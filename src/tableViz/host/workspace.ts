/**
 * The WorkspaceClient: list the SQL warehouses, catalogs, schemas and tables of a workspace.
 *
 * All functions use the REST API. None runs SQL, so that browsing never
 * starts a stopped warehouse.
 *
 * This file does not import `vscode`, so that a test can use it with a
 * local server.
 */
import type { ClusterInfo } from '../core/clusters.ts';
import { displayTableName } from '../core/names.ts';
import type { ColumnInfo, TableName } from '../core/schema.ts';
import { DEMO_TABLE_NAMES, demoTable } from '../demo/data.ts';
import { HttpError, type Http } from './http.ts';
import type { TableInfo } from './sqlProfiler.ts';

/** A SQL warehouse. */
export interface Warehouse {
  id: string;
  name: string;
  /** RUNNING, STOPPED, STARTING, STOPPING, DELETED or DELETING. */
  state: string;
  /** The size, for example 'Small'. */
  size?: string;
}

/** A table or view in a schema. */
export interface TableEntry {
  name: string;
  tableType: 'table' | 'view';
}

export interface WorkspaceClient {
  listWarehouses(): Promise<Warehouse[]>;
  getWarehouse(id: string): Promise<Warehouse>;
  /** List the all-purpose clusters. The list does not contain the clusters of jobs and pipelines. */
  listClusters(): Promise<ClusterInfo[]>;
  getCluster(id: string): Promise<ClusterInfo>;
  /** Tell Databricks to start a stopped cluster. The function returns before the cluster runs. */
  startCluster(id: string): Promise<void>;
  listCatalogs(): Promise<string[]>;
  listSchemas(catalog: string): Promise<string[]>;
  listTables(catalog: string, schema: string): Promise<TableEntry[]>;
  /** Get the columns and the type of a table. Throws an HttpError with status 404 if the table does not exist. */
  getTable(table: TableName): Promise<TableInfo>;
}

/** The largest number of pages that one list reads. One page of tables has 50 entries. */
const MAX_PAGES = 200;

const VIEW_TYPES = new Set(['VIEW', 'MATERIALIZED_VIEW', 'METRIC_VIEW']);
const tableTypeOf = (type: unknown): 'table' | 'view' => (VIEW_TYPES.has(String(type)) ? 'view' : 'table');

/** The client for a real workspace. */
export class RestWorkspaceClient implements WorkspaceClient {
  private readonly http: Http;

  constructor(http: Http) {
    this.http = http;
  }

  /**
   * Read all pages of a list.
   *
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

  private static warehouse(raw: Record<string, unknown>): Warehouse {
    return { id: String(raw.id ?? ''), name: String(raw.name ?? raw.id ?? ''), state: String(raw.state ?? 'UNKNOWN'), size: raw.cluster_size ? String(raw.cluster_size) : undefined };
  }

  async listWarehouses(): Promise<Warehouse[]> {
    const answer = (await this.http('GET', '/api/2.0/sql/warehouses')) as { warehouses?: Record<string, unknown>[] };
    return (answer.warehouses ?? []).map(RestWorkspaceClient.warehouse).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getWarehouse(id: string): Promise<Warehouse> {
    return RestWorkspaceClient.warehouse((await this.http('GET', `/api/2.0/sql/warehouses/${encodeURIComponent(id)}`)) as Record<string, unknown>);
  }

  private static cluster(raw: Record<string, unknown>): ClusterInfo {
    return {
      id: String(raw.cluster_id ?? ''),
      name: String(raw.cluster_name ?? raw.cluster_id ?? ''),
      state: String(raw.state ?? 'UNKNOWN'),
      sparkVersion: raw.spark_version ? String(raw.spark_version) : undefined,
      accessMode: raw.data_security_mode ? String(raw.data_security_mode) : undefined,
    };
  }

  async listClusters(): Promise<ClusterInfo[]> {
    const clusters = await this.pages<Record<string, unknown>>('/api/2.1/clusters/list', { page_size: 100 }, 'clusters');
    return clusters
      // A person makes an all-purpose cluster in the UI or with the API. Jobs and pipelines make the other clusters.
      .filter((c) => c.cluster_source === undefined || c.cluster_source === 'UI' || c.cluster_source === 'API')
      .map(RestWorkspaceClient.cluster)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getCluster(id: string): Promise<ClusterInfo> {
    return RestWorkspaceClient.cluster((await this.http('GET', '/api/2.1/clusters/get', { cluster_id: id })) as Record<string, unknown>);
  }

  async startCluster(id: string): Promise<void> {
    await this.http('POST', '/api/2.1/clusters/start', { cluster_id: id });
  }

  async listCatalogs(): Promise<string[]> {
    const catalogs = await this.pages<{ name?: string }>('/api/2.1/unity-catalog/catalogs', {}, 'catalogs');
    return catalogs.map((c) => c.name ?? '').filter(Boolean).sort();
  }

  async listSchemas(catalog: string): Promise<string[]> {
    const schemas = await this.pages<{ name?: string }>('/api/2.1/unity-catalog/schemas', { catalog_name: catalog }, 'schemas');
    return schemas.map((s) => s.name ?? '').filter(Boolean).sort();
  }

  async listTables(catalog: string, schema: string): Promise<TableEntry[]> {
    const query = { catalog_name: catalog, schema_name: schema, max_results: 50, omit_columns: true, omit_properties: true };
    const tables = await this.pages<{ name?: string; table_type?: string }>('/api/2.1/unity-catalog/tables', query, 'tables');
    return tables
      .filter((t) => t.name)
      .map((t) => ({ name: t.name as string, tableType: tableTypeOf(t.table_type) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

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

/** The client for the Demo profile: one catalog, one schema and the demo tables. It has no warehouses. */
export class DemoWorkspaceClient implements WorkspaceClient {
  async listWarehouses(): Promise<Warehouse[]> {
    return [];
  }
  async getWarehouse(id: string): Promise<Warehouse> {
    throw new HttpError(`The Demo profile has no warehouse ${id}.`, 404);
  }
  async listClusters(): Promise<ClusterInfo[]> {
    return [];
  }
  async getCluster(id: string): Promise<ClusterInfo> {
    throw new HttpError(`The Demo profile has no cluster ${id}.`, 404);
  }
  async startCluster(id: string): Promise<void> {
    throw new HttpError(`The Demo profile has no cluster ${id}.`, 404);
  }
  async listCatalogs(): Promise<string[]> {
    return ['demo'];
  }
  async listSchemas(catalog: string): Promise<string[]> {
    return catalog === 'demo' ? ['shop'] : [];
  }
  async listTables(catalog: string, schema: string): Promise<TableEntry[]> {
    return DEMO_TABLE_NAMES.filter((t) => t.catalog === catalog && t.schema === schema).map((t) => ({ name: t.name, tableType: 'table' as const }));
  }
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
