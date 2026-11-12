/**
 * The SQL profiler: it answers requests with queries on Databricks.
 *
 * For each request it does three steps: sql.ts builds the statement, a
 * QueryRunner runs it, and parse.ts converts the rows to the result.
 *
 * The columns of a table come from the Unity Catalog REST API, not from
 * SQL, so that reading the columns never starts a warehouse.
 *
 * This file does not import `vscode`, so that a test can use it with a fake
 * runner.
 */
import { toProfilerError, type ErrorContext } from '../core/errors.ts';
import type { Limiter } from '../core/limiter.ts';
import {
  parseDateCounts,
  parseDescribeDetail,
  parseDescribeHistory,
  parseDriftBins,
  parseFrequency,
  parseHistogram,
  parseNumericStats,
  parseOverview,
  parseQuantiles,
  parseValueCounts,
} from '../core/parse.ts';
import { CancelledError, type CancelSignal, type ProfileOptions, type Profiler } from '../core/profiler.ts';
import { QueryError, type QueryResult, type QueryRunner } from '../core/runner.ts';
import type { ColumnInfo, Request, RequestOf, Result, ResultOf, TableName } from '../core/schema.ts';
import { buildStatements, renderStatement, type BuildOptions, type Statement } from '../core/sql.ts';
import { HttpError } from './http.ts';

/**
 * What the Unity Catalog REST API tells about a table.
 *
 * @example
 * // {
 * //   columns: [{ name: 'order_date', typeText: 'date', partition: true }, { name: 'amount', typeText: 'decimal(10,2)' }],
 * //   tableType: 'table', format: 'delta', updatedAt: '2026-01-01T00:00:00.000Z',
 * // }
 */
export interface TableInfo {
  /** The columns, in the sequence of the table. */
  columns: ColumnInfo[];
  /** 'view' for a view, a materialized view and a metric view. */
  tableType: 'table' | 'view';
  /** The storage format, in lower case. Example: 'delta'. */
  format?: string;
  /** The time of the last change of the table definition. ISO 8601. */
  updatedAt?: string;
}

/** What a SqlProfiler needs from the code that makes it. In the extension, the session gives these values. */
export interface SqlProfilerDeps {
  /** Runs the statements: the runner for a SQL warehouse or the runner for a cluster. */
  runner: QueryRunner;
  /** Reads the columns and the type of a table from Unity Catalog. Throws an HttpError if the table does not exist. */
  getTable: (table: TableName, signal?: CancelSignal) => Promise<TableInfo>;
  /** Limits the number of statements that run at the same time. */
  limiter: Limiter;
  /**
   * Returns the facts that an error message needs: the time limit, the compute and the workspace URL.
   *
   * @example
   * // { timeoutSeconds: 300, compute: 'The warehouse "Starter Warehouse"', host: 'https://adb-123.azuredatabricks.net' }
   */
  describe: () => Pick<ErrorContext, 'timeoutSeconds' | 'compute' | 'host'>;
  /**
   * Runs before each statement. The host uses it to ask the user before a
   * stopped warehouse or cluster starts. It throws a ProfilerError if the
   * statement must not run.
   */
  beforeQuery?: (signal?: CancelSignal) => Promise<void>;
  /** How statements name tables and columns. See BuildOptions. */
  names?: BuildOptions['names'];
}

/**
 * The Profiler that runs SQL on Databricks.
 *
 * @example
 * const profiler = new SqlProfiler({
 *   runner,                                   // a StatementExecutionRunner or a ClusterRunner
 *   getTable: (table) => workspace.getTable(table),
 *   limiter: new Limiter(() => 4),
 *   describe: () => ({ timeoutSeconds: 300, compute: 'The warehouse "Starter Warehouse"', host: 'https://adb-123.azuredatabricks.net' }),
 * });
 */
export class SqlProfiler implements Profiler {
  private readonly deps: SqlProfilerDeps;

  constructor(deps: SqlProfilerDeps) {
    this.deps = deps;
  }

  /**
   * Answer one request with one statement on Databricks. "tableDetails" is different: see tableDetails().
   *
   * `approximate` in the result is true for "quantiles", and for "overview"
   * and "numericStats" if the request does not have `exact: true`.
   *
   * @example
   * const result = await profiler.profile({
   *   type: 'histogram',
   *   dataset: { profile: 'prod', table: { catalog: 'main', schema: 'shop', name: 'orders' } },
   *   columns: [{ name: 'amount', typeText: 'decimal(10,2)' }],
   *   edges: { lo: 0, hi: 200, bins: 4 },
   * });
   * // {
   * //   type: 'histogram', counts: [55974, 36907, 10988, 3608], below: 0, above: 2523,
   * //   sql: ['-- :c0 = ...\nSELECT ...'], approximate: false, asOf: '2026-11-12T09:30:00.000Z',
   * // }
   *
   * @throws {ProfilerError}  If a statement fails. The error has a plain message, a next step and the SQL.
   * @throws {CancelledError}  If `options.signal` stops the request.
   */
  async profile(request: Request, options: ProfileOptions = {}): Promise<Result> {
    const statements = buildStatements(request, { names: this.deps.names });
    const context: ErrorContext = { ...this.deps.describe(), table: request.dataset.table, sql: statements.map(renderStatement) };
    try {
      if (request.type === 'tableDetails') return await this.tableDetails(request, statements, options);

      const result = await this.run(statements[0] as Statement, options);
      const base = { sql: context.sql, asOf: new Date().toISOString() };
      switch (request.type) {
        case 'overview':
          return { ...base, approximate: !request.exact, ...parseOverview(request, result) };
        case 'numericStats':
          return { ...base, approximate: !request.exact, ...parseNumericStats(result) };
        case 'histogram':
          return { ...base, approximate: false, ...parseHistogram(request, result) };
        case 'frequency':
          return { ...base, approximate: false, ...parseFrequency(request, result) };
        case 'dateCounts':
          return { ...base, approximate: false, ...parseDateCounts(request, result) };
        case 'validateFilter':
          return { ...base, approximate: false, type: 'validateFilter' };
        case 'quantiles':
          return { ...base, approximate: true, ...parseQuantiles(request, result) };
        case 'driftBins':
          return { ...base, approximate: false, ...parseDriftBins(request, result) };
        case 'valueCounts':
          return { ...base, approximate: false, ...parseValueCounts(request, result) };
      }
    } catch (e) {
      if (e instanceof CancelledError || options.signal?.aborted) throw new CancelledError();
      throw toProfilerError(e, context);
    }
  }

  /**
   * Run one statement when the limiter has a free place.
   *
   * The function tells `options.onProgress` the state: 'queued' while the
   * statement waits for a place, then 'running', then 'running' with the ID
   * of the statement when Databricks accepts it.
   */
  private run(statement: Statement, options: ProfileOptions): Promise<QueryResult> {
    const { signal, onProgress } = options;
    return this.deps.limiter.run(
      async () => {
        await this.deps.beforeQuery?.(signal);
        if (signal?.aborted) throw new CancelledError();
        onProgress?.('running');
        return this.deps.runner.run(statement, { signal, onStarted: (id) => onProgress?.('running', id) });
      },
      signal,
      () => onProgress?.('queued')
    );
  }

  /**
   * Answer "tableDetails".
   *
   * 1. Read the columns and the type of the table from Unity Catalog. This needs no warehouse.
   * 2. For a Delta table, run `DESCRIBE DETAIL` (size, last change, partition columns)
   *    and `DESCRIBE HISTORY ... LIMIT 1` (the current version).
   *
   * If a DESCRIBE statement fails, the result has no value for those facts.
   * The board can show the columns without them.
   */
  private async tableDetails(request: RequestOf<'tableDetails'>, statements: Statement[], options: ProfileOptions): Promise<ResultOf<'tableDetails'>> {
    const { dataset } = request;
    let info: TableInfo;
    try {
      info = await this.deps.getTable(dataset.table, options.signal);
    } catch (e) {
      if (e instanceof HttpError) {
        // For a table, HTTP 404 means that the table does not exist, not that the warehouse does not exist.
        throw new QueryError(e.message, { kind: 'http', status: e.status === 404 ? undefined : e.status, code: e.status === 404 ? 'TABLE_OR_VIEW_NOT_FOUND' : e.code });
      }
      throw e;
    }

    const result: ResultOf<'tableDetails'> = {
      type: 'tableDetails',
      sql: [],
      approximate: false,
      asOf: new Date().toISOString(),
      columns: info.columns,
      tableType: info.tableType,
      format: info.format,
      lastModified: info.updatedAt,
      partitionColumns: info.columns.filter((c) => c.partition).map((c) => c.name),
    };
    if (dataset.version?.kind === 'version') result.version = dataset.version.n;
    if (info.tableType !== 'table' || info.format !== 'delta') return result;

    const [detail, history] = await Promise.allSettled(statements.map((s) => this.run(s, options)));
    if (options.signal?.aborted) throw new CancelledError();
    if (detail?.status === 'fulfilled' && detail.value.rows.length > 0) {
      const facts = parseDescribeDetail(detail.value);
      result.sizeBytes = facts.sizeBytes;
      result.lastModified = facts.lastModified ?? result.lastModified;
      if (facts.partitionColumns.length > 0) result.partitionColumns = facts.partitionColumns;
      result.sql.push(renderStatement(statements[0] as Statement));
    }
    if (history?.status === 'fulfilled') {
      // An explicit version of the dataset wins over the newest version.
      result.version ??= parseDescribeHistory(history.value);
      result.sql.push(renderStatement(statements[1] as Statement));
    }
    return result;
  }
}
