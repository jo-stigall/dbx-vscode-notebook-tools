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
 *     POST /api/2.0/sql/statements                  answers the statement from the demo tables (see warehouse.ts)
 *     GET  /api/2.0/sql/statements/{id}
 *     POST /api/2.0/sql/statements/{id}/cancel
 *
 * A statement starts a stopped warehouse, as on Databricks. Each answer has
 * the header "x-databricks-org-id" with the ID of the workspace.
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
import { DEMO_TABLE_NAMES, demoTable } from '../../../src/tableViz/demo/data.ts';
import { makeFakeDriver } from './driver.ts';
import { answerStatement, FakeSqlError } from './warehouse.ts';

export { makeFakeDriver };

/** The ID of the fake workspace. */
export const FAKE_WORKSPACE_ID = '1234567890123456';

interface FakeCluster {
  cluster_name: string;
  state: string;
  spark_version: string;
  data_security_mode?: string;
  cluster_source: string;
  /** The number of "get" requests until a cluster that starts is RUNNING. */
  startsIn?: number;
}

interface StatementState {
  body: Record<string, unknown>;
  /** The answer when the statement is done. Not set while it "runs". */
  done?: Record<string, unknown>;
  cancelled: boolean;
}

export interface FakeWorkspace {
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
  close(): void;
}

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

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'x-databricks-org-id': FAKE_WORKSPACE_ID });
    res.end(JSON.stringify(body));
  };
  const notFound = (res: ServerResponse, message: string) => send(res, 404, { error_code: 'RESOURCE_DOES_NOT_EXIST', message });
  const statusOf = (id: string, s: StatementState) =>
    s.cancelled ? { statement_id: id, status: { state: 'CANCELED' } } : (s.done ?? { statement_id: id, status: { state: 'RUNNING' } });

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

  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => void handle(req, res, text).catch((e) => send(res, 500, { message: String(e) })));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  workspace.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return workspace;
}
