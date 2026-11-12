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
import { parseDateCounts, parseDescribeDetail, parseDescribeHistory, parseFrequency, parseHistogram, parseNumericStats, parseOverview } from '../core/parse.ts';
import { CancelledError, type CancelSignal, type ProfileOptions, type Profiler } from '../core/profiler.ts';
import { QueryError, type QueryResult, type QueryRunner } from '../core/runner.ts';
import type { ColumnInfo, Request, RequestOf, Result, ResultOf, TableName } from '../core/schema.ts';
import { buildStatements, renderStatement, type BuildOptions, type Statement } from '../core/sql.ts';
import { HttpError } from './http.ts';

/** What the Unity Catalog REST API tells about a table. */
export interface TableInfo {
  columns: ColumnInfo[];
  tableType: 'table' | 'view';
  /** The storage format, in lower case. Example: 'delta'. */
  format?: string;
  /** The time of the last change of the table definition. ISO 8601. */
  updatedAt?: string;
}

export interface SqlProfilerDeps {
  runner: QueryRunner;
  /** Reads the columns and the type of a table from Unity Catalog. Throws an HttpError if the table does not exist. */
  getTable: (table: TableName, signal?: CancelSignal) => Promise<TableInfo>;
  /** Limits the number of statements that run at the same time. */
  limiter: Limiter;
  /** The facts that an error message needs. */
  describe: () => Pick<ErrorContext, 'timeoutSeconds' | 'compute' | 'host'>;
  /**
   * Runs before each statement. The host uses it to ask the user before a
   * stopped warehouse starts. It throws a ProfilerError if the statement
   * must not run.
   */
  beforeQuery?: (signal?: CancelSignal) => Promise<void>;
  /** How statements name tables and columns. See BuildOptions. */
  names?: BuildOptions['names'];
}

export class SqlProfiler implements Profiler {
  private readonly deps: SqlProfilerDeps;

  constructor(deps: SqlProfilerDeps) {
    this.deps = deps;
  }

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
      }
    } catch (e) {
      if (e instanceof CancelledError || options.signal?.aborted) throw new CancelledError();
      throw toProfilerError(e, context);
    }
  }

  /** Run one statement when the limiter has a free place. */
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
