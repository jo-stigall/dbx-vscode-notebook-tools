'use strict';
/**
 * Tests for src/local_runner.py: the Python process of the kernel "Local Python".
 *
 * The tests start the script with `python3` and send it cells, as the kernel
 * does. They do not need VS Code, Databricks or Databricks Connect. To use a
 * different Python, set the variable DBX_TEST_PYTHON.
 *
 * Run:
 *
 *     node test/localRunner.test.js
 *
 * The script prints the number of tests that passed, for example "11 passed". It prints each failure
 * and exits with code 1 if a test fails.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const PYTHON = process.env.DBX_TEST_PYTHON || 'python3';
const RUNNER = path.join(__dirname, '..', 'src', 'local_runner.py');

/** A folder for the files of one test run. The script deletes it at the end. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-runner-test-'));

/**
 * Start the Python process and wait until it is ready.
 *
 * @example
 * const runner = await start();
 * const messages = await runner.run('python', 'print(1 + 1)');
 * // [{ id: 1, type: 'stream', text: '2\n' }, { id: 1, type: 'done', ok: true }]
 * runner.stop();
 *
 * @param {Object<string, string>} [env]  More environment variables for the process.
 * @returns {Promise<{ ready: object, proc: import('child_process').ChildProcess, run: Function, send: Function, next: Function, stop: Function }>}
 */
async function start(env = {}) {
  const proc = spawn(PYTHON, ['-u', RUNNER], { cwd: tmp, env: { ...process.env, ...env } });
  const messages = [];
  let wake = () => {};
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    messages.push(JSON.parse(line));
    wake();
  });
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));

  /** Wait for the next message of the process. */
  const next = async () => {
    const end = Date.now() + 20000;
    while (!messages.length) {
      if (Date.now() > end) throw new Error('no message from the Python process in 20 seconds. stderr: ' + stderr);
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 200);
      });
    }
    return messages.shift();
  };

  let id = 0;
  /** Send one cell. Do not wait for the answer. */
  const send = (language, code) => proc.stdin.write(JSON.stringify({ id: ++id, language, code }) + '\n');
  /** Send one cell and return all its messages. The last message has the type 'done'. */
  const run = async (language, code) => {
    send(language, code);
    const got = [];
    for (;;) {
      const m = await next();
      got.push(m);
      if (m.type === 'done') return got;
    }
  };
  return { ready: await next(), proc, run, send, next, stop: () => proc.kill(), stderr: () => stderr };
}

/** Get the text that a cell printed. */
const printed = (messages) => messages.filter((m) => m.type === 'stream').map((m) => m.text).join('');

/** Get the last message of a cell. */
const done = (messages) => messages[messages.length - 1];

const tests = [
  ['tells the kernel when it is ready', async (r) => {
    assert.strictEqual(r.ready.type, 'ready');
    assert.match(r.ready.python, /^3\.\d+/);
    assert.ok(path.isAbsolute(r.ready.executable));
  }],

  ['runs Python and keeps the variables between cells', async (r) => {
    assert.deepStrictEqual(await r.run('python', 'x = 20\nprint("set")'), [
      { id: 1, type: 'stream', text: 'set' },
      { id: 1, type: 'stream', text: '\n' },
      { id: 1, type: 'done', ok: true },
    ]);
    assert.strictEqual(printed(await r.run('python', 'print(x + 1)')), '21\n');
  }],

  ['prints the value of the last expression', async (r) => {
    assert.strictEqual(printed(await r.run('python', 'y = 2\ny * 21')), '42\n');
    assert.strictEqual(printed(await r.run('python', 'None')), '');
  }],

  ['reports an error with the line of the cell', async (r) => {
    const last = done(await r.run('python', 'a = 1\nraise ValueError("boom")'));
    assert.strictEqual(last.ok, false);
    assert.strictEqual(last.cancelled, false);
    assert.strictEqual(last.summary, 'ValueError: boom');
    assert.match(last.trace, /File "<cell>", line 2/);
    assert.match(last.trace, /raise ValueError\("boom"\)/);
    assert.doesNotMatch(last.trace, /local_runner\.py/);
    // The process continues after an error.
    assert.strictEqual(printed(await r.run('python', 'print(a)')), '1\n');
  }],

  ['imports a module from the folder of the notebook and from the project folder', async () => {
    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(tmp, 'beside.py'), 'VALUE = 1\n');
    fs.writeFileSync(path.join(project, 'in_project.py'), 'VALUE = 2\n');
    const r = await start({ DBX_NOTEBOOK_PATHS: project });
    try {
      assert.strictEqual(printed(await r.run('python', 'import beside, in_project\nprint(beside.VALUE + in_project.VALUE)')), '3\n');
    } finally {
      r.stop();
    }
  }],

  ['shows a list of dictionaries as a table', async (r) => {
    const [table] = await r.run('python', 'display([{"id": 1, "label": "a"}, {"id": 2, "label": None}])');
    assert.deepStrictEqual(table, {
      id: 1,
      type: 'table',
      schema: [{ name: 'id' }, { name: 'label' }],
      data: [[1, 'a'], [2, null]],
      truncated: false,
    });
  }],

  ['sends at most 1000 rows of a table', async (r) => {
    const [table] = await r.run('python', 'display([{"n": i} for i in range(1500)])');
    assert.strictEqual(table.data.length, 1000);
    assert.strictEqual(table.truncated, true);
  }],

  ['shows HTML', async (r) => {
    const [html] = await r.run('python', 'displayHTML("<b>hi</b>")');
    assert.deepStrictEqual(html, { id: 1, type: 'html', data: '<b>hi</b>' });
  }],

  ['runs SQL with spark.sql() and keeps the result in _sqldf', async (r) => {
    // A stand-in for the Spark session of Databricks Connect.
    await r.run('python', 'class FakeSpark:\n    def sql(self, text):\n        return [{"query": text}]\nspark = FakeSpark()');
    const [table] = await r.run('sql', 'select 1;\n');
    assert.deepStrictEqual(table.data, [['select 1']]);
    assert.strictEqual(printed(await r.run('python', 'print(_sqldf)')), "[{'query': 'select 1'}]\n");
  }],

  ['tells you the reason if spark is not available', async () => {
    // The test needs a Python that has no Databricks package.
    const r = await start();
    try {
      const messages = await r.run('python', 'import importlib.util\nprint(importlib.util.find_spec("databricks") is not None)');
      if (printed(messages) === 'True\n') return; // this Python has a Databricks package: the test cannot run
      const last = done(await r.run('sql', 'select 1'));
      assert.strictEqual(last.ok, false);
      assert.match(last.summary, /spark is not available: .*Install Databricks Connect in this Python/);
    } finally {
      r.stop();
    }
  }],

  ['runs shell commands and reports a failure', async (r) => {
    assert.strictEqual(printed(await r.run('shell', 'echo one\necho two')), 'one\ntwo\n');
    const last = done(await r.run('shell', 'exit 3'));
    assert.strictEqual(last.summary, 'RuntimeError: %sh exited with code 3');
  }],

  ['stops a cell on SIGINT and keeps the variables', async (r) => {
    if (process.platform === 'win32') return; // Windows has no SIGINT for a child process
    await r.run('python', 'kept = "still here"');
    r.send('python', 'import time\nprint("started")\ntime.sleep(30)\nprint("not reached")');
    for (;;) if ((await r.next()).text === 'started') break;
    r.proc.kill('SIGINT');
    let last;
    do last = await r.next();
    while (last.type !== 'done');
    assert.deepStrictEqual(last, { id: 2, type: 'done', ok: false, cancelled: true });
    assert.strictEqual(printed(await r.run('python', 'print(kept)')), 'still here\n');
  }],

  ['a program that a cell starts cannot break the messages', async (r) => {
    // The program writes to file descriptor 1. The kernel must still get correct messages.
    const messages = await r.run('python', 'import subprocess, sys\nsubprocess.run([sys.executable, "-c", "print(\'{not json\')"])\nprint("after")');
    assert.strictEqual(printed(messages), 'after\n');
    assert.match(r.stderr(), /\{not json/);
  }],
];

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    // Each test gets a new process, so that the request IDs start at 1.
    const runner = fn.length ? await start() : undefined;
    try {
      await fn(runner);
      passed++;
    } catch (e) {
      console.error(`FAIL ${name}\n${e.stack}`);
      process.exitCode = 1;
    } finally {
      if (runner) runner.stop();
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} passed${process.exitCode ? ', with failures' : ''}`);
})();
