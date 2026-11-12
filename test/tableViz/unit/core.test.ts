/**
 * Tests for the pure code in src/tableViz/core: column kinds, names, bins and message checks.
 *
 * "Pure" means that the code needs no VS Code, no network and no Databricks.
 *
 * Source files that the tests cover:
 *
 * - src/tableViz/core/kinds.ts: `typeFamily`, `detectKind`
 * - src/tableViz/core/names.ts: `quoteIdentifier`, `quoteTableName`, `displayTableName`, `parseTableName`
 * - src/tableViz/core/bins.ts: `makeEdges`, `binIndex`, `binBounds`, `truncateDay`, `formatDay`, `chooseGrain`
 * - src/tableViz/core/schema.ts: `requestSchema`, `toHostSchema`, `toWebviewSchema`
 * - src/tableViz/core/derive.ts: `frequencyRows`, `histogramBars`, `fillPeriods`, `spanDays`, `kindsFor`, `openCard`
 *
 * Run all unit tests: npm run test:unit
 * Run this file only: node --test test/tableViz/unit/core.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { binBounds, binIndex, chooseGrain, formatDay, makeEdges, truncateDay } from '../../../src/tableViz/core/bins.ts';
import { detectKind, typeFamily } from '../../../src/tableViz/core/kinds.ts';
import { displayTableName, parseTableName, quoteIdentifier, quoteTableName } from '../../../src/tableViz/core/names.ts';
import { requestSchema, toHostSchema, toWebviewSchema } from '../../../src/tableViz/core/schema.ts';
import { makeRng } from '../../../src/tableViz/demo/random.ts';

test('typeFamily groups the Databricks types', () => {
  assert.equal(typeFamily('BIGINT'), 'integer');
  assert.equal(typeFamily('int'), 'integer');
  assert.equal(typeFamily('decimal(10,2)'), 'decimal');
  assert.equal(typeFamily('DOUBLE'), 'float');
  assert.equal(typeFamily('varchar(20)'), 'string');
  assert.equal(typeFamily('boolean'), 'boolean');
  assert.equal(typeFamily('date'), 'date');
  assert.equal(typeFamily('timestamp_ntz'), 'timestamp');
  for (const t of ['array<string>', 'map<string,int>', 'struct<a:int>', 'variant', 'binary', 'interval day', 'something_new']) {
    assert.equal(typeFamily(t), 'complex', t);
  }
});

test('detectKind follows the table in the brief', () => {
  assert.equal(detectKind('double', 5000, 100_000), 'continuous');
  assert.equal(detectKind('int', 51, 100_000), 'continuous');
  assert.equal(detectKind('int', 50, 100_000), 'discrete');
  assert.equal(detectKind('decimal(10,2)', 3, 100_000), 'continuous'); // discrete is for integer types only
  assert.equal(detectKind('string', 4, 100_000), 'category');
  assert.equal(detectKind('boolean', 2, 100_000), 'category');
  assert.equal(detectKind('string', 10_000, 100_000), 'category');
  assert.equal(detectKind('string', 10_001, 100_000), 'identifier');
  assert.equal(detectKind('string', 96, 100), 'identifier'); // nearly unique
  assert.equal(detectKind('string', 20, 20), 'category'); // too few rows to call it an identifier
  assert.equal(detectKind('bigint', 100_000, 100_000), 'identifier');
  assert.equal(detectKind('double', 100_000, 100_000), 'continuous'); // a measurement, not an ID
  assert.equal(detectKind('date', 365, 100_000), 'date');
  assert.equal(detectKind('timestamp', 99_000, 100_000), 'date');
  assert.equal(detectKind('array<string>', undefined, 100_000), 'complex');
  assert.equal(detectKind('int', undefined, 0), 'continuous'); // no distinct count: use the type
  assert.equal(detectKind('string', undefined, 0), 'category');
});

test('table names: quote, display and parse', () => {
  assert.equal(quoteIdentifier('my `odd` name'), '`my ``odd`` name`');
  const odd = { catalog: 'main', schema: 'sales data', name: 'tab`le.x' };
  assert.equal(quoteTableName(odd), '`main`.`sales data`.`tab``le.x`');
  assert.equal(displayTableName(odd), 'main.`sales data`.`tab``le.x`');
  assert.deepEqual(parseTableName(displayTableName(odd)), odd);
  assert.deepEqual(parseTableName(quoteTableName(odd)), odd);
  assert.deepEqual(parseTableName('  main.sales.orders '), { catalog: 'main', schema: 'sales', name: 'orders' });
  assert.deepEqual(parseTableName('główny.zamówienia.2026'), { catalog: 'główny', schema: 'zamówienia', name: '2026' });
  for (const bad of ['', 'orders', 'sales.orders', 'a.b.c.d', 'a..c', 'a.b.', '.b.c', 'a.b.`c', 'a.b c.d', 'a.b.c`d']) {
    assert.equal(parseTableName(bad), undefined, JSON.stringify(bad));
  }
});

test('makeEdges handles one value, a reversed range and bad input', () => {
  assert.deepEqual(makeEdges(0, 100, 4), { lo: 0, hi: 100, bins: 4 });
  assert.deepEqual(makeEdges(100, 0, 4), { lo: 0, hi: 100, bins: 4 });
  assert.deepEqual(makeEdges(7, 7, 30), { lo: 7, hi: 8, bins: 1 });
  const huge = makeEdges(1e20, 1e20, 30);
  assert.ok(huge.hi > huge.lo, 'the bin of a very large single value has a width');
  assert.equal(makeEdges(0, 1, 5000).bins, 200);
  assert.throws(() => makeEdges(NaN, 1, 10));
  assert.throws(() => makeEdges(0, Infinity, 10));
});

test('binIndex puts border values in the documented bins', () => {
  const edges = { lo: 0, hi: 100, bins: 4 };
  assert.equal(binIndex(0, edges), 0);
  assert.equal(binIndex(24.999, edges), 0);
  assert.equal(binIndex(25, edges), 1);
  assert.equal(binIndex(100, edges), 3);
  assert.equal(binIndex(-0.001, edges), -1);
  assert.equal(binIndex(100.001, edges), 4);
  assert.deepEqual(binBounds(edges, 1), [25, 50]);
  assert.deepEqual(binBounds(edges, 3), [75, 100]);
});

test('property: each value is in exactly one bin, and the counts add up', () => {
  // 300 rounds with random values and a random number of bins. The seed 7 does not change, so each run uses the same values.
  const rng = makeRng(7);
  for (let round = 0; round < 300; round++) {
    const n = 1 + Math.floor(rng() * 200);
    const scale = 10 ** Math.floor(rng() * 12 - 4);
    const offset = (rng() - 0.5) * scale * 10;
    // Some rounds have one value only, some have few different values.
    const pool = rng() < 0.1 ? 1 : rng() < 0.3 ? 3 : n;
    const base = Array.from({ length: pool }, () => offset + rng() * scale);
    const values = Array.from({ length: n }, () => base[Math.floor(rng() * pool)] as number);
    const edges = makeEdges(Math.min(...values), Math.max(...values), 1 + Math.floor(rng() * 200));

    const counts = new Array<number>(edges.bins).fill(0);
    for (const v of values) {
      const i = binIndex(v, edges);
      assert.ok(i >= 0 && i < edges.bins, `value ${v} is in the range of its own min and max`);
      const [start, end] = binBounds(edges, i);
      // Allow for the rounding of one floating-point step at a bin border.
      const slack = (edges.hi - edges.lo) * 1e-9;
      assert.ok(v >= start - slack && v <= end + slack, `value ${v} is in the bounds of bin ${i}`);
      counts[i] = (counts[i] as number) + 1;
    }
    assert.equal(counts.reduce((a, b) => a + b, 0), n);
  }
});

test('date periods', () => {
  const day = (iso: string) => Date.parse(iso) / 86_400_000;
  assert.equal(formatDay(truncateDay(day('2026-11-12'), 'day')), '2026-11-12'); // a Thursday
  assert.equal(formatDay(truncateDay(day('2026-11-12'), 'week')), '2026-11-09'); // the Monday before
  assert.equal(formatDay(truncateDay(day('2026-11-09'), 'week')), '2026-11-09');
  assert.equal(formatDay(truncateDay(day('2026-11-15'), 'week')), '2026-11-09'); // Sunday is the last day of the week
  assert.equal(formatDay(truncateDay(day('1969-12-31'), 'week')), '1969-12-29'); // before 1970
  assert.equal(formatDay(truncateDay(day('2026-11-12'), 'month')), '2026-11-01');
  assert.equal(formatDay(truncateDay(day('2026-11-12'), 'year')), '2026-01-01');
  assert.equal(chooseGrain('2026-01-01', '2026-03-01'), 'day');
  assert.equal(chooseGrain('2026-01-01', '2026-12-31'), 'week');
  assert.equal(chooseGrain('2020-01-01', '2026-12-31'), 'month');
  assert.equal(chooseGrain('1990-01-01', '2026-12-31'), 'year');
  assert.equal(chooseGrain('2026-01-01', '2026-01-01'), 'day');
});

test('message checks accept good messages and refuse bad ones', () => {
  const dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
  const column = { name: 'amount', typeText: 'decimal(10,2)' };
  assert.ok(requestSchema.safeParse({ type: 'histogram', dataset, columns: [column], edges: { lo: 0, hi: 1, bins: 30 } }).success);
  assert.ok(toHostSchema.safeParse({ type: 'request', id: '1', request: { type: 'tableDetails', dataset } }).success);
  assert.ok(toHostSchema.safeParse({ type: 'ready' }).success);
  assert.ok(toWebviewSchema.safeParse({ type: 'cancelled', id: '1' }).success);

  const bad: unknown[] = [
    { type: 'histogram', dataset, columns: [column], edges: { lo: 0, hi: 1, bins: 0 } }, // no bins
    { type: 'histogram', dataset, columns: [column, column], edges: { lo: 0, hi: 1, bins: 30 } }, // two columns
    { type: 'histogram', dataset, columns: [column], edges: { lo: 0, hi: 1, bins: 30 }, sql: 'DROP TABLE x' }, // unknown field
    { type: 'overview', dataset, columns: [] },
    { type: 'frequency', dataset: { ...dataset, sample: { percent: 0 } }, columns: [column], top: 20 },
    { type: 'frequency', dataset: { ...dataset, version: { kind: 'version', n: '1; DROP' } }, columns: [column], top: 20 },
    { type: 'runSql', dataset, sql: 'SELECT 1' },
  ];
  for (const request of bad) assert.equal(requestSchema.safeParse(request).success, false, JSON.stringify(request));
  assert.equal(toHostSchema.safeParse({ type: 'request', request: { type: 'tableDetails', dataset } }).success, false); // no id
});

test('frequencyRows: shares, cumulative shares, Other and null', async () => {
  const { frequencyRows } = await import('../../../src/tableViz/core/derive.ts');
  const result = {
    type: 'frequency' as const,
    sql: [],
    approximate: false,
    asOf: '',
    rowCount: 100,
    nulls: 5,
    values: [
      { value: 'web', count: 60 },
      { value: 'store', count: 30 },
      { value: 'phone', count: 4 },
      { value: 'fax', count: 1 },
    ],
  };
  assert.deepEqual(frequencyRows(result, { limit: 2 }), [
    { label: 'web', role: 'value', count: 60, share: 0.6, cumulative: 0.6 },
    { label: 'store', role: 'value', count: 30, share: 0.3, cumulative: 0.9 },
    { label: 'Other', role: 'other', count: 5, share: 0.05 },
    { label: '(null)', role: 'null', count: 5, share: 0.05 },
  ]);
  // All rows together are the full table.
  for (const limit of [1, 2, 3, 4, undefined]) {
    assert.equal(frequencyRows(result, { limit }).reduce((a, r) => a + r.count, 0), 100);
  }
  assert.deepEqual(frequencyRows(result, { sortBy: 'label' }).map((r) => r.label), ['fax', 'phone', 'store', 'web', '(null)']);
  assert.equal(result.values[0]?.value, 'web', 'the function does not change the result');
  const numbers = { ...result, nulls: 0, rowCount: 3, values: [{ value: '10', count: 1 }, { value: '9', count: 1 }, { value: '-2', count: 1 }] };
  assert.deepEqual(frequencyRows(numbers, { sortBy: 'label', numeric: true }).map((r) => r.label), ['-2', '9', '10']);
  assert.deepEqual(frequencyRows({ ...result, rowCount: 0, nulls: 0, values: [] }), []);
});

test('histogramBars: bins, below and above', async () => {
  const { histogramBars } = await import('../../../src/tableViz/core/derive.ts');
  const base = { type: 'histogram' as const, sql: [], approximate: false, asOf: '' };
  assert.deepEqual(histogramBars({ ...base, counts: [5, 9], below: 0, above: 2 }, { lo: 0, hi: 10, bins: 2 }), [
    { role: 'bin', from: 0, to: 5, count: 5 },
    { role: 'bin', from: 5, to: 10, count: 9 },
    { role: 'above', from: 10, count: 2 },
  ]);
  assert.equal(histogramBars({ ...base, counts: [1], below: 3, above: 0 }, { lo: 0, hi: 1, bins: 1 })[0]?.role, 'below');
});

test('fillPeriods: periods without rows, for each grain', async () => {
  const { fillPeriods, spanDays, MAX_PERIODS } = await import('../../../src/tableViz/core/derive.ts');
  assert.deepEqual(fillPeriods([{ start: '2026-01-01', count: 4 }, { start: '2026-03-01', count: 7 }], 'month'), {
    periods: [
      { start: '2026-01-01', count: 4 },
      { start: '2026-02-01', count: 0 },
      { start: '2026-03-01', count: 7 },
    ],
    empty: 1,
  });
  assert.equal(fillPeriods([{ start: '2026-02-27', count: 1 }, { start: '2026-03-02', count: 1 }], 'day').periods.length, 4);
  assert.equal(fillPeriods([{ start: '2025-12-29', count: 1 }, { start: '2026-01-19', count: 1 }], 'week').empty, 2);
  assert.equal(fillPeriods([{ start: '2020-01-01', count: 1 }, { start: '2026-01-01', count: 1 }], 'year').empty, 5);
  assert.deepEqual(fillPeriods([], 'day'), { periods: [], empty: 0 });
  // Too many periods: the function returns the buckets as they are.
  const far = [{ start: '1900-01-01', count: 1 }, { start: '2026-01-01', count: 1 }];
  assert.deepEqual(fillPeriods(far, 'day'), { periods: far, empty: undefined });
  assert.ok(fillPeriods(far, 'month').periods.length < MAX_PERIODS);
  assert.equal(spanDays('2026-01-01', '2026-12-31T23:59:59.000Z'), 364);
});

test('kindsFor and openCard', async () => {
  const { kindsFor, openCard } = await import('../../../src/tableViz/core/derive.ts');
  assert.deepEqual(kindsFor('int'), ['continuous', 'discrete', 'category', 'identifier']);
  assert.deepEqual(kindsFor('string'), ['category', 'identifier']);
  assert.deepEqual(kindsFor('timestamp'), ['date', 'category']);
  assert.deepEqual(kindsFor('array<string>'), ['complex']);
  // Each type permits the kind that detectKind() can select for it.
  for (const [type, distinct] of [['int', 5], ['int', 500], ['bigint', 1000], ['double', 500], ['string', 5], ['string', 99_999], ['boolean', 2], ['date', 30], ['map<string,int>', undefined]] as const) {
    assert.ok(kindsFor(type).includes(detectKind(type, distinct, 1000)), type);
  }

  const cards = [{ column: 'amount', pinned: false }, { column: 'region', pinned: true }];
  // A new card is the detailed view of the column. It replaces the cards that are not pinned.
  assert.deepEqual(openCard(cards, 'channel'), [{ column: 'channel', pinned: false, expanded: true }, { column: 'region', pinned: true }]);
  assert.deepEqual(openCard([], 'x'), [{ column: 'x', pinned: false, expanded: true }]);
  // A column that has a small card: the card becomes the detailed view, in its place.
  assert.deepEqual(openCard(cards, 'region'), [{ column: 'amount', pinned: false }, { column: 'region', pinned: true, expanded: true }]);
  const detailed = [{ column: 'amount', pinned: false, expanded: true }];
  assert.equal(openCard(detailed, 'amount'), detailed, 'a column that has a detailed view changes nothing');
});
