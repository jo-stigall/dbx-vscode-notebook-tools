/**
 * The table overview: one row for each column of the dataset.
 *
 * The page asks for the numbers of 25 columns at a time, so that one scan of
 * the table serves many columns. Each row fills in when its numbers arrive.
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

export type Sort = 'table' | 'nulls' | 'distinct' | 'drift';

export interface OverviewState {
  rowCount?: number;
  /** Column name -> the numbers of the column. */
  stats: Map<string, OverviewColumn>;
  /** true if a number is an estimate. */
  approximate: boolean;
  /** The time of the first query. */
  asOf?: string;
  /** Column name -> the SQL statements that gave the overview numbers of the column. */
  sql: Map<string, string[]>;
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
const EMPTY = EMPTY_OVERVIEW;

/**
 * Get the overview numbers of all columns, one batch at a time.
 *
 * When the dataset changes (for example, the user adds a filter), the hook
 * gives the numbers of the old dataset with `stale: true` until the first
 * numbers of the new dataset arrive. The table then does not go empty.
 *
 * @param columns  The columns of the table. Pass undefined to send nothing, for example before the user permits the scan of a large table.
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
 */
export function rowClick(onOpen: (column: string) => void, column: string): () => void {
  return () => {
    if (!window.getSelection()?.toString()) onOpen(column);
  };
}

/** A small bar that shows a part of a total. The text next to it gives the same number. */
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
  column: ColumnInfo;
  /** The position of the column in the table, from 0. */
  position: number;
  stats: OverviewColumn | undefined;
  nulls: number | undefined;
  kind: ColumnKind | undefined;
}

/**
 * Make the rows of the overview table: filter them by name and sort them.
 *
 * @param search  Show only the columns whose name contains this text. Upper and lower case are equal.
 * @param sort  'table': the sequence of the table. 'nulls' and 'distinct': largest first; a row without a number goes last.
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

export interface OverviewTableProps {
  dataset: Dataset;
  rows: OverviewRow[];
  overview: OverviewState;
  /** The names of the columns that have an open card. */
  open: Set<string>;
  /** The user selected a column. The board opens its card. */
  onOpen: (column: string) => void;
}

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
