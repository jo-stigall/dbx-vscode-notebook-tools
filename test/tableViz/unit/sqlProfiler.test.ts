/**
 * Tests for the SQL path: parsers, error messages, cache, queue and the SQL profiler.
 *
 * The SQL profiler runs its statements on a fake warehouse
 * (test/tableViz/fake/warehouse.ts), which answers from the demo tables.
 * The main test sends each request through the real builders and parsers
 * and expects the same numbers as the demo profiler.
 *
 * Source files that the tests cover:
 *
 * - src/tableViz/core/parse.ts: the parsers of the rows that Databricks returns
 * - src/tableViz/core/errors.ts: `toProfilerError`
 * - src/tableViz/core/limiter.ts: `Limiter`, the queue of the statements
 * - src/tableViz/core/cache.ts: `CachingProfiler`
 * - src/tableViz/host/sqlProfiler.ts: `SqlProfiler`
 *
 * The fake warehouse does not run SQL. Thus these tests do not show that
 * Databricks accepts each statement. Only the tests in test/tableViz/live show that.
 *
 * Run all unit tests: npm run test:unit
 * Run this file only: node --test test/tableViz/unit/sqlProfiler.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEdges } from '../../../src/tableViz/core/bins.ts';
import { CachingProfiler } from '../../../src/tableViz/core/cache.ts';
import { toProfilerError } from '../../../src/tableViz/core/errors.ts';
import { Limiter } from '../../../src/tableViz/core/limiter.ts';
import { parseDescribeDetail, parseFrequency, parseHistogram, parseNumericStats, parseOverview, ParseError, toCount, toNumber } from '../../../src/tableViz/core/parse.ts';
import { CancelledError, ProfilerError, type Profiler } from '../../../src/tableViz/core/profiler.ts';
import { QueryError, type QueryResult, type QueryRunner } from '../../../src/tableViz/core/runner.ts';
import type { Dataset, Request, RequestOf, ResultOf } from '../../../src/tableViz/core/schema.ts';
import { resultSchema } from '../../../src/tableViz/core/schema.ts';
import type { Statement } from '../../../src/tableViz/core/sql.ts';
import { demoTable, type DemoTable } from '../../../src/tableViz/demo/data.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';
import { HttpError } from '../../../src/tableViz/host/http.ts';
import { SqlProfiler, type SqlProfilerDeps, type TableInfo } from '../../../src/tableViz/host/sqlProfiler.ts';
import { answerStatement, comparable, FakeSqlError } from '../fake/warehouse.ts';

/** Make the three-part name of a demo table. `table('orders_2026')` is the table `demo.shop.orders_2026`. */
const table = (name: string) => ({ catalog: 'demo', schema: 'shop', name });
/**
 * Make the dataset of a demo table.
 *
 * @param name  The name of the table. Default: 'orders_2026'.
 * @param profile  The name of the profile. Default: 'p', a profile that is not the Demo profile. The cache tests use different profiles.
 */
const dataset = (name = 'orders_2026', profile = 'p'): Dataset => ({ profile, table: table(name) });
/**
 * Make the rows of a statement in the form that a runner returns, for the parser tests.
 *
 * @example
 * result(['bucket', 'n'], [['1', '5'], ['3', '7']])
 * // { columns: [{ name: 'bucket', typeName: 'STRING' }, { name: 'n', typeName: 'STRING' }], rows: [['1', '5'], ['3', '7']] }
 */
const result = (names: string[], rows: (string | null)[][]): QueryResult => ({ columns: names.map((name) => ({ name, typeName: 'STRING' })), rows });
/** Wait until the next turn of the event loop, so that other statements can start. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Make a runner that answers from the fake warehouse and records what it ran.
 *
 * Each statement waits one turn of the event loop before it answers. Thus
 * statements can run at the same time, and the test of the queue can count them.
 *
 * @example
 * const { runner, ran, state } = fakeRunner();
 * await runner.run(statement);
 * ran.length    // 1
 * state.most    // 1: the largest number of statements that ran at the same time
 *
 * @returns `runner`; `ran`: the statements in the sequence of their start; `state.running`: how many statements run now; `state.most`: the largest value that `running` had.
 */
function fakeRunner() {
  const ran: Statement[] = [];
  const state = { running: 0, most: 0 };
  const runner: QueryRunner = {
    async run(statement, options) {
      ran.push(statement);
      state.most = Math.max(state.most, ++state.running);
      try {
        options?.onStarted?.('s-' + ran.length);
        await tick();
        return await answerStatement(statement);
      } catch (e) {
        if (e instanceof FakeSqlError) throw new QueryError(e.message, { kind: 'failed', code: e.code, sqlState: e.sqlState });
        throw e;
      } finally {
        state.running--;
      }
    },
  };
  return { runner, ran, state };
}

/**
 * Get what Unity Catalog tells about a demo table: the columns, the table type and the format.
 *
 * The real extension gets these facts from the REST API, not from a SQL statement.
 *
 * @example
 * tableInfo({ catalog: 'demo', schema: 'shop', name: 'orders_2026' }).columns[0]   // { name: 'order_id', typeText: 'bigint' }
 *
 * @throws {HttpError}  With HTTP 404 and the code 'TABLE_DOES_NOT_EXIST', if the table is not a demo table.
 */
function tableInfo(name: { catalog: string; schema: string; name: string }): TableInfo {
  const demo = demoTable(name);
  if (!demo) throw new HttpError(`Table '${name.name}' does not exist.`, 404, 'TABLE_DOES_NOT_EXIST');
  return {
    columns: demo.columns.map((c) => ({ name: c.name, typeText: c.typeText, ...(c.partition ? { partition: true } : {}) })),
    tableType: 'table',
    format: 'delta',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
}

/**
 * Make a SQL profiler that runs its statements on the fake warehouse.
 *
 * @example
 * const { profiler, ran, state } = makeProfiler({}, 2);
 * await profiler.profile({ type: 'frequency', dataset: dataset(), columns: [{ name: 'region', typeText: 'string' }], top: 5 });
 * ran.length   // 1: the profiler ran one statement
 *
 * @param overrides  Parts of the profiler to replace, for example `getTable` to make the table a view.
 * @param max  The largest number of statements that run at the same time. Default: 4.
 * @returns The profiler, and the three values of `fakeRunner()`.
 */
function makeProfiler(overrides: Partial<SqlProfilerDeps> = {}, max = 4) {
  const fake = fakeRunner();
  const profiler = new SqlProfiler({
    runner: fake.runner,
    getTable: async (name) => tableInfo(name),
    limiter: new Limiter(() => max),
    describe: () => ({ timeoutSeconds: 300, compute: 'The warehouse "Test"', host: 'https://example.cloud.databricks.com' }),
    ...overrides,
  });
  return { profiler, ...fake };
}

test('parsers: nulls, 64-bit integers, decimals and timestamps', () => {
  // A 64-bit integer and a decimal stay text. A null min or max is left out.
  const overview = parseOverview(
    { type: 'overview', dataset: dataset(), columns: [{ name: 'id', typeText: 'bigint' }, { name: 'price', typeText: 'decimal(38,10)' }, { name: 'ts', typeText: 'timestamp' }, { name: 'tags', typeText: 'array<string>' }, { name: 'empty', typeText: 'int' }] },
    result(
      ['n', 'c0_nn', 'c0_d', 'c0_min', 'c0_max', 'c0_avg', 'c1_nn', 'c1_d', 'c1_min', 'c1_max', 'c1_avg', 'c2_nn', 'c2_d', 'c2_min', 'c2_max', 'c3_nn', 'c4_nn', 'c4_d', 'c4_min', 'c4_max', 'c4_avg'],
      [['3000000000', '3000000000', '2999999999', '-9223372036854775808', '9223372036854775807', '1.5E18', '10', '9', '0.0000000001', '12345678901234567890.1234567890', '6.17E18', '10', '10', '2026-01-01 00:00:00', '2026-12-31 23:59:59.999', '7', '0', '0', null, null, null]]
    )
  );
  assert.equal(overview.rowCount, 3_000_000_000);
  assert.deepEqual(overview.columns, [
    { name: 'id', nonNull: 3_000_000_000, distinct: 2_999_999_999, min: '-9223372036854775808', max: '9223372036854775807', mean: 1.5e18 },
    { name: 'price', nonNull: 10, distinct: 9, min: '0.0000000001', max: '12345678901234567890.1234567890', mean: 6.17e18 },
    { name: 'ts', nonNull: 10, distinct: 10, min: '2026-01-01 00:00:00', max: '2026-12-31 23:59:59.999' },
    { name: 'tags', nonNull: 7 },
    { name: 'empty', nonNull: 0, distinct: 0 },
  ]);

  assert.equal(toCount('0'), 0);
  for (const bad of [null, '', '-1', '1.5', 'abc', '9007199254740993']) assert.throws(() => toCount(bad as string | null), ParseError, String(bad));
  assert.equal(toNumber('1.0E21'), 1e21);
  assert.equal(toNumber('NaN'), undefined);
  assert.equal(toNumber(null), undefined);

  // A table with no values: min, max, mean and the percentiles are null.
  const names = ['n', 'nn', 'zeros', 'negatives', 'min', 'max', 'mean', 'stddev', 'p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
  assert.deepEqual(parseNumericStats(result(names, [['5', '0', null, null, null, null, null, null, null, null, null, null, null, null, null]])), {
    type: 'numericStats',
    rowCount: 5,
    nonNull: 0,
    zeros: 0,
    negatives: 0,
    percentiles: [],
  });
  assert.throws(() => parseNumericStats(result(['n'], [['5']])), /no column "nn"/);
  assert.throws(() => parseNumericStats(result(names, [])), /no row 0/);
});

test('parsers: histogram buckets and frequency rows', () => {
  const histogram = parseHistogram(
    { type: 'histogram', dataset: dataset(), columns: [{ name: 'x', typeText: 'double' }], edges: { lo: 0, hi: 10, bins: 3 } },
    result(['bucket', 'n'], [['0', '2'], ['1', '5'], ['3', '7'], ['4', '1']])
  );
  assert.deepEqual(histogram, { type: 'histogram', counts: [5, 0, 7], below: 2, above: 1 });

  const request: RequestOf<'frequency'> = { type: 'frequency', dataset: dataset(), columns: [{ name: 'x', typeText: 'string' }], top: 2 };
  // With a null row, the statement returns top + 1 rows: the null row and `top` values.
  assert.deepEqual(parseFrequency(request, result(['value', 'n', 'total'], [[null, '5', '100'], ['a', '60', '100'], ['b', '30', '100']])), {
    type: 'frequency',
    rowCount: 100,
    nulls: 5,
    values: [{ value: 'a', count: 60 }, { value: 'b', count: 30 }],
  });
  // Without a null row, the statement returns top + 1 values. The parser drops the last one.
  assert.deepEqual(parseFrequency(request, result(['value', 'n', 'total'], [['a', '60', '100'], ['b', '30', '100'], ['c', '10', '100']])).values.length, 2);
  // A table with no rows.
  assert.deepEqual(parseFrequency(request, result(['value', 'n', 'total'], [])), { type: 'frequency', rowCount: 0, nulls: 0, values: [] });

  assert.deepEqual(parseDescribeDetail(result(['format', 'sizeInBytes', 'lastModified', 'partitionColumns'], [['delta', '3771332', '2026-11-01 02:05:00', '["order_date","region"]']])), {
    format: 'delta',
    sizeBytes: 3_771_332,
    // A time without a time zone is UTC, on each computer.
    lastModified: '2026-11-01T02:05:00.000Z',
    partitionColumns: ['order_date', 'region'],
  });
  // A time with a time zone keeps its meaning.
  for (const text of ['2026-11-01T02:05:00.000Z', '2026-11-01T04:05:00+02:00', '2026-10-31 21:05:00-05:00']) {
    assert.equal(parseDescribeDetail(result(['lastModified'], [[text]])).lastModified, '2026-11-01T02:05:00.000Z', text);
  }
  assert.equal(parseDescribeDetail(result(['lastModified'], [['not a time']])).lastModified, undefined);
  assert.deepEqual(parseDescribeDetail(result(['format'], [['parquet']])), { format: 'parquet', partitionColumns: [] });
});

test('SQL profiler: each request gives the same numbers as the demo profiler', async () => {
  const demo = new DemoProfiler();
  const { profiler } = makeProfiler();
  for (const name of ['orders_2025', 'orders_2026']) {
    const t = demoTable(table(name)) as DemoTable;
    const d = dataset(name);
    const refs = t.columns.map((c) => ({ name: c.name, typeText: c.typeText }));
    const requests: Request[] = [{ type: 'overview', dataset: d, columns: refs }];
    for (const c of t.columns) {
      const ref = { name: c.name, typeText: c.typeText };
      if (c.family !== 'complex') {
        requests.push({ type: 'frequency', dataset: d, columns: [ref], top: 20 }, { type: 'frequency', dataset: d, columns: [ref], top: 3 });
        requests.push({ type: 'numericStats', dataset: d, columns: [ref], measure: 'length' });
        requests.push({ type: 'histogram', dataset: d, columns: [ref], edges: makeEdges(1, 30, 10), measure: 'length' });
      }
      if (c.family === 'integer' || c.family === 'decimal' || c.family === 'float') {
        requests.push({ type: 'numericStats', dataset: d, columns: [ref] });
        requests.push({ type: 'histogram', dataset: d, columns: [ref], edges: makeEdges(5, 60, 12) });
      }
      if (c.family === 'date' || c.family === 'timestamp') {
        for (const grain of ['day', 'week', 'month', 'year'] as const) requests.push({ type: 'dateCounts', dataset: d, columns: [ref], grain });
      }
    }
    for (const request of requests) {
      const viaSql = await profiler.profile(request);
      const expected = await demo.profile({ ...request, dataset: { ...request.dataset, profile: 'Demo' } } as Request);
      assert.deepEqual(comparable(viaSql), comparable(expected), `${request.type} of ${name}.${'columns' in request ? request.columns[0]?.name : ''}`);
      assert.ok(resultSchema.safeParse(viaSql).success);
      assert.equal(viaSql.approximate, request.type === 'overview' || request.type === 'numericStats');
      assert.deepEqual(viaSql.sql, expected.sql.map((s) => s), 'the result has the SQL that ran');
    }
  }
});

test('SQL profiler: tableDetails reads the columns from Unity Catalog and the facts from DESCRIBE', async () => {
  const { profiler, ran } = makeProfiler();
  const details = (await profiler.profile({ type: 'tableDetails', dataset: dataset() })) as ResultOf<'tableDetails'>;
  assert.equal(details.columns.length, 18);
  assert.deepEqual([details.tableType, details.format, details.sizeBytes, details.version], ['table', 'delta', 3_771_332, '42']);
  assert.deepEqual(details.partitionColumns, ['order_date']);
  assert.equal(details.lastModified, '2026-11-01T02:05:00.000Z', 'the same time as in the demo table');
  assert.deepEqual(ran.map((s) => s.sql.split(' IDENTIFIER')[0]), ['DESCRIBE DETAIL', 'DESCRIBE HISTORY']);
  assert.equal(details.sql.length, 2);

  // An explicit version of the dataset wins over the newest version.
  const pinned = (await profiler.profile({ type: 'tableDetails', dataset: { ...dataset(), version: { kind: 'version', n: '7' } } })) as ResultOf<'tableDetails'>;
  assert.equal(pinned.version, '7');

  // A view has no DESCRIBE statements: reading it starts no warehouse.
  const view = makeProfiler({ getTable: async (name) => ({ ...tableInfo(name), tableType: 'view', format: undefined }) });
  const viewDetails = (await view.profiler.profile({ type: 'tableDetails', dataset: dataset() })) as ResultOf<'tableDetails'>;
  assert.equal(view.ran.length, 0);
  assert.deepEqual([viewDetails.tableType, viewDetails.version, viewDetails.sizeBytes, viewDetails.lastModified], ['view', undefined, undefined, '2026-10-01T00:00:00.000Z']);
  assert.deepEqual(viewDetails.partitionColumns, ['order_date'], 'the partition columns come from Unity Catalog');

  // If the DESCRIBE statements fail, the columns still arrive.
  const broken = makeProfiler({ runner: { run: async () => { throw new QueryError('no', { kind: 'failed' }); } } });
  const partial = (await broken.profiler.profile({ type: 'tableDetails', dataset: dataset() })) as ResultOf<'tableDetails'>;
  assert.deepEqual([partial.columns.length, partial.sizeBytes, partial.version, partial.sql.length], [18, undefined, undefined, 0]);
});

test('SQL profiler: errors become plain messages with the SQL', async () => {
  const { profiler } = makeProfiler();
  const missing = profiler.profile({ type: 'tableDetails', dataset: dataset('orders_1999') });
  await assert.rejects(missing, (e: unknown) => {
    assert.ok(e instanceof ProfilerError);
    assert.equal(e.message, 'The table demo.shop.orders_1999 does not exist, or you are not permitted to see it.');
    assert.match(e.nextStep ?? '', /Check the name/);
    return true;
  });
  const column = profiler.profile({ type: 'frequency', dataset: dataset(), columns: [{ name: 'nope', typeText: 'string' }], top: 5 });
  await assert.rejects(column, (e: unknown) => {
    assert.ok(e instanceof ProfilerError);
    assert.match(e.message, /A column in the query does not exist in demo\.shop\.orders_2026/);
    assert.match(e.raw, /UNRESOLVED_COLUMN/);
    assert.match(e.sql[0] ?? '', /^-- :c0 = '`nope`'/);
    return true;
  });
});

test('error messages for the common failures', () => {
  const context = { table: table('orders_2026'), sql: ['SELECT 1'], timeoutSeconds: 120, compute: 'The warehouse "Shared"', host: 'https://adb-1.azuredatabricks.net' };
  // Change an error of a runner into the error that the board shows, and return it as "message | next step".
  const message = (error: QueryError) => {
    const e = toProfilerError(error, context);
    assert.deepEqual(e.sql, ['SELECT 1']);
    assert.equal(e.raw, error.message);
    return `${e.message} | ${e.nextStep}`;
  };
  assert.match(message(new QueryError('x', { kind: 'timeout' })), /longer than 120 seconds.*\| Add a filter or use a sample/);
  assert.match(message(new QueryError('Invalid access token', { kind: 'http', status: 401 })), /login is not valid.*databricks auth login --host https:\/\/adb-1\.azuredatabricks\.net/);
  assert.match(message(new QueryError('[TABLE_OR_VIEW_NOT_FOUND] ...', { kind: 'failed', sqlState: '42P01' })), /does not exist, or you are not permitted/);
  assert.match(message(new QueryError('User does not have USE SCHEMA privilege on Schema main.sales', { kind: 'failed', code: 'INSUFFICIENT_PERMISSIONS' })), /USE SCHEMA privilege.*owner of the schema/);
  assert.match(message(new QueryError('User does not have USE CATALOG permission on Catalog main', { kind: 'failed' })), /USE CATALOG privilege.*owner of the catalog/);
  assert.match(message(new QueryError('[INSUFFICIENT_PERMISSIONS] User does not have SELECT on Table', { kind: 'failed', code: 'INSUFFICIENT_PERMISSIONS' })), /SELECT privilege on demo\.shop\.orders_2026/);
  assert.match(message(new QueryError('forbidden', { kind: 'http', status: 403 })), /SELECT privilege/);
  assert.match(message(new QueryError('[PARSE_SYNTAX_ERROR] Syntax error at or near', { kind: 'failed', sqlState: '42601' })), /could not read the SQL.*check the filter/);
  assert.match(message(new QueryError('Warehouse wh-9 does not exist', { kind: 'http', status: 404, code: 'RESOURCE_DOES_NOT_EXIST' })), /The warehouse "Shared" does not exist now.*Select Profile and Compute/);
  assert.match(message(new QueryError('The SQL warehouse is stopped', { kind: 'failed' })), /The warehouse "Shared" is stopped/);
  assert.match(message(new QueryError('Too many requests', { kind: 'http', status: 429 })), /too many requests.*Wait a minute/);
  assert.match(message(new QueryError('Something new', { kind: 'failed' })), /Databricks reported an error for this query\. \| Open "Details"/);
  // Other errors keep their text as the details.
  assert.equal(toProfilerError(new TypeError('boom'), context).raw, 'boom');
  const own = new ProfilerError('mine');
  assert.equal(toProfilerError(own, context), own);
});

test('queue: a limited number of statements run at the same time', async () => {
  const { profiler, state } = makeProfiler({}, 2);
  const t = demoTable(table('orders_2026')) as DemoTable;
  const progress: string[] = [];
  const requests = t.columns
    .filter((c) => c.family !== 'complex')
    .map((c) => profiler.profile({ type: 'frequency', dataset: dataset(), columns: [{ name: c.name, typeText: c.typeText }], top: 5 }, { onProgress: (s, id) => progress.push(id ? `${s}:${id}` : s) }));
  await Promise.all(requests);
  assert.equal(state.most, 2);
  assert.equal(progress.filter((p) => p === 'queued').length, requests.length - 2, 'all requests after the first two waited');
  assert.equal(progress.filter((p) => p === 'running').length, requests.length);
  assert.ok(progress.includes('running:s-1'), 'the progress has the statement ID');
});

test('queue: a request that is cancelled while it waits never runs', async () => {
  const limiter = new Limiter(() => 1);
  const order: string[] = [];
  let release = () => {};
  const first = limiter.run(() => new Promise<void>((resolve) => ((release = resolve), order.push('first'))));
  const controller = new AbortController();
  const second = limiter.run(async () => void order.push('second'), controller.signal);
  const third = limiter.run(async () => void order.push('third'));
  assert.equal(limiter.waiting, 2);
  controller.abort();
  await assert.rejects(second, CancelledError);
  assert.equal(limiter.waiting, 1);
  release();
  await Promise.all([first, third]);
  assert.deepEqual(order, ['first', 'third']);
  // A signal that fired before the call.
  await assert.rejects(limiter.run(async () => 1, controller.signal), CancelledError);
  // A task that fails frees its place.
  await assert.rejects(limiter.run(async () => { throw new Error('x'); }), /x/);
  assert.equal(await limiter.run(async () => 7), 7);
});

test('SQL profiler: cancel, and the check before a query', async () => {
  // A request that is cancelled while it waits in the queue runs no statement.
  const { profiler, ran } = makeProfiler({}, 1);
  const controller = new AbortController();
  const first = profiler.profile({ type: 'frequency', dataset: dataset(), columns: [{ name: 'region', typeText: 'string' }], top: 5 });
  const second = profiler.profile({ type: 'frequency', dataset: dataset(), columns: [{ name: 'channel', typeText: 'string' }], top: 5 }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(second, CancelledError);
  await first;
  assert.equal(ran.length, 1);

  // The check before a query can refuse: for example, the user did not permit the start of a stopped warehouse.
  let asked = 0;
  const guarded = makeProfiler({
    beforeQuery: async () => {
      asked++;
      throw new ProfilerError('The warehouse "Test" is stopped, and you did not permit the extension to start it.');
    },
  });
  await assert.rejects(guarded.profiler.profile({ type: 'overview', dataset: dataset(), columns: [{ name: 'region', typeText: 'string' }] }), /did not permit/);
  assert.equal(asked, 1);
  assert.equal(guarded.ran.length, 0);
});

test('cache: the same request runs one query; refresh runs it again', async () => {
  let calls = 0;
  const inner: Profiler = { profile: async (request) => (calls++, new DemoProfiler().profile({ ...request, dataset: { ...request.dataset, profile: 'Demo' } } as Request)) };
  const hosts: Record<string, string> = { a: 'https://one', b: 'https://one', c: 'https://two' };
  const cache = new CachingProfiler(inner, { hostOf: (profile) => hosts[profile] ?? '' });
  const request = (profile: string, top = 5): Request => ({ type: 'frequency', dataset: dataset('orders_2026', profile), columns: [{ name: 'region', typeText: 'string' }], top });

  const first = await cache.profile(request('a'));
  assert.equal(await cache.profile(request('a')), first);
  assert.equal(calls, 1);
  // A different parameter, filter, version or sample is a different key.
  await cache.profile(request('a', 6));
  await cache.profile({ ...request('a'), dataset: { ...dataset('orders_2026', 'a'), version: { kind: 'version', n: '41' } } } as Request);
  await cache.profile({ ...request('a'), dataset: { ...dataset('orders_2026', 'a'), sample: { percent: 10 } } } as Request);
  assert.equal(calls, 4);
  // Refresh runs the query again and replaces the stored result.
  const fresh = await cache.profile(request('a'), { refresh: true });
  assert.notEqual(fresh, first);
  assert.equal(await cache.profile(request('a')), fresh);
  assert.equal(calls, 5);
  assert.deepEqual([cache.hits, cache.misses], [2, 5]);

  // A failed request is not stored.
  let fail = true;
  const flaky = new CachingProfiler({ profile: async (r) => { if (fail) throw new ProfilerError('down'); return inner.profile(r); } }, { hostOf: () => 'h' });
  await assert.rejects(flaky.profile(request('a')), /down/);
  fail = false;
  await flaky.profile(request('a'));
});

test('cache: the key has the workspace URL, and old results leave when the cache is full', async () => {
  let calls = 0;
  const demo = new DemoProfiler();
  const inner: Profiler = { profile: async (request) => (calls++, demo.profile({ ...request, dataset: { ...request.dataset, profile: 'Demo' } } as Request)) };
  const request = (profile: string, column: string): Request => ({ type: 'frequency', dataset: dataset('orders_2026', profile), columns: [{ name: column, typeText: 'string' }], top: 5 });
  // Profiles 'a' and 'b' are the same workspace. Profile 'c' is a different workspace.
  const hosts: Record<string, string> = { a: 'https://one', b: 'https://one', c: 'https://two' };
  const big = new CachingProfiler(inner, { hostOf: (profile) => hosts[profile] ?? '' });
  await big.profile(request('a', 'region'));
  await big.profile(request('c', 'region'));
  assert.equal(calls, 2, 'a different workspace does not share results');

  // A cache with space for about two results.
  const one = JSON.stringify(await demo.profile({ ...request('a', 'region'), dataset: dataset('orders_2026', 'Demo') } as Request)).length;
  calls = 0;
  const small = new CachingProfiler(inner, { hostOf: () => 'h', maxSize: one * 2 + 900 });
  await small.profile(request('a', 'region'));
  await small.profile(request('a', 'channel'));
  await small.profile(request('a', 'region')); // region is now the most recently used
  await small.profile(request('a', 'status')); // the cache is full: channel leaves
  assert.equal(calls, 3);
  await small.profile(request('a', 'region'));
  assert.equal(calls, 3, 'region is still in the cache');
  await small.profile(request('a', 'channel'));
  assert.equal(calls, 4, 'channel was deleted, so it runs again');
  small.clear();
  await small.profile(request('a', 'region'));
  assert.equal(calls, 5);
});
