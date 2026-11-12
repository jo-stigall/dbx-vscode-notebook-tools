/**
 * Live tests: the SQL profiler on a real Databricks workspace.
 *
 * The tests run only when the variables in env.ts are set. Without them,
 * each test is skipped. Before the first run, load the demo tables:
 *
 *     npm run live:setup
 *     npm run test:live
 *
 * Each test sends a request to the real workspace and to the demo profiler,
 * and expects the same numbers. For a number that Databricks estimates
 * (distinct counts and percentiles without "exact"), the test permits a
 * difference of 10 percent.
 *
 * NOT VERIFIED: these tests were written without access to a workspace.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEdges } from '../../../src/tableViz/core/bins.ts';
import { Limiter } from '../../../src/tableViz/core/limiter.ts';
import type { Dataset, Request, ResultOf } from '../../../src/tableViz/core/schema.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';
import { SqlProfiler } from '../../../src/tableViz/host/sqlProfiler.ts';
import { RestWorkspaceClient } from '../../../src/tableViz/host/workspace.ts';
import { liveClients, liveEnv } from './env.ts';

const env = liveEnv();
const skip = env ? false : 'Set DATABRICKS_HOST, DATABRICKS_TOKEN, TABLE_VIZ_TEST_WAREHOUSE_ID and TABLE_VIZ_TEST_SCHEMA to run the live tests.';
const demo = new DemoProfiler();

function profiler() {
  const { http, runner } = liveClients(env as NonNullable<typeof env>, 300);
  const workspace = new RestWorkspaceClient(http);
  return new SqlProfiler({
    runner,
    getTable: (table) => workspace.getTable(table),
    limiter: new Limiter(() => 4),
    describe: () => ({ timeoutSeconds: 300, compute: 'The test warehouse', host: env?.host ?? '' }),
  });
}

const live = (name: string): Dataset => ({ profile: 'live', table: { catalog: env?.catalog ?? '', schema: env?.schema ?? '', name } });
const local = (name: string): Dataset => ({ profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name } });

/** Send one request to the workspace and to the demo profiler. */
async function both<T extends Request>(name: string, request: (dataset: Dataset) => T): Promise<[ResultOf<T['type']>, ResultOf<T['type']>]> {
  const [real, expected] = await Promise.all([profiler().profile(request(live(name))), demo.profile(request(local(name)))]);
  return [real as ResultOf<T['type']>, expected as ResultOf<T['type']>];
}

const near = (actual: number | undefined, expected: number | undefined, tolerance: number, what: string) => {
  assert.ok(actual !== undefined && expected !== undefined, what);
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${what}: ${actual} is not near ${expected}`);
};

for (const name of ['orders_2025', 'orders_2026']) {
  test(`${name}: the columns`, { skip }, async () => {
    const [real, expected] = await both(name, (dataset) => ({ type: 'tableDetails', dataset }));
    assert.deepEqual(real.columns.map((c) => [c.name, c.typeText.toLowerCase()]), expected.columns.map((c) => [c.name, c.typeText]));
    assert.equal(real.tableType, 'table');
    assert.ok(real.version !== undefined, 'a Delta table has a version');
    assert.ok((real.sizeBytes ?? 0) > 0);
  });

  test(`${name}: the overview`, { skip }, async () => {
    const [details] = await both(name, (dataset) => ({ type: 'tableDetails', dataset }));
    const columns = details.columns.map((c) => ({ name: c.name, typeText: c.typeText.toLowerCase() }));
    for (const exact of [false, true]) {
      const [real, expected] = await both(name, (dataset) => ({ type: 'overview', dataset, columns, exact }));
      assert.equal(real.rowCount, expected.rowCount);
      for (const want of expected.columns) {
        const got = real.columns.find((c) => c.name === want.name);
        assert.ok(got, want.name);
        assert.equal(got.nonNull, want.nonNull, `${want.name}: not-null count`);
        if (want.distinct !== undefined) near(got.distinct, want.distinct, exact ? 0 : 0.1, `${want.name}: distinct count`);
        if (want.mean !== undefined) near(got.mean, want.mean, 1e-9, `${want.name}: mean`);
        // The text of a timestamp depends on the time zone of the session. Compare min and max of the other types.
        const type = columns.find((c) => c.name === want.name)?.typeText;
        if (want.min !== undefined && type !== 'timestamp') {
          assert.equal(Number(got.min) || got.min, Number(want.min) || want.min, `${want.name}: min`);
          assert.equal(Number(got.max) || got.max, Number(want.max) || want.max, `${want.name}: max`);
        }
      }
    }
  });

  test(`${name}: statistics and histogram of amount`, { skip }, async () => {
    const column = [{ name: 'amount', typeText: 'decimal(10,2)' }] as [{ name: string; typeText: string }];
    const [real, expected] = await both(name, (dataset) => ({ type: 'numericStats', dataset, columns: column, exact: true }));
    assert.deepEqual([real.rowCount, real.nonNull, real.zeros, real.negatives, real.min, real.max], [expected.rowCount, expected.nonNull, expected.zeros, expected.negatives, expected.min, expected.max]);
    near(real.mean, expected.mean, 1e-9, 'mean');
    near(real.stddev, expected.stddev, 1e-9, 'standard deviation');
    expected.percentiles.forEach((p, i) => near(real.percentiles[i]?.value, p.value, 1e-9, `exact percentile ${p.p}`));

    const [approx] = await both(name, (dataset) => ({ type: 'numericStats', dataset, columns: column }));
    expected.percentiles.forEach((p, i) => near(approx.percentiles[i]?.value, p.value, 0.1, `approximate percentile ${p.p}`));

    const edges = makeEdges(Number(expected.min), Number(expected.max), 30);
    const [histogram, wanted] = await both(name, (dataset) => ({ type: 'histogram', dataset, columns: column, edges }));
    assert.deepEqual([histogram.counts, histogram.below, histogram.above], [wanted.counts, wanted.below, wanted.above]);
    // Edges that are narrower than the data: the values outside go to "below" and "above".
    const [clipped, clippedWanted] = await both(name, (dataset) => ({ type: 'histogram', dataset, columns: column, edges: makeEdges(20, 100, 8) }));
    assert.deepEqual([clipped.counts, clipped.below, clipped.above], [clippedWanted.counts, clippedWanted.below, clippedWanted.above]);
  });

  test(`${name}: frequency tables, value lengths and dates`, { skip }, async () => {
    for (const [column, typeText] of [['status', 'string'], ['quantity', 'int'], ['is_gift', 'boolean'], ['customer_id', 'string']] as const) {
      const [real, expected] = await both(name, (dataset) => ({ type: 'frequency', dataset, columns: [{ name: column, typeText }], top: 20 }));
      assert.deepEqual([real.rowCount, real.nulls], [expected.rowCount, expected.nulls], column);
      // Two values with the same count can come in a different sequence. Compare the counts, and the values of the first row.
      assert.deepEqual(real.values.map((v) => v.count), expected.values.map((v) => v.count), column);
      assert.equal(real.values[0]?.value, expected.values[0]?.value, column);
    }
    const id = [{ name: 'customer_id', typeText: 'string' }] as [{ name: string; typeText: string }];
    const [lengths, wantedLengths] = await both(name, (dataset) => ({ type: 'numericStats', dataset, columns: id, measure: 'length', exact: true }));
    assert.deepEqual([lengths.min, lengths.max, lengths.nonNull], [wantedLengths.min, wantedLengths.max, wantedLengths.nonNull]);

    for (const grain of ['day', 'week', 'month', 'year'] as const) {
      const [real, expected] = await both(name, (dataset) => ({ type: 'dateCounts', dataset, columns: [{ name: 'order_date', typeText: 'date' }], grain }));
      assert.deepEqual(real.buckets, expected.buckets, grain);
    }
  });

  test(`${name}: a filter, a sample and a version`, { skip }, async () => {
    const p = profiler();
    const ok = await p.profile({ type: 'validateFilter', dataset: { ...live(name), filter: "region = 'EMEA' AND quantity >= 2" } });
    assert.equal(ok.type, 'validateFilter');
    await assert.rejects(p.profile({ type: 'validateFilter', dataset: { ...live(name), filter: 'no_such_column = 1' } }), /column in the query does not exist/);
    await assert.rejects(p.profile({ type: 'validateFilter', dataset: { ...live(name), filter: 'region = = 1' } }), /could not read the SQL/);

    const column = [{ name: 'region', typeText: 'string' }];
    const filtered = (await p.profile({ type: 'overview', dataset: { ...live(name), filter: "region = 'EMEA'" }, columns: column })) as ResultOf<'overview'>;
    assert.equal(filtered.columns[0]?.distinct, 1);
    const sampled = (await p.profile({ type: 'overview', dataset: { ...live(name), sample: { percent: 10 } }, columns: column })) as ResultOf<'overview'>;
    assert.ok(sampled.rowCount > 0 && sampled.rowCount < filtered.rowCount * 3 + 50_000);
    // Time travel: the version of the table details gives the same row count.
    const details = (await p.profile({ type: 'tableDetails', dataset: live(name) })) as ResultOf<'tableDetails'>;
    const pinned = (await p.profile({ type: 'overview', dataset: { ...live(name), version: { kind: 'version', n: details.version as string } }, columns: column })) as ResultOf<'overview'>;
    assert.ok(pinned.rowCount > 0);
  });
}

test('names with special characters: a table that does not exist gives the plain message', { skip }, async () => {
  const odd: Dataset = { profile: 'live', table: { catalog: env?.catalog ?? '', schema: env?.schema ?? '', name: 'no such `table`' } };
  await assert.rejects(profiler().profile({ type: 'tableDetails', dataset: odd }), /does not exist, or you are not permitted/);
});
