/**
 * The WorkspaceClient: list the SQL warehouses, clusters, catalogs, schemas and tables of a workspace.
 *
 * All functions use the REST API. None runs SQL, so that browsing never
 * starts a stopped warehouse.
 *
 * The file has two clients. RestWorkspaceClient asks a real workspace.
 * DemoWorkspaceClient answers for the Demo profile from the demo tables.
 *
 * The design note says that the requests to the warehouses API and to the
 * Unity Catalog API are from memory: see "Decisions in milestone 4" in
 * docs/table-viz-design.md. The fake workspace of the tests uses the same
 * field names, so only the live tests can find a wrong name.
 *
 * This file does not import `vscode`, so that a test can use it with a
 * local server.
 */
import type { ClusterInfo } from '../core/clusters.ts';
import { displayTableName, parseTableName } from '../core/names.ts';
import type { ColumnInfo, TableName } from '../core/schema.ts';
import { like, type FoundTable } from '../core/search.ts';
import { DEMO_TABLE_NAMES, demoTable } from '../demo/data.ts';
import { HttpError, type Http } from './http.ts';
import type { TableInfo } from './sqlProfiler.ts';

/** What the warehouses API tells about a SQL warehouse. */
export interface Warehouse {
  id: string;
  /** The name that the list of compute shows. If the API gives no name, this is the ID. */
  name: string;
  /** RUNNING, STOPPED, STARTING, STOPPING, DELETED or DELETING. */
  state: string;
  /** The size, as the API writes it in `cluster_size`. Example: 'Small'. */
  size?: string;
}

/** A table or view in a schema, as the tree shows it. */
export interface TableEntry {
  /** The last part of the table name. Example: 'orders' for main.shop.orders. */
  name: string;
  /** 'view' for a view, a materialized view and a metric view. 'table' for all other types. */
  tableType: 'table' | 'view';
}

/**
 * Reads what a workspace contains: SQL warehouses, clusters, catalogs, schemas and tables.
 *
 * The tree, the lists of "Select Profile and Compute for Tables" and the
 * session use this interface. Thus they work the same for a real workspace
 * and for the Demo profile.
 *
 * @example
 * const workspace = session.workspace('prod');
 * await workspace.listSchemas('main')                 // ['default', 'shop']
 * await workspace.listTables('main', 'shop')          // [{ name: 'orders', tableType: 'table' }]
 */
export interface WorkspaceClient {
  /** List the SQL warehouses, sorted by name. */
  listWarehouses(): Promise<Warehouse[]>;
  /** Get one SQL warehouse. The session calls it to read the state of the warehouse before a statement. */
  getWarehouse(id: string): Promise<Warehouse>;
  /** List the all-purpose clusters. The list does not contain the clusters of jobs and pipelines. */
  listClusters(): Promise<ClusterInfo[]>;
  /** Get one cluster. The session calls it to read the state of the cluster before a statement. */
  getCluster(id: string): Promise<ClusterInfo>;
  /** Tell Databricks to start a stopped cluster. The function returns before the cluster runs. */
  startCluster(id: string): Promise<void>;
  /** List the names of the catalogs, sorted. */
  listCatalogs(): Promise<string[]>;
  /** List the names of the schemas of a catalog, sorted. */
  listSchemas(catalog: string): Promise<string[]>;
  /** List the tables and views of a schema, sorted by name. */
  listTables(catalog: string, schema: string): Promise<TableEntry[]>;
  /** Get the columns and the type of a table. Throws an HttpError with status 404 if the table does not exist. */
  getTable(table: TableName): Promise<TableInfo>;
  /**
   * Find the tables and views of one catalog whose names fit two patterns. The function runs no SQL.
   *
   * @example
   * await workspace.findTables('main', undefined, '%ord%', 200)
   * // { tables: [{ table: { catalog: 'main', schema: 'shop', name: 'orders' }, tableType: 'table' }], more: false }
   *
   * @param schemaPattern  A SQL LIKE pattern for the schema name. Not set: all schemas.
   * @param tablePattern  A SQL LIKE pattern for the table name. Not set: all tables.
   * @param limit  The largest number of tables to return.
   * @param signal  Stops the requests when it fires.
   * @returns `more` is true if the catalog has more tables that fit than `limit`.
   */
  findTables(catalog: string, schemaPattern: string | undefined, tablePattern: string | undefined, limit: number, signal?: AbortSignal): Promise<FoundTables>;
}

/** The answer of findTables(): the tables, and `more` if there are more than the limit. */
export interface FoundTables {
  tables: FoundTable[];
  more: boolean;
}

/**
 * The largest number of pages that one list reads. One page of tables has 50 entries.
 * Thus the tree shows 10,000 tables of one schema at most.
 */
const MAX_PAGES = 200;

/** The values of `table_type` in Unity Catalog that the feature shows as a view. */
const VIEW_TYPES = new Set(['VIEW', 'MATERIALIZED_VIEW', 'METRIC_VIEW']);

/**
 * Convert a `table_type` of Unity Catalog to 'table' or 'view'.
 *
 * @example
 * tableTypeOf('MATERIALIZED_VIEW')   // 'view'
 * tableTypeOf('MANAGED')             // 'table'
 * tableTypeOf(undefined)             // 'table'
 */
const tableTypeOf = (type: unknown): 'table' | 'view' => (VIEW_TYPES.has(String(type)) ? 'view' : 'table');

/**
 * The client for a real workspace. Each method sends one or more requests to the REST API.
 *
 * @example
 * const http = createHttp({ host: () => 'https://adb-123.azuredatabricks.net', token: async () => 'dapi...' });
 * const client = new RestWorkspaceClient(http);
 * await client.listCatalogs()   // ['main', 'samples']
 */
export class RestWorkspaceClient implements WorkspaceClient {
  /** Sends one request to the workspace. See createHttp() in http.ts. */
  private readonly http: Http;

  /** @param http  The function that sends requests to the workspace, with the login token. */
  constructor(http: Http) {
    this.http = http;
  }

  /**
   * Read all pages of a list.
   *
   * Databricks puts a `next_page_token` in an answer if more pages exist.
   * The function sends that token as `page_token` in the next request. It
   * stops when an answer has no token, or after 200 pages.
   *
   * @example
   * // GET /api/2.1/unity-catalog/catalogs?max_results=0
   * //   answer: { catalogs: [{ name: 'main' }], next_page_token: 'abc' }
   * // GET /api/2.1/unity-catalog/catalogs?max_results=0&page_token=abc
   * //   answer: { catalogs: [{ name: 'samples' }] }
   * await this.pages('/api/2.1/unity-catalog/catalogs', { max_results: 0 }, 'catalogs')
   * // [{ name: 'main' }, { name: 'samples' }]
   *
   * @param path  The path of the API. Example: '/api/2.1/unity-catalog/catalogs'.
   * @param query  The parameters that each request has in its URL.
   * @param field  The name of the list in each answer. Example: 'catalogs'.
   */
  private async pages<T>(path: string, query: Record<string, unknown>, field: string): Promise<T[]> {
    const all: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const answer = (await this.http('GET', path, { ...query, page_token: pageToken })) as Record<string, unknown>;
      const items = answer[field];
      if (Array.isArray(items)) all.push(...(items as T[]));
      pageToken = typeof answer.next_page_token === 'string' && answer.next_page_token ? answer.next_page_token : undefined;
      if (!pageToken) break;
    }
    return all;
  }

  /**
   * Convert one warehouse of an API answer to a Warehouse.
   *
   * A warehouse with no `name` gets its ID as the name. A warehouse with no
   * `state` gets the state 'UNKNOWN'.
   *
   * @example
   * RestWorkspaceClient.warehouse({ id: 'abc123def456', name: 'Starter Warehouse', state: 'RUNNING', cluster_size: 'Small' })
   * // { id: 'abc123def456', name: 'Starter Warehouse', state: 'RUNNING', size: 'Small' }
   */
  private static warehouse(raw: Record<string, unknown>): Warehouse {
    return { id: String(raw.id ?? ''), name: String(raw.name ?? raw.id ?? ''), state: String(raw.state ?? 'UNKNOWN'), size: raw.cluster_size ? String(raw.cluster_size) : undefined };
  }

  /**
   * List the SQL warehouses of the workspace, sorted by name.
   *
   * The request reads the list only. It does not start a warehouse.
   *
   * @example
   * // GET /api/2.0/sql/warehouses
   * //   answer: { warehouses: [{ id: 'abc123def456', name: 'Starter Warehouse', state: 'STOPPED', cluster_size: 'Small' }] }
   * await client.listWarehouses()
   * // [{ id: 'abc123def456', name: 'Starter Warehouse', state: 'STOPPED', size: 'Small' }]
   */
  async listWarehouses(): Promise<Warehouse[]> {
    const answer = (await this.http('GET', '/api/2.0/sql/warehouses')) as { warehouses?: Record<string, unknown>[] };
    return (answer.warehouses ?? []).map(RestWorkspaceClient.warehouse).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get one SQL warehouse.
   *
   * @example
   * // GET /api/2.0/sql/warehouses/abc123def456
   * //   answer: { id: 'abc123def456', name: 'Starter Warehouse', state: 'RUNNING', cluster_size: 'Small' }
   * await client.getWarehouse('abc123def456')
   * // { id: 'abc123def456', name: 'Starter Warehouse', state: 'RUNNING', size: 'Small' }
   *
   * @throws {HttpError}  If Databricks refuses the request. The session reads status 404 as "the warehouse does not exist".
   */
  async getWarehouse(id: string): Promise<Warehouse> {
    return RestWorkspaceClient.warehouse((await this.http('GET', `/api/2.0/sql/warehouses/${encodeURIComponent(id)}`)) as Record<string, unknown>);
  }

  /**
   * Convert one cluster of an API answer to a ClusterInfo.
   *
   * A cluster with no `cluster_name` gets its ID as the name. A cluster with
   * no `state` gets the state 'UNKNOWN'. The values of `data_security_mode`
   * are not verified on a real workspace (see "Not verified until a real
   * workspace is available" in docs/table-viz-design.md).
   *
   * @example
   * RestWorkspaceClient.cluster({
   *   cluster_id: '0101-123456-abcdefgh', cluster_name: 'Team cluster', state: 'TERMINATED',
   *   spark_version: '15.4.x-scala2.12', data_security_mode: 'SINGLE_USER',
   * })
   * // { id: '0101-123456-abcdefgh', name: 'Team cluster', state: 'TERMINATED', sparkVersion: '15.4.x-scala2.12', accessMode: 'SINGLE_USER' }
   */
  private static cluster(raw: Record<string, unknown>): ClusterInfo {
    return {
      id: String(raw.cluster_id ?? ''),
      name: String(raw.cluster_name ?? raw.cluster_id ?? ''),
      state: String(raw.state ?? 'UNKNOWN'),
      sparkVersion: raw.spark_version ? String(raw.spark_version) : undefined,
      accessMode: raw.data_security_mode ? String(raw.data_security_mode) : undefined,
    };
  }

  /**
   * List the all-purpose clusters of the workspace, sorted by name.
   *
   * The function keeps a cluster if its `cluster_source` is 'UI' or 'API',
   * or if the answer has no `cluster_source`. It removes the clusters that
   * jobs and pipelines make.
   *
   * @example
   * // GET /api/2.1/clusters/list?page_size=100
   * //   answer: { clusters: [
   * //     { cluster_id: '0101-123456-abcdefgh', cluster_name: 'Team cluster', state: 'RUNNING', cluster_source: 'UI', ... },
   * //     { cluster_id: '0202-654321-hgfedcba', cluster_name: 'job-812-run-1', state: 'RUNNING', cluster_source: 'JOB', ... },
   * //   ] }
   * await client.listClusters()
   * // [{ id: '0101-123456-abcdefgh', name: 'Team cluster', state: 'RUNNING', ... }]
   */
  async listClusters(): Promise<ClusterInfo[]> {
    const clusters = await this.pages<Record<string, unknown>>('/api/2.1/clusters/list', { page_size: 100 }, 'clusters');
    return clusters
      // A person makes an all-purpose cluster in the UI or with the API. Jobs and pipelines make the other clusters.
      .filter((c) => c.cluster_source === undefined || c.cluster_source === 'UI' || c.cluster_source === 'API')
      .map(RestWorkspaceClient.cluster)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get one cluster.
   *
   * @example
   * // GET /api/2.1/clusters/get?cluster_id=0101-123456-abcdefgh
   * //   answer: { cluster_id: '0101-123456-abcdefgh', cluster_name: 'Team cluster', state: 'TERMINATED', ... }
   * (await client.getCluster('0101-123456-abcdefgh')).state   // 'TERMINATED'
   *
   * @throws {HttpError}  If Databricks refuses the request. The session reads status 400 or 404 as "the cluster does not exist".
   */
  async getCluster(id: string): Promise<ClusterInfo> {
    return RestWorkspaceClient.cluster((await this.http('GET', '/api/2.1/clusters/get', { cluster_id: id })) as Record<string, unknown>);
  }

  /**
   * Tell Databricks to start a stopped cluster. The function returns before the cluster runs.
   *
   * The session then calls getCluster() again and again until the state is 'RUNNING'.
   *
   * @example
   * // POST /api/2.1/clusters/start   body: { cluster_id: '0101-123456-abcdefgh' }
   * await client.startCluster('0101-123456-abcdefgh')
   */
  async startCluster(id: string): Promise<void> {
    await this.http('POST', '/api/2.1/clusters/start', { cluster_id: id });
  }

  // Unity Catalog returns all catalogs or schemas in one answer if `max_results` is not set. The docs call that
  // "not recommended" and say that such calls "will be deprecated". `max_results: 0` asks for pages of the size
  // that the server chooses. For tables, 50 is the largest page that the docs permit.

  /**
   * List the names of the catalogs that the user can see, sorted.
   *
   * @example
   * // GET /api/2.1/unity-catalog/catalogs?max_results=0
   * //   answer: { catalogs: [{ name: 'samples', ... }, { name: 'main', ... }] }
   * await client.listCatalogs()   // ['main', 'samples']
   */
  async listCatalogs(): Promise<string[]> {
    const catalogs = await this.pages<{ name?: string }>('/api/2.1/unity-catalog/catalogs', { max_results: 0 }, 'catalogs');
    return catalogs.map((c) => c.name ?? '').filter(Boolean).sort();
  }

  /**
   * List the names of the schemas of a catalog, sorted.
   *
   * @example
   * // GET /api/2.1/unity-catalog/schemas?catalog_name=main&max_results=0
   * //   answer: { schemas: [{ name: 'shop', ... }, { name: 'default', ... }] }
   * await client.listSchemas('main')   // ['default', 'shop']
   */
  async listSchemas(catalog: string): Promise<string[]> {
    const schemas = await this.pages<{ name?: string }>('/api/2.1/unity-catalog/schemas', { catalog_name: catalog, max_results: 0 }, 'schemas');
    return schemas.map((s) => s.name ?? '').filter(Boolean).sort();
  }

  /**
   * List the tables and views of a schema, sorted by name.
   *
   * The request asks Databricks to omit the columns and the properties of
   * each table, so that the answer is small.
   *
   * @example
   * // GET /api/2.1/unity-catalog/tables?catalog_name=main&schema_name=shop&max_results=50&omit_columns=true&omit_properties=true
   * //   answer: { tables: [{ name: 'orders', table_type: 'MANAGED', ... }, { name: 'daily_sales', table_type: 'VIEW', ... }] }
   * await client.listTables('main', 'shop')
   * // [{ name: 'daily_sales', tableType: 'view' }, { name: 'orders', tableType: 'table' }]
   */
  async listTables(catalog: string, schema: string): Promise<TableEntry[]> {
    const query = { catalog_name: catalog, schema_name: schema, max_results: 50, omit_columns: true, omit_properties: true };
    const tables = await this.pages<{ name?: string; table_type?: string }>('/api/2.1/unity-catalog/tables', query, 'tables');
    return tables
      .filter((t) => t.name)
      .map((t) => ({ name: t.name as string, tableType: tableTypeOf(t.table_type) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Find the tables and views of one catalog whose names fit two patterns.
   *
   * Databricks can answer with a page that has no tables but has a
   * `next_page_token`. The function thus reads pages until it has more
   * tables than `limit`, until no page is left, or until it read 20 pages.
   *
   * @example
   * // GET /api/2.1/unity-catalog/table-summaries?catalog_name=main&table_name_pattern=%25ord%25&max_results=201
   * //   answer: { tables: [{ full_name: 'main.shop.orders', table_type: 'MANAGED' }], next_page_token: '...' }
   * await client.findTables('main', undefined, '%ord%', 200)
   * // { tables: [{ table: { catalog: 'main', schema: 'shop', name: 'orders' }, tableType: 'table' }], more: false }
   */
  async findTables(catalog: string, schemaPattern: string | undefined, tablePattern: string | undefined, limit: number, signal?: AbortSignal): Promise<FoundTables> {
    const tables: FoundTable[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 20 && tables.length <= limit; page++) {
      const query = { catalog_name: catalog, schema_name_pattern: schemaPattern, table_name_pattern: tablePattern, max_results: Math.min(limit + 1, 10_000), page_token: pageToken };
      const answer = (await this.http('GET', '/api/2.1/unity-catalog/table-summaries', query, signal)) as { tables?: { full_name?: string; table_type?: string }[]; next_page_token?: string };
      for (const entry of answer.tables ?? []) {
        const table = parseTableName(entry.full_name ?? '');
        if (table) tables.push({ table, tableType: tableTypeOf(entry.table_type) });
      }
      pageToken = answer.next_page_token || undefined;
      if (!pageToken) break;
    }
    return { tables: tables.slice(0, limit), more: tables.length > limit || pageToken !== undefined };
  }

  /**
   * Get the columns and the type of a table.
   *
   * The function sorts the columns by their `position` in the table. A
   * column that has a `partition_index` is a partition column. `updated_at`
   * is a time in milliseconds after 1970-01-01.
   *
   * @example
   * // GET /api/2.1/unity-catalog/tables/main.shop.orders
   * //   answer: {
   * //     table_type: 'MANAGED', data_source_format: 'DELTA', updated_at: 1767225600000,
   * //     columns: [
   * //       { name: 'order_date', type_text: 'date', position: 0, partition_index: 0 },
   * //       { name: 'amount', type_text: 'decimal(10,2)', position: 1, comment: 'In EUR' },
   * //     ],
   * //   }
   * await client.getTable({ catalog: 'main', schema: 'shop', name: 'orders' })
   * // {
   * //   columns: [
   * //     { name: 'order_date', typeText: 'date', partition: true },
   * //     { name: 'amount', typeText: 'decimal(10,2)', comment: 'In EUR' },
   * //   ],
   * //   tableType: 'table', format: 'delta', updatedAt: '2026-01-01T00:00:00.000Z',
   * // }
   *
   * @throws {HttpError}  With status 404 if the table does not exist.
   */
  async getTable(table: TableName): Promise<TableInfo> {
    // The API takes the full name with dots between the three parts, without backticks.
    const fullName = encodeURIComponent(`${table.catalog}.${table.schema}.${table.name}`);
    const raw = (await this.http('GET', `/api/2.1/unity-catalog/tables/${fullName}`)) as {
      columns?: { name?: string; type_text?: string; comment?: string; partition_index?: number; position?: number }[];
      table_type?: string;
      data_source_format?: string;
      updated_at?: number;
    };
    const columns: ColumnInfo[] = [...(raw.columns ?? [])]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((c) => ({
        name: c.name ?? '',
        typeText: c.type_text ?? 'unknown',
        ...(c.comment ? { comment: c.comment } : {}),
        ...(typeof c.partition_index === 'number' ? { partition: true } : {}),
      }));
    return {
      columns,
      tableType: tableTypeOf(raw.table_type),
      format: raw.data_source_format ? raw.data_source_format.toLowerCase() : undefined,
      updatedAt: typeof raw.updated_at === 'number' ? new Date(raw.updated_at).toISOString() : undefined,
    };
  }
}

/**
 * The client for the Demo profile: one catalog, one schema and the demo tables. It has no warehouses and no clusters.
 *
 * It sends no request. It reads the demo tables from demo/data.ts.
 *
 * @example
 * const client = new DemoWorkspaceClient();
 * await client.listCatalogs()                // ['demo']
 * await client.listSchemas('demo')           // ['shop']
 * await client.listTables('demo', 'shop')    // [{ name: 'orders_2025', tableType: 'table' }, { name: 'orders_2026', tableType: 'table' }]
 */
export class DemoWorkspaceClient implements WorkspaceClient {
  /** Return an empty list: the Demo profile has no warehouses. */
  async listWarehouses(): Promise<Warehouse[]> {
    return [];
  }
  /** Always throw an HttpError with status 404: the Demo profile has no warehouses. */
  async getWarehouse(id: string): Promise<Warehouse> {
    throw new HttpError(`The Demo profile has no warehouse ${id}.`, 404);
  }
  /** Return an empty list: the Demo profile has no clusters. */
  async listClusters(): Promise<ClusterInfo[]> {
    return [];
  }
  /** Always throw an HttpError with status 404: the Demo profile has no clusters. */
  async getCluster(id: string): Promise<ClusterInfo> {
    throw new HttpError(`The Demo profile has no cluster ${id}.`, 404);
  }
  /** Always throw an HttpError with status 404: the Demo profile has no clusters. */
  async startCluster(id: string): Promise<void> {
    throw new HttpError(`The Demo profile has no cluster ${id}.`, 404);
  }
  /** Return the one catalog of the Demo profile: 'demo'. */
  async listCatalogs(): Promise<string[]> {
    return ['demo'];
  }
  /** Return ['shop'] for the catalog 'demo'. Return an empty list for all other catalogs. */
  async listSchemas(catalog: string): Promise<string[]> {
    return catalog === 'demo' ? ['shop'] : [];
  }
  /** List the demo tables of demo.shop. Return an empty list for all other schemas. */
  async listTables(catalog: string, schema: string): Promise<TableEntry[]> {
    return DEMO_TABLE_NAMES.filter((t) => t.catalog === catalog && t.schema === schema).map((t) => ({ name: t.name, tableType: 'table' as const }));
  }
  /** Find the demo tables of the catalog 'demo' whose names fit the two patterns. */
  async findTables(catalog: string, schemaPattern: string | undefined, tablePattern: string | undefined, limit: number): Promise<FoundTables> {
    const tables = DEMO_TABLE_NAMES.filter((t) => t.catalog === catalog && like(t.schema, schemaPattern) && like(t.name, tablePattern)).map((table) => ({ table, tableType: 'table' as const }));
    return { tables: tables.slice(0, limit), more: tables.length > limit };
  }

  /**
   * Get the columns of a demo table. Each demo table is a Delta table.
   *
   * @example
   * (await client.getTable({ catalog: 'demo', schema: 'shop', name: 'orders_2026' })).columns[4]
   * // { name: 'amount', typeText: 'decimal(10,2)' }
   *
   * @throws {HttpError}  With status 404 if no demo table has this name.
   */
  async getTable(table: TableName): Promise<TableInfo> {
    const demo = demoTable(table);
    if (!demo) throw new HttpError(`The demo table ${displayTableName(table)} does not exist.`, 404);
    return {
      columns: demo.columns.map((c) => ({ name: c.name, typeText: c.typeText, ...(c.partition ? { partition: true } : {}) })),
      tableType: 'table',
      format: 'delta',
      updatedAt: demo.lastModified,
    };
  }
}
