/**
 * Tests for the workspace client and the full SQL path through HTTP.
 *
 * The tests use the fake workspace (test/tableViz/fake/workspace.ts): an
 * HTTP server on this computer that answers as Databricks does.
 *
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { missesPartition } from '../../../src/tableViz/core/derive.ts';
import { Limiter } from '../../../src/tableViz/core/limiter.ts';
import { tableNameAt } from '../../../src/tableViz/core/names.ts';
import { CancelledError, ProfilerError } from '../../../src/tableViz/core/profiler.ts';
import type { Dataset, Request, ResultOf } from '../../../src/tableViz/core/schema.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';
import { createHttp, HttpError } from '../../../src/tableViz/host/http.ts';
import { SqlProfiler } from '../../../src/tableViz/host/sqlProfiler.ts';
import { StatementExecutionRunner } from '../../../src/tableViz/host/statementRunner.ts';
import { DemoWorkspaceClient, RestWorkspaceClient } from '../../../src/tableViz/host/workspace.ts';
import { comparable } from '../fake/warehouse.ts';
import { startFakeWorkspace, type FakeWorkspace } from '../fake/workspace.ts';

let fake: FakeWorkspace;
before(async () => {
  fake = await startFakeWorkspace();
});
after(() => fake.close());

const http = () => createHttp({ host: () => fake.url, token: async () => 'test-token' });
const dataset = (name = 'orders_2026'): Dataset => ({ profile: 'p', table: { catalog: 'demo', schema: 'shop', name } });

/** Make the SQL profiler as the extension makes it, for a warehouse of the fake workspace. */
function sqlProfiler(warehouseId = 'wh-run') {
  const client = http();
  const workspace = new RestWorkspaceClient(client);
  const fast = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / 100));
  const runner = new StatementExecutionRunner({ http: client, warehouseId, timeoutSeconds: () => 30, tags: { feature: 'table-viz' }, sleep: fast });
  return new SqlProfiler({
    runner,
    getTable: (table) => workspace.getTable(table),
    limiter: new Limiter(() => 4),
    describe: () => ({ timeoutSeconds: 30, compute: 'The warehouse "Fake"', host: fake.url }),
  });
}

test('workspace client: warehouses, catalogs, schemas and tables', async () => {
  const workspace = new RestWorkspaceClient(http());
  assert.deepEqual(await workspace.listWarehouses(), [
    { id: 'wh-run', name: 'Fake running', state: 'RUNNING', size: 'Small' },
    { id: 'wh-stop', name: 'Fake stopped', state: 'STOPPED', size: 'Medium' },
  ]);
  assert.equal((await workspace.getWarehouse('wh-stop')).state, 'STOPPED');
  await assert.rejects(workspace.getWarehouse('nope'), (e: unknown) => e instanceof HttpError && e.status === 404);
  assert.deepEqual(await workspace.listCatalogs(), ['demo']);
  assert.deepEqual(await workspace.listSchemas('demo'), ['shop']);

  // The fake workspace gives one table on each page. The client reads all pages.
  fake.requests.length = 0;
  assert.deepEqual(await workspace.listTables('demo', 'shop'), [
    { name: 'orders_2025', tableType: 'table' },
    { name: 'orders_2026', tableType: 'table' },
  ]);
  assert.equal(fake.requests.filter((r) => r === 'GET /api/2.1/unity-catalog/tables').length, 2);
  assert.deepEqual(await workspace.listTables('demo', 'nope'), []);
});

test('workspace client: clusters, and the ID of the workspace', async () => {
  let workspaceId: string | undefined;
  const client = createHttp({ host: () => fake.url, token: async () => 't', onWorkspaceId: (id) => (workspaceId = id) });
  const workspace = new RestWorkspaceClient(client);
  const clusters = await workspace.listClusters();
  // The cluster of a job is not in the list.
  assert.deepEqual(clusters.map((c) => c.id), ['cl-ok', 'cl-open', 'cl-old', 'cl-stop']);
  assert.deepEqual(clusters[0], { id: 'cl-ok', name: 'Fake dedicated', state: 'RUNNING', sparkVersion: '15.4.x-scala2.12', accessMode: 'SINGLE_USER' });
  assert.equal(workspaceId, '1234567890123456', 'each answer has the ID of the workspace');

  assert.equal((await workspace.getCluster('cl-stop')).state, 'TERMINATED');
  await workspace.startCluster('cl-stop');
  assert.equal((await workspace.getCluster('cl-stop')).state, 'PENDING');
  assert.equal((await workspace.getCluster('cl-stop')).state, 'RUNNING');
  (fake.clusters['cl-stop'] as { state: string }).state = 'TERMINATED';
  await assert.rejects(workspace.getCluster('nope'), (e: unknown) => e instanceof HttpError && e.status === 400);
  assert.deepEqual(await new DemoWorkspaceClient().listClusters(), []);
});

test('workspace client: the columns of a table', async () => {
  const workspace = new RestWorkspaceClient(http());
  const info = await workspace.getTable({ catalog: 'demo', schema: 'shop', name: 'orders_2026' });
  assert.equal(info.columns.length, 18);
  assert.deepEqual(info.columns[0], { name: 'order_id', typeText: 'bigint' });
  assert.deepEqual(info.columns[3], { name: 'order_date', typeText: 'date', partition: true });
  assert.deepEqual([info.tableType, info.format, info.updatedAt], ['table', 'delta', '2026-11-01T02:05:00.000Z']);
  await assert.rejects(workspace.getTable({ catalog: 'demo', schema: 'shop', name: 'nope' }), (e: unknown) => e instanceof HttpError && e.status === 404);
  // The Demo profile gives the same answer without a server.
  assert.deepEqual(await new DemoWorkspaceClient().getTable({ catalog: 'demo', schema: 'shop', name: 'orders_2026' }), info);
  assert.deepEqual(await new DemoWorkspaceClient().listTables('demo', 'shop'), await workspace.listTables('demo', 'shop'));
});

test('browsing the catalog sends no SQL statement', async () => {
  fake.requests.length = 0;
  const workspace = new RestWorkspaceClient(http());
  await workspace.listCatalogs();
  await workspace.listSchemas('demo');
  await workspace.listTables('demo', 'shop');
  await workspace.getTable({ catalog: 'demo', schema: 'shop', name: 'orders_2026' });
  assert.ok(fake.requests.length > 0);
  assert.ok(!fake.requests.some((r) => r.includes('/sql/statements')), 'no statement: a stopped warehouse stays stopped');
  assert.equal(fake.warehouses['wh-stop']?.state, 'STOPPED');
});

test('the full path through HTTP gives the same numbers as the demo profiler', async () => {
  const profiler = sqlProfiler();
  const demo = new DemoProfiler();
  const details = (await profiler.profile({ type: 'tableDetails', dataset: dataset() })) as ResultOf<'tableDetails'>;
  assert.deepEqual([details.columns.length, details.version, details.sizeBytes], [18, '42', 3_771_332]);

  const pinned: Dataset = { ...dataset(), version: { kind: 'version', n: details.version as string } };
  const requests: Request[] = [
    { type: 'overview', dataset: pinned, columns: details.columns.map((c) => ({ name: c.name, typeText: c.typeText })) },
    { type: 'numericStats', dataset: pinned, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }] },
    { type: 'histogram', dataset: pinned, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }], edges: { lo: 2.33, hi: 1202.88, bins: 30 } },
    { type: 'frequency', dataset: pinned, columns: [{ name: 'status', typeText: 'string' }], top: 20 },
    { type: 'dateCounts', dataset: pinned, columns: [{ name: 'order_ts', typeText: 'timestamp' }], grain: 'week' },
    { type: 'validateFilter', dataset: pinned },
  ];
  for (const request of requests) {
    const viaHttp = await profiler.profile(request);
    const expected = await demo.profile({ ...request, dataset: { ...request.dataset, profile: 'Demo' } } as Request);
    assert.deepEqual(comparable(viaHttp), comparable(expected), request.type);
  }
  // Each statement has the tag, named parameters and the version of the table.
  const last = fake.statements.at(-2) as { statement: string; query_tags: unknown; parameters: { name: string }[]; warehouse_id: string };
  assert.deepEqual(last.query_tags, [{ key: 'feature', value: 'table-viz' }]);
  assert.match(last.statement, /FROM IDENTIFIER\(:tbl\) VERSION AS OF 42/);
  assert.ok(last.parameters.some((p) => p.name === 'tbl'));
  assert.ok(fake.statements.every((s) => /^(SELECT|DESCRIBE)\b/.test(String(s.statement))), 'each statement reads data only');
});

test('errors from the workspace become plain messages', async () => {
  const profiler = sqlProfiler();
  await assert.rejects(profiler.profile({ type: 'tableDetails', dataset: dataset('orders_1999') }), /The table demo\.shop\.orders_1999 does not exist/);
  await assert.rejects(profiler.profile({ type: 'frequency', dataset: dataset(), columns: [{ name: 'nope', typeText: 'string' }], top: 5 }), (e: unknown) => {
    assert.ok(e instanceof ProfilerError);
    assert.match(e.message, /A column in the query does not exist/);
    return true;
  });
  await assert.rejects(sqlProfiler('wh-deleted').profile({ type: 'validateFilter', dataset: dataset() }), /The warehouse "Fake" does not exist now/);
});

test('a statement starts a stopped warehouse, and a cancel reaches the workspace', async () => {
  const stopped = sqlProfiler('wh-stop');
  await stopped.profile({ type: 'validateFilter', dataset: dataset() });
  assert.equal(fake.warehouses['wh-stop']?.state, 'RUNNING');
  (fake.warehouses['wh-stop'] as { state: string }).state = 'STOPPED';

  fake.hold = true;
  fake.requests.length = 0;
  try {
    const controller = new AbortController();
    const pending = sqlProfiler().profile({ type: 'validateFilter', dataset: dataset() }, { signal: controller.signal });
    while (!fake.requests.some((r) => r.startsWith('GET /api/2.0/sql/statements/'))) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await assert.rejects(pending, CancelledError);
    assert.ok(fake.requests.some((r) => /^POST \/api\/2\.0\/sql\/statements\/st-\d+\/cancel$/.test(r)));
  } finally {
    fake.hold = false;
  }
});

test('tableNameAt finds the table name at the cursor', () => {
  const line = 'SELECT * FROM main.sales.orders o JOIN `my cat`.`s``x`.t2 ON 1 = 1';
  assert.deepEqual(tableNameAt(line, 14), { catalog: 'main', schema: 'sales', name: 'orders' });
  assert.deepEqual(tableNameAt(line, 31), { catalog: 'main', schema: 'sales', name: 'orders' });
  assert.deepEqual(tableNameAt(line, 45), { catalog: 'my cat', schema: 's`x', name: 't2' });
  assert.equal(tableNameAt(line, 3), undefined);
  assert.equal(tableNameAt(line, 33), undefined);
  assert.deepEqual(tableNameAt('df = spark.table("główny.zamówienia.t_2026")', 25), { catalog: 'główny', schema: 'zamówienia', name: 't_2026' });
  assert.equal(tableNameAt('x = a.b', 5), undefined, 'two parts are not a table name');
});

test('missesPartition tells if a filter reads all partitions', () => {
  assert.equal(missesPartition("region = 'EMEA'", ['order_date']), true);
  assert.equal(missesPartition("order_date >= '2026-01-01'", ['order_date']), false);
  assert.equal(missesPartition("ORDER_DATE >= '2026-01-01'", ['order_date']), false);
  assert.equal(missesPartition("update_order_date_x = 1", ['order_date']), true, 'the name must be a full word');
  assert.equal(missesPartition("region = 'EMEA'", ['order_date', 'region']), false);
  assert.equal(missesPartition("region = 'EMEA'", []), false);
  assert.equal(missesPartition('', ['order_date']), false);
  assert.equal(missesPartition(undefined, ['order_date']), false);
});

test('demo profiler: a sample has about the requested part of the rows, and the same rows on each run', async () => {
  const demo = new DemoProfiler();
  const column = [{ name: 'region', typeText: 'string' }];
  const count = async (percent?: number) =>
    ((await demo.profile({ type: 'overview', dataset: { ...dataset(), profile: 'Demo', ...(percent ? { sample: { percent } } : {}) }, columns: column })) as ResultOf<'overview'>).rowCount;
  assert.equal(await count(), 110_000);
  for (const percent of [1, 10, 50]) {
    const rows = await count(percent);
    assert.ok(Math.abs(rows / 110_000 - percent / 100) < 0.01, `${percent}% gave ${rows} rows`);
    assert.equal(await count(percent), rows);
  }
  assert.equal(await count(100), 110_000);
  // The facts of the table do not depend on the sample.
  const details = (await demo.profile({ type: 'tableDetails', dataset: { ...dataset(), profile: 'Demo', sample: { percent: 1 } } })) as ResultOf<'tableDetails'>;
  assert.equal(details.columns.length, 18);
});
