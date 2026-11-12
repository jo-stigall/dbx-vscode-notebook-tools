'use strict';
/**
 * Test the full extension in a real VS Code window.
 *
 * Do not run this file directly. Run test/run-e2e.sh. That script starts
 * VS Code, and VS Code calls run() at the end of this file.
 *
 * The test uses the fake Databricks server (test/mock_databricks.py), not a
 * real cluster. It does what a person does: open samples/demo.py, run cells,
 * edit a cell, save the file. After each step it checks the cells, the
 * outputs or the file on disk.
 *
 * The test writes one line for each step that passed to the result file:
 *
 *     ok   auto-opens as a notebook
 *     ok   parses cells
 *     ...
 *     PASS
 */
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NOTEBOOK_TYPE = 'dbx-notebook';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a condition is true. Check the condition 10 times each second.
 *
 * @example
 * await until('the cell to finish', () => cell.executionSummary && cell.executionSummary.success);
 *
 * @param {string} what  The thing that you wait for. The error message contains this text.
 * @param {() => any} fn  Returns a true value when the condition is true.
 * @param {number} [timeout]  The longest time to wait, in milliseconds.
 * @returns {Promise<any>}  The value that `fn` returned.
 * @throws {Error}  If the condition is not true after `timeout`.
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
 * Start the fake Databricks server on a free port.
 *
 * @returns {Promise<{ proc: import('child_process').ChildProcess, port: number }>}  The server process and its port. Call `proc.kill()` to stop the server.
 */
function startMock() {
  const proc = spawn('python3', [path.join(__dirname, 'mock_databricks.py')]);
  return new Promise((resolve, reject) => {
    proc.stdout.once('data', (d) => resolve({ proc, port: Number(String(d).trim()) }));
    proc.once('error', reject);
    proc.stderr.on('data', (d) => console.error(`mock: ${d}`));
  });
}

/**
 * Get the output of a cell as text.
 *
 * @example
 * outputText(cell)                // 'hello, world'
 * outputText(cell, 'text/html')   // '<table ...'
 *
 * @param {vscode.NotebookCell} cell
 * @param {string} [mime]  The output type to read. An error has the type 'application/vnd.code.notebook.error'.
 * @returns {string}  Empty if the cell has no output of this type.
 */
const outputText = (cell, mime = 'text/plain') =>
  cell.outputs
    .flatMap((o) => o.items)
    .filter((i) => i.mime === mime)
    .map((i) => new TextDecoder().decode(i.data))
    .join('\n');

/**
 * Tell VS Code to run cells. The promise ends when the cells are done.
 *
 * To do something while a cell runs, do not wait for the promise immediately.
 *
 * @example
 * await runAll(nb);                       // run all cells
 * await runAll(nb, { start: 2, end: 3 }); // run the third cell only
 *
 * const running = runAll(nb, { start: 2, end: 3 });
 * // ... stop the cell here ...
 * await running;
 *
 * @param {vscode.NotebookDocument} nb
 * @param {{ start: number, end: number }} [range]  The cells to run. `start` is the first cell (0 = top). `end` is the cell after the last one.
 */
async function runAll(nb, range) {
  if (range) await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [range], document: nb.uri });
  else await vscode.commands.executeCommand('notebook.execute', nb.uri);
}

/**
 * Send a request to the fake server. Use it for the two test requests of the server.
 *
 * @example
 * await mock('POST', '/mock/config', { context_delay: 3 });   // a new session takes 3 seconds to start
 * await mock('POST', '/mock/requests');                        // forget the requests until now
 * await mock('GET', '/mock/requests');                         // ['POST /api/1.2/contexts/create', ...]
 *
 * @param {'GET'|'POST'} method
 * @param {string} urlPath
 * @param {object} [body]
 * @returns {Promise<any>}  The JSON answer of the server.
 */
async function mock(method, urlPath, body) {
  const res = await fetch(process.env.DATABRICKS_HOST + urlPath, { method, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

/**
 * Do all test steps. Stop at the first step that fails.
 *
 * @param {(message: string) => void} log  Call it after each step that passed.
 */
async function main(log) {
  const work = process.env.DBX_E2E_DIR;
  fs.cpSync(path.join(__dirname, '..', 'samples'), work, { recursive: true });

  // 0. Which copy of the extension runs: the files of this folder, or the copy that test/run-vsix.sh installed from the .vsix file.
  const extension = vscode.extensions.getExtension('local.dbx-notebook');
  assert.ok(extension, 'the extension is installed');
  if (process.env.DBX_E2E_EXPECT_PATH) {
    assert.ok(extension.extensionPath.startsWith(process.env.DBX_E2E_EXPECT_PATH), `the installed copy runs, not ${extension.extensionPath}`);
    log('runs the copy that was installed from the .vsix file');
  }
  await extension.activate();
  // The table feature is a separate file. The start of the extension must not load it.
  const loaded = (file) => Object.keys(require.cache).some((key) => key.startsWith(extension.extensionPath) && key.endsWith(path.join('dist', 'tableViz', file)));
  assert.ok(!loaded('host.js') && !loaded('driver.js'), 'the start of the extension does not load the table feature');
  log('the start of the extension does not load the table feature');
  const file = path.join(work, 'demo.py');
  const original = fs.readFileSync(file, 'utf8');
  const uri = vscode.Uri.file(file);

  // 1. Opening the .py as text switches to the notebook UI.
  await vscode.window.showTextDocument(uri);
  const editor = await until('notebook editor', () => {
    const e = vscode.window.activeNotebookEditor;
    return e && e.notebook.notebookType === NOTEBOOK_TYPE && e.notebook.uri.fsPath === uri.fsPath && e;
  });
  const nb = editor.notebook;
  await until(
    'the text tab to be replaced by the notebook',
    () => !vscode.window.tabGroups.all.flatMap((g) => g.tabs).some((t) => t.input instanceof vscode.TabInputText),
    5000
  );
  log('auto-opens as a notebook');

  // 2. Cells are parsed correctly.
  const cells = nb.getCells();
  assert.deepStrictEqual(
    cells.map((c) => [c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code', c.document.languageId]),
    [['markdown', 'markdown'], ['code', 'python'], ['code', 'python'], ['code', 'sql'], ['code', 'python']]
  );
  assert.strictEqual(cells[1].document.getText(), '%run ./helpers/setup');
  assert.strictEqual(cells[3].document.getText(), "select 1 as id, 'a' as label");
  log('parses cells');

  // 3. Run All executes on the "cluster", including a nested %run.
  await vscode.commands.executeCommand('notebook.selectKernel', { id: 'dbx-cluster', extension: 'local.dbx-notebook' });
  await runAll(nb);
  const code = cells.filter((c) => c.kind === vscode.NotebookCellKind.Code);
  await until('cells to finish', () => code.every((c) => c.executionSummary && c.executionSummary.success !== undefined));
  assert.ok(code.every((c) => c.executionSummary.success), 'all cells succeed: ' + code.map((c) => outputText(c, 'application/vnd.code.notebook.error')).join(' | '));
  assert.strictEqual(outputText(cells[2]), 'hello, world'); // function from ./helpers/setup, constant from its own %run
  assert.ok(outputText(cells[3], 'text/html').includes('<th') && outputText(cells[3]).includes('id\tlabel\n1\ta'));
  assert.strictEqual(outputText(cells[4]), 'id\n0\n1\n2');
  assert.deepStrictEqual(code.map((c) => c.executionSummary.executionOrder), [1, 2, 3, 4]);
  log('runs all cells with nested %run, SQL and display()');

  // 4. Running did not dirty the file; outputs are not saved.
  assert.strictEqual(nb.isDirty, false);

  // 5. Edit one cell and save: only that line changes on disk.
  const doc = cells[2].document;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), 'print(greeting("there"))');
  await vscode.workspace.applyEdit(edit);
  await nb.save();
  assert.strictEqual(fs.readFileSync(file, 'utf8'), original.replace('"world"', '"there"'));
  log('saves an edit with a minimal diff');

  // 6. State persists between runs, and a single cell can be run on its own.
  await runAll(nb, { start: 2, end: 3 });
  await until('re-run', () => outputText(cells[2]) === 'hello, there');
  log('re-runs a single cell with kept state');

  // 6b. Partial output reported while a command is running is shown, then replaced by the final text.
  const seen = new Set();
  const watch = vscode.workspace.onDidChangeNotebookDocument(() => seen.add(outputText(cells[2])));
  const slow = new vscode.WorkspaceEdit();
  slow.replace(
    doc.uri,
    new vscode.Range(0, 0, doc.lineCount, 0),
    'import time\nprint("tick 1")\ntime.sleep(1.5)\nprint("tick 2")\ntime.sleep(1.5)\nprint("tick 3")'
  );
  await vscode.workspace.applyEdit(slow);
  await runAll(nb, { start: 2, end: 3 });
  await until('streamed cell', () => outputText(cells[2]) === 'tick 1\ntick 2\ntick 3' && cells[2].executionSummary.success);
  watch.dispose();
  assert.ok(seen.has('tick 1') && seen.has('tick 1\ntick 2'), 'partial output was shown: ' + JSON.stringify([...seen]));
  assert.strictEqual(cells[2].outputs.length, 1, 'partial output is replaced, not duplicated');
  log('streams partial output while a cell runs');

  // 6c. Python pasted into a SQL cell fails loudly instead of showing a stale-looking result.
  const sqlDoc = cells[3].document;
  const wrong = new vscode.WorkspaceEdit();
  wrong.replace(sqlDoc.uri, new vscode.Range(0, 0, sqlDoc.lineCount, 0), 'for i in range(3):\n    print(i)');
  await vscode.workspace.applyEdit(wrong);
  await runAll(nb, { start: 3, end: 4 });
  await until('SQL failure', () => cells[3].executionSummary && cells[3].executionSummary.success === false);
  assert.ok(outputText(cells[3], 'application/vnd.code.notebook.error').includes('SQL error'));
  const undo = new vscode.WorkspaceEdit();
  undo.replace(sqlDoc.uri, new vscode.Range(0, 0, sqlDoc.lineCount, 0), "select 1 as id, 'a' as label");
  await vscode.workspace.applyEdit(undo);
  log('reports Python in a SQL cell as an error');

  // 7. Errors are reported as failures (Copilot's run tool relies on this).
  const bad = new vscode.WorkspaceEdit();
  bad.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), 'raise ValueError("boom")');
  await vscode.workspace.applyEdit(bad);
  await runAll(nb, { start: 2, end: 3 });
  await until('failure', () => cells[2].executionSummary && cells[2].executionSummary.success === false);
  assert.ok(outputText(cells[2], 'application/vnd.code.notebook.error').includes('ValueError: boom'));
  log('reports cell errors');

  // 7b. Stop while the session on the cluster starts: the cell must not run.
  const sent = async (request) => (await mock('GET', '/mock/requests')).includes(request);
  const quick = new vscode.WorkspaceEdit();
  quick.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), 'print("must not run")');
  await vscode.workspace.applyEdit(quick);
  await vscode.commands.executeCommand('dbxNotebook.resetContext');
  await mock('POST', '/mock/config', { context_delay: 2 });
  await mock('POST', '/mock/requests');
  let running = runAll(nb, { start: 2, end: 3 });
  await until('the session to start', () => sent('POST /api/1.2/contexts/create'));
  await vscode.commands.executeCommand('notebook.cell.cancelExecution', { ranges: [{ start: 2, end: 3 }], document: nb.uri });
  await running;
  assert.strictEqual(outputText(cells[2]), 'Cancelled.');
  assert.ok(!(await sent('POST /api/1.2/commands/execute')), 'a stopped cell is not sent to the cluster');
  log('does not run a cell that you stop while the session starts');

  // 7c. Reset while the session starts: the cell must not run, and the cluster must not keep the new session.
  await vscode.commands.executeCommand('dbxNotebook.resetContext');
  await mock('POST', '/mock/requests');
  running = runAll(nb, { start: 2, end: 3 });
  await until('the session to start', () => sent('POST /api/1.2/contexts/create'));
  await vscode.commands.executeCommand('dbxNotebook.resetContext');
  await running;
  assert.strictEqual(outputText(cells[2]), 'Cancelled.');
  assert.ok(!(await sent('POST /api/1.2/commands/execute')), 'a cell is not sent to the cluster after a reset');
  assert.ok(await sent('POST /api/1.2/contexts/destroy'), 'the session that started during the reset is deleted');
  await mock('POST', '/mock/config', { context_delay: 0 });
  log('deletes a session that you reset while it starts');

  // 7d. Stop while the cluster accepts the command: the kernel must cancel the command when it gets the ID.
  await mock('POST', '/mock/config', { execute_delay: 2 });
  await mock('POST', '/mock/requests');
  running = runAll(nb, { start: 2, end: 3 });
  await until('the command to be sent', () => sent('POST /api/1.2/commands/execute'));
  await vscode.commands.executeCommand('notebook.cell.cancelExecution', { ranges: [{ start: 2, end: 3 }], document: nb.uri });
  await running;
  assert.strictEqual(outputText(cells[2]), 'Cancelled.');
  assert.ok(await sent('POST /api/1.2/commands/cancel'), 'the command is cancelled on the cluster');
  await mock('POST', '/mock/config', { execute_delay: 0 });
  log('cancels a command that you stop while the cluster accepts it');

  // 8. Adding cells through the notebook API (what Copilot's edit tool does) saves in Databricks format.
  const add = new vscode.WorkspaceEdit();
  add.set(nb.uri, [
    vscode.NotebookEdit.insertCells(nb.cellCount, [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'select 2', 'sql'),
      new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '## Notes', 'markdown'),
    ]),
  ]);
  await vscode.workspace.applyEdit(add);
  await nb.save();
  assert.ok(
    fs.readFileSync(file, 'utf8').endsWith(
      'display(df)\n\n# COMMAND ----------\n\n# MAGIC %sql\n# MAGIC select 2\n\n# COMMAND ----------\n\n# MAGIC %md\n# MAGIC ## Notes\n'
    )
  );
  log('writes new cells in Databricks format');

  // 9. "Reopen with text editor" sticks instead of bouncing back to the notebook.
  await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
  await sleep(2500);
  assert.ok(vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri.fsPath === uri.fsPath, 'stays in the text editor');
  log('reopening as text sticks');
}

/**
 * Start the fake server, do the test steps and write the result file.
 *
 * VS Code calls this function. The function reads two environment variables
 * that test/run-e2e.sh sets:
 *
 * - DBX_E2E_DIR: an empty folder. The test copies the sample notebooks into it.
 * - DBX_E2E_RESULT: the path of the result file.
 *
 * The function points the extension at the fake server with the variables
 * DATABRICKS_HOST, DATABRICKS_TOKEN and DATABRICKS_CLUSTER_ID.
 */
exports.run = async () => {
  const lines = [];
  const log = (m) => lines.push('ok   ' + m);
  const mock = await startMock();
  process.env.DATABRICKS_HOST = `http://127.0.0.1:${mock.port}`;
  process.env.DATABRICKS_TOKEN = 'mock-token';
  process.env.DATABRICKS_CLUSTER_ID = 'mock';
  process.env.DATABRICKS_CONFIG_FILE = path.join(process.env.DBX_E2E_DIR, 'no-such-databrickscfg');
  try {
    await main(log);
    // The steps for the table visualization feature are in their own file.
    await require('./tableViz/integration/demo.cjs').main(log);
    await require('./tableViz/integration/workspace.cjs').main(log);
    lines.push('PASS');
  } catch (e) {
    lines.push('FAIL ' + (e.stack || e));
    throw e;
  } finally {
    mock.proc.kill();
    fs.writeFileSync(process.env.DBX_E2E_RESULT, lines.join('\n') + '\n');
  }
};
