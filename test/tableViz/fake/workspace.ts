/**
 * A fake Databricks workspace for tests: an HTTP server on this computer.
 *
 * It answers the REST requests that the feature sends:
 *
 *     GET  /api/2.0/sql/warehouses                  two warehouses: "wh-run" runs, "wh-stop" is stopped
 *     GET  /api/2.0/sql/warehouses/{id}
 *     GET  /api/2.1/clusters/list                   five clusters: see `clusters` below
 *     GET  /api/2.1/clusters/get
 *     POST /api/2.1/clusters/start                  the cluster is PENDING, and RUNNING after two more "get" requests
 *     GET  /api/2.1/unity-catalog/catalogs          the catalog "demo"
 *     GET  /api/2.1/unity-catalog/schemas           the schema "shop"
 *     GET  /api/2.1/unity-catalog/tables            the demo tables, one table on each page
 *     GET  /api/2.1/unity-catalog/tables/{name}     the columns of a demo table
 *     GET  /api/2.1/unity-catalog/table-summaries   the demo tables whose names fit the patterns: an empty page first, then one table on each page
 *     POST /api/2.0/sql/statements                  answers the statement from the demo tables (see warehouse.ts)
 *     GET  /api/2.0/sql/statements/{id}
 *     POST /api/2.0/sql/statements/{id}/cancel
 *
 * A statement starts a stopped warehouse, as on Databricks. Each answer has
 * the header "x-databricks-org-id" with the ID of the workspace.
 *
 * The fake is different from a Databricks workspace in these ways:
 *
 * - It does not run SQL. It answers each statement from the demo tables
 *   (see warehouse.ts). Thus it does not show that Databricks accepts a statement.
 * - It accepts each token. A request without a "Bearer" token gets HTTP 401.
 * - The answer to the POST request has the final state of the statement.
 *   Set `hold` to keep the statement in the state RUNNING.
 * - A stopped warehouse runs at once. On Databricks, a warehouse needs time to start.
 * - It returns all rows of a result in one piece.
 * - It has one catalog, one schema, two tables, two warehouses and five clusters.
 *
 * Two tests use this file:
 *
 *     npm run test:unit    test/tableViz/unit/workspace.test.ts
 *     npm run test:e2e     test/tableViz/integration/workspace.cjs
 *
 * The test in VS Code cannot load a TypeScript file. `npm run build` makes
 * dist/test/fakeWorkspace.cjs from this file for it.
 *
 * @example
 * const workspace = await startFakeWorkspace();
 * workspace.url        // 'http://127.0.0.1:54321'
 * workspace.requests   // ['GET /api/2.0/sql/warehouses', ...]
 * workspace.close();
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseTableName } from '../../../src/tableViz/core/names.ts';
import { like } from '../../../src/tableViz/core/search.ts';
import { DEMO_TABLE_NAMES, demoTable } from '../../../src/tableViz/demo/data.ts';
import { makeFakeDriver } from './driver.ts';
import { answerStatement, FakeSqlError } from './warehouse.ts';

// The build makes dist/test/fakeWorkspace.cjs from this file. The test in VS Code gets the fake driver from that file also.
export { makeFakeDriver };

/** The ID of the fake workspace. The server sends it in the header "x-databricks-org-id" of each answer. */
export const FAKE_WORKSPACE_ID = '1234567890123456';

/** One cluster of the fake workspace. The fields have the names that the Clusters API of Databricks uses. */
interface FakeCluster {
  cluster_name: string;
  /** 'RUNNING', 'TERMINATED' or 'PENDING'. */
  state: string;
  /** The runtime of the cluster, for example '15.4.x-scala2.12'. */
  spark_version: string;
  /** The access mode, for example 'SINGLE_USER'. 'NONE' cannot read Unity Catalog. */
  data_security_mode?: string;
  /** What made the cluster: 'UI', 'API' or 'JOB'. The extension does not list the cluster of a job. */
  cluster_source: string;
  /** The number of "get" requests until a cluster that starts is RUNNING. */
  startsIn?: number;
}

/** What the fake workspace keeps for one statement. */
interface StatementState {
  /** The body of the POST request that started the statement. */
  body: Record<string, unknown>;
  /** The answer when the statement is done. Not set while it "runs". */
  done?: Record<string, unknown>;
  /** true after a cancel request for a statement that was not done. The statement then has the state CANCELED. */
  cancelled: boolean;
}

/**
 * A fake workspace that runs: its address, the record of what it received, and the parts that a test can change.
 */
export interface FakeWorkspace {
  /** The address of the server, for example 'http://127.0.0.1:54321'. The port is different on each run. */
  url: string;
  /** Each request as "METHOD /path", oldest first. */
  requests: string[];
  /** The bodies of the statements that the workspace received. */
  statements: Record<string, unknown>[];
  /** The state of each warehouse. A test can change it. */
  warehouses: Record<string, { name: string; state: string; cluster_size: string }>;
  /** The clusters. A test can change them. */
  clusters: Record<string, FakeCluster>;
  /** true: a statement stays in the state RUNNING until it is cancelled. For cancel tests. */
  hold: boolean;
  /** Stop the server and close its open connections. */
  close(): void;
}

/**
 * Start a fake workspace on a free port of this computer.
 *
 * @example
 * const fake = await startFakeWorkspace();
 * const http = createHttp({ host: () => fake.url, token: async () => 'test-token' });
 * await new RestWorkspaceClient(http).listCatalogs()   // ['demo']
 * fake.requests                                         // ['GET /api/2.1/unity-catalog/catalogs']
 * fake.hold = true;                                     // the next statements stay in the state RUNNING
 * fake.close();
 *
 * @returns The fake workspace. Call `close()` when the test is done.
 */
export async function startFakeWorkspace(): Promise<FakeWorkspace> {
  const statements = new Map<string, StatementState>();
  const workspace: FakeWorkspace = {
    url: '',
    requests: [],
    statements: [],
    warehouses: {
      'wh-run': { name: 'Fake running', state: 'RUNNING', cluster_size: 'Small' },
      'wh-stop': { name: 'Fake stopped', state: 'STOPPED', cluster_size: 'Medium' },
    },
    clusters: {
      'cl-ok': { cluster_name: 'Fake dedicated', state: 'RUNNING', spark_version: '15.4.x-scala2.12', data_security_mode: 'SINGLE_USER', cluster_source: 'UI' },
      'cl-stop': { cluster_name: 'Fake stopped', state: 'TERMINATED', spark_version: '16.4.x-scala2.13', data_security_mode: 'USER_ISOLATION', cluster_source: 'API' },
      'cl-old': { cluster_name: 'Fake old runtime', state: 'RUNNING', spark_version: '12.2.x-scala2.12', data_security_mode: 'SINGLE_USER', cluster_source: 'UI' },
      'cl-open': { cluster_name: 'Fake no isolation', state: 'RUNNING', spark_version: '15.4.x-scala2.12', data_security_mode: 'NONE', cluster_source: 'UI' },
      'cl-job': { cluster_name: 'job-123-run-1', state: 'RUNNING', spark_version: '15.4.x-scala2.12', data_security_mode: 'SINGLE_USER', cluster_source: 'JOB' },
    },
    hold: false,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };

  // Send a JSON answer with the header that has the ID of the workspace.
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'x-databricks-org-id': FAKE_WORKSPACE_ID });
    res.end(JSON.stringify(body));
  };
  // Send HTTP 404 with the error code that Databricks uses for a warehouse or a statement that does not exist.
  const notFound = (res: ServerResponse, message: string) => send(res, 404, { error_code: 'RESOURCE_DOES_NOT_EXIST', message });
  // Make the answer to a status request: CANCELED, the stored final answer, or RUNNING.
  const statusOf = (id: string, s: StatementState) =>
    s.cancelled ? { statement_id: id, status: { state: 'CANCELED' } } : (s.done ?? { statement_id: id, status: { state: 'RUNNING' } });

  /**
   * Answer one request.
   *
   * @param text  The body of the request, as text. Empty for a GET request.
   */
  async function handle(req: IncomingMessage, res: ServerResponse, text: string): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const query = url.searchParams;
    workspace.requests.push(`${req.method} ${path}`);
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) return send(res, 401, { message: 'Invalid access token' });

    if (path === '/api/2.0/sql/warehouses') {
      return send(res, 200, { warehouses: Object.entries(workspace.warehouses).map(([id, w]) => ({ id, ...w })) });
    }
    const warehouse = /^\/api\/2\.0\/sql\/warehouses\/([^/]+)$/.exec(path);
    if (warehouse) {
      const id = decodeURIComponent(warehouse[1] as string);
      const found = workspace.warehouses[id];
      return found ? send(res, 200, { id, ...found }) : notFound(res, `Warehouse ${id} does not exist`);
    }

    // Write a cluster as the Clusters API returns it. `startsIn` is a field of the fake only.
    const clusterBody = (id: string, c: FakeCluster) => {
      const { startsIn: _startsIn, ...rest } = c;
      return { cluster_id: id, ...rest };
    };
    if (path === '/api/2.1/clusters/list') {
      return send(res, 200, { clusters: Object.entries(workspace.clusters).map(([id, c]) => clusterBody(id, c)) });
    }
    if (path === '/api/2.1/clusters/get' || path === '/api/2.1/clusters/start') {
      const id = path.endsWith('/get') ? String(query.get('cluster_id')) : String((JSON.parse(text || '{}') as { cluster_id?: string }).cluster_id);
      const cluster = workspace.clusters[id];
      if (!cluster) return send(res, 400, { error_code: 'INVALID_PARAMETER_VALUE', message: `Cluster ${id} does not exist` });
      if (path.endsWith('/start')) {
        cluster.state = 'PENDING';
        cluster.startsIn = 2;
        return send(res, 200, {});
      }
      if (cluster.state === 'PENDING' && cluster.startsIn !== undefined && --cluster.startsIn <= 0) cluster.state = 'RUNNING';
      return send(res, 200, clusterBody(id, cluster));
    }

    if (path === '/api/2.1/unity-catalog/catalogs') return send(res, 200, { catalogs: [{ name: 'demo' }] });
    if (path === '/api/2.1/unity-catalog/schemas') {
      return send(res, 200, { schemas: query.get('catalog_name') === 'demo' ? [{ name: 'shop', full_name: 'demo.shop' }] : [] });
    }
    if (path === '/api/2.1/unity-catalog/tables') {
      const tables = DEMO_TABLE_NAMES.filter((t) => t.catalog === query.get('catalog_name') && t.schema === query.get('schema_name'));
      // One table on each page, so that the client must follow the page tokens.
      const page = Number(query.get('page_token') ?? 0);
      const table = tables[page];
      return send(res, 200, {
        tables: table ? [{ name: table.name, table_type: 'MANAGED' }] : [],
        ...(page + 1 < tables.length ? { next_page_token: String(page + 1) } : {}),
      });
    }
    if (path === '/api/2.1/unity-catalog/table-summaries') {
      const tables = DEMO_TABLE_NAMES.filter(
        (t) => t.catalog === query.get('catalog_name') && like(t.schema, query.get('schema_name_pattern') ?? undefined) && like(t.name, query.get('table_name_pattern') ?? undefined)
      );
      // Databricks can send a page with no tables and a token. The first page is such a page, so that the client must read on.
      const page = Number(query.get('page_token') ?? -1);
      const table = tables[page];
      return send(res, 200, {
        tables: table ? [{ full_name: `${table.catalog}.${table.schema}.${table.name}`, table_type: 'MANAGED' }] : [],
        ...(page + 1 < tables.length ? { next_page_token: String(page + 1) } : {}),
      });
    }
    const tableGet = /^\/api\/2\.1\/unity-catalog\/tables\/(.+)$/.exec(path);
    if (tableGet) {
      const name = decodeURIComponent(tableGet[1] as string);
      const table = parseTableName(name);
      const demo = table && demoTable(table);
      if (!demo) return send(res, 404, { error_code: 'TABLE_DOES_NOT_EXIST', message: `Table '${name}' does not exist.` });
      let partition = 0;
      return send(res, 200, {
        name: demo.name.name,
        table_type: 'MANAGED',
        data_source_format: 'DELTA',
        updated_at: Date.parse(demo.lastModified),
        columns: demo.columns.map((c, position) => ({ name: c.name, type_text: c.typeText, position, ...(c.partition ? { partition_index: partition++ } : {}) })),
      });
    }

    if (path === '/api/2.0/sql/statements' && req.method === 'POST') {
      const body = JSON.parse(text || '{}') as Record<string, unknown>;
      workspace.statements.push(body);
      const warehouseId = String(body.warehouse_id);
      const target = workspace.warehouses[warehouseId];
      if (!target) return notFound(res, `Warehouse ${warehouseId} does not exist`);
      target.state = 'RUNNING'; // A statement starts a stopped warehouse.
      const id = `st-${statements.size + 1}`;
      const state: StatementState = { body, cancelled: false };
      statements.set(id, state);
      if (!workspace.hold) {
        try {
          const params = (body.parameters as { name: string; value: string; type: 'STRING' | 'INT' | 'DOUBLE' }[]) ?? [];
          const result = await answerStatement({ sql: String(body.statement), params });
          state.done = {
            statement_id: id,
            status: { state: 'SUCCEEDED' },
            manifest: { schema: { columns: result.columns.map((c, position) => ({ name: c.name, type_name: c.typeName, position })) } },
            result: { data_array: result.rows },
          };
        } catch (e) {
          const error = e instanceof FakeSqlError ? { error_code: e.code, message: e.message } : { error_code: 'INTERNAL_ERROR', message: String(e) };
          state.done = { statement_id: id, status: { state: 'FAILED', error, ...(e instanceof FakeSqlError ? { sql_state: e.sqlState } : {}) } };
        }
      }
      return send(res, 200, statusOf(id, state));
    }
    const statement = /^\/api\/2\.0\/sql\/statements\/([^/]+)(\/cancel)?$/.exec(path);
    if (statement) {
      const id = statement[1] as string;
      const state = statements.get(id);
      if (!state) return notFound(res, `Statement ${id} does not exist`);
      if (statement[2]) {
        if (!state.done) state.cancelled = true;
        return send(res, 200, {});
      }
      return send(res, 200, statusOf(id, state));
    }
    return send(res, 404, { message: `The fake workspace has no ${path}` });
  }

  // Read the full body of each request, then answer it. An error in `handle` becomes HTTP 500.
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => void handle(req, res, text).catch((e) => send(res, 500, { message: String(e) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  workspace.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return workspace;
}
