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

/** One line in the tree. */
export type Node =
  | { kind: 'group'; group: 'favorites' | 'recents' }
  | { kind: 'catalog'; catalog: string }
  | { kind: 'schema'; catalog: string; schema: string }
  | { kind: 'table'; table: TableName; tableType?: 'table' | 'view'; favorite: boolean; inGroup?: 'favorites' | 'recents' }
  | { kind: 'message'; text: string; tooltip?: string };

const FAVORITES_KEY = 'dbxNotebook.tableViz.favorites';
const RECENTS_KEY = 'dbxNotebook.tableViz.recents';
/** The number of recent tables that the tree shows. */
const MAX_RECENTS = 10;

export class TableTree implements vscode.TreeDataProvider<Node> {
  private readonly context: vscode.ExtensionContext;
  private readonly session: Session;
  private readonly changed = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(context: vscode.ExtensionContext, session: Session) {
    this.context = context;
    this.session = session;
    context.subscriptions.push(this.changed);
  }

  /** Read all levels again. */
  refresh(): void {
    this.changed.fire();
  }

  /**
   * The key for the lists of the profile that is selected now. Each workspace has its own favorites and recent tables.
   * The Demo profile has the key 'Demo'.
   */
  private get listKey(): string {
    return this.session.hostOf(this.session.profile) || this.session.profile;
  }

  private names(key: string): string[] {
    return this.context.globalState.get<Record<string, string[]>>(key, {})[this.listKey] ?? [];
  }

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

  async addFavorite(table: TableName): Promise<void> {
    const name = displayTableName(table);
    if (!this.favorites.includes(name)) await this.setNames(FAVORITES_KEY, [...this.favorites, name].sort());
  }

  async removeFavorite(table: TableName): Promise<void> {
    const name = displayTableName(table);
    await this.setNames(FAVORITES_KEY, this.favorites.filter((f) => f !== name));
  }

  /** Put a table at the top of the recent tables. */
  async addRecent(table: TableName): Promise<void> {
    const name = displayTableName(table);
    await this.setNames(RECENTS_KEY, [name, ...this.recents.filter((r) => r !== name)].slice(0, MAX_RECENTS));
  }

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
        return item;
      }
      case 'schema': {
        const item = new vscode.TreeItem(node.schema, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon('folder');
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
