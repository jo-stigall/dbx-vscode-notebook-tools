/**
 * Tests for the content of each kind of detail card (src/tableViz/webview/cards).
 *
 * Each test draws a card from fixed results as HTML text, without a browser,
 * and looks for the numbers and the labels in that text. The results come
 * from the demo profiler, which gives the same numbers on each run. A chart
 * is a canvas, which has no text, so the tests check the sentence for screen
 * readers and the table that shows the same numbers.
 *
 * Source files that the tests cover:
 *
 * - src/tableViz/webview/cards/views.tsx and CardShell.tsx: the cards of one dataset
 * - src/tableViz/webview/compare/views.tsx and CompareOverview.tsx: the cards and the overview of compare mode
 * - src/tableViz/webview/options.ts: the chart options of the detailed view
 * - src/tableViz/webview/Board.tsx: `LargeTableNotice`
 *
 * Node.js cannot run a .tsx file. `npm run build` converts this file to
 * dist/test/cards.test.cjs with esbuild.
 *
 * Run all unit tests: npm run test:unit
 * Run this file only: npm run build && node --test dist/test/cards.test.cjs
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
import { LargeTableNotice, Board } from '../../../src/tableViz/webview/Board.tsx';
import { ConfirmView } from '../../../src/tableViz/webview/ConfirmView.tsx';
import { COMPARE_CONTEXT_SECTION, compareContext, CopyTableButton, TABLE_CONTEXT_SECTION, tableContext } from '../../../src/tableViz/webview/CopyTable.tsx';
import { DatasetBar } from '../../../src/tableViz/webview/DatasetBar.tsx';
import { DEFAULT_SETTINGS } from '../../../src/tableViz/core/schema.ts';
import { formatBytes } from '../../../src/tableViz/webview/format.ts';
import { CompareTable, compareRows, SchemaPanel } from '../../../src/tableViz/webview/compare/CompareOverview.tsx';
import type { DriftState } from '../../../src/tableViz/webview/compare/useCompare.ts';
import { ContinuousCompareView, DateCompareView, DriftLine, formatPoints, ValuesCompareView } from '../../../src/tableViz/webview/compare/views.tsx';
import { barsOption, compareBarsOption } from '../../../src/tableViz/webview/options.ts';
import { RequestError } from '../../../src/tableViz/webview/rpc.ts';
import { FALLBACK_THEME as theme } from '../../../src/tableViz/webview/theme.ts';

/** The demo table `demo.shop.orders_2026`: 110,000 rows. In the compare tests it is dataset B. */
const dataset: Dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
/** The demo profiler. It gives the results that the tests draw. */
const profiler = new DemoProfiler();
/**
 * Send one request to the demo profiler. The result has the type that fits the request.
 *
 * @example
 * const stats = await ask({ type: 'numericStats', dataset, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }] });
 * stats.min   // '2.33'
 */
const ask = <T extends Request>(request: T) => profiler.profile(request) as Promise<ResultOf<T['type']>>;
/** A function that does nothing. The tests give it to each `on...` prop, because static HTML has no events. */
const noop = () => {};

/**
 * Draw an element and return its text: the HTML without the tags, with one space between two pieces of text.
 *
 * @example
 * textOf(<table><tbody><tr><th>Count</th><td>110,000</td></tr></tbody></table>)   // ' Count 110,000 '
 */
function textOf(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/**
 * Get the columns and the overview numbers of the demo table.
 *
 * @example
 * const { column, stats, rowCount } = await tableFacts();
 * column('amount')             // { name: 'amount', typeText: 'decimal(10,2)' }
 * stats('region').distinct     // 4
 * rowCount                     // 110000
 */
async function tableFacts() {
  const details = await ask({ type: 'tableDetails', dataset });
  const overview = await ask({ type: 'overview', dataset, columns: details.columns.map((c) => ({ name: c.name, typeText: c.typeText })) });
  const column = (name: string) => details.columns.find((c) => c.name === name) as ColumnInfo;
  const stats = (name: string) => overview.columns.find((c) => c.name === name) as OverviewColumn;
  return { column, stats, rowCount: overview.rowCount };
}

/**
 * Make the state of a card. With no argument: a small card that is not pinned and shows its chart.
 *
 * The components under test do not read `column` of the card, so its value is the placeholder 'x'.
 *
 * @example
 * card({ asTable: true })    // the card shows its chart as a table
 * card({ expanded: true })   // the card is the detailed view of its column
 */
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

test('identifier card: lengths outside the edges have their own rows, and no filter button', async () => {
  const { column, stats, rowCount } = await tableFacts();
  const ref = { name: 'customer_id', typeText: 'string' };
  const frequency = await ask({ type: 'frequency', dataset, columns: [ref], top: 20 });
  // All values have 6 characters. With a sample, the histogram can read rows that the statistics did not read.
  const lengthEdges = makeEdges(6, 7, 1);
  const lengths = { ...(await ask({ type: 'histogram', dataset, columns: [ref], edges: lengthEdges, measure: 'length' })), below: 5, above: 7 };
  const props = { column: column('customer_id'), rowCount, stats: stats('customer_id'), approximate: false, frequency, lengths, lengthEdges, theme, onFilter: noop };

  const text = textOf(<IdentifierView {...props} card={card({ asTable: true })} />);
  assert.ok(text.includes('Fewer than 6 5'), text);
  assert.ok(text.includes('7 or more 7'), text);
  assert.ok(!text.includes('NaN'), text);
  const html = renderToStaticMarkup(<IdentifierView {...props} card={card({ asTable: true })} />);
  assert.ok(html.includes('aria-label="Filter the dataset to 6"'), 'the bin has a filter button');
  assert.ok(!html.includes('aria-label="Filter the dataset to Fewer than 6"') && !html.includes('aria-label="Filter the dataset to 7 or more"'), 'the bars outside the edges have none');
  assert.ok(!renderToStaticMarkup(<IdentifierView {...props} card={card()} />).includes('NaN'), 'the chart labels have no NaN');
});

test('large table: the question names the dataset in compare mode', () => {
  const size = 500 * 1024 ** 3;
  const single = textOf(<LargeTableNotice sizeBytes={size} onSample={noop} onReadAll={noop} />);
  assert.ok(single.includes(`This table is ${formatBytes(size)}.`), single);
  const b = textOf(<LargeTableNotice label="B" sizeBytes={size} onSample={noop} onReadAll={noop} />);
  assert.ok(b.includes(`Dataset B is ${formatBytes(size)}.`) && b.includes('Use a 1% sample') && b.includes('Read all rows'), b);
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

// ---- The detailed view of a column ----

test('detailed view of a number: large numbers at the top, and the small card has none', async () => {
  const { column, stats: overview } = await tableFacts();
  const amount = column('amount');
  const ref = { name: 'amount', typeText: amount.typeText };
  const stats = await ask({ type: 'numericStats', dataset, columns: [ref] });
  const edges = makeEdges(Number(stats.min), Number(stats.max), 30);
  const histogram = await ask({ type: 'histogram', dataset, columns: [ref], edges });
  const props = { column: amount, stats, histogram, edges, bins: 30, theme, onChange: noop, onBins: noop, distinct: overview('amount').distinct };

  const detailed = renderToStaticMarkup(<ContinuousView {...props} card={card({ expanded: true })} />);
  assert.ok(detailed.includes('class="tiles"'), 'the detailed view has the row of large numbers');
  const text = textOf(<ContinuousView {...props} card={card({ expanded: true })} />);
  for (const part of ['Count 110,000', 'Nulls 0 0%', 'Distinct 18,526', 'Mean 63', 'Median 49.26', 'Std. deviation 50.41', 'Min 2.33', 'Max 1202.88']) {
    assert.ok(text.includes(part), `"${part}" in: ${text}`);
  }
  // The table of statistics stays, next to the chart.
  assert.ok(text.includes('99th percentile 253.25'));
  assert.match(detailed, /class="card-main">.*class="card-side">/s);

  const small = renderToStaticMarkup(<ContinuousView {...props} card={card()} />);
  assert.ok(!small.includes('class="tiles"'), 'a small card has no row of large numbers');
});

test('detailed view of the other kinds: the facts that a person looks for first', async () => {
  const { column, stats, rowCount } = await tableFacts();
  const frequency = await ask({ type: 'frequency', dataset, columns: [{ name: 'region', typeText: 'string' }], top: 200 });
  const values = textOf(<ValuesView column={column('region')} kind="category" frequency={frequency} distinct={stats('region').distinct} topValues={20} card={card({ expanded: true })} theme={theme} onChange={noop} />);
  for (const part of ['Rows 110,000', 'Distinct values 4', 'Most frequent AMER 39.7%']) assert.ok(values.includes(part), `"${part}" in: ${values}`);

  const dates = textOf(<DateView column={column('order_date')} rowCount={rowCount} stats={stats('order_date')} dateCounts={undefined} grain="week" card={card({ expanded: true })} theme={theme} onChange={noop} />);
  for (const part of ['Earliest 2026-01-01', 'Latest 2026-12-31', 'Span 364 days']) assert.ok(dates.includes(part), `"${part}" in: ${dates}`);
  // While the chart loads, a block with the height of the chart holds its place.
  assert.ok(renderToStaticMarkup(<DateView column={column('order_date')} rowCount={rowCount} stats={stats('order_date')} dateCounts={undefined} grain="week" card={card({ expanded: true })} theme={theme} onChange={noop} />).includes('skeleton chart-wait tall'));

  const ids = textOf(<IdentifierView column={column('order_id')} rowCount={rowCount} stats={stats('order_id')} approximate={false} frequency={undefined} lengths={undefined} lengthEdges={undefined} card={card({ expanded: true })} theme={theme} />);
  for (const part of ['Rows 110,000', 'Distinct values 110,000', 'Percent unique 100%']) assert.ok(ids.includes(part), `"${part}" in: ${ids}`);
});

test('chart of the detailed view: axis titles, bar labels, and lines for the mean and the median', () => {
  type Axis = { id: string; type: string; name?: string; min?: number; max?: number };
  type Series = { id: string; label?: { show: boolean; formatter: (item: { dataIndex: number }) => string }; markLine?: { data: { xAxis: number; name: string }[] } };
  const input = { labels: ['0', '10', '20'], counts: [5, 0, 7], tips: ['a', 'b', 'c'] };

  const small = barsOption(theme, input) as { xAxis: Axis; yAxis: Axis; series: Series[] };
  assert.equal(small.xAxis.name, undefined);
  assert.equal(small.yAxis.name, undefined);
  assert.deepEqual(small.series.map((s) => s.id), ['a']);
  assert.equal(small.series[0]?.label, undefined);

  const detail = { categoryName: 'amount', countName: 'Rows', barLabels: ['5', '', '7'], numeric: { lo: 0, hi: 30, markers: [{ value: 12.5, label: 'Mean 12.5' }, { value: 11, label: 'Median 11' }] } };
  const large = barsOption(theme, { ...input, detail }) as unknown as { xAxis: Axis[]; yAxis: Axis; series: Series[] };
  // The second horizontal axis is an axis of numbers with the range of the bins. It has the title.
  assert.deepEqual(large.xAxis.map((axis) => [axis.id, axis.type]), [['x', 'category'], ['x2', 'value']]);
  assert.deepEqual([large.xAxis[1]?.min, large.xAxis[1]?.max, large.xAxis[1]?.name], [0, 30, 'amount']);
  assert.equal(large.yAxis.name, 'Rows');
  assert.equal(large.series[0]?.label?.formatter({ dataIndex: 2 }), '7');
  assert.deepEqual(large.series[1]?.markLine?.data.map((line) => [line.xAxis, line.name]), [[12.5, 'Mean 12.5'], [11, 'Median 11']]);

  // A horizontal chart (category values) has no axis of numbers for the bars, and no title next to the value labels.
  const horizontal = barsOption(theme, { ...input, horizontal: true, detail }) as { xAxis: Axis; yAxis: Axis; series: Series[] };
  assert.equal(horizontal.xAxis.name, 'Rows');
  assert.equal(horizontal.yAxis.name, undefined);
  assert.deepEqual(horizontal.series.map((s) => s.id), ['a']);

  // Two datasets: a label on each bar of A and of B.
  const pair = compareBarsOption(theme, { labels: ['x'], a: [40], b: [60], tips: ['t'], nameA: 'A', nameB: 'B', detail: { countName: 'Percent' }, labelsA: ['40.0%'], labelsB: ['60.0%'] }) as { series: Series[] };
  assert.deepEqual(pair.series.map((s) => s.label?.formatter({ dataIndex: 0 })), ['40.0%', '60.0%']);
});

test('card frame: the detailed view, and old numbers while new numbers load', async () => {
  const { column } = await tableFacts();
  const base: CardShellProps = { column: column('amount'), card: card(), kind: 'continuous', detected: 'continuous', kinds: ['continuous'], onChange: noop, onClose: noop, sql: [], approximate: false, hasChart: true, loading: false };

  const small = renderToStaticMarkup(<CardShell {...base} />);
  assert.ok(small.includes('class="card"') && small.includes('aria-label="Show the detailed view"') && small.includes('aria-busy="false"'));
  assert.ok(small.includes('data-card="amount"'), 'the board finds the card of a column by this attribute');

  const detailed = renderToStaticMarkup(<CardShell {...base} card={card({ expanded: true })} />);
  assert.ok(detailed.includes('class="card expanded"') && detailed.includes('aria-label="Show as a small card"'));

  // Old numbers stay on the card, dimmed, and a line shows that a query runs.
  const stale = renderToStaticMarkup(<CardShell {...base} stale>old numbers</CardShell>);
  assert.ok(stale.includes('class="card stale"') && stale.includes('aria-busy="true"') && stale.includes('busy-bar') && stale.includes('old numbers'));
  // An error stops the line.
  const failed = renderToStaticMarkup(<CardShell {...base} stale error={new RequestError('No access')} />);
  assert.ok(!failed.includes('busy-bar') && failed.includes('No access'));
});

// ---- Compare mode ----

/** Dataset A of the compare tests: `demo.shop.orders_2025`, 100,000 rows. Dataset B is `dataset`. */
const datasetA: Dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2025' } };
/** Send one request to the demo profiler. The compare functions take a function of this shape. */
const askDemo: Ask = (request) => profiler.profile(request) as never;

/**
 * Get the columns, the overview numbers and the drift of each pair of the two demo tables. A is 2025, B is 2026.
 *
 * The function does what the board does in compare mode, without React.
 *
 * @example
 * const { schema, a, b, drifts } = await comparison();
 * schema.pairs.length      // 17
 * a.rowCount               // 100000
 * drifts.get('store_id')   // { status: 'skip' }: the types differ, so the board does not compare the column
 *
 * @returns `schema`: the matched pairs of columns. `a` and `b`: the overview numbers in the form that `CompareTable` reads. `drifts`: the drift of each pair, with the name of the column in A as the key.
 */
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

  // While the numbers of B load, each cell of B shows "…". The Mean cell of a number column must not show "—".
  const loadingB = { ...b, rowCount: undefined, stats: new Map<string, OverviewColumn>() };
  const loadingRows = compareRows(schema, a, loadingB, new Map(), '', 'table');
  const loading = textOf(<CompareTable rows={loadingRows} a={a} b={loadingB} open={new Set()} onOpen={noop} />);
  assert.ok(loading.includes('discount_pct double 5.1% … 501 … 25.0209 … …'), loading);
  assert.ok(loading.includes('channel string 0% … 3 … — … …'), loading);
  assert.ok(text.includes('store_id int → string') && text.includes('Not compared'), text);
});

test('compare: the drift in words, with the null rate on its own line', async () => {
  const { drifts } = await comparison();
  const discount = (drifts.get('discount_pct') as { drift: Drift }).drift;
  const text = textOf(<DriftLine drift={discount} />);
  assert.ok(text.includes('Drift score 0.33 (Jensen-Shannon distance over 10 bins cut at the deciles of A, plus a bin for null;'), text);
  assert.match(text, /Population Stability Index \d+\.\d\d/);
  assert.ok(text.includes('Null rate: 5.1% in A, 34.9% in B (+29.8 pp)'), text);
  // A column with few different values has fewer than 10 bins. The sentence gives the real number.
  const few = textOf(<DriftLine drift={{ ...discount, bins: discount.bins.slice(0, 2) }} />);
  assert.ok(few.includes('over 2 bins cut at the deciles of A'), few);
  assert.ok(textOf(<DriftLine drift={{ ...discount, bins: discount.bins.slice(0, 1) }} />).includes('over 1 bin cut'));
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
  // In a compare card, `sortBy: 'label'` selects this sort. The value 'label' has a different meaning in a card of one dataset.
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

test('detailed compare card: a larger chart with the same numbers, and the table next to it', async () => {
  const pair = matchColumns([{ name: 'channel', typeText: 'string' }], [{ name: 'channel', typeText: 'string' }]).pairs[0];
  assert.ok(pair);
  const { a, b } = await comparedFrequency(askDemo, datasetA, dataset, pair, 200);
  const html = renderToStaticMarkup(<ValuesCompareView name="channel" a={a} b={b} topValues={20} card={card({ expanded: true })} theme={theme} onChange={noop} />);
  assert.match(html, /class="card-main">.*class="chart".*class="card-side">/s);
  assert.ok(textOf(<ValuesCompareView name="channel" a={a} b={b} topValues={20} card={card({ expanded: true })} theme={theme} onChange={noop} />).includes('web 59,630 59.6% 60,352 54.9% -4.8 pp'));
  // As a table, the card has no chart, and the table uses the full width.
  assert.ok(renderToStaticMarkup(<ValuesCompareView name="channel" a={a} b={b} topValues={20} card={card({ expanded: true, asTable: true })} theme={theme} onChange={noop} />).includes('class="card-body single"'));
});

test('compare: a drift score of the datasets before the last change is marked as old', async () => {
  const { schema, a, b, drifts } = await comparison();
  const old = new Map([...drifts].map(([name, state]): [string, DriftState] => [name, state.status === 'done' ? { ...state, stale: true } : state]));
  const html = renderToStaticMarkup(<CompareTable rows={compareRows(schema, a, b, old, '', 'drift')} a={{ ...a, stale: true }} b={b} open={new Set()} onOpen={noop} />);
  assert.ok(html.includes('class="columns compare stale"') && html.includes('aria-busy="true"') && html.includes('<span class="stale">'));
  // The rows keep the sequence of the old scores.
  assert.deepEqual(compareRows(schema, a, b, old, '', 'drift').map((r) => r.name), compareRows(schema, a, b, drifts, '', 'drift').map((r) => r.name));
});

test('copy table name: icon button and right-click context on board, dataset bar and saved view', () => {
  // Single-table board: copy icon next to the table name and right-click context on <main>.
  const singleHtml = renderToStaticMarkup(<Board datasets={{ a: dataset }} settings={DEFAULT_SETTINGS} />);
  assert.ok(singleHtml.includes('aria-label="Copy table name demo.shop.orders_2026"'), singleHtml);
  assert.ok(singleHtml.includes('codicon-copy'), singleHtml);
  assert.equal(JSON.parse(tableContext('demo.shop.orders_2026')).webviewSection, TABLE_CONTEXT_SECTION);
  assert.equal(JSON.parse(tableContext('demo.shop.orders_2026')).tableName, 'demo.shop.orders_2026');
  const mainContext = singleHtml.match(/<main[^>]*data-vscode-context="([^"]+)"/)?.[1]?.replace(/&quot;/g, '"');
  assert.deepEqual(JSON.parse(mainContext ?? 'null'), { webviewSection: TABLE_CONTEXT_SECTION, tableName: 'demo.shop.orders_2026' });

  // Compare-mode board: copy icons for A and B, compare context on <main>, and table context on each dataset bar and heading.
  const compareHtml = renderToStaticMarkup(<Board datasets={{ a: datasetA, b: dataset }} settings={DEFAULT_SETTINGS} />);
  assert.ok(compareHtml.includes('aria-label="Copy table name demo.shop.orders_2025"'));
  assert.ok(compareHtml.includes('aria-label="Copy table name demo.shop.orders_2026"'));
  const compareMain = compareHtml.match(/<main[^>]*data-vscode-context="([^"]+)"/)?.[1]?.replace(/&quot;/g, '"');
  assert.deepEqual(JSON.parse(compareMain ?? 'null'), {
    webviewSection: COMPARE_CONTEXT_SECTION,
    tableNameA: 'demo.shop.orders_2025',
    tableNameB: 'demo.shop.orders_2026',
  });
  assert.equal(compareContext('a.b.c', 'd.e.f'), JSON.stringify({ webviewSection: COMPARE_CONTEXT_SECTION, tableNameA: 'a.b.c', tableNameB: 'd.e.f' }));

  // Compare dataset bar carries its own table context and copy button; single-table dataset bar does not duplicate them.
  const barB = renderToStaticMarkup(<DatasetBar label="B" dataset={dataset} pinned={dataset} facts={undefined} asOf={undefined} onChange={noop} />);
  assert.ok(barB.includes('aria-label="Copy table name demo.shop.orders_2026"'));
  const barContext = barB.match(/data-vscode-context="([^"]+)"/)?.[1]?.replace(/&quot;/g, '"');
  assert.deepEqual(JSON.parse(barContext ?? 'null'), { webviewSection: TABLE_CONTEXT_SECTION, tableName: 'demo.shop.orders_2026' });
  const barSingle = renderToStaticMarkup(<DatasetBar dataset={dataset} pinned={dataset} facts={undefined} asOf={undefined} onChange={noop} />);
  assert.ok(!barSingle.includes('data-vscode-context'));
  assert.ok(!barSingle.includes('copy-table-button'));

  // Saved-view confirmation screen includes copy icons and right-click context for single and compare views.
  const confirmSingle = renderToStaticMarkup(<ConfirmView datasets={{ a: dataset }} onApprove={noop} />);
  assert.ok(confirmSingle.includes('aria-label="Copy table name demo.shop.orders_2026"'));
  const confirmCompare = renderToStaticMarkup(<ConfirmView datasets={{ a: datasetA, b: dataset }} onApprove={noop} />);
  assert.ok(confirmCompare.includes('aria-label="Copy table name demo.shop.orders_2025"'));
  assert.ok(confirmCompare.includes('aria-label="Copy table name demo.shop.orders_2026"'));
  const confirmMain = confirmCompare.match(/<main[^>]*data-vscode-context="([^"]+)"/)?.[1]?.replace(/&quot;/g, '"');
  assert.deepEqual(JSON.parse(confirmMain ?? 'null'), {
    webviewSection: COMPARE_CONTEXT_SECTION,
    tableNameA: 'demo.shop.orders_2025',
    tableNameB: 'demo.shop.orders_2026',
  });

  // Standalone button renders accessible copy control.
  const btn = renderToStaticMarkup(<CopyTableButton name="main.`my schema`.orders" />);
  assert.ok(btn.includes('title="Copy main.`my schema`.orders"') && btn.includes('codicon-copy'));
});
