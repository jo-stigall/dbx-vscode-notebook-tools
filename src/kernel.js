'use strict';
/**
 * Run notebook cells on a Databricks cluster and show the results.
 *
 * VS Code calls the Kernel class in this file when you run a cell. The kernel
 * sends the text of the cell to the cluster with the Databricks Command
 * Execution API (version 1.2). The cluster runs the text and returns a result.
 *
 * The cluster keeps one session for each open notebook. Databricks calls this
 * session an "execution context". A variable that you set in one cell stays
 * available in the next cell, because the two cells use the same session.
 *
 * The kernel does three things that the cluster cannot do:
 *
 * - `%run ./other` : the kernel reads the other notebook from your disk and
 *   runs each of its cells.
 * - `%sql`, `%scala`, `%r` : the kernel sends the cell in that language.
 * - `%sh` : the kernel sends Python code that runs the shell commands.
 */
const vscode = require('vscode');
const { parseNotebook } = require('./format');

/** The largest number of notebooks that can call each other with %run. A larger number shows that two notebooks call each other in a loop. */
const MAX_RUN_DEPTH = 20;

/**
 * Wait for a number of milliseconds.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Make a value safe to put in HTML.
 *
 * @example
 * esc('<b>a & b</b>')   // '&lt;b&gt;a &amp; b&lt;/b&gt;'
 *
 * @param {*} v
 * @returns {string}
 */
const esc = (v) =>
  String(v).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

/**
 * Make a cell output that shows plain text.
 *
 * @param {string} text
 * @returns {vscode.NotebookCellOutput}
 */
const textOutput = (text) =>
  new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(text, 'text/plain')]);

/**
 * Make a cell output that shows an error in red.
 *
 * @param {string} message  One line that tells you what went wrong. Example: 'NameError: name "df" is not defined'.
 * @param {string} [stack]  The full error text from the cluster. If you omit it, the output shows `message` only.
 * @returns {vscode.NotebookCellOutput}
 */
const errorOutput = (message, stack) =>
  new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.error({ name: 'Error', message, stack: stack || message }),
  ]);

/**
 * Make a cell output that shows a table.
 *
 * The output contains the table two times. VS Code shows the HTML table to
 * you. A tool that reads the output as text (for example Copilot) gets the
 * table with a tab between the columns.
 *
 * @example
 * tableOutput({ schema: [{ name: 'id' }, { name: 'label' }], data: [[1, 'a'], [2, null]], truncated: false })
 * // HTML: a table with the columns "id" and "label", and the text "2 rows"
 * // Text: 'id\tlabel\n1\ta\n2\tnull'
 *
 * @param {{ schema?: {name: string}[], data?: any[][], truncated?: boolean }} results  The `results` object from Databricks with `resultType: 'table'`.
 * @returns {vscode.NotebookCellOutput}
 */
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

/**
 * Make cell outputs that show images, for example a matplotlib plot.
 *
 * The function can show an image that Databricks sends as a "data:" URL. If
 * Databricks sends only a file name on the cluster, the function shows the
 * file name as text.
 *
 * Not tested with a real cluster. The format of image results can be different.
 *
 * @param {{ data?: string|string[], fileName?: string }} results  The `results` object from Databricks with `resultType: 'image'` or `'images'`.
 * @returns {vscode.NotebookCellOutput[]}  One output for each image.
 */
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

/**
 * Convert the result of one command to cell outputs.
 *
 * @example
 * toOutputs({ resultType: 'text', data: 'hello' })   // one output that shows "hello"
 * toOutputs({ resultType: 'text', data: '' })        // [] : the command printed nothing
 * toOutputs({ resultType: 'table', schema: [...], data: [...] })   // one output that shows a table
 *
 * @param {{ resultType?: string, data?: any }} results  The `results` object from Databricks. Do not use this function for `resultType: 'error'`.
 * @returns {vscode.NotebookCellOutput[]}
 */
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

/**
 * The state that the kernel keeps for one open notebook.
 *
 * @typedef {object} Session
 * @property {vscode.Uri} uri  The notebook file.
 * @property {Promise<void>} queue  Ends when all cells that you started are done. The kernel uses it to run one cell at a time.
 * @property {number} order  The number of cells that ran. VS Code shows it as [1], [2], ... next to each cell.
 * @property {number} epoch  Increases when you stop the notebook. Cells that you started before the stop do not run.
 * @property {string} [clusterId]  The cluster of the session. Set by ensureContext().
 * @property {string} [contextId]  The ID of the session on the cluster. Set by ensureContext().
 * @property {string} [commandId]  The command that runs now. Not set between commands.
 * @property {boolean} [closed]  true after reset() deleted the session. A cell that waits for the session to start must not run.
 */

/**
 * Runs the cells of Databricks notebooks on a cluster.
 *
 * VS Code shows this kernel as "Databricks Cluster" in the kernel list of the notebook.
 *
 * @example
 * const kernel = new Kernel('dbx-notebook', new Connection(context));
 * context.subscriptions.push(kernel);   // VS Code calls kernel.dispose() when the extension stops
 */
class Kernel {
  /**
   * @param {string} notebookType  The notebook type from package.json: 'dbx-notebook'.
   * @param {import('./client').Connection} conn  Sends the requests to Databricks.
   */
  constructor(notebookType, conn) {
    this.conn = conn;
    /** @type {Map<string, Session>}  Notebook URI -> session. */
    this.sessions = new Map();
    this.controller = vscode.notebooks.createNotebookController('dbx-cluster', notebookType, 'Databricks Cluster');
    this.controller.description = 'Runs cells on your Databricks cluster';
    this.controller.supportedLanguages = ['python', 'sql', 'scala', 'r', 'shellscript'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
    this.controller.interruptHandler = (notebook) => this.interrupt(notebook);
  }

  /**
   * Get the session of a notebook. Make a new session if the notebook has none.
   *
   * A new session has no connection to the cluster. ensureContext() makes
   * the connection when the first cell runs.
   *
   * @param {vscode.NotebookDocument} notebook
   * @returns {Session}
   */
  session(notebook) {
    const key = notebook.uri.toString();
    let s = this.sessions.get(key);
    if (!s) {
      s = { uri: notebook.uri, queue: Promise.resolve(), order: 0, epoch: 0 };
      this.sessions.set(key, s);
    }
    return s;
  }

  /**
   * Run cells. VS Code calls this function when you run one cell or all cells.
   *
   * The function runs one cell at a time, in the sequence that VS Code gives.
   * If a cell fails, the function does not run the cells after it. If you
   * start more cells while a cell runs, the new cells wait.
   *
   * The function tells VS Code if each cell passed or failed. Copilot reads
   * this value to know if its code worked.
   *
   * @param {vscode.NotebookCell[]} cells  The cells to run.
   * @param {vscode.NotebookDocument} notebook  The notebook that contains the cells.
   * @returns {Promise<void>}  Ends when all the cells are done.
   */
  execute(cells, notebook) {
    const s = this.session(notebook);
    const epoch = s.epoch;
    s.queue = s.queue.then(async () => {
      let ok = true;
      for (const cell of cells) {
        const exec = this.controller.createNotebookCellExecution(cell);
        if (!ok || epoch !== s.epoch) {
          // An earlier cell failed, or you stopped the notebook. Do not run this cell.
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

  /**
   * Stop the cell that runs now. VS Code calls this function when you click the stop button.
   *
   * The function tells the cluster to cancel the command. It also prevents
   * the start of the cells that wait.
   *
   * If the session on the cluster is not ready, there is no command to
   * cancel. runCommand() then sees that `epoch` changed, and it does not send
   * the cell to the cluster. If the cluster did not yet give the ID of the
   * command, runCommand() cancels the command when it gets the ID.
   *
   * @param {vscode.NotebookDocument} notebook
   * @returns {Promise<void>}
   */
  async interrupt(notebook) {
    const s = this.session(notebook);
    s.epoch++;
    await this.cancel(s);
  }

  /**
   * Tell the cluster to cancel the command that runs now.
   *
   * The function does nothing if no command runs. It ignores an error from
   * the cluster.
   *
   * @param {Session} s
   * @returns {Promise<void>}
   */
  async cancel(s) {
    if (!s.commandId || !s.contextId) return;
    await this.conn
      .api(s.uri, 'POST', '/api/1.2/commands/cancel', {
        clusterId: s.clusterId,
        contextId: s.contextId,
        commandId: s.commandId,
      })
      .catch(() => {});
  }

  /**
   * Run the text of one cell.
   *
   * The function looks at the first line of a Python cell. If the line starts
   * with a magic command, the function does this:
   *
   * | First line          | What the function does                              |
   * |---------------------|-----------------------------------------------------|
   * | `%run ./other`      | Runs the cells of `other.py`. See runNotebook().    |
   * | `%sql`, `%scala`, `%r` | Sends the other lines to the cluster in that language. |
   * | `%sh`               | Sends Python code that runs the other lines in bash. |
   * | `%python`           | Sends the other lines as Python.                    |
   * | `%md`               | Nothing. The cell is text.                          |
   * | `%pip`, `%fs`, other | Sends the cell to the cluster without a change.    |
   *
   * @example
   * await this.runCode(s, 'python', '%sql\nselect 1', dir, exec, 0);
   * // sends "select 1" to the cluster as SQL
   *
   * @param {Session} s
   * @param {string} language  VS Code language name of the cell: 'python', 'sql', 'scala', 'r' or 'shellscript'.
   * @param {string} source  The text of the cell.
   * @param {vscode.Uri} dir  The folder of the notebook that contains the cell. `%run` paths start from this folder.
   * @param {vscode.NotebookCellExecution} exec  The function adds the output of the cell to this object.
   * @param {number} depth  0 for a cell of the open notebook. 1 for a cell of a notebook that `%run` started, and so on.
   * @returns {Promise<boolean>}  true if the cell passed. false if it failed or you stopped it.
   */
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
    }

    if (language === 'shellscript') {
      // The API has no shell language. Run the script from Python on the cluster.
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

  /**
   * Run a second notebook in the session of the open notebook. This is the `%run` command.
   *
   * The function reads the second notebook from your disk, not from the
   * Databricks workspace. It runs each code cell of that notebook. The
   * functions and variables of the second notebook are then available in the
   * open notebook. The second notebook can contain `%run` and other magic
   * commands.
   *
   * @example
   * // The open notebook is /project/etl/main.py and a cell contains: %run ./helpers/setup
   * await this.runNotebook(s, './helpers/setup', vscode.Uri.file('/project/etl'), exec, 0);
   * // runs the cells of /project/etl/helpers/setup.py
   *
   * @param {Session} s
   * @param {string} args  The text after `%run`. Example: './helpers/setup' or '"./my notebook"'. The function ignores values after the path.
   * @param {vscode.Uri} dir  The folder of the notebook that contains the `%run` cell.
   * @param {vscode.NotebookCellExecution} exec  The function adds the output of each cell to this object.
   * @param {number} depth  See runCode().
   * @returns {Promise<boolean>}  true if all cells passed.
   * @throws {Error}  If the path is empty, starts with "/", or points to no file. Also if the depth is more than MAX_RUN_DEPTH.
   */
  async runNotebook(s, args, dir, exec, depth) {
    if (depth >= MAX_RUN_DEPTH) throw new Error(`%run is nested more than ${MAX_RUN_DEPTH} deep (is there a cycle?)`);
    const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(args.trim());
    const target = m && (m[1] || m[2] || m[3]);
    if (!target) throw new Error('%run needs a notebook path, e.g. %run ./helpers/setup');
    if (target.startsWith('/')) {
      throw new Error(`%run ${target}: workspace-absolute paths are not supported yet; use a path relative to this notebook.`);
    }
    // Databricks paths have no ".py" at the end. The files on disk have it.
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

  /**
   * Make sure that the notebook has a session on the cluster.
   *
   * If the session exists, the function does nothing. If not, the function:
   *
   * 1. Finds the cluster. It asks you to select a cluster if none is set.
   * 2. Checks that the cluster runs.
   * 3. Tells the cluster to make a Python session (an "execution context").
   * 4. Waits until the session is ready.
   *
   * If you reset or close the notebook while the function waits, the function
   * deletes the new session on the cluster and sets nothing.
   *
   * @param {Session} s  The function sets `s.clusterId` and `s.contextId`.
   * @returns {Promise<void>}
   * @throws {Error}  If you select no cluster, if the cluster does not run, or if the session does not start in 60 seconds.
   */
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
    for (let i = 0; !s.closed; i++) {
      const { status } = await this.conn.api(s.uri, 'GET', '/api/1.2/contexts/status', { clusterId, contextId: id });
      if (status === 'Running') break;
      if (status === 'Error' || i > 120) throw new Error(`Could not start an execution context on the cluster (status: ${status}).`);
      await sleep(500);
    }
    if (s.closed) {
      // reset() ran while the session started. reset() did not know the ID of the session, thus delete it here.
      await this.conn.api(s.uri, 'POST', '/api/1.2/contexts/destroy', { clusterId, contextId: id }).catch(() => {});
      return;
    }
    s.clusterId = clusterId;
    s.contextId = id;
  }

  /**
   * Send one command to the cluster, wait for the result and show it.
   *
   * The function asks the cluster for the status of the command again and
   * again. The first time it waits 150 milliseconds. The wait time increases
   * to a maximum of 1 second.
   *
   * While the command runs, the cluster can report the text that the command
   * printed until now. The function shows that text immediately. When the
   * command is done, the function replaces that text with the final result.
   *
   * @example
   * const ok = await this.runCommand(s, 'python', 'print(1 + 1)', exec);
   * // The cell shows "2". ok is true.
   *
   * @param {Session} s
   * @param {'python'|'sql'|'scala'|'r'} language  The language that the cluster uses to run the command.
   * @param {string} command  The code to run.
   * @param {vscode.NotebookCellExecution} exec  The function adds the output to this object.
   * If you stop or reset the notebook while the session starts, the function
   * does not send the command. If you stop the notebook while the cluster
   * accepts the command, the function cancels the command.
   *
   * @returns {Promise<boolean>}  true if the command passed. false if the code failed or you stopped the command.
   * @throws {Error}  If a request to Databricks fails.
   */
  async runCommand(s, language, command, exec) {
    const epoch = s.epoch;
    await this.ensureContext(s);
    if (epoch !== s.epoch) {
      // You clicked stop or reset while the session started. Do not run the cell.
      await exec.appendOutput(textOutput('Cancelled.'));
      return false;
    }
    const base = { clusterId: s.clusterId, contextId: s.contextId };
    let commandId;
    try {
      ({ id: commandId } = await this.conn.api(s.uri, 'POST', '/api/1.2/commands/execute', { ...base, language, command }));
    } catch (e) {
      throw new Error(`${e.message}\nIf the cluster was restarted, run "Databricks Notebook: Reset Execution Context" and try again.`);
    }
    s.commandId = commandId;
    // You clicked stop while the cluster accepted the command. interrupt() did not know the ID, thus cancel the command here.
    if (epoch !== s.epoch) await this.cancel(s);

    // `partial` is the output that shows the text of a command that runs.
    // `shown` is the text in that output.
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

  /**
   * Delete the session of one notebook on the cluster.
   *
   * The cluster then forgets all variables, imports and temporary views of
   * the notebook. The next cell that you run starts a new session. This is
   * the same as "Detach & re-attach" in Databricks.
   *
   * @param {vscode.Uri} uri  The notebook file.
   * @returns {Promise<void>}
   */
  async reset(uri) {
    const key = uri.toString();
    const s = this.sessions.get(key);
    if (!s) return;
    this.sessions.delete(key);
    s.epoch++;
    // If the session starts now, ensureContext() deletes it when it sees this value.
    s.closed = true;
    if (s.contextId) {
      await this.conn
        .api(s.uri, 'POST', '/api/1.2/contexts/destroy', { clusterId: s.clusterId, contextId: s.contextId })
        .catch(() => {});
    }
  }

  /**
   * Delete the sessions of all open notebooks. See reset().
   *
   * The extension calls this function when you select a different cluster.
   *
   * @returns {Promise<void>}
   */
  async resetAll() {
    await Promise.all([...this.sessions.values()].map((s) => this.reset(s.uri)));
  }

  /** Delete all sessions and remove the kernel from VS Code. VS Code calls this function when the extension stops. */
  dispose() {
    this.resetAll();
    this.controller.dispose();
  }
}

module.exports = { Kernel };
