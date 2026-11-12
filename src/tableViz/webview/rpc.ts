/**
 * Send requests from the webview to the extension host and get the answers.
 *
 * The webview has no network access and no token. It asks the host for each
 * number with a typed request. The host answers with a typed result.
 */
import * as z from 'zod';
import {
  boardStateSchema,
  toWebviewSchema,
  type BoardDatasets,
  type BoardState,
  type Request,
  type Result,
  type ResultOf,
  type ToHost,
} from '../core/schema.ts';

// zod can make its checks faster with `new Function`. The Content Security Policy of the webview forbids that.
z.config({ jitless: true });

interface VsCodeApi {
  postMessage(message: ToHost): void;
  getState(): unknown;
  setState(state: BoardState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

/** An error from the host that the UI can show. */
export class RequestError extends Error {
  readonly nextStep?: string;
  readonly raw: string;
  readonly sql: string[];
  readonly cancelled: boolean;

  constructor(message: string, details: { nextStep?: string; raw?: string; sql?: string[]; cancelled?: boolean } = {}) {
    super(message);
    this.nextStep = details.nextStep;
    this.raw = details.raw ?? message;
    this.sql = details.sql ?? [];
    this.cancelled = details.cancelled ?? false;
  }
}

interface Pending {
  resolve: (result: Result) => void;
  reject: (error: RequestError) => void;
}
const pending = new Map<string, Pending>();
let lastId = 0;
let onInit: ((datasets: BoardDatasets) => void) | undefined;

window.addEventListener('message', (event: MessageEvent) => {
  const parsed = toWebviewSchema.safeParse(event.data);
  if (!parsed.success) return; // Ignore a message that does not have a known shape.
  const message = parsed.data;
  if (message.type === 'init') {
    onInit?.(message.datasets);
    return;
  }
  const waiter = pending.get(message.id);
  if (!waiter || message.type === 'progress') return;
  pending.delete(message.id);
  if (message.type === 'result') waiter.resolve(message.result);
  else if (message.type === 'cancelled') waiter.reject(new RequestError('Cancelled.', { cancelled: true }));
  else waiter.reject(new RequestError(message.message, message));
});

/**
 * Tell the host that the webview started. The host answers with the datasets of the board.
 *
 * @param callback  Gets the datasets.
 */
export function start(callback: (datasets: BoardDatasets) => void): void {
  onInit = callback;
  vscode.postMessage({ type: 'ready' });
}

/** Results that the webview has, keyed by the request as JSON text. A sort or a search then sends no new request. */
const cache = new Map<string, Promise<Result>>();

/**
 * Ask the host for one result.
 *
 * Two calls with the same request share one answer.
 *
 * @example
 * const result = await request({ type: 'frequency', dataset, columns: [{ name: 'region', typeText: 'string' }], top: 20 });
 * result.values   // [{ value: 'AMER', count: 43925 }, ...]
 *
 * @throws {RequestError}  If the host reports an error or the request was cancelled.
 */
export function request<T extends Request>(req: T): Promise<ResultOf<T['type']>> {
  const key = JSON.stringify(req);
  let promise = cache.get(key);
  if (!promise) {
    const id = String(++lastId);
    promise = new Promise<Result>((resolve, reject) => pending.set(id, { resolve, reject }));
    promise.catch(() => cache.delete(key)); // Do not keep a failure. The next call tries again.
    cache.set(key, promise);
    vscode.postMessage({ type: 'request', id, request: req });
  }
  return promise as Promise<ResultOf<T['type']>>;
}

/** Read the state that the webview stored before the last reload. Returns undefined if there is none. */
export function loadState(): BoardState | undefined {
  const parsed = boardStateSchema.safeParse(vscode.getState());
  return parsed.success ? parsed.data : undefined;
}

/** Store the state, so that the board comes back after a window reload. */
export function saveState(state: BoardState): void {
  vscode.setState(state);
}
