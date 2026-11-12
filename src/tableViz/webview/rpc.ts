/**
 * Send requests from the webview to the extension host and get the answers.
 *
 * The webview has no network access and no token. It asks the host for each
 * number with a typed request. The host answers with a typed result.
 *
 * Two components that ask for the same thing share one request. When no
 * component wants a request that still runs, the file tells the host to
 * cancel it, so that the query stops on Databricks.
 */
import { useSyncExternalStore } from 'react';
import * as z from 'zod';
import {
  boardStateSchema,
  toWebviewSchema,
  type BoardDatasets,
  type BoardSettings,
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
  /** true if the request was cancelled. This is not a failure. */
  readonly cancelled: boolean;

  constructor(message: string, details: { nextStep?: string; raw?: string; sql?: string[]; cancelled?: boolean } = {}) {
    super(message);
    this.nextStep = details.nextStep;
    this.raw = details.raw ?? message;
    this.sql = details.sql ?? [];
    this.cancelled = details.cancelled ?? false;
  }
}

/** The state of a query on Databricks: it waits for a free place, or it runs. */
export type Progress = 'queued' | 'running';

/** One request that the webview sent. */
interface Entry {
  id: string;
  promise: Promise<Result>;
  resolve: (result: Result) => void;
  reject: (error: RequestError) => void;
  /** true after the host sent the result, an error or "cancelled". */
  settled: boolean;
  /** The number of components that want the answer. */
  users: number;
  onProgress: Set<(progress: Progress) => void>;
}

/** The requests, by the request as JSON text. A sort or a search then sends no new request. */
const entries = new Map<string, Entry>();
const byId = new Map<string, { key: string; entry: Entry }>();
let lastId = 0;
let onInit: ((datasets: BoardDatasets, settings: BoardSettings) => void) | undefined;

/** Increases with each click on "Refresh". */
let generation = 0;
/** The requests that were sent after the last "Refresh". The first time after a refresh, a request tells the host not to use its cache. */
const sentSinceRefresh = new Set<string>();

// A small store, so that React components draw again when a request starts or ends, or when the user refreshes.
let snapshot = { generation: 0, pending: 0 };
const listeners = new Set<() => void>();
function publish(): void {
  let pending = 0;
  for (const entry of entries.values()) if (!entry.settled) pending++;
  snapshot = { generation, pending };
  listeners.forEach((listener) => listener());
}

/**
 * Get the number of the last refresh and the number of requests that run now.
 * The component draws again when one of them changes.
 */
export function useRequests(): { generation: number; pending: number } {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  const parsed = toWebviewSchema.safeParse(event.data);
  if (!parsed.success) return; // Ignore a message that does not have a known shape.
  const message = parsed.data;
  if (message.type === 'init') {
    onInit?.(message.datasets, message.settings);
    return;
  }
  const found = byId.get(message.id);
  if (!found) return;
  const { key, entry } = found;
  if (message.type === 'progress') {
    entry.onProgress.forEach((callback) => callback(message.state));
    return;
  }
  byId.delete(message.id);
  entry.settled = true;
  if (message.type === 'result') {
    entry.resolve(message.result);
  } else {
    // Do not keep a failure or a cancel. The next call tries again.
    if (entries.get(key) === entry) entries.delete(key);
    entry.reject(message.type === 'cancelled' ? new RequestError('Cancelled.', { cancelled: true }) : new RequestError(message.message, message));
  }
  publish();
});

/**
 * Tell the host that the webview started. The host answers with the datasets of the board.
 *
 * @param callback  Gets the datasets and the settings of the feature.
 */
export function start(callback: (datasets: BoardDatasets, settings: BoardSettings) => void): void {
  onInit = callback;
  vscode.postMessage({ type: 'ready' });
}

/**
 * Ask the host for one result. Call release() with the same request when the answer is not wanted any more.
 *
 * @example
 * const result = await acquire({ type: 'frequency', dataset, columns: [{ name: 'region', typeText: 'string' }], top: 20 });
 * result.values   // [{ value: 'AMER', count: 43925 }, ...]
 *
 * @param onProgress  Gets 'queued' when the query waits for a free place on Databricks, and 'running' when it starts.
 * @throws {RequestError}  If the host reports an error or the request was cancelled.
 */
export function acquire<T extends Request>(req: T, onProgress?: (progress: Progress) => void): Promise<ResultOf<T['type']>> {
  const key = JSON.stringify(req);
  let entry = entries.get(key);
  if (!entry) {
    const id = String(++lastId);
    let resolve!: (result: Result) => void;
    let reject!: (error: RequestError) => void;
    const promise = new Promise<Result>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {}); // A component that left does not read the failure.
    entry = { id, promise, resolve, reject, settled: false, users: 0, onProgress: new Set() };
    entries.set(key, entry);
    byId.set(id, { key, entry });
    const refresh = generation > 0 && !sentSinceRefresh.has(key);
    sentSinceRefresh.add(key);
    vscode.postMessage({ type: 'request', id, request: req, ...(refresh ? { refresh: true } : {}) });
    publish();
  }
  entry.users++;
  if (onProgress) entry.onProgress.add(onProgress);
  return entry.promise as Promise<ResultOf<T['type']>>;
}

/**
 * Tell the file that one component does not want the answer of a request any more.
 *
 * If no component wants a request that still runs, the host cancels it.
 */
export function release(req: Request, onProgress?: (progress: Progress) => void): void {
  const key = JSON.stringify(req);
  const entry = entries.get(key);
  if (!entry) return;
  if (onProgress) entry.onProgress.delete(onProgress);
  entry.users--;
  if (entry.users <= 0 && !entry.settled) {
    entries.delete(key);
    vscode.postMessage({ type: 'cancel', id: entry.id });
  }
}

/** Cancel all requests that run now. Each one fails with a RequestError that has `cancelled: true`. */
export function cancelAll(): void {
  for (const entry of entries.values()) if (!entry.settled) vscode.postMessage({ type: 'cancel', id: entry.id });
}

/**
 * Run all queries again. This is the "Refresh" button.
 *
 * The function forgets all answers and cancels the requests that run. The
 * components then ask again, and each request tells the host not to answer
 * from its cache.
 */
export function refreshAll(): void {
  cancelAll();
  entries.clear();
  sentSinceRefresh.clear();
  generation++;
  publish();
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
