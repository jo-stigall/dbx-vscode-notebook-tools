/**
 * A small client for the Databricks REST API.
 *
 * The client does three things for each request:
 *
 * - It adds the login token. After an HTTP 401 answer it gets a new token and
 *   tries one more time, because an OAuth token expires in less than one hour.
 * - It waits and tries again after an HTTP 429 or 503 answer.
 * - It refuses a workspace URL that starts with "http://", because that
 *   sends the token as plain text. A server on this computer is permitted,
 *   for tests.
 *
 * The client never writes a token to a log or to an error message.
 *
 * This file does not import `vscode`, so that a test can use it with a
 * local server.
 */

/** Sends one request and returns the JSON answer. GET puts `payload` in the URL. POST sends it as JSON. */
export type Http = (method: 'GET' | 'POST', path: string, payload?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** Databricks answered with an error status, or did not answer. */
export class HttpError extends Error {
  /** The HTTP status code. 0 if there was no answer. */
  readonly status: number;
  /** The error code from Databricks. Example: 'RESOURCE_DOES_NOT_EXIST'. */
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export interface HttpDeps {
  /** Returns the workspace URL. Example: 'https://adb-123.azuredatabricks.net'. */
  host: () => string;
  /**
   * Returns the login token.
   *
   * @param fresh  true after an HTTP 401 answer: the token that the function gave before is not valid. Get a new one if that is possible.
   */
  token: (fresh: boolean) => Promise<string>;
  /** How long to wait for one answer, in milliseconds. Default: 30,000. */
  timeoutMs?: number;
  /** How many times to try again after HTTP 429 or 503. Default: 4. */
  maxRetries?: number;
  /** Waits for a number of milliseconds. A test can make it return at once. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Gets the ID of the workspace, which Databricks sends in the header
   * "x-databricks-org-id" of each answer. The cluster runner needs the ID.
   */
  onWorkspaceId?: (id: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tell if a URL points to this computer. */
function isLoopback(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Make the function that sends requests to one workspace.
 *
 * @example
 * const http = createHttp({ host: () => 'https://adb-123.azuredatabricks.net', token: async () => 'dapi...' });
 * const { warehouses } = await http('GET', '/api/2.0/sql/warehouses');
 */
export function createHttp(deps: HttpDeps): Http {
  const sleep = deps.sleep ?? defaultSleep;
  const timeoutMs = deps.timeoutMs ?? 30_000;
  const maxRetries = deps.maxRetries ?? 4;

  return async (method, path, payload, signal) => {
    const host = deps.host().replace(/\/+$/, '');
    if (!host) throw new HttpError('No Databricks workspace is selected.', 0);
    if (host.startsWith('http://') && !isLoopback(host)) {
      throw new HttpError(`The workspace URL ${host} must start with "https://". The extension does not send your token without encryption.`, 0);
    }
    let url = host + path;
    if (method === 'GET' && payload) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(payload)) if (value !== undefined) query.set(key, String(value));
      if ([...query].length) url += '?' + query.toString();
    }

    let refreshed = false;
    for (let retries = 0; ; ) {
      const token = await deps.token(refreshed);
      const limits = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
      let response: Response;
      let text: string;
      try {
        response = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
          body: method === 'POST' ? JSON.stringify(payload ?? {}) : undefined,
          signal: AbortSignal.any(limits),
        });
        text = await response.text();
      } catch (e) {
        if (signal?.aborted) throw e; // The caller stopped the request.
        const error = e as Error & { cause?: Error };
        if (error.name === 'TimeoutError') throw new HttpError(`${host} did not answer ${path} in ${Math.round(timeoutMs / 1000)} seconds.`, 0);
        throw new HttpError(`Cannot reach ${host}: ${error.cause?.message ?? error.message}`, 0);
      }

      const workspaceId = response.headers.get('x-databricks-org-id');
      if (workspaceId) deps.onWorkspaceId?.(workspaceId);

      // One new token after the first 401. A second 401 is an error.
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        continue;
      }
      if ((response.status === 429 || response.status === 503) && retries < maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        // Wait as long as Databricks says. If it does not say: 1, 2, 4, 8 seconds.
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 1000 * 2 ** retries);
        retries++;
        continue;
      }

      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = undefined;
      }
      if (!response.ok) {
        const body = (json ?? {}) as { message?: string; error?: string; error_code?: string };
        const detail = body.message ?? body.error ?? text.slice(0, 300);
        throw new HttpError(`Databricks API ${path} failed (HTTP ${response.status}): ${detail}`, response.status, body.error_code);
      }
      return json ?? {};
    }
  };
}
