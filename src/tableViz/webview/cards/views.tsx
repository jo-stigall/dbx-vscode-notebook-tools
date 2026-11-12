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
import { chipForBins, chipForPeriods, chipForValue, fillPeriods, frequencyRows, histogramBars, spanDays, type FrequencyRow } from '../../core/derive.ts';
import { isNumeric, typeFamily } from '../../core/kinds.ts';
import type { BinEdges, Card, Chip, ColumnInfo, Grain, OverviewColumn, ResultOf } from '../../core/schema.ts';
import { Chart } from '../Chart.tsx';
import { StatTiles, type Tile } from './CardShell.tsx';
import { formatCount, formatNumber, formatPercent, formatStat, formatValue } from '../format.ts';
import { barsOption } from '../options.ts';
import type { Theme } from '../theme.ts';

/** The height of the chart in the detailed view of a column, in pixels. */
export const DETAIL_HEIGHT = 380;

/** A chart with this number of bars or fewer has a label on each bar in the detailed view. */
const MAX_LABELLED_BARS = 40;

/**
 * The parts of a card in their places.
 *
 * In a small card, the parts are below each other: controls, chart, tables.
 * In the detailed view, the large numbers are at the top, the chart is on
 * the left, and the tables are on the right.
 */
export function CardLayout(props: { detailed: boolean; tiles?: Tile[]; controls?: ReactNode; main: ReactNode; side?: ReactNode }) {
  return (
    <>
      {props.detailed && props.tiles && <StatTiles tiles={props.tiles} />}
      {props.controls}
      {/* "single": the card has no chart now, so the tables use the full width. */}
      <div className={props.main && props.side ? 'card-body' : 'card-body single'}>
        {props.main && <div className="card-main">{props.main}</div>}
        {props.side && <div className="card-side">{props.side}</div>}
      </div>
    </>
  );
}

/** A block with the size of a chart, for the time that the chart loads. The page then does not jump when the chart arrives. */
export function ChartWait({ detailed, children }: { detailed: boolean; children: ReactNode }) {
  return (
    <div className={`skeleton chart-wait${detailed ? ' tall' : ''}`} role="status">
      {children}
    </div>
  );
}

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

/** A button in a table row that adds a filter chip for that row. It does with the keyboard what a click on a bar does. */
export function RowFilter({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="icon-button row-filter" title="Filter the dataset to this row" aria-label={`Filter the dataset to ${label}`} onClick={onClick}>
      <span className="codicon codicon-filter" aria-hidden="true" />
    </button>
  );
}

/**
 * A table of counts: one row for each bar of a chart.
 *
 * @param onRow  If set, each row has a filter button. The function gets the position of the row. Return false from `canFilter` for a row that has no button.
 */
function CountTable({ head, rows, total, onRow, canFilter }: { head: string; rows: { label: string; count: number }[]; total: number; onRow?: (index: number) => void; canFilter?: (index: number) => boolean }) {
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
              <td>
                {onRow && (canFilter?.(i) ?? true) && <RowFilter label={row.label} onClick={() => onRow(i)} />}
                {row.label}
              </td>
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
  /** The user selected bins of the histogram. The board adds the chip to the dataset. */
  onFilter?: (chip: Chip) => void;
  /** The number of different values, from the overview. The detailed view shows it. */
  distinct?: number;
}

/**
 * A number column with many values: a histogram and a table of statistics.
 *
 * In the detailed view, the histogram has an axis of numbers, a line at the
 * mean and a line at the median, and a count on each bar.
 */
export function ContinuousView(props: ContinuousViewProps) {
  const { column, stats, histogram, edges, card, onChange } = props;
  const detailed = card.expanded === true;
  const approx = stats.approximate ? '≈ ' : '';
  const median = stats.percentiles.find((p) => p.p === 0.5)?.value;
  const nulls = stats.rowCount - stats.nonNull;
  const bars = histogram && edges ? histogramBars(histogram, edges) : undefined;
  const label = (bar: { role: string; from?: number; to?: number }) =>
    bar.role === 'below' ? `Below ${formatNumber(bar.to as number)}` : bar.role === 'above' ? `Above ${formatNumber(bar.from as number)}` : `${formatNumber(bar.from as number)} to ${formatNumber(bar.to as number)}`;

  /** Make a chip from the selected bars. The bars "below" and "above" are not bins, so they cannot be selected. */
  const select = (first: number, last: number) => {
    if (!bars || !edges || !props.onFilter) return;
    const offset = bars[0]?.role === 'below' ? 1 : 0;
    const from = Math.max(0, first - offset);
    const to = Math.min(edges.bins - 1, last - offset);
    if (to < from) return;
    props.onFilter(chipForBins({ name: column.name, typeText: column.typeText }, edges, from, to));
  };
  const onSelect = props.onFilter ? select : undefined;

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

  // The detailed view: an axis of numbers below the bars, and lines for the mean and the median.
  // The bars "below" and "above" are one bin wide each, so the axis starts and ends one bin further.
  const width = edges ? (edges.hi - edges.lo) / edges.bins : 0;
  const lo = edges && bars?.[0]?.role === 'below' ? edges.lo - width : edges?.lo;
  const hi = edges && bars?.[bars.length - 1]?.role === 'above' ? edges.hi + width : edges?.hi;
  const inRange = (value: number | undefined): value is number => value !== undefined && lo !== undefined && hi !== undefined && value >= lo && value <= hi;
  const detail =
    detailed && bars && lo !== undefined && hi !== undefined
      ? {
          categoryName: column.name,
          countName: 'Rows',
          barLabels: bars.length <= MAX_LABELLED_BARS ? bars.map((b) => (b.count > 0 ? formatCount(b.count) : '')) : undefined,
          numeric: {
            lo,
            hi,
            markers: [
              ...(inRange(stats.mean) ? [{ value: stats.mean, label: `Mean ${formatNumber(stats.mean)}` }] : []),
              ...(inRange(median) ? [{ value: median, label: `Median ${formatNumber(median)}` }] : []),
            ],
          },
        }
      : undefined;

  const tiles: Tile[] = [
    { label: 'Count', value: formatCount(stats.nonNull) },
    { label: 'Nulls', value: formatCount(nulls), note: formatPercent(nulls, stats.rowCount) },
    ...(props.distinct !== undefined ? [{ label: 'Distinct', value: formatCount(props.distinct) }] : []),
    { label: 'Mean', value: stats.mean === undefined ? '—' : formatNumber(stats.mean) },
    { label: 'Median', value: median === undefined ? '—' : approx + formatNumber(median) },
    { label: 'Std. deviation', value: stats.stddev === undefined ? '—' : formatNumber(stats.stddev) },
    { label: 'Min', value: stats.min === undefined ? '—' : formatValue(stats.min) },
    { label: 'Max', value: stats.max === undefined ? '—' : formatValue(stats.max) },
  ];

  return (
    <CardLayout
      detailed={detailed}
      tiles={tiles}
      controls={
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
      }
      main={
        stats.nonNull === 0 ? (
          <p className="status">All rows are null.</p>
        ) : !bars ? (
          <ChartWait detailed={detailed}>Loading the histogram…</ChartWait>
        ) : card.asTable ? (
          <CountTable head="Range" rows={bars.map((b) => ({ label: label(b), count: b.count }))} total={stats.nonNull} onRow={onSelect && ((i) => select(i, i))} canFilter={(i) => bars[i]?.role === 'bin'} />
        ) : (
          <Chart
            onSelect={onSelect}
            range
            height={detailed ? DETAIL_HEIGHT : undefined}
            label={`Histogram of ${column.name} with ${bars.length} bars.`}
            option={barsOption(props.theme, {
              labels: bars.map((b) => (b.role === 'below' ? 'below' : b.role === 'above' ? 'above' : formatNumber(b.from as number))),
              counts: bars.map((b) => b.count),
              tips: bars.map((b) => `${label(b)}\n${formatCount(b.count)} rows (${formatPercent(b.count, stats.nonNull)})`),
              logScale: card.logScale,
              gap: 4,
              detail,
            })}
          />
        )
      }
      side={<StatsTable rows={rows} />}
    />
  );
}

/** The table of values: value, count, percent and cumulative percent. If `onRow` is set, each value row and the null row has a filter button. */
function FrequencyTable({ rows, total, onRow }: { rows: FrequencyRow[]; total: number; onRow?: (row: FrequencyRow) => void }) {
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
              <td>
                {onRow && row.role !== 'other' && <RowFilter label={row.label} onClick={() => onRow(row)} />}
                {row.label}
              </td>
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
  /** The user selected a value. The board adds the chip to the dataset. */
  onFilter?: (chip: Chip) => void;
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
  const filter = (row: FrequencyRow | undefined) => {
    const chip = row && chipForValue({ name: column.name, typeText: column.typeText }, row.role, row.label);
    if (chip) props.onFilter?.(chip);
  };

  const detailed = card.expanded === true;
  const top = frequency.values[0];
  const tiles: Tile[] = [
    { label: 'Rows', value: formatCount(frequency.rowCount) },
    { label: 'Distinct values', value: formatCount(props.distinct ?? frequency.values.length) },
    { label: 'Nulls', value: formatCount(frequency.nulls), note: formatPercent(frequency.nulls, frequency.rowCount) },
    ...(top ? [{ label: 'Most frequent', value: top.value, note: formatPercent(top.count, frequency.rowCount) }] : []),
  ];
  // A horizontal chart needs space for the label of each bar. The detailed view gives each bar more space.
  const height = kind === 'category' ? Math.max(detailed ? 200 : 120, (detailed ? 70 : 40) + chartRows.length * (detailed ? 28 : 20)) : detailed ? DETAIL_HEIGHT : undefined;

  return (
    <CardLayout
      detailed={detailed}
      tiles={tiles}
      controls={
        kind === 'category' && (
          <div className="controls">
            <label>
              Sort by{' '}
              <select value={sortBy} onChange={(e) => onChange({ sortBy: e.target.value as 'count' | 'label' })}>
                <option value="count">Count</option>
                <option value="label">Label</option>
              </select>
            </label>
          </div>
        )
      }
      main={
        !card.asTable && (
          <Chart
            onSelect={props.onFilter && ((i) => filter(chartRows[i]))}
            horizontal={kind === 'category'}
            label={`${kind === 'discrete' ? 'Rows for each value' : 'Most frequent values'} of ${column.name}, ${chartRows.length} bars.`}
            option={barsOption(props.theme, {
              labels: chartRows.map((r) => r.label),
              counts: chartRows.map((r) => r.count),
              tips: chartRows.map((r) => `${r.label}\n${formatCount(r.count)} rows (${formatPercent(r.count, frequency.rowCount)})`),
              horizontal: kind === 'category',
              detail: detailed
                ? {
                    categoryName: column.name,
                    countName: 'Rows',
                    barLabels: chartRows.length <= MAX_LABELLED_BARS ? chartRows.map((r) => `${formatCount(r.count)} (${formatPercent(r.count, frequency.rowCount)})`) : undefined,
                  }
                : undefined,
            })}
            height={height}
          />
        )
      }
      side={
        <>
          <div className="controls">
            <input type="search" placeholder="Search values" aria-label="Search values" value={search} onChange={(e) => setSearch(e.target.value)} />
            {hidden > 0 && (
              <span className="count">
                The table shows the {formatCount(frequency.values.length)} most frequent of {formatCount(props.distinct as number)} values.
              </span>
            )}
          </div>
          <FrequencyTable rows={tableRows} total={frequency.rowCount} onRow={props.onFilter && filter} />
        </>
      }
    />
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
  /** The user selected a value or a range of lengths. The board adds the chip to the dataset. */
  onFilter?: (chip: Chip) => void;
}

/** A column where almost every row has a different value: statistics, the values that repeat, and the lengths of the values. */
export function IdentifierView(props: IdentifierViewProps) {
  const { column, stats, rowCount, frequency, lengths, lengthEdges } = props;
  const distinct = stats.distinct ?? 0;
  const repeated = frequency?.values.filter((v) => v.count > 1) ?? [];
  const bars = lengths && lengthEdges ? histogramBars(lengths, lengthEdges) : undefined;
  // The length of a value is a whole number. Show "6" for a bin that holds one length, and "6 to 8" for a wider bin.
  const lengthLabel = (from: number, to: number) => (to - from <= 1 ? String(Math.floor(from)) : `${Math.floor(from)} to ${Math.ceil(to) - 1}`);
  const ref = { name: column.name, typeText: column.typeText };
  const { onFilter } = props;
  const selectLengths = onFilter && lengthEdges ? (first: number, last: number) => onFilter(chipForBins(ref, lengthEdges, first, last, 'length')) : undefined;

  const detailed = props.card.expanded === true;
  const nulls = rowCount - stats.nonNull;
  const tiles: Tile[] = [
    { label: 'Rows', value: formatCount(rowCount) },
    { label: 'Distinct values', value: (props.approximate ? '≈ ' : '') + formatCount(distinct) },
    { label: 'Percent unique', value: formatPercent(Math.min(distinct, stats.nonNull), stats.nonNull) },
    { label: 'Nulls', value: formatCount(nulls), note: formatPercent(nulls, rowCount) },
  ];

  return (
    <CardLayout
      detailed={detailed}
      tiles={tiles}
      main={
        <>
          <h3>Length of the values</h3>
          {!bars ? (
            <ChartWait detailed={detailed}>Loading…</ChartWait>
          ) : props.card.asTable ? (
            <CountTable head="Characters" rows={bars.map((b) => ({ label: lengthLabel(b.from as number, b.to as number), count: b.count }))} total={stats.nonNull} onRow={selectLengths && ((i) => selectLengths(i, i))} />
          ) : (
            <Chart
              onSelect={selectLengths}
              range
              height={detailed ? DETAIL_HEIGHT - 60 : undefined}
              label={`Histogram of the number of characters in the values of ${column.name}.`}
              option={barsOption(props.theme, {
                labels: bars.map((b) => lengthLabel(b.from as number, b.to as number)),
                counts: bars.map((b) => b.count),
                tips: bars.map((b) => `${lengthLabel(b.from as number, b.to as number)} characters\n${formatCount(b.count)} rows`),
                gap: 4,
                detail: detailed
                  ? { categoryName: 'Number of characters', countName: 'Rows', barLabels: bars.length <= MAX_LABELLED_BARS ? bars.map((b) => (b.count > 0 ? formatCount(b.count) : '')) : undefined }
                  : undefined,
              })}
            />
          )}
        </>
      }
      side={
        <>
          <StatsTable
            rows={[
              ['Distinct values', (props.approximate ? '≈ ' : '') + formatCount(distinct)],
              ['Percent unique', formatPercent(Math.min(distinct, stats.nonNull), stats.nonNull)],
              ['Nulls', `${formatCount(nulls)} (${formatPercent(nulls, rowCount)})`],
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
            <CountTable head="Value" rows={repeated.map((v) => ({ label: v.value, count: v.count }))} total={rowCount} onRow={onFilter && ((i) => onFilter({ op: 'eq', column: ref, value: (repeated[i] as { value: string }).value }))} />
          )}
        </>
      }
    />
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
  /** The user selected periods. The board adds the chip to the dataset. */
  onFilter?: (chip: Chip) => void;
}

/** A date or timestamp column: the number of rows in each period, and the first and last date. */
export function DateView(props: DateViewProps) {
  const { column, stats, rowCount, dateCounts, grain, card, onChange } = props;
  const filled = dateCounts ? fillPeriods(dateCounts.buckets, grain) : undefined;
  const hasDates = stats.min !== undefined && stats.max !== undefined;
  const { onFilter } = props;
  const select =
    onFilter && filled
      ? (first: number, last: number) => {
          const from = filled.periods[Math.max(0, first)];
          const to = filled.periods[Math.min(filled.periods.length - 1, last)];
          if (from && to) onFilter(chipForPeriods({ name: column.name, typeText: column.typeText }, from.start, to.start, grain));
        }
      : undefined;

  const detailed = card.expanded === true;
  const nulls = rowCount - stats.nonNull;
  const earliest = hasDates ? formatValue(stats.min as string) : '—';
  const latest = hasDates ? formatValue(stats.max as string) : '—';
  const span = hasDates ? `${formatCount(spanDays(stats.min as string, stats.max as string))} days` : '—';
  const empty = filled?.empty === undefined ? '—' : formatCount(filled.empty);
  const tiles: Tile[] = [
    { label: 'Earliest', value: earliest },
    { label: 'Latest', value: latest },
    { label: 'Span', value: span },
    { label: `Empty ${grain}s`, value: empty },
    { label: 'Nulls', value: formatCount(nulls), note: formatPercent(nulls, rowCount) },
  ];

  return (
    <CardLayout
      detailed={detailed}
      tiles={tiles}
      controls={
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
      }
      main={
        !hasDates ? (
          <p className="status">All rows are null.</p>
        ) : !filled ? (
          <ChartWait detailed={detailed}>Loading…</ChartWait>
        ) : card.asTable ? (
          <CountTable head={`Start of the ${grain}`} rows={filled.periods.map((p) => ({ label: p.start, count: p.count }))} total={stats.nonNull} onRow={select && ((i) => select(i, i))} />
        ) : (
          <Chart
            onSelect={select}
            range
            height={detailed ? DETAIL_HEIGHT : undefined}
            label={`Rows of ${column.name} for each ${grain}, ${filled.periods.length} periods.`}
            option={barsOption(props.theme, {
              labels: filled.periods.map((p) => p.start),
              counts: filled.periods.map((p) => p.count),
              tips: filled.periods.map((p) => `${grain[0]?.toUpperCase() + grain.slice(1)} of ${p.start}\n${formatCount(p.count)} rows`),
              logScale: card.logScale,
              gap: 10,
              detail: detailed
                ? {
                    categoryName: `${column.name} (start of the ${grain})`,
                    countName: 'Rows',
                    barLabels: filled.periods.length <= MAX_LABELLED_BARS ? filled.periods.map((p) => (p.count > 0 ? formatCount(p.count) : '')) : undefined,
                  }
                : undefined,
            })}
          />
        )
      }
      side={
        <StatsTable
          rows={[
            ['Earliest', earliest],
            ['Latest', latest],
            ['Span', span],
            [`Empty ${grain}s`, empty],
            ['Nulls', `${formatCount(nulls)} (${formatPercent(nulls, rowCount)})`],
          ]}
        />
      }
    />
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
