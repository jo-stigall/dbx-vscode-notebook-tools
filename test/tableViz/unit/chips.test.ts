/**
 * Tests for filter chips: the conditions that a click on a chart adds to a dataset.
 *
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEdges } from '../../../src/tableViz/core/bins.ts';
import { addChip, chipForBins, chipForPeriods, chipForValue, chipLabel, removeChip } from '../../../src/tableViz/core/derive.ts';
import type { Chip, Dataset, ResultOf } from '../../../src/tableViz/core/schema.ts';
import { datasetSchema } from '../../../src/tableViz/core/schema.ts';
import { buildStatements } from '../../../src/tableViz/core/sql.ts';
import { demoTable, formatDemoValue, type DemoTable } from '../../../src/tableViz/demo/data.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';

const dataset: Dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
const table = demoTable(dataset.table) as DemoTable;
const values = (name: string) => (table.columns.find((c) => c.name === name) as DemoTable['columns'][number]).values;
const region = { name: 'region', typeText: 'string' };
const amount = { name: 'amount', typeText: 'decimal(10,2)' };
const discount = { name: 'discount_pct', typeText: 'double' };
const orderDate = { name: 'order_date', typeText: 'date' };
const demo = new DemoProfiler();
const rowCount = async (chips: Chip[]) =>
  ((await demo.profile({ type: 'overview', dataset: { ...dataset, chips }, columns: [region] })) as ResultOf<'overview'>).rowCount;

test('a click on a chart makes a chip', () => {
  assert.deepEqual(chipForValue(region, 'value', 'EMEA'), { op: 'eq', column: region, value: 'EMEA' });
  assert.deepEqual(chipForValue(region, 'null', '(null)'), { op: 'null', column: region });
  assert.equal(chipForValue(region, 'other', 'Other'), undefined);

  const edges = makeEdges(0, 100, 4);
  assert.deepEqual(chipForBins(amount, edges, 1, 2), { op: 'range', column: amount, lo: 25, hi: 75 });
  assert.deepEqual(chipForBins(amount, edges, 2, 1), { op: 'range', column: amount, lo: 25, hi: 75 }, 'a drag from right to left');
  assert.deepEqual(chipForBins(amount, edges, 3, 3), { op: 'range', column: amount, lo: 75, hi: 100, includeHi: true });
  assert.deepEqual(chipForBins(amount, edges, 0, 9), { op: 'range', column: amount, lo: 0, hi: 100, includeHi: true });
  assert.deepEqual(chipForBins(region, edges, 0, 0, 'length'), { op: 'range', column: region, lo: 0, hi: 25, measure: 'length' });

  const day = (iso: string) => Date.parse(iso) / 86_400_000;
  assert.deepEqual(chipForPeriods(orderDate, '2026-01-01', '2026-02-01', 'month'), { op: 'range', column: orderDate, measure: 'day', lo: day('2026-01-01'), hi: day('2026-03-01') });
  assert.deepEqual(chipForPeriods(orderDate, '2026-01-05', '2026-01-05', 'week'), { op: 'range', column: orderDate, measure: 'day', lo: day('2026-01-05'), hi: day('2026-01-12') });
});

test('chipLabel writes a chip for a person', () => {
  assert.equal(chipLabel({ op: 'eq', column: region, value: 'EMEA' }), 'region = EMEA');
  assert.equal(chipLabel({ op: 'null', column: discount }), 'discount_pct is null');
  assert.equal(chipLabel({ op: 'range', column: amount, lo: 25, hi: 75.123456789 }), 'amount: 25 to 75.1235');
  assert.equal(chipLabel(chipForPeriods(orderDate, '2026-01-01', '2026-01-01', 'month')), 'order_date: 2026-01-01 to 2026-01-31');
  assert.equal(chipLabel({ op: 'range', column: region, measure: 'length', lo: 4, hi: 6 }), 'length of region: 4 to 6');
});

test('addChip and removeChip', () => {
  const chip: Chip = { op: 'eq', column: region, value: 'EMEA' };
  const one = addChip(dataset, chip);
  assert.deepEqual(one.chips, [chip]);
  assert.equal(addChip(one, { ...chip }), one, 'the same chip is not added a second time');
  const two = addChip(one, { op: 'null', column: discount });
  assert.equal(two.chips?.length, 2);
  assert.deepEqual(removeChip(two, 0).chips, [{ op: 'null', column: discount }]);
  assert.equal(removeChip(one, 0).chips, undefined);
  assert.ok(datasetSchema.safeParse(two).success);
  assert.equal(datasetSchema.safeParse({ ...dataset, chips: [{ op: 'sql', column: region, value: '1=1' }] }).success, false, 'a chip cannot be SQL text');
});

test('the SQL of a chip has parameters only', () => {
  const chips: Chip[] = [
    { op: 'eq', column: region, value: "EMEA' OR '1'='1" },
    { op: 'null', column: discount },
    { op: 'range', column: amount, lo: 10, hi: 20 },
    { op: 'range', column: orderDate, measure: 'day', lo: 20454, hi: 20485, includeHi: true },
  ];
  const [statement] = buildStatements({ type: 'frequency', dataset: { ...dataset, filter: 'quantity > 1', chips }, columns: [region], top: 5 });
  assert.ok(statement);
  const where = statement.sql.slice(statement.sql.indexOf('WHERE'), statement.sql.indexOf('GROUP BY')).trim();
  assert.equal(
    where,
    [
      'WHERE (',
      '    quantity > 1',
      '  ) AND CAST(IDENTIFIER(:c0) AS STRING) = :f0 AND IDENTIFIER(:c1) IS NULL AND (CAST(IDENTIFIER(:c2) AS DOUBLE) >= :f2lo AND CAST(IDENTIFIER(:c2) AS DOUBLE) < :f2hi)' +
        ' AND (CAST(unix_date(CAST(IDENTIFIER(:c3) AS DATE)) AS DOUBLE) >= :f3lo AND CAST(unix_date(CAST(IDENTIFIER(:c3) AS DATE)) AS DOUBLE) <= :f3hi)',
    ].join('\n')
  );
  const param = (name: string) => statement.params.find((p) => p.name === name);
  assert.deepEqual(param('f0'), { name: 'f0', value: "EMEA' OR '1'='1", type: 'STRING' });
  assert.deepEqual(param('f2lo'), { name: 'f2lo', value: '10', type: 'DOUBLE' });
  assert.ok(!statement.sql.includes("OR '1'='1"), 'the value of a chip is not in the SQL text');
  // The column of the chip and the column of the request are the same: one parameter.
  assert.equal(statement.params.filter((p) => p.value === '`region`').length, 1);
});

test('demo profiler: chips select the same rows as a direct count', async () => {
  const regions = values('region');
  const amounts = values('amount') as number[];
  const discounts = values('discount_pct');
  const dates = values('order_date') as number[];
  assert.equal(await rowCount([{ op: 'eq', column: region, value: 'EMEA' }]), regions.filter((v) => v === 'EMEA').length);
  assert.equal(await rowCount([{ op: 'null', column: discount }]), discounts.filter((v) => v === null).length);
  // A decimal is stored as cents. 10 to 20 means 10.00 to 19.99.
  assert.equal(await rowCount([{ op: 'range', column: amount, lo: 10, hi: 20 }]), amounts.filter((v) => v >= 1000 && v < 2000).length);
  assert.equal(await rowCount([{ op: 'range', column: amount, lo: 10, hi: 20, includeHi: true }]), amounts.filter((v) => v >= 1000 && v <= 2000).length);
  const january = chipForPeriods(orderDate, '2026-01-01', '2026-01-01', 'month');
  assert.equal(await rowCount([january]), dates.filter((d) => d < Date.parse('2026-02-01') / 86_400_000).length);
  // Chips combine with AND.
  const both = regions.filter((v, i) => v === 'EMEA' && discounts[i] === null).length;
  assert.equal(await rowCount([{ op: 'eq', column: region, value: 'EMEA' }, { op: 'null', column: discount }]), both);
  // A value as text: the chip of a number column compares the text that the chart showed.
  const quantity = { name: 'quantity', typeText: 'int' };
  assert.equal(await rowCount([{ op: 'eq', column: quantity, value: '2' }]), values('quantity').filter((v) => v === 2).length);
  assert.equal(await rowCount([{ op: 'eq', column: amount, value: formatDemoValue(table.columns[4] as DemoTable['columns'][number], 2316) }]), amounts.filter((v) => v === 2316).length);
  // A chip that no row meets gives an empty dataset, not an error.
  assert.equal(await rowCount([{ op: 'eq', column: region, value: 'MARS' }]), 0);
});

test('demo profiler: chips work with a sample and in each request type', async () => {
  const chips: Chip[] = [{ op: 'eq', column: region, value: 'EMEA' }];
  const filteredDataset = { ...dataset, chips };
  const frequency = (await demo.profile({ type: 'frequency', dataset: filteredDataset, columns: [region], top: 10 })) as ResultOf<'frequency'>;
  assert.deepEqual(frequency.values.map((v) => v.value), ['EMEA']);
  const stats = (await demo.profile({ type: 'numericStats', dataset: filteredDataset, columns: [amount] })) as ResultOf<'numericStats'>;
  assert.equal(stats.rowCount, frequency.rowCount);
  const sampled = (await demo.profile({ type: 'overview', dataset: { ...filteredDataset, sample: { percent: 10 } }, columns: [region] })) as ResultOf<'overview'>;
  assert.ok(sampled.rowCount > 0 && sampled.rowCount < frequency.rowCount / 5);
  // The details of the table do not depend on the chips.
  const details = (await demo.profile({ type: 'tableDetails', dataset: filteredDataset })) as ResultOf<'tableDetails'>;
  assert.equal(details.columns.length, 18);
  // A filter that the user typed is SQL. The Demo profile cannot run it.
  await assert.rejects(demo.profile({ type: 'validateFilter', dataset: { ...dataset, filter: "region = 'EMEA'" } }), /cannot use a filter that you type/);
});

test('toCsv writes cells that a spreadsheet program reads correctly', async () => {
  const { toCsv, fileName } = await import('../../../src/tableViz/core/derive.ts');
  assert.equal(toCsv([['Value', 'Rows'], ['web, mobile', '60352'], ['say "hi"', '1']]), 'Value,Rows\r\n"web, mobile",60352\r\n"say ""hi""",1\r\n');
  assert.equal(toCsv([['line\nbreak', '']]), '"line\nbreak",\r\n');
  // A cell that starts with =, + or @ is text, not a formula. A negative number stays a number.
  assert.equal(toCsv([['=1+1', '+SUM(A1)', '@x', '-cmd', '-4.8', '-12,5%']]), "'=1+1,'+SUM(A1),'@x,'-cmd,-4.8,\"-12,5%\"\r\n");
  assert.equal(toCsv([]), '');
  assert.equal(fileName(['orders 2026', 'unit/price'], 'csv'), 'orders_2026_unit_price.csv');
  assert.equal(fileName(['zamówienie 2026'], 'png'), 'zamówienie_2026.png');
  assert.ok(!fileName(['a/b\\c:d'], 'svg').match(/[\\/:]/), 'a file name has no folder');
  assert.equal(fileName([], 'csv'), 'table.csv');
});

test('inlineRendered writes a statement that a person can run', async () => {
  const { inlineRendered, renderStatement, buildStatements: build } = await import('../../../src/tableViz/core/sql.ts');
  assert.equal(
    inlineRendered("-- :tbl = '`main`.`sales`.`orders`'\n-- :limit = 21\nSELECT 1 FROM IDENTIFIER(:tbl) LIMIT :limit"),
    "SELECT 1 FROM IDENTIFIER('`main`.`sales`.`orders`') LIMIT 21"
  );
  const chips: Chip[] = [{ op: 'eq', column: region, value: "it's a \\ test" }, { op: 'range', column: amount, lo: 10, hi: 20 }];
  const [statement] = build({ type: 'frequency', dataset: { ...dataset, chips }, columns: [region], top: 5 });
  assert.ok(statement);
  const text = inlineRendered(renderStatement(statement));
  assert.ok(!/(?<![:\w]):[a-z]\w*/.test(text), `no parameter marker is left: ${text}`);
  assert.ok(text.startsWith('SELECT `value`'), 'the comment lines of the parameters are gone');
  assert.ok(text.includes("= 'it''s a \\\\ test'"), text); // the quotation mark two times, the backslash two times
  assert.ok(text.includes('>= 10 AND') && text.includes('LIMIT 6'), text);
  // A statement without parameters does not change.
  assert.equal(inlineRendered('SELECT 1'), 'SELECT 1');
});

test('a saved view holds the datasets and the cards, and nothing more', async () => {
  const { savedViewSchema } = await import('../../../src/tableViz/core/schema.ts');
  const view = {
    tableViz: 1,
    datasets: { a: { ...dataset, filter: "region = 'EMEA'", chips: [{ op: 'null', column: discount }] }, b: dataset },
    ui: { search: '', sort: 'drift' },
    cards: [{ column: 'amount', pinned: true, bins: 40 }],
    asText: ['store_id'],
  };
  assert.ok(savedViewSchema.safeParse(view).success);
  assert.ok(savedViewSchema.safeParse({ tableViz: 1, datasets: { a: dataset } }).success);
  for (const bad of [
    { ...view, tableViz: 2 },
    { ...view, token: 'dapi123' },
    { ...view, results: [{ rowCount: 1 }] },
    { ...view, datasets: { a: { ...dataset, token: 'dapi123' } } },
    { ...view, datasets: { a: { ...dataset, chips: [{ op: 'eq', column: region, value: 'x', sql: '1=1' }] } } },
    { datasets: view.datasets },
    [],
    'text',
  ]) {
    assert.equal(savedViewSchema.safeParse(bad).success, false, JSON.stringify(bad).slice(0, 80));
  }
});

test('the dispatcher runs no request while a saved view waits for permission', async () => {
  const { createDispatcher } = await import('../../../src/tableViz/core/profiler.ts');
  let approved = false;
  let ran = 0;
  const sent: { type: string; message?: string }[] = [];
  const other: string[] = [];
  const dispatcher = createDispatcher({
    profilerFor: () => ({ profile: (request) => (ran++, demo.profile(request)) }),
    post: (m) => sent.push(m),
    makeSignal: () => {
      const c = new AbortController();
      return { signal: c.signal, cancel: () => c.abort() };
    },
    onOther: (m) => void other.push(m.type),
    blocked: () => (approved ? undefined : 'This saved view waits for your permission.'),
  });
  const request = { type: 'request', id: '1', request: { type: 'tableDetails', dataset } };
  await dispatcher.handle(request);
  assert.equal(ran, 0);
  assert.deepEqual(sent, [{ type: 'error', id: '1', message: 'This saved view waits for your permission.', raw: 'This saved view waits for your permission.', sql: [] }]);
  await dispatcher.handle({ type: 'approve' });
  await dispatcher.handle({ type: 'saveView', state: { datasets: { a: dataset } } });
  await dispatcher.handle({ type: 'export', action: 'copy', name: 'x.csv', format: 'csv', text: 'a,b' });
  await dispatcher.handle({ type: 'openSql', sql: ['SELECT 1'] });
  await dispatcher.handle({ type: 'export', action: 'save', name: '', format: 'exe', text: 'x' }); // not a known shape: ignored
  assert.deepEqual(other, ['approve', 'saveView', 'export', 'openSql']);
  approved = true;
  await dispatcher.handle({ ...request, id: '2' });
  assert.equal(ran, 1);
  assert.equal(sent.at(-1)?.type, 'result');
});
