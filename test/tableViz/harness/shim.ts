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
 *
 * `cards` opens detail cards at the start. Example: `cards=amount,region`.
 * `b` names a second table. The board then compares the two tables.
 * `large=1` makes the board ask before it reads all rows of the table.
 * `kind=identifier` sets the kind of the first card, `astable=1` shows its
 * chart as a table, and `sql=1` shows the SQL of each card.
 * `detail=1` shows the first card as the detailed view of its column.
 * `delay=800` makes each answer arrive 800 ms late, so that a person can see
 * how the page looks while it loads.
 */
import { parseTableName } from '../../../src/tableViz/core/names.ts';
import { createDispatcher } from '../../../src/tableViz/core/profiler.ts';
import { columnKindSchema, DEFAULT_SETTINGS, type BoardDatasets, type Card, type ToWebview } from '../../../src/tableViz/core/schema.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';

const params = new URLSearchParams(location.search);
const table = parseTableName(params.get('table') ?? '') ?? { catalog: 'demo', schema: 'shop', name: 'orders_2026' };
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';

// `b=demo.shop.orders_2026` puts a second table on the board: compare mode.
const tableB = parseTableName(params.get('b') ?? '');
const datasets: BoardDatasets = { a: { profile: 'Demo', table }, ...(tableB ? { b: { profile: 'Demo', table: tableB } } : {}) };
let approved = params.get('confirm') !== '1';
const sent: unknown[] = [];
const profiler = new DemoProfiler();
const delay = Number(params.get('delay')) || 0;
const post = (message: ToWebview) => {
  if (delay > 0 && message.type !== 'init') setTimeout(() => window.postMessage(message, '*'), delay);
  else window.postMessage(message, '*');
};
const dispatcher = createDispatcher({
  profilerFor: () => profiler,
  post,
  makeSignal: () => {
    const controller = new AbortController();
    return { signal: controller.signal, cancel: () => controller.abort() };
  },
  // `large=1` sets the size limit to 1 MB, so that the demo table is "too large" and the board asks before it reads all rows.
  onOther: (message) => {
    // `confirm=1` shows the question that a saved view asks. A click on its button sends "approve".
    if (message.type === 'approve') approved = true;
    if (message.type === 'ready' || message.type === 'approve') {
      post({ type: 'init', datasets, settings: { ...DEFAULT_SETTINGS, ...(params.get('large') === '1' ? { largeTableBytes: 1024 ** 2 } : {}) }, ...(approved ? {} : { confirm: true }) });
    } else {
      // The test page cannot write files. Keep the message so that a person can look at it.
      sent.push(message);
    }
  },
});

// The cards from the page URL go into the stored state, as if the board was open before a reload.
const kind = columnKindSchema.safeParse(params.get('kind'));
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
let state: unknown = { datasets, cards };
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
  /** The messages that are not requests: export, open SQL, save view. */
  tableVizSent: sent,
});
