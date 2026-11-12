/**
 * The Profiler interface, and the function that connects a profiler to the messages of a board.
 *
 * A profiler answers requests about a dataset. The feature has two profilers:
 * the demo profiler computes the answers in memory, and the SQL profiler runs
 * queries on Databricks. The code above the profiler does not know which one
 * it uses.
 */
import { toHostSchema, type Request, type Result, type ToHost, type ToWebview } from './schema.ts';

/** Tells a profiler to stop. An AbortSignal has this shape. */
export interface CancelSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void): void;
}

/** What a caller can ask of one `profile()` call: to stop it, to report its progress, and to ignore the cache. */
export interface ProfileOptions {
  /** When this signal fires, the profiler stops the request and throws a CancelledError. */
  signal?: CancelSignal;
  /** The profiler calls this function when the state of the query changes. */
  onProgress?: (state: 'queued' | 'running', statementId?: string) => void;
  /** true: do not answer from the cache. Run the query again. */
  refresh?: boolean;
}

/**
 * Answers requests about datasets.
 *
 * @example
 * const result = await profiler.profile({
 *   type: 'frequency',
 *   dataset: { profile: 'DEFAULT', table: { catalog: 'main', schema: 'shop', name: 'orders' } },
 *   columns: [{ name: 'channel', typeText: 'string' }],
 *   top: 20,
 * });
 * // result.type is 'frequency'. result.values has the 20 most frequent values.
 */
export interface Profiler {
  /**
   * Answer one request.
   *
   * @returns A result with the same `type` as the request.
   * @throws {ProfilerError}  If the request fails.
   * @throws {CancelledError}  If `options.signal` stops the request.
   */
  profile(request: Request, options?: ProfileOptions): Promise<Result>;
}

/**
 * An error that the UI can show: a plain message, a next step, and the details.
 *
 * `message` tells what went wrong, in one sentence.
 *
 * @example
 * throw new ProfilerError('The table main.sales.orders does not exist.', {
 *   nextStep: 'Check the name of the table.',
 *   raw: '[TABLE_OR_VIEW_NOT_FOUND] ...',
 *   sql: ['SELECT count(*) FROM ...'],
 * });
 */
export class ProfilerError extends Error {
  /** What the user can do. Example: 'Check the name of the table.' */
  readonly nextStep?: string;
  /** The error text from Databricks. The same as `message` if the caller gives no text. */
  readonly raw: string;
  /** The SQL statements that failed. Empty if the caller gives none. */
  readonly sql: string[];

  constructor(message: string, details: { nextStep?: string; raw?: string; sql?: string[] } = {}) {
    super(message);
    this.name = 'ProfilerError';
    this.nextStep = details.nextStep;
    this.raw = details.raw ?? message;
    this.sql = details.sql ?? [];
  }
}

/** A profiler throws this error when the caller stops a request. */
export class CancelledError extends Error {
  constructor() {
    super('The request was cancelled.');
    this.name = 'CancelledError';
  }
}

/** One request from the webview and the final message that the host sent back for it. Tests and the log read this record. */
export interface Exchange {
  /** The `id` of the "request" message. */
  id: string;
  request: Request;
  /** The "result", "error" or "cancelled" message. Not set while the request runs. A "progress" message is not a response. */
  response?: ToWebview;
}

/** Handles the "request" and "cancel" messages of one board. createDispatcher() makes it. */
export interface Dispatcher {
  /** Handle one message from the webview. The function checks the message before it uses it. */
  handle(message: unknown): Promise<void>;
  /** Stop all requests that run. Call it when the board closes. */
  cancelAll(): void;
  /** The requests that the webview sent, oldest first. The list does not have a request that `blocked` refused. */
  readonly exchanges: Exchange[];
}

/**
 * Connect the messages of one board to a profiler.
 *
 * The dispatcher handles "request" and "cancel" messages. For each request it
 * sends back "progress", then one of "result", "error" or "cancelled".
 *
 * An error that is not a ProfilerError gets the message "The request
 * failed.", and `raw` has the text of the error.
 *
 * @example
 * const dispatcher = createDispatcher({
 *   profilerFor: () => new DemoProfiler(),
 *   post: (message) => panel.webview.postMessage(message),
 *   makeSignal: () => { const c = new AbortController(); return { signal: c.signal, cancel: () => c.abort() }; },
 * });
 * panel.webview.onDidReceiveMessage((m) => dispatcher.handle(m));
 *
 * @param deps.profilerFor  Returns the profiler for a profile name. It throws a ProfilerError if the feature cannot use the profile.
 * @param deps.post  Sends one message to the webview.
 * @param deps.makeSignal  Makes a cancel signal and the function that fires it.
 * @param deps.onOther  Handles the messages that are not "request" or "cancel", for example "ready" and "saveView".
 * @param deps.blocked  Returns a reason if requests must not run now. The dispatcher then answers each request with an "error" message that has this reason.
 */
export function createDispatcher(deps: {
  profilerFor: (profile: string) => Profiler;
  post: (message: ToWebview) => void;
  makeSignal: () => { signal: CancelSignal; cancel: () => void };
  onOther?: (message: Exclude<ToHost, { type: 'request' | 'cancel' }>) => void | Promise<void>;
  /** Returns a reason if requests must not run now, for example while a saved view waits for the permission of the user. */
  blocked?: () => string | undefined;
}): Dispatcher {
  // The function that stops each request that runs now. The key is the `id` of the request.
  const running = new Map<string, () => void>();
  const exchanges: Exchange[] = [];

  /** Check one message from the webview, then cancel a request, run a request, or give the message to `onOther`. */
  async function handle(raw: unknown): Promise<void> {
    const parsed = toHostSchema.safeParse(raw);
    if (!parsed.success) return; // Ignore a message that does not have a known shape.
    const message = parsed.data;

    if (message.type === 'cancel') {
      running.get(message.id)?.();
      return;
    }
    if (message.type !== 'request') {
      await deps.onOther?.(message);
      return;
    }

    const { id, request } = message;
    const reason = deps.blocked?.();
    if (reason) {
      deps.post({ type: 'error', id, message: reason, raw: reason, sql: [] });
      return;
    }
    const exchange: Exchange = { id, request };
    exchanges.push(exchange);
    const reply = (response: ToWebview) => {
      exchange.response = response;
      deps.post(response);
    };
    const { signal, cancel } = deps.makeSignal();
    running.set(id, cancel);
    try {
      const profiler = deps.profilerFor(request.dataset.profile);
      const result = await profiler.profile(request, {
        signal,
        refresh: message.refresh,
        onProgress: (state, statementId) => deps.post({ type: 'progress', id, state, statementId }),
      });
      if (signal.aborted) reply({ type: 'cancelled', id });
      else reply({ type: 'result', id, result });
    } catch (e) {
      if (e instanceof CancelledError || signal.aborted) {
        reply({ type: 'cancelled', id });
      } else if (e instanceof ProfilerError) {
        reply({ type: 'error', id, message: e.message, nextStep: e.nextStep, raw: e.raw, sql: e.sql });
      } else {
        const text = e instanceof Error ? e.message : String(e);
        reply({ type: 'error', id, message: 'The request failed.', raw: text, sql: [] });
      }
    } finally {
      running.delete(id);
    }
  }

  return {
    handle,
    cancelAll: () => running.forEach((cancel) => cancel()),
    exchanges,
  };
}
