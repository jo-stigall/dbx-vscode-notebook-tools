/**
 * The overview of compare mode: the schema comparison, and one row for each column that is in the two datasets.
 *
 * Each row shows the percent of nulls, the distinct count and the mean for
 * A and for B, and the drift score. A sort by the drift score puts the
 * columns that changed most at the top.
 */
import type { SchemaComparison } from '../../core/match.ts';
import { formatCount, formatPercent, formatStat } from '../format.ts';
import type { OverviewState, Sort } from '../Overview.tsx';
import type { DriftState } from './useCompare.ts';

/**
 * Write a drift score with two digits after the point.
 *
 * @example
 * formatScore(0.3081)   // '0.31'
 */
export const formatScore = (score: number): string => score.toFixed(2);

export interface SchemaPanelProps {
  schema: SchemaComparison;
  /** The names of the columns of A that the user chose to compare as text. */
  asText: string[];
  onAsText: (names: string[]) => void;
}

/** The comparison of the columns of A and B: the matches, the columns of one dataset only, and the types that differ. */
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
  name: string;
  /** The position of the pair in the list of pairs, from 0. */
  position: number;
  typeA: string;
  typeB: string;
  nullsA: number | undefined;
  nullsB: number | undefined;
  distinctA: number | undefined;
  distinctB: number | undefined;
  meanA: number | undefined;
  meanB: number | undefined;
  drift: DriftState;
}

/**
 * Make the rows of the compare table: filter them by name and sort them.
 *
 * @param sort  'drift': the largest drift score first; a row without a score goes last. 'nulls' and 'distinct' use the numbers of A.
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

/** The drift score of a row: a bar and the number, or the reason that there is no number. */
function DriftCell({ state }: { state: DriftState }) {
  if (state.status === 'loading') return <>…</>;
  if (state.status === 'skip') return <span className="muted" title="The types are different. Select “Compare as text” in the list of columns above.">Not compared</span>;
  if (state.status === 'error') return <span className="muted" title={state.error.message}>Failed</span>;
  const { score } = state.drift;
  return (
    <>
      {formatScore(score)}{' '}
      <svg className="share" width="40" height="6" viewBox="0 0 40 6" aria-hidden="true">
        <rect className="share-track" width="40" height="6" />
        <rect className="drift-fill" width={score > 0 ? Math.max(score * 40, 1) : 0} height="6" />
      </svg>
    </>
  );
}

export interface CompareTableProps {
  rows: CompareRow[];
  a: OverviewState;
  b: OverviewState;
  /** The names of the columns that have an open card. */
  open: Set<string>;
  onOpen: (column: string) => void;
}

export function CompareTable({ rows, a, b, open, onOpen }: CompareTableProps) {
  const approx = a.approximate || b.approximate ? '≈ ' : '';
  const percent = (nulls: number | undefined, total: number | undefined) => (nulls === undefined || total === undefined ? '…' : formatPercent(nulls, total));
  const count = (n: number | undefined, pending: boolean) => (n === undefined ? (pending ? '…' : '—') : approx + formatCount(n));
  const mean = (n: number | undefined) => (n === undefined ? '—' : formatStat(n));
  return (
    <table className="columns compare">
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
          <tr key={row.name} className={open.has(row.name) ? 'selected' : undefined}>
            <th scope="row" className="name">
              <button type="button" className="link" aria-expanded={open.has(row.name)} onClick={() => onOpen(row.name)}>
                {row.name}
              </button>
            </th>
            <td className="type">{row.typeA.toLowerCase() === row.typeB.toLowerCase() ? row.typeA : `${row.typeA} → ${row.typeB}`}</td>
            <td className="num">{percent(row.nullsA, a.rowCount)}</td>
            <td className="num">{percent(row.nullsB, b.rowCount)}</td>
            <td className="num">{count(row.distinctA, !a.stats.has(row.name))}</td>
            <td className="num">{count(row.distinctB, row.nullsB === undefined)}</td>
            <td className="num">{mean(row.meanA)}</td>
            <td className="num">{mean(row.meanB)}</td>
            <td className="num">
              <DriftCell state={row.drift} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
