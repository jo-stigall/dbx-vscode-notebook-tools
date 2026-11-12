/**
 * A replacement for the VS Code side of a board, for the test page.
 *
 * In VS Code, the webview talks to the extension host. In the test page there
 * is no extension host. This file gives the webview the same `acquireVsCodeApi`
 * function, and answers its requests with the demo profiler in the page.
 *
 * The page URL selects what the board shows:
 *
 *     index.html?table=demo.shop.orders_2025&theme=light
 *
 * `theme` is dark (default), light or hc (high contrast).
 */
import { parseTableName } from '../../../src/tableViz/core/names.ts';
import { createDispatcher } from '../../../src/tableViz/core/profiler.ts';
import type { ToWebview } from '../../../src/tableViz/core/schema.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';

const params = new URLSearchParams(location.search);
const table = parseTableName(params.get('table') ?? '') ?? { catalog: 'demo', schema: 'shop', name: 'orders_2026' };
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';

const profiler = new DemoProfiler();
const post = (message: ToWebview) => window.postMessage(message, '*');
const dispatcher = createDispatcher({
  profilerFor: () => profiler,
  post,
  makeSignal: () => {
    const controller = new AbortController();
    return { signal: controller.signal, cancel: () => controller.abort() };
  },
  onOther: () => post({ type: 'init', datasets: { a: { profile: 'Demo', table } } }),
});

let state: unknown;
Object.assign(window, {
  acquireVsCodeApi: () => ({
    postMessage: (message: unknown) => void dispatcher.handle(message),
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
    },
  }),
  /** The requests that the webview sent. A test can read this list. */
  tableVizExchanges: dispatcher.exchanges,
});
