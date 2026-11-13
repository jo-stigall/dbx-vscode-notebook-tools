/**
 * The list of the command "Search Tables": type a part of a table name and select a table.
 *
 * The list is a VS Code quick pick. After each change of the text it asks
 * search.ts for the tables that fit, and it stops the search of the text
 * before. The search runs no SQL.
 */
import * as vscode from 'vscode';
import { parseTableName } from '../core/names.ts';
import type { TableName } from '../core/schema.ts';
import type { SearchScope } from '../core/search.ts';
import { SEARCH_LIMIT, searchTables } from './search.ts';
import type { Session } from './session.ts';
import type { TableTree } from './tree.ts';

/** How long the list waits after the last key before it searches, in milliseconds. */
const WAIT_AFTER_KEY_MS = 250;

/** One line of the list. A line without `table` is a message, and a click on it does nothing. */
interface Line extends vscode.QuickPickItem {
  table?: TableName;
}

/**
 * Tell in words where a search looks.
 *
 * @example
 * scopeText({})                                    // 'all catalogs'
 * scopeText({ catalog: 'main' })                   // 'main'
 * scopeText({ catalog: 'main', schema: 'shop' })   // 'main.shop'
 */
export function scopeText(scope: SearchScope): string {
  if (scope.catalog && scope.schema) return `${scope.catalog}.${scope.schema}`;
  return scope.catalog ?? 'all catalogs';
}

/** Make a line that shows a message. */
const message = (label: string, detail?: string): Line => ({ label, detail, alwaysShow: true });

/**
 * Show the search list and return the table that the user selects.
 *
 * | Scope        | With no text, the list shows            | The search starts after |
 * |--------------|-----------------------------------------|-------------------------|
 * | all catalogs | the favorite and the recent tables      | 2 characters            |
 * | one catalog  | a hint                                  | 2 characters            |
 * | one schema   | all tables of the schema                | 0 characters            |
 *
 * @example
 * const table = await pickTable(session, tree, { catalog: 'main' });
 * // The user types "ord" and selects "orders  main.shop": { catalog: 'main', schema: 'shop', name: 'orders' }
 *
 * @param session  Gives the workspace of the selected profile.
 * @param tree  Gives the favorite and the recent tables.
 * @param scope  Where the search looks.
 * @param text  The text that is in the box when the list opens. The list searches for it at once.
 * @returns The table, or undefined if the user closes the list.
 */
export function pickTable(session: Session, tree: TableTree, scope: SearchScope, text = ''): Promise<TableName | undefined> {
  const workspace = session.workspace(session.profile);
  const list = vscode.window.createQuickPick<Line>();
  list.title = `Search tables in ${scopeText(scope)} (profile: ${session.label(session.profile)})`;
  list.placeholder = scope.schema ? 'Type a part of a table name' : 'Type 2 letters or more of a table name. "shop.ord" also looks at the schema name.';
  // Databricks does the search. VS Code must not hide a line because its text is different from the box, for example for "shop.ord".
  list.matchOnDescription = false;

  /** The catalogs of the workspace. The list asks for them one time, when a search needs them. */
  let catalogs: string[] | undefined;
  /** Stops the search that runs now. */
  let running: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** The favorite and the recent tables that contain the text, for a search in all catalogs with a short text. */
  const knownTables = (text: string): Line[] => {
    if (scope.catalog) return [];
    const lines: Line[] = [];
    const seen = new Set<string>();
    for (const [names, icon, what] of [[tree.favorites, 'star-full', 'Favorite'], [tree.recents, 'history', 'Recent']] as const) {
      for (const name of names) {
        const table = parseTableName(name);
        if (!table || seen.has(name) || !name.toLowerCase().includes(text.toLowerCase())) continue;
        seen.add(name);
        lines.push({ label: `$(${icon}) ${table.name}`, description: `${table.catalog}.${table.schema}`, detail: what, table, alwaysShow: true });
      }
    }
    return lines;
  };

  /** Search for the text of the box and show the result. A newer search stops this one. */
  const search = async (text: string): Promise<void> => {
    running?.abort();
    const mine = (running = new AbortController());
    list.busy = true;
    try {
      // A text with a catalog, or a scope with a catalog, needs no list of catalogs.
      const needsCatalogs = !scope.catalog && text.split('.').length < 3;
      if (needsCatalogs && text.replace(/\./g, '').trim().length >= 2) catalogs ??= await workspace.listCatalogs();
      const result = await searchTables(workspace, scope, text, { signal: mine.signal, catalogs });
      if (mine.signal.aborted) return;
      const lines: Line[] = result.tables.map((found) => ({
        label: `$(${found.tableType === 'view' ? 'eye' : 'table'}) ${found.table.name}`,
        description: `${found.table.catalog}.${found.table.schema}`,
        table: found.table,
        alwaysShow: true,
      }));
      if (result.tooShort) {
        lines.push(...knownTables(text));
        if (lines.length === 0) lines.push(message(`Type 2 letters or more to search ${scopeText(scope)}.`));
      } else if (lines.length === 0) {
        lines.push(message('No table has this text in its name.', `Searched: ${scopeText(scope)}`));
      }
      if (result.more) lines.push(message(`$(info) More than ${SEARCH_LIMIT} tables fit. Type more letters.`));
      if (result.problems.length > 0) {
        lines.push(message(`$(warning) The search could not read ${result.problems.length === 1 ? '1 catalog' : `${result.problems.length} catalogs`}.`, result.problems.join('  ·  ')));
      }
      list.items = lines;
    } catch (e) {
      if (mine.signal.aborted) return;
      list.items = [message('$(error) The search failed.', e instanceof Error ? e.message : String(e))];
    } finally {
      if (running === mine) list.busy = false;
    }
  };

  return new Promise<TableName | undefined>((resolve) => {
    let picked: TableName | undefined;
    list.onDidChangeValue((text) => {
      clearTimeout(timer);
      timer = setTimeout(() => void search(text), WAIT_AFTER_KEY_MS);
    });
    list.onDidAccept(() => {
      const table = list.selectedItems[0]?.table;
      if (!table) return; // A message line: keep the list open.
      picked = table;
      list.hide();
    });
    list.onDidHide(() => {
      clearTimeout(timer);
      running?.abort();
      list.dispose();
      resolve(picked);
    });
    list.value = text;
    list.show();
    void search(text);
  });
}
