'use strict';
/**
 * Test the table visualization feature in a real VS Code window, with the Demo profile.
 *
 * test/e2e.js calls main() after its own steps. Run it with test/run-e2e.sh
 * (or `npm run test:e2e`, which builds the feature first).
 *
 * The test opens a board with the command "Visualize Table". The board is a
 * webview. The test cannot look into the webview, but it can read the
 * requests that the webview sent to the extension host and the answers. A
 * request from the webview shows that the page loaded and ran with its
 * Content Security Policy.
 */
const vscode = require('vscode');
const assert = require('assert');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn` returns a true value. Check 10 times each second. */
async function until(what, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/**
 * Do the test steps. Stop at the first step that fails.
 *
 * @param {(message: string) => void} log  Call it after each step that passed.
 */
exports.main = async function main(log) {
  // Use the Demo profile. Without this, the feature uses the connection of the notebooks, which the other steps set.
  const api = await vscode.commands.executeCommand('dbxNotebook.tableViz._api');
  await api.session.select('Demo');

  // 1. The command opens a board panel, and the webview starts.
  const board = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'demo.shop.orders_2026');
  assert.ok(board, 'the command returns the board');
  await until('a webview tab with the name of the table', () =>
    vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputWebview && t.label === 'orders_2026')
  );
  await until('the webview to start', () => board.ready);
  log('tableViz: Visualize Table opens a board');

  // 2. The webview asks for the columns and the overview numbers, and the answers are correct.
  const exchanges = board.dispatcher.exchanges;
  const answer = (type) => exchanges.find((x) => x.request.type === type && x.response && x.response.type === 'result');
  const details = (await until('the table details', () => answer('tableDetails'))).response.result;
  assert.strictEqual(details.columns.length, 18);
  assert.deepStrictEqual(details.partitionColumns, ['order_date']);
  const overview = (await until('the overview numbers', () => answer('overview'))).response.result;
  assert.strictEqual(overview.rowCount, 110000);
  const by = Object.fromEntries(overview.columns.map((c) => [c.name, c]));
  assert.strictEqual(Object.keys(by).length, 18, 'one overview entry for each column');
  assert.strictEqual(by.order_id.distinct, 110000);
  assert.strictEqual(by.order_id.min, '5001000000');
  assert.strictEqual(by.channel.distinct, 4);
  assert.strictEqual(by.quantity.max, '8');
  assert.strictEqual(by.items.distinct, undefined, 'a complex column has no distinct count');
  const nullShare = 1 - by.discount_pct.nonNull / overview.rowCount;
  assert.ok(Math.abs(nullShare - 0.35) < 0.01, `discount_pct is null in about 35% of the rows, got ${nullShare}`);
  assert.ok(!exchanges.some((x) => x.response && x.response.type === 'error'), 'no request failed');
  log('tableViz: the overview of demo.shop.orders_2026 has the correct numbers');

  // 2b. A detail card asks for statistics. Send the same request that the card sends, and check the answer and its SQL.
  const dataset = { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
  await board.dispatcher.handle({
    type: 'request',
    id: 'test-stats',
    request: { type: 'numericStats', dataset, columns: [{ name: 'amount', typeText: 'decimal(10,2)' }] },
  });
  const stats = exchanges.find((x) => x.id === 'test-stats').response.result;
  assert.strictEqual(stats.nonNull, 110000);
  assert.strictEqual(stats.min, '2.33');
  assert.ok(Math.abs(stats.percentiles.find((p) => p.p === 0.5).value - 49.26) < 0.01, 'the median of amount');
  assert.strictEqual(stats.sql.length, 1);
  assert.ok(stats.sql[0].includes("-- :tbl = '`demo`.`shop`.`orders_2026`'") && stats.sql[0].includes('approx_percentile('), 'the result has the SQL of the request');
  // A message that is not a known request gets no answer and runs nothing.
  const count = exchanges.length;
  await board.dispatcher.handle({ type: 'request', id: 'bad', request: { type: 'runSql', sql: 'DROP TABLE x' } });
  assert.strictEqual(exchanges.length, count);
  log('tableViz: a statistics request gives numbers and the SQL behind them');

  // 2c. Compare mode: a board with two tables asks for the numbers of A and B and for the drift bins.
  const compared = await vscode.commands.executeCommand('dbxNotebook.tableViz.compareTables', 'demo.shop.orders_2025', 'demo.shop.orders_2026');
  assert.strictEqual(compared.panel.title, 'orders_2025 ↔ orders_2026');
  const sent = (type, table) => compared.dispatcher.exchanges.filter((x) => x.request.type === type && x.request.dataset.table.name === table && x.response && x.response.type === 'result');
  await until('the overviews of A and B', () => sent('overview', 'orders_2025').length && sent('overview', 'orders_2026').length);
  // The page computes the drift of each pair. For a number column it asks for the deciles of A, then for the bins of A and B.
  await until('the drift bins of A and B', () => sent('driftBins', 'orders_2025').length >= 5 && sent('driftBins', 'orders_2026').length >= 5);
  assert.strictEqual(sent('quantiles', 'orders_2026').length, 0, 'the cut points come from A only');
  assert.ok(sent('frequency', 'orders_2025').length >= 4 && sent('frequency', 'orders_2026').length >= 4);
  assert.ok(!compared.dispatcher.exchanges.some((x) => x.response && x.response.type === 'error'), 'no request failed');
  compared.panel.dispose();
  log('tableViz: Compare Tables opens a board that reads A and B');

  // 3. A name that is not a three-part name opens no board.
  const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview).length;
  const before = tabs();
  assert.strictEqual(await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'orders_2026'), undefined);
  assert.strictEqual(tabs(), before);
  log('tableViz: a bad table name opens no board');

  // 4. A table that does not exist gives a plain error with a next step, not a crash.
  const missing = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'demo.shop.orders_1999');
  const failed = await until('the error for a missing table', () => missing.dispatcher.exchanges.find((x) => x.response && x.response.type === 'error'));
  assert.match(failed.response.message, /orders_1999 does not exist/);
  assert.ok(failed.response.nextStep);
  missing.panel.dispose();
  board.panel.dispose();
  log('tableViz: a missing table shows a plain error');
};
