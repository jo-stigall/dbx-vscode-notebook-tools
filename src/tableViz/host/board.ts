/**
 * A board: one webview panel that shows one or two datasets.
 *
 * The board owns the panel and the dispatcher. The webview sends typed
 * requests, and the dispatcher answers them through a profiler. The webview
 * never gets a token, and it gets SQL text only inside a result.
 */
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { displayTableName } from '../core/names.ts';
import { createDispatcher, type Dispatcher, type Profiler } from '../core/profiler.ts';
import type { BoardDatasets, BoardSettings, ToWebview } from '../core/schema.ts';

/** The name that VS Code uses for the panels of this feature. package.json uses the same name. */
export const VIEW_TYPE = 'dbxNotebook.tableViz.board';

export interface BoardDeps {
  /** The folder of the installed extension. */
  extensionUri: vscode.Uri;
  /** Returns the profiler for a profile name. */
  profilerFor: (profile: string) => Profiler;
  /** Reads the settings of the feature from the VS Code settings. */
  settings: () => BoardSettings;
  log: vscode.LogOutputChannel;
}

/** The folder that contains the built webview files. The webview can read no other folder. */
const distUri = (extensionUri: vscode.Uri) => vscode.Uri.joinPath(extensionUri, 'dist', 'tableViz');

/** The options that each board panel needs. */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [distUri(extensionUri)] };
}

export class Board {
  /** true after the webview started and asked for its datasets. */
  ready = false;
  readonly dispatcher: Dispatcher;
  readonly panel: vscode.WebviewPanel;
  readonly datasets: BoardDatasets;

  /**
   * @param panel  A new panel, or a panel that VS Code restored after a window reload.
   * @param datasets  The datasets that the board shows.
   */
  constructor(panel: vscode.WebviewPanel, datasets: BoardDatasets, deps: BoardDeps) {
    this.panel = panel;
    this.datasets = datasets;
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
      onOther: () => {
        this.ready = true;
        post({ type: 'init', datasets, settings: deps.settings() });
      },
    });

    panel.webview.options = webviewOptions(deps.extensionUri);
    panel.webview.html = this.html(deps.extensionUri);
    const listener = panel.webview.onDidReceiveMessage((message: unknown) => void this.dispatcher.handle(message));
    panel.onDidDispose(() => {
      listener.dispose();
      this.dispatcher.cancelAll();
    });
  }

  /** The text on the tab of a board. Example: "orders_2026" or "orders_2025 ↔ orders_2026". */
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
