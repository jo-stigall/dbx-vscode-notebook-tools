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
 */
const vscode = require('vscode');
const { parseNotebook, serializeNotebook, hasHeader } = require('./src/format');
const { Connection } = require('./src/client');
const { Kernel } = require('./src/kernel');

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

/** The kernel of the running extension. deactivate() uses it. */
let activeKernel;

/**
 * Start the extension. VS Code calls this function one time.
 *
 * The function adds these parts to VS Code:
 *
 * - The serializer, so that VS Code can open and save .py notebooks.
 * - The kernel "Databricks Cluster", so that you can run cells.
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
  activeKernel = kernel;

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
   * - The file is open as a notebook, or you closed its notebook less than
   *   2 seconds ago. This occurs when you select "Reopen Editor With... >
   *   Text Editor". The file must then stay open as text.
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
    if (vscode.workspace.notebookDocuments.some((nb) => isOurs(nb) && nb.uri.toString() === key)) return;
    if (Date.now() - (recentlyClosed.get(key) || 0) < 2000) return;
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

    // Select the "Databricks Cluster" kernel for each notebook that opens.
    vscode.workspace.onDidOpenNotebookDocument((nb) => {
      if (isOurs(nb)) kernel.controller.updateNotebookAffinity(nb, vscode.NotebookControllerAffinity.Preferred);
    }),

    // When you close a notebook, delete its session on the cluster.
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      if (!isOurs(nb)) return;
      recentlyClosed.set(nb.uri.toString(), Date.now());
      kernel.reset(nb.uri);
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
    vscode.commands.registerCommand('dbxNotebook.selectCluster', async () => {
      const nb = activeNotebook();
      const uri = nb ? nb.uri : vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri;
      try {
        if (await conn.pickCluster(uri)) await kernel.resetAll();
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),

    // "Reset Execution Context": the cluster forgets the variables of the notebook that you look at.
    vscode.commands.registerCommand('dbxNotebook.resetContext', async () => {
      const nb = activeNotebook();
      if (!nb) return;
      await kernel.reset(nb.uri);
      vscode.window.setStatusBarMessage('Databricks execution context reset: notebook state cleared', 4000);
    })
  );

  // Handle the notebooks and the text editor that were open before the extension started.
  for (const nb of vscode.workspace.notebookDocuments) {
    if (isOurs(nb)) kernel.controller.updateNotebookAffinity(nb, vscode.NotebookControllerAffinity.Preferred);
  }
  updateButton(vscode.window.activeTextEditor);
  autoOpen(vscode.window.activeTextEditor);
}

/**
 * Stop the extension. VS Code then removes the parts in `context.subscriptions`.
 *
 * The function deletes the sessions of the open notebooks on the cluster.
 * VS Code waits for the returned promise, so the requests can finish before
 * VS Code stops. Without this, each reload of the VS Code window can leave one
 * session for each open notebook on the cluster.
 *
 * @returns {Promise<void>|undefined}
 */
function deactivate() {
  return activeKernel && activeKernel.dispose();
}

module.exports = { activate, deactivate, NOTEBOOK_TYPE };
