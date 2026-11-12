/**
 * The overview of compare mode: the schema comparison, and one row for each column that is in the two datasets.
 *
 * Each row shows the percent of nulls, the distinct count and the mean for
 * A and for B, and the drift score. A sort by the drift score puts the
 * columns that changed most at the top.
 *
 * The board (Board.tsx) gives the numbers to this file: the two overviews
 * from useOverview(), the pairs from matchColumns() in core/match.ts, and
 * the drifts from useDrifts() in useCompare.ts.
 */
import type { SchemaComparison } from '../../core/match.ts';
import { formatCount, formatPercent, formatStat } from '../format.ts';
import { rowClick, type OverviewState, type Sort } from '../Overview.tsx';
import type { DriftState } from './useCompare.ts';

/**
 * Write a drift score with two digits after the point.
 *
 * @example
 * formatScore(0.3081)   // '0.31'
 * formatScore(0)        // '0.00'
 */
export const formatScore = (score: number): string => score.toFixed(2);

/** The properties of the `SchemaPanel` component. */
export interface SchemaPanelProps {
  /** The pairs of columns that A and B have, and the columns that only one dataset has. */
  schema: SchemaComparison;
  /** The names of the columns of A that the user chose to compare as text. */
  asText: string[];
  /** The user changed a "Compare as text" check box. The function gets the new list of names. */
  onAsText: (names: string[]) => void;
}

/**
 * The comparison of the columns of A and B: the matches, the columns of one dataset only, and the types that differ.
 *
 * The user sees one line of counts, for example "Columns: 12 in A and B ·
 * 1 only in A · 0 only in B · 2 with different types". A click on the line
 * shows or hides the lists below it. The lists are open at the start if the
 * two datasets do not have the same columns and types.
 *
 * A pair with two different number types (int and bigint) needs no action:
 * the feature compares the values as numbers. A pair with other types
 * (int and string) has the check box "Compare as text". A click on it calls
 * `onAsText`, and the board then computes the drift of that pair.
 *
 * @example
 * <SchemaPanel schema={matchColumns(columnsA, columnsB)} asText={['zip_code']} onAsText={setAsText} />
 */
export function SchemaPanel({ schema, asText, onAsText }: SchemaPanelProps) {
  const differ = schema.pairs.filter((pair) => pair.typesDiffer);
  const names = (list: { name: string; typeText: string }[]) => (list.length ? list.map((c) => `${c.name} (${c.typeText})`).join(', ') : 'None');
  return (
    <details className="schema" open={schema.onlyA.length + schema.onlyB.length + differ.length > 0}>
      <summary>
        Columns: {schema.pairs.length} in A and B · {schema.onlyA.length} only in A · {schema.onlyB.length} only in B · {differ.length} with different types
      </summary>
      <dl>
        <dt>Only in A</dt>
        <dd>{names(schema.onlyA)}</dd>
        <dt>Only in B</dt>
        <dd>{names(schema.onlyB)}</dd>
        <dt>Different types</dt>
        <dd>
          {differ.length === 0
            ? 'None'
            : differ.map((pair) => (
                <div key={pair.a.name}>
                  {pair.a.name}: {pair.a.typeText} in A, {pair.b.typeText} in B.{' '}
                  {pair.compareAs === 'number' ? (
                    'The feature compares the values as numbers.'
                  ) : (
                    <label>
                      <input
                        type="checkbox"
                        checked={asText.includes(pair.a.name)}
                        onChange={(e) => onAsText(e.target.checked ? [...asText, pair.a.name] : asText.filter((n) => n !== pair.a.name))}
                      />{' '}
                      Compare as text
                    </label>
                  )}
                </div>
              ))}
        </dd>
      </dl>
    </details>
  );
}

/** One row of the compare table, with the numbers that are here now. */
export interface CompareRow {
  /** The name of the column in A. */
  name: string;
  /** The position of the pair in the list of pairs, from 0. */
  position: number;
  /** The Databricks type of the column in A and in B. Example: 'int' and 'bigint'. */
  typeA: string;
  typeB: string;
  /** The number of rows where the column is null, in A and in B. undefined while the overview loads. */
  nullsA: number | undefined;
  nullsB: number | undefined;
  /** The number of different values in A and in B. undefined while the overview loads, and for a type that has no distinct count. */
  distinctA: number | undefined;
  distinctB: number | undefined;
  /** The mean in A and in B, for a number column. undefined for other types. */
  meanA: number | undefined;
  meanB: number | undefined;
  /** The state of the drift of the pair. "loading" if the drift hook has no state for it yet. */
  drift: DriftState;
}

/**
 * Make the rows of the compare table: filter them by name and sort them.
 *
 * @example
 * // The drift scores are: amount 0.31, region 0.05, order_date not known yet.
 * compareRows(schema, overviewA, overviewB, drifts, '', 'drift').map((row) => row.name)   // ['amount', 'region', 'order_date']
 * compareRows(schema, overviewA, overviewB, drifts, 'REG', 'drift').map((row) => row.name)   // ['region']
 *
 * @param drifts  Column name of A -> the state of its drift, from useDrifts().
 * @param search  Show only the columns whose name in A contains this text. Upper and lower case are equal.
 * @param sort  'drift': the largest drift score first; a row without a score goes last. 'nulls' and 'distinct' use the numbers of A.
 *   'table': the sequence of the columns in A.
 */
export function compareRows(schema: SchemaComparison, a: OverviewState, b: OverviewState, drifts: Map<string, DriftState>, search: string, sort: Sort): CompareRow[] {
  const needle = search.trim().toLowerCase();
  const rows = schema.pairs
    .map((pair, position): CompareRow => {
      const sa = a.stats.get(pair.a.name);
      const sb = b.stats.get(pair.b.name);
      return {
        name: pair.a.name,
        position,
        typeA: pair.a.typeText,
        typeB: pair.b.typeText,
        nullsA: sa && a.rowCount !== undefined ? a.rowCount - sa.nonNull : undefined,
        nullsB: sb && b.rowCount !== undefined ? b.rowCount - sb.nonNull : undefined,
        distinctA: sa?.distinct,
        distinctB: sb?.distinct,
        meanA: sa?.mean,
        meanB: sb?.mean,
        drift: drifts.get(pair.a.name) ?? { status: 'loading' },
      };
    })
    .filter((row) => !needle || row.name.toLowerCase().includes(needle));
  const score = (row: CompareRow) => (row.drift.status === 'done' ? row.drift.drift.score : -1);
  if (sort === 'drift') rows.sort((x, y) => score(y) - score(x) || x.position - y.position);
  if (sort === 'nulls') rows.sort((x, y) => (y.nullsA ?? -1) - (x.nullsA ?? -1) || x.position - y.position);
  if (sort === 'distinct') rows.sort((x, y) => (y.distinctA ?? -1) - (x.distinctA ?? -1) || x.position - y.position);
  return rows;
}

/**
 * The drift score of a row: a bar and the number, or the reason that there is no number.
 *
 * | State   | What the user sees                                                    |
 * |---------|-----------------------------------------------------------------------|
 * | loading | "…"                                                                   |
 * | done    | The score and a bar. Example: "0.31" and a bar that is 31% full. Dimmed if the score is old. |
 * | skip    | "Not compared": the types differ and the user did not select "Compare as text". |
 * | error   | "Failed". The message of the error shows when you point at it.        |
 */
function DriftCell({ state }: { state: DriftState }) {
  if (state.status === 'loading') return <>…</>;
  if (state.status === 'skip') return <span className="muted" title="The types are different. Select “Compare as text” in the list of columns above.">Not compared</span>;
  if (state.status === 'error') return <span className="muted" title={state.error.message}>Failed</span>;
  const { score } = state.drift;
  return (
    <span className={state.stale ? 'stale' : undefined}>
      {formatScore(score)}{' '}
      <svg className="share" width="40" height="6" viewBox="0 0 40 6" aria-hidden="true">
        <rect className="share-track" width="40" height="6" />
        <rect className="drift-fill" width={score > 0 ? Math.max(score * 40, 1) : 0} height="6" />
      </svg>
    </span>
  );
}

/** The properties of the `CompareTable` component. */
export interface CompareTableProps {
  /** The rows to show, from compareRows(). */
  rows: CompareRow[];
  /** The overview numbers of A and of B. The table reads the row counts, `approximate` and `stale` from them. */
  a: OverviewState;
  b: OverviewState;
  /** The names of the columns that have an open card. The table marks their rows. */
  open: Set<string>;
  /** The user selected a column. The board opens its card. The function gets the name of the column in A. */
  onOpen: (column: string) => void;
}

/**
 * The table with one row for each column that A and B have.
 *
 * In each row the user sees the name, the type (or "int → bigint" if the
 * types differ), and for A and for B the percent of nulls, the distinct
 * count and the mean. The last cell is the drift score with a small bar. A
 * cell shows "…" until its number arrives. A column with no mean, for
 * example a text column, shows "—". "≈" before a distinct count marks an estimate.
 *
 * A click at any place in a row calls `onOpen` with the name of the column.
 * The name of the column is a button, so that the keyboard can do the same.
 * While the numbers of a new dataset load, the table shows the old numbers
 * dimmed.
 *
 * @example
 * <CompareTable rows={compareRows(schema, overview, overviewB, drifts, search, sort)} a={overview} b={overviewB} open={open} onOpen={openColumn} />
 */
export function CompareTable({ rows, a, b, open, onOpen }: CompareTableProps) {
  const approx = a.approximate || b.approximate ? '≈ ' : '';
  const percent = (nulls: number | undefined, total: number | undefined) => (nulls === undefined || total === undefined ? '…' : formatPercent(nulls, total));
  const count = (n: number | undefined, pending: boolean) => (n === undefined ? (pending ? '…' : '—') : approx + formatCount(n));
  const mean = (n: number | undefined, pending: boolean) => (n === undefined ? (pending ? '…' : '—') : formatStat(n));
  return (
    <table className={a.stale || b.stale ? 'columns compare stale' : 'columns compare'} aria-busy={a.stale === true || b.stale === true}>
      <thead>
        <tr>
          <th scope="col">Column</th>
          <th scope="col">Type</th>
          <th scope="col" className="num">
            Null A
          </th>
          <th scope="col" className="num">
            Null B
          </th>
          <th scope="col" className="num">
            Distinct A
          </th>
          <th scope="col" className="num">
            Distinct B
          </th>
          <th scope="col" className="num">
            Mean A
          </th>
          <th scope="col" className="num">
            Mean B
          </th>
          <th scope="col" className="num" title="The Jensen-Shannon distance: 0 if the column is the same in A and B, 1 if it has nothing in common">
            Drift
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          // A click at any place in the row opens the column. The button in the row is for the keyboard; its click also arrives here.
          <tr key={row.name} className={open.has(row.name) ? 'selected' : undefined} onClick={rowClick(onOpen, row.name)}>
            <th scope="row" className="name">
              <button type="button" className="link" aria-expanded={open.has(row.name)} title="Show the detailed view of this column">
                {row.name}
              </button>
            </th>
            <td className="type">{row.typeA.toLowerCase() === row.typeB.toLowerCase() ? row.typeA : `${row.typeA} → ${row.typeB}`}</td>
            <td className="num">{percent(row.nullsA, a.rowCount)}</td>
            <td className="num">{percent(row.nullsB, b.rowCount)}</td>
            <td className="num">{count(row.distinctA, !a.stats.has(row.name))}</td>
            <td className="num">{count(row.distinctB, row.nullsB === undefined)}</td>
            <td className="num">{mean(row.meanA, !a.stats.has(row.name))}</td>
            <td className="num">{mean(row.meanB, row.nullsB === undefined)}</td>
            <td className="num">
              <DriftCell state={row.drift} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
