/**
 * The start of the table visualization feature in the extension host.
 *
 * extension.js loads this file the first time that you use a command, a view
 * or a panel of the feature. Thus the feature does not make the start of the
 * extension slower.
 */
import * as vscode from 'vscode';
import { displayTableName, parseTableName, tableNameAt } from '../core/names.ts';
import { boardSettingsSchema, boardStateSchema, DEFAULT_SETTINGS, type BoardDatasets, type BoardSettings, type TableName } from '../core/schema.ts';
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
  /** Show a board again after VS Code reloads the window. `state` is what the webview stored. */
  restoreBoard(panel: vscode.WebviewPanel, state: unknown): Promise<void>;
  /** The command "Select Profile and Compute for Tables". */
  selectCompute(): Promise<boolean>;
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
  const deps = { extensionUri: context.extensionUri, profilerFor: (profile: string) => session.profilerFor(profile), settings, log };

  /**
   * Open a board for a table with the selected profile.
   *
   * If the profile has no SQL warehouse, the function shows the lists of
   * "Select Profile and Compute for Tables" first. It returns undefined if
   * the user closes a list.
   */
  const open = async (table: TableName): Promise<Board | undefined> => {
    if (session.profile !== DEMO_PROFILE && !session.compute(session.profile)) {
      if (!(await selectProfileAndCompute(session, conn))) return undefined;
    }
    const datasets: BoardDatasets = { a: { profile: session.profile, table } };
    log.info(`tableViz: open ${displayTableName(table)} with the profile ${session.label(session.profile)}`);
    void tree.addRecent(table);
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, Board.title(datasets), vscode.ViewColumn.Active);
    return new Board(panel, datasets, deps);
  };

  return {
    tree,
    session,

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
      new Board(panel, parsed.data.datasets, deps);
    },

    selectCompute: () => selectProfileAndCompute(session, conn),
  };
}
