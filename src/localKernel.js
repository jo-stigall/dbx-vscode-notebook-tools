'use strict';
/**
 * Run notebook cells in a Python process on this computer.
 *
 * VS Code shows the LocalKernel class in this file as "Local Python
 * (Databricks Connect)" in the kernel list of the notebook. The kernel starts
 * one Python process for each open notebook, with the Python of your project
 * (for example `.venv/bin/python`). Python code runs on this computer, thus a
 * cell can import each package that you installed in that Python. `spark`
 * comes from Databricks Connect, thus Spark code runs on the cluster.
 *
 * The kernel "Databricks Cluster" (src/kernel.js) does the opposite: it sends
 * all code to the cluster.
 *
 * The Python process runs src/local_runner.py. That file describes the
 * messages between the kernel and the process.
 */
const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { Kernel, textOutput, errorOutput, tableOutput } = require('./kernel');

/** How long the kernel waits for the Python process to start, in milliseconds. */
const START_TIMEOUT_MS = 60000;

/**
 * Find the Python that runs the cells of a notebook.
 *
 * The function looks in these places and uses the first Python that it finds:
 *
 * 1. The setting "dbxNotebook.pythonPath".
 * 2. The interpreter that you selected in the Python extension of VS Code.
 * 3. A `.venv` folder next to the notebook, or in a folder above it, up to
 *    the project folder.
 * 4. `python3` on your PATH (`python` on Windows).
 *
 * @example
 * await findPython(vscode.Uri.file('/work/sales/etl/report.py'))
 * // '/work/sales/.venv/bin/python'
 *
 * @param {vscode.Uri} uri  The notebook file.
 * @returns {Promise<string>}  The path of the Python program.
 */
async function findPython(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const root = folder && folder.uri.fsPath;

  const setting = vscode.workspace.getConfiguration('dbxNotebook', uri).get('pythonPath');
  if (setting) {
    return setting.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/\$\{workspaceFolder\}/g, root || '');
  }

  try {
    const extension = vscode.extensions.getExtension('ms-python.python');
    if (extension) {
      const api = extension.isActive ? extension.exports : await extension.activate();
      const env = await api.environments.resolveEnvironment(api.environments.getActiveEnvironmentPath(uri));
      const exe = env && env.executable && env.executable.uri && env.executable.uri.fsPath;
      if (exe) return exe;
    }
  } catch {
    // The Python extension gave no answer. Continue with the next place.
  }

  const inVenv = process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'];
  for (let dir = path.dirname(uri.fsPath); ; dir = path.dirname(dir)) {
    const exe = path.join(dir, ...inVenv);
    if (fs.existsSync(exe)) return exe;
    if (!root || dir === root || !dir.startsWith(root) || path.dirname(dir) === dir) break;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * The state that the local kernel keeps for one open notebook, in addition to the Session of src/kernel.js.
 *
 * @typedef {object} LocalSession
 * @property {import('child_process').ChildProcess} [proc]  The Python process of the notebook. Not set before the first cell runs.
 * @property {Promise<void>} [starting]  Ends when the Python process is ready.
 * @property {{ id: number, onMessage: (message: object) => void, onExit: (code: number|null) => void }} [current]  The cell that runs now.
 */

/**
 * Runs the cells of Databricks notebooks in a Python process on this computer.
 *
 * The class uses these parts of Kernel without a change: one cell at a time,
 * `%run`, `%md`, `%python`, and the pass or fail value for VS Code.
 *
 * @example
 * const local = new LocalKernel('dbx-notebook', new Connection(context));
 * context.subscriptions.push(local);
 */
class LocalKernel extends Kernel {
  /**
   * @param {string} notebookType  The notebook type from package.json: 'dbx-notebook'.
   * @param {import('./client').Connection} conn  Gives the environment variables for Databricks Connect.
   */
  constructor(notebookType, conn) {
    super(notebookType, conn, {
      id: 'dbx-local',
      label: 'Local Python (Databricks Connect)',
      description: 'Runs Python on this computer. Spark runs on your cluster.',
    });
    /** The path of the script that the Python process runs. */
    this.runnerPath = path.join(__dirname, 'local_runner.py');
    /** The ID of the last request. Each request to a Python process gets the next number. */
    this.lastId = 0;
  }

  /**
   * Stop the cell that runs now. VS Code calls this function when you click the stop button.
   *
   * The function sends the signal SIGINT to the Python process. Python then
   * stops the cell and keeps the variables. Windows has no such signal: there
   * the process stops, and the variables are gone.
   *
   * @param {vscode.NotebookDocument} notebook
   * @returns {Promise<void>}
   */
  async interrupt(notebook) {
    const s = this.session(notebook);
    s.epoch++;
    if (s.proc && s.current) s.proc.kill('SIGINT');
  }

  /**
   * Run shell commands on this computer. This is the `%sh` command.
   *
   * @param {import('./kernel').Session & LocalSession} s
   * @param {string} script  The shell commands. Example: 'ls'.
   * @param {vscode.NotebookCellExecution} exec
   * @returns {Promise<boolean>}  true if the commands passed.
   */
  runShell(s, script, exec) {
    return this.runCommand(s, 'shell', script, exec);
  }

  /**
   * Start the Python process of a notebook, if it does not run.
   *
   * The process starts in the folder of the notebook. A cell can import a
   * file from that folder and from the project folder, as in Databricks.
   *
   * @param {import('./kernel').Session & LocalSession} s  The function sets `s.proc`.
   * @returns {Promise<void>}  Ends when the process is ready for the first cell.
   * @throws {Error}  If the Python program does not exist, or if the process stops or gives no answer in 60 seconds. The message contains the path of the Python program.
   */
  ensureProcess(s) {
    if (!s.starting) {
      s.starting = this.startProcess(s).catch((e) => {
        s.starting = undefined;
        throw e;
      });
    }
    return s.starting;
  }

  /** Do the work of ensureProcess(). */
  async startProcess(s) {
    const python = await findPython(s.uri);
    const folder = vscode.workspace.getWorkspaceFolder(s.uri);
    const login = await this.conn.localEnv(s.uri);
    if (login.warning) vscode.window.showWarningMessage(login.warning);
    const env = {
      ...login.env,
      PYTHONIOENCODING: 'utf-8',
      // The script adds these folders to the places where Python looks for an import.
      DBX_NOTEBOOK_PATHS: folder ? folder.uri.fsPath : '',
    };
    const proc = spawn(python, ['-u', this.runnerPath], { cwd: path.dirname(s.uri.fsPath), env });
    /** The last text that the process wrote outside a cell. An error message shows it. */
    let stray = '';

    await new Promise((resolve, reject) => {
      const fail = (reason) =>
        reject(
          new Error(
            `The kernel "Local Python" cannot start ${python}: ${reason}${stray ? '\n' + stray.trim() : ''}\n` +
              'To use a different Python, select an interpreter with the Python extension, or set "dbxNotebook.pythonPath".'
          )
        );
      const timer = setTimeout(() => {
        proc.kill();
        fail(`no answer in ${START_TIMEOUT_MS / 1000} seconds.`);
      }, START_TIMEOUT_MS);

      proc.on('error', (e) => {
        clearTimeout(timer);
        fail(e.message);
      });
      // If the process stops, a write to it fails. The 'exit' handler reports that.
      proc.stdin.on('error', () => {});
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (s.proc === proc) {
          s.proc = undefined;
          s.starting = undefined;
        }
        if (s.current) s.current.onExit(code);
        fail(`the process stopped (exit code ${code}).`);
      });
      proc.stderr.on('data', (data) => {
        if (s.current) s.current.onMessage({ type: 'stream', text: String(data) });
        else stray = (stray + data).slice(-2000);
      });
      readline.createInterface({ input: proc.stdout }).on('line', (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.type === 'ready') {
          clearTimeout(timer);
          s.proc = proc;
          vscode.window.setStatusBarMessage(`Local Python ${message.python}: ${message.executable}`, 8000);
          resolve();
        } else if (s.current && message.id === s.current.id) {
          s.current.onMessage(message);
        }
      });
    });

    if (s.closed) proc.kill(); // reset() ran while the process started
  }

  /**
   * Run one piece of code in the Python process and show its output.
   *
   * The function shows text while the code prints it. It shows a table for
   * `display(df)`, a page for `displayHTML()` and an image for a plot.
   *
   * These cells do not go to the Python process:
   *
   * | Cell                | What the function does                                  |
   * |---------------------|---------------------------------------------------------|
   * | `%scala`, `%r`      | Error. Only the cluster can run these languages.        |
   * | `%pip`              | Shows a note and continues. You install packages in the Python of your project. |
   * | `%fs`, other magic  | Error.                                                  |
   *
   * @example
   * const ok = await this.runCommand(s, 'python', 'print(1 + 1)', exec);
   * // The cell shows "2". ok is true.
   *
   * @param {import('./kernel').Session & LocalSession} s
   * @param {'python'|'sql'|'shell'|'scala'|'r'} language
   * @param {string} code  The code to run.
   * @param {vscode.NotebookCellExecution} exec  The function adds the output to this object.
   * @returns {Promise<boolean>}  true if the code passed. false if the code failed or you stopped it.
   * @throws {Error}  If the Python process cannot start, or if it stops while the code runs.
   */
  async runCommand(s, language, code, exec) {
    if (language === 'scala' || language === 'r') {
      throw new Error(`The kernel "Local Python" cannot run %${language} cells. Select the kernel "Databricks Cluster" for this notebook.`);
    }
    const magic = language === 'python' && /^%([\w-]+)/.exec(code);
    if (magic && magic[1] === 'pip') {
      await exec.appendOutput(
        textOutput('Skipped: the kernel "Local Python" does not run %pip. Install the package in the Python of your project, for example: uv pip install <package>')
      );
      return true;
    }
    if (magic) {
      throw new Error(`The kernel "Local Python" cannot run %${magic[1]}. Select the kernel "Databricks Cluster" for this notebook.`);
    }

    const epoch = s.epoch;
    await this.ensureProcess(s);
    if (epoch !== s.epoch || !s.proc) {
      // You clicked stop or reset while the process started. Do not run the cell.
      await exec.appendOutput(textOutput('Cancelled.'));
      return false;
    }

    const id = ++this.lastId;
    return new Promise((resolve, reject) => {
      // The process sends messages faster than VS Code shows them. `queue` shows one output at a time, in the sequence of the messages.
      let queue = Promise.resolve();
      const show = (fn) => (queue = queue.then(fn).catch(() => {}));
      /** The text output that grows now. A table or an image ends it; the next text starts a new one. */
      let text;

      const finish = (fn) =>
        show(async () => {
          s.current = undefined;
          await fn();
        });

      s.current = {
        id,
        onMessage: (m) => {
          if (m.type === 'stream') {
            if (!text) text = { value: '', output: undefined, waiting: false };
            const mine = text;
            mine.value += m.text;
            // If an update of this text waits, it shows the new text also.
            if (mine.waiting) return;
            mine.waiting = true;
            show(async () => {
              mine.waiting = false;
              const item = vscode.NotebookCellOutputItem.text(mine.value, 'text/plain');
              if (mine.output) await exec.replaceOutputItems(item, mine.output);
              else await exec.appendOutput((mine.output = new vscode.NotebookCellOutput([item])));
            });
          } else if (m.type === 'table') {
            text = undefined;
            show(() => exec.appendOutput(tableOutput(m)));
          } else if (m.type === 'html') {
            text = undefined;
            show(() => exec.appendOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(m.data, 'text/html')])));
          } else if (m.type === 'image') {
            text = undefined;
            show(() => exec.appendOutput(new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(Buffer.from(m.data, 'base64'), m.mime)])));
          } else if (m.type === 'done') {
            finish(async () => {
              if (m.ok) return resolve(true);
              await exec.appendOutput(m.cancelled ? textOutput('Cancelled.') : errorOutput(m.summary, m.trace));
              resolve(false);
            });
          }
        },
        onExit: (exitCode) =>
          finish(async () => {
            if (s.closed) {
              await exec.appendOutput(textOutput('Cancelled.'));
              return resolve(false);
            }
            reject(
              new Error(
                `The local Python process stopped (exit code ${exitCode}). The variables of the notebook are gone. Run the cell again to start a new process.`
              )
            );
          }),
      };
      s.proc.stdin.write(JSON.stringify({ id, language, code }) + '\n');
    });
  }

  /**
   * Stop the Python process of one notebook.
   *
   * All variables and imports of the notebook are then gone. The next cell
   * that you run starts a new process. Use it after you install a package or
   * change a module that the notebook imported.
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
    // If the process starts now, startProcess() stops it when it sees this value.
    s.closed = true;
    if (s.proc) s.proc.kill();
  }
}

module.exports = { LocalKernel, findPython };
