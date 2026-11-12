/**
 * The content of each kind of detail card.
 *
 * Each component in this file gets finished results as properties and sends
 * no request. Thus a test can draw a card from fixed results.
 *
 * | Kind       | Component      | Chart                    | Tables                         |
 * |------------|----------------|--------------------------|--------------------------------|
 * | continuous | ContinuousView | Histogram                | Statistics                     |
 * | discrete   | ValuesView     | One bar for each value   | Frequency table                |
 * | category   | ValuesView     | Top values, Other, null  | Frequency table with a search  |
 * | identifier | IdentifierView | Lengths of the values    | Statistics, most repeated values |
 * | date       | DateView       | Rows over time           | First, last, span, empty periods |
 * | complex    | ComplexView    | None                     | Type and percent null          |
 */
import { useState, type ReactNode } from 'react';
import { fillPeriods, frequencyRows, histogramBars, spanDays, type FrequencyRow } from '../../core/derive.ts';
import { isNumeric, typeFamily } from '../../core/kinds.ts';
import type { BinEdges, Card, ColumnInfo, Grain, OverviewColumn, ResultOf } from '../../core/schema.ts';
import { Chart } from '../Chart.tsx';
import { formatCount, formatNumber, formatPercent, formatStat, formatValue } from '../format.ts';
import { barsOption } from '../options.ts';
import type { Theme } from '../theme.ts';

/** A table with a name column and a value column. */
function StatsTable({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <table className="stats">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A table of counts: one row for each bar of a chart. */
function CountTable({ head, rows, total }: { head: string; rows: { label: string; count: number }[]; total: number }) {
  return (
    <div className="scroll">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">{head}</th>
            <th scope="col" className="num">
              Rows
            </th>
            <th scope="col" className="num">
              Percent
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td>{row.label}</td>
              <td className="num">{formatCount(row.count)}</td>
              <td className="num">{formatPercent(row.count, total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const PERCENTILE_LABELS: Record<string, string> = {
  '0.01': '1st percentile',
  '0.05': '5th percentile',
  '0.25': '25th percentile',
  '0.5': 'Median',
  '0.75': '75th percentile',
  '0.95': '95th percentile',
  '0.99': '99th percentile',
};

export interface ContinuousViewProps {
  column: ColumnInfo;
  stats: ResultOf<'numericStats'>;
  /** Not set while the histogram loads. */
  histogram: ResultOf<'histogram'> | undefined;
  edges: BinEdges | undefined;
  /** The number of bins that the slider shows. */
  bins: number;
  card: Card;
  theme: Theme;
  onChange: (patch: Partial<Card>) => void;
  /** The user moved the slider. The card asks for a new histogram a moment later. */
  onBins: (bins: number) => void;
}

/** A number column with many values: a histogram and a table of statistics. */
export function ContinuousView(props: ContinuousViewProps) {
  const { column, stats, histogram, edges, card, onChange } = props;
  const approx = stats.approximate ? '≈ ' : '';
  const bars = histogram && edges ? histogramBars(histogram, edges) : undefined;
  const label = (bar: { role: string; from?: number; to?: number }) =>
    bar.role === 'below' ? `Below ${formatNumber(bar.to as number)}` : bar.role === 'above' ? `Above ${formatNumber(bar.from as number)}` : `${formatNumber(bar.from as number)} to ${formatNumber(bar.to as number)}`;

  const rows: [string, ReactNode][] = [
    ['Count', formatCount(stats.nonNull)],
    ['Nulls', `${formatCount(stats.rowCount - stats.nonNull)} (${formatPercent(stats.rowCount - stats.nonNull, stats.rowCount)})`],
    ['Zeros', formatCount(stats.zeros)],
    ['Negatives', formatCount(stats.negatives)],
    ['Mean', stats.mean === undefined ? '—' : formatStat(stats.mean)],
    ['Standard deviation', stats.stddev === undefined ? '—' : formatStat(stats.stddev)],
    ['Min', stats.min === undefined ? '—' : formatValue(stats.min)],
    ...stats.percentiles.map((p): [string, ReactNode] => [PERCENTILE_LABELS[String(p.p)] ?? `p${p.p}`, approx + formatStat(p.value)]),
    ['Max', stats.max === undefined ? '—' : formatValue(stats.max)],
  ];

  return (
    <>
      <div className="controls">
        <label>
          Bins{' '}
          <input type="range" min={5} max={200} value={props.bins} onChange={(e) => props.onBins(Number(e.target.value))} aria-valuetext={`${props.bins} bins`} />{' '}
          <output>{props.bins}</output>
        </label>
        <label>
          <input type="checkbox" checked={card.logScale === true} onChange={(e) => onChange({ logScale: e.target.checked })} /> Log scale
        </label>
        <label title="Show the range from the 1st to the 99th percentile">
          <input type="checkbox" checked={card.clip === true} onChange={(e) => onChange({ clip: e.target.checked })} /> Clip to 1%–99%
        </label>
      </div>
      {stats.nonNull === 0 ? (
        <p className="status">All rows are null.</p>
      ) : !bars ? (
        <p className="status" role="status">
          Loading the histogram…
        </p>
      ) : card.asTable ? (
        <CountTable head="Range" rows={bars.map((b) => ({ label: label(b), count: b.count }))} total={stats.nonNull} />
      ) : (
        <Chart
          label={`Histogram of ${column.name} with ${bars.length} bars.`}
          option={barsOption(props.theme, {
            labels: bars.map((b) => (b.role === 'below' ? 'below' : b.role === 'above' ? 'above' : formatNumber(b.from as number))),
            counts: bars.map((b) => b.count),
            tips: bars.map((b) => `${label(b)}\n${formatCount(b.count)} rows (${formatPercent(b.count, stats.nonNull)})`),
            logScale: card.logScale,
            gap: 4,
          })}
        />
      )}
      <StatsTable rows={rows} />
    </>
  );
}

/** The table of values: value, count, percent and cumulative percent. */
function FrequencyTable({ rows, total }: { rows: FrequencyRow[]; total: number }) {
  return (
    <div className="scroll">
      <table className="data">
        <thead>
          <tr>
            <th scope="col">Value</th>
            <th scope="col" className="num">
              Rows
            </th>
            <th scope="col" className="num">
              Percent
            </th>
            <th scope="col" className="num">
              Cumulative
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.role + row.label} className={row.role === 'value' ? undefined : 'muted'}>
              <td>{row.label}</td>
              <td className="num">{formatCount(row.count)}</td>
              <td className="num">{formatPercent(row.count, total)}</td>
              <td className="num">{row.cumulative === undefined ? '' : formatPercent(Math.round(row.cumulative * total), total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ValuesViewProps {
  column: ColumnInfo;
  /** 'discrete': one bar for each value, in the sequence of the values. 'category': the top values, most frequent first. */
  kind: 'discrete' | 'category';
  frequency: ResultOf<'frequency'>;
  /** The number of different values of the column, from the overview. */
  distinct: number | undefined;
  /** The number of values in the chart of a category. */
  topValues: number;
  card: Card;
  theme: Theme;
  onChange: (patch: Partial<Card>) => void;
}

/** A column with few different values: a bar for each value and a frequency table. */
export function ValuesView(props: ValuesViewProps) {
  const { column, kind, frequency, card, onChange } = props;
  const [search, setSearch] = useState('');
  const numeric = isNumeric(typeFamily(column.typeText));
  const sortBy = kind === 'discrete' ? 'label' : (card.sortBy ?? 'count');

  const chartRows = frequencyRows(frequency, { limit: kind === 'discrete' ? undefined : props.topValues, sortBy, numeric });
  const allRows = frequencyRows(frequency, { sortBy, numeric });
  const needle = search.trim().toLowerCase();
  const tableRows = needle ? allRows.filter((r) => r.role === 'value' && r.label.toLowerCase().includes(needle)) : allRows;
  const hidden = props.distinct !== undefined ? props.distinct - frequency.values.length : 0;

  return (
    <>
      {kind === 'category' && (
        <div className="controls">
          <label>
            Sort by{' '}
            <select value={sortBy} onChange={(e) => onChange({ sortBy: e.target.value as 'count' | 'label' })}>
              <option value="count">Count</option>
              <option value="label">Label</option>
            </select>
          </label>
        </div>
      )}
      {!card.asTable && (
        <Chart
          label={`${kind === 'discrete' ? 'Rows for each value' : 'Most frequent values'} of ${column.name}, ${chartRows.length} bars.`}
          option={barsOption(props.theme, {
            labels: chartRows.map((r) => r.label),
            counts: chartRows.map((r) => r.count),
            tips: chartRows.map((r) => `${r.label}\n${formatCount(r.count)} rows (${formatPercent(r.count, frequency.rowCount)})`),
            horizontal: kind === 'category',
          })}
          // A horizontal chart needs space for the label of each bar.
          height={kind === 'category' ? Math.max(120, 40 + chartRows.length * 20) : undefined}
        />
      )}
      <div className="controls">
        <input type="search" placeholder="Search values" aria-label="Search values" value={search} onChange={(e) => setSearch(e.target.value)} />
        {hidden > 0 && (
          <span className="count">
            The table shows the {formatCount(frequency.values.length)} most frequent of {formatCount(props.distinct as number)} values.
          </span>
        )}
      </div>
      <FrequencyTable rows={tableRows} total={frequency.rowCount} />
    </>
  );
}

export interface IdentifierViewProps {
  column: ColumnInfo;
  rowCount: number;
  stats: OverviewColumn;
  /** true if the distinct count is an estimate. */
  approximate: boolean;
  /** The most frequent values. Not set while it loads. */
  frequency: ResultOf<'frequency'> | undefined;
  /** The histogram of the lengths of the values. Not set while it loads. */
  lengths: ResultOf<'histogram'> | undefined;
  lengthEdges: BinEdges | undefined;
  card: Card;
  theme: Theme;
}

/** A column where almost every row has a different value: statistics, the values that repeat, and the lengths of the values. */
export function IdentifierView(props: IdentifierViewProps) {
  const { column, stats, rowCount, frequency, lengths, lengthEdges } = props;
  const distinct = stats.distinct ?? 0;
  const repeated = frequency?.values.filter((v) => v.count > 1) ?? [];
  const bars = lengths && lengthEdges ? histogramBars(lengths, lengthEdges) : undefined;
  // The length of a value is a whole number. Show "6" for a bin that holds one length, and "6 to 8" for a wider bin.
  const lengthLabel = (from: number, to: number) => (to - from <= 1 ? String(Math.floor(from)) : `${Math.floor(from)} to ${Math.ceil(to) - 1}`);

  return (
    <>
      <StatsTable
        rows={[
          ['Distinct values', (props.approximate ? '≈ ' : '') + formatCount(distinct)],
          ['Percent unique', formatPercent(Math.min(distinct, stats.nonNull), stats.nonNull)],
          ['Nulls', `${formatCount(rowCount - stats.nonNull)} (${formatPercent(rowCount - stats.nonNull, rowCount)})`],
        ]}
      />
      <h3>Most repeated values</h3>
      {!frequency ? (
        <p className="status" role="status">
          Loading…
        </p>
      ) : repeated.length === 0 ? (
        <p className="status">No value occurs more than one time.</p>
      ) : (
        <CountTable head="Value" rows={repeated.map((v) => ({ label: v.value, count: v.count }))} total={rowCount} />
      )}
      <h3>Length of the values</h3>
      {!bars ? (
        <p className="status" role="status">
          Loading…
        </p>
      ) : props.card.asTable ? (
        <CountTable head="Characters" rows={bars.map((b) => ({ label: lengthLabel(b.from as number, b.to as number), count: b.count }))} total={stats.nonNull} />
      ) : (
        <Chart
          label={`Histogram of the number of characters in the values of ${column.name}.`}
          option={barsOption(props.theme, {
            labels: bars.map((b) => lengthLabel(b.from as number, b.to as number)),
            counts: bars.map((b) => b.count),
            tips: bars.map((b) => `${lengthLabel(b.from as number, b.to as number)} characters\n${formatCount(b.count)} rows`),
            gap: 4,
          })}
        />
      )}
    </>
  );
}

const GRAINS: Grain[] = ['day', 'week', 'month', 'year'];

export interface DateViewProps {
  column: ColumnInfo;
  rowCount: number;
  stats: OverviewColumn;
  /** Not set while it loads. */
  dateCounts: ResultOf<'dateCounts'> | undefined;
  grain: Grain;
  card: Card;
  theme: Theme;
  onChange: (patch: Partial<Card>) => void;
}

/** A date or timestamp column: the number of rows in each period, and the first and last date. */
export function DateView(props: DateViewProps) {
  const { column, stats, rowCount, dateCounts, grain, card, onChange } = props;
  const filled = dateCounts ? fillPeriods(dateCounts.buckets, grain) : undefined;
  const hasDates = stats.min !== undefined && stats.max !== undefined;

  return (
    <>
      <div className="controls">
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
      </div>
      {!hasDates ? (
        <p className="status">All rows are null.</p>
      ) : !filled ? (
        <p className="status" role="status">
          Loading…
        </p>
      ) : card.asTable ? (
        <CountTable head={`Start of the ${grain}`} rows={filled.periods.map((p) => ({ label: p.start, count: p.count }))} total={stats.nonNull} />
      ) : (
        <Chart
          label={`Rows of ${column.name} for each ${grain}, ${filled.periods.length} periods.`}
          option={barsOption(props.theme, {
            labels: filled.periods.map((p) => p.start),
            counts: filled.periods.map((p) => p.count),
            tips: filled.periods.map((p) => `${grain[0]?.toUpperCase() + grain.slice(1)} of ${p.start}\n${formatCount(p.count)} rows`),
            logScale: card.logScale,
            gap: 10,
          })}
        />
      )}
      <StatsTable
        rows={[
          ['Earliest', hasDates ? formatValue(stats.min as string) : '—'],
          ['Latest', hasDates ? formatValue(stats.max as string) : '—'],
          ['Span', hasDates ? `${formatCount(spanDays(stats.min as string, stats.max as string))} days` : '—'],
          [`Empty ${grain}s`, filled?.empty === undefined ? '—' : formatCount(filled.empty)],
          ['Nulls', `${formatCount(rowCount - stats.nonNull)} (${formatPercent(rowCount - stats.nonNull, rowCount)})`],
        ]}
      />
    </>
  );
}

/** A column of a type that has no chart, such as array, map or struct: the type and the percent of nulls. */
export function ComplexView({ column, rowCount, stats }: { column: ColumnInfo; rowCount: number; stats: OverviewColumn }) {
  return (
    <>
      <StatsTable
        rows={[
          ['Type', <code key="type">{column.typeText}</code>],
          ['Nulls', `${formatCount(rowCount - stats.nonNull)} (${formatPercent(rowCount - stats.nonNull, rowCount)})`],
        ]}
      />
      <p className="status">This version shows no chart for this type.</p>
    </>
  );
}
