/**
 * The view "Databricks Tables": a tree of catalogs, schemas and tables.
 *
 * The tree reads one level only when the user opens it. It uses the Unity
 * Catalog REST API, so it never starts a warehouse. Favorites and recent
 * tables are at the top.
 *
 * To filter the tree, click in it and type (the "find" feature of VS Code
 * trees).
 */
import * as vscode from 'vscode';
import { displayTableName, parseTableName } from '../core/names.ts';
import type { TableName } from '../core/schema.ts';
import type { Session } from './session.ts';

/**
 * One line in the tree.
 *
 * | kind      | What the line shows                                                        |
 * |-----------|----------------------------------------------------------------------------|
 * | 'group'   | The heading "Favorites" or "Recent".                                       |
 * | 'catalog' | A catalog. The lines below it are its schemas.                             |
 * | 'schema'  | A schema. The lines below it are its tables and views.                     |
 * | 'table'   | A table or a view. A click opens a board.                                  |
 * | 'message' | Text for the user: "No tables", or the reason why the tree could not read a list. |
 *
 * For a 'table' line, `inGroup` is set if the line is below "Favorites" or
 * "Recent". `tableType` is not set there, because the stored lists hold
 * names only.
 *
 * @example
 * const node: Node = { kind: 'table', table: { catalog: 'main', schema: 'shop', name: 'orders' }, tableType: 'table', favorite: false };
 */
export type Node =
  | { kind: 'group'; group: 'favorites' | 'recents' }
  | { kind: 'catalog'; catalog: string }
  | { kind: 'schema'; catalog: string; schema: string }
  | { kind: 'table'; table: TableName; tableType?: 'table' | 'view'; favorite: boolean; inGroup?: 'favorites' | 'recents' }
  | { kind: 'message'; text: string; tooltip?: string };

/**
 * The name under which VS Code stores the favorite tables, for all windows.
 *
 * The stored value has one list for each workspace URL, and one for the Demo profile.
 *
 * @example
 * // { 'https://adb-123.azuredatabricks.net': ['main.shop.orders'], Demo: ['demo.shop.orders_2026'] }
 */
const FAVORITES_KEY = 'dbxNotebook.tableViz.favorites';
/** The name under which VS Code stores the recent tables. The stored value has the same form as the favorites. */
const RECENTS_KEY = 'dbxNotebook.tableViz.recents';
/** The number of recent tables that the tree shows. */
const MAX_RECENTS = 10;

/**
 * Gives VS Code the lines of the view "Databricks Tables", and stores the favorite and the recent tables.
 *
 * The tree shows the catalogs of the profile that is selected in the
 * session. When the user selects a different profile, index.ts calls
 * refresh(). extension.js gives the view to VS Code and passes each call
 * of VS Code to this class.
 *
 * @example
 * const tree = new TableTree(context, session);
 * await tree.addRecent({ catalog: 'main', schema: 'shop', name: 'orders' });
 * tree.recents   // ['main.shop.orders']
 */
export class TableTree implements vscode.TreeDataProvider<Node> {
  /** The tree stores the favorite and the recent tables in the `globalState` of this context. */
  private readonly context: vscode.ExtensionContext;
  /** The tree reads the selected profile and its WorkspaceClient from the session. */
  private readonly session: Session;
  /** Fires when the lines of the tree are not correct any more. */
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  /** The event that fires after refresh(). VS Code then calls getChildren() again. */
  readonly onDidChangeTreeData = this.changed.event;

  constructor(context: vscode.ExtensionContext, session: Session) {
    this.context = context;
    this.session = session;
    context.subscriptions.push(this.changed);
  }

  /** Tell VS Code to read all levels of the tree again. */
  refresh(): void {
    this.changed.fire();
  }

  /**
   * The key for the lists of the profile that is selected now: the workspace URL of the profile.
   *
   * Each workspace has its own favorites and recent tables. Two profiles
   * for the same workspace share them. The Demo profile has the key 'Demo'.
   */
  private get listKey(): string {
    return this.session.hostOf(this.session.profile) || this.session.profile;
  }

  /**
   * Read one stored list for the selected profile.
   *
   * @param key  FAVORITES_KEY or RECENTS_KEY.
   * @returns Table names such as 'main.shop.orders'. An empty list if VS Code stored none for this profile.
   */
  private names(key: string): string[] {
    return this.context.globalState.get<Record<string, string[]>>(key, {})[this.listKey] ?? [];
  }

  /**
   * Store one list for the selected profile, then refresh the tree.
   *
   * The lists of the other profiles do not change.
   *
   * @param key  FAVORITES_KEY or RECENTS_KEY.
   * @param names  The new list. It replaces the old list.
   */
  private async setNames(key: string, names: string[]): Promise<void> {
    const all = this.context.globalState.get<Record<string, string[]>>(key, {});
    await this.context.globalState.update(key, { ...all, [this.listKey]: names });
    this.refresh();
  }

  /** The favorite tables of the selected profile, as names such as 'main.sales.orders'. */
  get favorites(): string[] {
    return this.names(FAVORITES_KEY);
  }

  /** The tables that the user opened last, newest first. */
  get recents(): string[] {
    return this.names(RECENTS_KEY);
  }

  /**
   * Add a table to the favorites of the selected profile. The list stays sorted by name.
   *
   * The function does nothing if the table is a favorite already.
   *
   * @example
   * await tree.addFavorite({ catalog: 'main', schema: 'shop', name: 'orders' });
   * tree.favorites   // ['main.shop.orders']
   */
  async addFavorite(table: TableName): Promise<void> {
    const name = displayTableName(table);
    if (!this.favorites.includes(name)) await this.setNames(FAVORITES_KEY, [...this.favorites, name].sort());
  }

  /** Remove a table from the favorites of the selected profile. */
  async removeFavorite(table: TableName): Promise<void> {
    const name = displayTableName(table);
    await this.setNames(FAVORITES_KEY, this.favorites.filter((f) => f !== name));
  }

  /** Put a table at the top of the recent tables. The list keeps the 10 newest tables. */
  async addRecent(table: TableName): Promise<void> {
    const name = displayTableName(table);
    await this.setNames(RECENTS_KEY, [name, ...this.recents.filter((r) => r !== name)].slice(0, MAX_RECENTS));
  }

  /**
   * Make the line that VS Code shows for a node: the text, the icon, the tooltip and the command of a click.
   *
   * A click on a table line runs the command
   * `dbxNotebook.tableViz.visualizeNode`, which opens a board for the table.
   * A catalog and a schema start closed. "Favorites" and "Recent" start open.
   */
  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'group': {
        const item = new vscode.TreeItem(node.group === 'favorites' ? 'Favorites' : 'Recent', vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(node.group === 'favorites' ? 'star-full' : 'history');
        return item;
      }
      case 'catalog': {
        const item = new vscode.TreeItem(node.catalog, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('library');
        // package.json shows the button "Search Tables" for this value and for 'tableViz.schema'.
        item.contextValue = 'tableViz.catalog';
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.contextValue = 'tableViz.schema';
        return item;
      }
      case 'table': {
        // In "Favorites" and "Recent" the line shows the full name. In a schema it shows the table name only.
        const item = new vscode.TreeItem(node.inGroup ? displayTableName(node.table) : node.table.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(node.tableType === 'view' ? 'eye' : 'table');
        item.tooltip = displayTableName(node.table);
        item.description = node.tableType === 'view' ? 'view' : undefined;
        // package.json shows "Add to Favorites" or "Remove from Favorites" for these two values.
        item.contextValue = node.favorite ? 'tableViz.favorite' : 'tableViz.table';
        item.command = { command: 'dbxNotebook.tableViz.visualizeNode', title: 'Visualize', arguments: [node] };
        return item;
      }
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.tooltip = node.tooltip;
        item.iconPath = new vscode.ThemeIcon('info');
        return item;
      }
    }
  }

  /**
   * Get the lines below a node. VS Code asks for them when the user opens a level.
   *
   * | `node`            | The lines that the function returns                                   |
   * |-------------------|-----------------------------------------------------------------------|
   * | not set (the top) | "Favorites" and "Recent" if they have tables, then the catalogs.      |
   * | a group           | The stored tables of the group. No request to Databricks.             |
   * | a catalog         | The schemas of the catalog.                                           |
   * | a schema          | The tables and views of the schema, or the message "No tables".       |
   *
   * The function does not throw. If a list fails, for example because the
   * login does not work, it returns one 'message' line with the error text.
   *
   * @example
   * await tree.getChildren({ kind: 'catalog', catalog: 'demo' })
   * // [{ kind: 'schema', catalog: 'demo', schema: 'shop' }]
   */
  async getChildren(node?: Node): Promise<Node[]> {
    const workspace = this.session.workspace(this.session.profile);
    const favorites = new Set(this.favorites);
    const tableNode = (name: string, inGroup: 'favorites' | 'recents'): Node[] => {
      const table = parseTableName(name);
      return table ? [{ kind: 'table', table, favorite: favorites.has(name), inGroup }] : [];
    };
    try {
      if (!node) {
        const catalogs = await workspace.listCatalogs();
        return [
          ...(this.favorites.length ? [{ kind: 'group', group: 'favorites' } as Node] : []),
          ...(this.recents.length ? [{ kind: 'group', group: 'recents' } as Node] : []),
          ...catalogs.map((catalog): Node => ({ kind: 'catalog', catalog })),
        ];
      }
      if (node.kind === 'group') return (node.group === 'favorites' ? this.favorites : this.recents).flatMap((name) => tableNode(name, node.group));
      if (node.kind === 'catalog') return (await workspace.listSchemas(node.catalog)).map((schema): Node => ({ kind: 'schema', catalog: node.catalog, schema }));
      if (node.kind === 'schema') {
        const tables = await workspace.listTables(node.catalog, node.schema);
        if (tables.length === 0) return [{ kind: 'message', text: 'No tables' }];
        return tables.map((t): Node => {
          const table = { catalog: node.catalog, schema: node.schema, name: t.name };
          return { kind: 'table', table, tableType: t.tableType, favorite: favorites.has(displayTableName(table)) };
        });
      }
      return [];
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return [{ kind: 'message', text: `Could not read the list. ${text}`, tooltip: text }];
    }
  }
}
