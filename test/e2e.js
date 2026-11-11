'use strict';
// End-to-end test. Runs inside a real VS Code extension host against the mock
// Databricks server; see test/run-e2e.sh for how it is launched.
const vscode = require('vscode');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NOTEBOOK_TYPE = 'dbx-notebook';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function startMock() {
  const proc = spawn('python3', [path.join(__dirname, 'mock_databricks.py')]);
  return new Promise((resolve, reject) => {
    proc.stdout.once('data', (d) => resolve({ proc, port: Number(String(d).trim()) }));
    proc.once('error', reject);
    proc.stderr.on('data', (d) => console.error(`mock: ${d}`));
  });
}

const outputText = (cell, mime = 'text/plain') =>
  cell.outputs
    .flatMap((o) => o.items)
    .filter((i) => i.mime === mime)
    .map((i) => new TextDecoder().decode(i.data))
    .join('\n');

async function runAll(nb, range) {
  if (range) await vscode.commands.executeCommand('notebook.cell.execute', { ranges: [range], document: nb.uri });
  else await vscode.commands.executeCommand('notebook.execute', nb.uri);
}

async function main(log) {
  const work = process.env.DBX_E2E_DIR;
  fs.cpSync(path.join(__dirname, '..', 'samples'), work, { recursive: true });
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
    lines.push('PASS');
  } catch (e) {
    lines.push('FAIL ' + (e.stack || e));
    throw e;
  } finally {
    mock.proc.kill();
    fs.writeFileSync(process.env.DBX_E2E_RESULT, lines.join('\n') + '\n');
  }
};
