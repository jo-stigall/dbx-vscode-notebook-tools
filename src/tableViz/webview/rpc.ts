/**
 * Send requests from the webview to the extension host and get the answers.
 *
 * The webview has no network access and no token. It asks the host for each
 * number with a typed request. The host answers with a typed result.
 *
 * Two components that ask for the same thing share one request. When no
 * component wants a request that still runs, the file tells the host to
 * cancel it, so that the query stops on Databricks.
 *
 * The file keeps each result until the user clicks "Refresh". A component
 * that asks for the same thing later gets that result, and the file sends
 * nothing.
 *
 * Most components do not call this file directly. They use the hooks in
 * hooks.ts and compare/useCompare.ts, which call acquire(), hold() and
 * release().
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

/** The part of the VS Code webview API that this file uses. */
interface VsCodeApi {
  /** Send a message to the extension host. */
  postMessage(message: ToHost): void;
  /** Read the state that setState() stored. Returns undefined if there is none. */
  getState(): unknown;
  /** Store the state of the board. It replaces the state that was there. */
  setState(state: BoardState): void;
}
/** VS Code puts this function in each webview. A page can call it one time only. */
declare function acquireVsCodeApi(): VsCodeApi;

/**
 * The connection to VS Code.
 *
 * A test that draws components in Node.js has no VS Code. It gets an object
 * that does nothing.
 */
const vscode: VsCodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage: () => {}, getState: () => undefined, setState: () => {} };

/**
 * An error from the host that the page can show.
 *
 * ErrorPanel in cards/CardShell.tsx shows the fields:
 *
 * - `message`: a plain sentence. Example: "The table does not exist."
 * - `nextStep`: what the user can do. Example: "Check the name of the table."
 * - `raw`: the error text from Databricks. The same as `message` if the host gave no other text.
 * - `sql`: the SQL statements of the request that failed. Empty if the host gave none.
 * - `cancelled`: true if the host cancelled the request, for example after a click on "Cancel".
 *
 * @example
 * try {
 *   await acquire({ type: 'tableDetails', dataset });
 * } catch (e) {
 *   const error = e as RequestError;
 *   if (!error.cancelled) show(error.message, error.nextStep);
 * }
 *
 * @param message  The plain sentence that the page shows.
 * @param details  The other fields of the error. Default: no next step, `raw` equal to `message`, no SQL, not cancelled.
 */
export class RequestError extends Error {
  /** What the user can do about the error. Example: 'Ask the owner of the table for the SELECT privilege.' */
  readonly nextStep?: string;
  /** The original text from Databricks. */
  readonly raw: string;
  /** The SQL statements of the request that failed. */
  readonly sql: string[];
  /** true if the host cancelled the request. This is not a failure. */
  readonly cancelled: boolean;

  constructor(message: string, details: { nextStep?: string; raw?: string; sql?: string[]; cancelled?: boolean } = {}) {
    super(message);
    this.nextStep = details.nextStep;
    this.raw = details.raw ?? message;
    this.sql = details.sql ?? [];
    this.cancelled = details.cancelled ?? false;
  }
}

/** What the host sends when the webview starts. */
export interface Init {
  /** Dataset A, and dataset B if the board starts in compare mode. */
  datasets: BoardDatasets;
  /** The settings of the feature, from the VS Code settings. Example: the number of bins of a new histogram. */
  settings: BoardSettings;
  /** The cards and settings of a saved view. Not set for a new board. */
  state?: BoardState;
  /** true: show the datasets and the filters of a saved view, and ask the user before any query runs. */
  confirm?: boolean;
}

/**
 * Send a message that is not a request to the host: save a file, open SQL, save the view, permit a saved view.
 *
 * @example
 * send({ type: 'openSql', sql: ['SELECT count(*) FROM `main`.`shop`.`orders`'] });
 */
export function send(message: Exclude<ToHost, { type: 'request' | 'cancel' | 'ready' }>): void {
  vscode.postMessage(message);
}

/** The state of a query on Databricks: it waits for a free place, or it runs. */
export type Progress = 'queued' | 'running';

/** One request that the webview sent, and the components that wait for its answer. */
interface Entry {
  /** The number that the request has in the messages. The host puts the same id in its answer. */
  id: string;
  /** Gives the result, or fails with a RequestError. All users of the entry share it. */
  promise: Promise<Result>;
  /** Ends `promise` with the result from the host. */
  resolve: (result: Result) => void;
  /** Ends `promise` with an error from the host, or with "Cancelled.". */
  reject: (error: RequestError) => void;
  /** true after the host sent the result, an error or "cancelled". */
  settled: boolean;
  /** The number of components that want the answer. */
  users: number;
  /** The functions that get 'queued' or 'running' when the host reports the state of the query. */
  onProgress: Set<(progress: Progress) => void>;
}

/**
 * The requests that the webview sent, by the request as JSON text.
 *
 * An entry stays in the map after its result arrives. A component that
 * asks for the same thing again, for example after a sort or a search, gets
 * that result and the file sends no new request. "Refresh" empties the map.
 */
const entries = new Map<string, Entry>();
/** The requests that have no answer yet, by their id. The file finds the entry of a message from the host with it. */
const byId = new Map<string, { key: string; entry: Entry }>();
/** The id of the last request. Each new request gets the next number: '1', '2', '3'. */
let lastId = 0;
/** The function that start() got. It gets the "init" message of the host. */
let onInit: ((init: Init) => void) | undefined;

/** The number of clicks on "Refresh". The hooks send their requests again when it changes. */
let generation = 0;
/** The requests that the file sent after the last "Refresh". The first time after a refresh, a request tells the host not to use its cache. */
const sentSinceRefresh = new Set<string>();

/**
 * What useRequests() returns now. publish() replaces the object, so React sees a change.
 *
 * `pending` is the number of requests that have no answer yet.
 */
let snapshot = { generation: 0, pending: 0 };
/** The functions that React gave to useRequests(). Each one makes a component draw again. */
const listeners = new Set<() => void>();
/** Count the requests that run, and tell the components that use useRequests() to draw again. */
function publish(): void {
  let pending = 0;
  for (const entry of entries.values()) if (!entry.settled) pending++;
  snapshot = { generation, pending };
  listeners.forEach((listener) => listener());
}

/**
 * Get the number of the last refresh and the number of requests that run now.
 *
 * The component draws again when one of them changes. The dataset bar shows
 * `pending` on its button "Cancel 3 queries". A hook puts `generation` in its
 * key, so that it sends its requests again after "Refresh".
 *
 * @example
 * const { generation, pending } = useRequests();   // { generation: 0, pending: 3 } while three requests run on a new board
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

/** The window of the webview. undefined in a test that runs in Node.js. */
const page = typeof window === 'undefined' ? undefined : window;
// Handle each message from the host: "init" goes to the function of start(), "progress" goes to the
// users of the request, and a result, an error or "cancelled" ends the request.
page?.addEventListener('message', (event: MessageEvent) => {
  const parsed = toWebviewSchema.safeParse(event.data);
  if (!parsed.success) return; // Ignore a message that does not have a known shape.
  const message = parsed.data;
  if (message.type === 'init') {
    onInit?.(message);
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
 * @param callback  Gets the datasets, the settings of the feature, and for a saved view its cards and whether to ask the user first.
 *   The host can call it a second time, after the user permitted the queries of a saved view.
 */
export function start(callback: (init: Init) => void): void {
  onInit = callback;
  vscode.postMessage({ type: 'ready' });
}

/**
 * Find the entry of a request, or send the request and make its entry. Add one user.
 *
 * @param key  The request as JSON text.
 * @param onProgress  Gets 'queued' or 'running' when the host reports the state of the query.
 */
function enter(req: Request, key: string, onProgress?: (progress: Progress) => void): Entry {
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
  return entry;
}

/**
 * Remove one user from an entry. If the entry has no users and still runs, tell the host to cancel it.
 *
 * The function does nothing to an entry that "Refresh" removed: refreshAll() cancelled it already,
 * and a new entry with the same request can be in the map now.
 */
function leave(key: string, entry: Entry, onProgress?: (progress: Progress) => void): void {
  if (onProgress) entry.onProgress.delete(onProgress);
  entry.users--;
  if (entry.users <= 0 && !entry.settled && entries.get(key) === entry) {
    entries.delete(key);
    vscode.postMessage({ type: 'cancel', id: entry.id });
  }
}

/**
 * Ask the host for one result. Call release() with the same request when you do not want the answer any more.
 *
 * If a different component already asked for the same thing, the function
 * sends nothing and gives the answer of that request.
 *
 * @example
 * const request = { type: 'frequency' as const, dataset, columns: [{ name: 'region', typeText: 'string' }], top: 20 };
 * const result = await acquire(request);
 * result.values   // [{ value: 'AMER', count: 43925 }, ...]
 * release(request);
 *
 * @param onProgress  Gets 'queued' when the query waits for a free place on Databricks, and 'running' when it starts.
 * @throws {RequestError}  If the host reports an error or cancels the request.
 */
export function acquire<T extends Request>(req: T, onProgress?: (progress: Progress) => void): Promise<ResultOf<T['type']>> {
  return enter(req, JSON.stringify(req), onProgress).promise as Promise<ResultOf<T['type']>>;
}

/** A request that one user holds. See hold(). */
export interface Held<T> {
  /** Gives the result, or fails with a RequestError. */
  promise: Promise<T>;
  /** Tell the file that this user does not want the answer any more. A second call does nothing. */
  release: () => void;
}

/**
 * Ask the host for one result, and get a function that releases exactly this request.
 *
 * Use it when the release can come after a "Refresh". release(req) then finds
 * the new request with the same text and releases it by mistake; the function
 * of hold() releases only the request that it sent.
 *
 * @example
 * const held = hold({ type: 'quantiles', dataset, columns: [amount], probabilities: [0.5] });
 * const median = (await held.promise).values[0];
 * held.release();
 */
export function hold<T extends Request>(req: T): Held<ResultOf<T['type']>> {
  const key = JSON.stringify(req);
  const entry = enter(req, key);
  let released = false;
  return {
    promise: entry.promise as Promise<ResultOf<T['type']>>,
    release: () => {
      if (released) return;
      released = true;
      leave(key, entry);
    },
  };
}

/**
 * Tell the file that one component does not want the answer of a request any more.
 *
 * If no component wants a request that still runs, the host cancels it.
 * A request that has its result keeps the result for the next component
 * that asks.
 *
 * @example
 * release({ type: 'frequency', dataset, columns: [{ name: 'region', typeText: 'string' }], top: 20 });
 *
 * @param req  The same request that acquire() got.
 * @param onProgress  The same function that acquire() got, if it got one.
 */
export function release(req: Request, onProgress?: (progress: Progress) => void): void {
  const key = JSON.stringify(req);
  const entry = entries.get(key);
  if (entry) leave(key, entry, onProgress);
}

/**
 * Cancel all requests that run now. This is the button "Cancel 3 queries".
 *
 * The function tells the host to stop each query. When the host answers
 * "cancelled", the request fails with a RequestError that has
 * `cancelled: true`.
 */
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

/**
 * Read the state that the webview stored before the last reload.
 *
 * @returns undefined if there is no state, or if the state does not have the shape of `boardStateSchema`.
 */
export function loadState(): BoardState | undefined {
  const parsed = boardStateSchema.safeParse(vscode.getState());
  return parsed.success ? parsed.data : undefined;
}

/**
 * Store the state, so that the board comes back after a window reload.
 *
 * The state holds the datasets, the open cards and their settings. It holds no data of a table.
 *
 * @example
 * saveState({ datasets: { a: dataset }, cards: [{ column: 'amount', pinned: false, expanded: true }] });
 */
export function saveState(state: BoardState): void {
  vscode.setState(state);
}
