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
import { browseTable } from './browsePicker.ts';
import { selectProfileAndCompute } from './picker.ts';
import { pickTable } from './searchPicker.ts';
import { DEMO_PROFILE, Session, type HostConnection } from './session.ts';
import { TableTree, type Node } from './tree.ts';

/** The name of the Demo profile, for the code that loads this file. */
export { DEMO_PROFILE };

/** The functions that extension.js calls. */
export interface TableVizApi {
  /**
   * Open a board for a table. This is the command "Visualize Table".
   *
   * @param name  A three-part table name, for example 'demo.shop.orders_2026'. If you omit it, the function shows the list of catalogs, schemas and tables.
   * @returns The board, or undefined if the user gave no valid name.
   */
  visualizeTable(name?: string): Promise<Board | undefined>;
  /** Open a board for the table name at the cursor of the active editor. */
  visualizeTableUnderCursor(): Promise<Board | undefined>;
  /** Open a board for a table of the tree. */
  visualizeNode(node: Node): Promise<Board | undefined>;
  /**
   * Copy the three-part name of a table to the clipboard.
   *
   * Accepts a table node from the "Databricks Tables" view, a `data-vscode-context`
   * object from a board's right-click menu, or a plain table name string.
   *
   * @param target  The table node, webview context object, or table name string.
   * @param key  The context field to read from a webview context object. Default: 'tableName'.
   * @returns The copied table name, or undefined if `target` contains no table name.
   */
  copyTableName(target: unknown, key?: 'tableName' | 'tableNameA' | 'tableNameB'): Promise<string | undefined>;
  /**
   * Show the search list, and open a board for the table that the user selects. This is the command "Search Tables".
   *
   * @param node  A catalog or a schema of the tree: the search looks only there. If you omit it, the search looks in all catalogs.
   * @returns The board, or undefined if the user closes the list.
   */
  searchTables(node?: Node): Promise<Board | undefined>;
  /**
   * Open a board that compares two tables. This is "Compare With..." on a table of the tree, and the command "Compare Tables".
   *
   * @param a  The name of dataset A, or a table of the tree. If you omit it, the function asks for the name.
   * @param b  The name of dataset B. If you omit it, the function shows a list.
   */
  compareTables(a?: string | Node, b?: string): Promise<Board | undefined>;
  /** Show a board again after VS Code reloads the window. `state` is what the webview stored. */
  restoreBoard(panel: vscode.WebviewPanel, state: unknown): Promise<void>;
  /**
   * Show the two lists of the command "Select Profile and Compute for Tables".
   *
   * @returns true if the user selected a profile and its compute. See selectProfileAndCompute() in picker.ts.
   */
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
  /** The boards that are open. A board leaves the set when its panel closes. */
  boards: Set<Board>;
  /** Tells if the user trusted the workspace. A test can replace it. */
  isTrusted: () => boolean;
  /** Gives the lines of the view "Databricks Tables", and stores the favorite and the recent tables. */
  tree: TableTree;
  /** The selected profile and compute. Tests use it. */
  session: Session;
}

/**
 * Extract a table name string from a tree node, a webview context object, or a plain string.
 *
 * @example
 * tableNameFrom({ kind: 'table', table: { catalog: 'main', schema: 'shop', name: 'orders' }, favorite: false })
 * // 'main.shop.orders'
 * tableNameFrom({ tableName: 'main.shop.orders' })                   // 'main.shop.orders'
 * tableNameFrom({ tableNameB: 'main.shop.orders' }, 'tableNameB')    // 'main.shop.orders'
 */
function tableNameFrom(target: unknown, key: 'tableName' | 'tableNameA' | 'tableNameB' = 'tableName'): string | undefined {
  if (typeof target === 'string') return target.trim() || undefined;
  if (!target || typeof target !== 'object') return undefined;
  const record = target as Record<string, unknown>;
  if (record.kind === 'table' && record.table && typeof record.table === 'object') {
    const t = record.table as Partial<TableName>;
    if (typeof t.catalog === 'string' && t.catalog && typeof t.schema === 'string' && t.schema && typeof t.name === 'string' && t.name) {
      return displayTableName({ catalog: t.catalog, schema: t.schema, name: t.name });
    }
  }
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Start the feature.
 *
 * The function makes the session, the tree and the item in the status bar
 * that shows the profile and the compute. It opens no board.
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
  /**
   * Write the profile, the compute and its state to the status bar.
   *
   * @example
   * // The text of the item: '$(database) prod · Starter Warehouse (running)'
   * // With the Demo profile: '$(database) Demo'
   */
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
  /** The boards that are open. */
  const boards = new Set<Board>();
  /**
   * The name under which VS Code stores the views that the user permitted, or saved from a board.
   * The stored value is a list of hashes. See hashOf.
   */
  const APPROVED_KEY = 'dbxNotebook.tableViz.approvedViews';
  /**
   * Make the SHA-256 hash of the location and the content of a view file.
   *
   * If a person or a program changes the file, the hash changes. The board
   * then asks for permission again before it runs the filters of the file.
   */
  const hashOf = (uri: vscode.Uri, text: string) => createHash('sha256').update(uri.toString()).update('\n').update(text).digest('hex');
  /** Store the hash of a view that the user permitted or saved. VS Code keeps the 200 newest hashes for the open workspace. */
  const remember = (uri: vscode.Uri, text: string) => {
    const list = context.workspaceState.get<string[]>(APPROVED_KEY, []);
    const hash = hashOf(uri, text);
    if (!list.includes(hash)) void context.workspaceState.update(APPROVED_KEY, [...list, hash].slice(-200));
  };
  // The text of each view that waits for permission, to remember it when the user permits it.
  const waiting = new Map<Board, { uri: vscode.Uri; text: string }>();
  /** `isTrusted` is in an object, so that a test can replace the function after activate() returns. */
  const api = { isTrusted: () => vscode.workspace.isTrusted };

  /** What each board gets. See BoardDeps. */
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
  /** Add a board to the set of open boards. Returns the same board. */
  const track = (board: Board): Board => {
    boards.add(board);
    return board;
  };

  /**
   * Open a board for a table with the selected profile.
   *
   * If the profile has no SQL warehouse and no cluster, the function shows
   * the lists of "Select Profile and Compute for Tables" first. It returns
   * undefined if the user closes a list. The Demo profile needs no compute.
   *
   * The function also puts the table at the top of the recent tables.
   *
   * @param table  The table of dataset A.
   * @param tableB  The table of dataset B. If you give it, the board opens in compare mode.
   */
  const open = async (table: TableName, tableB?: TableName): Promise<Board | undefined> => {
    if (session.profile !== DEMO_PROFILE && !session.compute(session.profile)) {
      if (!(await selectProfileAndCompute(session, conn))) return undefined;
    }
    const datasets: BoardDatasets = { a: { profile: session.profile, table }, ...(tableB ? { b: { profile: session.profile, table: tableB } } : {}) };
    log.info(`tableViz: open ${displayTableName(table)}${tableB ? ` and ${displayTableName(tableB)}` : ''} with the profile ${session.label(session.profile)}`);
    await tree.addRecent(table);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, Board.title(datasets), vscode.ViewColumn.Active);
    return track(new Board(panel, datasets, deps));
  };

  /**
   * Let the user select a table from the list of catalogs, schemas and tables. See browseTable() in browsePicker.ts.
   *
   * @param title  The start of the title of the list. Example: 'Dataset A'.
   * @returns The table, or undefined if the user closes the list.
   */
  const askTable = (title: string): Promise<TableName | undefined> => browseTable(session, tree, title);

  /** Let the user select dataset B: the same table, a recent or favorite table, or a table from the list of catalogs, schemas and tables. */
  const pickSecond = async (a: TableName): Promise<TableName | undefined> => {
    const same = `$(versions) ${displayTableName(a)}`;
    const type = '$(list-tree) Select a different table…';
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
    if (picked.label === type) return askTable('Dataset B');
    return parseTableName(picked.label.replace('$(table) ', ''));
  };

  return {
    tree,
    session,

    async compareTables(a, b) {
      const first =
        typeof a === 'string' ? parseTableName(a) : a?.kind === 'table' ? a.table : await askTable('Dataset A');
      if (!first) return undefined;
      const second = b === undefined ? await pickSecond(first) : parseTableName(b);
      if (!second) return undefined;
      return open(first, second);
    },

    async visualizeTable(name) {
      if (name === undefined) {
        const picked = await askTable('Visualize Table');
        return picked ? open(picked) : undefined;
      }
      const table = parseTableName(name);
      if (!table) {
        void vscode.window.showErrorMessage(`"${name}" is not a table name. Type three parts: catalog.schema.table`);
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

    async copyTableName(target, key = 'tableName') {
      const text = tableNameFrom(target, key);
      if (!text) return undefined;
      await vscode.env.clipboard.writeText(text);
      if (target && typeof target === 'object' && (target as { kind?: unknown }).kind === 'table') {
        tree.markCopied(target as Node);
      }
      vscode.window.setStatusBarMessage(`Copied ${text.replace(/\s+/g, ' ')}`, 3000);
      return text;
    },

    async searchTables(node) {
      const scope = node?.kind === 'schema' ? { catalog: node.catalog, schema: node.schema } : node?.kind === 'catalog' ? { catalog: node.catalog } : {};
      const table = await pickTable(session, tree, scope);
      return table ? open(table) : undefined;
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
