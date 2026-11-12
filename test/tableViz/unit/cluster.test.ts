/**
 * Tests for the cluster rules and the cluster runner (src/tableViz/core/clusters.ts, host/clusterRunner.ts).
 *
 * The runner talks to a fake of the SQL driver (test/tableViz/fake/driver.ts),
 * which answers from the demo tables and can fail as a cluster fails.
 *
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessModeLabel, clusterHttpPath, clusterProblem, driverSupportsNode, parseRuntime, workspaceIdFromHost } from '../../../src/tableViz/core/clusters.ts';
import { Limiter } from '../../../src/tableViz/core/limiter.ts';
import { CancelledError } from '../../../src/tableViz/core/profiler.ts';
import { QueryError } from '../../../src/tableViz/core/runner.ts';
import type { Dataset, Request } from '../../../src/tableViz/core/schema.ts';
import { buildStatements, type Statement } from '../../../src/tableViz/core/sql.ts';
import { demoTable, type DemoTable } from '../../../src/tableViz/demo/data.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';
import { ClusterRunner, normalizeValue } from '../../../src/tableViz/host/clusterRunner.ts';
import { SqlProfiler } from '../../../src/tableViz/host/sqlProfiler.ts';
import { DemoWorkspaceClient } from '../../../src/tableViz/host/workspace.ts';
import { makeFakeDriver } from '../fake/driver.ts';
import { answerStatement, comparable } from '../fake/warehouse.ts';

const dataset: Dataset = { profile: 'p', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
const statementOf = (request: Request): Statement => buildStatements(request)[0] as Statement;
const frequency = statementOf({ type: 'frequency', dataset, columns: [{ name: 'status', typeText: 'string' }], top: 5 });

function makeRunner(options: { timeoutSeconds?: number; tokens?: string[] } = {}) {
  const fake = makeFakeDriver();
  const tokens = options.tokens ?? ['token-1', 'token-2'];
  const tokenCalls: boolean[] = [];
  let loads = 0;
  const runner = new ClusterRunner({
    loadDriver: () => (loads++, fake.module),
    host: () => 'https://adb-1234567890123456.7.azuredatabricks.net/',
    httpPath: () => 'sql/protocolv1/o/1234567890123456/0101-123456-abcdefgh',
    token: async (fresh) => (tokenCalls.push(fresh), (fresh ? tokens[1] : tokens[0]) ?? 'none'),
    timeoutSeconds: () => options.timeoutSeconds ?? 300,
    tags: { feature: 'table-viz' },
  });
  return { runner, fake, tokenCalls, loads: () => loads };
}

test('cluster rules: runtime, access mode and HTTP path', () => {
  assert.deepEqual(parseRuntime('15.4.x-scala2.12'), { major: 15, minor: 4 });
  assert.deepEqual(parseRuntime('13.3.x-photon-scala2.12'), { major: 13, minor: 3 });
  assert.equal(parseRuntime('custom:my-image'), undefined);
  assert.equal(parseRuntime(undefined), undefined);

  const cluster = (sparkVersion: string | undefined, accessMode: string | undefined) => ({ id: 'c', name: 'c', state: 'RUNNING', sparkVersion, accessMode });
  for (const mode of ['SINGLE_USER', 'USER_ISOLATION', 'DATA_SECURITY_MODE_DEDICATED', 'DATA_SECURITY_MODE_STANDARD', 'DATA_SECURITY_MODE_AUTO']) {
    assert.equal(clusterProblem(cluster('15.4.x-scala2.12', mode)), undefined, mode);
  }
  for (const mode of ['NONE', 'LEGACY_TABLE_ACL', 'LEGACY_PASSTHROUGH', 'LEGACY_SINGLE_USER', undefined]) {
    assert.match(clusterProblem(cluster('15.4.x-scala2.12', mode)) ?? '', /cannot read Unity Catalog/, String(mode));
  }
  assert.match(clusterProblem(cluster('15.4.x-scala2.12', 'NONE')) ?? '', /"no isolation shared"/);
  assert.match(clusterProblem(cluster('13.3.x-scala2.12', 'SINGLE_USER')) ?? '', /Databricks Runtime 13\.3\. The feature needs 14\.2 or later/);
  assert.match(clusterProblem(cluster('14.1.x-scala2.12', 'SINGLE_USER')) ?? '', /14\.1/);
  assert.equal(clusterProblem(cluster('14.2.x-scala2.12', 'SINGLE_USER')), undefined);
  assert.equal(clusterProblem(cluster('16.4.x-scala2.13', 'USER_ISOLATION')), undefined);
  assert.equal(clusterProblem(cluster('custom:image', 'SINGLE_USER')), undefined, 'an unknown runtime is permitted');
  assert.equal(accessModeLabel('USER_ISOLATION'), 'standard');
  assert.equal(accessModeLabel('LEGACY_TABLE_ACL'), 'legacy table acl');

  assert.equal(clusterHttpPath('1234567890123456', '0101-123456-abcdefgh'), 'sql/protocolv1/o/1234567890123456/0101-123456-abcdefgh');
  assert.equal(workspaceIdFromHost('https://adb-1234567890123456.7.azuredatabricks.net'), '1234567890123456');
  assert.equal(workspaceIdFromHost('adb-42.1.azuredatabricks.net/'), '42');
  assert.equal(workspaceIdFromHost('https://dbc-a1b2c3d4-e5f6.cloud.databricks.com'), undefined);
});

test('the driver runs only on a Node.js that has the security fix', () => {
  for (const ok of ['22.23.4', '22.30.0', '24.22.1', '24.22.2', '24.30.0', '26.12.1', '27.0.0', '30.1.0']) assert.equal(driverSupportsNode(ok), true, ok);
  for (const old of ['18.20.0', '20.9.0', '22.23.3', '22.9.0', '23.11.0', '24.22.0', '24.9.0', '25.1.0', '26.12.0', '26.1.5']) assert.equal(driverSupportsNode(old), false, old);
});

test('normalizeValue writes each driver value as a warehouse writes it', () => {
  assert.equal(normalizeValue(null), null);
  assert.equal(normalizeValue(undefined), null);
  assert.equal(normalizeValue(9223372036854775807n), '9223372036854775807');
  assert.equal(normalizeValue('12345678901234567890.1234567890'), '12345678901234567890.1234567890');
  assert.equal(normalizeValue(63.0015), '63.0015');
  assert.equal(normalizeValue(true), 'true');
  assert.equal(normalizeValue(new Date('2026-11-01T02:05:00Z')), '2026-11-01T02:05:00.000Z');
  assert.equal(normalizeValue(['order_date', 'region']), '["order_date","region"]');
  assert.equal(normalizeValue({ a: 1n }), '{"a":"1"}');
});

test('cluster runner: a statement that succeeds', async () => {
  const { runner, fake, loads } = makeRunner();
  assert.equal(loads(), 0, 'the driver is not loaded before the first statement');
  const started: string[] = [];
  const result = await runner.run(frequency, { onStarted: (id) => started.push(id) });
  assert.deepEqual(result.columns.map((c) => c.name), ['value', 'n', 'total']);
  assert.deepEqual(result.rows[0], [null, '1123', '110000']);
  assert.deepEqual(started, ['op-1']);

  // The connection: no usage data, exact numbers, the name of the server without "https://".
  assert.deepEqual(fake.connects, [
    {
      host: 'adb-1234567890123456.7.azuredatabricks.net',
      path: 'sql/protocolv1/o/1234567890123456/0101-123456-abcdefgh',
      token: 'token-1',
      userAgentEntry: 'dbx-notebook-table-viz',
      preserveBigNumericPrecision: true,
      telemetryEnabled: false,
    },
  ]);
  assert.ok(!('useKernel' in (fake.connects[0] ?? {})), 'the runner uses the default Thrift path');
  assert.deepEqual(fake.sessions, [{ feature: 'table-viz' }]);
  const options = fake.statements[0]?.options as { namedParameters: Record<string, { type: string; value: string }> } & Record<string, unknown>;
  assert.deepEqual([options.runAsync, options.useCloudFetch, options.useLZ4Compression], [true, false, false]);
  assert.deepEqual({ ...options.namedParameters.limit }, { type: 'INTEGER', value: '6' });
  assert.deepEqual({ ...options.namedParameters.tbl }, { type: 'STRING', value: '`demo`.`shop`.`orders_2026`' });
  assert.equal(fake.closedOperations, 1, 'the runner closes each operation');

  // A second statement uses the same connection and session.
  await runner.run(frequency);
  assert.deepEqual([fake.connects.length, fake.sessions.length, loads()], [1, 1, 1]);
  await runner.close();
  assert.deepEqual([fake.closedSessions, fake.closedClients], [1, 1]);
  // A closed runner runs nothing more. It does not connect again.
  await assert.rejects(runner.run(frequency), CancelledError);
  assert.equal(fake.connects.length, 1);
});

test('both runners give the same rows for the same statement', async () => {
  const { runner } = makeRunner();
  const t = demoTable(dataset.table) as DemoTable;
  const requests: Request[] = [
    { type: 'overview', dataset, columns: t.columns.map((c) => ({ name: c.name, typeText: c.typeText })) },
    { type: 'numericStats', dataset, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }] },
    { type: 'histogram', dataset, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }], edges: { lo: 2.33, hi: 1202.88, bins: 30 } },
    { type: 'frequency', dataset, columns: [{ name: 'is_gift', typeText: 'boolean' }], top: 20 },
    { type: 'dateCounts', dataset, columns: [{ name: 'order_date', typeText: 'date' }], grain: 'month' },
    { type: 'validateFilter', dataset },
    { type: 'tableDetails', dataset },
  ];
  for (const request of requests) {
    for (const statement of buildStatements(request)) {
      const fromCluster = await runner.run(statement);
      const fromWarehouse = await answerStatement(statement); // the rows as a SQL warehouse returns them
      assert.deepEqual(fromCluster.rows, fromWarehouse.rows, `${request.type}: ${statement.sql.slice(0, 40)}`);
      assert.deepEqual(fromCluster.columns.map((c) => c.name), fromWarehouse.columns.map((c) => c.name));
    }
  }

  // Through the SQL profiler, a cluster gives the same results as the demo profiler.
  const workspace = new DemoWorkspaceClient();
  const profiler = new SqlProfiler({
    runner,
    getTable: (table) => workspace.getTable(table),
    limiter: new Limiter(() => 2),
    describe: () => ({ timeoutSeconds: 300, compute: 'The cluster "Test"', host: 'https://example' }),
  });
  const demo = new DemoProfiler();
  for (const request of requests.slice(0, 6)) {
    const expected = await demo.profile({ ...request, dataset: { ...dataset, profile: 'Demo' } } as Request);
    assert.deepEqual(comparable(await profiler.profile(request)), comparable(expected), request.type);
  }
});

test('cluster runner: a statement that fails', async () => {
  const { runner, fake } = makeRunner();
  const missing = statementOf({ type: 'validateFilter', dataset: { ...dataset, table: { ...dataset.table, name: 'orders_1999' } } });
  await assert.rejects(runner.run(missing), (e: unknown) => {
    assert.ok(e instanceof QueryError);
    assert.deepEqual([e.kind, e.code, e.sqlState], ['failed', 'TABLE_OR_VIEW_NOT_FOUND', '42P01']);
    return true;
  });
  assert.equal(fake.connects.length, 1, 'a SQL error does not make a new connection');
  assert.equal(fake.closedOperations, 1);
});

test('cluster runner: cancel', async () => {
  const { runner, fake } = makeRunner();
  fake.hold = true;
  const controller = new AbortController();
  const pending = runner.run(frequency, { signal: controller.signal });
  while (fake.statements.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(pending, CancelledError);
  assert.deepEqual([fake.cancels, fake.closedOperations], [1, 1]);

  // A signal that fired before the start connects to nothing.
  const fresh = makeRunner();
  await assert.rejects(fresh.runner.run(frequency, { signal: controller.signal }), CancelledError);
  assert.equal(fresh.fake.connects.length, 0);
});

test('cluster runner: a statement that runs longer than the time limit is cancelled', async () => {
  const { runner, fake } = makeRunner({ timeoutSeconds: 0.03 });
  fake.hold = true;
  await assert.rejects(runner.run(frequency), (e: unknown) => e instanceof QueryError && e.kind === 'timeout');
  assert.deepEqual([fake.cancels, fake.closedOperations], [1, 1]);
});

test('cluster runner: an expired token gives a new connection with a new token', async () => {
  const { runner, fake, tokenCalls } = makeRunner();
  await runner.run(frequency);
  fake.expiredTokens.add('token-1'); // one hour later
  const result = await runner.run(frequency);
  assert.equal(result.rows.length, 5);
  assert.deepEqual(fake.connects.map((c) => c.token), ['token-1', 'token-2']);
  assert.deepEqual(tokenCalls, [false, true]);
  assert.deepEqual([fake.closedSessions, fake.closedClients], [1, 1], 'the runner closes the old connection');
  assert.equal(fake.statements.length, 3, 'the runner tries the statement one more time');

  // If the new token is refused also, the runner stops.
  fake.expiredTokens.add('token-2');
  await assert.rejects(runner.run(frequency), (e: unknown) => {
    assert.ok(e instanceof QueryError);
    assert.deepEqual([e.kind, e.status], ['http', 401]);
    return true;
  });
  assert.equal(fake.statements.length, 5);
});

test('cluster runner: a session that ended gives a new session', async () => {
  const { runner, fake } = makeRunner();
  await runner.run(frequency);
  fake.failNext.push('Invalid SessionHandle: SessionHandle [abc]');
  assert.equal((await runner.run(frequency)).rows.length, 5);
  assert.equal(fake.sessions.length, 2);
  // An error that is not about the session or the token gets no second try.
  fake.failNext.push('[DIVIDE_BY_ZERO] Division by zero. SQLSTATE: 22012');
  await assert.rejects(runner.run(frequency), /DIVIDE_BY_ZERO/);
  assert.equal(fake.sessions.length, 2);
});

test('cluster runner: a connection that fails is tried again by the next statement', async () => {
  const fake = makeFakeDriver();
  let fail = true;
  const runner = new ClusterRunner({
    loadDriver: () => fake.module,
    host: () => 'https://example',
    httpPath: () => {
      if (fail) throw new Error('The HTTP path of the cluster is not known.');
      return 'sql/protocolv1/o/1/c';
    },
    token: async () => 't',
    timeoutSeconds: () => 300,
    tags: {},
  });
  await assert.rejects(runner.run(frequency), /HTTP path of the cluster is not known/);
  fail = false;
  assert.equal((await runner.run(frequency)).rows.length, 5);
});
