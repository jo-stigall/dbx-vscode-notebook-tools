/**
 * The start of the table visualization feature in the extension host.
 *
 * extension.js loads this file the first time that you use a command, a view
 * or a panel of the feature. Thus the feature does not make the start of the
 * extension slower.
 */
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { displayTableName, parseTableName, tableNameAt } from '../core/names.ts';
import { boardSettingsSchema, boardStateSchema, DEFAULT_SETTINGS, savedViewSchema, type BoardDatasets, type BoardSettings, type TableName } from '../core/schema.ts';
import { Board, VIEW_TYPE } from './board.ts';
import { selectProfileAndCompute } from './picker.ts';
import { DEMO_PROFILE, Session, type HostConnection } from './session.ts';
import { TableTree, type Node } from './tree.ts';

export { DEMO_PROFILE };

/** The functions that extension.js calls. */
export interface TableVizApi {
  /**
   * Open a board for a table. This is the command "Visualize Table".
   *
   * @param name  A three-part table name, for example 'demo.shop.orders_2026'. If you omit it, the function asks for the name.
   * @returns The board, or undefined if the user gave no valid name.
   */
  visualizeTable(name?: string): Promise<Board | undefined>;
  /** Open a board for the table name at the cursor of the active editor. */
  visualizeTableUnderCursor(): Promise<Board | undefined>;
  /** Open a board for a table of the tree. */
  visualizeNode(node: Node): Promise<Board | undefined>;
  /**
   * Open a board that compares two tables. This is "Compare With..." on a table of the tree, and the command "Compare Tables".
   *
   * @param a  The name of dataset A, or a table of the tree. If you omit it, the function asks for the name.
   * @param b  The name of dataset B. If you omit it, the function shows a list.
   */
  compareTables(a?: string | Node, b?: string): Promise<Board | undefined>;
  /** Show a board again after VS Code reloads the window. `state` is what the webview stored. */
  restoreBoard(panel: vscode.WebviewPanel, state: unknown): Promise<void>;
  /** The command "Select Profile and Compute for Tables". */
  selectCompute(): Promise<boolean>;
  /**
   * Show a `.tableviz.json` file as a board. VS Code calls this function when the user opens such a file.
   *
   * The filters in the file are SQL that runs with the login of the user.
   * The first time that the extension sees the content of a file, the board
   * shows the datasets and filters and runs nothing until the user permits
   * it. In a workspace that the user did not trust, the board asks each time.
   */
  resolveView(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<Board | undefined>;
  /** The boards that are open. */
  boards: Set<Board>;
  /** Tells if the user trusted the workspace. A test can replace it. */
  isTrusted: () => boolean;
  /** The data of the view "Databricks Tables". */
  tree: TableTree;
  /** The selected profile and compute. Tests use it. */
  session: Session;
}

/**
 * Start the feature.
 *
 * @example
 * const tableViz = require('./dist/tableViz/host.js').activate(context, conn);
 * await tableViz.visualizeTable('demo.shop.orders_2026');
 *
 * @param conn  The Connection of the extension (src/client.js). The feature uses it to find the workspace URL and the token.
 */
export function activate(context: vscode.ExtensionContext, conn: HostConnection): TableVizApi {
  const log = vscode.window.createOutputChannel('Databricks Notebook', { log: true });
  const session = new Session(context, conn, log);
  const tree = new TableTree(context, session);

  // The status bar shows the profile and the compute. A click opens the two lists.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'dbxNotebook.tableViz.selectCompute';
  const showStatus = () => {
    const profile = session.profile;
    const compute = session.compute(profile);
    const state = session.computeState ? ` (${session.computeState.toLowerCase()})` : '';
    status.text = `$(database) ${session.label(profile)}${compute ? ` · ${compute.name}${state}` : ''}`;
    status.tooltip = [
      'Databricks tables',
      `Profile: ${session.label(profile)}`,
      profile === DEMO_PROFILE ? 'Demo tables. No workspace.' : `Workspace: ${session.hostOf(profile) || 'none'}`,
      ...(profile === DEMO_PROFILE ? [] : [`${compute?.kind === 'cluster' ? 'Cluster' : 'SQL warehouse'}: ${compute ? compute.name + state : 'none selected'}`]),
      'Click to select a different profile, warehouse or cluster.',
    ].join('\n');
    status.show();
  };
  showStatus();
  context.subscriptions.push(
    log,
    status,
    { dispose: () => session.dispose() },
    session.onDidChange(() => {
      showStatus();
      tree.refresh();
    })
  );

  /** Read "dbxNotebook.tableViz.*" from the VS Code settings. Use the defaults if a value is not valid. */
  const settings = (): BoardSettings => {
    const config = vscode.workspace.getConfiguration('dbxNotebook.tableViz');
    const parsed = boardSettingsSchema.safeParse({
      defaultBins: config.get('defaultBins'),
      topValues: config.get('topValues'),
      largeTableBytes: session.settings().largeTableWarningGB * 1024 ** 3,
      matchColumnsCaseSensitive: config.get('matchColumnsCaseSensitive') === true,
    });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  };
  const boards = new Set<Board>();
  // The views that the user permitted, or saved from a board: a hash of the file path and the content.
  const APPROVED_KEY = 'dbxNotebook.tableViz.approvedViews';
  const hashOf = (uri: vscode.Uri, text: string) => createHash('sha256').update(uri.toString()).update('\n').update(text).digest('hex');
  const remember = (uri: vscode.Uri, text: string) => {
    const list = context.workspaceState.get<string[]>(APPROVED_KEY, []);
    const hash = hashOf(uri, text);
    if (!list.includes(hash)) void context.workspaceState.update(APPROVED_KEY, [...list, hash].slice(-200));
  };
  // The text of each view that waits for permission, to remember it when the user permits it.
  const waiting = new Map<Board, { uri: vscode.Uri; text: string }>();
  const api = { isTrusted: () => vscode.workspace.isTrusted };

  const deps = {
    extensionUri: context.extensionUri,
    profilerFor: (profile: string) => session.profilerFor(profile),
    settings,
    log,
    onSaved: remember,
    onApproved: (board: Board) => {
      const view = waiting.get(board);
      // In a workspace that is not trusted, do not remember the permission: ask again the next time.
      if (view && api.isTrusted()) remember(view.uri, view.text);
      waiting.delete(board);
    },
    onClosed: (board: Board) => {
      boards.delete(board);
      waiting.delete(board);
    },
  };
  const track = (board: Board): Board => {
    boards.add(board);
    return board;
  };

  /**
   * Open a board for a table with the selected profile.
   *
   * If the profile has no SQL warehouse, the function shows the lists of
   * "Select Profile and Compute for Tables" first. It returns undefined if
   * the user closes a list.
   */
  const open = async (table: TableName, tableB?: TableName): Promise<Board | undefined> => {
    if (session.profile !== DEMO_PROFILE && !session.compute(session.profile)) {
      if (!(await selectProfileAndCompute(session, conn))) return undefined;
    }
    const datasets: BoardDatasets = { a: { profile: session.profile, table }, ...(tableB ? { b: { profile: session.profile, table: tableB } } : {}) };
    log.info(`tableViz: open ${displayTableName(table)}${tableB ? ` and ${displayTableName(tableB)}` : ''} with the profile ${session.label(session.profile)}`);
    void tree.addRecent(table);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, Board.title(datasets), vscode.ViewColumn.Active);
    return track(new Board(panel, datasets, deps));
  };

  /** Ask for a three-part table name. Returns undefined if the user closes the box. */
  const askTable = async (title: string, value: string): Promise<TableName | undefined> => {
    const text = await vscode.window.showInputBox({
      title,
      prompt: `Type the name of the table: catalog.schema.table (profile: ${session.label(session.profile)})`,
      value,
      validateInput: (input) => (parseTableName(input) ? undefined : 'Type three parts: catalog.schema.table'),
    });
    return text === undefined ? undefined : parseTableName(text);
  };

  /** Let the user select dataset B: the same table, a recent or favorite table, or a name that the user types. */
  const pickSecond = async (a: TableName): Promise<TableName | undefined> => {
    const same = `$(versions) ${displayTableName(a)}`;
    const type = '$(edit) Type a table name…';
    const names = [...new Set([...tree.recents, ...tree.favorites])].filter((name) => name !== displayTableName(a));
    const picked = await vscode.window.showQuickPick(
      [
        { label: same, detail: 'The same table. On the board, give dataset B a different filter or version.' },
        ...names.map((name) => ({ label: `$(table) ${name}`, detail: undefined })),
        { label: type, detail: undefined },
      ],
      { title: `Compare ${displayTableName(a)} with`, placeHolder: 'Select dataset B' }
    );
    if (!picked) return undefined;
    if (picked.label === same) return a;
    if (picked.label === type) return askTable('Dataset B', session.profile === DEMO_PROFILE ? 'demo.shop.orders_2026' : '');
    return parseTableName(picked.label.replace('$(table) ', ''));
  };

  return {
    tree,
    session,

    async compareTables(a, b) {
      const first =
        typeof a === 'string' ? parseTableName(a) : a?.kind === 'table' ? a.table : await askTable('Dataset A', session.profile === DEMO_PROFILE ? 'demo.shop.orders_2025' : (tree.recents[0] ?? ''));
      if (!first) return undefined;
      const second = b === undefined ? await pickSecond(first) : parseTableName(b);
      if (!second) return undefined;
      return open(first, second);
    },

    async visualizeTable(name) {
      const example = session.profile === DEMO_PROFILE ? 'demo.shop.orders_2026' : (tree.recents[0] ?? '');
      const text =
        name ??
        (await vscode.window.showInputBox({
          title: 'Visualize Table',
          prompt: `Type the name of the table: catalog.schema.table (profile: ${session.label(session.profile)})`,
          value: example,
          validateInput: (value) => (parseTableName(value) ? undefined : 'Type three parts: catalog.schema.table'),
        }));
      if (text === undefined) return undefined;
      const table = parseTableName(text);
      if (!table) {
        void vscode.window.showErrorMessage(`"${text}" is not a table name. Type three parts: catalog.schema.table`);
        return undefined;
      }
      return open(table);
    },

    async visualizeTableUnderCursor() {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return undefined;
      const position = editor.selection.active;
      const table = tableNameAt(editor.document.lineAt(position.line).text, position.character);
      if (!table) {
        void vscode.window.showInformationMessage('The cursor is not on a table name with three parts: catalog.schema.table');
        return undefined;
      }
      return open(table);
    },

    async visualizeNode(node) {
      return node?.kind === 'table' ? open(node.table) : undefined;
    },

    async restoreBoard(panel, state) {
      const parsed = boardStateSchema.safeParse(state);
      if (!parsed.success) {
        // The stored state is missing or has an old shape. Close the empty panel.
        panel.dispose();
        return;
      }
      panel.title = Board.title(parsed.data.datasets);
      track(new Board(panel, parsed.data.datasets, deps));
    },

    async resolveView(document, panel) {
      const text = document.getText();
      let parsed;
      try {
        parsed = savedViewSchema.safeParse(JSON.parse(text));
      } catch {
        parsed = undefined;
      }
      if (!parsed?.success) {
        // Not a saved view. Show a page with no script, and tell the user how to see the text.
        panel.webview.options = { enableScripts: false };
        panel.webview.html =
          '<!DOCTYPE html><html lang="en"><body><h2>This file is not a saved view of "Visualize Table"</h2>' +
          '<p>The file must contain JSON that "Save View" made. To see the text of the file, right-click its tab, select "Reopen Editor With...", then "Text Editor".</p></body></html>';
        return undefined;
      }
      const view = parsed.data;
      const needsApproval = !api.isTrusted() || !context.workspaceState.get<string[]>(APPROVED_KEY, []).includes(hashOf(document.uri, text));
      const state = { datasets: view.datasets, ui: view.ui, cards: view.cards, asText: view.asText };
      const board = track(new Board(panel, view.datasets, deps, { uri: document.uri, state, needsApproval }));
      if (needsApproval) waiting.set(board, { uri: document.uri, text });
      log.info(`tableViz: open the saved view ${document.uri.fsPath}${needsApproval ? ' (waits for permission)' : ''}`);
      return board;
    },

    boards,
    get isTrusted() {
      return api.isTrusted;
    },
    set isTrusted(value: () => boolean) {
      api.isTrusted = value;
    },

    selectCompute: () => selectProfileAndCompute(session, conn),
  };
}
