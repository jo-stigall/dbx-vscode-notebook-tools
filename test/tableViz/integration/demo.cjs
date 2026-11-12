'use strict';
/**
 * Test the table visualization feature in a real VS Code window, with the Demo profile.
 *
 * The steps cover the code of the extension host (src/tableViz/host/index.ts
 * and board.ts): the commands, the board panel, saved views, and the question
 * that a saved view asks before it runs a query.
 *
 * test/e2e.js calls main() after its own steps. Run it with test/run-e2e.sh
 * (or `npm run test:e2e`, which builds the feature first). `npm run test:vsix`
 * runs the same steps on the installed copy of the extension.
 *
 * The test opens a board with the command "Visualize Table". The board is a
 * webview. The test cannot look into the webview, but it can read the
 * requests that the webview sent to the extension host and the answers. A
 * request from the webview shows that the page loaded and ran with its
 * Content Security Policy.
 *
 * The command `dbxNotebook.tableViz._api` gives the test the objects of the
 * feature: the session, the open boards and the tree. Users do not see this
 * command.
 */
const vscode = require('vscode');
const assert = require('assert');

/**
 * Wait for a time.
 *
 * @param {number} ms  The time in milliseconds.
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `fn` returns a true value. Check 10 times each second.
 *
 * @example
 * const overview = await until('the overview numbers', () => answer('overview'));
 *
 * @template T
 * @param {string} what  The thing that the test waits for. The error message contains this text.
 * @param {() => T | Promise<T>} fn  The check.
 * @param {number} [timeout]  The longest time to wait, in milliseconds. Default: 20000.
 * @returns {Promise<T>}  The first true value that `fn` returned.
 * @throws {Error}  "timed out waiting for the overview numbers", if `fn` returns no true value in that time.
 */
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
  // The first command of the feature loads its code. The SQL driver for clusters stays unloaded.
  const extensionPath = vscode.extensions.getExtension('local.dbx-notebook').extensionPath;
  // Tell if Node.js loaded a file of the feature, for example 'host.js' for dist/tableViz/host.js.
  const loaded = (file) => Object.keys(require.cache).some((key) => key.startsWith(extensionPath) && key.endsWith(require('path').join('dist', 'tableViz', file)));
  // Use the Demo profile. Without this, the feature uses the connection of the notebooks, which the other steps set.
  const api = await vscode.commands.executeCommand('dbxNotebook.tableViz._api');
  assert.ok(loaded('host.js'), 'a command of the feature loads its code');
  assert.ok(!loaded('driver.js'), 'the SQL driver is not loaded until the user selects a cluster');
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
  // Find the first request of a type that has a result. undefined while no such request is done.
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
  // Get the requests of a type on a table that have a result, for example ('overview', 'orders_2025').
  const sent = (type, table) => compared.dispatcher.exchanges.filter((x) => x.request.type === type && x.request.dataset.table.name === table && x.response && x.response.type === 'result');
  await until('the overviews of A and B', () => sent('overview', 'orders_2025').length && sent('overview', 'orders_2026').length);
  // The page computes the drift of each pair. For a number column it asks for the deciles of A, then for the bins of A and B.
  await until('the drift bins of A and B', () => sent('driftBins', 'orders_2025').length >= 5 && sent('driftBins', 'orders_2026').length >= 5);
  assert.strictEqual(sent('quantiles', 'orders_2026').length, 0, 'the cut points come from A only');
  assert.ok(sent('frequency', 'orders_2025').length >= 4 && sent('frequency', 'orders_2026').length >= 4);
  assert.ok(!compared.dispatcher.exchanges.some((x) => x.response && x.response.type === 'error'), 'no request failed');
  compared.panel.dispose();
  log('tableViz: Compare Tables opens a board that reads A and B');

  // 2d. A saved view. Save a board with a filter chip and a card, then open the file.
  const fs = require('fs');
  const path = require('path');
  const viewFile = vscode.Uri.file(path.join(process.env.DBX_E2E_DIR, 'orders.tableviz.json'));
  const chip = { op: 'eq', column: { name: 'region', typeText: 'string' }, value: 'EMEA' };
  const state = {
    datasets: { a: { ...dataset, chips: [chip] } },
    ui: { search: '', sort: 'nulls' },
    cards: [{ column: 'amount', pinned: true, bins: 12 }],
  };
  await board.saveView(state, viewFile);
  const written = JSON.parse(fs.readFileSync(viewFile.fsPath, 'utf8'));
  assert.deepStrictEqual(written, { tableViz: 1, ...state });
  assert.ok(!/token|rowCount|"values"/.test(fs.readFileSync(viewFile.fsPath, 'utf8')), 'the file has no token and no data');

  // The board saved this file, so the extension knows its content: it opens with no question.
  // Wait for the board that VS Code opens for the file of a saved view. `board` is the board that saved the file, so skip it.
  const boardOf = async (uri) => until('the board of the view', () => [...api.boards].find((b) => b.viewUri && b.viewUri.fsPath === uri.fsPath && b !== board));
  await vscode.commands.executeCommand('vscode.openWith', viewFile, 'dbxNotebook.tableViz.view');
  const restored = await boardOf(viewFile);
  assert.strictEqual(restored.approved, true);
  // Find the first request of a type that a board got a result for.
  const done = (b, type) => b.dispatcher.exchanges.find((x) => x.request.type === type && x.response && x.response.type === 'result');
  // The page asks for the numbers of the saved card, with the saved filter chip and the saved number of bins.
  const histogram = await until('the histogram of the saved card', () => restored.dispatcher.exchanges.find((x) => x.request.type === 'histogram' && x.request.edges.bins === 12 && x.response));
  assert.deepStrictEqual(histogram.request.dataset.chips, [chip]);
  // The row count of the filtered board is the count of the value EMEA in the board that has no filter.
  await board.dispatcher.handle({ type: 'request', id: 'emea', request: { type: 'frequency', dataset, columns: [{ name: 'region', typeText: 'string' }], top: 10 } });
  const emea = exchanges.find((x) => x.id === 'emea').response.result.values.find((v) => v.value === 'EMEA').count;
  assert.strictEqual((await until('the overview of the saved view', () => done(restored, 'overview'))).response.result.rowCount, emea);
  restored.panel.dispose();
  log('tableViz: a saved view opens again with its filter and its card');

  // A file that the extension did not see before: the board shows the datasets and runs nothing until the user permits it.
  const foreign = vscode.Uri.file(path.join(process.env.DBX_E2E_DIR, 'from-a-colleague.tableviz.json'));
  fs.writeFileSync(foreign.fsPath, JSON.stringify({ tableViz: 1, datasets: { a: { ...dataset, filter: '1 = 1' } }, cards: [{ column: 'channel', pinned: false }] }));
  await vscode.commands.executeCommand('vscode.openWith', foreign, 'dbxNotebook.tableViz.view');
  const waiting = await boardOf(foreign);
  await until('the page of the view', () => waiting.ready);
  assert.strictEqual(waiting.approved, false);
  await sleep(700);
  assert.strictEqual(waiting.dispatcher.exchanges.length, 0, 'the page sends no request before the user permits it');
  // A request that arrives too early is refused. No profiler runs.
  await waiting.dispatcher.handle({ type: 'request', id: 'early', request: { type: 'tableDetails', dataset } });
  assert.strictEqual(waiting.dispatcher.exchanges.length, 0);
  // The button "Run the Queries" sends this message.
  await waiting.dispatcher.handle({ type: 'approve' });
  assert.strictEqual(waiting.approved, true);
  await until('the requests after the permission', () => waiting.dispatcher.exchanges.some((x) => x.request.type === 'tableDetails'));
  waiting.panel.dispose();
  log('tableViz: a saved view from a different person asks before it runs a query');

  // After the permission, the same file opens with no question. In a workspace that is not trusted, it asks each time.
  await vscode.commands.executeCommand('vscode.openWith', foreign, 'dbxNotebook.tableViz.view');
  const again = await boardOf(foreign);
  assert.strictEqual(again.approved, true);
  again.panel.dispose();
  await until('the board to close', () => ![...api.boards].includes(again));
  const trusted = api.isTrusted;
  api.isTrusted = () => false;
  try {
    await vscode.commands.executeCommand('vscode.openWith', viewFile, 'dbxNotebook.tableViz.view');
    const untrusted = await boardOf(viewFile);
    assert.strictEqual(untrusted.approved, false, 'a workspace that is not trusted asks, also for a file that was permitted');
    await until('the page of the view', () => untrusted.ready);
    await sleep(500);
    assert.strictEqual(untrusted.dispatcher.exchanges.length, 0);
    untrusted.panel.dispose();
  } finally {
    api.isTrusted = trusted;
  }
  // A file that is not a saved view opens a page with a message, not a board.
  const broken = vscode.Uri.file(path.join(process.env.DBX_E2E_DIR, 'broken.tableviz.json'));
  fs.writeFileSync(broken.fsPath, '{ "tableViz": 1, "datasets": { "a": { "profile": "Demo", "table": "x" } }, "token": "dapi" }');
  const boardsBefore = api.boards.size;
  await vscode.commands.executeCommand('vscode.openWith', broken, 'dbxNotebook.tableViz.view');
  await sleep(500);
  assert.strictEqual(api.boards.size, boardsBefore, 'a file with a wrong shape makes no board');
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  log('tableViz: a workspace that is not trusted asks each time, and a wrong file makes no board');

  // 3. A name that is not a three-part name opens no board.
  // Count the webview tabs that are open.
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
