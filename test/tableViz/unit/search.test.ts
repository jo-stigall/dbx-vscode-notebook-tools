/**
 * Tests for the table search of the view "Databricks Tables".
 *
 * Source files that the tests cover:
 *
 * - src/tableViz/core/search.ts: `parseSearch`, `hasEnoughText`, `likePattern`, `like`, `matches`, `rank`, `stepInto`
 * - src/tableViz/host/search.ts: `searchTables`
 *
 * The tests use the Demo profile and small workspaces that are made in this
 * file. test/tableViz/unit/workspace.test.ts tests the request to the fake
 * Databricks workspace.
 *
 * Run all unit tests: npm run test:unit
 * Run this file only: node --test test/tableViz/unit/search.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TableName } from '../../../src/tableViz/core/schema.ts';
import { hasEnoughText, like, likePattern, matches, parseSearch, rank, stepInto, type FoundTable } from '../../../src/tableViz/core/search.ts';
import { SEARCH_LIMIT, searchTables } from '../../../src/tableViz/host/search.ts';
import { DemoWorkspaceClient, type FoundTables, type WorkspaceClient } from '../../../src/tableViz/host/workspace.ts';

/**
 * Make a table of a search result from its full name.
 *
 * @example
 * found('main.shop.orders')   // { table: { catalog: 'main', schema: 'shop', name: 'orders' }, tableType: 'table' }
 */
function found(fullName: string): FoundTable {
  const [catalog, schema, name] = fullName.split('.') as [string, string, string];
  return { table: { catalog, schema, name }, tableType: 'table' };
}

/**
 * Make a workspace that knows a list of tables, and records each search request.
 *
 * @example
 * const { workspace, asked } = workspaceWith(['main.shop.orders'], ['broken']);
 * await workspace.findTables('main', undefined, '%ord%', 200);   // finds main.shop.orders
 * asked   // ['main||%ord%']: catalog, schema pattern, table pattern
 *
 * @param names  The full names of the tables.
 * @param failing  Catalogs that the workspace cannot read. A search in one of them throws an error.
 */
function workspaceWith(names: string[], failing: string[] = []) {
  const tables = names.map(found);
  const catalogs = [...new Set([...tables.map((t) => t.table.catalog), ...failing])].sort();
  const asked: string[] = [];
  const workspace = {
    listCatalogs: async () => catalogs,
    findTables: async (catalog: string, schemaPattern: string | undefined, tablePattern: string | undefined, limit: number): Promise<FoundTables> => {
      asked.push(`${catalog}|${schemaPattern ?? ''}|${tablePattern ?? ''}`);
      if (failing.includes(catalog)) throw new Error('No permission.');
      const fit = tables.filter((t) => t.table.catalog === catalog && like(t.table.schema, schemaPattern) && like(t.table.name, tablePattern));
      return { tables: fit.slice(0, limit), more: fit.length > limit };
    },
  } as unknown as WorkspaceClient;
  return { workspace, asked };
}

/** The full names of the tables of a search result, in their sequence. */
const namesOf = (tables: FoundTable[]) => tables.map((t) => `${t.table.catalog}.${t.table.schema}.${t.table.name}`);

test('search text: the last part is the table, and the scope gives the parts that the text does not have', () => {
  assert.deepEqual(parseSearch('ord', {}), { schema: '', schemaExact: false, table: 'ord' });
  assert.deepEqual(parseSearch('shop.ord', {}), { schema: 'shop', schemaExact: false, table: 'ord' });
  assert.deepEqual(parseSearch('main.shop.ord', {}), { catalog: 'main', schema: 'shop', schemaExact: false, table: 'ord' });
  assert.deepEqual(parseSearch('ord', { catalog: 'main' }), { catalog: 'main', schema: '', schemaExact: false, table: 'ord' });
  assert.deepEqual(parseSearch('ord', { catalog: 'main', schema: 'shop' }), { catalog: 'main', schema: 'shop', schemaExact: true, table: 'ord' });
  assert.deepEqual(parseSearch('', { catalog: 'main', schema: 'shop' }), { catalog: 'main', schema: 'shop', schemaExact: true, table: '' });
  // A schema that the user types replaces the schema of the scope, and is a part of a name.
  assert.deepEqual(parseSearch('web.ord', { catalog: 'main', schema: 'shop' }), { catalog: 'main', schema: 'web', schemaExact: false, table: 'ord' });
  // Upper case, spaces, backticks and "%" in the text.
  assert.deepEqual(parseSearch(' `Shop`.OR%D ', {}), { schema: 'shop', schemaExact: false, table: 'ord' });
});

test('the list of "Visualize Table": a name and a dot go one level down', () => {
  const catalogs = ['dev', 'main', 'My Catalog'];
  assert.deepEqual(stepInto('main.', catalogs), { name: 'main', rest: '' });
  assert.deepEqual(stepInto('main.sh', catalogs), { name: 'main', rest: 'sh' });
  // A full name that the user pastes: the list goes into the catalog, then reads the rest in the same way.
  assert.deepEqual(stepInto('main.shop.orders', catalogs), { name: 'main', rest: 'shop.orders' });
  assert.deepEqual(stepInto('shop.orders', ['hr', 'shop']), { name: 'shop', rest: 'orders' });
  // Upper case and backticks. The result has the name as the list writes it.
  assert.deepEqual(stepInto('MAIN.x', catalogs), { name: 'main', rest: 'x' });
  assert.deepEqual(stepInto('`my catalog`.x', catalogs), { name: 'My Catalog', rest: 'x' });
  // No dot, or a name that the list does not have: stay on the level.
  assert.equal(stepInto('mai', catalogs), undefined);
  assert.equal(stepInto('prod.x', catalogs), undefined);
  assert.equal(stepInto('', catalogs), undefined);
});

test('search text: a search starts after two characters, or at once in one schema', () => {
  assert.equal(hasEnoughText(parseSearch('', {})), false);
  assert.equal(hasEnoughText(parseSearch('o', { catalog: 'main' })), false);
  assert.equal(hasEnoughText(parseSearch('or', { catalog: 'main' })), true);
  assert.equal(hasEnoughText(parseSearch('shop.', {})), true);
  assert.equal(hasEnoughText(parseSearch('', { catalog: 'main', schema: 'shop' })), true);
});

test('patterns: "contains" for a part of a name, and "_" fits one character', () => {
  assert.equal(likePattern('ord'), '%ord%');
  assert.equal(likePattern('shop', true), 'shop');
  assert.equal(likePattern(''), undefined);
  assert.equal(like('orders_2026', '%ord%'), true);
  assert.equal(like('orders_2026', 'orders'), false);
  assert.equal(like('ORDERS', '%ord%'), true);
  assert.equal(like('ordersX2026', '%s_2%'), true);
  assert.equal(like('a.b', 'a.b'), true);
  assert.equal(like('axb', 'a.b'), false, 'a dot in a pattern is a dot');
  assert.equal(like('anything', undefined), true);
});

test('a result must contain the text as the user typed it', () => {
  const parts = parseSearch('shop.ord_2', {});
  const table = (schema: string, name: string): TableName => ({ catalog: 'main', schema, name });
  assert.equal(matches(table('webshop', 'ord_2025'), parts), true);
  assert.equal(matches(table('shop', 'orders_2026'), parts), false);
  assert.equal(matches(table('hr', 'ord_2025'), parts), false);
  // In the scope of one schema, the name of the schema must be equal.
  assert.equal(matches(table('webshop', 'ord_2025'), parseSearch('ord', { catalog: 'main', schema: 'shop' })), false);
});

test('the best match comes first: the same name, then the start of the name, then all others', () => {
  const tables = ['main.z.old_orders', 'main.b.orders_2026', 'main.c.orders', 'main.a.orders_2025'].map(found);
  assert.deepEqual(namesOf(rank(tables, parseSearch('orders', {}))), ['main.c.orders', 'main.a.orders_2025', 'main.b.orders_2026', 'main.z.old_orders']);
  // With no text, the tables are in the sequence of their names.
  assert.deepEqual(namesOf(rank(tables, parseSearch('', { catalog: 'main', schema: 'x' }))), ['main.a.orders_2025', 'main.b.orders_2026', 'main.c.orders', 'main.z.old_orders']);
});

test('search: all catalogs, one catalog and one schema', async () => {
  const { workspace, asked } = workspaceWith(['main.shop.orders', 'main.shop.order_lines', 'main.hr.people', 'dev.shop.orders', 'dev.tmp.reorders']);

  // All catalogs: one request for each catalog.
  const all = await searchTables(workspace, {}, 'ord');
  assert.deepEqual(namesOf(all.tables), ['dev.shop.orders', 'main.shop.order_lines', 'main.shop.orders', 'dev.tmp.reorders']);
  assert.deepEqual([all.more, all.problems, all.tooShort], [false, [], false]);
  assert.deepEqual(asked.sort(), ['dev||%ord%', 'main||%ord%']);

  // One catalog: one request.
  asked.length = 0;
  assert.deepEqual(namesOf((await searchTables(workspace, { catalog: 'main' }, 'ord')).tables), ['main.shop.order_lines', 'main.shop.orders']);
  assert.deepEqual(asked, ['main||%ord%']);

  // One schema with no text: all tables of the schema. The pattern is the full name of the schema.
  asked.length = 0;
  assert.deepEqual(namesOf((await searchTables(workspace, { catalog: 'main', schema: 'shop' }, '')).tables), ['main.shop.order_lines', 'main.shop.orders']);
  assert.deepEqual(asked, ['main|shop|']);

  // A text with a schema and with a catalog.
  assert.deepEqual(namesOf((await searchTables(workspace, {}, 'tmp.ord')).tables), ['dev.tmp.reorders']);
  assert.deepEqual(namesOf((await searchTables(workspace, {}, 'dev.shop.ord')).tables), ['dev.shop.orders']);

  // A text that is too short sends no request.
  asked.length = 0;
  assert.deepEqual(await searchTables(workspace, {}, 'o'), { tables: [], more: false, problems: [], tooShort: true });
  assert.deepEqual(asked, []);

  // A caller that has the list of catalogs gives it, and the search does not ask for it.
  assert.deepEqual(namesOf((await searchTables(workspace, {}, 'people', { catalogs: ['main'] })).tables), ['main.hr.people']);
});

test('search: a catalog that fails does not stop the search', async () => {
  const { workspace } = workspaceWith(['main.shop.orders'], ['hive_metastore']);
  const result = await searchTables(workspace, {}, 'orders');
  assert.deepEqual(namesOf(result.tables), ['main.shop.orders']);
  assert.deepEqual(result.problems, ['hive_metastore: No permission.']);
});

test('search: more tables than the limit', async () => {
  const names = Array.from({ length: SEARCH_LIMIT + 5 }, (_, i) => `main.shop.orders_${String(i).padStart(4, '0')}`);
  const { workspace } = workspaceWith(names);
  const result = await searchTables(workspace, { catalog: 'main' }, 'orders');
  assert.equal(result.tables.length, SEARCH_LIMIT);
  assert.equal(result.more, true);
  assert.equal(result.tables[0]?.table.name, 'orders_0000');
});

test('search: a signal that fired stops the search', async () => {
  const { workspace, asked } = workspaceWith(['main.shop.orders']);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchTables(workspace, {}, 'orders', { signal: controller.signal }));
  assert.deepEqual(asked, []);
});

test('search: the Demo profile', async () => {
  const demo = new DemoWorkspaceClient();
  assert.deepEqual(namesOf((await searchTables(demo, {}, '2026')).tables), ['demo.shop.orders_2026']);
  assert.deepEqual(namesOf((await searchTables(demo, { catalog: 'demo', schema: 'shop' }, '')).tables), ['demo.shop.orders_2025', 'demo.shop.orders_2026']);
  assert.deepEqual((await searchTables(demo, {}, 'nothing')).tables, []);
});
