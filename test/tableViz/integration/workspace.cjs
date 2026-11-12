'use strict';
/**
 * Test the table visualization feature in a real VS Code window, with a fake Databricks workspace.
 *
 * The steps cover the path from a command of VS Code to Databricks and back:
 * the session and the tree (src/tableViz/host/session.ts, tree.ts), the
 * workspace client, the two runners and the SQL profiler.
 *
 * test/e2e.js calls main() after the steps of demo.cjs. Run it with
 * `npm run test:e2e`. That command builds dist/test/fakeWorkspace.cjs, which
 * this file loads. `npm run test:vsix` runs the same steps on the installed
 * copy of the extension.
 *
 * The fake workspace (test/tableViz/fake/workspace.ts) is an HTTP server on
 * this computer. The feature talks to it as it talks to Databricks: it lists
 * the catalog with the REST API, runs SQL statements on a warehouse, and
 * cancels a statement. The fake answers the statements from the demo tables,
 * so the test knows the correct numbers.
 *
 * For a cluster, a fake of the SQL driver (test/tableViz/fake/driver.ts)
 * takes the place of the real driver. The test loads the real driver one
 * time, but does not connect with it.
 *
 * One thing has no test here: the question "Start the warehouse?". It is a
 * modal dialog, and a test cannot click it.
 */
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');

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
 * const overview = await until('the overview numbers', () => answerOf(board, 'overview'));
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
 * Find the first request of a type that a board got a result for.
 *
 * @example
 * answerOf(board, 'overview').response.result.rowCount   // 110000
 *
 * @param {{ dispatcher: { exchanges: object[] } }} board  A board from a command of the feature.
 * @param {string} type  The type of the request, for example 'overview'.
 * @returns {{ id: string, request: object, response: object } | undefined}  The request and its answer. undefined while no such request is done.
 */
const answerOf = (board, type) => board.dispatcher.exchanges.find((x) => x.request.type === type && x.response && x.response.type === 'result');

/**
 * Do the test steps. Stop at the first step that fails.
 *
 * @param {(message: string) => void} log  Call it after each step that passed.
 */
exports.main = async function main(log) {
  // The build makes this file from test/tableViz/fake/workspace.ts. VS Code cannot load a TypeScript file.
  const { startFakeWorkspace } = require(path.join(__dirname, '..', '..', '..', 'dist', 'test', 'fakeWorkspace.cjs'));
  const fake = await startFakeWorkspace();
  const api = await vscode.commands.executeCommand('dbxNotebook.tableViz._api');
  const settings = vscode.workspace.getConfiguration('dbxNotebook.tableViz');
  // The connection of the notebooks reads these variables. Point it at the fake workspace.
  const saved = { host: process.env.DATABRICKS_HOST, token: process.env.DATABRICKS_TOKEN };
  process.env.DATABRICKS_HOST = fake.url;
  process.env.DATABRICKS_TOKEN = 'fake-token';
  const boards = [];
  try {
    // 1. Select the connection of the notebooks and the warehouse that runs.
    await api.session.select('@workspace', { kind: 'warehouse', id: 'wh-run', name: 'Fake running' });
    assert.strictEqual(api.session.profile, '@workspace');
    assert.strictEqual(api.session.hostOf('@workspace'), fake.url);
    assert.deepStrictEqual(api.session.compute('@workspace'), { kind: 'warehouse', id: 'wh-run', name: 'Fake running' });

    // 2. The tree lists the catalog with the REST API. It sends no SQL.
    const root = await api.tree.getChildren();
    const catalog = root.find((n) => n.kind === 'catalog' && n.catalog === 'demo');
    assert.ok(catalog, 'the tree shows the catalog of the workspace');
    const [schema] = await api.tree.getChildren(catalog);
    assert.strictEqual(schema.schema, 'shop');
    const tables = await api.tree.getChildren(schema);
    assert.deepStrictEqual(tables.map((n) => n.table.name), ['orders_2025', 'orders_2026']);
    assert.strictEqual(api.tree.getTreeItem(tables[1]).command.command, 'dbxNotebook.tableViz.visualizeNode');
    assert.strictEqual(fake.statements.length, 0, 'browsing sends no SQL statement');
    log('tableViz: the tree lists catalogs, schemas and tables without SQL');

    // 3. "Visualize" on a table: the board gets its numbers from SQL statements on the warehouse.
    const board = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeNode', tables[1]);
    boards.push(board);
    const details = (await until('the table details', () => answerOf(board, 'tableDetails'))).response.result;
    assert.deepStrictEqual([details.columns.length, details.version, details.sizeBytes], [18, '42', 3771332]);
    const overview = await until('the overview numbers', () => answerOf(board, 'overview'));
    assert.strictEqual(overview.response.result.rowCount, 110000);
    assert.strictEqual(overview.response.result.approximate, true, 'distinct counts from Databricks are estimates');
    assert.strictEqual(overview.request.dataset.profile, '@workspace');
    assert.deepStrictEqual(overview.request.dataset.version, { kind: 'version', n: '42' }, 'the queries read the Delta version of the table details');
    const byName = Object.fromEntries(overview.response.result.columns.map((c) => [c.name, c]));
    assert.strictEqual(byName.order_id.max, '5001109999');
    assert.strictEqual(byName.channel.distinct, 4);
    assert.ok(overview.response.result.sql[0].includes('FROM IDENTIFIER(:tbl) VERSION AS OF 42'));
    assert.ok(fake.statements.length >= 3, 'the workspace received SQL statements');
    assert.ok(fake.statements.every((s) => s.warehouse_id === 'wh-run' && JSON.stringify(s.query_tags) === '[{"key":"feature","value":"table-viz"}]'));
    assert.ok(fake.statements.every((s) => /^(SELECT|DESCRIBE)\b/.test(s.statement)), 'each statement reads data only');
    assert.ok(!board.dispatcher.exchanges.some((x) => x.response && x.response.type === 'error'), 'no request failed');
    log('tableViz: a board gets correct numbers from SQL statements on a warehouse');

    // 4. The same request a second time comes from the cache: no new statement.
    // The page sends its own requests at the same time, so count only the statements of this request (21 values of "status").
    const count = () =>
      fake.statements.filter((s) => s.statement.includes('sum(`n`) OVER ()') && s.parameters.some((p) => p.name === 'limit' && p.value === '21') && s.parameters.some((p) => p.value === '`status`')).length;
    const request = { type: 'frequency', dataset: overview.request.dataset, columns: [{ name: 'status', typeText: 'string' }], top: 20 };
    assert.strictEqual(count(), 0);
    await board.dispatcher.handle({ type: 'request', id: 'cache-1', request });
    await board.dispatcher.handle({ type: 'request', id: 'cache-2', request });
    assert.strictEqual(count(), 1);
    await board.dispatcher.handle({ type: 'request', id: 'cache-3', request, refresh: true });
    assert.strictEqual(count(), 2, '"Refresh" runs the statement again');
    log('tableViz: the cache answers a repeated request, and refresh runs it again');

    // 5. Recent tables and favorites.
    assert.deepStrictEqual(api.tree.recents, ['demo.shop.orders_2026']);
    await vscode.commands.executeCommand('dbxNotebook.tableViz.addFavorite', tables[0]);
    const groups = (await api.tree.getChildren()).filter((n) => n.kind === 'group').map((n) => n.group);
    assert.deepStrictEqual(groups, ['favorites', 'recents']);
    const favorite = (await api.tree.getChildren({ kind: 'group', group: 'favorites' }))[0];
    assert.strictEqual(api.tree.getTreeItem(favorite).label, 'demo.shop.orders_2025');
    await vscode.commands.executeCommand('dbxNotebook.tableViz.removeFavorite', favorite);
    assert.deepStrictEqual(api.tree.favorites, []);
    log('tableViz: the tree keeps favorites and recent tables');

    // 6. "Visualize Table Under Cursor" in a SQL file.
    const document = await vscode.workspace.openTextDocument({ language: 'sql', content: 'SELECT *\nFROM demo.shop.orders_2025 o\nWHERE 1 = 1\n' });
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(1, 12, 1, 12);
    const second = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTableUnderCursor');
    boards.push(second);
    assert.strictEqual(second.datasets.a.table.name, 'orders_2025');
    editor.selection = new vscode.Selection(0, 3, 0, 3);
    assert.strictEqual(await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTableUnderCursor'), undefined);
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    log('tableViz: Visualize Table Under Cursor opens the table at the cursor');

    // 7. Cancel: the workspace gets a cancel request, and the board gets "cancelled".
    fake.hold = true;
    fake.requests.length = 0;
    const slow = { type: 'validateFilter', dataset: { ...overview.request.dataset, filter: '1 = 1' } };
    const running = board.dispatcher.handle({ type: 'request', id: 'to-cancel', request: slow });
    await until('the statement to run', () => fake.requests.some((r) => r.startsWith('GET /api/2.0/sql/statements/')));
    await board.dispatcher.handle({ type: 'cancel', id: 'to-cancel' });
    await running;
    fake.hold = false;
    assert.strictEqual(board.dispatcher.exchanges.find((x) => x.id === 'to-cancel').response.type, 'cancelled');
    assert.ok(fake.requests.some((r) => /^POST \/api\/2\.0\/sql\/statements\/st-\d+\/cancel$/.test(r)), 'the workspace received the cancel');
    log('tableViz: a cancel stops the statement on the workspace');

    // 8. A table that does not exist gives a plain message.
    const missing = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'demo.shop.orders_1999');
    boards.push(missing);
    const failed = await until('the error for a missing table', () => missing.dispatcher.exchanges.find((x) => x.response && x.response.type === 'error'));
    assert.strictEqual(failed.response.message, 'The table demo.shop.orders_1999 does not exist, or you are not permitted to see it.');
    assert.ok(failed.response.nextStep);
    log('tableViz: an error from the workspace becomes a plain message');

    // 9. A stopped warehouse, with the question turned off: the statement starts it.
    await settings.update('confirmComputeStart', false, vscode.ConfigurationTarget.Global);
    await api.session.select('@workspace', { kind: 'warehouse', id: 'wh-stop', name: 'Fake stopped' });
    const third = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'demo.shop.orders_2025');
    boards.push(third);
    await until('the overview on the second warehouse', () => answerOf(third, 'overview'));
    assert.strictEqual(fake.warehouses['wh-stop'].state, 'RUNNING');
    assert.strictEqual(api.session.computeState, 'STOPPED', 'the status bar has the state from before the start');
    assert.ok(fake.statements.some((s) => s.warehouse_id === 'wh-stop'));
    log('tableViz: a statement starts a stopped warehouse when the question is off');

    // 10. The SQL driver for clusters is in the built extension, and it loads in VS Code.
    const extensionPath = vscode.extensions.getExtension('local.dbx-notebook').extensionPath;
    // Tell if Node.js loaded dist/tableViz/driver.js, the file that contains the SQL driver.
    const driverLoaded = () => Object.keys(require.cache).some((key) => key.startsWith(extensionPath) && key.endsWith(path.join('dist', 'tableViz', 'driver.js')));
    assert.ok(!driverLoaded(), 'boards on a SQL warehouse do not load the driver');
    const driver = await api.session.loadDriver();
    assert.ok(driverLoaded());
    assert.strictEqual(typeof driver.DBSQLClient, 'function');
    assert.strictEqual(typeof driver.DBSQLParameter, 'function');
    log('tableViz: the SQL driver for clusters loads in VS Code');

    // 11. A cluster: the board gets its numbers through the cluster runner. A fake driver takes the place of the real one.
    const { makeFakeDriver } = require(path.join(__dirname, '..', '..', '..', 'dist', 'test', 'fakeWorkspace.cjs'));
    const fakeDriver = makeFakeDriver();
    const realDriver = api.session.loadDriver;
    api.session.loadDriver = () => fakeDriver.module;
    api.session.clusterPollMs = 50;
    try {
      await api.session.select('@workspace', { kind: 'cluster', id: 'cl-ok', name: 'Fake dedicated' });
      const onCluster = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'demo.shop.orders_2026');
      boards.push(onCluster);
      const clusterOverview = await until('the overview on the cluster', () => answerOf(onCluster, 'overview'));
      assert.strictEqual(clusterOverview.response.result.rowCount, 110000);
      assert.strictEqual(Object.fromEntries(clusterOverview.response.result.columns.map((c) => [c.name, c])).order_id.max, '5001109999');
      assert.strictEqual(fakeDriver.connects.length, 1, 'one connection for all statements');
      assert.strictEqual(fakeDriver.connects[0].path, 'sql/protocolv1/o/1234567890123456/cl-ok', 'the HTTP path has the workspace ID from the REST answers');
      assert.strictEqual(fakeDriver.connects[0].host, fake.url.replace('http://', ''));
      assert.strictEqual(fakeDriver.connects[0].telemetryEnabled, false);
      assert.deepStrictEqual(fakeDriver.sessions[0], { feature: 'table-viz' });
      assert.ok(fakeDriver.statements.every((s) => s.options.useCloudFetch === false));
      log('tableViz: a board gets correct numbers through the cluster runner');

      // 12. A cluster that cannot read Unity Catalog, and one with an old runtime, are refused with the reason.
      for (const [id, reason] of [['cl-open', /cannot read Unity Catalog/], ['cl-old', /Runtime 12\.2/]]) {
        await api.session.select('@workspace', { kind: 'cluster', id, name: id });
        const refused = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'demo.shop.orders_2025');
        boards.push(refused);
        const error = await until(`the error for ${id}`, () => refused.dispatcher.exchanges.find((x) => x.request.type === 'overview' && x.response && x.response.type === 'error'));
        assert.match(error.response.message, /cannot run the queries of this feature/);
        assert.match(error.response.nextStep, reason);
      }
      assert.strictEqual(fakeDriver.connects.length, 1, 'no connection to a cluster that is refused');
      log('tableViz: a cluster with a wrong access mode or an old runtime is refused');

      // 13. A stopped cluster, with the question turned off: the extension starts it and waits until it runs.
      await api.session.select('@workspace', { kind: 'cluster', id: 'cl-stop', name: 'Fake stopped' });
      fake.requests.length = 0;
      const started = await vscode.commands.executeCommand('dbxNotebook.tableViz.visualizeTable', 'demo.shop.orders_2025');
      boards.push(started);
      await until('the overview on the started cluster', () => answerOf(started, 'overview'));
      assert.ok(fake.requests.includes('POST /api/2.1/clusters/start'));
      assert.strictEqual(fake.clusters['cl-stop'].state, 'RUNNING');
      assert.strictEqual(api.session.computeState, 'RUNNING');
      assert.strictEqual(fakeDriver.connects.at(-1).path, 'sql/protocolv1/o/1234567890123456/cl-stop');
      log('tableViz: the extension starts a stopped cluster and waits until it runs');
    } finally {
      api.session.loadDriver = realDriver;
    }
  } finally {
    boards.forEach((b) => b && b.panel.dispose());
    await settings.update('confirmComputeStart', undefined, vscode.ConfigurationTarget.Global);
    await api.session.select('Demo');
    process.env.DATABRICKS_HOST = saved.host;
    process.env.DATABRICKS_TOKEN = saved.token;
    fake.close();
  }
};
