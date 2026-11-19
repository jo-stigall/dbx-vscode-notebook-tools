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
 * The page reads these parameters from the URL:
 *
 *     table=demo.shop.orders_2025   The table of dataset A. Default: demo.shop.orders_2026.
 *     b=demo.shop.orders_2026       A second table, dataset B. The board then compares the two tables.
 *     theme=light                   dark (default), light or hc (high contrast). See themes.css.
 *     cards=amount,region           The columns whose detail cards are open at the start.
 *     detail=1                      Shows the first card as the detailed view of its column.
 *     kind=identifier               Sets the kind of the first card.
 *     astable=1                     Shows the chart of the first card as a table.
 *     sql=1                         Shows the SQL of each card.
 *     delay=800                     Each answer arrives 800 ms late, so that a person can see
 *                                   how the page looks while it loads.
 *     large=1                       The board asks before it reads all rows of the table.
 *     confirm=1                     The board shows the question that a saved view asks before
 *                                   it runs a query.
 *
 * The file sets three lists on `window`. A person can read them in the
 * console of the browser, and a browser test can check them:
 *
 *     window.tableVizExchanges   Each request of the webview, with the last answer to it.
 *     window.tableVizSent        The other messages of the webview: export, open SQL, save view.
 *     window.tableVizCancels     The IDs of the requests that the webview cancelled, oldest first.
 *
 * @example
 * // In the console of the browser, after the board loaded:
 * window.tableVizExchanges.map((x) => x.request.type)   // ['tableDetails', 'overview', ...]
 */
import { parseTableName } from '../../../src/tableViz/core/names.ts';
import { createDispatcher } from '../../../src/tableViz/core/profiler.ts';
import { columnKindSchema, DEFAULT_SETTINGS, type BoardDatasets, type Card, type ToWebview } from '../../../src/tableViz/core/schema.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';

/** The parameters of the page URL. The comment at the top of this file lists them. */
const params = new URLSearchParams(location.search);
/** The table of dataset A, from the parameter `table`. */
const table = parseTableName(params.get('table') ?? '') ?? { catalog: 'demo', schema: 'shop', name: 'orders_2026' };
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';

// `b=demo.shop.orders_2026` puts a second table on the board: compare mode.
const tableB = parseTableName(params.get('b') ?? '');
/** The datasets of the board: A, and B if the URL has the parameter `b`. */
const datasets: BoardDatasets = { a: { profile: 'Demo', table }, ...(tableB ? { b: { profile: 'Demo', table: tableB } } : {}) };
/** false while the board shows the question of a saved view (`confirm=1`) and the user did not answer it. */
let approved = params.get('confirm') !== '1';
/** The messages of the webview that the test page cannot handle, oldest first: export, open SQL, save view. */
const sent: unknown[] = [];
/** The IDs of the requests that the webview cancelled, oldest first. */
const cancels: string[] = [];
/** The profiler that answers all requests of the page from the demo tables. */
const profiler = new DemoProfiler();
/** The time in milliseconds that each answer waits, from the parameter `delay`. 0 if the URL has no such parameter. */
const delay = Number(params.get('delay')) || 0;
/**
 * Send one message to the webview, as the extension host does.
 *
 * With `delay`, the message arrives late. The "init" message is the
 * exception: it arrives at once.
 */
const post = (message: ToWebview) => {
  if (delay > 0 && message.type !== 'init') setTimeout(() => window.postMessage(message, '*'), delay);
  else window.postMessage(message, '*');
};
/** The same dispatcher that the extension host uses. Here it sends each request to the demo profiler. */
const dispatcher = createDispatcher({
  profilerFor: () => profiler,
  post,
  makeSignal: () => {
    const controller = new AbortController();
    return { signal: controller.signal, cancel: () => controller.abort() };
  },
  onOther: (message) => {
    // `confirm=1` shows the question that a saved view asks. A click on its button sends "approve".
    // `large=1` sets the size limit to 1 MB, so that the demo table is "too large" and the board asks before it reads all rows.
    if (message.type === 'approve') approved = true;
    if (message.type === 'ready' || message.type === 'approve') {
      post({ type: 'init', datasets, settings: { ...DEFAULT_SETTINGS, ...(params.get('large') === '1' ? { largeTableBytes: 1024 ** 2 } : {}) }, ...(approved ? {} : { confirm: true }) });
    } else if (message.type === 'copyText') {
      sent.push(message);
      void navigator.clipboard?.writeText(message.text).catch(() => {});
    } else {
      // The test page cannot write files. Keep the message so that a person can look at it.
      sent.push(message);
    }
  },
});

// The cards from the page URL go into the stored state, as if the board was open before a reload.
const kind = columnKindSchema.safeParse(params.get('kind'));
/** The cards that are open at the start, from the parameters `cards`, `detail`, `kind`, `astable` and `sql`. */
const cards: Card[] = (params.get('cards') ?? '')
  .split(',')
  .filter(Boolean)
  .map((column, i) => ({
    column,
    pinned: !(i === 0 && params.get('detail') === '1'),
    ...(i === 0 && params.get('detail') === '1' ? { expanded: true } : {}),
    ...(i === 0 && kind.success ? { kind: kind.data } : {}),
    ...(i === 0 && params.get('astable') === '1' ? { asTable: true } : {}),
    ...(params.get('sql') === '1' ? { showSql: true } : {}),
  }));
/** The state that the webview stores with `setState` and reads with `getState`. VS Code keeps this state for a real webview. */
let state: unknown = { datasets, cards };
Object.assign(window, {
  acquireVsCodeApi: () => ({
    postMessage: (message: unknown) => {
      const m = message as { type?: string; id?: string };
      if (m.type === 'cancel' && m.id) cancels.push(m.id);
      void dispatcher.handle(message);
    },
    getState: () => state,
    setState: (next: unknown) => {
      state = next;
    },
  }),
  /** The requests that the webview sent. A test can read this list. */
  tableVizExchanges: dispatcher.exchanges,
  /** The messages that are not requests: export, open SQL, save view. */
  tableVizSent: sent,
  /** The IDs of the requests that the webview cancelled. A test can read this list. */
  tableVizCancels: cancels,
});
