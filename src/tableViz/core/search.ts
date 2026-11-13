/**
 * The rules of the table search: how to read the text that the user types, and how to sort the tables that Databricks finds.
 *
 * The search of the view "Databricks Tables" uses these functions. The file
 * sends no request. host/search.ts sends the requests.
 */
import type { TableName } from './schema.ts';

/**
 * The place where a search looks.
 *
 * | Value                               | The search looks in        |
 * |-------------------------------------|----------------------------|
 * | `{}`                                | all catalogs               |
 * | `{ catalog: 'main' }`               | the catalog `main`         |
 * | `{ catalog: 'main', schema: 'shop' }` | the schema `main.shop`   |
 */
export interface SearchScope {
  catalog?: string;
  schema?: string;
}

/** What a search looks for. parseSearch() makes it from the text of the user and the scope. */
export interface SearchParts {
  /** The exact name of the catalog. Not set: search all catalogs. */
  catalog?: string;
  /** A part of the schema name, or the exact name if `schemaExact` is true. Empty: all schemas. */
  schema: string;
  /** true if `schema` is the full name of one schema, not a part of a name. */
  schemaExact: boolean;
  /** A part of the table name. Empty: all tables. */
  table: string;
}

/** A table that a search found. */
export interface FoundTable {
  table: TableName;
  /** 'view' for a view, a materialized view and a metric view. 'table' for all other types. */
  tableType: 'table' | 'view';
}

/**
 * Read the text that the user typed in the search box.
 *
 * A dot separates the parts of a name. The last part is the table. The part
 * before it is the schema, and the part before that is the catalog. A part
 * that the text does not have comes from the scope.
 *
 * Unity Catalog stores names in lower case, so the function changes the text
 * to lower case. It removes backticks and the characters `%`.
 *
 * @example
 * parseSearch('ord', {})                                  // { schema: '', schemaExact: false, table: 'ord' }
 * parseSearch('shop.ord', {})                             // { schema: 'shop', schemaExact: false, table: 'ord' }
 * parseSearch('main.shop.ord', {})                        // { catalog: 'main', schema: 'shop', schemaExact: false, table: 'ord' }
 * parseSearch('ord', { catalog: 'main' })                 // { catalog: 'main', schema: '', schemaExact: false, table: 'ord' }
 * parseSearch('ord', { catalog: 'main', schema: 'shop' }) // { catalog: 'main', schema: 'shop', schemaExact: true, table: 'ord' }
 * parseSearch('', { catalog: 'main', schema: 'shop' })    // { catalog: 'main', schema: 'shop', schemaExact: true, table: '' }: all tables of main.shop
 *
 * @param text  The text of the search box.
 * @param scope  The place where the search looks if the text names no catalog or schema.
 */
export function parseSearch(text: string, scope: SearchScope): SearchParts {
  const parts = text
    .toLowerCase()
    .replace(/[`%]/g, '')
    .split('.')
    .map((part) => part.trim());
  const table = parts.pop() ?? '';
  const schema = parts.pop();
  const catalog = parts.pop();
  const result: SearchParts = {
    schema: schema ?? scope.schema ?? '',
    // The schema of the scope is a full name. A schema that the user typed is a part of a name.
    schemaExact: schema === undefined && scope.schema !== undefined,
    table,
  };
  const inCatalog = catalog || scope.catalog;
  if (inCatalog) result.catalog = inCatalog;
  return result;
}

/**
 * Tell if the text of the box names one of the lines of the list, followed by a dot.
 *
 * The list of "Visualize Table" uses it: when you type `main.`, the list
 * goes into the catalog `main`. The comparison ignores upper and lower case
 * and backticks.
 *
 * @example
 * stepInto('main.sh', ['dev', 'main'])    // { name: 'main', rest: 'sh' }
 * stepInto('MAIN.', ['dev', 'main'])      // { name: 'main', rest: '' }
 * stepInto('mai', ['dev', 'main'])        // undefined: no dot
 * stepInto('prod.x', ['dev', 'main'])     // undefined: the list has no "prod"
 *
 * @param text  The text of the box.
 * @param names  The names of the lines: the catalogs, or the schemas of a catalog.
 * @returns `name`: the line as the list writes it. `rest`: the text after the dot.
 */
export function stepInto(text: string, names: string[]): { name: string; rest: string } | undefined {
  const dot = text.indexOf('.');
  if (dot < 0) return undefined;
  const first = text.slice(0, dot).replace(/`/g, '').trim().toLowerCase();
  const name = names.find((n) => n.toLowerCase() === first);
  return name === undefined ? undefined : { name, rest: text.slice(dot + 1) };
}

/**
 * Tell if a search has enough text to send a request.
 *
 * A search in one schema needs no text: it lists all tables of the schema.
 * A wider search needs two characters or more, so that the first letter
 * does not ask Databricks for each table of each catalog.
 *
 * @example
 * hasEnoughText(parseSearch('', { catalog: 'main', schema: 'shop' }))   // true
 * hasEnoughText(parseSearch('o', { catalog: 'main' }))                  // false
 * hasEnoughText(parseSearch('or', { catalog: 'main' }))                 // true
 * hasEnoughText(parseSearch('shop.', {}))                               // true: all tables of the schemas that contain "shop"
 */
export function hasEnoughText(parts: SearchParts): boolean {
  if (parts.schemaExact) return true;
  return parts.table.length + parts.schema.length >= 2;
}

/**
 * Make the pattern that Databricks uses to find a name that contains a text.
 *
 * Databricks reads the pattern as SQL LIKE: `%` is "zero or more characters"
 * and `_` is "one character". A `_` in the text thus also finds other
 * characters. matches() removes those results.
 *
 * @example
 * likePattern('ord')          // '%ord%'
 * likePattern('shop', true)   // 'shop': the full name
 * likePattern('')             // undefined: no pattern, all names
 *
 * @param exact  true: the text is the full name.
 */
export function likePattern(text: string, exact = false): string | undefined {
  if (!text) return undefined;
  return exact ? text : `%${text}%`;
}

/**
 * Tell if a name fits a SQL LIKE pattern. The Demo profile uses it in the place of Databricks.
 *
 * @example
 * like('orders_2026', '%ord%')   // true
 * like('orders_2026', 'orders')  // false: no `%`, so the full name must be equal
 * like('orders_2026', undefined) // true: no pattern, all names
 */
export function like(name: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  const source = pattern
    .split('')
    .map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${source}$`, 'i').test(name);
}

/**
 * Tell if a table has the text of the search in its names.
 *
 * @example
 * const parts = parseSearch('shop.ord_2', {});
 * matches({ catalog: 'main', schema: 'shop', name: 'orders_2026' }, parts)   // false: the name does not contain "ord_2"
 * matches({ catalog: 'main', schema: 'webshop', name: 'ord_2025' }, parts)   // true
 */
export function matches(table: TableName, parts: SearchParts): boolean {
  const schema = table.schema.toLowerCase();
  if (parts.catalog && table.catalog.toLowerCase() !== parts.catalog) return false;
  if (parts.schemaExact ? schema !== parts.schema : !schema.includes(parts.schema)) return false;
  return table.name.toLowerCase().includes(parts.table);
}

/**
 * Sort the tables that a search found: the best match first.
 *
 * 1. A table whose name is equal to the text.
 * 2. A table whose name starts with the text.
 * 3. All other tables.
 *
 * Tables in the same group are in the sequence of their full names.
 *
 * @example
 * // The text is "orders". The sequence is: orders, orders_2026, old_orders.
 * rank([oldOrders, orders2026, orders], parseSearch('orders', {}))
 */
export function rank(tables: FoundTable[], parts: SearchParts): FoundTable[] {
  const group = (name: string) => (name === parts.table ? 0 : parts.table && name.startsWith(parts.table) ? 1 : 2);
  const fullName = (t: TableName) => `${t.catalog}.${t.schema}.${t.name}`;
  return [...tables].sort((a, b) => group(a.table.name.toLowerCase()) - group(b.table.name.toLowerCase()) || fullName(a.table).localeCompare(fullName(b.table)));
}
