/**
 * Read the environment variables of the live tests and make a query runner for the real workspace.
 *
 * The live tests need these variables:
 *
 *     DATABRICKS_HOST                 the workspace URL
 *     DATABRICKS_TOKEN                a personal access token
 *     TABLE_VIZ_TEST_WAREHOUSE_ID     the ID of a SQL warehouse
 *     TABLE_VIZ_TEST_SCHEMA           a schema that the tests can write to, as catalog.schema
 */
import { createHttp } from '../../../src/tableViz/host/http.ts';
import { StatementExecutionRunner } from '../../../src/tableViz/host/statementRunner.ts';

export interface LiveEnv {
  host: string;
  warehouseId: string;
  catalog: string;
  schema: string;
}

/** Returns the settings, or undefined if a variable is missing. */
export function liveEnv(): LiveEnv | undefined {
  const { DATABRICKS_HOST: host, DATABRICKS_TOKEN: token, TABLE_VIZ_TEST_WAREHOUSE_ID: warehouseId, TABLE_VIZ_TEST_SCHEMA: target } = process.env;
  const [catalog, schema, extra] = (target ?? '').split('.');
  if (!host || !token || !warehouseId || !catalog || !schema || extra) return undefined;
  return { host, warehouseId, catalog, schema };
}

/** Make the REST client and the warehouse runner for the workspace of the variables. */
export function liveClients(env: LiveEnv, timeoutSeconds = 600) {
  const http = createHttp({ host: () => env.host, token: async () => process.env.DATABRICKS_TOKEN ?? '', timeoutMs: 60_000 });
  const runner = new StatementExecutionRunner({ http, warehouseId: env.warehouseId, timeoutSeconds: () => timeoutSeconds, tags: { feature: 'table-viz', purpose: 'live-test' } });
  return { http, runner };
}
