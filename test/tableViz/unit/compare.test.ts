/**
 * Tests for compare mode: column matching, the drift maths, and the compare logic on the demo tables.
 *
 * In compare mode, a board shows dataset A and dataset B. The drift score of
 * a column tells how different its values are in A and in B: 0 is no
 * difference, 1 is the largest difference.
 *
 * Source files that the tests cover:
 *
 * - src/tableViz/core/match.ts: `matchColumns`
 * - src/tableViz/core/drift.ts: `jsDistance`, `psi`, `uniqueCuts`
 * - src/tableViz/core/compare.ts: `compareKind`, `columnDrift`, `comparedValues`, `comparedFrequency`
 * - src/tableViz/core/cache.ts: a change of B runs no query for A
 * - src/tableViz/core/sql.ts and parse.ts: the requests `quantiles`, `driftBins` and `valueCounts`
 *
 * The two demo tables have six known differences (see src/tableViz/demo/data.ts).
 * A is `demo.shop.orders_2025`, B is `demo.shop.orders_2026`.
 *
 * Run all unit tests: npm run test:unit
 * Run this file only: node --test test/tableViz/unit/compare.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CachingProfiler } from '../../../src/tableViz/core/cache.ts';
import { columnDrift, compareKind, comparedFrequency, comparedValues, type Ask } from '../../../src/tableViz/core/compare.ts';
import { DECILES, jsDistance, psi, uniqueCuts, type Drift } from '../../../src/tableViz/core/drift.ts';
import { Limiter } from '../../../src/tableViz/core/limiter.ts';
import { matchColumns } from '../../../src/tableViz/core/match.ts';
import type { Profiler } from '../../../src/tableViz/core/profiler.ts';
import type { ColumnInfo, Dataset, OverviewColumn, Request, ResultOf } from '../../../src/tableViz/core/schema.ts';
import { resultSchema } from '../../../src/tableViz/core/schema.ts';
import { demoTable, type DemoTable } from '../../../src/tableViz/demo/data.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';
import { SqlProfiler } from '../../../src/tableViz/host/sqlProfiler.ts';
import { DemoWorkspaceClient } from '../../../src/tableViz/host/workspace.ts';
import { answerStatement } from '../fake/warehouse.ts';

/**
 * Fail if two numbers differ by more than `tolerance`.
 *
 * @example
 * near(0.72870, 0.7287, 1e-5)   // passes
 * near(0.73, 0.7287, 1e-5)      // fails: "0.73 is not near 0.7287"
 */
const near = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not near ${expected}`);
/**
 * Make the dataset of a demo table.
 *
 * @example
 * dataset('orders_2026', { sample: { percent: 10 } })
 * // { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' }, sample: { percent: 10 } }
 *
 * @param extra  A filter, a version or a sample to add to the dataset.
 */
const dataset = (name: string, extra: Partial<Dataset> = {}): Dataset => ({ profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name }, ...extra });
/**
 * Get the names and the types of the columns of a demo table.
 *
 * @example
 * columnsOf('orders_2026')[0]   // { name: 'order_id', typeText: 'bigint' }
 */
const columnsOf = (name: string): ColumnInfo[] => (demoTable(dataset(name).table) as DemoTable).columns.map((c) => ({ name: c.name, typeText: c.typeText }));

test('matchColumns: matched pairs, columns in one dataset only, and types that differ', () => {
  const a: ColumnInfo[] = [
    { name: 'id', typeText: 'int' },
    { name: 'Region', typeText: 'string' },
    { name: 'store', typeText: 'int' },
    { name: 'old', typeText: 'int' },
    { name: 'amount', typeText: 'DECIMAL(10,2)' },
  ];
  const b: ColumnInfo[] = [
    { name: 'region', typeText: 'string' },
    { name: 'ID', typeText: 'bigint' },
    { name: 'store', typeText: 'string' },
    { name: 'new', typeText: 'int' },
    { name: 'amount', typeText: 'decimal(10,2)' },
  ];
  const result = matchColumns(a, b);
  assert.deepEqual(result.pairs.map((p) => [p.a.name, p.b.name, p.typesDiffer, p.compareAs]), [
    ['id', 'ID', true, 'number'], // int and bigint: compare as numbers
    ['Region', 'region', false, 'same'],
    ['store', 'store', true, 'text'], // int and string: only if the user asks
    ['amount', 'amount', false, 'same'], // upper and lower case are the same type
  ]);
  assert.deepEqual(result.onlyA.map((c) => c.name), ['old']);
  assert.deepEqual(result.onlyB.map((c) => c.name), ['new']);

  const exact = matchColumns(a, b, { caseSensitive: true });
  assert.deepEqual(exact.pairs.map((p) => p.a.name), ['store', 'amount']);
  assert.deepEqual(exact.onlyA.map((c) => c.name), ['id', 'Region', 'old']);
  assert.deepEqual(exact.onlyB.map((c) => c.name), ['region', 'ID', 'new']);

  // B has "Name" and "name". The column "name" of A matches the one with exactly the same name.
  const twice = matchColumns([{ name: 'name', typeText: 'string' }], [{ name: 'Name', typeText: 'string' }, { name: 'name', typeText: 'string' }]);
  assert.equal(twice.pairs[0]?.b.name, 'name');
  assert.deepEqual(twice.onlyB.map((c) => c.name), ['Name']);
});

test('the demo tables: one column dropped, one added, one with a different type', () => {
  const schema = matchColumns(columnsOf('orders_2025'), columnsOf('orders_2026'));
  assert.equal(schema.pairs.length, 17);
  assert.deepEqual(schema.onlyA.map((c) => c.name), ['coupon_code']);
  assert.deepEqual(schema.onlyB.map((c) => c.name), ['loyalty_tier']);
  assert.deepEqual(schema.pairs.filter((p) => p.typesDiffer).map((p) => [p.a.name, p.a.typeText, p.b.typeText, p.compareAs]), [['store_id', 'int', 'string', 'text']]);
});

test('Jensen-Shannon distance: values that are computed by hand', () => {
  assert.equal(jsDistance([50, 50], [50, 50]), 0);
  assert.equal(jsDistance([1, 2, 3], [10, 20, 30]), 0, 'only the shares count');
  assert.equal(jsDistance([100, 0], [0, 100]), 1);
  assert.equal(jsDistance([5, 5, 0, 0], [0, 0, 7, 3]), 1, 'no bin has rows in the two datasets');
  // P = (0.9, 0.1), Q = (0.1, 0.9), M = (0.5, 0.5).
  // Divergence = 0.9 * log2(0.9 / 0.5) + 0.1 * log2(0.1 / 0.5) = 0.763197 - 0.232193 = 0.531004. Distance = sqrt = 0.728700.
  near(jsDistance([90, 10], [10, 90]), 0.7287, 1e-5);
  // P = (0.5, 0.5), Q = (0.75, 0.25), M = (0.625, 0.375).
  // KL(P||M) = 0.5*log2(0.8) + 0.5*log2(4/3) = 0.046555. KL(Q||M) = 0.75*log2(1.2) + 0.25*log2(2/3) = 0.051035.
  // Divergence = (0.046555 + 0.051035) / 2 = 0.048795. Distance = 0.220895.
  near(jsDistance([50, 50], [75, 25]), 0.220895, 1e-5);
  near(jsDistance([75, 25], [50, 50]), jsDistance([50, 50], [75, 25]), 1e-12); // the same if you swap A and B
  assert.equal(jsDistance([0, 0], [5, 5]), 0, 'a dataset with no rows gives 0');
  assert.throws(() => jsDistance([1], [1, 2]));
  // Each result is from 0 to 1.
  for (const [p, q] of [[[1, 0, 0], [0, 0, 1]], [[3, 1, 4], [1, 5, 9]], [[1e9, 1], [1, 1e9]]] as const) {
    const d = jsDistance([...p], [...q]);
    assert.ok(d >= 0 && d <= 1, String(d));
  }
});

test('Population Stability Index: values that are computed by hand', () => {
  assert.equal(psi([50, 50], [50, 50]), 0);
  // (0.8 - 0.9) * ln(0.8 / 0.9) + (0.2 - 0.1) * ln(0.2 / 0.1) = 0.011778 + 0.069315 = 0.081093
  near(psi([90, 10], [80, 20]), 0.081093, 1e-6);
  // An empty bin gets the share 0.0001: (0.0001 - 0.5) * ln(0.0001 / 0.5) + (1 - 0.5) * ln(1 / 0.5) = 4.257743 + 0.346574
  near(psi([50, 50], [0, 100]), 4.604317, 1e-5);
  assert.ok(Number.isFinite(psi([100, 0], [0, 100])));
  assert.equal(psi([0, 0], [1, 1]), 0);
});

test('uniqueCuts keeps each decile one time', () => {
  assert.deepEqual(uniqueCuts([1, 1, 2, 2, 2, 5, 7, 7, 9]), [1, 2, 5, 7, 9]);
  assert.deepEqual(uniqueCuts([3, 3, 3]), [3]);
  assert.deepEqual(uniqueCuts([]), []);
  assert.equal(DECILES.length, 9);
});

test('comparedValues: the union of the values, ranked by the larger share', () => {
  const base = { type: 'frequency' as const, sql: [], approximate: false, asOf: '' };
  const a = { ...base, rowCount: 100, nulls: 0, values: [{ value: 'web', count: 60 }, { value: 'store', count: 40 }] };
  const b = { ...base, rowCount: 200, nulls: 10, values: [{ value: 'web', count: 90 }, { value: 'store', count: 76 }, { value: 'marketplace', count: 24 }] };
  assert.deepEqual(comparedValues(a, b), [
    { label: 'web', role: 'value', countA: 60, countB: 90, shareA: 0.6, shareB: 0.45 },
    { label: 'store', role: 'value', countA: 40, countB: 76, shareA: 0.4, shareB: 0.38 },
    { label: 'marketplace', role: 'value', countA: 0, countB: 24, shareA: 0, shareB: 0.12, onlyIn: 'b' },
    { label: '(null)', role: 'null', countA: 0, countB: 10, shareA: 0, shareB: 0.05 },
  ]);
  // With a limit, the other values go into "Other", and each dataset still adds up to all its rows.
  const limited = comparedValues(a, b, 1);
  assert.deepEqual(limited.map((r) => [r.label, r.countA, r.countB]), [['web', 60, 90], ['Other', 40, 100], ['(null)', 0, 10]]);
  assert.equal(limited.reduce((sum, r) => sum + r.countA, 0), 100);
  assert.equal(limited.reduce((sum, r) => sum + r.countB, 0), 200);
});

/**
 * Get the columns and the overview numbers of the two demo tables.
 *
 * @param ask  Sends one request to a profiler. A test can give a function that counts the requests.
 * @returns `schema`: the matched pairs of columns. `oa` and `ob`: the overview results of A and B. `stats(o, name)`: the overview numbers of one column.
 */
async function overviews(ask: Ask, a: Dataset, b: Dataset) {
  const schema = matchColumns(columnsOf(a.table.name), columnsOf(b.table.name));
  const [oa, ob] = await Promise.all([
    ask({ type: 'overview', dataset: a, columns: columnsOf(a.table.name) }),
    ask({ type: 'overview', dataset: b, columns: columnsOf(b.table.name) }),
  ]);
  const stats = (o: ResultOf<'overview'>, name: string) => o.columns.find((c) => c.name === name) as OverviewColumn;
  return { schema, oa, ob, stats };
}

/**
 * Compute the drift of each matched pair of the two datasets, as the board does.
 *
 * @example
 * const drifts = await allDrifts(askDemo, dataset('orders_2025'), dataset('orders_2026'));
 * drifts.get('channel')?.score    // more than 0.2: B has the new value 'marketplace'
 * drifts.get('store_id')          // undefined: the types differ, so the board does not compare the column
 *
 * @param asText  The names of the columns that the user wants to compare as text, although their types differ.
 * @returns The drift of each pair, with the name of the column in A as the key. undefined for a pair that the board does not compare.
 */
async function allDrifts(ask: Ask, a: Dataset, b: Dataset, asText: string[] = []): Promise<Map<string, Drift | undefined>> {
  const { schema, oa, ob, stats } = await overviews(ask, a, b);
  const drifts = new Map<string, Drift | undefined>();
  for (const pair of schema.pairs) {
    const sa = stats(oa, pair.a.name);
    const sb = stats(ob, pair.b.name);
    const kind = compareKind(pair, sa, sb, asText.includes(pair.a.name));
    drifts.set(pair.a.name, await columnDrift(ask, a, b, pair, kind, oa.rowCount, sa, ob.rowCount, sb));
  }
  return drifts;
}

/** The demo profiler. It answers all requests of the tests below. */
const demo = new DemoProfiler();
/** Send one request to the demo profiler. The compare functions take a function of this shape. */
const askDemo: Ask = (request) => demo.profile(request) as never;

test('comparing the demo tables ranks the planted differences highest', async () => {
  const drifts = await allDrifts(askDemo, dataset('orders_2025'), dataset('orders_2026'));
  const ranked = [...drifts.entries()].filter(([, d]) => d).sort((x, y) => (y[1] as Drift).score - (x[1] as Drift).score);
  const score = (name: string) => (drifts.get(name) as Drift).score;

  // The two tables hold different years. That is a true difference, so the two date columns come first.
  // Their score is not 1: all dates of B are in the last bin of A, which has one tenth of the dates of A.
  assert.deepEqual(ranked.slice(0, 2).map(([name]) => name).sort(), ['order_date', 'order_ts']);
  near(score('order_date'), 0.87, 0.01);
  // After the dates come the three planted differences in the values.
  assert.deepEqual(ranked.slice(2, 5).map(([name]) => name).sort(), ['amount', 'channel', 'discount_pct']);
  assert.ok(score('discount_pct') > 0.25, `discount_pct ${score('discount_pct')}`);
  assert.ok(score('channel') > 0.2, `channel ${score('channel')}`);
  assert.ok(score('amount') > 0.1, `amount ${score('amount')}`);
  // All other columns have the same distribution in the two tables: their score is near 0.
  for (const [name, drift] of ranked.slice(5)) assert.ok((drift as Drift).score < 0.03, `${name} ${(drift as Drift).score}`);

  // The column whose type changed is not compared until the user asks for it.
  assert.equal(drifts.get('store_id'), undefined);
  const withText = await allDrifts(askDemo, dataset('orders_2025'), dataset('orders_2026'), ['store_id']);
  near((withText.get('store_id') as Drift).score, 1, 1e-9); // as text, "7" and "S007" are different values

  // The null rate is on its own line: it is often the real finding.
  const discount = drifts.get('discount_pct') as Drift;
  near(discount.nullRateA, 0.05, 0.01);
  near(discount.nullRateB, 0.35, 0.01);
  assert.equal(discount.method, 'deciles');
  assert.equal(discount.bins.length, 11, '10 bins and the null bin');
  assert.ok(discount.psi > 0.25, 'the PSI is above its "large change" limit');
  // The 10 bins of A have about one tenth of its values each.
  for (const bin of discount.bins.slice(0, 10)) near(bin.a / 95_000, 0.1, 0.02);
  assert.equal((drifts.get('channel') as Drift).method, 'values');
  assert.equal((drifts.get('order_id') as Drift).method, 'nulls');
  assert.equal((drifts.get('order_id') as Drift).score, 0);
});

test('a dataset compared with itself has no drift', async () => {
  const drifts = await allDrifts(askDemo, dataset('orders_2026'), dataset('orders_2026'));
  for (const [name, drift] of drifts) assert.equal(drift?.score, 0, name);
});

test('the top lists get exact counts for the values that one list lacks', async () => {
  const pair = matchColumns([{ name: 'postal_code', typeText: 'int' }], [{ name: 'postal_code', typeText: 'int' }]).pairs[0];
  assert.ok(pair);
  const asked: Request[] = [];
  const ask: Ask = (request) => (asked.push(request), demo.profile(request) as never);
  // postal_code has 900 values. With 5 values from each table, the two top lists can differ.
  const { a, b } = await comparedFrequency(ask, dataset('orders_2025'), dataset('orders_2026'), pair, 5);
  // Count the rows of one value in one table directly, with a `valueCounts` request.
  const direct = async (name: string, value: string) => (await demo.profile({ type: 'valueCounts', dataset: dataset(name), columns: [{ name: 'postal_code', typeText: 'int' }], values: [value] })) as ResultOf<'valueCounts'>;
  for (const value of new Set([...a.values, ...b.values].map((v) => v.value))) {
    assert.equal(a.values.find((v) => v.value === value)?.count ?? 0, (await direct('orders_2025', value)).values[0]?.count, `A ${value}`);
    assert.equal(b.values.find((v) => v.value === value)?.count ?? 0, (await direct('orders_2026', value)).values[0]?.count, `B ${value}`);
  }
  // A list that has all values of the column needs no second request.
  asked.length = 0;
  const channel = matchColumns([{ name: 'channel', typeText: 'string' }], [{ name: 'channel', typeText: 'string' }]).pairs[0];
  assert.ok(channel);
  await comparedFrequency(ask, dataset('orders_2025'), dataset('orders_2026'), channel, 50);
  assert.deepEqual(asked.map((r) => r.type), ['frequency', 'frequency']);
});

test('changing dataset B runs no query for dataset A', async () => {
  // Count the requests that reach the inner profiler, for each table.
  const ran: Request[] = [];
  const inner: Profiler = { profile: (request, options) => (ran.push(request), demo.profile(request, options)) };
  const cache = new CachingProfiler(inner, { hostOf: () => 'demo' });
  const ask: Ask = (request) => cache.profile(request) as never;
  const a = dataset('orders_2025');
  // The number of requests for A that reached the inner profiler. A request that the cache answers does not count.
  const forA = () => ran.filter((r) => r.dataset.table.name === 'orders_2025').length;

  await allDrifts(ask, a, dataset('orders_2026'));
  const afterFirst = forA();
  assert.ok(afterFirst > 10, 'the first comparison runs queries for A');

  // Three changes of B: a sample, a different table, and B = A at a different version.
  await allDrifts(ask, a, dataset('orders_2026', { sample: { percent: 10 } }));
  await allDrifts(ask, a, dataset('orders_2026', { version: { kind: 'version', n: '41' } }));
  assert.equal(forA(), afterFirst, 'a different B runs nothing for A');
  const bRuns = ran.filter((r) => r.dataset.table.name === 'orders_2026').length;
  assert.ok(bRuns > 20, 'each B ran its own queries');

  // The same comparison again runs nothing at all.
  const total = ran.length;
  await allDrifts(ask, a, dataset('orders_2026'));
  assert.equal(ran.length, total);
});

test('the new requests give the same numbers through SQL as the demo profiler', async () => {
  const workspace = new DemoWorkspaceClient();
  const sql = new SqlProfiler({
    runner: { run: (statement) => answerStatement(statement) },
    getTable: (table) => workspace.getTable(table),
    limiter: new Limiter(() => 4),
    describe: () => ({ timeoutSeconds: 300, compute: 'The warehouse "Test"', host: 'https://example' }),
  });
  const d = dataset('orders_2026');
  const requests: Request[] = [
    { type: 'quantiles', dataset: d, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }], probabilities: DECILES },
    { type: 'quantiles', dataset: d, columns: [{ name: 'order_ts', typeText: 'timestamp' }], probabilities: DECILES, measure: 'day' },
    { type: 'driftBins', dataset: d, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }], cuts: [10, 20, 50, 100] },
    { type: 'driftBins', dataset: d, columns: [{ name: 'discount_pct', typeText: 'double' }], cuts: [5, 25] },
    { type: 'driftBins', dataset: d, columns: [{ name: 'order_date', typeText: 'date' }], cuts: [20500, 20600], measure: 'day' },
    { type: 'valueCounts', dataset: d, columns: [{ name: 'channel', typeText: 'string' }], values: ['web', 'fax', 'marketplace'] },
    { type: 'valueCounts', dataset: d, columns: [{ name: 'quantity', typeText: 'int' }], values: ['1', '8', '99'] },
  ];
  for (const request of requests) {
    const viaSql = await sql.profile(request);
    const expected = await demo.profile(request);
    assert.ok(resultSchema.safeParse(viaSql).success, request.type);
    const strip = ({ sql: _sql, asOf: _asOf, approximate: _approximate, ...rest }: typeof viaSql) => rest;
    assert.deepEqual(strip(viaSql), strip(expected), request.type);
  }
  const bins = (await demo.profile(requests[3] as Request)) as ResultOf<'driftBins'>;
  assert.equal(bins.counts.reduce((x, y) => x + y, 0) + bins.nulls, 110_000);
  const counts = (await demo.profile(requests[5] as Request)) as ResultOf<'valueCounts'>;
  assert.deepEqual(counts.values.map((v) => [v.value, v.count > 0]), [['web', true], ['fax', false], ['marketplace', true]]);
});
