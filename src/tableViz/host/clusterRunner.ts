/**
 * Run SQL on an all-purpose cluster with the Databricks SQL Driver for Node.js.
 *
 * The runner opens one connection and one session, and uses them for all
 * statements. If the token expires or the session ends, it connects again
 * with a new token and tries the statement one more time.
 *
 * The runner turns three driver features off, because the feature must
 * talk to the workspace only and must send no usage data:
 *
 * - telemetry (`telemetryEnabled: false`)
 * - downloads of results from cloud storage (`useCloudFetch: false`)
 * - the native "kernel" path (the runner never sets `useKernel`)
 *
 * This file does not import `vscode` or the driver. The caller gives the
 * driver to the runner, so that a test can give a fake driver.
 */
import { CancelledError } from '../core/profiler.ts';
import { QueryError, type QueryResult, type QueryRunner, type RunOptions } from '../core/runner.ts';
import type { SqlParam, Statement } from '../core/sql.ts';

/**
 * The parts of the module `@databricks/sql` that the runner uses.
 *
 * The real module is dist/tableViz/driver.js (see driver.ts). A test gives
 * a fake module with the same two classes.
 */
export interface DriverModule {
  /** Makes a client. The runner gives it a logger, so that the messages of the driver go to the log of the extension. */
  DBSQLClient: new (options?: { logger?: { log(level: string, message: string): void } }) => DriverClient;
  /** Makes one named parameter of a statement. `type` is a name from PARAMETER_TYPES. */
  DBSQLParameter: new (options: { type?: string; value: string }) => unknown;
}

/** The part of a client of the driver that the runner uses. One client is one connection to the cluster. */
export interface DriverClient {
  /** Connects to the cluster. The options hold the server name, the HTTP path and the token. */
  connect(options: Record<string, unknown>): Promise<unknown>;
  /** Opens a session on the cluster. `queryTags` are the tags that administrators see in the query history. */
  openSession(request?: { queryTags?: Record<string, string> }): Promise<DriverSession>;
  close(): Promise<unknown>;
}

/** The part of a session of the driver that the runner uses. All statements of one runner go through one session. */
export interface DriverSession {
  /** Sends a statement to the cluster. It returns before the statement is done. */
  executeStatement(sql: string, options: Record<string, unknown>): Promise<DriverOperation>;
  close(): Promise<unknown>;
}

/** One statement that the cluster runs, or ran. */
export interface DriverOperation {
  /** The ID of the statement on Databricks. */
  readonly id?: string;
  /** Waits until the statement is done and returns all rows. Each row is an object: column name -> value. */
  fetchAll(): Promise<object[]>;
  /** Returns the columns of the result. The runner reads the `columnName` of each. */
  getSchema(): Promise<{ columns?: { columnName?: string }[] } | null>;
  /** Tells the cluster to stop the statement. */
  cancel(): Promise<unknown>;
  /** Tells the cluster that the runner does not need the statement any more. */
  close(): Promise<unknown>;
}

/** What a ClusterRunner needs from the code that makes it. */
export interface ClusterRunnerDeps {
  /** Loads the driver. The runner calls it for the first statement, not before. */
  loadDriver: () => DriverModule | Promise<DriverModule>;
  /** Returns the workspace URL. */
  host: () => string;
  /** Returns the HTTP path of the cluster. Example: 'sql/protocolv1/o/1234567890123456/0101-123456-abcdefgh'. */
  httpPath: () => string | Promise<string>;
  /** Returns the login token. `fresh` is true after Databricks refused the last token. */
  token: (fresh: boolean) => Promise<string>;
  /** The time limit of one statement, in seconds. */
  timeoutSeconds: () => number;
  /** Tags that administrators see in the query history. */
  tags: Record<string, string>;
  /** Gets the messages of the driver. They contain no token and no result values. */
  log?: (message: string) => void;
}

/** The name that the driver uses for each parameter type of sql.ts. Only INT is different: the driver calls it INTEGER. */
const PARAMETER_TYPES: Record<SqlParam['type'], string> = { STRING: 'STRING', INT: 'INTEGER', DOUBLE: 'DOUBLE' };

/**
 * Write a value from the driver in the one format of QueryResult: text, or null.
 *
 * A warehouse returns each value as text. The driver returns JavaScript
 * values. After this function, the two are equal.
 *
 * @example
 * normalizeValue(110000n)          // '110000'
 * normalizeValue(63.0015)          // '63.0015'
 * normalizeValue(true)             // 'true'
 * normalizeValue(['order_date'])   // '["order_date"]'
 * normalizeValue(null)             // null
 */
export function normalizeValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * Tell if an error shows that the token or the session is not valid any more. A new connection can fix these.
 *
 * The function reads the text of the error, because the driver has no code for these errors.
 *
 * @example
 * needsReconnect(new Error('Invalid SessionHandle: SessionHandle [abc]'))   // true
 * needsReconnect(new Error('Response code 401'))                            // true
 * needsReconnect(new Error('read ECONNRESET'))                              // true
 * needsReconnect(new Error('[TABLE_OR_VIEW_NOT_FOUND] The table or view `main`.`shop`.`orderz` cannot be found.'))   // false
 * needsReconnect(new Error("[CAST_INVALID_INPUT] The value '403' cannot be cast to INT. SQLSTATE: 22018"))            // false: 403 is a value, not a status
 */
function needsReconnect(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  if (/invalid ?session|session.{0,40}(closed|expired|not found|does not exist|invalid)|invalid access token|token.{0,20}expired|unauthorized|unauthenticated|ECONNRESET|socket hang up/i.test(text)) return true;
  return httpStatusOf(text) !== undefined;
}

/**
 * Find the HTTP status 401 or 403 in the text of a driver error.
 *
 * The text of a SQL error can contain the same numbers, as a value of the
 * table or as a position in the statement. A SQL error has a code between
 * brackets or a SQLSTATE. The function finds no status in such a text.
 *
 * @example
 * httpStatusOf('Error during request to server: Invalid access token. (HTTP 401)')          // 401
 * httpStatusOf("[CAST_INVALID_INPUT] The value '403' cannot be cast to INT. SQLSTATE: 22018")   // undefined
 */
function httpStatusOf(text: string): number | undefined {
  if (/\[[A-Z][A-Z0-9_.]+\]|SQLSTATE/.test(text)) return undefined;
  const status = /\b(401|403)\b/.exec(text)?.[1];
  return status ? Number(status) : undefined;
}

/** One open connection to the cluster: the client, its session, and the driver module that made them. */
interface Connected {
  client: DriverClient;
  session: DriverSession;
  driver: DriverModule;
}

/**
 * The QueryRunner for an all-purpose cluster.
 *
 * The runner connects when the first statement runs, not when you make it.
 * In each result, the `typeName` of each column is empty: the runner reads
 * only the names of the columns from the driver.
 *
 * @example
 * const runner = new ClusterRunner({
 *   loadDriver: () => require('./driver.js'),
 *   host: () => 'https://adb-1234567890123456.7.azuredatabricks.net',
 *   httpPath: () => 'sql/protocolv1/o/1234567890123456/0101-123456-abcdefgh',
 *   token: async () => 'dapi...',
 *   timeoutSeconds: () => 300,
 *   tags: { feature: 'table-viz' },
 * });
 * await runner.run({ sql: 'SELECT count(*) AS n FROM IDENTIFIER(:tbl)', params: [{ name: 'tbl', value: 'main.shop.orders', type: 'STRING' }] })
 * // { columns: [{ name: 'n', typeName: '' }], rows: [['110000']], statementId: '01f0b2c3-...' }
 * await runner.close();
 */
export class ClusterRunner implements QueryRunner {
  private readonly deps: ClusterRunnerDeps;
  /** The connection, or the connection that the runner opens now. Not set before the first statement and after close(). */
  private connected: Promise<Connected> | undefined;
  /** true after close(). The runner then runs no statement and does not connect again. */
  private closed = false;

  constructor(deps: ClusterRunnerDeps) {
    this.deps = deps;
  }

  /**
   * Connect to the cluster and open a session.
   *
   * If the connection or the session fails, the function closes the client
   * and throws the error of the driver.
   *
   * @param fresh  true: ask for a new token, because Databricks refused the last one.
   */
  private async connect(fresh: boolean): Promise<Connected> {
    const driver = await this.deps.loadDriver();
    const client = new driver.DBSQLClient({ logger: { log: (_level, message) => this.deps.log?.(message) } });
    try {
      await client.connect({
        // The driver wants the name of the server without "https://".
        host: this.deps.host().replace(/^https?:\/\//, '').replace(/\/+$/, ''),
        path: await this.deps.httpPath(),
        token: await this.deps.token(fresh),
        userAgentEntry: 'dbx-notebook-table-viz',
        // Keep all digits of DECIMAL and BIGINT values.
        preserveBigNumericPrecision: true,
        // The feature sends no usage data.
        telemetryEnabled: false,
      });
      const session = await client.openSession({ queryTags: this.deps.tags });
      return { client, session, driver };
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
  }

  /**
   * Get the open session. Connect first if there is none, or if `fresh` is true.
   *
   * Statements that start at the same time share one connection: the
   * function stores the promise, not the result. If `fresh` is true, the
   * function closes the old connection before it opens the new one.
   */
  private session(fresh = false): Promise<Connected> {
    if (fresh || !this.connected) {
      const old = this.connected;
      const next = (async () => {
        if (old) await old.then((c) => this.shut(c), () => {});
        return this.connect(fresh);
      })();
      this.connected = next;
      // If the connection fails, forget it, so that the next statement tries again.
      next.catch(() => {
        if (this.connected === next) this.connected = undefined;
      });
    }
    return this.connected;
  }

  /** Close the session and the client of one connection. The function ignores errors, because the connection can be broken already. */
  private async shut(connected: Connected): Promise<void> {
    await connected.session.close().catch(() => {});
    await connected.client.close().catch(() => {});
  }

  /**
   * Close the session and the connection, for good.
   *
   * The session of the extension calls this function when the user selects
   * different compute. A statement that still waits for this runner then
   * stops as "cancelled". It must not connect to the old cluster again.
   */
  async close(): Promise<void> {
    this.closed = true;
    const connected = this.connected;
    this.connected = undefined;
    if (connected) await connected.then((c) => this.shut(c), () => {});
  }

  /**
   * Run one statement and return all its rows.
   *
   * If the error shows that the token or the session is not valid, the
   * runner connects again with a new token and tries the statement one more
   * time. It does not try again after a cancel, a timeout or a SQL error.
   *
   * @example
   * await runner.run({ sql: 'SELECT min(amount) AS lo, count(*) AS n FROM IDENTIFIER(:tbl)', params: [{ name: 'tbl', value: 'main.shop.orders', type: 'STRING' }] })
   * // { columns: [{ name: 'lo', typeName: '' }, { name: 'n', typeName: '' }], rows: [['2.33', '110000']], statementId: '01f0b2c3-...' }
   *
   * @throws {CancelledError}  If `options.signal` stops the statement, or after close().
   * @throws {QueryError}  If the statement fails or runs longer than the time limit.
   */
  async run(statement: Statement, options: RunOptions = {}): Promise<QueryResult> {
    if (options.signal?.aborted || this.closed) throw new CancelledError();
    try {
      return await this.attempt(statement, options, false);
    } catch (e) {
      if (this.closed) throw new CancelledError();
      if (e instanceof CancelledError || (e instanceof QueryError && e.kind === 'timeout') || options.signal?.aborted || !needsReconnect(e)) throw this.convert(e);
      this.deps.log?.('The connection to the cluster is not valid. Connecting again with a new token.');
      try {
        return await this.attempt(statement, options, true);
      } catch (again) {
        throw this.convert(again);
      }
    }
  }

  /**
   * Run the statement one time.
   *
   * The function sends the values as named parameters, not in the SQL text.
   * It tells the cluster to cancel the statement when the signal fires or
   * when the time limit ends. It writes each value of the result as text
   * (see normalizeValue).
   *
   * @param fresh  true: connect again with a new token before the statement.
   */
  private async attempt(statement: Statement, options: RunOptions, fresh: boolean): Promise<QueryResult> {
    const { signal } = options;
    const { session, driver } = await this.session(fresh);
    // The user can cancel, or select different compute, while the runner connects. Then do not send the statement.
    if (signal?.aborted || this.closed) throw new CancelledError();

    const timeoutSeconds = this.deps.timeoutSeconds();
    const namedParameters: Record<string, unknown> = {};
    for (const p of statement.params) namedParameters[p.name] = new driver.DBSQLParameter({ type: PARAMETER_TYPES[p.type], value: p.value });
    const operation = await session.executeStatement(statement.sql, {
      runAsync: true,
      namedParameters,
      // Results are small. Read them from the cluster, not from cloud storage.
      useCloudFetch: false,
      useLZ4Compression: false,
    });

    let stopped: 'cancel' | 'timeout' | undefined;
    const stop = (why: 'cancel' | 'timeout') => {
      if (stopped) return;
      stopped = why;
      void operation.cancel().catch(() => {});
    };
    const onAbort = () => stop('cancel');
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
    try {
      if (signal?.aborted) stop('cancel');
      if (operation.id) options.onStarted?.(operation.id);
      const [rows, schema] = await Promise.all([operation.fetchAll(), operation.getSchema()]);
      if (stopped) throw new Error('stopped');
      // The names of the columns come from the schema. A result with rows also has them as the keys of each row.
      const names = schema?.columns?.map((c) => c.columnName ?? '') ?? Object.keys(rows[0] ?? {});
      return {
        columns: names.map((name) => ({ name, typeName: '' })),
        rows: rows.map((row) => names.map((name) => normalizeValue((row as Record<string, unknown>)[name]))),
        statementId: operation.id,
      };
    } catch (e) {
      if (stopped === 'cancel') throw new CancelledError();
      if (stopped === 'timeout') throw new QueryError(`The statement ran longer than ${timeoutSeconds} seconds.`, { kind: 'timeout', statementId: operation.id });
      throw e;
    } finally {
      clearTimeout(timer);
      await operation.close().catch(() => {});
    }
  }

  /**
   * Convert an error of the driver to a QueryError.
   *
   * The text of a Databricks error starts with its code between brackets and
   * contains "SQLSTATE: 42P01". The function reads the two. If the text
   * has no code and no SQLSTATE and contains 401 or 403, the error gets the
   * kind 'http' and that status. See httpStatusOf().
   *
   * @example
   * // The driver throws: Error('[TABLE_OR_VIEW_NOT_FOUND] The table or view `main`.`shop`.`orderz` cannot be found. SQLSTATE: 42P01')
   * // convert() returns: QueryError { kind: 'failed', code: 'TABLE_OR_VIEW_NOT_FOUND', sqlState: '42P01' }
   *
   * @returns A QueryError. A CancelledError or a QueryError comes back as it is.
   */
  private convert(error: unknown): unknown {
    if (error instanceof CancelledError || error instanceof QueryError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = httpStatusOf(message);
    return new QueryError(message, {
      kind: status ? 'http' : 'failed',
      status,
      code: /\[([A-Z][A-Z0-9_.]+)\]/.exec(message)?.[1],
      sqlState: /SQLSTATE:? ?([0-9A-Z]{5})/.exec(message)?.[1],
    });
  }
}
