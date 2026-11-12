/**
 * Read the environment variables of the live tests and make a query runner for the real workspace.
 *
 * The live tests need these variables:
 *
 *     DATABRICKS_HOST                 the workspace URL
 *     DATABRICKS_TOKEN                a personal access token
 *     TABLE_VIZ_TEST_WAREHOUSE_ID     the ID of a SQL warehouse
 *     TABLE_VIZ_TEST_SCHEMA           a schema that the tests can write to, as catalog.schema
 *
 * This variable is optional. If it is set, the tests run a second time on that cluster:
 *
 *     TABLE_VIZ_TEST_CLUSTER_ID       the ID of an all-purpose cluster that runs
 *
 * setup.ts (`npm run live:setup`) and live.test.ts (`npm run test:live`) use
 * this file. The clients here are the real ones from src/tableViz/host: the
 * REST client, the warehouse runner and the cluster runner. No fake has a
 * part in the live tests.
 *
 * NOT VERIFIED: no person has run this code on a workspace yet.
 */
import { clusterHttpPath, workspaceIdFromHost } from '../../../src/tableViz/core/clusters.ts';
import type { QueryRunner } from '../../../src/tableViz/core/runner.ts';
import { ClusterRunner, type DriverModule } from '../../../src/tableViz/host/clusterRunner.ts';
import { createHttp } from '../../../src/tableViz/host/http.ts';
import { StatementExecutionRunner } from '../../../src/tableViz/host/statementRunner.ts';

/**
 * The settings of the live tests, from the environment variables.
 *
 * The token is not a field. The clients read DATABRICKS_TOKEN each time that
 * they need it.
 */
export interface LiveEnv {
  /** The workspace URL, from DATABRICKS_HOST. Example: 'https://adb-1234567890123456.7.azuredatabricks.net'. */
  host: string;
  /** The ID of the SQL warehouse, from TABLE_VIZ_TEST_WAREHOUSE_ID. */
  warehouseId: string;
  /** Not set if TABLE_VIZ_TEST_CLUSTER_ID is not set. */
  clusterId?: string;
  /** The first part of TABLE_VIZ_TEST_SCHEMA. Example: 'main' for 'main.table_viz_test'. */
  catalog: string;
  /** The second part of TABLE_VIZ_TEST_SCHEMA. Example: 'table_viz_test' for 'main.table_viz_test'. */
  schema: string;
}

/**
 * Read the settings of the live tests from the environment variables.
 *
 * @example
 * // With DATABRICKS_HOST, DATABRICKS_TOKEN, TABLE_VIZ_TEST_WAREHOUSE_ID=abc123 and TABLE_VIZ_TEST_SCHEMA=main.table_viz_test:
 * liveEnv()   // { host: 'https://...', warehouseId: 'abc123', catalog: 'main', schema: 'table_viz_test', clusterId: undefined }
 * // With no variables:
 * liveEnv()   // undefined
 *
 * @returns The settings. undefined if one of the four variables is missing, or if TABLE_VIZ_TEST_SCHEMA does not have exactly two parts.
 */
export function liveEnv(): LiveEnv | undefined {
  const { DATABRICKS_HOST: host, DATABRICKS_TOKEN: token, TABLE_VIZ_TEST_WAREHOUSE_ID: warehouseId, TABLE_VIZ_TEST_SCHEMA: target } = process.env;
  const [catalog, schema, extra] = (target ?? '').split('.');
  if (!host || !token || !warehouseId || !catalog || !schema || extra) return undefined;
  return { host, warehouseId, catalog, schema, clusterId: process.env.TABLE_VIZ_TEST_CLUSTER_ID || undefined };
}

/**
 * Make the REST client and the warehouse runner for the workspace of the variables.
 *
 * Each statement of the runner has the tags `feature: table-viz` and
 * `purpose: live-test`. The second tag marks it as a statement of the live tests.
 *
 * @example
 * const { http, runner } = liveClients(env);
 * await runner.run({ sql: 'SELECT 1', params: [] });
 *
 * @param env  The settings from `liveEnv()`.
 * @param timeoutSeconds  The time limit of one statement. Default: 600 seconds.
 * @returns `http`, the REST client, and `runner`, the warehouse runner.
 */
export function liveClients(env: LiveEnv, timeoutSeconds = 600) {
  const http = createHttp({ host: () => env.host, token: async () => process.env.DATABRICKS_TOKEN ?? '', timeoutMs: 60_000 });
  const runner = new StatementExecutionRunner({ http, warehouseId: env.warehouseId, timeoutSeconds: () => timeoutSeconds, tags: { feature: 'table-viz', purpose: 'live-test' } });
  return { http, runner };
}

/**
 * Make the cluster runner for the cluster of TABLE_VIZ_TEST_CLUSTER_ID, with the real SQL driver.
 *
 * The HTTP path of the cluster needs the ID of the workspace. The function
 * reads the ID from the answer of one REST request, or from an Azure URL.
 *
 * @example
 * const runner = liveClusterRunner(env);
 * await runner.run({ sql: 'SELECT 1', params: [] });
 * // The runner connects with the HTTP path 'sql/protocolv1/o/<workspace ID>/<cluster ID>'.
 *
 * @param env  The settings from `liveEnv()`. They must have a `clusterId`.
 * @param timeoutSeconds  The time limit of one statement. Default: 300 seconds.
 */
export function liveClusterRunner(env: LiveEnv, timeoutSeconds = 300): QueryRunner {
  let workspaceId = workspaceIdFromHost(env.host);
  const http = createHttp({ host: () => env.host, token: async () => process.env.DATABRICKS_TOKEN ?? '', onWorkspaceId: (id) => (workspaceId = id) });
  return new ClusterRunner({
    loadDriver: async () => (await import('@databricks/sql')) as unknown as DriverModule,
    host: () => env.host,
    httpPath: async () => {
      await http('GET', '/api/2.1/clusters/get', { cluster_id: env.clusterId });
      if (!workspaceId) throw new Error('The workspace did not send its ID in the header "x-databricks-org-id".');
      return clusterHttpPath(workspaceId, env.clusterId as string);
    },
    token: async () => process.env.DATABRICKS_TOKEN ?? '',
    timeoutSeconds: () => timeoutSeconds,
    tags: { feature: 'table-viz', purpose: 'live-test' },
  });
}
