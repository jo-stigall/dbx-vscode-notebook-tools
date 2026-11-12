/**
 * Tests for the requests of the webview (src/tableViz/webview/rpc.ts) and the
 * request scopes of compare mode (src/tableViz/webview/compare/useCompare.ts).
 *
 * The tests check what the webview sends to the host: a request, and a
 * "cancel" when no part of the page wants the answer any more. A fake VS Code
 * API records the messages, and a fake window delivers the answers of the host.
 *
 * Run all unit tests: npm run test:unit
 * Run this file only: node --test test/tableViz/unit/requests.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dataset, Request } from '../../../src/tableViz/core/schema.ts';

/** The messages that the webview sent to the host, in sequence. */
const sent: { type: string; id?: string }[] = [];

// rpc.ts reads these two globals when it loads, so set them before the import.
/** The fake `window`. rpc.ts listens on it for the "message" events that carry the answers of the host. */
const page = new EventTarget();
Object.assign(globalThis, {
  window: page,
  acquireVsCodeApi: () => ({ postMessage: (message: { type: string; id?: string }) => sent.push(message), getState: () => undefined, setState: () => {} }),
});
const { hold, refreshAll } = await import('../../../src/tableViz/webview/rpc.ts');
const { DatasetHolds, Scope } = await import('../../../src/tableViz/webview/compare/useCompare.ts');

/** The base dataset of all requests. No test here runs a query, so the table does not have to exist. */
const dataset: Dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders' } };
/**
 * Make a request. Two calls with the same `filter` make the same request. A different `filter` makes a different request.
 *
 * Each test uses its own filter text, so that a request of one test is not the same as a request of a test before it.
 *
 * @example
 * request('a = 1')   // { type: 'validateFilter', dataset: { ..., filter: 'a = 1' } }
 */
const request = (filter: string): Request => ({ type: 'validateFilter', dataset: { ...dataset, filter } });

/**
 * Get the IDs of the requests and of the cancels that the webview sent after `from`.
 *
 * @example
 * const from = sent.length;
 * // ... the test asks for one request and closes its scope ...
 * messages(from)   // { requests: ['7'], cancels: ['7'] }
 *
 * @param from  The length of `sent` at the start of the test. The function ignores the messages before it.
 */
function messages(from: number) {
  const list = sent.slice(from);
  return { requests: list.filter((m) => m.type === 'request').map((m) => m.id), cancels: list.filter((m) => m.type === 'cancel').map((m) => m.id) };
}

/** Do what the host does when a query is done: send the result for the request with this ID. */
function answer(id: string | undefined): void {
  const result = { type: 'validateFilter', sql: [], approximate: false, asOf: '2026-11-12T00:00:00Z' };
  page.dispatchEvent(new MessageEvent('message', { data: { type: 'result', id, result } }));
}

test('closing a scope cancels its request that still runs', () => {
  const from = sent.length;
  const scope = new Scope();
  void scope.ask(request('a = 1')).catch(() => {});
  const { requests } = messages(from);
  assert.equal(requests.length, 1);
  scope.close();
  assert.deepEqual(messages(from).cancels, requests);
});

test('a request that a second scope wants is not cancelled', () => {
  const from = sent.length;
  const one = new Scope();
  const two = new Scope();
  void one.ask(request('b = 1')).catch(() => {});
  void two.ask(request('b = 1')).catch(() => {});
  assert.equal(messages(from).requests.length, 1, 'the same request is sent one time');
  one.close();
  assert.deepEqual(messages(from).cancels, [], 'the second scope still wants it');
  two.close();
  assert.deepEqual(messages(from).cancels, messages(from).requests);
});

test('a closed scope sends nothing and fails as cancelled', async () => {
  const from = sent.length;
  const scope = new Scope();
  scope.close();
  await assert.rejects(scope.ask(request('c = 1')), (e: { cancelled?: boolean }) => e.cancelled === true);
  assert.deepEqual(messages(from), { requests: [], cancels: [] });
});

test('a request that is done keeps its answer after the scope closes', async () => {
  const from = sent.length;
  const first = new Scope();
  const promise = first.ask(request('d = 1'));
  answer(messages(from).requests[0]);
  await promise;
  first.close();
  assert.deepEqual(messages(from).cancels, [], 'a request that is done is not cancelled');
  const second = new Scope();
  await second.ask(request('d = 1'));
  assert.equal(messages(from).requests.length, 1, 'the same question later sends no new query');
  second.close();
});

test('releasing an old request after "Refresh" does not cancel the new request with the same text', () => {
  const from = sent.length;
  const old = hold(request('e = 1'));
  old.promise.catch(() => {});
  refreshAll();
  const fresh = hold(request('e = 1'));
  fresh.promise.catch(() => {});
  const [oldId, freshId] = messages(from).requests;
  assert.ok(oldId && freshId && oldId !== freshId);
  old.release();
  assert.ok(!messages(from).cancels.includes(freshId), 'the new request still runs');
  fresh.release();
  assert.ok(messages(from).cancels.includes(freshId));
});

test('drift requests: a change to B cancels the queries on the old B, and the queries on A continue', () => {
  const from = sent.length;
  const a: Dataset = { ...dataset, filter: 'g = 1' };
  const oldB: Dataset = { ...dataset, filter: 'g = 2' };
  const newB: Dataset = { ...dataset, filter: 'g = 3' };
  const holds = new DatasetHolds();
  holds.show([a, oldB]);
  void holds.ask({ type: 'validateFilter', dataset: a }).catch(() => {});
  void holds.ask({ type: 'validateFilter', dataset: oldB }).catch(() => {});
  const [idA, idOldB] = messages(from).requests;

  // The user changes B. The new numbers of B are not here yet, so no new drift asks for A now.
  holds.show([a, newB]);
  assert.deepEqual(messages(from).cancels, [idOldB], 'only the query on the old B stops');

  // When the numbers of the new B are here, the drift asks for A again and gets the same query.
  void holds.ask({ type: 'validateFilter', dataset: a }).catch(() => {});
  assert.equal(messages(from).requests.length, 2, 'the query on A is not sent again');

  holds.close();
  assert.deepEqual(messages(from).cancels, [idOldB, idA], 'the board left the page: the query on A stops');
});

test('drift requests: a request on a dataset that the board does not show is not sent', async () => {
  const from = sent.length;
  const holds = new DatasetHolds();
  holds.show([{ ...dataset, filter: 'h = 1' }]);
  await assert.rejects(holds.ask({ type: 'validateFilter', dataset: { ...dataset, filter: 'h = 2' } }), (e: { cancelled?: boolean }) => e.cancelled === true);
  assert.deepEqual(messages(from).requests, []);
});
