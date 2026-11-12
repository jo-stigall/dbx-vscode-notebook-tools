/**
 * A detail card in compare mode: it asks the host for the numbers of one column in A and in B and shows them together.
 *
 * Each request names one dataset. A request for A and a request for B run
 * at the same time, and the host keeps their answers apart.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { chooseGrain, makeEdges } from '../../core/bins.ts';
import { comparedFrequency, type CompareKind } from '../../core/compare.ts';
import type { ColumnPair } from '../../core/match.ts';
import type { BoardSettings, Card, ColumnInfo, Dataset, OverviewColumn } from '../../core/schema.ts';
import { CardShell, StatTiles, type Tile } from '../cards/CardShell.tsx';
import { formatCount, formatPercent } from '../format.ts';
import { fresh, useDebounced, useLast, useResult, type Loadable } from '../hooks.ts';
import { useTheme } from '../theme.ts';
import { ask, useAsync, type DriftState } from './useCompare.ts';
import { formatScore } from './CompareOverview.tsx';
import { ContinuousCompareView, DateCompareView, DriftLine, formatPoints, SimpleCompareView, ValuesCompareView, type ChipMaker } from './views.tsx';

/** The number of values that the frequency table of a compare card reads from each dataset. */
const TABLE_VALUES = 200;

export interface CompareCardProps {
  a: Dataset;
  b: Dataset;
  pair: ColumnPair;
  /** The overview numbers of the column in A and B. Not set while the overviews load. */
  statsA: OverviewColumn | undefined;
  statsB: OverviewColumn | undefined;
  rowsA: number | undefined;
  rowsB: number | undefined;
  drift: DriftState;
  /** true if the overview numbers belong to older datasets while newer numbers load. */
  overviewStale?: boolean;
  /** true if an overview failed or was cancelled. No new overview numbers arrive until "Refresh". */
  overviewStopped?: boolean;
  card: Card;
  settings: BoardSettings;
  onChange: (patch: Partial<Card>) => void;
  onClose: () => void;
  /** The user selected bars of a chart. The board adds the chip to dataset A and to dataset B. */
  onFilter?: (make: ChipMaker) => void;
}

interface KindProps extends CompareCardProps {
  statsA: OverviewColumn;
  statsB: OverviewColumn;
  rowsA: number;
  rowsB: number;
}

const refs = (pair: ColumnPair) => ({ a: { name: pair.a.name, typeText: pair.a.typeText }, b: { name: pair.b.name, typeText: pair.b.typeText } });
const sqlOf = (...states: Loadable<{ sql: string[] }, unknown>[]) => states.flatMap((s) => (s.status === 'done' ? s.result.sql : []));
const errorOf = (...states: Loadable<unknown, unknown>[]) => states.map((s) => (s.status === 'error' ? s.error : undefined)).find((e) => e);
const staleOf = (...states: Loadable<unknown, unknown>[]) => states.some((s) => s.status === 'done' && s.stale === true);

/**
 * Get the last results of A and B that answer the same question.
 *
 * The request for A and the request for B end at different times. When the
 * question changes (for example, the number of bins), the answer for A can
 * be new while the answer for B is old. A chart must not mix them. This
 * hook keeps the last pair that belongs together until the new pair is
 * complete.
 *
 * @param same  Tells if the request of A and the request of B ask the same question.
 */
function useMatched<T, R>(a: Loadable<T, R>, b: Loadable<T, R>, same: (x: R, y: R) => boolean): { a: T; b: T; request: R; stale: boolean } | undefined {
  const last = useRef<{ a: T; b: T; request: R } | undefined>(undefined);
  const matched = a.status === 'done' && b.status === 'done' && same(a.request, b.request);
  if (matched) last.current = { a: a.result, b: b.result, request: a.request };
  else if (a.status === 'error' || b.status === 'error' || a.status === 'cancelled' || b.status === 'cancelled') last.current = undefined;
  return last.current && { ...last.current, stale: !matched || a.stale === true || b.stale === true };
}

/** The frame of a compare card. It shows the drift below the content. */
function Frame(props: CompareCardProps & { sql: string[]; hasChart: boolean; loading: boolean; stale?: boolean; error?: ReturnType<typeof errorOf>; children?: React.ReactNode }) {
  const { pair, drift } = props;
  // The header shows the two types if they differ.
  const column: ColumnInfo = { name: pair.a.name, typeText: pair.typesDiffer ? `${pair.a.typeText} → ${pair.b.typeText}` : pair.a.typeText };
  // The detailed view starts with the answer to "how much did this column change?".
  const tiles: Tile[] | undefined =
    props.card.expanded && drift.status === 'done'
      ? [
          { label: 'Drift score', value: formatScore(drift.drift.score), note: '0 = the same, 1 = nothing in common' },
          { label: 'Population Stability Index', value: formatScore(drift.drift.psi) },
          ...(props.rowsA !== undefined && props.rowsB !== undefined
            ? [
                { label: 'Rows in A', value: formatCount(props.rowsA) },
                { label: 'Rows in B', value: formatCount(props.rowsB) },
              ]
            : []),
          { label: 'Nulls in A', value: formatPercent(Math.round(drift.drift.nullRateA * 1e6), 1e6) },
          { label: 'Nulls in B', value: formatPercent(Math.round(drift.drift.nullRateB * 1e6), 1e6), note: formatPoints(drift.drift.nullRateB - drift.drift.nullRateA) },
        ]
      : undefined;
  return (
    <CardShell
      column={column}
      card={props.card}
      kind="complex"
      detected="complex"
      kinds={[]}
      onChange={props.onChange}
      onClose={props.onClose}
      sql={props.sql}
      approximate={false}
      hasChart={props.hasChart}
      loading={props.loading}
      stale={props.stale === true || props.overviewStale === true || (drift.status === 'done' && drift.stale === true)}
      error={props.error ?? (drift.status === 'error' ? drift.error : undefined)}
    >
      {tiles && <StatTiles tiles={tiles} />}
      {props.children}
      {drift.status === 'done' && <DriftLine drift={drift.drift} />}
      {drift.status === 'skip' && <p className="status">The types of this column are different in A and B. To compare it, select "Compare as text" in the list of columns.</p>}
    </CardShell>
  );
}

function ContinuousCompareCard(props: KindProps) {
  const { a, b, pair, card, settings, onChange } = props;
  const theme = useTheme();
  const ref = refs(pair);
  const statsA = useResult({ type: 'numericStats', dataset: a, columns: [ref.a] });
  const statsB = useResult({ type: 'numericStats', dataset: b, columns: [ref.b] });
  const [bins, setBins] = useState(card.bins ?? settings.defaultBins);
  const settled = useDebounced(bins, 300);
  useEffect(() => {
    if (settled !== (card.bins ?? settings.defaultBins)) onChange({ bins: settled });
  }, [settled]);

  const ra = statsA.status === 'done' ? statsA.result : undefined;
  const rb = statsB.status === 'done' ? statsB.result : undefined;
  // One set of bins for A and B, from the range of the two datasets together. Never bin A and B separately.
  // The bins come from the newest statistics only: while new statistics load, the card keeps the old histograms.
  const freshA = fresh(statsA);
  const freshB = fresh(statsB);
  const edges = useMemo(() => {
    if (!freshA || !freshB) return undefined;
    const low: number[] = [];
    const high: number[] = [];
    for (const r of [freshA, freshB]) {
      if (r.nonNull === 0) continue;
      const first = r.percentiles[0];
      const last = r.percentiles[r.percentiles.length - 1];
      low.push(card.clip && first ? first.value : Number(r.min));
      high.push(card.clip && last ? last.value : Number(r.max));
    }
    return low.length ? makeEdges(Math.min(...low), Math.max(...high), settled) : undefined;
  }, [freshA, freshB, card.clip, settled]);
  const histogramA = useResult(edges ? { type: 'histogram', dataset: a, columns: [ref.a], edges } : undefined);
  const histogramB = useResult(edges ? { type: 'histogram', dataset: b, columns: [ref.b], edges } : undefined);
  // The histograms of A and B that have the same bins.
  const histograms = useMatched(histogramA, histogramB, (x, y) => JSON.stringify(x.edges) === JSON.stringify(y.edges));
  const hasRows = (ra?.nonNull ?? 0) > 0 || (rb?.nonNull ?? 0) > 0;

  return (
    <Frame
      {...props}
      sql={sqlOf(statsA, statsB, ...(hasRows ? [histogramA, histogramB] : []))}
      hasChart
      loading={!ra || !rb}
      stale={staleOf(statsA, statsB) || (hasRows && histograms?.stale === true)}
      error={errorOf(statsA, statsB, ...(hasRows ? [histogramA, histogramB] : []))}
    >
      {ra && rb && (
        <ContinuousCompareView
          name={pair.a.name}
          statsA={ra}
          statsB={rb}
          histogramA={hasRows ? histograms?.a : undefined}
          histogramB={hasRows ? histograms?.b : undefined}
          // The bins of the histograms that are on the screen. They can be older than the bins of the requests that run.
          edges={histograms ? histograms.request.edges : edges}
          bins={bins}
          card={card}
          theme={theme}
          onChange={onChange}
          onBins={setBins}
          onFilter={props.onFilter}
        />
      )}
    </Frame>
  );
}

function ValuesCompareCard(props: KindProps) {
  const { a, b, pair, card } = props;
  const theme = useTheme();
  const frequency = useAsync(JSON.stringify([a, b, pair.a, pair.b]), () => comparedFrequency(ask, a, b, pair, TABLE_VALUES));
  // While the values of the new datasets load, the card keeps the values that it had.
  const done = useLast(frequency.status === 'done' ? frequency.value : undefined);
  const failed = frequency.status === 'error';
  return (
    <Frame {...props} sql={done && !failed ? [...done.a.sql, ...done.b.sql] : []} hasChart loading={!done && !failed} stale={frequency.status === 'loading' && done !== undefined} error={failed ? frequency.error : undefined}>
      {done && !failed && <ValuesCompareView name={pair.a.name} a={done.a} b={done.b} topValues={props.settings.topValues} card={card} theme={theme} onChange={props.onChange} onFilter={props.onFilter} />}
    </Frame>
  );
}

function DateCompareCard(props: KindProps) {
  const { a, b, pair, card, statsA, statsB } = props;
  const theme = useTheme();
  const ref = refs(pair);
  // One period for A and B, from the first date and the last date of the two datasets together.
  const mins = [statsA.min, statsB.min].filter((x): x is string => x !== undefined).sort();
  const maxs = [statsA.max, statsB.max].filter((x): x is string => x !== undefined).sort();
  const grain = card.grain ?? (mins.length ? chooseGrain(mins[0] as string, maxs[maxs.length - 1] as string) : 'day');
  const countsA = useResult({ type: 'dateCounts', dataset: a, columns: [ref.a], grain });
  const countsB = useResult({ type: 'dateCounts', dataset: b, columns: [ref.b], grain });
  // The counts of A and B that have the same period.
  const counts = useMatched(countsA, countsB, (x, y) => x.grain === y.grain);
  return (
    <Frame {...props} sql={sqlOf(countsA, countsB)} hasChart loading={false} stale={counts?.stale} error={errorOf(countsA, countsB)}>
      <DateCompareView
        name={pair.a.name}
        statsA={statsA}
        statsB={statsB}
        countsA={counts?.a}
        countsB={counts?.b}
        // The period of the counts that are on the screen.
        shownGrain={counts ? counts.request.grain : grain}
        grain={grain}
        card={card}
        theme={theme}
        onChange={props.onChange}
        onFilter={props.onFilter}
      />
    </Frame>
  );
}

export function CompareCard(props: CompareCardProps) {
  // While new overview numbers or a new drift load, the card keeps the numbers that it had. The card then stays on the screen.
  const ready =
    props.statsA && props.statsB && props.rowsA !== undefined && props.rowsB !== undefined && props.drift.status !== 'loading'
      ? { statsA: props.statsA, statsB: props.statsB, rowsA: props.rowsA, rowsB: props.rowsB, drift: props.drift }
      : undefined;
  const numbers = useLast(ready);
  if (!numbers) return <Frame {...props} sql={[]} hasChart={false} loading />;
  const { statsA, statsB, rowsA, rowsB, drift } = numbers;
  const kindProps: KindProps = { ...props, ...numbers, overviewStale: props.overviewStale === true || (!ready && !props.overviewStopped) };
  const kind: CompareKind = drift.status === 'done' ? drift.kind : 'skip';
  switch (kind) {
    case 'continuous':
      return <ContinuousCompareCard {...kindProps} />;
    case 'values':
      return <ValuesCompareCard {...kindProps} />;
    case 'date':
      return <DateCompareCard {...kindProps} />;
    default:
      return (
        <Frame {...kindProps} sql={[]} hasChart={false} loading={false}>
          <SimpleCompareView rowsA={rowsA} rowsB={rowsB} statsA={statsA} statsB={statsB} />
        </Frame>
      );
  }
}
