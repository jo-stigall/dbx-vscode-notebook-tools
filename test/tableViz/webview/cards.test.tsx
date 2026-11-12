/**
 * Tests for the content of each kind of detail card (src/tableViz/webview/cards).
 *
 * Each test draws a card from fixed results as HTML text, without a browser,
 * and looks for the numbers and the labels in that text. The results come
 * from the demo profiler, which gives the same numbers on each run. A chart
 * is a canvas, which has no text, so the tests check the sentence for screen
 * readers and the table that shows the same numbers.
 *
 * Run: npm run test:unit   (the command converts this file with esbuild first)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chooseGrain, makeEdges } from '../../../src/tableViz/core/bins.ts';
import { columnDrift, compareKind, comparedFrequency, type Ask } from '../../../src/tableViz/core/compare.ts';
import type { Drift } from '../../../src/tableViz/core/drift.ts';
import { matchColumns } from '../../../src/tableViz/core/match.ts';
import type { Card, ColumnInfo, Dataset, OverviewColumn, Request, ResultOf } from '../../../src/tableViz/core/schema.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';
import { CardShell, type CardShellProps } from '../../../src/tableViz/webview/cards/CardShell.tsx';
import { ComplexView, ContinuousView, DateView, IdentifierView, ValuesView } from '../../../src/tableViz/webview/cards/views.tsx';
import { CompareTable, compareRows, SchemaPanel } from '../../../src/tableViz/webview/compare/CompareOverview.tsx';
import type { DriftState } from '../../../src/tableViz/webview/compare/useCompare.ts';
import { ContinuousCompareView, DateCompareView, DriftLine, formatPoints, ValuesCompareView } from '../../../src/tableViz/webview/compare/views.tsx';
import { FALLBACK_THEME as theme } from '../../../src/tableViz/webview/theme.ts';

const dataset: Dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
const profiler = new DemoProfiler();
const ask = <T extends Request>(request: T) => profiler.profile(request) as Promise<ResultOf<T['type']>>;
const noop = () => {};

/** Draw an element and return its text: the HTML without the tags, with one space between two pieces of text. */
function textOf(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** Get the columns and the overview numbers of the demo table. */
async function tableFacts() {
  const details = await ask({ type: 'tableDetails', dataset });
  const overview = await ask({ type: 'overview', dataset, columns: details.columns.map((c) => ({ name: c.name, typeText: c.typeText })) });
  const column = (name: string) => details.columns.find((c) => c.name === name) as ColumnInfo;
  const stats = (name: string) => overview.columns.find((c) => c.name === name) as OverviewColumn;
  return { column, stats, rowCount: overview.rowCount };
}

const card = (patch: Partial<Card> = {}): Card => ({ column: 'x', pinned: false, ...patch });

test('continuous card: statistics, histogram sentence and histogram table', async () => {
  const { column } = await tableFacts();
  const amount = column('amount');
  const ref = { name: 'amount', typeText: amount.typeText };
  const stats = await ask({ type: 'numericStats', dataset, columns: [ref] });
  const edges = makeEdges(Number(stats.min), Number(stats.max), 30);
  const histogram = await ask({ type: 'histogram', dataset, columns: [ref], edges });
  const props = { column: amount, stats, histogram, edges, bins: 30, theme, onChange: noop, onBins: noop };

  const html = renderToStaticMarkup(<ContinuousView {...props} card={card()} />);
  assert.match(html, /aria-label="Histogram of amount with 30 bars\."/);
  const text = textOf(<ContinuousView {...props} card={card()} />);
  for (const part of ['Count 110,000', 'Nulls 0 (0%)', 'Zeros 0', 'Mean 63.0015', 'Standard deviation 50.4107', 'Min 2.33', 'Median 49.26', '99th percentile 253.25', 'Max 1202.88']) {
    assert.ok(text.includes(part), `"${part}" in: ${text}`);
  }
  assert.ok(!text.includes('≈'), 'exact numbers have no ≈');

  // As a table: one row for each bin, with the same counts as the chart.
  const table = textOf(<ContinuousView {...props} card={card({ asTable: true })} />);
  assert.ok(table.includes('Range Rows Percent'));
  assert.ok(table.includes(`2.33 to 42.35 ${histogram.counts[0]?.toLocaleString('en-US')} 41.3%`), table);
  assert.ok(!renderToStaticMarkup(<ContinuousView {...props} card={card({ asTable: true })} />).includes('class="chart"'));

  // An estimate has the ≈ mark on the percentiles.
  assert.ok(textOf(<ContinuousView {...props} stats={{ ...stats, approximate: true }} card={card()} />).includes('Median ≈ 49.26'));
  // While the histogram loads, the statistics show.
  const loading = textOf(<ContinuousView {...props} histogram={undefined} edges={undefined} card={card()} />);
  assert.ok(loading.includes('Loading the histogram…') && loading.includes('Median 49.26'));
});

test('continuous card: a clipped histogram has bars for the values outside the range', async () => {
  const { column } = await tableFacts();
  const ref = { name: 'amount', typeText: column('amount').typeText };
  const stats = await ask({ type: 'numericStats', dataset, columns: [ref] });
  const edges = makeEdges(stats.percentiles[0]?.value as number, stats.percentiles[6]?.value as number, 10);
  const histogram = await ask({ type: 'histogram', dataset, columns: [ref], edges });
  assert.ok(histogram.below > 0 && histogram.above > 0);
  const text = textOf(
    <ContinuousView column={column('amount')} stats={stats} histogram={histogram} edges={edges} bins={10} card={card({ clip: true, asTable: true })} theme={theme} onChange={noop} onBins={noop} />
  );
  assert.ok(text.includes(`Below 9.78 ${histogram.below.toLocaleString('en-US')}`), text);
  assert.ok(text.includes(`Above 253.3 ${histogram.above.toLocaleString('en-US')}`), text);
});

test('continuous card: a column where all rows are null', async () => {
  const { column } = await tableFacts();
  const stats: ResultOf<'numericStats'> = { type: 'numericStats', sql: [], approximate: false, asOf: '', rowCount: 10, nonNull: 0, zeros: 0, negatives: 0, percentiles: [] };
  const text = textOf(
    <ContinuousView column={column('amount')} stats={stats} histogram={undefined} edges={undefined} bins={30} card={card()} theme={theme} onChange={noop} onBins={noop} />
  );
  assert.ok(text.includes('All rows are null.') && text.includes('Nulls 10 (100%)') && text.includes('Mean —'), text);
});

test('category card: top values, Other and null', async () => {
  const { column, stats } = await tableFacts();
  const status = column('status');
  const frequency = await ask({ type: 'frequency', dataset, columns: [{ name: 'status', typeText: 'string' }], top: 200 });
  const props = { column: status, kind: 'category' as const, frequency, distinct: stats('status').distinct, topValues: 20, theme, onChange: noop };
  const text = textOf(<ValuesView {...props} card={card()} />);
  assert.ok(text.includes('Value Rows Percent Cumulative'));
  assert.ok(text.includes('delivered 89,165 81.1% 81.1% shipped 9,768 8.9% 89.9%'), text);
  assert.ok(text.includes('(null) 1,123 1%'), text);
  assert.ok(!text.includes('Other'), 'all values are in the list, so there is no "Other" row');
  assert.match(renderToStaticMarkup(<ValuesView {...props} card={card()} />), /aria-label="Most frequent values of status, 5 bars\."/);

  // With 2 values in the chart, the 3rd and 4th value go into "Other".
  assert.match(renderToStaticMarkup(<ValuesView {...props} topValues={2} card={card()} />), /aria-label="Most frequent values of status, 4 bars\."/);
  // Sort by label.
  const byLabel = textOf(<ValuesView {...props} card={card({ sortBy: 'label' })} />);
  assert.ok(byLabel.indexOf('cancelled') < byLabel.indexOf('delivered') && byLabel.indexOf('delivered') < byLabel.indexOf('returned'));
});

test('category card: a column with more values than the table shows', async () => {
  const { column, stats } = await tableFacts();
  const frequency = await ask({ type: 'frequency', dataset, columns: [{ name: 'postal_code', typeText: 'int' }], top: 200 });
  const text = textOf(
    <ValuesView column={column('postal_code')} kind="category" frequency={frequency} distinct={stats('postal_code').distinct} topValues={20} card={card()} theme={theme} onChange={noop} />
  );
  assert.ok(text.includes('The table shows the 200 most frequent of 900 values.'), text);
  assert.ok(text.includes('Other'), text);
});

test('discrete card: one bar for each value, in the sequence of the values', async () => {
  const { column, stats } = await tableFacts();
  const frequency = await ask({ type: 'frequency', dataset, columns: [{ name: 'quantity', typeText: 'int' }], top: 50 });
  const element = <ValuesView column={column('quantity')} kind="discrete" frequency={frequency} distinct={stats('quantity').distinct} topValues={20} card={card()} theme={theme} onChange={noop} />;
  assert.match(renderToStaticMarkup(element), /aria-label="Rows for each value of quantity, 7 bars\."/);
  const text = textOf(element);
  assert.ok(text.includes('1 55,007 50% 50% 2 27,670 25.2% 75.2%'), text);
  // 8 comes after 6: the values sort as numbers, not as text.
  assert.ok(text.indexOf(' 6 2,213') < text.indexOf(' 8 1,057'), text);
  assert.ok(!text.includes('Sort by'), 'a discrete card has no sort control');
});

test('identifier card: distinct count, repeated values and value lengths', async () => {
  const { column, stats, rowCount } = await tableFacts();
  const ref = { name: 'customer_id', typeText: 'string' };
  const frequency = await ask({ type: 'frequency', dataset, columns: [ref], top: 20 });
  const lengthStats = await ask({ type: 'numericStats', dataset, columns: [ref], measure: 'length' });
  const lengthEdges = makeEdges(Number(lengthStats.min), Number(lengthStats.max) + 1, 1);
  const lengths = await ask({ type: 'histogram', dataset, columns: [ref], edges: lengthEdges, measure: 'length' });
  const props = { column: column('customer_id'), rowCount, stats: stats('customer_id'), frequency, lengths, lengthEdges, theme };

  const text = textOf(<IdentifierView {...props} approximate={false} card={card({ asTable: true })} />);
  assert.ok(text.includes('Distinct values 34,620'), text);
  assert.ok(text.includes('Percent unique 31.5%'), text);
  assert.ok(text.includes('Most repeated values Value Rows Percent C00000 550 0.5%'), text);
  assert.ok(text.includes('Length of the values Characters Rows Percent 6 110,000 100%'), text);
  assert.ok(textOf(<IdentifierView {...props} approximate card={card()} />).includes('Distinct values ≈ 34,620'));

  // A column where each value occurs one time.
  const idRef = { name: 'order_id', typeText: 'bigint' };
  const unique = await ask({ type: 'frequency', dataset, columns: [idRef], top: 20 });
  const uniqueText = textOf(
    <IdentifierView column={column('order_id')} rowCount={rowCount} stats={stats('order_id')} approximate={false} frequency={unique} lengths={undefined} lengthEdges={undefined} card={card()} theme={theme} />
  );
  assert.ok(uniqueText.includes('Percent unique 100%') && uniqueText.includes('No value occurs more than one time.'), uniqueText);
});

test('date card: counts for each period, first and last date, empty periods', async () => {
  const { column, stats, rowCount } = await tableFacts();
  const s = stats('order_ts');
  const grain = chooseGrain(s.min as string, s.max as string);
  assert.equal(grain, 'week');
  const dateCounts = await ask({ type: 'dateCounts', dataset, columns: [{ name: 'order_ts', typeText: 'timestamp' }], grain });
  const props = { column: column('order_ts'), rowCount, stats: s, dateCounts, grain, theme, onChange: noop };
  assert.match(renderToStaticMarkup(<DateView {...props} card={card()} />), /aria-label="Rows of order_ts for each week, 53 periods\."/);
  const text = textOf(<DateView {...props} card={card()} />);
  assert.ok(text.includes('Earliest 2026-01-01 Latest 2026-12-31 Span 364 days Empty weeks 0 Nulls 0 (0%)'), text);
  assert.ok(textOf(<DateView {...props} card={card({ asTable: true })} />).includes('Start of the week Rows Percent 2025-12-29 1,073'));

  // A gap in the data shows as empty periods.
  const gap = { ...dateCounts, grain: 'month' as const, buckets: [{ start: '2026-01-01', count: 5 }, { start: '2026-04-01', count: 7 }] };
  assert.ok(textOf(<DateView {...props} dateCounts={gap} grain="month" card={card()} />).includes('Empty months 2'));
});

test('complex card: the type and the nulls only', async () => {
  const { column, stats, rowCount } = await tableFacts();
  const element = <ComplexView column={column('items')} rowCount={rowCount} stats={stats('items')} />;
  const text = textOf(element);
  assert.ok(text.includes('Type array<string>') || text.includes('Type array&lt;string&gt;'), text);
  assert.ok(text.includes('Nulls 2,185 (2%)'), text);
  assert.ok(!renderToStaticMarkup(element).includes('class="chart"'));
});

test('card frame: buttons, kind override, SQL and the estimate note', async () => {
  const { column } = await tableFacts();
  const base: CardShellProps = {
    column: column('postal_code'),
    card: card(),
    kind: 'continuous',
    detected: 'continuous',
    kinds: ['continuous', 'discrete', 'category', 'identifier'],
    onChange: noop,
    onClose: noop,
    sql: ['SELECT 1'],
    approximate: false,
    hasChart: true,
    loading: false,
  };
  const html = renderToStaticMarkup(<CardShell {...base} />);
  // Each button has a name for a screen reader.
  for (const label of ['Kind of column', 'Show the chart as a table', 'Show SQL', 'Pin the card to the board', 'Close the card']) {
    assert.ok(html.includes(`aria-label="${label}"`), label);
  }
  assert.ok(html.includes('Number (detected)') && html.includes('<option value="category">Category</option>'));
  assert.ok(!html.includes('SELECT 1'), 'the SQL is hidden until the user asks for it');
  assert.ok(!html.includes('Compute exactly'));

  const open = renderToStaticMarkup(<CardShell {...base} kind="category" card={card({ showSql: true, pinned: true, asTable: true, kind: 'category' })} approximate />);
  assert.ok(open.includes('<pre>SELECT 1</pre>'));
  assert.ok(open.includes('aria-label="Unpin the card"') && open.includes('aria-label="Show the chart"') && open.includes('aria-label="Hide SQL"'));
  assert.ok(open.includes('Compute exactly'));
  assert.match(open, /<option value="category" selected="">Category<\/option>/);

  // A card without a chart has no table button. A card with one kind has no kind list.
  const plain = renderToStaticMarkup(<CardShell {...base} kinds={['complex']} hasChart={false} />);
  assert.ok(!plain.includes('Show the chart as a table') && !plain.includes('Kind of column'));
});

// ---- Compare mode ----

const datasetA: Dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2025' } };
const askDemo: Ask = (request) => profiler.profile(request) as never;

/** Get the columns, the overview numbers and the drift of each pair of the two demo tables. A is 2025, B is 2026. */
async function comparison() {
  const [detailsA, detailsB] = await Promise.all([ask({ type: 'tableDetails', dataset: datasetA }), ask({ type: 'tableDetails', dataset })]);
  const refs = (columns: ColumnInfo[]) => columns.map((c) => ({ name: c.name, typeText: c.typeText }));
  const [overviewA, overviewB] = await Promise.all([
    ask({ type: 'overview', dataset: datasetA, columns: refs(detailsA.columns) }),
    ask({ type: 'overview', dataset, columns: refs(detailsB.columns) }),
  ]);
  const schema = matchColumns(detailsA.columns, detailsB.columns);
  const stateOf = (o: typeof overviewA) => ({ rowCount: o.rowCount, stats: new Map(o.columns.map((c) => [c.name, c])), approximate: false, sql: new Map<string, string[]>() });
  const a = stateOf(overviewA);
  const b = stateOf(overviewB);
  const drifts = new Map<string, DriftState>();
  for (const pair of schema.pairs) {
    const sa = a.stats.get(pair.a.name) as OverviewColumn;
    const sb = b.stats.get(pair.b.name) as OverviewColumn;
    const kind = compareKind(pair, sa, sb, false);
    const drift = await columnDrift(askDemo, datasetA, dataset, pair, kind, a.rowCount, sa, b.rowCount, sb);
    drifts.set(pair.a.name, drift ? { status: 'done', drift, kind } : { status: 'skip' });
  }
  return { schema, a, b, drifts };
}

test('compare: the list of columns shows what is in one dataset only and which types differ', async () => {
  const { schema } = await comparison();
  const text = textOf(<SchemaPanel schema={schema} asText={[]} onAsText={noop} />);
  assert.ok(text.includes('Columns: 17 in A and B · 1 only in A · 1 only in B · 1 with different types'), text);
  assert.ok(text.includes('Only in A coupon_code (string) Only in B loyalty_tier (string)'), text);
  assert.ok(text.includes('store_id: int in A, string in B. Compare as text'), text);
  const html = renderToStaticMarkup(<SchemaPanel schema={schema} asText={['store_id']} onAsText={noop} />);
  assert.match(html, /<input type="checkbox" checked=""/);
});

test('compare: the overview sorted by drift has the changed columns first', async () => {
  const { schema, a, b, drifts } = await comparison();
  const rows = compareRows(schema, a, b, drifts, '', 'drift');
  assert.deepEqual(rows.slice(0, 5).map((r) => r.name).sort(), ['amount', 'channel', 'discount_pct', 'order_date', 'order_ts']);
  assert.equal(rows.at(-1)?.name, 'store_id', 'a column that is not compared goes last');
  assert.deepEqual(compareRows(schema, a, b, drifts, 'ORDER_', 'table').map((r) => r.name), ['order_id', 'order_ts', 'order_date']);

  const text = textOf(<CompareTable rows={rows} a={a} b={b} open={new Set(['channel'])} onOpen={noop} />);
  assert.ok(text.includes('Column Type Null A Null B Distinct A Distinct B Mean A Mean B Drift'), text);
  assert.ok(text.includes('discount_pct double 5.1% 34.9% 501 501 25.0209 25.0389 0.33'), text);
  assert.ok(text.includes('channel string 0% 0% 3 4 — — 0.25'), text);
  assert.ok(text.includes('store_id int → string') && text.includes('Not compared'), text);
});

test('compare: the drift in words, with the null rate on its own line', async () => {
  const { drifts } = await comparison();
  const discount = (drifts.get('discount_pct') as { drift: Drift }).drift;
  const text = textOf(<DriftLine drift={discount} />);
  assert.ok(text.includes('Drift score 0.33 (Jensen-Shannon distance over 10 bins cut at the deciles of A'), text);
  assert.match(text, /Population Stability Index \d+\.\d\d/);
  assert.ok(text.includes('Null rate: 5.1% in A, 34.9% in B (+29.8 pp)'), text);
  assert.equal(formatPoints(0), '0 pp');
  assert.equal(formatPoints(-0.048), '-4.8 pp');
});

test('compare card of a number: the same bins for A and B, and the statistics side by side', async () => {
  const ref = { name: 'amount', typeText: 'decimal(10,2)' };
  const [statsA, statsB] = await Promise.all([ask({ type: 'numericStats', dataset: datasetA, columns: [ref] }), ask({ type: 'numericStats', dataset, columns: [ref] })]);
  const edges = makeEdges(Math.min(Number(statsA.min), Number(statsB.min)), Math.max(Number(statsA.max), Number(statsB.max)), 10);
  const [histogramA, histogramB] = await Promise.all([ask({ type: 'histogram', dataset: datasetA, columns: [ref], edges }), ask({ type: 'histogram', dataset, columns: [ref], edges })]);
  assert.equal(histogramA.below + histogramA.above + histogramB.below + histogramB.above, 0, 'the shared bins contain all values of A and B');
  const props = { name: 'amount', statsA, statsB, histogramA, histogramB, edges, bins: 10, theme, onChange: noop, onBins: noop };

  assert.match(renderToStaticMarkup(<ContinuousCompareView {...props} card={card()} />), /aria-label="Histogram of amount with the same 10 bins for A and B\. Dataset A and dataset B\."/);
  const table = textOf(<ContinuousCompareView {...props} card={card({ asTable: true })} />);
  assert.ok(table.includes('Range A rows A % B rows B % Difference'), table);
  assert.ok(table.includes(`${histogramA.counts[0]?.toLocaleString('en-US')}`) && table.includes(`${histogramB.counts[0]?.toLocaleString('en-US')}`), table);
  assert.ok(table.includes('Statistic A B Difference Change'), table);
  assert.ok(table.includes('Count 100,000 110,000 +10,000 +10.0%'), table);
  assert.ok(table.includes('Mean 46.7535 63.0015 +16.248 +34.8%'), table);
  // Side by side: two charts.
  const sides = renderToStaticMarkup(<ContinuousCompareView {...props} card={card({ sideBySide: true })} />);
  assert.equal(sides.split('class="chart"').length - 1, 2);
});

test('compare card of a category: the values of A and B, and a value that one dataset lacks', async () => {
  const pair = matchColumns([{ name: 'channel', typeText: 'string' }], [{ name: 'channel', typeText: 'string' }]).pairs[0];
  assert.ok(pair);
  const { a, b } = await comparedFrequency(askDemo, datasetA, dataset, pair, 200);
  const text = textOf(<ValuesCompareView name="channel" a={a} b={b} topValues={20} card={card()} theme={theme} onChange={noop} />);
  assert.ok(text.includes('Value A rows A % B rows B % Difference'), text);
  assert.ok(text.includes('web 59,630 59.6% 60,352 54.9% -4.8 pp'), text);
  assert.ok(text.includes('marketplace only in B 0 0% 13,283 12.1% +12.1 pp'), text);
  // Sorted by the size of the difference, the new value comes first.
  const bySize = textOf(<ValuesCompareView name="channel" a={a} b={b} topValues={20} card={card({ sortBy: 'label' })} theme={theme} onChange={noop} />);
  assert.ok(bySize.indexOf('marketplace') < bySize.indexOf('store'), bySize);
});

test('compare card of a date: one axis for A and B', async () => {
  const { a, b } = await comparison();
  const ref = { name: 'order_date', typeText: 'date' };
  const [countsA, countsB] = await Promise.all([ask({ type: 'dateCounts', dataset: datasetA, columns: [ref], grain: 'month' }), ask({ type: 'dateCounts', dataset, columns: [ref], grain: 'month' })]);
  const props = { name: 'order_date', statsA: a.stats.get('order_date') as OverviewColumn, statsB: b.stats.get('order_date') as OverviewColumn, countsA, countsB, grain: 'month' as const, theme, onChange: noop };
  assert.match(renderToStaticMarkup(<DateCompareView {...props} card={card()} />), /Rows of order_date for each month, 24 periods\./);
  const text = textOf(<DateCompareView {...props} card={card({ asTable: true })} />);
  // A has rows in 2025 only, B in 2026 only.
  assert.ok(text.includes(`2025-01-01 ${countsA.buckets[0]?.count.toLocaleString('en-US')}`) && text.includes('2026-01-01 0 0%'), text);
  assert.ok(text.includes('Earliest 2025-01-01 2026-01-01') && text.includes('Latest 2025-12-31 2026-12-31'), text);
});
