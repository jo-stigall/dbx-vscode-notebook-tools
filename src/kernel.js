'use strict';
// Notebook kernel: runs cells on a Databricks cluster through the Command
// Execution API (1.2), one execution context per open notebook, so state
// (variables, temp views, imports) persists between cells like in Databricks.
const vscode = require('vscode');
const { parseNotebook } = require('./format');

const MAX_RUN_DEPTH = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (v) =>
  String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const textOutput = (text) =>
  new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(text, 'text/plain')]);
const errorOutput = (message, stack) =>
  new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.error({ name: 'Error', message, stack: stack || message }),
  ]);

function tableOutput(results) {
  const cols = (results.schema || []).map((c) => c.name);
  const rows = results.data || [];
  const cell = (v) => (v === null || v === undefined ? 'null' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const html =
    '<table style="border-collapse:collapse;font-size:12px">' +
    `<thead><tr>${cols.map((c) => `<th style="text-align:left;padding:2px 10px;border-bottom:1px solid var(--vscode-editorWidget-border)">${esc(c)}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${r.map((v) => `<td style="padding:2px 10px;white-space:pre">${esc(cell(v))}</td>`).join('')}</tr>`).join('')}</tbody></table>` +
    `<div style="opacity:.7;font-size:11px;padding-top:4px">${rows.length} row${rows.length === 1 ? '' : 's'}${results.truncated ? ' (truncated)' : ''}</div>`;
  const plain = [cols.join('\t'), ...rows.map((r) => r.map(cell).join('\t'))].join('\n');
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.text(html, 'text/html'),
    vscode.NotebookCellOutputItem.text(plain, 'text/plain'),
  ]);
}

function imageOutputs(results) {
  const urls = [].concat(results.data || []).filter((d) => typeof d === 'string' && d.startsWith('data:image/'));
  if (!urls.length) return [textOutput(`[image output: ${results.fileName || 'not retrievable'}]`)];
  return urls.map((u) => {
    const [, mime, b64] = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(u) || [];
    return mime
      ? new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(b64, 'base64'), mime)])
      : textOutput('[image output in an unknown encoding]');
  });
}

/** Command Execution API `results` -> notebook outputs */
function toOutputs(results) {
  switch (results.resultType) {
    case 'table':
      return [tableOutput(results)];
    case 'image':
    case 'images':
      return imageOutputs(results);
    case 'text':
      return results.data ? [textOutput(String(results.data))] : [];
    default:
      return results.data ? [textOutput(typeof results.data === 'string' ? results.data : JSON.stringify(results.data, null, 2))] : [];
  }
}

class Kernel {
  /** @param {import('./client').Connection} conn */
  constructor(notebookType, conn) {
    this.conn = conn;
    this.sessions = new Map(); // notebook uri -> session
    this.controller = vscode.notebooks.createNotebookController('dbx-cluster', notebookType, 'Databricks Cluster');
    this.controller.description = 'Runs cells on your Databricks cluster';
    this.controller.supportedLanguages = ['python', 'sql', 'scala', 'r', 'shellscript'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
    this.controller.interruptHandler = (notebook) => this.interrupt(notebook);
  }

  session(notebook) {
    const key = notebook.uri.toString();
    let s = this.sessions.get(key);
    if (!s) {
      s = { uri: notebook.uri, queue: Promise.resolve(), order: 0, epoch: 0 };
      this.sessions.set(key, s);
    }
    return s;
  }

  execute(cells, notebook) {
    const s = this.session(notebook);
    const epoch = s.epoch;
    // One cell at a time per notebook; after a failure or interrupt, skip the rest.
    s.queue = s.queue.then(async () => {
      let ok = true;
      for (const cell of cells) {
        const exec = this.controller.createNotebookCellExecution(cell);
        if (!ok || epoch !== s.epoch) {
          exec.start();
          exec.end(undefined);
          continue;
        }
        exec.executionOrder = ++s.order;
        exec.start(Date.now());
        try {
          await exec.clearOutput();
          const dir = vscode.Uri.joinPath(notebook.uri, '..');
          ok = await this.runCode(s, cell.document.languageId, cell.document.getText(), dir, exec, 0);
        } catch (e) {
          ok = false;
          await exec.appendOutput(errorOutput(e.message)).then(undefined, () => {});
        }
        exec.end(ok, Date.now());
      }
    });
    return s.queue;
  }

  async interrupt(notebook) {
    const s = this.session(notebook);
    s.epoch++;
    if (s.commandId && s.contextId) {
      await this.conn
        .api(s.uri, 'POST', '/api/1.2/commands/cancel', {
          clusterId: s.clusterId,
          contextId: s.contextId,
          commandId: s.commandId,
        })
        .catch(() => {});
    }
  }

  /** Run one cell's source, handling the magics the cluster does not understand. Returns success. */
  async runCode(s, language, source, dir, exec, depth) {
    let code = source.replace(/\r\n/g, '\n').trim();
    if (!code) return true;

    if (language === 'python') {
      const m = /^%([\w-]+)[ \t]*([^\n]*)\n?([\s\S]*)$/.exec(code);
      const magic = m && m[1];
      const rest = m ? (m[2] ? m[2] + '\n' : '') + m[3] : '';
      if (magic === 'run') return this.runNotebook(s, m[2], dir, exec, depth);
      if (magic === 'md' || magic === 'md-sandbox') return true;
      if (magic === 'sql' || magic === 'scala' || magic === 'r') return this.runCode(s, magic, rest, dir, exec, depth);
      if (magic === 'sh') return this.runCode(s, 'shellscript', rest, dir, exec, depth);
      if (magic === 'python') code = rest;
      // anything else (%pip, %fs, ...) is sent to the cluster as written
    }

    if (language === 'shellscript') {
      language = 'python';
      code = [
        'import subprocess as _dbx_sp',
        `_dbx_r = _dbx_sp.run(${JSON.stringify(code)}, shell=True, executable="/bin/bash", stdout=_dbx_sp.PIPE, stderr=_dbx_sp.STDOUT, text=True)`,
        'print(_dbx_r.stdout, end="")',
        'if _dbx_r.returncode != 0: raise RuntimeError(f"%sh exited with code {_dbx_r.returncode}")',
      ].join('\n');
    }
    return this.runCommand(s, language, code, exec);
  }

  /** %run: execute another local notebook's cells in this notebook's context. */
  async runNotebook(s, args, dir, exec, depth) {
    if (depth >= MAX_RUN_DEPTH) throw new Error(`%run is nested more than ${MAX_RUN_DEPTH} deep (is there a cycle?)`);
    const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(args.trim());
    const target = m && (m[1] || m[2] || m[3]);
    if (!target) throw new Error('%run needs a notebook path, e.g. %run ./helpers/setup');
    if (target.startsWith('/')) {
      throw new Error(`%run ${target}: workspace-absolute paths are not supported yet; use a path relative to this notebook.`);
    }
    const candidates = target.endsWith('.py') ? [target] : [target + '.py', target];
    let uri, text;
    for (const c of candidates) {
      try {
        uri = vscode.Uri.joinPath(dir, c);
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
        break;
      } catch {
        text = undefined;
      }
    }
    if (text === undefined) {
      throw new Error(`%run ${target}: no such notebook next to this one (looked for ${candidates.join(', ')} in ${dir.fsPath})`);
    }
    const targetDir = vscode.Uri.joinPath(uri, '..');
    for (const cell of parseNotebook(text).cells) {
      if (cell.kind !== 'code') continue;
      if (!(await this.runCode(s, cell.language, cell.value, targetDir, exec, depth + 1))) {
        await exec.appendOutput(textOutput(`(error above came from %run ${target})`));
        return false;
      }
    }
    return true;
  }

  async ensureContext(s) {
    if (s.contextId) return;
    let { clusterId } = this.conn.resolve(s.uri);
    if (!clusterId) clusterId = await this.conn.pickCluster(s.uri);
    if (!clusterId) throw new Error('No cluster selected. Run "Databricks Notebook: Select Cluster".');

    const cluster = await this.conn.api(s.uri, 'GET', '/api/2.1/clusters/get', { cluster_id: clusterId });
    if (cluster.state !== 'RUNNING') {
      throw new Error(
        `Cluster "${cluster.cluster_name || clusterId}" is ${cluster.state}. Start it (Databricks extension or workspace), then run the cell again.`
      );
    }
    const { id } = await this.conn.api(s.uri, 'POST', '/api/1.2/contexts/create', { clusterId, language: 'python' });
    for (let i = 0; ; i++) {
      const { status } = await this.conn.api(s.uri, 'GET', '/api/1.2/contexts/status', { clusterId, contextId: id });
      if (status === 'Running') break;
      if (status === 'Error' || i > 120) throw new Error(`Could not start an execution context on the cluster (status: ${status}).`);
      await sleep(500);
    }
    s.clusterId = clusterId;
    s.contextId = id;
  }

  /** Send one command to the cluster, wait for it, render the result. Returns success. */
  async runCommand(s, language, command, exec) {
    await this.ensureContext(s);
    const base = { clusterId: s.clusterId, contextId: s.contextId };
    let commandId;
    try {
      ({ id: commandId } = await this.conn.api(s.uri, 'POST', '/api/1.2/commands/execute', { ...base, language, command }));
    } catch (e) {
      throw new Error(`${e.message}\nIf the cluster was restarted, run "Databricks Notebook: Reset Execution Context" and try again.`);
    }
    s.commandId = commandId;
    // Text shown while the command is still running, if the API reports any.
    let partial;
    let shown = '';
    const showText = async (text) => {
      const item = vscode.NotebookCellOutputItem.text(text, 'text/plain');
      if (partial) await exec.replaceOutputItems(item, partial);
      else await exec.appendOutput((partial = new vscode.NotebookCellOutput([item])));
      shown = text;
    };
    try {
      for (let delay = 150; ; delay = Math.min(delay * 1.5, 1000)) {
        const st = await this.conn.api(s.uri, 'GET', '/api/1.2/commands/status', { ...base, commandId });
        if (st.status === 'Cancelled') {
          await exec.appendOutput(textOutput('Cancelled.'));
          return false;
        }
        if (st.status === 'Finished' || st.status === 'Error') {
          const r = st.results || {};
          if (st.status === 'Error' || r.resultType === 'error') {
            const summary = String(r.summary || r.cause || 'Command failed').replace(/<[^>]+>/g, '');
            await exec.appendOutput(errorOutput(summary, r.cause));
            return false;
          }
          if (partial && r.resultType === 'text') {
            // The final text supersedes what was streamed so far.
            if (String(r.data || '') !== shown) await showText(String(r.data || ''));
            return true;
          }
          const outputs = toOutputs(r);
          if (outputs.length) await exec.appendOutput(outputs);
          return true;
        }
        const running = st.results;
        if (running && running.resultType === 'text' && typeof running.data === 'string' && running.data && running.data !== shown) {
          await showText(running.data);
        }
        await sleep(delay);
      }
    } finally {
      s.commandId = undefined;
    }
  }

  /** Drop the remote execution context (clears all notebook state). */
  async reset(uri) {
    const key = uri.toString();
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    s.epoch++;
    if (s.contextId) {
      await this.conn
        .api(s.uri, 'POST', '/api/1.2/contexts/destroy', { clusterId: s.clusterId, contextId: s.contextId })
        .catch(() => {});
    }
  }

  async resetAll() {
    await Promise.all([...this.sessions.values()].map((s) => this.reset(s.uri)));
  }

  dispose() {
    this.resetAll();
    this.controller.dispose();
  }
}

module.exports = { Kernel };
