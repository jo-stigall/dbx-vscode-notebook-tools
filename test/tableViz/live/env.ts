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
 */
import { clusterHttpPath, workspaceIdFromHost } from '../../../src/tableViz/core/clusters.ts';
import type { QueryRunner } from '../../../src/tableViz/core/runner.ts';
import { ClusterRunner, type DriverModule } from '../../../src/tableViz/host/clusterRunner.ts';
import { createHttp } from '../../../src/tableViz/host/http.ts';
import { StatementExecutionRunner } from '../../../src/tableViz/host/statementRunner.ts';

export interface LiveEnv {
  host: string;
  warehouseId: string;
  /** Not set if TABLE_VIZ_TEST_CLUSTER_ID is not set. */
  clusterId?: string;
  catalog: string;
  schema: string;
}

/** Returns the settings, or undefined if a variable is missing. */
export function liveEnv(): LiveEnv | undefined {
  const { DATABRICKS_HOST: host, DATABRICKS_TOKEN: token, TABLE_VIZ_TEST_WAREHOUSE_ID: warehouseId, TABLE_VIZ_TEST_SCHEMA: target } = process.env;
  const [catalog, schema, extra] = (target ?? '').split('.');
  if (!host || !token || !warehouseId || !catalog || !schema || extra) return undefined;
  return { host, warehouseId, catalog, schema, clusterId: process.env.TABLE_VIZ_TEST_CLUSTER_ID || undefined };
}

/** Make the REST client and the warehouse runner for the workspace of the variables. */
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
