/**
 * The start of the table visualization feature in the extension host.
 *
 * extension.js loads this file the first time that you use a command, a view
 * or a file of the feature. Thus the feature does not make the start of the
 * extension slower.
 */
import * as vscode from 'vscode';
import { displayTableName, parseTableName } from '../core/names.ts';
import { ProfilerError, type Profiler } from '../core/profiler.ts';
import { boardSettingsSchema, boardStateSchema, DEFAULT_SETTINGS, type BoardDatasets, type BoardSettings } from '../core/schema.ts';
import { DemoProfiler } from '../demo/demoProfiler.ts';
import { Board, VIEW_TYPE } from './board.ts';

/** The name of the built-in profile that needs no Databricks workspace. */
export const DEMO_PROFILE = 'Demo';

/** The functions that extension.js calls. */
export interface TableVizApi {
  /**
   * Open a board for a table. This is the command "Visualize Table".
   *
   * @param name  A three-part table name, for example 'demo.shop.orders_2026'. If you omit it, the function asks for the name.
   * @returns The board, or undefined if the user gave no valid name.
   */
  visualizeTable(name?: string): Promise<Board | undefined>;
  /** Show a board again after VS Code reloads the window. `state` is what the webview stored. */
  restoreBoard(panel: vscode.WebviewPanel, state: unknown): Promise<void>;
}

/**
 * Start the feature.
 *
 * @example
 * const tableViz = require('./dist/tableViz/host.js').activate(context);
 * await tableViz.visualizeTable('demo.shop.orders_2026');
 */
export function activate(context: vscode.ExtensionContext): TableVizApi {
  const log = vscode.window.createOutputChannel('Databricks Notebook', { log: true });
  context.subscriptions.push(log);

  const demo = new DemoProfiler();
  const profilerFor = (profile: string): Profiler => {
    if (profile === DEMO_PROFILE) return demo;
    throw new ProfilerError(`The profile "${profile}" is not available.`, {
      nextStep: 'This version shows the demo tables only. Open demo.shop.orders_2026.',
    });
  };
  /** Read "dbxNotebook.tableViz.*" from the VS Code settings. Use the defaults if a value is not valid. */
  const settings = (): BoardSettings => {
    const config = vscode.workspace.getConfiguration('dbxNotebook.tableViz');
    const parsed = boardSettingsSchema.safeParse({ defaultBins: config.get('defaultBins'), topValues: config.get('topValues') });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  };
  const deps = { extensionUri: context.extensionUri, profilerFor, settings, log };

  return {
    async visualizeTable(name) {
      const text =
        name ??
        (await vscode.window.showInputBox({
          title: 'Visualize Table',
          prompt: 'Type the name of the table: catalog.schema.table',
          value: 'demo.shop.orders_2026',
          validateInput: (value) => (parseTableName(value) ? undefined : 'Type three parts: catalog.schema.table'),
        }));
      if (text === undefined) return undefined;
      const table = parseTableName(text);
      if (!table) {
        void vscode.window.showErrorMessage(`"${text}" is not a table name. Type three parts: catalog.schema.table`);
        return undefined;
      }
      const datasets: BoardDatasets = { a: { profile: DEMO_PROFILE, table } };
      log.info(`tableViz: open ${displayTableName(table)}`);
      const panel = vscode.window.createWebviewPanel(VIEW_TYPE, Board.title(datasets), vscode.ViewColumn.Active);
      return new Board(panel, datasets, deps);
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
  };
}
