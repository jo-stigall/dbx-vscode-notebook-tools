'use strict';
/**
 * Find the Databricks workspace, the login and the cluster. Call the Databricks REST API.
 *
 * The kernel (src/kernel.js) uses the Connection class in this file for each
 * request to Databricks. The class reads its values from four places. The
 * first place that has a value wins:
 *
 * 1. The VS Code settings that start with "dbxNotebook.".
 * 2. Environment variables, for example DATABRICKS_HOST.
 * 3. The file `.databricks/.databricks.env` in your project folder. The
 *    official Databricks extension writes this file.
 * 4. A profile in `~/.databrickscfg`.
 */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/** The start of the name under which VS Code stores the cluster that you selected. See Connection.clusterKey(). */
const CLUSTER_KEY = 'dbxNotebook.clusterId';

/** How long api() waits for an answer from Databricks, in milliseconds. */
const REQUEST_TIMEOUT_MS = 30000;

/**
 * The name of the connection that the notebook kernel uses: the settings, the
 * environment variables, the project file and the default profile.
 */
const WORKSPACE_PROFILE = '@workspace';

/** The start of the name of a connection whose token is in the secret store of VS Code. Example: '@token:https://adb-123.azuredatabricks.net'. */
const TOKEN_PROFILE_PREFIX = '@token:';

/** The start of the name under which the secret store of VS Code keeps a token. The workspace URL follows. */
const SECRET_PREFIX = 'dbxNotebook.token:';

/** The name under which VS Code stores the list of workspace URLs that have a token in the secret store. */
const STORED_HOSTS_KEY = 'dbxNotebook.tokenHosts';

/**
 * Write a workspace URL in one form: with "https://" and without a "/" at the end.
 *
 * @example
 * normalizeHost('adb-123.azuredatabricks.net/')   // 'https://adb-123.azuredatabricks.net'
 *
 * @param {string} [host]
 * @returns {string}  Empty if `host` is empty.
 */
function normalizeHost(host) {
  host = (host || '').trim().replace(/\/+$/, '');
  if (host && !/^https?:\/\//.test(host)) host = 'https://' + host;
  return host;
}

/**
 * Get the scheme, the name and the port of a workspace URL. Ignore the rest.
 *
 * @example
 * origin('https://adb-123.azuredatabricks.net/?o=456')   // 'https://adb-123.azuredatabricks.net'
 * origin('adb-123.azuredatabricks.net')                  // 'https://adb-123.azuredatabricks.net'
 * origin('')                                             // ''
 *
 * @param {string} [url]
 * @returns {string}  Empty if `url` is empty or is not a URL.
 */
function origin(url) {
  if (!url) return '';
  try {
    return new URL(/^https?:\/\//.test(url) ? url : 'https://' + url).origin;
  } catch {
    return '';
  }
}

/**
 * Tell if a URL points to this computer.
 *
 * @example
 * isLoopback('http://127.0.0.1:8765')               // true
 * isLoopback('http://adb-123.azuredatabricks.net')  // false
 *
 * @param {string} url
 * @returns {boolean}
 */
function isLoopback(url) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Read a text file. Return an empty string if the file does not exist.
 *
 * @param {string} file  Full path of the file.
 * @returns {string}
 */
function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Read an INI file such as `~/.databrickscfg`.
 *
 * @example
 * // The file contains:
 * //   [DEFAULT]
 * //   host = https://adb-123.azuredatabricks.net
 * //   token = dapi...
 * readIni('/Users/me/.databrickscfg')
 * // { DEFAULT: { host: 'https://adb-123.azuredatabricks.net', token: 'dapi...' } }
 *
 * @param {string} file  Full path of the file.
 * @returns {Object<string, Object<string, string>>}  Profile name -> key -> value. Empty if the file does not exist.
 */
function readIni(file) {
  const out = {};
  let section;
  for (const line of readFileOrEmpty(file).split(/\r?\n/)) {
    const s = /^\s*\[(.+)\]\s*$/.exec(line);
    const kv = /^\s*([^#;=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (s) section = out[s[1]] = {};
    else if (kv && section) section[kv[1]] = kv[2];
  }
  return out;
}

/**
 * Read a file of KEY=VALUE lines such as `.databricks/.databricks.env`.
 *
 * The function removes quotation marks around a value. It ignores lines that
 * are not KEY=VALUE.
 *
 * @example
 * // The file contains:
 * //   DATABRICKS_HOST=https://adb-123.azuredatabricks.net
 * //   DATABRICKS_CLUSTER_ID="0101-123456-abcdefgh"
 * readEnvFile('/project/.databricks/.databricks.env')
 * // { DATABRICKS_HOST: 'https://adb-123.azuredatabricks.net', DATABRICKS_CLUSTER_ID: '0101-123456-abcdefgh' }
 *
 * @param {string} file  Full path of the file.
 * @returns {Object<string, string>}  Empty if the file does not exist.
 */
function readEnvFile(file) {
  const out = {};
  for (const line of readFileOrEmpty(file).split(/\r?\n/)) {
    const kv = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * Connects the extension to one Databricks workspace.
 *
 * @example
 * const conn = new Connection(context);
 * const cluster = await conn.api(notebook.uri, 'GET', '/api/2.1/clusters/get', { cluster_id: '0101-123456-abcdefgh' });
 * cluster.state   // 'RUNNING'
 */
class Connection {
  /**
   * @param {vscode.ExtensionContext} context  VS Code gives this object to activate(). The class uses it to remember the cluster that you selected.
   */
  constructor(context) {
    this.context = context;
    /** Login tokens from the Databricks CLI. Workspace URL -> { token, expires }. */
    this.cliTokens = new Map();
    /** How long api() waits for an answer, in milliseconds. A test can set a smaller value. */
    this.timeoutMs = REQUEST_TIMEOUT_MS;
  }

  /**
   * Get the name under which VS Code stores the cluster that you selected.
   *
   * Each project folder has its own name. Thus two folders in one VS Code
   * window can use different clusters.
   *
   * @example
   * conn.clusterKey(vscode.Uri.file('/work/sales/report.py'))
   * // 'dbxNotebook.clusterId:file:///work/sales'   if /work/sales is a folder of the VS Code window
   *
   * @param {vscode.Uri} [uri]  A file in the project.
   * @returns {string}
   */
  clusterKey(uri) {
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    return folder ? `${CLUSTER_KEY}:${folder.uri.toString()}` : CLUSTER_KEY;
  }

  /**
   * Find the workspace URL, the token, the cluster and the Databricks CLI.
   *
   * The function reads the settings and files each time you call it. Thus a
   * change to a setting applies to the next cell that you run.
   *
   * The function uses the token of a `~/.databrickscfg` profile only if the
   * profile is for the same workspace URL. Example: your DEFAULT profile is
   * for workspace A, and the project file `.databricks/.databricks.env` names
   * workspace B. The function then returns no token, and getToken() asks the
   * Databricks CLI for a token for workspace B.
   *
   * @example
   * conn.resolve(notebook.uri)
   * // {
   * //   host: 'https://adb-123.azuredatabricks.net',
   * //   token: '',                          // empty: getToken() will ask the Databricks CLI
   * //   clusterId: '0101-123456-abcdefgh',  // empty: the kernel will ask you to select a cluster
   * //   cliPath: 'databricks',
   * // }
   *
   * @param {vscode.Uri} [uri]  A file in the project. The function reads the settings and `.databricks/.databricks.env` of the folder that contains this file.
   * @param {string} [profile]  The connection to use. Omit it, or give '@workspace', for the connection of the notebook kernel (the description above).
   *   A name such as 'DEFAULT' uses that profile of `~/.databrickscfg` for the URL and the token.
   *   '@token:<URL>' uses that URL, and getToken() reads the token from the secret store of VS Code.
   * @returns {{ host: string, token: string, clusterId: string, cliPath: string, secret?: boolean }}  A value is an empty string if the function did not find it. `secret` is true for a '@token:' connection.
   */
  resolve(uri, profile) {
    const cfg = vscode.workspace.getConfiguration('dbxNotebook', uri);
    if (profile && profile !== WORKSPACE_PROFILE) return this.resolveProfile(uri, cfg, profile);

    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    const fileEnv = folder
      ? readEnvFile(path.join(folder.uri.fsPath, '.databricks', '.databricks.env'))
      : {};
    const env = { ...fileEnv, ...process.env };
    const profileName = cfg.get('profile') || env.DATABRICKS_CONFIG_PROFILE || 'DEFAULT';
    const cfgFile = env.DATABRICKS_CONFIG_FILE || path.join(os.homedir(), '.databrickscfg');
    const profileSection = readIni(cfgFile)[profileName] || {};

    let host = cfg.get('host') || env.DATABRICKS_HOST || profileSection.host || '';
    host = host.replace(/\/+$/, '');
    if (host && !/^https?:\/\//.test(host)) host = 'https://' + host;

    // Do not send the token of a profile to a workspace that the profile is not for.
    const profileToken = profileSection.token && origin(profileSection.host) === origin(host) ? profileSection.token : '';

    return {
      host,
      token: env.DATABRICKS_TOKEN || profileToken || '',
      clusterId:
        this.context.workspaceState.get(this.clusterKey(uri)) ||
        cfg.get('clusterId') ||
        env.DATABRICKS_CLUSTER_ID ||
        profileSection.cluster_id ||
        '',
      cliPath: cfg.get('cliPath') || this.bundledCli() || 'databricks',
    };
  }

  /**
   * Find the URL and the token of a named connection. See the `profile` parameter of resolve().
   *
   * A named profile uses the URL and the token of that profile only. It does
   * not use DATABRICKS_HOST or DATABRICKS_TOKEN: the user selected the
   * profile by its name.
   */
  resolveProfile(uri, cfg, profile) {
    const clusterId = this.context.workspaceState.get(this.clusterKey(uri)) || cfg.get('clusterId') || '';
    const cliPath = cfg.get('cliPath') || this.bundledCli() || 'databricks';
    if (profile.startsWith(TOKEN_PROFILE_PREFIX)) {
      return { host: normalizeHost(profile.slice(TOKEN_PROFILE_PREFIX.length)), token: '', clusterId, cliPath, secret: true };
    }
    const section = readIni(this.configFile())[profile] || {};
    return { host: normalizeHost(section.host), token: section.token || '', clusterId: clusterId || section.cluster_id || '', cliPath };
  }

  /** @returns {string}  The path of the Databricks configuration file: DATABRICKS_CONFIG_FILE, or `~/.databrickscfg`. */
  configFile() {
    return process.env.DATABRICKS_CONFIG_FILE || path.join(os.homedir(), '.databrickscfg');
  }

  /**
   * List the profiles in `~/.databrickscfg`.
   *
   * The function reads the file. It does not call Databricks, so it is fast
   * and it works without a network.
   *
   * @example
   * conn.listProfiles()
   * // [
   * //   { name: 'DEFAULT', host: 'https://adb-123.azuredatabricks.net', auth: 'token' },
   * //   { name: 'prod',    host: 'https://adb-456.azuredatabricks.net', auth: 'databricks-cli' },
   * // ]
   *
   * @returns {{ name: string, host: string, auth: string }[]}  `auth` is 'token' if the profile has a `token` line. If not, it is the `auth_type` of the profile, or 'databricks-cli'.
   */
  listProfiles() {
    return Object.entries(readIni(this.configFile()))
      .filter(([, section]) => section.host)
      .map(([name, section]) => ({ name, host: normalizeHost(section.host), auth: section.token ? 'token' : section.auth_type || 'databricks-cli' }));
  }

  /**
   * Keep a personal access token in the secret store of VS Code.
   *
   * VS Code encrypts the secret store with the keychain of the operating
   * system. The token is not in a settings file. Use the connection name
   * '@token:<URL>' to use the token.
   *
   * @param {string} host  The workspace URL.
   * @param {string} token  The personal access token.
   * @returns {Promise<string>}  The connection name, for example '@token:https://adb-123.azuredatabricks.net'.
   */
  async storeToken(host, token) {
    host = normalizeHost(host);
    await this.context.secrets.store(SECRET_PREFIX + host, token);
    const hosts = new Set(this.context.globalState.get(STORED_HOSTS_KEY, []));
    hosts.add(host);
    await this.context.globalState.update(STORED_HOSTS_KEY, [...hosts]);
    return TOKEN_PROFILE_PREFIX + host;
  }

  /** @returns {string[]}  The workspace URLs that have a token in the secret store. */
  storedHosts() {
    return this.context.globalState.get(STORED_HOSTS_KEY, []);
  }

  /**
   * Find the Databricks CLI that the official Databricks extension installs.
   *
   * @returns {string}  Full path of the CLI. Empty if the official extension is not installed.
   */
  bundledCli() {
    const ext = vscode.extensions.getExtension('databricks.databricks');
    const cli = ext && path.join(ext.extensionPath, 'bin', process.platform === 'win32' ? 'databricks.exe' : 'databricks');
    return cli && fs.existsSync(cli) ? cli : '';
  }

  /**
   * Get the token that proves to Databricks who you are.
   *
   * The function uses a personal access token if resolve() found one. If not,
   * it runs `databricks auth token --host <workspace URL>`. The Databricks CLI
   * then gives a token from your last `databricks auth login`. The function
   * keeps that token until one minute before it expires.
   *
   * @param {vscode.Uri} [uri]  A file in the project. See resolve().
   * @param {{ profile?: string, fresh?: boolean }} [options]  `profile`: the connection to use; see resolve().
   *   `fresh: true`: Databricks refused the last token, so do not use the stored token of the CLI; ask the CLI again.
   * @returns {Promise<string>}  The token.
   * @throws {Error}  If there is no personal access token and the CLI cannot give a token. The message tells you how to log in.
   */
  async getToken(uri, options = {}) {
    const { host, token, cliPath, secret } = this.resolve(uri, options.profile);
    if (secret) {
      const stored = await this.context.secrets.get(SECRET_PREFIX + host);
      if (!stored) throw new Error(`No token is stored for ${host}. Select the profile again and type the token.`);
      return stored;
    }
    if (token) return token;
    if (options.fresh) this.cliTokens.delete(host);
    const cached = this.cliTokens.get(host);
    if (cached && cached.expires > Date.now()) return cached.token;

    const stdout = await new Promise((resolve, reject) => {
      execFile(cliPath, ['auth', 'token', '--host', host], { timeout: 30000 }, (err, out, stderr) => {
        if (err) {
          reject(
            new Error(
              `No Databricks credentials for ${host}. Tried DATABRICKS_TOKEN, the ~/.databrickscfg profile, ` +
                `and "${cliPath} auth token" (${(stderr || err.message).trim().split('\n')[0]}). ` +
                `Run "databricks auth login --host ${host}" or set a token in ~/.databrickscfg.`
            )
          );
        } else resolve(out);
      });
    });
    const json = JSON.parse(stdout);
    const expiry = Date.parse(json.expiry || '');
    this.cliTokens.set(host, {
      token: json.access_token,
      // If the CLI gives no expiry time, ask the CLI again after 4 minutes.
      expires: (Number.isFinite(expiry) ? expiry : Date.now() + 5 * 60000) - 60000,
    });
    return json.access_token;
  }

  /**
   * Send one request to the Databricks REST API and return the answer.
   *
   * @example
   * // GET: the function puts the values in the URL.
   * await conn.api(uri, 'GET', '/api/2.1/clusters/get', { cluster_id: '0101-123456-abcdefgh' });
   *
   * // POST: the function sends the values as JSON.
   * await conn.api(uri, 'POST', '/api/1.2/contexts/create', { clusterId: '0101-123456-abcdefgh', language: 'python' });
   *
   * @param {vscode.Uri} [uri]  A file in the project. See resolve().
   * @param {'GET'|'POST'} method
   * @param {string} apiPath  The path after the workspace URL. Example: '/api/2.1/clusters/list'.
   * @param {object} [payload]  The values to send.
   * @returns {Promise<object>}  The JSON answer. An empty object if Databricks sends no text.
   * @throws {Error}  If no workspace is set, if the workspace URL starts with "http://", if the workspace does not answer in 30 seconds, or if Databricks returns an error. The message includes the text from Databricks.
   */
  async api(uri, method, apiPath, payload) {
    const { host } = this.resolve(uri);
    if (!host) {
      throw new Error(
        'No Databricks workspace configured. Set "dbxNotebook.host", the DATABRICKS_HOST environment variable, or a ~/.databrickscfg profile.'
      );
    }
    // "http://" sends the token as plain text. Permit it only for a test server on this computer.
    if (host.startsWith('http://') && !isLoopback(host)) {
      throw new Error(`The workspace URL ${host} must start with "https://". The extension does not send your token without encryption.`);
    }
    const token = await this.getToken(uri);
    let url = host + apiPath;
    const init = { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.timeoutMs) };
    if (payload && method === 'GET') url += '?' + new URLSearchParams(payload);
    else if (payload) {
      init.body = JSON.stringify(payload);
      init.headers['Content-Type'] = 'application/json';
    }
    let res, text;
    try {
      res = await fetch(url, init);
      text = await res.text();
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new Error(`${host} did not answer ${apiPath} in ${Math.round(this.timeoutMs / 1000)} seconds.`);
      }
      throw new Error(`Cannot reach ${host}: ${(e.cause && e.cause.message) || e.message}`);
    }
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const detail = (json && (json.message || json.error)) || text.slice(0, 300);
      throw new Error(`Databricks API ${apiPath} failed (HTTP ${res.status}): ${detail}`);
    }
    return json || {};
  }

  /**
   * Show a list of clusters and let you select one.
   *
   * The list shows running clusters first. It does not show the clusters that
   * Databricks jobs start. VS Code remembers your selection for the project
   * folder that contains `uri`.
   *
   * @param {vscode.Uri} [uri]  A file in the project. See resolve().
   * @returns {Promise<string>}  The ID of the cluster. Empty if you close the list without a selection.
   */
  async pickCluster(uri) {
    const { clusters = [] } = await this.api(uri, 'GET', '/api/2.1/clusters/list');
    const items = clusters
      .filter((c) => c.cluster_source !== 'JOB')
      .sort((a, b) => (b.state === 'RUNNING') - (a.state === 'RUNNING') || a.cluster_name.localeCompare(b.cluster_name))
      .map((c) => ({ label: c.cluster_name, description: c.state, detail: c.cluster_id, id: c.cluster_id }));
    const choice = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select the Databricks cluster that runs notebook cells',
      matchOnDescription: true,
    });
    if (!choice) return '';
    await this.context.workspaceState.update(this.clusterKey(uri), choice.id);
    return choice.id;
  }
}

module.exports = { Connection, WORKSPACE_PROFILE, TOKEN_PROFILE_PREFIX };
