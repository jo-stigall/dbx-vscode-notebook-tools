'use strict';
/**
 * Start the extension: connect the parser, the kernel and the commands to VS Code.
 *
 * VS Code loads this file when you open a Python file or a Databricks
 * notebook. VS Code then calls activate() one time.
 *
 * The other source files do the work:
 *
 * - src/format.js converts a .py file to cells, and back.
 * - src/client.js finds your Databricks workspace and sends requests to it.
 * - src/kernel.js runs cells on the cluster.
 * - src/localKernel.js runs cells in a Python process on this computer.
 */
const vscode = require('vscode');
const { parseNotebook, serializeNotebook, hasHeader } = require('./src/format');
const { Connection } = require('./src/client');
const { Kernel } = require('./src/kernel');
const { LocalKernel } = require('./src/localKernel');

/** The name of the notebook type. package.json uses the same name. */
const NOTEBOOK_TYPE = 'dbx-notebook';

/**
 * Converts between the bytes of a .py file and the cells that VS Code shows.
 *
 * VS Code calls deserializeNotebook() when you open a file as a notebook.
 * VS Code calls serializeNotebook() when you save the notebook.
 *
 * Each cell keeps the data from src/format.js in `cell.metadata.dbx`:
 * the original text (`raw`), the original separator (`sep`), the title
 * (`dbtitle`) and the markdown type (`magic`). The notebook keeps the line
 * ending, the header and the end of the file in `notebook.metadata.dbx`.
 *
 * @type {vscode.NotebookSerializer}
 */
const serializer = {
  /**
   * Convert the bytes of a .py file to notebook cells.
   *
   * @param {Uint8Array} content  The bytes of the file.
   * @returns {vscode.NotebookData}
   */
  deserializeNotebook(content) {
    // ignoreBOM: keep a byte-order mark at the start of the file, so that the parser can remember it.
    const nb = parseNotebook(new TextDecoder('utf-8', { ignoreBOM: true }).decode(content));
    const data = new vscode.NotebookData(
      nb.cells.map((c) => {
        const kind = c.kind === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
        const cell = new vscode.NotebookCellData(kind, c.value, c.language);
        const dbx = { raw: c.raw };
        for (const k of ['sep', 'dbtitle', 'magic']) if (c[k] !== undefined) dbx[k] = c[k];
        cell.metadata = { dbx };
        return cell;
      })
    );
    data.metadata = { dbx: { eol: nb.eol, header: nb.header, trailer: nb.trailer, ...(nb.bom ? { bom: true } : {}) } };
    return data;
  },

  /**
   * Convert notebook cells to the bytes of a .py file.
   *
   * A cell that Copilot or you added has no `metadata.dbx`. The function
   * writes that cell in the format that Databricks uses.
   *
   * @param {vscode.NotebookData} data
   * @returns {Uint8Array}  The bytes to write to the file.
   */
  serializeNotebook(data) {
    const cells = data.cells.map((c) => ({
      ...((c.metadata && c.metadata.dbx) || {}),
      kind: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
      language: c.kind === vscode.NotebookCellKind.Markup ? 'markdown' : c.languageId,
      value: c.value,
    }));
    const text = serializeNotebook({ ...((data.metadata && data.metadata.dbx) || {}), cells });
    return new TextEncoder().encode(text);
  },
};

/** The kernels of the running extension. deactivate() uses them. */
let activeKernels = [];

/**
 * Start the extension. VS Code calls this function one time.
 *
 * The function adds these parts to VS Code:
 *
 * - The serializer, so that VS Code can open and save .py notebooks.
 * - The kernels "Databricks Cluster" and "Local Python (Databricks
 *   Connect)", so that you can run cells. The setting
 *   "dbxNotebook.defaultKernel" tells which one a new notebook uses.
 * - Automatic open: a .py file that starts with the Databricks header opens
 *   as a notebook.
 * - The cell title: VS Code shows the "# DBTITLE" text below the cell.
 * - Three commands: "Open as Databricks Notebook", "Select Cluster" and
 *   "Reset Execution Context".
 *
 * @param {vscode.ExtensionContext} context  VS Code removes all parts in `context.subscriptions` when the extension stops.
 */
function activate(context) {
  const conn = new Connection(context);
  const kernel = new Kernel(NOTEBOOK_TYPE, conn);
  const localKernel = new LocalKernel(NOTEBOOK_TYPE, conn);
  activeKernels = [kernel, localKernel];

  /** The name under which VS Code stores the kernels that you selected by hand. Notebook URI -> kernel ID. */
  const KERNEL_CHOICE_KEY = 'dbxNotebook.kernelChoice';
  /** The notebooks that got their kernel from selectKernel() since they opened. */
  const kernelApplied = new Set();
  /** true while selectKernel() selects a kernel. A selection in this time is not a selection by hand. */
  let applyingKernel = false;

  /**
   * Select the kernel of the notebook that you look at.
   *
   * VS Code selects no kernel by itself when a notebook type has two kernels:
   * it asks you each time. Thus the extension selects one:
   *
   * 1. The kernel that you selected by hand for this notebook, if there is one.
   * 2. If not, the kernel of the setting "dbxNotebook.defaultKernel":
   *    "cluster" or "local".
   *
   * The function does its work one time for each open notebook. After that,
   * you can select the other kernel in the kernel list of the notebook.
   *
   * @param {vscode.NotebookEditor|undefined} editor  The notebook editor that you look at.
   * @returns {Promise<void>}
   */
  async function selectKernel(editor) {
    const nb = editor && editor.notebook;
    if (!isOurs(nb) || applyingKernel) return;
    const key = nb.uri.toString();
    if (kernelApplied.has(key)) return;
    const choice = context.workspaceState.get(KERNEL_CHOICE_KEY, {})[key];
    const byDefault = vscode.workspace.getConfiguration('dbxNotebook', nb.uri).get('defaultKernel') === 'local' ? localKernel : kernel;
    applyingKernel = true;
    try {
      // This command selects a kernel for the notebook editor that you look at.
      await vscode.commands.executeCommand('notebook.selectKernel', { id: choice || byDefault.controller.id, extension: context.extension.id });
      kernelApplied.add(key);
    } finally {
      applyingKernel = false;
    }
  }

  /**
   * Remember a kernel that you selected by hand, so that the notebook uses it the next time.
   *
   * @param {string} id  The ID of the kernel: 'dbx-cluster' or 'dbx-local'.
   * @param {{ notebook: vscode.NotebookDocument, selected: boolean }} e  The event from VS Code.
   */
  const rememberKernel = (id, e) => {
    const key = e.notebook.uri.toString();
    // Before selectKernel() did its work, the selection comes from VS Code, not from you.
    if (!e.selected || applyingKernel || !kernelApplied.has(key)) return;
    context.workspaceState.update(KERNEL_CHOICE_KEY, { ...context.workspaceState.get(KERNEL_CHOICE_KEY, {}), [key]: id });
  };

  /** @returns {boolean} true if the notebook is a Databricks .py notebook. */
  const isOurs = (nb) => nb && nb.notebookType === NOTEBOOK_TYPE;

  /** @returns {vscode.NotebookDocument|undefined} The Databricks notebook that you look at now, if there is one. */
  const activeNotebook = () => {
    const nb = vscode.window.activeNotebookEditor && vscode.window.activeNotebookEditor.notebook;
    return isOurs(nb) ? nb : undefined;
  };

  /** Notebook URI -> the time when you closed the notebook view of that file. */
  const recentlyClosed = new Map();

  /** true if the text editor that you look at shows a Databricks notebook file. See updateButton(). */
  let activeFileIsNotebook = false;

  /**
   * Show or hide the button "Open as Databricks Notebook" at the top of a text editor.
   *
   * The button shows only if the file is a .py file and its first line is
   * "# Databricks notebook source". A normal Python file gets no button.
   * The function sets the value "dbxNotebook.activeFileIsNotebook", and the
   * `when` condition of the button in package.json reads it.
   *
   * @param {vscode.TextEditor|undefined} editor  The text editor that you look at.
   */
  function updateButton(editor) {
    const doc = editor && editor.document;
    activeFileIsNotebook = Boolean(doc && doc.fileName.endsWith('.py') && doc.lineCount > 0 && hasHeader(doc.lineAt(0).text));
    vscode.commands.executeCommand('setContext', 'dbxNotebook.activeFileIsNotebook', activeFileIsNotebook);
  }

  /**
   * Open a file as a notebook if it is a Databricks notebook.
   *
   * VS Code calls this function each time you go to a text editor. The
   * function does nothing in these conditions:
   *
   * - The setting "dbxNotebook.autoOpen" is off.
   * - The file is not a saved .py file on your disk.
   * - The first line is not "# Databricks notebook source".
   * - You closed the notebook of the file less than 2 seconds ago. This
   *   occurs when you select "Reopen Editor With... > Text Editor". The file
   *   must then stay open as text.
   * - No normal text tab shows the file. This occurs when you look at a diff
   *   of the file, for example from the Source Control view. The diff must
   *   stay a diff. If the notebook opened next to it, the text document and
   *   the notebook would be open at the same time, and Ruff stops with
   *   "expected a single text document, but found a notebook document" when
   *   you point at the text.
   *
   * If the notebook of the file is open, the function closes the text tab
   * and goes to the notebook. Example: the notebook of `report.py` is open,
   * and you click `report.py` in the Explorer. VS Code opens a text tab next
   * to the notebook. Without this step, you have two editors of one file,
   * and Ruff reports an error for each edit in one of them.
   *
   * @param {vscode.TextEditor|undefined} editor  The text editor that you went to.
   * @returns {Promise<void>}
   */
  async function autoOpen(editor) {
    if (!editor || !vscode.workspace.getConfiguration('dbxNotebook').get('autoOpen')) return;
    const doc = editor.document;
    if (doc.uri.scheme !== 'file' || !doc.fileName.endsWith('.py') || doc.isDirty) return;
    if (!doc.lineCount || !hasHeader(doc.lineAt(0).text)) return;
    const key = doc.uri.toString();
    const notebookIsOpen = () => vscode.workspace.notebookDocuments.some((nb) => isOurs(nb) && nb.uri.toString() === key);
    if (notebookIsOpen()) {
      // "Reopen Editor With... > Text Editor" puts the text in the place of the notebook tab, and
      // VS Code closes the notebook some time later. Thus look for a notebook tab, not for the
      // notebook: if no tab shows the notebook, you selected the text editor, and the file stays text.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const hasNotebookTab = vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .some((t) => t.input instanceof vscode.TabInputNotebook && t.input.notebookType === NOTEBOOK_TYPE && t.input.uri.toString() === key);
      if (!hasNotebookTab || doc.isDirty) return;
    }
    if (Date.now() - (recentlyClosed.get(key) || 0) < 2000) return;
    const inTextTab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .some((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key);
    if (!inTextTab) return;
    await openAsNotebook(doc.uri);
  }

  /**
   * Wait until VS Code closed the text document of a file.
   *
   * VS Code closes the document a short time after its last tab closes. It
   * keeps the document longer if a different extension uses it. Thus the
   * function waits 300 milliseconds at most.
   *
   * @param {vscode.Uri} uri  The file.
   * @returns {Promise<boolean>}  true if the document is closed. false if it was still open after 300 milliseconds.
   */
  function textDocumentClosed(uri) {
    const key = uri.toString();
    if (!vscode.workspace.textDocuments.some((d) => d.uri.toString() === key)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (closed) => {
        clearTimeout(timer);
        listener.dispose();
        resolve(closed);
      };
      const listener = vscode.workspace.onDidCloseTextDocument((d) => d.uri.toString() === key && done(true));
      const timer = setTimeout(() => done(false), 300);
    });
  }

  /**
   * Open a .py file in the notebook view, in the place of its text editor tab.
   *
   * This is the command "Open as Databricks Notebook".
   *
   * The function closes the text tab first and waits until VS Code closed
   * the text document. Then it opens the notebook. The sequence is
   * important for other extensions: the text document and the notebook
   * have the same address (the path of the file). A language server such
   * as Ruff keeps one entry for each address. If the two are open at the
   * same time, the entry of one replaces the entry of the other, and Ruff
   * reports "tried to close document that didn't exist".
   *
   * @param {vscode.Uri} [uri]  The file to open. If you omit it, the function uses the file in the text editor that you look at.
   * @returns {Promise<void>}
   */
  async function openNow(uri) {
    uri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!uri) return;
    const key = uri.toString();
    // Do not close a text tab that has changes that you did not save.
    const textTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key && !t.isDirty);
    // Open the notebook in the editor group of the text tab.
    const viewColumn = textTabs.length ? textTabs[0].group.viewColumn : undefined;
    // true if the text tab is the tab that you look at.
    const wasActive = textTabs.some((t) => t.isActive && t.group.isActive);
    if (textTabs.length) {
      await vscode.window.tabGroups.close(textTabs).then(undefined, () => {});
      await textDocumentClosed(uri);
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE, viewColumn);
    // When the text tab closed, the keyboard focus left the editor. Put it in the notebook, so that
    // the keys and the commands of the notebook work without a click.
    if (wasActive) await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  }

  /** Ends when the last call of openAsNotebook() is done. */
  let opening = Promise.resolve();

  /**
   * Open a .py file in the notebook view. See openNow().
   *
   * The function does one file at a time. A second call waits until the
   * first call is done, so that the steps of two calls do not mix.
   *
   * @param {vscode.Uri} [uri]  The file to open. If you omit it, the function uses the file in the text editor that you look at.
   * @returns {Promise<void>}
   */
  function openAsNotebook(uri) {
    const next = opening.then(() => openNow(uri));
    opening = next.catch(() => {});
    return next;
  }

  /**
   * Load the table visualization feature. The feature is a separate file
   * (dist/tableViz/host.js, built from src/tableViz), and the extension loads
   * it only when you use a command or a panel of the feature.
   *
   * @returns {import('./src/tableViz/host/index.ts').TableVizApi}
   */
  let tableViz;
  const loadTableViz = () => tableViz || (tableViz = require('./dist/tableViz/host.js').activate(context, conn));

  // The view "Databricks Tables". This object gives the calls of VS Code to the feature, which loads when the view opens.
  const treeChanged = new vscode.EventEmitter();
  let treeConnected = false;
  const tableTree = () => {
    const tree = loadTableViz().tree;
    if (!treeConnected) {
      treeConnected = true;
      context.subscriptions.push(tree.onDidChangeTreeData((node) => treeChanged.fire(node)));
    }
    return tree;
  };

  context.subscriptions.push(
    kernel,
    localKernel,
    // transientOutputs: VS Code does not save cell outputs, and a new output does not mark the file as changed.
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, { transientOutputs: true }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      updateButton(editor);
      return autoOpen(editor);
    }),
    // You can type or delete the header line. Then the button must show or go away.
    vscode.workspace.onDidChangeTextDocument((e) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && e.document === editor.document) updateButton(editor);
    }),
    // For the tests: wait until the extension finished the last "open as notebook".
    vscode.commands.registerCommand('dbxNotebook._openDone', () => opening),
    // For the tests: tell if the button shows now.
    vscode.commands.registerCommand('dbxNotebook._activeFileIsNotebook', () => activeFileIsNotebook),

    // Select a kernel for each notebook when you go to it for the first time.
    vscode.window.onDidChangeActiveNotebookEditor(selectKernel),
    kernel.controller.onDidChangeSelectedNotebooks((e) => rememberKernel(kernel.controller.id, e)),
    localKernel.controller.onDidChangeSelectedNotebooks((e) => rememberKernel(localKernel.controller.id, e)),
    // A new default kernel applies to the open notebooks also, but not to a notebook with a kernel that you selected by hand.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('dbxNotebook.defaultKernel')) return;
      kernelApplied.clear();
      return selectKernel(vscode.window.activeNotebookEditor);
    }),

    // When you close a notebook, delete its session on the cluster and stop its local Python process.
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      if (!isOurs(nb)) return;
      recentlyClosed.set(nb.uri.toString(), Date.now());
      kernelApplied.delete(nb.uri.toString());
      kernel.reset(nb.uri);
      localKernel.reset(nb.uri);
    }),

    // Show the title of a cell below the cell. "# DBTITLE 1,Load the data" shows "Load the data".
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, {
      provideCellStatusBarItems(cell) {
        const t = cell.metadata && cell.metadata.dbx && cell.metadata.dbx.dbtitle;
        if (!t) return [];
        return [new vscode.NotebookCellStatusBarItem(t.replace(/^\d+,/, ''), vscode.NotebookCellStatusBarAlignment.Left)];
      },
    }),

    vscode.commands.registerCommand('dbxNotebook.openAsNotebook', openAsNotebook),

    // The commands of "Visualize Table". See docs/table-viz-design.md.
    vscode.commands.registerCommand('dbxNotebook.tableViz.visualizeTable', (name) => loadTableViz().visualizeTable(name)),
    vscode.commands.registerCommand('dbxNotebook.tableViz.visualizeTableUnderCursor', () => loadTableViz().visualizeTableUnderCursor()),
    vscode.commands.registerCommand('dbxNotebook.tableViz.visualizeNode', (node) => loadTableViz().visualizeNode(node)),
    vscode.commands.registerCommand('dbxNotebook.tableViz.searchTables', (node) => loadTableViz().searchTables(node)),
    vscode.commands.registerCommand('dbxNotebook.tableViz.compareTables', (a, b) => loadTableViz().compareTables(a, b)),
    vscode.commands.registerCommand('dbxNotebook.tableViz.selectCompute', () => loadTableViz().selectCompute()),
    vscode.commands.registerCommand('dbxNotebook.tableViz.refreshTables', () => tableTree().refresh()),
    vscode.commands.registerCommand('dbxNotebook.tableViz.addFavorite', (node) => node && node.kind === 'table' && tableTree().addFavorite(node.table)),
    vscode.commands.registerCommand('dbxNotebook.tableViz.removeFavorite', (node) => node && node.kind === 'table' && tableTree().removeFavorite(node.table)),
    // A file "*.tableviz.json" is a saved view. VS Code opens it as a board.
    vscode.window.registerCustomEditorProvider('dbxNotebook.tableViz.view', {
      resolveCustomTextEditor: async (document, panel) => {
        await loadTableViz().resolveView(document, panel);
      },
    }),
    // For tests: get the feature object.
    vscode.commands.registerCommand('dbxNotebook.tableViz._api', () => loadTableViz()),
    treeChanged,
    vscode.window.registerTreeDataProvider('dbxNotebook.tableViz.tables', {
      onDidChangeTreeData: treeChanged.event,
      getTreeItem: (node) => tableTree().getTreeItem(node),
      getChildren: (node) => tableTree().getChildren(node),
    }),

    // After a window reload, VS Code gives each board panel back to the extension with the state that the panel stored.
    vscode.window.registerWebviewPanelSerializer('dbxNotebook.tableViz.board', {
      deserializeWebviewPanel: (panel, state) => loadTableViz().restoreBoard(panel, state),
    }),

    // "Select Cluster": after you select a cluster, delete all sessions. They are on the old cluster.
    // The local Python processes stop also: Databricks Connect in them uses the old cluster.
    vscode.commands.registerCommand('dbxNotebook.selectCluster', async () => {
      const nb = activeNotebook();
      const uri = nb ? nb.uri : vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri;
      try {
        if (await conn.pickCluster(uri)) await Promise.all([kernel.resetAll(), localKernel.resetAll()]);
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),

    // "Reset Execution Context": the cluster or the local Python process forgets the variables of the notebook that you look at.
    vscode.commands.registerCommand('dbxNotebook.resetContext', async () => {
      const nb = activeNotebook();
      if (!nb) return;
      await Promise.all([kernel.reset(nb.uri), localKernel.reset(nb.uri)]);
      vscode.window.setStatusBarMessage('Databricks execution context reset: notebook state cleared', 4000);
    })
  );

  // Handle the notebooks and the text editor that were open before the extension started.
  selectKernel(vscode.window.activeNotebookEditor);
  updateButton(vscode.window.activeTextEditor);
  autoOpen(vscode.window.activeTextEditor);
}

/**
 * Stop the extension. VS Code then removes the parts in `context.subscriptions`.
 *
 * The function deletes the sessions of the open notebooks on the cluster and
 * stops the local Python processes.
 * VS Code waits for the returned promise, so the requests can finish before
 * VS Code stops. Without this, each reload of the VS Code window can leave one
 * session for each open notebook on the cluster.
 *
 * @returns {Promise<void>|undefined}
 */
function deactivate() {
  return Promise.all(activeKernels.map((k) => k.dispose()));
}

module.exports = { activate, deactivate, NOTEBOOK_TYPE };
