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
 * The script prints the number of tests that passed, for example "10 passed". It prints each failure
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
  const global = new Map();
  const secrets = new Map();
  return new Connection({
    workspaceState: { get: (key) => stored.get(key), update: async (key, value) => void stored.set(key, value) },
    globalState: { get: (key, fallback) => (global.has(key) ? global.get(key) : fallback), update: async (key, value) => void global.set(key, value) },
    secrets: { get: async (key) => secrets.get(key), store: async (key, value) => void secrets.set(key, value) },
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

  ['lists the profiles of the configuration file', async () => {
    const conn = newConnection(PROFILE_A + '[prod]\nhost = b.example.com\nauth_type = databricks-cli\n\n[broken]\ntoken = x\n');
    assert.deepStrictEqual(conn.listProfiles(), [
      { name: 'DEFAULT', host: 'https://a.example.com', auth: 'token' },
      { name: 'prod', host: 'https://b.example.com', auth: 'databricks-cli' },
    ]);
    assert.deepStrictEqual(newConnection().listProfiles(), []);
  }],

  ['a named profile uses the URL and the token of that profile only', async () => {
    const conn = newConnection(PROFILE_A + '[prod]\nhost = https://b.example.com\ntoken = token-for-b\n');
    // The variables are for a third workspace. A profile that the user selected by name does not use them.
    process.env.DATABRICKS_HOST = 'https://c.example.com';
    process.env.DATABRICKS_TOKEN = 'token-for-c';
    const r = conn.resolve(undefined, 'prod');
    assert.deepStrictEqual([r.host, r.token], ['https://b.example.com', 'token-for-b']);
    assert.strictEqual(await conn.getToken(undefined, { profile: 'prod' }), 'token-for-b');
    // '@workspace' and no name give the connection of the notebook kernel.
    assert.strictEqual(conn.resolve(undefined, '@workspace').host, 'https://c.example.com');
    assert.strictEqual(conn.resolve(undefined).token, 'token-for-c');
    // A profile that does not exist has no URL.
    assert.strictEqual(conn.resolve(undefined, 'nope').host, '');
  }],

  ['keeps a typed token in the secret store, not in a file', async () => {
    const conn = newConnection();
    const name = await conn.storeToken('adb-9.example.com/', 'typed-token');
    assert.strictEqual(name, '@token:https://adb-9.example.com');
    assert.deepStrictEqual(conn.storedHosts(), ['https://adb-9.example.com']);
    const r = conn.resolve(undefined, name);
    assert.deepStrictEqual([r.host, r.token, r.secret], ['https://adb-9.example.com', '', true]);
    assert.strictEqual(await conn.getToken(undefined, { profile: name }), 'typed-token');
    await assert.rejects(conn.getToken(undefined, { profile: '@token:https://other.example.com' }), /No token is stored/);
  }],

  ['asks the Databricks CLI for a new token when the old one was refused', async () => {
    // A replacement for the Databricks CLI: each call prints a token with the next number.
    const counter = path.join(tmp, 'cli-calls');
    const cli = path.join(tmp, 'fake-databricks');
    fs.writeFileSync(counter, '');
    fs.writeFileSync(cli, `#!/bin/sh\necho x >> "${counter}"\nn=$(wc -l < "${counter}" | tr -d ' ')\necho "{\\"access_token\\": \\"cli-token-$n\\", \\"expiry\\": \\"2099-01-01T00:00:00Z\\"}"\n`, { mode: 0o755 });
    const conn = newConnection('[oauth]\nhost = https://d.example.com\nauth_type = databricks-cli\n');
    state.settings = { cliPath: cli };
    assert.strictEqual(await conn.getToken(undefined, { profile: 'oauth' }), 'cli-token-1');
    assert.strictEqual(await conn.getToken(undefined, { profile: 'oauth' }), 'cli-token-1', 'the second call uses the stored token');
    assert.strictEqual(await conn.getToken(undefined, { profile: 'oauth', fresh: true }), 'cli-token-2');
    assert.strictEqual(await conn.getToken(undefined, { profile: 'oauth' }), 'cli-token-2');
  }],

  ['gives a local Python process the same workspace, login and cluster', async () => {
    const conn = newConnection(PROFILE_A);
    const { env, warning } = await conn.localEnv(undefined);
    assert.strictEqual(warning, '');
    assert.strictEqual(env.DATABRICKS_HOST, 'https://a.example.com');
    assert.strictEqual(env.DATABRICKS_CLUSTER_ID, 'cluster-a');
    assert.strictEqual(env.DATABRICKS_AUTH_TYPE, 'pat');
    assert.strictEqual(env.DATABRICKS_TOKEN, 'token-for-a');
  }],

  ['tells a local Python process to use the Databricks CLI when there is no token', async () => {
    const conn = newConnection(PROFILE_A);
    const notebook = project('local-cli', 'DATABRICKS_HOST=https://b.example.com\n');
    const { env } = await conn.localEnv(notebook);
    assert.strictEqual(env.DATABRICKS_HOST, 'https://b.example.com');
    assert.strictEqual(env.DATABRICKS_AUTH_TYPE, 'databricks-cli');
    assert.strictEqual(env.DATABRICKS_TOKEN, undefined, 'the token of workspace A does not go to workspace B');
  }],

  ['does not change the login of a local Python process if the project sets one', async () => {
    const conn = newConnection(PROFILE_A);
    const notebook = project('local-auth', 'DATABRICKS_HOST=https://a.example.com\nDATABRICKS_AUTH_TYPE=azure-cli\n');
    const { env, warning } = await conn.localEnv(notebook);
    assert.strictEqual(env.DATABRICKS_AUTH_TYPE, 'azure-cli');
    assert.strictEqual(env.DATABRICKS_TOKEN, undefined);
    assert.strictEqual(warning, '');
  }],

  ['uses the login service of the official extension while it answers', async () => {
    const server = await startServer(true);
    try {
      const conn = newConnection(PROFILE_A);
      const notebook = project('service-up', `DATABRICKS_HOST=https://a.example.com\nDATABRICKS_AUTH_TYPE=metadata-service\nDATABRICKS_METADATA_SERVICE_URL=${server.url}/secret\n`);
      const { env, warning } = await conn.localEnv(notebook);
      assert.strictEqual(env.DATABRICKS_AUTH_TYPE, 'metadata-service');
      assert.strictEqual(env.DATABRICKS_METADATA_SERVICE_URL, `${server.url}/secret`);
      assert.strictEqual(env.DATABRICKS_TOKEN, undefined);
      assert.strictEqual(warning, '');
    } finally {
      server.close();
    }
  }],

  ['uses its own login when the login service of the official extension does not answer', async () => {
    // Start a server to get a free port, then stop it. No program then listens on that port.
    const server = await startServer(true);
    server.close();
    const stale = `DATABRICKS_AUTH_TYPE=metadata-service\nDATABRICKS_METADATA_SERVICE_URL=${server.url}/secret\n`;

    // The profile has a token for the workspace: the process gets that token.
    let conn = newConnection(PROFILE_A);
    let result = await conn.localEnv(project('service-down-token', 'DATABRICKS_HOST=https://a.example.com\n' + stale));
    assert.strictEqual(result.env.DATABRICKS_AUTH_TYPE, 'pat');
    assert.strictEqual(result.env.DATABRICKS_TOKEN, 'token-for-a');
    assert.strictEqual(result.env.DATABRICKS_METADATA_SERVICE_URL, undefined);
    assert.match(result.warning, /does not answer.*uses your token instead/);

    // There is no token for the workspace: the process asks the Databricks CLI.
    conn = newConnection(PROFILE_A);
    result = await conn.localEnv(project('service-down-cli', 'DATABRICKS_HOST=https://b.example.com\n' + stale));
    assert.strictEqual(result.env.DATABRICKS_AUTH_TYPE, 'databricks-cli');
    assert.strictEqual(result.env.DATABRICKS_TOKEN, undefined);
    assert.match(result.warning, /uses the login of the Databricks CLI instead/);
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
