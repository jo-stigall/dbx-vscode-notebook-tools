/**
 * Tests for the REST client and the SQL warehouse runner (src/tableViz/host/http.ts and statementRunner.ts).
 *
 * Each test starts a small HTTP server on this computer and gives it a
 * script: what to answer to each request. The runner then talks to that
 * server as it talks to Databricks. No test needs a workspace.
 *
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { CancelledError } from '../../../src/tableViz/core/profiler.ts';
import { QueryError } from '../../../src/tableViz/core/runner.ts';
import type { Statement } from '../../../src/tableViz/core/sql.ts';
import { createHttp, HttpError } from '../../../src/tableViz/host/http.ts';
import { StatementExecutionRunner } from '../../../src/tableViz/host/statementRunner.ts';

/** One request that the server received. */
interface Seen {
  method: string;
  path: string;
  body: Record<string, unknown>;
  token: string;
}
/** What the server answers. */
interface Answer {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Start a server that answers each request with the result of `script`.
 *
 * @param script  Gets the request and the list of all requests until now (the new request is the last one).
 * @returns The address of the server, the requests that it received, and a function that stops it.
 */
async function scripted(script: (request: Seen, all: Seen[]) => Answer) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      const request: Seen = {
        method: req.method ?? '',
        path: req.url ?? '',
        body: text ? JSON.parse(text) : {},
        token: (req.headers.authorization ?? '').replace('Bearer ', ''),
      };
      seen.push(request);
      const answer = script(request, seen);
      res.writeHead(answer.status ?? 200, { 'Content-Type': 'application/json', ...answer.headers });
      res.end(JSON.stringify(answer.body ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    seen,
    paths: () => seen.map((r) => `${r.method} ${r.path}`),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The waits of the runner and the client, 200 times faster. The test records the times that the code asked for. */
function fastSleep() {
  const asked: number[] = [];
  return { asked, sleep: (ms: number) => (asked.push(ms), new Promise<void>((resolve) => setTimeout(resolve, ms / 200))) };
}

/** Make a runner that talks to a scripted server. */
function makeRunner(url: string, options: { timeoutSeconds?: number; tokens?: string[]; sleep?: (ms: number) => Promise<void> } = {}) {
  const tokens = options.tokens ?? ['token-1'];
  const tokenCalls: boolean[] = [];
  const sleep = options.sleep ?? fastSleep().sleep;
  const http = createHttp({
    host: () => url,
    token: async (fresh) => {
      tokenCalls.push(fresh);
      return (fresh ? tokens[1] : tokens[0]) ?? 'none';
    },
    sleep,
  });
  const runner = new StatementExecutionRunner({
    http,
    warehouseId: 'wh-1',
    timeoutSeconds: () => options.timeoutSeconds ?? 300,
    tags: { feature: 'table-viz' },
    sleep,
  });
  return { runner, tokenCalls };
}

const statement: Statement = {
  sql: 'SELECT count(*) AS `n` FROM IDENTIFIER(:tbl)',
  params: [{ name: 'tbl', value: '`main`.`sales`.`orders`', type: 'STRING' }],
};
const columns = [
  { name: 'n', type_name: 'LONG', position: 0 },
  { name: 'lo', type_name: 'DECIMAL', position: 1 },
];
const succeeded = (rows: (string | null)[][], extra: object = {}) => ({
  statement_id: 's-1',
  status: { state: 'SUCCEEDED' },
  manifest: { schema: { columns } },
  result: { data_array: rows, ...extra },
});
const inState = (state: string) => ({ statement_id: 's-1', status: { state } });

test('runner: a statement that is done in the first request', async () => {
  const server = await scripted(() => ({ body: succeeded([['9007199254740993', null]]) }));
  try {
    const started: string[] = [];
    const result = await makeRunner(server.url).runner.run(statement, { onStarted: (id) => started.push(id) });
    assert.deepEqual(result, {
      columns: [{ name: 'n', typeName: 'LONG' }, { name: 'lo', typeName: 'DECIMAL' }],
      rows: [['9007199254740993', null]], // a 64-bit integer stays text, and NULL stays null
      statementId: 's-1',
    });
    assert.deepEqual(started, ['s-1']);
    assert.deepEqual(server.paths(), ['POST /api/2.0/sql/statements']);
    assert.equal(server.seen[0]?.token, 'token-1');
    assert.deepEqual(server.seen[0]?.body, {
      statement: statement.sql,
      warehouse_id: 'wh-1',
      parameters: [{ name: 'tbl', value: '`main`.`sales`.`orders`', type: 'STRING' }],
      wait_timeout: '10s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      query_tags: [{ key: 'feature', value: 'table-viz' }],
    });
  } finally {
    server.close();
  }
});

test('runner: a statement that is pending, then runs, then succeeds with two pieces of rows', async () => {
  const server = await scripted((request, all) => {
    if (request.method === 'POST') return { body: inState('PENDING') };
    if (request.path.endsWith('/result/chunks/1')) return { body: { data_array: [['3', '3.50']] } };
    const polls = all.filter((r) => r.method === 'GET').length;
    return { body: polls < 3 ? inState('RUNNING') : succeeded([['1', '1.50'], ['2', '2.50']], { next_chunk_index: 1 }) };
  });
  try {
    const { asked, sleep } = fastSleep();
    const result = await makeRunner(server.url, { sleep }).runner.run(statement);
    assert.deepEqual(result.rows, [['1', '1.50'], ['2', '2.50'], ['3', '3.50']]);
    assert.deepEqual(server.paths(), [
      'POST /api/2.0/sql/statements',
      'GET /api/2.0/sql/statements/s-1',
      'GET /api/2.0/sql/statements/s-1',
      'GET /api/2.0/sql/statements/s-1',
      'GET /api/2.0/sql/statements/s-1/result/chunks/1',
    ]);
    assert.deepEqual(asked, [500, 750, 1125], 'the wait between two requests increases');
  } finally {
    server.close();
  }
});

test('runner: a statement that fails', async () => {
  const failed = { statement_id: 's-1', status: { state: 'FAILED', sql_state: '42P01', error: { error_code: 'TABLE_OR_VIEW_NOT_FOUND', message: 'The table `x` cannot be found.' } } };
  const server = await scripted((request) => ({ body: request.method === 'POST' ? inState('RUNNING') : failed }));
  try {
    await assert.rejects(makeRunner(server.url).runner.run(statement), (e: unknown) => {
      assert.ok(e instanceof QueryError);
      assert.deepEqual([e.kind, e.code, e.sqlState, e.statementId, e.message], ['failed', 'TABLE_OR_VIEW_NOT_FOUND', '42P01', 's-1', 'The table `x` cannot be found.']);
      return true;
    });
  } finally {
    server.close();
  }
});

test('runner: cancel sends a cancel request and waits until Databricks confirms it', async () => {
  const controller = new AbortController();
  const server = await scripted((request, all) => {
    if (request.path.endsWith('/cancel')) return { body: {} };
    const cancelled = all.findIndex((r) => r.path.endsWith('/cancel'));
    if (cancelled < 0) {
      // The second status request stops the statement, as a user does when they close a card.
      if (all.filter((r) => r.method === 'GET').length === 2) controller.abort();
      return { body: inState('RUNNING') };
    }
    // Databricks needs some time to stop: the first request after the cancel still says RUNNING.
    return { body: inState(all.length - cancelled > 2 ? 'CANCELED' : 'RUNNING') };
  });
  try {
    await assert.rejects(makeRunner(server.url).runner.run(statement, { signal: controller.signal }), CancelledError);
    const paths = server.paths();
    const cancelAt = paths.indexOf('POST /api/2.0/sql/statements/s-1/cancel');
    assert.ok(cancelAt > 0, 'the runner sent a cancel request');
    assert.deepEqual(paths.slice(cancelAt + 1), ['GET /api/2.0/sql/statements/s-1', 'GET /api/2.0/sql/statements/s-1'], 'the runner asks until the state is CANCELED');
  } finally {
    server.close();
  }
});

test('runner: a signal that fired before the start sends nothing', async () => {
  const server = await scripted(() => ({ body: succeeded([]) }));
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(makeRunner(server.url).runner.run(statement, { signal: controller.signal }), CancelledError);
    assert.deepEqual(server.paths(), []);
  } finally {
    server.close();
  }
});

test('runner: a statement that runs longer than the time limit is cancelled', async () => {
  const server = await scripted((request, all) => {
    if (request.path.endsWith('/cancel')) return { body: {} };
    return { body: inState(all.some((r) => r.path.endsWith('/cancel')) ? 'CANCELED' : 'RUNNING') };
  });
  try {
    await assert.rejects(makeRunner(server.url, { timeoutSeconds: 0.05 }).runner.run(statement), (e: unknown) => {
      assert.ok(e instanceof QueryError);
      assert.equal(e.kind, 'timeout');
      return true;
    });
    assert.ok(server.paths().includes('POST /api/2.0/sql/statements/s-1/cancel'));
  } finally {
    server.close();
  }
});

test('runner: a statement that a different person cancelled is an error', async () => {
  const server = await scripted((request) => ({ body: inState(request.method === 'POST' ? 'RUNNING' : 'CANCELED') }));
  try {
    await assert.rejects(makeRunner(server.url).runner.run(statement), /cancelled the statement/);
  } finally {
    server.close();
  }
});

test('client: after HTTP 401 it gets a new token and tries one more time', async () => {
  const server = await scripted((request) => (request.token === 'token-1' ? { status: 401, body: { message: 'Invalid access token' } } : { body: succeeded([['1', '1']]) }));
  try {
    const { runner, tokenCalls } = makeRunner(server.url, { tokens: ['token-1', 'token-2'] });
    const result = await runner.run(statement);
    assert.deepEqual(result.rows, [['1', '1']]);
    assert.deepEqual(server.seen.map((r) => r.token), ['token-1', 'token-2']);
    assert.deepEqual(tokenCalls, [false, true]);
  } finally {
    server.close();
  }

  // A new token that is also refused is an error. The client does not try a third time.
  const refused = await scripted(() => ({ status: 401, body: { message: 'Invalid access token' } }));
  try {
    await assert.rejects(makeRunner(refused.url, { tokens: ['a', 'b'] }).runner.run(statement), (e: unknown) => {
      assert.ok(e instanceof QueryError);
      assert.deepEqual([e.kind, e.status], ['http', 401]);
      assert.ok(!e.message.includes('Bearer') && !/\b[ab]\b/.test(e.message.replace('Databricks API', '')), 'the message has no token');
      return true;
    });
    assert.equal(refused.seen.length, 2);
  } finally {
    refused.close();
  }
});

test('client: after HTTP 429 it waits and tries again', async () => {
  const server = await scripted((_request, all): Answer => {
    if (all.length >= 3) return { body: succeeded([]) };
    // Only the first answer tells how long to wait.
    return { status: 429, headers: all.length === 1 ? { 'Retry-After': '2' } : undefined, body: { message: 'Too many requests' } };
  });
  try {
    const { asked, sleep } = fastSleep();
    await makeRunner(server.url, { sleep }).runner.run(statement);
    assert.equal(server.seen.length, 3);
    assert.deepEqual(asked, [2000, 2000], 'first the time that the server gave, then 2 seconds for the second try');
  } finally {
    server.close();
  }

  // The client stops after 4 more tries.
  const busy = await scripted(() => ({ status: 429, body: { message: 'Too many requests' } }));
  try {
    await assert.rejects(makeRunner(busy.url).runner.run(statement), (e: unknown) => e instanceof QueryError && e.status === 429);
    assert.equal(busy.seen.length, 5);
  } finally {
    busy.close();
  }
});

test('client: URL, query values and errors', async () => {
  const server = await scripted((request) => (request.path.startsWith('/missing') ? { status: 404, body: { error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'Warehouse wh-9 does not exist' } } : { body: { ok: true } }));
  try {
    const http = createHttp({ host: () => server.url + '/', token: async () => 't' });
    assert.deepEqual(await http('GET', '/api/2.1/unity-catalog/schemas', { catalog_name: 'main', max_results: 50, page_token: undefined }), { ok: true });
    assert.equal(server.seen[0]?.path, '/api/2.1/unity-catalog/schemas?catalog_name=main&max_results=50');
    await assert.rejects(http('GET', '/missing'), (e: unknown) => {
      assert.ok(e instanceof HttpError);
      assert.deepEqual([e.status, e.code], [404, 'RESOURCE_DOES_NOT_EXIST']);
      assert.match(e.message, /HTTP 404\): Warehouse wh-9 does not exist/);
      return true;
    });
  } finally {
    server.close();
  }
  // The client sends no token to a URL without encryption.
  let asked = 0;
  const plain = createHttp({ host: () => 'http://workspace.example.com', token: async () => (asked++, 'secret') });
  await assert.rejects(plain('GET', '/api/2.0/sql/warehouses'), /must start with "https:\/\/"/);
  assert.equal(asked, 0);
  await assert.rejects(createHttp({ host: () => '', token: async () => 't' })('GET', '/x'), /No Databricks workspace/);
});
