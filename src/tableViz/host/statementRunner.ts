/**
 * Run SQL on a SQL warehouse with the Statement Execution API.
 *
 * How one statement runs:
 *
 * 1. POST /api/2.0/sql/statements sends the statement. Databricks waits up
 *    to 10 seconds for the result. A fast statement is done in this one
 *    request.
 * 2. If the statement is not done, the runner asks for its state again and
 *    again with GET /api/2.0/sql/statements/{id}. The wait between two
 *    requests starts at 0.5 seconds and increases to 5 seconds.
 * 3. When the state is SUCCEEDED, the runner reads the rows.
 *
 * To stop a statement, the runner sends POST .../cancel and then asks for
 * the state until Databricks confirms that the statement stopped. If the
 * runner only stopped asking, the statement would continue and cost money.
 *
 * This file does not import `vscode`, so that a test can use it with a
 * local server.
 */
import { CancelledError, type CancelSignal } from '../core/profiler.ts';
import { QueryError, type QueryResult, type QueryRunner, type RunOptions } from '../core/runner.ts';
import type { Statement } from '../core/sql.ts';
import { HttpError, type Http } from './http.ts';

export interface StatementRunnerDeps {
  http: Http;
  /** The ID of the SQL warehouse. */
  warehouseId: string;
  /** The time limit of one statement, in seconds. The runner cancels a statement that runs longer. */
  timeoutSeconds: () => number;
  /** Tags that administrators see in the query history. Example: { feature: 'table-viz' }. */
  tags: Record<string, string>;
  /** Waits for a number of milliseconds. A test can make it faster. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns the time in milliseconds. A test can control it. */
  now?: () => number;
}

/** The part of an answer of the API that the runner reads. */
interface StatementResponse {
  statement_id?: string;
  status?: { state?: string; error?: { error_code?: string; message?: string }; sql_state?: string };
  manifest?: { schema?: { columns?: { name?: string; type_name?: string }[] } };
  result?: ChunkResponse;
}
interface ChunkResponse {
  data_array?: (string | null)[][];
  next_chunk_index?: number;
}

const BASE = '/api/2.0/sql/statements';
/** The states after which a statement does not change. */
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELED', 'CLOSED']);
/** How long the runner waits for Databricks to confirm a cancel, in milliseconds. */
const CANCEL_CONFIRM_MS = 30_000;

export class StatementExecutionRunner implements QueryRunner {
  private readonly deps: StatementRunnerDeps;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(deps: StatementRunnerDeps) {
    this.deps = deps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = deps.now ?? Date.now;
  }

  async run(statement: Statement, options: RunOptions = {}): Promise<QueryResult> {
    const { signal } = options;
    if (signal?.aborted) throw new CancelledError();
    const timeoutSeconds = this.deps.timeoutSeconds();
    const deadline = this.now() + timeoutSeconds * 1000;

    // Do not stop this request when the signal fires: without its answer, the runner has no statement ID to cancel.
    let response = await this.call('POST', BASE, {
      statement: statement.sql,
      warehouse_id: this.deps.warehouseId,
      parameters: statement.params.map((p) => ({ name: p.name, value: p.value, type: p.type })),
      wait_timeout: '10s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      query_tags: Object.entries(this.deps.tags).map(([key, value]) => ({ key, value })),
    });
    const id = response.statement_id;
    if (!id) throw new QueryError('Databricks accepted the statement but returned no statement ID.', { kind: 'http' });
    options.onStarted?.(id);

    for (let delay = 500; !TERMINAL.has(response.status?.state ?? ''); delay = Math.min(delay * 1.5, 5000)) {
      if (signal?.aborted) {
        await this.cancel(id);
        throw new CancelledError();
      }
      if (this.now() >= deadline) {
        await this.cancel(id);
        throw new QueryError(`The statement ran longer than ${timeoutSeconds} seconds.`, { kind: 'timeout', statementId: id });
      }
      await this.wait(Math.min(delay, Math.max(0, deadline - this.now())), signal);
      response = await this.call('GET', `${BASE}/${id}`);
    }

    const state = response.status?.state;
    if (state === 'SUCCEEDED') {
      // The caller can stop while the last request runs. Then the result is not wanted.
      if (signal?.aborted) throw new CancelledError();
      return this.collect(id, response);
    }
    if (state === 'FAILED') {
      const error = response.status?.error;
      throw new QueryError(error?.message ?? 'The statement failed.', {
        kind: 'failed',
        code: error?.error_code,
        sqlState: response.status?.sql_state,
        statementId: id,
      });
    }
    if (state === 'CANCELED') {
      if (signal?.aborted) throw new CancelledError();
      throw new QueryError('A person or a rule in Databricks cancelled the statement.', { kind: 'failed', statementId: id });
    }
    throw new QueryError('The result of the statement is not available now.', { kind: 'failed', statementId: id });
  }

  /** Read the columns and all rows of a statement that succeeded. A large result comes in more than one piece. */
  private async collect(id: string, response: StatementResponse): Promise<QueryResult> {
    const columns = (response.manifest?.schema?.columns ?? []).map((c) => ({ name: c.name ?? '', typeName: c.type_name ?? '' }));
    const rows: (string | null)[][] = [];
    let chunk = response.result;
    for (;;) {
      for (const row of chunk?.data_array ?? []) rows.push(row);
      if (chunk?.next_chunk_index === undefined || chunk.next_chunk_index === null) break;
      chunk = (await this.call('GET', `${BASE}/${id}/result/chunks/${chunk.next_chunk_index}`)) as ChunkResponse;
    }
    return { columns, rows, statementId: id };
  }

  /**
   * Tell Databricks to stop a statement, then wait until Databricks confirms it.
   *
   * The function does not throw. If Databricks does not confirm in 30
   * seconds, the function returns: the user must not wait longer for a
   * cancel than for the query.
   */
  private async cancel(id: string): Promise<void> {
    try {
      await this.call('POST', `${BASE}/${id}/cancel`, {});
      const end = this.now() + CANCEL_CONFIRM_MS;
      for (let delay = 200; this.now() < end; delay = Math.min(delay * 2, 2000)) {
        const response = await this.call('GET', `${BASE}/${id}`);
        if (TERMINAL.has(response.status?.state ?? '')) return;
        await this.sleep(delay);
      }
    } catch {
      // The statement is gone, or the workspace does not answer. There is nothing more to do.
    }
  }

  /** Wait, but return at once when the signal fires. */
  private wait(ms: number, signal: CancelSignal | undefined): Promise<void> {
    if (!signal) return this.sleep(ms);
    return Promise.race([this.sleep(ms), new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))]);
  }

  /** Send one request. Convert an HTTP error to a QueryError. */
  private async call(method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>): Promise<StatementResponse> {
    try {
      return (await this.deps.http(method, path, payload)) as StatementResponse;
    } catch (e) {
      if (e instanceof HttpError) throw new QueryError(e.message, { kind: 'http', status: e.status, code: e.code });
      throw e;
    }
  }
}
