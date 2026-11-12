'use strict';
/**
 * Tests for src/client.js: find the workspace, the token and the cluster, and send requests.
 *
 * The tests do not need VS Code or Databricks. They give src/client.js a small
 * replacement for the `vscode` module, and they start a server on this computer.
 *
 * Run:
 *
 *     ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/client.test.js
 *
 * The script prints the number of tests that passed, for example "6 passed". It prints each failure
 * and exits with code 1 if a test fails.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');

/** The values that the replacement `vscode` module returns. Each test sets them. */
const state = { settings: {}, folders: [] };

/** Make a small replacement for a vscode.Uri. Example: uri('/work/sales/report.py'). */
const uri = (fsPath) => ({ fsPath, toString: () => 'file://' + fsPath });

/** The parts of the `vscode` module that src/client.js uses. */
const fakeVscode = {
  workspace: {
    getConfiguration: () => ({ get: (key) => state.settings[key] }),
    getWorkspaceFolder: (u) => state.folders.find((f) => u.fsPath === f.uri.fsPath || u.fsPath.startsWith(f.uri.fsPath + path.sep)),
  },
  extensions: { getExtension: () => undefined },
  window: { showQuickPick: async (items) => items[0] },
};

// Give the replacement to each file that asks for 'vscode'.
const load = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? fakeVscode : load(request, ...rest));
const { Connection } = require('../src/client');

/** A folder for the files of one test run. The script deletes it at the end. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-client-test-'));

/**
 * Make a Connection that starts with no settings, no variables and no selected cluster.
 *
 * @param {string} [databrickscfg]  The text of the `~/.databrickscfg` file that the Connection reads.
 * @returns {Connection}
 */
function newConnection(databrickscfg = '') {
  state.settings = {};
  state.folders = [];
  for (const name of Object.keys(process.env)) if (name.startsWith('DATABRICKS_')) delete process.env[name];
  process.env.DATABRICKS_CONFIG_FILE = path.join(tmp, 'databrickscfg');
  fs.writeFileSync(process.env.DATABRICKS_CONFIG_FILE, databrickscfg);
  const stored = new Map();
  return new Connection({
    workspaceState: { get: (key) => stored.get(key), update: async (key, value) => void stored.set(key, value) },
  });
}

/**
 * Make a project folder that contains `.databricks/.databricks.env`.
 *
 * @param {string} name  The name of the folder. Example: 'sales'.
 * @param {string} envText  The text of the file. Example: 'DATABRICKS_HOST=https://b.example.com'.
 * @returns {object}  The Uri of a notebook file in the folder.
 */
function project(name, envText) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.databricks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.databricks', '.databricks.env'), envText);
  state.folders.push({ uri: uri(dir) });
  return uri(path.join(dir, 'notebook.py'));
}

/**
 * Start a server on this computer and count its requests.
 *
 * @param {boolean} answer  true: the server answers each request with "{}". false: the server never answers.
 * @returns {Promise<{ url: string, count: () => number, close: () => void }>}
 */
function startServer(answer) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    if (answer) res.end('{}');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        count: () => count,
        close: () => {
          server.closeAllConnections();
          server.close();
        },
      })
    )
  );
}

const PROFILE_A = '[DEFAULT]\nhost = https://a.example.com/\ntoken = token-for-a\ncluster_id = cluster-a\n';

const tests = [
  ['uses the token of a profile for the workspace of that profile', async () => {
    const conn = newConnection(PROFILE_A);
    assert.deepStrictEqual(conn.resolve(undefined), {
      host: 'https://a.example.com',
      token: 'token-for-a',
      clusterId: 'cluster-a',
      cliPath: 'databricks',
    });
  }],

  ['does not send the token of a profile to a different workspace', async () => {
    const conn = newConnection(PROFILE_A);
    const notebook = project('other', 'DATABRICKS_HOST=https://b.example.com\n');
    const r = conn.resolve(notebook);
    assert.strictEqual(r.host, 'https://b.example.com');
    assert.strictEqual(r.token, '');
  }],

  ['refuses a workspace URL that starts with http://', async () => {
    const conn = newConnection();
    process.env.DATABRICKS_HOST = 'http://workspace.example.com';
    process.env.DATABRICKS_TOKEN = 'secret';
    await assert.rejects(conn.api(undefined, 'GET', '/api/2.1/clusters/list'), /must start with "https:\/\/"/);
  }],

  ['permits http:// for a server on this computer', async () => {
    const server = await startServer(true);
    try {
      const conn = newConnection();
      process.env.DATABRICKS_HOST = server.url;
      process.env.DATABRICKS_TOKEN = 'secret';
      assert.deepStrictEqual(await conn.api(undefined, 'GET', '/api/2.1/clusters/list'), {});
      assert.strictEqual(server.count(), 1);
    } finally {
      server.close();
    }
  }],

  ['stops a request that gets no answer', async () => {
    const server = await startServer(false);
    try {
      const conn = newConnection();
      conn.timeoutMs = 300;
      process.env.DATABRICKS_HOST = server.url;
      process.env.DATABRICKS_TOKEN = 'secret';
      const start = Date.now();
      await assert.rejects(conn.api(undefined, 'GET', '/api/1.2/commands/status'), /did not answer \/api\/1\.2\/commands\/status/);
      assert.ok(Date.now() - start < 3000, 'the request stops after the time limit');
    } finally {
      server.close();
    }
  }],

  ['remembers one selected cluster for each project folder', async () => {
    const conn = newConnection();
    const sales = project('sales', '');
    const hr = project('hr', 'DATABRICKS_CLUSTER_ID=cluster-from-file\n');
    // Do what "Select Cluster" does for the folder "sales".
    await conn.context.workspaceState.update(conn.clusterKey(sales), 'cluster-for-sales');
    assert.strictEqual(conn.resolve(sales).clusterId, 'cluster-for-sales');
    assert.strictEqual(conn.resolve(hr).clusterId, 'cluster-from-file');
  }],
];

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
    } catch (e) {
      console.error(`FAIL ${name}\n${e.stack}`);
      process.exitCode = 1;
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${passed} passed${process.exitCode ? ', with failures' : ''}`);
})();
