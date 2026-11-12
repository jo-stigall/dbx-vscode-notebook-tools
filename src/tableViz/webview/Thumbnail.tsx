/**
 * The small chart in each row of the overview.
 *
 * | Kind of column       | Chart                                   |
 * |----------------------|-----------------------------------------|
 * | continuous           | A histogram with 20 bins.               |
 * | date                 | The number of rows in each period.      |
 * | category, discrete   | One bar for each of the top values.     |
 * | identifier, complex  | No chart.                               |
 *
 * The chart is plain SVG. A screen reader gets a sentence that tells the
 * same facts.
 */
import { binBounds, chooseGrain, makeEdges } from '../core/bins.ts';
import type { ColumnInfo, ColumnKind, Dataset, OverviewColumn } from '../core/schema.ts';
import { formatCount, formatNumber, formatValue } from './format.ts';
import { useResult, useSeen, type Loadable } from './hooks.ts';

const WIDTH = 132;
const HEIGHT = 28;
const HISTOGRAM_BINS = 20;
const TOP_VALUES = 8;

/** One bar of a thumbnail: its height comes from `count`, and `label` is the text that shows when you point at it. */
interface Bar {
  count: number;
  label: string;
}

/** Draw bars of equal width. The tallest bar uses the full height. */
function Bars({ bars, summary, stale }: { bars: Bar[]; summary: string; stale?: boolean }) {
  const max = Math.max(1, ...bars.map((b) => b.count));
  // A chart with few bars does not use the full width: a bar is 16 pixels wide at most.
  const step = Math.min(16, WIDTH / Math.max(bars.length, 1));
  const gap = bars.length > 40 ? 0 : 1;
  return (
    <svg className={stale ? 'thumb stale' : 'thumb'} width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={summary}>
      {bars.map((bar, i) => {
        // A bar with rows is always visible: 1 pixel high at least.
        const h = bar.count === 0 ? 0 : Math.max(1, (bar.count / max) * HEIGHT);
        return (
          <rect key={i} x={i * step} y={HEIGHT - h} width={Math.max(step - gap, 0.5)} height={h}>
            <title>{bar.label}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Show the state of a request that has no result. Returns undefined if the request is done. */
function pendingMark(state: Loadable<unknown, unknown>) {
  if (state.status === 'loading') return <span className="thumb-wait" aria-label="Loading" />;
  if (state.status === 'cancelled') return <span className="thumb-none">Cancelled</span>;
  if (state.status === 'error') {
    return (
      <span className="thumb-error" title={state.error.message}>
        No chart
      </span>
    );
  }
  return undefined;
}

function HistogramThumb({ dataset, column, stats }: { dataset: Dataset; column: ColumnInfo; stats: OverviewColumn }) {
  const edges = makeEdges(Number(stats.min), Number(stats.max), HISTOGRAM_BINS);
  const state = useResult({ type: 'histogram', dataset, columns: [{ name: column.name, typeText: column.typeText }], edges });
  if (state.status !== 'done') return pendingMark(state);
  // While a newer request runs, the bars are the answer to an older request. Their labels use the bins of that request.
  const shown = state.request.edges;
  const bars = state.result.counts.map((count, i) => {
    const [from, to] = binBounds(shown, i);
    return { count, label: `${formatNumber(from)} to ${formatNumber(to)}: ${formatCount(count)} rows` };
  });
  const summary = `Histogram of ${column.name} from ${formatValue(stats.min as string)} to ${formatValue(stats.max as string)}, ${shown.bins} bins.`;
  return <Bars bars={bars} summary={summary} stale={state.stale} />;
}

function DateThumb({ dataset, column, stats }: { dataset: Dataset; column: ColumnInfo; stats: OverviewColumn }) {
  const grain = chooseGrain(stats.min as string, stats.max as string);
  const state = useResult({ type: 'dateCounts', dataset, columns: [{ name: column.name, typeText: column.typeText }], grain });
  if (state.status !== 'done') return pendingMark(state);
  const shown = state.request.grain;
  const bars = state.result.buckets.map((b) => ({ count: b.count, label: `${shown} of ${b.start}: ${formatCount(b.count)} rows` }));
  const summary = `Rows of ${column.name} for each ${shown}, from ${formatValue(stats.min as string)} to ${formatValue(stats.max as string)}.`;
  return <Bars bars={bars} summary={summary} stale={state.stale} />;
}

function ValuesThumb({ dataset, column, kind }: { dataset: Dataset; column: ColumnInfo; kind: ColumnKind }) {
  // A discrete number has 50 values at most, and the chart shows all of them in the sequence of the values.
  const top = kind === 'discrete' ? 50 : TOP_VALUES;
  const state = useResult({ type: 'frequency', dataset, columns: [{ name: column.name, typeText: column.typeText }], top });
  if (state.status !== 'done') return pendingMark(state);
  const values = [...state.result.values];
  if (kind === 'discrete') values.sort((a, b) => Number(a.value) - Number(b.value));
  const bars = values.map((v) => ({ count: v.count, label: `${v.value}: ${formatCount(v.count)} rows` }));
  const first = state.result.values[0];
  const summary = first
    ? `${kind === 'discrete' ? 'Values' : 'Top values'} of ${column.name}. The most frequent value is ${first.value} with ${formatCount(first.count)} rows.`
    : `${column.name} has no values.`;
  return <Bars bars={bars} summary={summary} stale={state.stale} />;
}

/**
 * The thumbnail of one column.
 *
 * @param stats  The overview numbers of the column. undefined while the overview loads.
 * @param kind  The kind of the column. undefined while the overview loads.
 */
export function Thumbnail(props: { dataset: Dataset; column: ColumnInfo; stats: OverviewColumn | undefined; kind: ColumnKind | undefined }) {
  const { dataset, column, stats, kind } = props;
  const [ref, seen] = useSeen<HTMLDivElement>();

  let content;
  if (!stats || !kind || !seen) content = <span className="thumb-wait" aria-label="Loading" />;
  else if (kind === 'complex') content = <span className="thumb-none">No chart for this type</span>;
  else if (kind === 'identifier') content = <span className="thumb-none">Almost all values are different</span>;
  else if (stats.nonNull === 0) content = <span className="thumb-none">All rows are null</span>;
  else if (kind === 'continuous') content = <HistogramThumb dataset={dataset} column={column} stats={stats} />;
  else if (kind === 'date') content = <DateThumb dataset={dataset} column={column} stats={stats} />;
  else content = <ValuesThumb dataset={dataset} column={column} kind={kind} />;

  return (
    <div ref={ref} className="thumb-cell">
      {content}
    </div>
  );
}
