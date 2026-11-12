/**
 * The content of a detail card in compare mode.
 *
 * Each component gets finished results as properties and sends no request,
 * so a test can draw a card from fixed results.
 *
 * A chart shows dataset A and dataset B for the same bins, values or
 * periods. By default it shows the percent of the rows of each dataset,
 * because A and B usually have different sizes.
 */
import { useState, type ReactNode } from 'react';
import { binBounds } from '../../core/bins.ts';
import { comparedValues, type ComparedValue } from '../../core/compare.ts';
import { sharedPeriods, spanDays } from '../../core/derive.ts';
import type { Drift } from '../../core/drift.ts';
import type { BinEdges, Card, Grain, OverviewColumn, ResultOf } from '../../core/schema.ts';
import { Chart } from '../Chart.tsx';
import { formatCount, formatNumber, formatPercent, formatStat, formatValue } from '../format.ts';
import { barsOption, compareBarsOption } from '../options.ts';
import type { Theme } from '../theme.ts';
import { formatScore } from './CompareOverview.tsx';

/**
 * Write a difference of two shares in percentage points, with its sign.
 *
 * @example
 * formatPoints(0.349 - 0.05)   // '+29.9 pp'
 * formatPoints(0)              // '0 pp'
 */
export function formatPoints(difference: number): string {
  const points = Math.round(difference * 1000) / 10;
  return `${points > 0 ? '+' : ''}${points} pp`;
}

const METHODS: Record<Drift['method'], string> = {
  values: 'over the values of A and B',
  deciles: 'over 10 bins cut at the deciles of A',
  nulls: 'over "null" and "not null" only',
};

/** The drift of a column in words: the score, the PSI, and the null rate on its own line. */
export function DriftLine({ drift }: { drift: Drift }) {
  return (
    <div className="drift">
      <p>
        <strong>Drift score {formatScore(drift.score)}</strong> (Jensen-Shannon distance {METHODS[drift.method]}; 0 is "the same", 1 is "nothing in common") · Population Stability Index{' '}
        {formatScore(drift.psi)}
      </p>
      <p>
        Null rate: {formatPercent(Math.round(drift.nullRateA * 1e6), 1e6)} in A, {formatPercent(Math.round(drift.nullRateB * 1e6), 1e6)} in B ({formatPoints(drift.nullRateB - drift.nullRateA)})
      </p>
    </div>
  );
}

/** One line of a chart or table that shows A and B: a bin, a value or a period. */
export interface PairRow {
  label: string;
  /** The number of rows in A and in B. */
  a: number;
  b: number;
  /** The row is in one dataset only. The table marks it. */
  onlyIn?: 'a' | 'b';
  /** "Other" and "(null)" rows are shown in a different style. */
  muted?: boolean;
}

export interface PairViewProps {
  rows: PairRow[];
  /** The number that 100% is, for each dataset. */
  totalA: number;
  totalB: number;
  /** The title of the first column of the table. Example: 'Range'. */
  head: string;
  /** One sentence for a screen reader. */
  label: string;
  card: Card;
  theme: Theme;
  horizontal?: boolean;
}

/** A chart of A and B for the same rows, or the same numbers as a table. */
export function PairView({ rows, totalA, totalB, head, label, card, theme, horizontal }: PairViewProps) {
  const share = (count: number, total: number) => (total === 0 ? 0 : (count / total) * 100);
  const percent = !card.rawCounts;
  const a = rows.map((r) => (percent ? share(r.a, totalA) : r.a));
  const b = rows.map((r) => (percent ? share(r.b, totalB) : r.b));
  const axisFormat = percent ? (value: number) => `${formatNumber(value)}%` : undefined;
  const tips = rows.map((r) => `${r.label}\nA: ${formatCount(r.a)} rows (${formatPercent(r.a, totalA)})\nB: ${formatCount(r.b)} rows (${formatPercent(r.b, totalB)})`);
  const height = horizontal ? Math.max(140, 60 + rows.length * 26) : undefined;

  if (card.asTable) {
    return (
      <div className="scroll">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">{head}</th>
              <th scope="col" className="num">
                A rows
              </th>
              <th scope="col" className="num">
                A %
              </th>
              <th scope="col" className="num">
                B rows
              </th>
              <th scope="col" className="num">
                B %
              </th>
              <th scope="col" className="num">
                Difference
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.muted ? 'muted' : undefined}>
                <td>
                  {r.label}
                  {r.onlyIn && <span className="tag">only in {r.onlyIn.toUpperCase()}</span>}
                </td>
                <td className="num">{formatCount(r.a)}</td>
                <td className="num">{formatPercent(r.a, totalA)}</td>
                <td className="num">{formatCount(r.b)}</td>
                <td className="num">{formatPercent(r.b, totalB)}</td>
                <td className="num">{formatPoints(share(r.b, totalB) / 100 - share(r.a, totalA) / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (card.sideBySide) {
    // The two charts have the same top of the axis, so that the heights of their bars can be compared.
    const max = Math.max(...a, ...b, 0) || undefined;
    const one = (values: number[], name: 'A' | 'B') => (
      <div className="side">
        <p className="side-name">
          <span className={`chip chip-${name.toLowerCase()}`}>{name}</span>
        </p>
        <Chart
          label={`${label} Dataset ${name}.`}
          height={height}
          option={barsOption(theme, { labels: rows.map((r) => r.label), counts: values, tips, logScale: card.logScale, horizontal, gap: 10, color: name === 'A' ? theme.a : theme.b, max: card.logScale ? undefined : max, axisFormat })}
        />
      </div>
    );
    return (
      <div className="sides">
        {one(a, 'A')}
        {one(b, 'B')}
      </div>
    );
  }
  return <Chart label={`${label} Dataset A and dataset B.`} height={height} option={compareBarsOption(theme, { labels: rows.map((r) => r.label), a, b, tips, nameA: 'A', nameB: 'B', logScale: card.logScale, horizontal, axisFormat })} />;
}

/** The controls that each compare card has: percent or counts, one chart or two. */
export function CompareControls({ card, onChange, children }: { card: Card; onChange: (patch: Partial<Card>) => void; children?: ReactNode }) {
  return (
    <div className="controls">
      {children}
      <label title="Show the number of rows. If this is off, the chart shows the percent of the rows of each dataset.">
        <input type="checkbox" checked={card.rawCounts === true} onChange={(e) => onChange({ rawCounts: e.target.checked })} /> Row counts
      </label>
      <label title="Show one chart for A and one chart for B">
        <input type="checkbox" checked={card.sideBySide === true} onChange={(e) => onChange({ sideBySide: e.target.checked })} /> Side by side
      </label>
    </div>
  );
}

/** One line of the statistics table. `a` and `b` are numbers, or text for a value such as a date. */
interface StatRow {
  label: string;
  a: number | string | undefined;
  b: number | string | undefined;
  /** true: the value is a count. The table writes it with separators and no decimals. */
  count?: boolean;
}

/** A table with one statistic in each row: the value in A, the value in B, the difference, and the change in percent. */
export function CompareStatsTable({ rows }: { rows: StatRow[] }) {
  const show = (row: StatRow, value: number | string | undefined) =>
    value === undefined ? '—' : typeof value === 'string' ? formatValue(value) : row.count ? formatCount(value) : formatStat(value);
  return (
    <table className="data">
      <thead>
        <tr>
          <th scope="col">Statistic</th>
          <th scope="col" className="num">
            A
          </th>
          <th scope="col" className="num">
            B
          </th>
          <th scope="col" className="num">
            Difference
          </th>
          <th scope="col" className="num">
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const both = typeof row.a === 'number' && typeof row.b === 'number';
          const difference = both ? (row.b as number) - (row.a as number) : undefined;
          return (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td className="num">{show(row, row.a)}</td>
              <td className="num">{show(row, row.b)}</td>
              <td className="num">{difference === undefined ? '' : (difference > 0 ? '+' : '') + (row.count ? formatCount(difference) : formatStat(difference))}</td>
              <td className="num">{difference === undefined || row.a === 0 ? '' : `${difference > 0 ? '+' : ''}${((difference / Math.abs(row.a as number)) * 100).toFixed(1)}%`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const PERCENTILE_LABELS = ['1st percentile', '5th percentile', '25th percentile', 'Median', '75th percentile', '95th percentile', '99th percentile'];

export interface ContinuousCompareViewProps {
  name: string;
  statsA: ResultOf<'numericStats'>;
  statsB: ResultOf<'numericStats'>;
  /** Not set while the histograms load. */
  histogramA: ResultOf<'histogram'> | undefined;
  histogramB: ResultOf<'histogram'> | undefined;
  /** The bins that A and B share. */
  edges: BinEdges | undefined;
  bins: number;
  card: Card;
  theme: Theme;
  onChange: (patch: Partial<Card>) => void;
  onBins: (bins: number) => void;
}

/** A number column in A and B: two histograms with the same bins, and the statistics side by side. */
export function ContinuousCompareView(props: ContinuousCompareViewProps) {
  const { statsA, statsB, histogramA, histogramB, edges, card, onChange } = props;
  let rows: PairRow[] | undefined;
  if (histogramA && histogramB && edges) {
    rows = histogramA.counts.map((count, i) => {
      const [from, to] = binBounds(edges, i);
      return { label: `${formatNumber(from)} to ${formatNumber(to)}`, a: count, b: histogramB.counts[i] ?? 0 };
    });
    if (histogramA.below > 0 || histogramB.below > 0) rows.unshift({ label: `Below ${formatNumber(edges.lo)}`, a: histogramA.below, b: histogramB.below, muted: true });
    if (histogramA.above > 0 || histogramB.above > 0) rows.push({ label: `Above ${formatNumber(edges.hi)}`, a: histogramA.above, b: histogramB.above, muted: true });
  }
  const num = (text: string | undefined) => (text === undefined ? undefined : Number(text));
  const stats: StatRow[] = [
    { label: 'Count', a: statsA.nonNull, b: statsB.nonNull, count: true },
    { label: 'Nulls', a: statsA.rowCount - statsA.nonNull, b: statsB.rowCount - statsB.nonNull, count: true },
    { label: 'Zeros', a: statsA.zeros, b: statsB.zeros, count: true },
    { label: 'Negatives', a: statsA.negatives, b: statsB.negatives, count: true },
    { label: 'Mean', a: statsA.mean, b: statsB.mean },
    { label: 'Standard deviation', a: statsA.stddev, b: statsB.stddev },
    { label: 'Min', a: num(statsA.min), b: num(statsB.min) },
    ...PERCENTILE_LABELS.map((label, i) => ({ label: (statsA.approximate || statsB.approximate ? '≈ ' : '') + label, a: statsA.percentiles[i]?.value, b: statsB.percentiles[i]?.value })),
    { label: 'Max', a: num(statsA.max), b: num(statsB.max) },
  ];
  return (
    <>
      <CompareControls card={card} onChange={onChange}>
        <label>
          Bins <input type="range" min={5} max={200} value={props.bins} onChange={(e) => props.onBins(Number(e.target.value))} aria-valuetext={`${props.bins} bins`} /> <output>{props.bins}</output>
        </label>
        <label>
          <input type="checkbox" checked={card.logScale === true} onChange={(e) => onChange({ logScale: e.target.checked })} /> Log scale
        </label>
        <label title="Show the range from the 1st to the 99th percentile of A and B">
          <input type="checkbox" checked={card.clip === true} onChange={(e) => onChange({ clip: e.target.checked })} /> Clip to 1%–99%
        </label>
      </CompareControls>
      {statsA.nonNull === 0 && statsB.nonNull === 0 ? (
        <p className="status">All rows are null in A and B.</p>
      ) : !rows ? (
        <p className="status" role="status">
          Loading the histograms…
        </p>
      ) : (
        <PairView rows={rows} totalA={statsA.nonNull} totalB={statsB.nonNull} head="Range" label={`Histogram of ${props.name} with the same ${edges?.bins} bins for A and B.`} card={card} theme={props.theme} />
      )}
      <CompareStatsTable rows={stats} />
    </>
  );
}

export interface ValuesCompareViewProps {
  name: string;
  a: ResultOf<'frequency'>;
  b: ResultOf<'frequency'>;
  /** The number of values in the chart. */
  topValues: number;
  card: Card;
  theme: Theme;
  onChange: (patch: Partial<Card>) => void;
}

/** A column with few values in A and B: the values of the two datasets, ranked by the larger share. */
export function ValuesCompareView({ name, a, b, topValues, card, theme, onChange }: ValuesCompareViewProps) {
  const [search, setSearch] = useState('');
  const toRow = (v: ComparedValue): PairRow => ({ label: v.label, a: v.countA, b: v.countB, onlyIn: v.onlyIn, muted: v.role !== 'value' });
  const chart = comparedValues(a, b, topValues).map(toRow);
  const all = comparedValues(a, b);
  const needle = search.trim().toLowerCase();
  let table = needle ? all.filter((v) => v.role === 'value' && v.label.toLowerCase().includes(needle)) : all;
  // 'label' sorts by the size of the difference, largest first. The default is the rank by the larger share.
  if (card.sortBy === 'label') table = [...table].sort((x, y) => Math.abs(y.shareB - y.shareA) - Math.abs(x.shareB - x.shareA));
  return (
    <>
      <CompareControls card={card} onChange={onChange} />
      {!card.asTable && <PairView rows={chart} totalA={a.rowCount} totalB={b.rowCount} head="Value" label={`The most frequent values of ${name}, ${chart.length} bars.`} card={card} theme={theme} horizontal />}
      <div className="controls">
        <input type="search" placeholder="Search values" aria-label="Search values" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label>
          Sort by{' '}
          <select value={card.sortBy ?? 'count'} onChange={(e) => onChange({ sortBy: e.target.value as 'count' | 'label' })}>
            <option value="count">Larger share</option>
            <option value="label">Size of the difference</option>
          </select>
        </label>
      </div>
      <PairView rows={table.map(toRow)} totalA={a.rowCount} totalB={b.rowCount} head="Value" label="" card={{ ...card, asTable: true }} theme={theme} />
    </>
  );
}

const GRAINS: Grain[] = ['day', 'week', 'month', 'year'];

export interface DateCompareViewProps {
  name: string;
  statsA: OverviewColumn;
  statsB: OverviewColumn;
  /** Not set while they load. */
  countsA: ResultOf<'dateCounts'> | undefined;
  countsB: ResultOf<'dateCounts'> | undefined;
  grain: Grain;
  card: Card;
  theme: Theme;
  onChange: (patch: Partial<Card>) => void;
}

/** A date column in A and B: the rows of each period on one axis, and the first and last date of each dataset. */
export function DateCompareView({ name, statsA, statsB, countsA, countsB, grain, card, theme, onChange }: DateCompareViewProps) {
  const shared = countsA && countsB ? sharedPeriods(countsA.buckets, countsB.buckets, grain) : undefined;
  const span = (stats: OverviewColumn) => (stats.min !== undefined && stats.max !== undefined ? spanDays(stats.min, stats.max) : undefined);
  const day = (text: string | undefined) => (text === undefined ? undefined : text.slice(0, 10));
  return (
    <>
      <CompareControls card={card} onChange={onChange}>
        <label>
          Period{' '}
          <select value={grain} onChange={(e) => onChange({ grain: e.target.value as Grain })}>
            {GRAINS.map((g) => (
              <option key={g} value={g}>
                {g[0]?.toUpperCase() + g.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={card.logScale === true} onChange={(e) => onChange({ logScale: e.target.checked })} /> Log scale
        </label>
      </CompareControls>
      {!shared ? (
        <p className="status" role="status">
          Loading…
        </p>
      ) : (
        <PairView
          rows={shared.starts.map((start, i) => ({ label: start, a: shared.a[i] ?? 0, b: shared.b[i] ?? 0 }))}
          totalA={statsA.nonNull}
          totalB={statsB.nonNull}
          head={`Start of the ${grain}`}
          label={`Rows of ${name} for each ${grain}, ${shared.starts.length} periods.`}
          card={card}
          theme={theme}
        />
      )}
      <CompareStatsTable
        rows={[
          { label: 'Earliest', a: day(statsA.min), b: day(statsB.min) },
          { label: 'Latest', a: day(statsA.max), b: day(statsB.max) },
          { label: 'Span in days', a: span(statsA), b: span(statsB), count: true },
        ]}
      />
    </>
  );
}

/** A column that has no values to chart (an ID or a complex type): the counts of the overview side by side. */
export function SimpleCompareView({ rowsA, rowsB, statsA, statsB }: { rowsA: number; rowsB: number; statsA: OverviewColumn; statsB: OverviewColumn }) {
  return (
    <CompareStatsTable
      rows={[
        { label: 'Rows', a: rowsA, b: rowsB, count: true },
        { label: 'Nulls', a: rowsA - statsA.nonNull, b: rowsB - statsB.nonNull, count: true },
        { label: 'Distinct values', a: statsA.distinct, b: statsB.distinct, count: true },
      ]}
    />
  );
}
