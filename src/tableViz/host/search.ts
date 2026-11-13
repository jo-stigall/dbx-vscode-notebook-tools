/**
 * Search the tables of a workspace by name, for the view "Databricks Tables".
 *
 * The search asks Unity Catalog for the tables whose names contain the text
 * (the request "List table summaries"). It runs no SQL, so it never starts a
 * warehouse. One request searches one catalog.
 *
 * This file does not import `vscode`, so that a test can use it with the
 * Demo profile or a local server. searchPicker.ts shows the results.
 */
import { Limiter } from '../core/limiter.ts';
import { hasEnoughText, likePattern, matches, parseSearch, rank, type FoundTable, type SearchScope } from '../core/search.ts';
import type { WorkspaceClient } from './workspace.ts';

/** The largest number of tables that one search shows. */
export const SEARCH_LIMIT = 200;

/** The number of catalogs that a search of all catalogs asks at the same time. */
const CATALOGS_AT_ONE_TIME = 4;

/** What a search found. */
export interface SearchResult {
  /** The tables, the best match first. SEARCH_LIMIT tables at most. */
  tables: FoundTable[];
  /** true if more tables fit the text than the search shows. */
  more: boolean;
  /** One text for each catalog that the search could not read. Example: 'hive_metastore: Catalog is not a Unity Catalog catalog.' */
  problems: string[];
  /** true if the text is too short and the search sent no request. */
  tooShort: boolean;
}

/**
 * Find the tables whose names contain the text that the user typed.
 *
 * A catalog that the search cannot read does not stop the search. Its
 * error goes in `problems`, and the tables of the other catalogs come back.
 *
 * @example
 * await searchTables(workspace, {}, 'ord')
 * // { tables: [{ table: { catalog: 'main', schema: 'shop', name: 'orders' }, tableType: 'table' }, ...], more: false, problems: [], tooShort: false }
 *
 * await searchTables(workspace, { catalog: 'main', schema: 'shop' }, '')   // all tables of main.shop
 * await searchTables(workspace, {}, 'o')                                   // { tables: [], more: false, problems: [], tooShort: true }
 *
 * @param workspace  Sends the requests. See WorkspaceClient.findTables().
 * @param scope  Where to look: all catalogs, one catalog or one schema.
 * @param text  The text of the search box. See parseSearch() in core/search.ts for its form.
 * @param options.signal  Stops the requests when it fires. The promise then fails with the error of the signal.
 * @param options.catalogs  The catalogs of the workspace, if the caller has them. If not set, the search asks for them when it needs them.
 */
export async function searchTables(workspace: WorkspaceClient, scope: SearchScope, text: string, options: { signal?: AbortSignal; catalogs?: string[] } = {}): Promise<SearchResult> {
  const parts = parseSearch(text, scope);
  if (!hasEnoughText(parts)) return { tables: [], more: false, problems: [], tooShort: true };

  const { signal } = options;
  const catalogs = parts.catalog ? [parts.catalog] : (options.catalogs ?? (await workspace.listCatalogs()));
  const schemaPattern = likePattern(parts.schema, parts.schemaExact);
  const tablePattern = likePattern(parts.table);
  const limiter = new Limiter(() => CATALOGS_AT_ONE_TIME);
  const found: FoundTable[] = [];
  const problems: string[] = [];
  let more = false;
  await Promise.all(
    catalogs.map((catalog) =>
      limiter.run(async () => {
        if (signal?.aborted) return;
        try {
          const answer = await workspace.findTables(catalog, schemaPattern, tablePattern, SEARCH_LIMIT, signal);
          found.push(...answer.tables);
          more ||= answer.more;
        } catch (e) {
          if (signal?.aborted) throw e;
          problems.push(`${catalog}: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    )
  );
  signal?.throwIfAborted();
  // "_" in a pattern fits each character. Keep only the tables that contain the text as the user typed it.
  const tables = rank(found.filter((t) => matches(t.table, parts)), parts);
  return { tables: tables.slice(0, SEARCH_LIMIT), more: more || tables.length > SEARCH_LIMIT, problems: problems.sort(), tooShort: false };
}
