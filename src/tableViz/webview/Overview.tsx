/**
 * The table overview: one row for each column of the dataset.
 *
 * The page asks for the numbers of 25 columns at a time, so that one scan of
 * the table serves many columns. Each row fills in when its numbers arrive.
 *
 * useOverview() gets the numbers, overviewRows() filters and sorts the rows,
 * and `OverviewTable` shows them. The board (Board.tsx) calls all three.
 * Compare mode uses useOverview() for each dataset and has its own table in
 * compare/CompareOverview.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import { detectKind } from '../core/kinds.ts';
import type { ColumnInfo, ColumnKind, Dataset, OverviewColumn, RequestOf } from '../core/schema.ts';
import { KIND_LABELS } from './cards/CardShell.tsx';
import { formatCount, formatPercent } from './format.ts';
import { acquire, release, useRequests, type RequestError } from './rpc.ts';
import { Thumbnail } from './Thumbnail.tsx';

/** The number of columns in one overview request. */
const BATCH = 25;

/**
 * The sequence of the rows of the overview, from the "Sort by" list.
 *
 * | Value      | The rows are in this sequence                               |
 * |------------|-------------------------------------------------------------|
 * | 'table'    | the sequence of the columns in the table                    |
 * | 'nulls'    | the column with the most nulls first                        |
 * | 'distinct' | the column with the most different values first             |
 * | 'drift'    | compare mode only: the column with the largest drift score first |
 */
export type Sort = 'table' | 'nulls' | 'distinct' | 'drift';

/**
 * The overview numbers of one dataset that are here now.
 *
 * The numbers arrive one batch of columns at a time, so `stats` can hold
 * some columns and not others.
 */
export interface OverviewState {
  /** The number of rows of the dataset. Not set before the first batch arrives. */
  rowCount?: number;
  /** Column name -> the numbers of the column. */
  stats: Map<string, OverviewColumn>;
  /** true if a number is an estimate. */
  approximate: boolean;
  /** The time of the first query. */
  asOf?: string;
  /** Column name -> the SQL statements that gave the overview numbers of the column. */
  sql: Map<string, string[]>;
  /** The error of a batch that failed. The rows of that batch stay without numbers. */
  error?: RequestError;
  /** true if the user cancelled a request of the overview. No more numbers arrive until "Refresh". */
  cancelled?: boolean;
  /** The dataset that the numbers belong to. Not set before the first numbers arrive. */
  dataset?: Dataset;
  /**
   * true if the numbers belong to an older dataset while the numbers of the
   * new dataset load. The page shows them dimmed. Do not compute new results
   * from them.
   */
  stale?: boolean;
}

/** An overview with no numbers. */
export const EMPTY_OVERVIEW: OverviewState = { stats: new Map(), approximate: false, sql: new Map() };
/** A short name for EMPTY_OVERVIEW in this file. */
const EMPTY = EMPTY_OVERVIEW;

/**
 * Get the overview numbers of all columns, one batch at a time.
 *
 * The hook sends one "overview" request for each 25 columns. It sends them
 * again when the dataset or the columns change, and after a click on
 * "Refresh". It releases the requests of the old dataset, so the host
 * cancels those that still run.
 *
 * When the dataset changes (for example, the user adds a filter), the hook
 * gives the numbers of the old dataset with `stale: true` until the first
 * numbers of the new dataset arrive. The table then does not go empty.
 *
 * @example
 * const overview = useOverview(dataset, details.result.columns);   // a table with 60 columns: 3 requests
 * overview.rowCount              // 110000, after the first batch arrived
 * overview.stats.get('amount')   // { name: 'amount', nonNull: 109500, distinct: 8400, min: '2.33', max: '4999.00', mean: 63.0015 }
 *
 * @param columns  The columns of the table. Pass undefined to send nothing, for example before the user permits the scan of a large table.
 * @returns The numbers that are here now. EMPTY_OVERVIEW before the first numbers arrive.
 */
export function useOverview(dataset: Dataset, columns: ColumnInfo[] | undefined): OverviewState {
  const { generation } = useRequests();
  const key = JSON.stringify([dataset, columns?.map((c) => [c.name, c.typeText]), generation]);
  const [state, setState] = useState<{ key: string; value: OverviewState }>({ key, value: EMPTY });
  useEffect(() => {
    if (!columns) return;
    let current = true;
    const sent: RequestOf<'overview'>[] = [];
    for (let i = 0; i < columns.length; i += BATCH) {
      const batch = columns.slice(i, i + BATCH).map((c) => ({ name: c.name, typeText: c.typeText }));
      const request: RequestOf<'overview'> = { type: 'overview', dataset, columns: batch };
      sent.push(request);
      acquire(request).then(
        (result) => {
          if (!current) return;
          setState((prev) => {
            const old = prev.key === key ? prev.value : EMPTY;
            const stats = new Map(old.stats);
            const sql = new Map(old.sql);
            for (const c of result.columns) {
              stats.set(c.name, c);
              sql.set(c.name, result.sql);
            }
            return {
              key,
              value: { ...old, dataset, stats, sql, rowCount: result.rowCount, approximate: old.approximate || result.approximate, asOf: old.asOf ?? result.asOf },
            };
          });
        },
        (error: RequestError) => {
          if (current) setState((prev) => ({ key, value: { ...(prev.key === key ? prev.value : EMPTY), ...(error.cancelled ? { cancelled: true } : { error }) } }));
        }
      );
    }
    return () => {
      current = false;
      sent.forEach((request) => release(request));
    };
    // `key` is the dataset and the columns as text.
  }, [key]);

  const value = state.key === key ? state.value : EMPTY;
  // The last overview that had numbers, to show while the next one loads.
  const last = useRef<OverviewState | undefined>(undefined);
  if (value.rowCount !== undefined) last.current = value;
  else if (value.error || value.cancelled || !columns) last.current = undefined; // Do not show old numbers below an error, or after "Cancel".
  if (value.rowCount === undefined && last.current) return { ...last.current, stale: true };
  return value;
}

/**
 * Make the click function of a table row: it opens the column.
 *
 * A person who selects the name of a column with the mouse, to copy it,
 * also makes a click. That click opens nothing.
 *
 * @example
 * <tr onClick={rowClick(onOpen, 'amount')}>   // a click on the row calls onOpen('amount')
 *
 * @param onOpen  Opens the card of a column.
 * @param column  The name of the column of the row.
 */
export function rowClick(onOpen: (column: string) => void, column: string): () => void {
  return () => {
    if (!window.getSelection()?.toString()) onOpen(column);
  };
}

/**
 * A small bar that shows a part of a total. The text next to it gives the same number.
 *
 * The bar is 40 pixels wide. A part that is not 0 is 1 pixel wide at least,
 * so that it shows.
 *
 * @example
 * <ShareBar part={550} total={110000} />   // 0.5% null: the filled part is 1 pixel wide
 */
function ShareBar({ part, total }: { part: number; total: number }) {
  const width = total === 0 ? 0 : (part / total) * 40;
  return (
    <svg className="share" width="40" height="6" viewBox="0 0 40 6" aria-hidden="true">
      <rect className="share-track" width="40" height="6" />
      <rect className="share-fill" width={part > 0 ? Math.max(width, 1) : 0} height="6" />
    </svg>
  );
}

/** One row of the overview table, with the numbers that are here now. */
export interface OverviewRow {
  /** The name and the type of the column. */
  column: ColumnInfo;
  /** The position of the column in the table, from 0. */
  position: number;
  /** The overview numbers of the column. undefined while its batch loads. */
  stats: OverviewColumn | undefined;
  /** The number of rows where the column is null. undefined while its batch loads. */
  nulls: number | undefined;
  /** The kind that the feature selected for the column. undefined while its batch loads. */
  kind: ColumnKind | undefined;
}

/**
 * Make the rows of the overview table: filter them by name and sort them.
 *
 * @example
 * // The table has the columns order_id, amount, region and order_date. The dataset has 110,000 rows.
 * overviewRows(columns, overview, 'ORDER', 'table').map((row) => row.column.name)   // ['order_id', 'order_date']
 * // amount has 109,500 rows that are not null:
 * overviewRows(columns, overview, 'amount', 'table')[0].nulls                       // 500
 *
 * @param search  Show only the columns whose name contains this text. Upper and lower case are equal.
 * @param sort  'table': the sequence of the table. 'nulls' and 'distinct': largest first; a row without a number goes last.
 *   'drift' is for compare mode; this function then keeps the sequence of the table.
 */
export function overviewRows(columns: ColumnInfo[], overview: OverviewState, search: string, sort: Sort): OverviewRow[] {
  const needle = search.trim().toLowerCase();
  const rows = columns
    .map((column, position): OverviewRow => {
      const stats = overview.stats.get(column.name);
      const nulls = stats && overview.rowCount !== undefined ? overview.rowCount - stats.nonNull : undefined;
      const kind = stats ? detectKind(column.typeText, stats.distinct, stats.nonNull) : undefined;
      return { column, position, stats, nulls, kind };
    })
    .filter((row) => !needle || row.column.name.toLowerCase().includes(needle));
  if (sort === 'nulls') rows.sort((a, b) => (b.nulls ?? -1) - (a.nulls ?? -1) || a.position - b.position);
  if (sort === 'distinct') rows.sort((a, b) => (b.stats?.distinct ?? -1) - (a.stats?.distinct ?? -1) || a.position - b.position);
  return rows;
}

/** The properties of the `OverviewTable` component. */
export interface OverviewTableProps {
  /** The dataset of the board. The thumbnails use it until the first overview numbers arrive. */
  dataset: Dataset;
  /** The rows to show, from overviewRows(). */
  rows: OverviewRow[];
  /** The overview numbers. The table reads the row count, `approximate` and `stale` from it. */
  overview: OverviewState;
  /** The names of the columns that have an open card. The table marks their rows. */
  open: Set<string>;
  /** The user selected a column. The board opens its card. */
  onOpen: (column: string) => void;
}

/**
 * The table with one row for each column of the dataset.
 *
 * In each row the user sees the name, the type, the kind, the percent of
 * nulls with a small bar, the distinct count, and a thumbnail of the
 * values. A cell shows "…" until its numbers arrive. "≈" before a distinct
 * count marks an estimate.
 *
 * A click at any place in a row calls `onOpen` with the name of the column.
 * The name of the column is a button, so that the keyboard can do the same.
 * While the numbers of a new dataset load, the table shows the old numbers
 * dimmed.
 *
 * @example
 * <OverviewTable dataset={pinned} rows={rows} overview={overview} open={new Set(['amount'])} onOpen={openColumn} />
 */
export function OverviewTable({ dataset, rows, overview, open, onOpen }: OverviewTableProps) {
  const approx = overview.approximate ? '≈ ' : '';
  return (
    <table className={overview.stale ? 'columns stale' : 'columns'} aria-busy={overview.stale === true}>
      <thead>
        <tr>
          <th scope="col">Column</th>
          <th scope="col">Type</th>
          <th scope="col">Kind</th>
          <th scope="col" className="num">
            Null
          </th>
          <th scope="col" className="num">
            Distinct
          </th>
          <th scope="col">Values</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ column, stats, nulls, kind }) => (
          // A click at any place in the row opens the column. The button in the row is for the keyboard; its click also arrives here.
          <tr key={column.name} className={open.has(column.name) ? 'selected' : undefined} onClick={rowClick(onOpen, column.name)}>
            <th scope="row" className="name">
              <button type="button" className="link" aria-expanded={open.has(column.name)} title="Show the detailed view of this column">
                {column.name}
              </button>
              {column.partition && (
                <span className="tag" title="The table is partitioned by this column">
                  partition
                </span>
              )}
            </th>
            <td className="type">{column.typeText}</td>
            <td>{kind ? KIND_LABELS[kind] : '…'}</td>
            <td className="num">
              {nulls === undefined || overview.rowCount === undefined ? (
                '…'
              ) : (
                <>
                  {formatPercent(nulls, overview.rowCount)} <ShareBar part={nulls} total={overview.rowCount} />
                </>
              )}
            </td>
            <td className="num">{!stats ? '…' : stats.distinct === undefined ? '—' : approx + formatCount(stats.distinct)}</td>
            <td>
              {/* The thumbnail asks for the dataset that the numbers of the row belong to. */}
              <Thumbnail dataset={overview.dataset ?? dataset} column={column} stats={stats} kind={kind} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
