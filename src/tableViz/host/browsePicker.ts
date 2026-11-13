/**
 * The list of "Visualize Table" and "Compare Tables": go from a catalog to a schema to a table.
 *
 * The list is a VS Code quick pick with three levels:
 *
 * | Level     | The list shows                                              |
 * |-----------|-------------------------------------------------------------|
 * | top       | the favorite and the recent tables, then the catalogs       |
 * | a catalog | the schemas of the catalog                                  |
 * | a schema  | the tables and views of the schema                          |
 *
 * On each level, the text of the box filters the lines. A name with a dot
 * goes one level down: `main.` opens the catalog `main`. A full name
 * (`main.shop.orders`) gives a line that opens that table, so the user can
 * paste a name and press Enter.
 *
 * The list reads the catalog with the REST API. It runs no SQL.
 */
import * as vscode from 'vscode';
import { displayTableName, parseTableName } from '../core/names.ts';
import type { TableName } from '../core/schema.ts';
import { stepInto, type SearchScope } from '../core/search.ts';
import { pickTable, scopeText } from './searchPicker.ts';
import type { Session } from './session.ts';
import type { TableTree } from './tree.ts';

/**
 * One line of the list. The field that is set tells what Enter does:
 *
 * | Field                 | Enter                                           |
 * |-----------------------|-------------------------------------------------|
 * | `table`               | returns the table                               |
 * | `into`                | shows that level                                |
 * | `search`              | opens the search list with this text            |
 * | none                  | nothing: the line is a message                  |
 */
interface Line extends vscode.QuickPickItem {
  table?: TableName;
  into?: SearchScope;
  search?: string;
}

/** Make a line that shows a message. */
const message = (label: string, detail?: string): Line => ({ label, detail, alwaysShow: true });

/**
 * Show the list and return the table that the user selects.
 *
 * @example
 * const table = await browseTable(session, tree, 'Visualize Table');
 * // The user selects "main", then "shop", then "orders": { catalog: 'main', schema: 'shop', name: 'orders' }
 * // Or the user pastes "main.shop.orders" and presses Enter: the same table.
 *
 * @param session  Gives the workspace of the selected profile.
 * @param tree  Gives the favorite and the recent tables.
 * @param title  The start of the title of the list. Example: 'Visualize Table'.
 * @returns The table, or undefined if the user closes the list.
 */
export function browseTable(session: Session, tree: TableTree, title: string): Promise<TableName | undefined> {
  const workspace = session.workspace(session.profile);
  const list = vscode.window.createQuickPick<Line>();
  // A favorite line has the catalog and the schema in its description. Let the text of the box find them.
  list.matchOnDescription = true;

  /** The level that the list shows now. `{}` is the top. */
  let level: SearchScope = {};
  /** The lines of the level, without the lines that depend on the text of the box. */
  let lines: Line[] = [];
  /** The names that a text with a dot can go into: the catalogs at the top, the schemas in a catalog. */
  let names: string[] = [];
  /** Increases each time the list starts to load a level. An older load then does not show its lines. */
  let loads = 0;

  /** The favorite and the recent tables, each one time. */
  const knownTables = (): Line[] => {
    const known: Line[] = [];
    const seen = new Set<string>();
    for (const [stored, icon, what] of [[tree.favorites, 'star-full', 'Favorite'], [tree.recents, 'history', 'Recent']] as const) {
      for (const name of stored) {
        const table = parseTableName(name);
        if (!table || seen.has(name)) continue;
        seen.add(name);
        known.push({ label: `$(${icon}) ${table.name}`, description: `${table.catalog}.${table.schema}`, detail: what, table });
      }
    }
    return known;
  };

  /**
   * Show the lines of the level, plus the lines that depend on the text:
   * a line that opens a full name, and a line that starts a search.
   */
  const render = (): void => {
    const text = list.value.trim();
    const first: Line[] = [];
    const last: Line[] = [];
    const full = parseTableName(text);
    if (full) first.push({ label: `$(arrow-right) ${displayTableName(full)}`, description: 'Open this table', table: full, alwaysShow: true });
    if (!level.schema && !full && text.replace(/\./g, '').length >= 2) {
      last.push({ label: `$(search) Search ${scopeText(level)} for "${text}"`, description: 'Find tables by a part of their name', search: text, alwaysShow: true });
    }
    list.items = [...first, ...lines, ...last];
  };

  /** Read the lines of a level from the workspace and show them. `text` goes in the box. */
  const show = async (next: SearchScope, text: string): Promise<void> => {
    const mine = ++loads;
    level = next;
    lines = [];
    names = [];
    list.value = text;
    list.title = `${title}: ${next.catalog ? scopeText(next) : 'select a table'} (profile: ${session.label(session.profile)})`;
    list.placeholder = next.schema ? 'Select a table, or type a part of its name' : next.catalog ? 'Select a schema, or type its name and a dot' : 'Select a table or a catalog, or paste catalog.schema.table';
    list.buttons = next.catalog ? [vscode.QuickInputButtons.Back] : [];
    list.busy = true;
    render();
    let loaded: Line[];
    let found: string[] = [];
    try {
      if (next.catalog && next.schema) {
        const tables = await workspace.listTables(next.catalog, next.schema);
        loaded = tables.map((t) => ({
          label: `$(${t.tableType === 'view' ? 'eye' : 'table'}) ${t.name}`,
          description: t.tableType === 'view' ? 'view' : undefined,
          table: { catalog: next.catalog as string, schema: next.schema as string, name: t.name },
        }));
        if (loaded.length === 0) loaded.push(message('This schema has no tables that you can read.'));
      } else if (next.catalog) {
        found = await workspace.listSchemas(next.catalog);
        loaded = found.map((schema) => ({ label: `$(folder) ${schema}`, into: { catalog: next.catalog, schema } }));
        if (loaded.length === 0) loaded.push(message('This catalog has no schemas that you can read.'));
      } else {
        const known = knownTables();
        found = await workspace.listCatalogs();
        loaded = [
          ...(known.length ? [{ label: 'Favorite and recent tables', kind: vscode.QuickPickItemKind.Separator } as Line] : []),
          ...known,
          { label: 'Catalogs', kind: vscode.QuickPickItemKind.Separator },
          ...found.map((catalog): Line => ({ label: `$(library) ${catalog}`, into: { catalog } })),
        ];
      }
    } catch (e) {
      // At the top, the favorite and the recent tables need no request. Show them with the error.
      loaded = [...(next.catalog ? [] : knownTables()), message('$(error) The list could not read this level.', e instanceof Error ? e.message : String(e))];
    }
    if (mine !== loads) return;
    lines = loaded;
    names = found;
    list.busy = false;
    // The user can type while the level loads. Read the text of the box again.
    onText(list.value);
  };

  /** Go one level down if the text names a line and a dot. If not, show the lines for the text. */
  const onText = (text: string): void => {
    const step = level.schema ? undefined : stepInto(text, names);
    if (step) void show(level.catalog ? { catalog: level.catalog, schema: step.name } : { catalog: step.name }, step.rest);
    else render();
  };

  return new Promise<TableName | undefined>((resolve) => {
    let picked: TableName | undefined;
    /** Set when the user selects the search line: the function that shows the search list. */
    let search: (() => Promise<TableName | undefined>) | undefined;
    list.onDidChangeValue(onText);
    list.onDidTriggerButton(() => void show(level.schema ? { catalog: level.catalog } : {}, ''));
    list.onDidAccept(() => {
      const line = list.selectedItems[0];
      if (line?.into) return void show(line.into, '');
      if (line?.search !== undefined) {
        const scope = level;
        const text = line.search;
        search = () => pickTable(session, tree, scope, text);
      } else if (line?.table) {
        picked = line.table;
      } else {
        return; // A message line, or no line: keep the list open.
      }
      list.hide();
    });
    list.onDidHide(() => {
      loads++;
      list.dispose();
      resolve(search ? search() : picked);
    });
    list.show();
    void show({}, '');
  });
}
