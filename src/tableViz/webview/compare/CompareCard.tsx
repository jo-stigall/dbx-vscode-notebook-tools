/**
 * A detail card in compare mode: it asks the host for the numbers of one column in A and in B and shows them together.
 *
 * Each request names one dataset. A request for A and a request for B run
 * at the same time, and the host keeps their answers apart.
 */
import { useEffect, useMemo, useState } from 'react';
import { chooseGrain, makeEdges } from '../../core/bins.ts';
import { comparedFrequency, type CompareKind } from '../../core/compare.ts';
import type { ColumnPair } from '../../core/match.ts';
import type { BoardSettings, Card, ColumnInfo, Dataset, OverviewColumn } from '../../core/schema.ts';
import { CardShell } from '../cards/CardShell.tsx';
import { useDebounced, useResult, type Loadable } from '../hooks.ts';
import { useTheme } from '../theme.ts';
import { ask, useAsync, type DriftState } from './useCompare.ts';
import { ContinuousCompareView, DateCompareView, DriftLine, SimpleCompareView, ValuesCompareView } from './views.tsx';

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
  card: Card;
  settings: BoardSettings;
  onChange: (patch: Partial<Card>) => void;
  onClose: () => void;
}

interface KindProps extends CompareCardProps {
  statsA: OverviewColumn;
  statsB: OverviewColumn;
  rowsA: number;
  rowsB: number;
}

const refs = (pair: ColumnPair) => ({ a: { name: pair.a.name, typeText: pair.a.typeText }, b: { name: pair.b.name, typeText: pair.b.typeText } });
const sqlOf = (...states: Loadable<{ sql: string[] }>[]) => states.flatMap((s) => (s.status === 'done' ? s.result.sql : []));
const errorOf = (...states: Loadable<unknown>[]) => states.map((s) => (s.status === 'error' ? s.error : undefined)).find((e) => e);

/** The frame of a compare card. It shows the drift below the content. */
function Frame(props: CompareCardProps & { sql: string[]; hasChart: boolean; loading: boolean; error?: ReturnType<typeof errorOf>; children?: React.ReactNode }) {
  const { pair, drift } = props;
  // The header shows the two types if they differ.
  const column: ColumnInfo = { name: pair.a.name, typeText: pair.typesDiffer ? `${pair.a.typeText} → ${pair.b.typeText}` : pair.a.typeText };
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
      error={props.error ?? (drift.status === 'error' ? drift.error : undefined)}
    >
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  const ra = statsA.status === 'done' ? statsA.result : undefined;
  const rb = statsB.status === 'done' ? statsB.result : undefined;
  // One set of bins for A and B, from the range of the two datasets together. Never bin A and B separately.
  const edges = useMemo(() => {
    if (!ra || !rb) return undefined;
    const low: number[] = [];
    const high: number[] = [];
    for (const r of [ra, rb]) {
      if (r.nonNull === 0) continue;
      const first = r.percentiles[0];
      const last = r.percentiles[r.percentiles.length - 1];
      low.push(card.clip && first ? first.value : Number(r.min));
      high.push(card.clip && last ? last.value : Number(r.max));
    }
    return low.length ? makeEdges(Math.min(...low), Math.max(...high), settled) : undefined;
  }, [ra, rb, card.clip, settled]);
  const histogramA = useResult(edges ? { type: 'histogram', dataset: a, columns: [ref.a], edges } : undefined);
  const histogramB = useResult(edges ? { type: 'histogram', dataset: b, columns: [ref.b], edges } : undefined);

  return (
    <Frame {...props} sql={sqlOf(statsA, statsB, ...(edges ? [histogramA, histogramB] : []))} hasChart loading={!ra || !rb} error={errorOf(statsA, statsB, ...(edges ? [histogramA, histogramB] : []))}>
      {ra && rb && (
        <ContinuousCompareView
          name={pair.a.name}
          statsA={ra}
          statsB={rb}
          histogramA={histogramA.status === 'done' ? histogramA.result : undefined}
          histogramB={histogramB.status === 'done' ? histogramB.result : undefined}
          edges={edges}
          bins={bins}
          card={card}
          theme={theme}
          onChange={onChange}
          onBins={setBins}
        />
      )}
    </Frame>
  );
}

function ValuesCompareCard(props: KindProps) {
  const { a, b, pair, card } = props;
  const theme = useTheme();
  const frequency = useAsync(JSON.stringify([a, b, pair.a, pair.b]), () => comparedFrequency(ask, a, b, pair, TABLE_VALUES));
  const done = frequency.status === 'done' ? frequency.value : undefined;
  return (
    <Frame {...props} sql={done ? [...done.a.sql, ...done.b.sql] : []} hasChart loading={frequency.status === 'loading'} error={frequency.status === 'error' ? frequency.error : undefined}>
      {done && <ValuesCompareView name={pair.a.name} a={done.a} b={done.b} topValues={props.settings.topValues} card={card} theme={theme} onChange={props.onChange} />}
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
  return (
    <Frame {...props} sql={sqlOf(countsA, countsB)} hasChart loading={false} error={errorOf(countsA, countsB)}>
      <DateCompareView
        name={pair.a.name}
        statsA={statsA}
        statsB={statsB}
        countsA={countsA.status === 'done' ? countsA.result : undefined}
        countsB={countsB.status === 'done' ? countsB.result : undefined}
        grain={grain}
        card={card}
        theme={theme}
        onChange={props.onChange}
      />
    </Frame>
  );
}

export function CompareCard(props: CompareCardProps) {
  const { statsA, statsB, rowsA, rowsB, drift } = props;
  if (!statsA || !statsB || rowsA === undefined || rowsB === undefined || drift.status === 'loading') {
    return <Frame {...props} sql={[]} hasChart={false} loading />;
  }
  const kindProps: KindProps = { ...props, statsA, statsB, rowsA, rowsB };
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
        <Frame {...props} sql={[]} hasChart={false} loading={false}>
          <SimpleCompareView rowsA={rowsA} rowsB={rowsB} statsA={statsA} statsB={statsB} />
        </Frame>
      );
  }
}
