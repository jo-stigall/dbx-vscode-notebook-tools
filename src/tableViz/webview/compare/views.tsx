/**
 * The content of a detail card in compare mode.
 *
 * Each component gets finished results as properties and sends no request,
 * so a test can draw a card from fixed results. The components in
 * CompareCard.tsx send the requests.
 *
 * A chart shows dataset A and dataset B for the same bins, values or
 * periods. By default it shows the percent of the rows of each dataset,
 * because A and B usually have different sizes.
 */
import { useState, type ReactNode } from 'react';
import { binBounds } from '../../core/bins.ts';
import { comparedValues, type ComparedValue } from '../../core/compare.ts';
import { chipForBins, chipForPeriods, chipForValue, sharedPeriods, spanDays } from '../../core/derive.ts';
import type { Drift } from '../../core/drift.ts';
import type { BinEdges, Card, Chip, ColumnRef, Grain, OverviewColumn, ResultOf } from '../../core/schema.ts';
import { CardLayout, ChartWait, DETAIL_HEIGHT, RowFilter } from '../cards/views.tsx';
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
 * formatPoints(0.05 - 0.349)   // '-29.9 pp'
 * formatPoints(0)              // '0 pp'
 *
 * @param difference  The share in B minus the share in A. A share is from 0 to 1.
 */
export function formatPoints(difference: number): string {
  const points = Math.round(difference * 1000) / 10;
  return `${points > 0 ? '+' : ''}${points} pp`;
}

/**
 * Tell in words how the compare code made the bins of a drift score. DriftLine puts the words after "Jensen-Shannon distance".
 *
 * A column usually has 10 bins. It has fewer if two or more deciles of A are
 * the same value, for example in a column with three different values. The
 * null rows are a bin of their own, if A or B has null rows.
 *
 * @example
 * methodText({ method: 'deciles', bins: [10 bins and '(null)'], ... })   // 'over 10 bins cut at the deciles of A, plus a bin for null'
 * methodText({ method: 'deciles', bins: [2 bins], ... })                 // 'over 2 bins cut at the deciles of A'
 * methodText({ method: 'values', ... })                                  // 'over the values of A and B'
 */
function methodText(drift: Drift): string {
  if (drift.method === 'values') return 'over the values of A and B';
  if (drift.method === 'nulls') return 'over "null" and "not null" only';
  // columnDrift() in core/compare.ts gives the bin of the null rows this label.
  const hasNull = drift.bins.some((bin) => bin.label === '(null)');
  const count = drift.bins.length - (hasNull ? 1 : 0);
  return `over ${count} ${count === 1 ? 'bin' : 'bins'} cut at the deciles of A${hasNull ? ', plus a bin for null' : ''}`;
}

/**
 * The drift of a column in words: the score, the PSI, and the null rate on its own line.
 *
 * @example
 * <DriftLine drift={{ score: 0.31, psi: 0.42, nullRateA: 0.05, nullRateB: 0.349, method: 'values', bins: [] }} />
 * // Drift score 0.31 (Jensen-Shannon distance over the values of A and B; 0 is "the same", 1 is "nothing in common") · Population Stability Index 0.42
 * // Null rate: 5% in A, 34.9% in B (+29.9 pp)
 */
export function DriftLine({ drift }: { drift: Drift }) {
  return (
    <div className="drift">
      <p>
        <strong>Drift score {formatScore(drift.score)}</strong> (Jensen-Shannon distance {methodText(drift)}; 0 is "the same", 1 is "nothing in common") · Population Stability Index{' '}
        {formatScore(drift.psi)}
      </p>
      <p>
        Null rate: {formatPercent(Math.round(drift.nullRateA * 1e6), 1e6)} in A, {formatPercent(Math.round(drift.nullRateB * 1e6), 1e6)} in B ({formatPoints(drift.nullRateB - drift.nullRateA)})
      </p>
    </div>
  );
}

/**
 * Makes the filter chip of a selection for one column.
 *
 * In compare mode a selection filters dataset A and dataset B. The column
 * can have a different name or type in B, so the board calls this function
 * one time with the column of A and one time with the column of B.
 *
 * @example
 * const make: ChipMaker = (column) => chipForValue(column, 'value', 'web');
 * make({ name: 'channel', typeText: 'string' })   // { op: 'eq', column: { name: 'channel', typeText: 'string' }, value: 'web' }
 *
 * @returns The chip, or undefined if the selection cannot be a filter, for example the row "Other".
 */
export type ChipMaker = (column: ColumnRef) => Chip | undefined;

/** One line of a chart or table that shows A and B: a bin, a value or a period. */
export interface PairRow {
  /** The text of the line. Example: '0 to 25', 'web' or '2026-01-01'. */
  label: string;
  /** The number of rows in A and in B. */
  a: number;
  b: number;
  /** The row is in one dataset only. The table marks it. */
  onlyIn?: 'a' | 'b';
  /** true for a row such as "Other" or "(null)". The table shows it in a different style. */
  muted?: boolean;
}

/** The properties of the `PairView` component. */
export interface PairViewProps {
  /** One row for each bin, value or period, in the sequence of the chart. */
  rows: PairRow[];
  /** The number that 100% is, for each dataset. */
  totalA: number;
  totalB: number;
  /** The title of the first column of the table. Example: 'Range'. */
  head: string;
  /** One sentence for a screen reader. */
  label: string;
  /** The settings of the card. The view reads `asTable`, `sideBySide`, `rawCounts`, `logScale` and `expanded`. */
  card: Card;
  /** The colors and the font of the chart. */
  theme: Theme;
  /** true: the bars go from left to right, with the first row at the top. Use it for values, which have long labels. */
  horizontal?: boolean;
  /** The user selected rows: a click on one bar, a drag across some bars, or the filter button of a table row. */
  onSelect?: (first: number, last: number) => void;
  /** true: a drag across the chart selects a range. */
  range?: boolean;
  /** Returns false for a row that cannot be a filter, for example "Other". */
  canFilter?: (index: number) => boolean;
  /** The title of the axis that has the bars, in the detailed view. Example: the name of the column. */
  categoryName?: string;
}

/** A chart with this number of rows or fewer has a label on each bar in the detailed view. Each row has two bars. */
const MAX_LABELLED_ROWS = 12;

/**
 * A chart of A and B for the same rows, or the same numbers as a table.
 *
 * The settings of the card select what the user sees:
 *
 * | Setting           | What the user sees                                                        |
 * |-------------------|---------------------------------------------------------------------------|
 * | none              | One chart. Each row has a bar of A and a bar of B, as a percent of the rows of each dataset. |
 * | `card.rawCounts`  | The bars show numbers of rows, not percents.                              |
 * | `card.sideBySide` | One chart for A and one chart for B, with the same scale on the count axis. |
 * | `card.asTable`    | A table: the rows and the percent in A and in B, and the difference in percentage points. |
 *
 * In the detailed view (`card.expanded`), the chart is larger, the axes
 * have titles, and a chart with few bars has a number on each bar.
 *
 * A click on a bar, a drag across some bars (with `range`), or the filter
 * button of a table row calls `onSelect` with the positions of the first
 * and the last selected row.
 *
 * @example
 * <PairView rows={[{ label: 'web', a: 60, b: 50 }, { label: 'store', a: 30, b: 50 }]} totalA={90} totalB={100}
 *   head="Value" label="The most frequent values of channel, 2 bars." card={card} theme={theme} horizontal />
 * // The bars of 'web' are 66.7% for A and 50% for B.
 */
export function PairView({ rows, totalA, totalB, head, label, card, theme, horizontal, onSelect, range, canFilter, categoryName }: PairViewProps) {
  const share = (count: number, total: number) => (total === 0 ? 0 : (count / total) * 100);
  const percent = !card.rawCounts;
  const detailed = card.expanded === true;
  const a = rows.map((r) => (percent ? share(r.a, totalA) : r.a));
  const b = rows.map((r) => (percent ? share(r.b, totalB) : r.b));
  const axisFormat = percent ? (value: number) => `${formatNumber(value)}%` : undefined;
  const tips = rows.map((r) => `${r.label}\nA: ${formatCount(r.a)} rows (${formatPercent(r.a, totalA)})\nB: ${formatCount(r.b)} rows (${formatPercent(r.b, totalB)})`);
  const height = horizontal ? Math.max(detailed ? 220 : 140, (detailed ? 80 : 60) + rows.length * (detailed ? 36 : 26)) : detailed ? DETAIL_HEIGHT : undefined;
  const detail = detailed ? { categoryName, countName: percent ? 'Percent of the rows of the dataset' : 'Rows' } : undefined;
  const barLabel = (value: number) => (value === 0 ? '' : percent ? `${value.toFixed(1)}%` : formatCount(value));
  const labelled = detailed && rows.length <= MAX_LABELLED_ROWS;

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
            {rows.map((r, i) => (
              <tr key={r.label} className={r.muted ? 'muted' : undefined}>
                <td>
                  {onSelect && (canFilter?.(i) ?? true) && <RowFilter label={r.label} onClick={() => onSelect(i, i)} />}
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
    // The two charts have the same top of the axis, so that you can compare the heights of their bars.
    const max = Math.max(...a, ...b, 0) || undefined;
    const one = (values: number[], name: 'A' | 'B') => (
      <div className="side">
        <p className="side-name">
          <span className={`chip chip-${name.toLowerCase()}`}>{name}</span>
        </p>
        <Chart
          onSelect={onSelect}
          range={range}
          horizontal={horizontal}
          label={`${label} Dataset ${name}.`}
          height={height}
          option={barsOption(theme, {
            labels: rows.map((r) => r.label),
            counts: values,
            tips,
            logScale: card.logScale,
            horizontal,
            gap: 10,
            color: name === 'A' ? theme.a : theme.b,
            max: card.logScale ? undefined : max,
            axisFormat,
            detail: detail && { ...detail, barLabels: labelled ? values.map(barLabel) : undefined },
          })}
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
  return (
    <Chart
      onSelect={onSelect}
      range={range}
      horizontal={horizontal}
      label={`${label} Dataset A and dataset B.`}
      height={height}
      option={compareBarsOption(theme, {
        labels: rows.map((r) => r.label),
        a,
        b,
        tips,
        nameA: 'A',
        nameB: 'B',
        logScale: card.logScale,
        horizontal,
        axisFormat,
        detail,
        labelsA: labelled ? a.map(barLabel) : undefined,
        labelsB: labelled ? b.map(barLabel) : undefined,
      })}
    />
  );
}

/**
 * The controls that each compare card has: percent or counts, one chart or two.
 *
 * "Row counts" calls `onChange({ rawCounts: true })` or `false`. "Side by
 * side" calls `onChange({ sideBySide: true })` or `false`.
 *
 * @example
 * <CompareControls card={card} onChange={onChange}>
 *   <label>Period <select>...</select></label>
 * </CompareControls>
 *
 * @param children  The controls of one kind of card, for example the "Bins" slider. They come first.
 */
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
  /** The name of the statistic. Example: 'Mean'. */
  label: string;
  /** The value in A and in B. undefined shows as "—". */
  a: number | string | undefined;
  b: number | string | undefined;
  /** true: the value is a count. The table writes it with separators and no decimals. */
  count?: boolean;
}

/**
 * A table with one statistic in each row: the value in A, the value in B, the difference, and the change in percent.
 *
 * The difference is B minus A. The change is the difference as a percent
 * of the value in A. The two cells are empty if a value is text or is not
 * set. The change is also empty if the value in A is 0.
 *
 * @example
 * <CompareStatsTable rows={[{ label: 'Count', a: 100000, b: 110000, count: true }, { label: 'Earliest', a: '2026-01-01', b: '2026-02-01' }]} />
 * // Statistic   A            B            Difference   Change
 * // Count       100,000      110,000      +10,000      +10.0%
 * // Earliest    2026-01-01   2026-02-01
 */
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

/** The names of the percentiles in the statistics table, in the sequence of PERCENTILES in core/schema.ts. */
const PERCENTILE_LABELS = ['1st percentile', '5th percentile', '25th percentile', 'Median', '75th percentile', '95th percentile', '99th percentile'];

/** The properties of the `ContinuousCompareView` component. */
export interface ContinuousCompareViewProps {
  /** The name of the column in A. */
  name: string;
  /** The statistics of the column in A and in B. */
  statsA: ResultOf<'numericStats'>;
  statsB: ResultOf<'numericStats'>;
  /** The counts of the bins in A and in B. Not set while the histograms load. */
  histogramA: ResultOf<'histogram'> | undefined;
  histogramB: ResultOf<'histogram'> | undefined;
  /** The bins that A and B share. */
  edges: BinEdges | undefined;
  /** The number of bins that the slider shows. */
  bins: number;
  /** The settings of the card. */
  card: Card;
  /** The colors and the font of the chart. */
  theme: Theme;
  /** The user changed "Log scale", "Clip to 1%–99%", "Row counts" or "Side by side". */
  onChange: (patch: Partial<Card>) => void;
  /** The user moved the "Bins" slider. The card asks for new histograms a moment later. */
  onBins: (bins: number) => void;
  /** The user selected bins. The board adds the chip to A and to B. */
  onFilter?: (make: ChipMaker) => void;
}

/**
 * A number column in A and B: two histograms with the same bins, and the statistics side by side.
 *
 * The rows "Below ..." and "Above ..." hold the values outside the bins.
 * They show only if a dataset has such values.
 *
 * What the view does when the user acts:
 *
 * - The "Bins" slider calls `onBins` with the new number, from 5 to 200.
 * - The check boxes call `onChange`.
 * - A click on a bar, or a drag across some bars, calls `onFilter` with a
 *   function that makes the chip for the range of those bins. The rows
 *   "Below ..." and "Above ..." cannot be a filter.
 *
 * @example
 * <ContinuousCompareView name="amount" statsA={statsA} statsB={statsB} histogramA={histogramA} histogramB={histogramB}
 *   edges={{ lo: 0, hi: 500, bins: 30 }} bins={30} card={card} theme={theme} onChange={onChange} onBins={setBins} />
 */
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
  // The row "Below ..." is not a bin. If it is there, the bins start at position 1.
  const offset = rows?.[0]?.label.startsWith('Below ') && rows[0].muted ? 1 : 0;
  const { onFilter } = props;
  const select =
    onFilter && edges
      ? (first: number, last: number) => {
          const from = Math.max(0, first - offset);
          const to = Math.min(edges.bins - 1, last - offset);
          if (to >= from) onFilter((column) => chipForBins(column, edges, from, to));
        }
      : undefined;
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
  const detailed = card.expanded === true;
  return (
    <CardLayout
      detailed={detailed}
      controls={
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
      }
      main={
        statsA.nonNull === 0 && statsB.nonNull === 0 ? (
          <p className="status">All rows are null in A and B.</p>
        ) : !rows ? (
          <ChartWait detailed={detailed}>Loading the histograms…</ChartWait>
        ) : (
          <PairView
            rows={rows}
            totalA={statsA.nonNull}
            totalB={statsB.nonNull}
            head="Range"
            label={`Histogram of ${props.name} with the same ${edges?.bins} bins for A and B.`}
            card={card}
            theme={props.theme}
            onSelect={select}
            range
            canFilter={(i) => !rows?.[i]?.muted}
            categoryName={props.name}
          />
        )
      }
      side={<CompareStatsTable rows={stats} />}
    />
  );
}

/** The properties of the `ValuesCompareView` component. */
export interface ValuesCompareViewProps {
  /** The name of the column in A. */
  name: string;
  /** The most frequent values of the column in A and in B, from comparedFrequency() in core/compare.ts. */
  a: ResultOf<'frequency'>;
  b: ResultOf<'frequency'>;
  /** The number of values in the chart. */
  topValues: number;
  /** The settings of the card. In this view, `sortBy: 'label'` sorts the table by the size of the difference. */
  card: Card;
  /** The colors and the font of the chart. */
  theme: Theme;
  /** The user changed "Sort by", "Row counts" or "Side by side". */
  onChange: (patch: Partial<Card>) => void;
  /** The user selected a value. The board adds the chip to A and to B. */
  onFilter?: (make: ChipMaker) => void;
}

/**
 * A column with few values in A and B: the values of the two datasets, ranked by the larger share.
 *
 * The chart shows the `topValues` values with the largest share in A or in
 * B. The table shows all values of the two results and marks a value that
 * only one dataset has.
 *
 * What the view does when the user acts:
 *
 * - Text in "Search values" keeps only the table rows whose value contains
 *   the text. The chart does not change.
 * - "Sort by" calls `onChange`. "Size of the difference" puts the value
 *   whose share changed most at the top of the table.
 * - A click on a bar, or the filter button of a table row, calls `onFilter`
 *   with a function that makes the chip for that value. A click on "Other"
 *   does nothing.
 *
 * @example
 * <ValuesCompareView name="channel" a={frequencyA} b={frequencyB} topValues={20} card={card} theme={theme} onChange={onChange} onFilter={onFilter} />
 */
export function ValuesCompareView({ name, a, b, topValues, card, theme, onChange, onFilter }: ValuesCompareViewProps) {
  const [search, setSearch] = useState('');
  const toRow = (v: ComparedValue): PairRow => ({ label: v.label, a: v.countA, b: v.countB, onlyIn: v.onlyIn, muted: v.role !== 'value' });
  const chart = comparedValues(a, b, topValues).map(toRow);
  const all = comparedValues(a, b);
  const needle = search.trim().toLowerCase();
  let table = needle ? all.filter((v) => v.role === 'value' && v.label.toLowerCase().includes(needle)) : all;
  // 'label' sorts by the size of the difference, largest first. The default is the rank by the larger share.
  if (card.sortBy === 'label') table = [...table].sort((x, y) => Math.abs(y.shareB - y.shareA) - Math.abs(x.shareB - x.shareA));
  const selectIn = (list: ComparedValue[]) =>
    onFilter &&
    ((first: number) => {
      const value = list[first];
      if (value && value.role !== 'other') onFilter((column) => chipForValue(column, value.role, value.label));
    });
  return (
    <CardLayout
      detailed={card.expanded === true}
      controls={<CompareControls card={card} onChange={onChange} />}
      main={
        !card.asTable && (
          <PairView
            rows={chart}
            totalA={a.rowCount}
            totalB={b.rowCount}
            head="Value"
            label={`The most frequent values of ${name}, ${chart.length} bars.`}
            card={card}
            theme={theme}
            horizontal
            onSelect={selectIn(comparedValues(a, b, topValues))}
            categoryName={name}
          />
        )
      }
      side={
        <>
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
          <PairView rows={table.map(toRow)} totalA={a.rowCount} totalB={b.rowCount} head="Value" label="" card={{ ...card, asTable: true }} theme={theme} onSelect={selectIn(table)} canFilter={(i) => table[i]?.role !== 'other'} />
        </>
      }
    />
  );
}

/** The periods in the "Period" list of a date card, shortest first. */
const GRAINS: Grain[] = ['day', 'week', 'month', 'year'];

/** The properties of the `DateCompareView` component. */
export interface DateCompareViewProps {
  /** The name of the column in A. */
  name: string;
  /** The overview numbers of the column in A and in B. `min` is the first date and `max` is the last date. */
  statsA: OverviewColumn;
  statsB: OverviewColumn;
  /** The number of rows in each period, in A and in B. Not set while they load. */
  countsA: ResultOf<'dateCounts'> | undefined;
  countsB: ResultOf<'dateCounts'> | undefined;
  /** The period that the user selected. */
  grain: Grain;
  /** The period of `countsA` and `countsB`. It is different from `grain` while the counts of a new period load. Default: `grain`. */
  shownGrain?: Grain;
  /** The settings of the card. */
  card: Card;
  /** The colors and the font of the chart. */
  theme: Theme;
  /** The user changed "Period", "Log scale", "Row counts" or "Side by side". */
  onChange: (patch: Partial<Card>) => void;
  /** The user selected periods. The board adds the chip to A and to B. */
  onFilter?: (make: ChipMaker) => void;
}

/**
 * A date column in A and B: the rows of each period on one axis, and the first and last date of each dataset.
 *
 * The axis goes from the first period of A or B to the last period of A or
 * B. A period where a dataset has no rows gets the count 0 for that
 * dataset.
 *
 * What the view does when the user acts:
 *
 * - "Period" and the check boxes call `onChange`.
 * - A click on a bar, or a drag across some bars, calls `onFilter` with a
 *   function that makes the chip for those periods.
 *
 * @example
 * <DateCompareView name="order_date" statsA={statsA} statsB={statsB} countsA={countsA} countsB={countsB} grain="month" card={card} theme={theme} onChange={onChange} />
 */
export function DateCompareView({ name, statsA, statsB, countsA, countsB, grain, shownGrain = grain, card, theme, onChange, onFilter }: DateCompareViewProps) {
  const shared = countsA && countsB ? sharedPeriods(countsA.buckets, countsB.buckets, shownGrain) : undefined;
  const detailed = card.expanded === true;
  const span = (stats: OverviewColumn) => (stats.min !== undefined && stats.max !== undefined ? spanDays(stats.min, stats.max) : undefined);
  const day = (text: string | undefined) => (text === undefined ? undefined : text.slice(0, 10));
  const select =
    onFilter && shared
      ? (first: number, last: number) => {
          const from = shared.starts[Math.max(0, first)];
          const to = shared.starts[Math.min(shared.starts.length - 1, last)];
          if (from && to) onFilter((column) => chipForPeriods(column, from, to, shownGrain));
        }
      : undefined;
  return (
    <CardLayout
      detailed={detailed}
      controls={
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
      }
      main={
        !shared ? (
          <ChartWait detailed={detailed}>Loading…</ChartWait>
        ) : (
          <PairView
            rows={shared.starts.map((start, i) => ({ label: start, a: shared.a[i] ?? 0, b: shared.b[i] ?? 0 }))}
            totalA={statsA.nonNull}
            totalB={statsB.nonNull}
            head={`Start of the ${shownGrain}`}
            label={`Rows of ${name} for each ${shownGrain}, ${shared.starts.length} periods.`}
            card={card}
            theme={theme}
            onSelect={select}
            range
            categoryName={`${name} (start of the ${shownGrain})`}
          />
        )
      }
      side={
        <CompareStatsTable
          rows={[
            { label: 'Earliest', a: day(statsA.min), b: day(statsB.min) },
            { label: 'Latest', a: day(statsA.max), b: day(statsB.max) },
            { label: 'Span in days', a: span(statsA), b: span(statsB), count: true },
          ]}
        />
      }
    />
  );
}

/**
 * A column that has no values to chart (an ID or a complex type): the counts of the overview side by side.
 *
 * @example
 * <SimpleCompareView rowsA={100000} rowsB={110000} statsA={{ name: 'order_id', nonNull: 100000, distinct: 100000 }} statsB={{ name: 'order_id', nonNull: 109450, distinct: 109450 }} />
 * // Statistic         A         B         Difference   Change
 * // Rows              100,000   110,000   +10,000      +10.0%
 * // Nulls             0         550       +550
 * // Distinct values   100,000   109,450   +9,450       +9.4%
 */
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
