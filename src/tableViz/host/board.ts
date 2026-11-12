/**
 * A board: one webview panel that shows one or two datasets.
 *
 * The board owns the panel and the dispatcher. The webview sends typed
 * requests, and the dispatcher answers them through a profiler. The webview
 * never gets a token, and it gets SQL text only inside a result.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { fileName } from '../core/derive.ts';
import { displayTableName } from '../core/names.ts';
import { createDispatcher, type Dispatcher, type Profiler } from '../core/profiler.ts';
import { inlineRendered } from '../core/sql.ts';
import type { BoardDatasets, BoardSettings, BoardState, SavedView, ToHost, ToWebview } from '../core/schema.ts';

/** The name that VS Code uses for the panels of this feature. package.json uses the same name. */
export const VIEW_TYPE = 'dbxNotebook.tableViz.board';

/** What a Board needs from the code that makes it. index.ts gives the same object to each board. */
export interface BoardDeps {
  /** The folder of the installed extension. The board loads the page of the webview from its `dist/tableViz` folder. */
  extensionUri: vscode.Uri;
  /** Returns the profiler for a profile name. It throws a ProfilerError if the feature cannot use the profile. */
  profilerFor: (profile: string) => Profiler;
  /** Reads the settings of the feature from the VS Code settings. */
  settings: () => BoardSettings;
  /** The log of the extension. The board writes the type and the time of each request to it, and no value from a result. */
  log: vscode.LogOutputChannel;
  /** The board calls this function after it writes a saved view to a file. `text` is the content of the file. */
  onSaved?: (uri: vscode.Uri, text: string) => void;
  /** The board calls this function when the user permits the queries of a saved view. */
  onApproved?: (board: Board) => void;
  /** The board calls this function when its panel closes. */
  onClosed?: (board: Board) => void;
}

/** The extra values of a board that comes from a `.tableviz.json` file. A new board has none of them. */
export interface ViewOptions {
  /** The file of the saved view. "Save View" writes to it. */
  uri: vscode.Uri;
  /** The cards and settings of the view. */
  state: BoardState;
  /** true: show the datasets and filters, and run no query until the user permits it. */
  needsApproval: boolean;
}

/** The folder that contains the built webview files. The webview can read no other folder. */
const distUri = (extensionUri: vscode.Uri) => vscode.Uri.joinPath(extensionUri, 'dist', 'tableViz');

/** The options that each board panel needs: the webview can run scripts, and it can read files only from `dist/tableViz`. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [distUri(extensionUri)] };
}

/**
 * One board: a webview panel, and the dispatcher that answers the requests of its webview.
 *
 * The board also handles the messages that are not requests: "ready",
 * "approve", "openSql", "export" and "saveView". When the panel closes, the
 * board cancels all requests that run.
 *
 * @example
 * const datasets = { a: { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } } };
 * const panel = vscode.window.createWebviewPanel(VIEW_TYPE, Board.title(datasets), vscode.ViewColumn.Active);
 * const board = new Board(panel, datasets, deps);
 */
export class Board {
  /** true after the webview started and asked for its datasets. */
  ready = false;
  /** Answers the "request" and "cancel" messages of the webview. Its `exchanges` list the requests, for tests and the log. */
  readonly dispatcher: Dispatcher;
  /** The webview panel that shows the board. */
  readonly panel: vscode.WebviewPanel;
  /** The datasets with which the board opened: A and, in compare mode, B. The webview gets them in the "init" message. */
  readonly datasets: BoardDatasets;
  /** The file of the saved view, if the board came from a file or if "Save View" wrote the board to one. */
  viewUri: vscode.Uri | undefined;
  /** false while a saved view waits for the permission of the user. No query runs then. */
  approved: boolean;
  private readonly deps: BoardDeps;

  /**
   * Put the page of the feature in a panel and start to answer its messages.
   *
   * @param panel  A new panel, or a panel that VS Code restored after a window reload.
   * @param datasets  The datasets that the board shows.
   * @param view  Set for a board that comes from a `.tableviz.json` file.
   */
  constructor(panel: vscode.WebviewPanel, datasets: BoardDatasets, deps: BoardDeps, view?: ViewOptions) {
    this.panel = panel;
    this.datasets = datasets;
    this.deps = deps;
    this.viewUri = view?.uri;
    this.approved = !view?.needsApproval;
    const post = (message: ToWebview) => void panel.webview.postMessage(message);
    const started = new Map<string, number>();
    this.dispatcher = createDispatcher({
      profilerFor: deps.profilerFor,
      post: (message) => {
        // Log the type and the time of each request. Never log a value from a result.
        if (message.type === 'result' || message.type === 'error' || message.type === 'cancelled') {
          const ms = Date.now() - (started.get(message.id) ?? Date.now());
          started.delete(message.id);
          const exchange = this.dispatcher.exchanges.find((x) => x.id === message.id);
          deps.log.info(`tableViz: ${exchange?.request.type ?? 'request'} ${message.type} in ${ms} ms`);
        } else if (message.type === 'progress' && !started.has(message.id)) {
          started.set(message.id, Date.now());
        }
        post(message);
      },
      makeSignal: () => {
        const controller = new AbortController();
        return { signal: controller.signal, cancel: () => controller.abort() };
      },
      onOther: async (message) => {
        const init = (): ToWebview => ({ type: 'init', datasets, settings: deps.settings(), ...(view ? { state: view.state } : {}), ...(this.approved ? {} : { confirm: true }) });
        try {
          switch (message.type) {
            case 'ready':
              this.ready = true;
              post(init());
              break;
            case 'approve':
              this.approved = true;
              deps.onApproved?.(this);
              post(init());
              break;
            case 'openSql':
              await this.openSql(message.sql);
              break;
            case 'export':
              await this.exportFile(message);
              break;
            case 'saveView':
              await this.saveView(message.state);
              break;
          }
        } catch (e) {
          void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
        }
      },
      blocked: () => (this.approved ? undefined : 'This saved view waits for your permission. Read its datasets and filters, then click "Run the Queries".'),
    });

    panel.webview.options = webviewOptions(deps.extensionUri);
    panel.webview.html = this.html(deps.extensionUri);
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => void this.dispatcher.handle(message));
    panel.onDidDispose(() => {
      listener.dispose();
      this.dispatcher.cancelAll();
      deps.onClosed?.(this);
    });
  }

  /** A folder for the "Save" dialogs: the first folder of the workspace. */
  private get folder(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  /**
   * Open the SQL of a card in a text editor.
   *
   * The extension runs each statement with named parameters. The editor
   * gets the same statements with the values in the text, so that a person
   * can run them as they are.
   */
  private async openSql(statements: string[]): Promise<void> {
    const content =
      '-- The SQL behind a card of "Visualize Table".\n-- The extension runs each statement with named parameters. Here the values are in the text.\n\n' +
      statements.map(inlineRendered).join(';\n\n') +
      ';\n';
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content });
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }

  /**
   * Save a chart or the tables of a card to a file that the user selects, or copy them.
   *
   * The message has the content: `text` for CSV and SVG, `base64` for a PNG
   * image. For "copy", the host copies text only.
   */
  private async exportFile(message: Extract<ToHost, { type: 'export' }>): Promise<void> {
    if (message.action === 'copy') {
      // VS Code can copy text only. The webview copies a PNG image itself.
      if (message.text === undefined) return;
      await vscode.env.clipboard.writeText(message.text);
      vscode.window.setStatusBarMessage(message.format === 'csv' ? 'Copied the tables' : 'Copied the chart as SVG text', 3000);
      return;
    }
    const names = { csv: 'CSV', svg: 'SVG image', png: 'PNG image' };
    const name = fileName([message.name.replace(/\.[a-z]+$/, '')], message.format);
    const target = await vscode.window.showSaveDialog({
      defaultUri: this.folder ? vscode.Uri.joinPath(this.folder, name) : vscode.Uri.file(name),
      filters: { [names[message.format]]: [message.format] },
    });
    if (!target) return;
    const bytes = message.base64 !== undefined ? Buffer.from(message.base64, 'base64') : Buffer.from(message.text ?? '', 'utf8');
    await vscode.workspace.fs.writeFile(target, bytes);
  }

  /**
   * Write the board to a `.tableviz.json` file.
   *
   * The file holds the datasets, the filters, the cards and their settings.
   * It holds no data and no token.
   *
   * @param state  What the webview shows now.
   * @param target  The file to write. If you omit it, the function writes to the file of the view, or asks for a file.
   * @returns The file, or undefined if the user closed the dialog.
   */
  async saveView(state: BoardState, target?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const name = fileName([state.datasets.a.table.name, ...(state.datasets.b ? ['vs', state.datasets.b.table.name] : [])], 'tableviz.json');
    const uri =
      target ??
      this.viewUri ??
      (await vscode.window.showSaveDialog({
        defaultUri: this.folder ? vscode.Uri.joinPath(this.folder, name) : vscode.Uri.file(name),
        filters: { 'Table visualization view': ['json'] },
      }));
    if (!uri) return undefined;
    const view: SavedView = { tableViz: 1, datasets: state.datasets, ui: state.ui, cards: state.cards, asText: state.asText };
    const text = JSON.stringify(view, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    this.viewUri = uri;
    this.deps.onSaved?.(uri, text);
    this.deps.log.info(`tableViz: saved the view to ${uri.fsPath}`);
    vscode.window.setStatusBarMessage(`Saved the view to ${uri.fsPath}`, 4000);
    return uri;
  }

  /**
   * Make the text on the tab of a board.
   *
   * @example
   * const a = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2025' } };
   * const b = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
   * Board.title({ a })      // 'orders_2025'
   * Board.title({ a, b })   // 'orders_2025 ↔ orders_2026'
   */
  static title(datasets: BoardDatasets): string {
    return datasets.b ? `${datasets.a.table.name} ↔ ${datasets.b.table.name}` : datasets.a.table.name;
  }

  /**
   * Make the HTML page of the webview.
   *
   * The Content Security Policy permits one script only: the bundle of this
   * extension, which the nonce marks. It permits no inline script, no `eval`
   * and no content from the network.
   */
  private html(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri(extensionUri), 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri(extensionUri), 'webview.css'));
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    const title = displayTableName(this.datasets.a.table).replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>${title}</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
