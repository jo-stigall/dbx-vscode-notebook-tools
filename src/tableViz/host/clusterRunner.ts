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

/** The parts of the module `@databricks/sql` that the runner uses. */
export interface DriverModule {
  DBSQLClient: new (options?: { logger?: { log(level: string, message: string): void } }) => DriverClient;
  DBSQLParameter: new (options: { type?: string; value: string }) => unknown;
}
export interface DriverClient {
  connect(options: Record<string, unknown>): Promise<unknown>;
  openSession(request?: { queryTags?: Record<string, string> }): Promise<DriverSession>;
  close(): Promise<unknown>;
}
export interface DriverSession {
  executeStatement(sql: string, options: Record<string, unknown>): Promise<DriverOperation>;
  close(): Promise<unknown>;
}
export interface DriverOperation {
  readonly id?: string;
  fetchAll(): Promise<object[]>;
  getSchema(): Promise<{ columns?: { columnName?: string }[] } | null>;
  cancel(): Promise<unknown>;
  close(): Promise<unknown>;
}

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

/** The driver names of the parameter types of sql.ts. */
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

/** Tell if an error shows that the token or the session is not valid any more. A new connection can fix these. */
function needsReconnect(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /invalid ?session|session.{0,40}(closed|expired|not found|does not exist|invalid)|invalid access token|token.{0,20}expired|\b40[13]\b|unauthorized|unauthenticated|ECONNRESET|socket hang up/i.test(text);
}

interface Connected {
  client: DriverClient;
  session: DriverSession;
  driver: DriverModule;
}

export class ClusterRunner implements QueryRunner {
  private readonly deps: ClusterRunnerDeps;
  private connected: Promise<Connected> | undefined;
  private closed = false;

  constructor(deps: ClusterRunnerDeps) {
    this.deps = deps;
  }

  /** Connect to the cluster and open a session. */
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

  /** Get the open session. Connect first if there is none, or if `fresh` is true. */
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

  /** Run the statement one time. */
  private async attempt(statement: Statement, options: RunOptions, fresh: boolean): Promise<QueryResult> {
    const { signal } = options;
    const { session, driver } = await this.session(fresh);
    if (signal?.aborted) throw new CancelledError();

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
   * contains "SQLSTATE: 42P01". The function reads the two.
   */
  private convert(error: unknown): unknown {
    if (error instanceof CancelledError || error instanceof QueryError) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = /\b(401|403)\b/.exec(message)?.[1];
    return new QueryError(message, {
      kind: status ? 'http' : 'failed',
      status: status ? Number(status) : undefined,
      code: /\[([A-Z][A-Z0-9_.]+)\]/.exec(message)?.[1],
      sqlState: /SQLSTATE:? ?([0-9A-Z]{5})/.exec(message)?.[1],
    });
  }
}
