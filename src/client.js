'use strict';
// Finds the Databricks workspace, credentials and cluster, and calls the REST API.
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const CLUSTER_KEY = 'dbxNotebook.clusterId';

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** ~/.databrickscfg -> { profileName: { key: value } } */
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

/** KEY=VALUE lines -> { KEY: VALUE } */
function readEnvFile(file) {
  const out = {};
  for (const line of readFileOrEmpty(file).split(/\r?\n/)) {
    const kv = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

class Connection {
  /** @param {vscode.ExtensionContext} context */
  constructor(context) {
    this.context = context;
    this.cliTokens = new Map(); // host -> { token, expires }
  }

  /**
   * Where the connection comes from, first match wins:
   * settings, environment variables, the official Databricks extension's
   * `.databricks/.databricks.env`, then a `~/.databrickscfg` profile.
   */
  resolve(uri) {
    const cfg = vscode.workspace.getConfiguration('dbxNotebook', uri);
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    const fileEnv = folder
      ? readEnvFile(path.join(folder.uri.fsPath, '.databricks', '.databricks.env'))
      : {};
    const env = { ...fileEnv, ...process.env };
    const profileName = cfg.get('profile') || env.DATABRICKS_CONFIG_PROFILE || 'DEFAULT';
    const cfgFile = env.DATABRICKS_CONFIG_FILE || path.join(os.homedir(), '.databrickscfg');
    const profile = readIni(cfgFile)[profileName] || {};

    let host = cfg.get('host') || env.DATABRICKS_HOST || profile.host || '';
    host = host.replace(/\/+$/, '');
    if (host && !/^https?:\/\//.test(host)) host = 'https://' + host;

    return {
      host,
      token: env.DATABRICKS_TOKEN || profile.token || '',
      clusterId:
        this.context.workspaceState.get(CLUSTER_KEY) ||
        cfg.get('clusterId') ||
        env.DATABRICKS_CLUSTER_ID ||
        profile.cluster_id ||
        '',
      cliPath: cfg.get('cliPath') || this.bundledCli() || 'databricks',
    };
  }

  /** The Databricks CLI that ships inside the official extension, if installed. */
  bundledCli() {
    const ext = vscode.extensions.getExtension('databricks.databricks');
    const cli = ext && path.join(ext.extensionPath, 'bin', process.platform === 'win32' ? 'databricks.exe' : 'databricks');
    return cli && fs.existsSync(cli) ? cli : '';
  }

  async getToken(uri) {
    const { host, token, cliPath } = this.resolve(uri);
    if (token) return token;
    const cached = this.cliTokens.get(host);
    if (cached && cached.expires > Date.now()) return cached.token;

    // No personal access token: ask the Databricks CLI for an OAuth token.
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
      expires: (Number.isFinite(expiry) ? expiry : Date.now() + 5 * 60000) - 60000,
    });
    return json.access_token;
  }

  /** Call the REST API. GET sends `payload` as query parameters, others as JSON. */
  async api(uri, method, apiPath, payload) {
    const { host } = this.resolve(uri);
    if (!host) {
      throw new Error(
        'No Databricks workspace configured. Set "dbxNotebook.host", the DATABRICKS_HOST environment variable, or a ~/.databrickscfg profile.'
      );
    }
    const token = await this.getToken(uri);
    let url = host + apiPath;
    const init = { method, headers: { Authorization: `Bearer ${token}` } };
    if (payload && method === 'GET') url += '?' + new URLSearchParams(payload);
    else if (payload) {
      init.body = JSON.stringify(payload);
      init.headers['Content-Type'] = 'application/json';
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      throw new Error(`Cannot reach ${host}: ${(e.cause && e.cause.message) || e.message}`);
    }
    const text = await res.text();
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

  /** Let the user choose a cluster; remembered per workspace. */
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
    await this.context.workspaceState.update(CLUSTER_KEY, choice.id);
    return choice.id;
  }
}

module.exports = { Connection };
