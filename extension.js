'use strict';
const vscode = require('vscode');
const { parseNotebook, serializeNotebook, HEADER } = require('./src/format');
const { Connection } = require('./src/client');
const { Kernel } = require('./src/kernel');

const NOTEBOOK_TYPE = 'dbx-notebook';

const serializer = {
  deserializeNotebook(content) {
    const nb = parseNotebook(new TextDecoder().decode(content));
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
    data.metadata = { dbx: { eol: nb.eol, header: nb.header, trailer: nb.trailer } };
    return data;
  },

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

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const conn = new Connection(context);
  const kernel = new Kernel(NOTEBOOK_TYPE, conn);
  const isOurs = (nb) => nb && nb.notebookType === NOTEBOOK_TYPE;
  const activeNotebook = () => {
    const nb = vscode.window.activeNotebookEditor && vscode.window.activeNotebookEditor.notebook;
    return isOurs(nb) ? nb : undefined;
  };

  // Text editor -> notebook, for files that start with the Databricks header.
  const recentlyClosed = new Map(); // uri -> time the notebook view was closed
  async function autoOpen(editor) {
    if (!editor || !vscode.workspace.getConfiguration('dbxNotebook').get('autoOpen')) return;
    const doc = editor.document;
    if (doc.uri.scheme !== 'file' || !doc.fileName.endsWith('.py') || doc.isDirty) return;
    if (!doc.lineCount || !doc.lineAt(0).text.startsWith(HEADER)) return;
    const key = doc.uri.toString();
    // Respect "Reopen Editor With... Text Editor": don't bounce straight back.
    if (vscode.workspace.notebookDocuments.some((nb) => isOurs(nb) && nb.uri.toString() === key)) return;
    if (Date.now() - (recentlyClosed.get(key) || 0) < 2000) return;
    await openAsNotebook(doc.uri);
  }

  async function openAsNotebook(uri) {
    uri = uri || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!uri) return;
    const key = uri.toString();
    const textTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.toString() === key && !t.isDirty);
    await vscode.commands.executeCommand('vscode.openWith', uri, NOTEBOOK_TYPE);
    await vscode.window.tabGroups.close(textTabs).then(undefined, () => {});
  }

  context.subscriptions.push(
    kernel,
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, { transientOutputs: true }),

    vscode.window.onDidChangeActiveTextEditor(autoOpen),
    vscode.workspace.onDidOpenNotebookDocument((nb) => {
      if (isOurs(nb)) kernel.controller.updateNotebookAffinity(nb, vscode.NotebookControllerAffinity.Preferred);
    }),
    vscode.workspace.onDidCloseNotebookDocument((nb) => {
      if (!isOurs(nb)) return;
      recentlyClosed.set(nb.uri.toString(), Date.now());
      kernel.reset(nb.uri);
    }),

    // Show a cell's Databricks title (# DBTITLE) under the cell.
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(NOTEBOOK_TYPE, {
      provideCellStatusBarItems(cell) {
        const t = cell.metadata && cell.metadata.dbx && cell.metadata.dbx.dbtitle;
        if (!t) return [];
        return [new vscode.NotebookCellStatusBarItem(t.replace(/^\d+,/, ''), vscode.NotebookCellStatusBarAlignment.Left)];
      },
    }),

    vscode.commands.registerCommand('dbxNotebook.openAsNotebook', openAsNotebook),
    vscode.commands.registerCommand('dbxNotebook.selectCluster', async () => {
      const nb = activeNotebook();
      const uri = nb ? nb.uri : vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0].uri;
      try {
        if (await conn.pickCluster(uri)) await kernel.resetAll();
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    }),
    vscode.commands.registerCommand('dbxNotebook.resetContext', async () => {
      const nb = activeNotebook();
      if (!nb) return;
      await kernel.reset(nb.uri);
      vscode.window.setStatusBarMessage('Databricks execution context reset: notebook state cleared', 4000);
    })
  );

  for (const nb of vscode.workspace.notebookDocuments) {
    if (isOurs(nb)) kernel.controller.updateNotebookAffinity(nb, vscode.NotebookControllerAffinity.Preferred);
  }
  autoOpen(vscode.window.activeTextEditor);
}

function deactivate() {}

module.exports = { activate, deactivate, NOTEBOOK_TYPE };
