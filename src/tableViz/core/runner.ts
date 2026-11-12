/**
 * The QueryRunner interface: run one SQL statement on Databricks and get the rows.
 *
 * The feature has one runner for SQL warehouses and one for clusters. Both
 * return rows in the same format, so the code above the runner does not know
 * which kind of compute ran the statement.
 */
import type { CancelSignal } from './profiler.ts';
import type { Statement } from './sql.ts';

/** One column of a result: its name and its Databricks type, for example 'LONG' or 'STRING'. */
export interface QueryColumn {
  name: string;
  typeName: string;
}

/**
 * The rows of one statement, in the one format that all runners return.
 *
 * Each value is text, or null for a SQL NULL. Text keeps all digits of a
 * 64-bit integer and of a decimal, which a JavaScript number cannot hold.
 *
 * @example
 * // SELECT count(*) AS n, min(amount) AS lo FROM ...
 * { columns: [{ name: 'n', typeName: 'LONG' }, { name: 'lo', typeName: 'DECIMAL' }], rows: [['110000', '2.33']] }
 */
export interface QueryResult {
  columns: QueryColumn[];
  rows: (string | null)[][];
  /** The ID of the statement on Databricks, for the log and for query history. */
  statementId?: string;
}

/** What a caller can ask of one `run()` call: to stop it, and to report the ID of the statement. */
export interface RunOptions {
  /** When this signal fires, the runner cancels the statement on Databricks and throws a CancelledError. */
  signal?: CancelSignal;
  /** The runner calls this function when Databricks accepts the statement. */
  onStarted?: (statementId: string) => void;
}

/**
 * Runs SQL statements on one kind of Databricks compute.
 *
 * @example
 * const result = await runner.run({
 *   sql: 'SELECT count(*) AS `n` FROM IDENTIFIER(:tbl)',
 *   params: [{ name: 'tbl', value: '`main`.`shop`.`orders`', type: 'STRING' }],
 * });
 * // { columns: [{ name: 'n', typeName: 'LONG' }], rows: [['110000']], statementId: '01f0...' }
 */
export interface QueryRunner {
  /**
   * Run one statement and return all its rows.
   *
   * @throws {QueryError}  If the statement fails, runs too long, or Databricks refuses the request.
   * @throws {CancelledError}  If `options.signal` stops the statement.
   */
  run(statement: Statement, options?: RunOptions): Promise<QueryResult>;
}

/**
 * A statement that did not give a result.
 *
 * `kind` tells what went wrong:
 *
 * - 'failed': Databricks ran the statement and reported an error.
 * - 'timeout': the statement ran longer than the time limit, and the runner cancelled it.
 * - 'http': Databricks refused a request, for example with HTTP 403 or 404.
 *
 * `message` is the error text from Databricks. toProfilerError() in
 * errors.ts makes a message for the user from this error.
 *
 * @example
 * throw new QueryError('[TABLE_OR_VIEW_NOT_FOUND] The table or view `main`.`shop`.`orders` cannot be found.', {
 *   kind: 'failed',
 *   code: 'TABLE_OR_VIEW_NOT_FOUND',
 *   sqlState: '42P01',
 * });
 */
export class QueryError extends Error {
  readonly kind: 'failed' | 'timeout' | 'http';
  /** The HTTP status code, for kind 'http'. */
  readonly status?: number;
  /** The error code from Databricks. Example: 'TABLE_OR_VIEW_NOT_FOUND'. */
  readonly code?: string;
  /** The SQLSTATE from Databricks. Example: '42P01'. */
  readonly sqlState?: string;
  /** The ID of the statement on Databricks. Not set if Databricks did not accept the statement. */
  readonly statementId?: string;

  constructor(message: string, details: { kind: QueryError['kind']; status?: number; code?: string; sqlState?: string; statementId?: string }) {
    super(message);
    this.name = 'QueryError';
    this.kind = details.kind;
    this.status = details.status;
    this.code = details.code;
    this.sqlState = details.sqlState;
    this.statementId = details.statementId;
  }
}
