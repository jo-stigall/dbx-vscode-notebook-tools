/**
 * A detail card: it asks the host for the numbers of one column and shows them.
 *
 * ColumnCard selects the kind of the column. Then one component for that
 * kind sends the requests and gives the results to a view in views.tsx.
 *
 * | Kind               | Component      | Requests                                                    |
 * |--------------------|----------------|-------------------------------------------------------------|
 * | continuous         | ContinuousCard | "numericStats", then "histogram"                            |
 * | discrete, category | ValuesCard     | "frequency"                                                 |
 * | identifier         | IdentifierCard | "frequency"; "numericStats" and "histogram" of the lengths  |
 * | date               | DateCard       | "dateCounts"                                                |
 * | complex            | (none)         | none: the card shows the overview numbers                   |
 */
import { useEffect, useMemo, useState } from 'react';
import { chooseGrain, makeEdges } from '../../core/bins.ts';
import { kindsFor } from '../../core/derive.ts';
import { detectKind } from '../../core/kinds.ts';
import type { BoardSettings, Card, Chip, ColumnInfo, ColumnKind, Dataset, OverviewColumn } from '../../core/schema.ts';
import { fresh, useDebounced, useLast, useResult, type Loadable } from '../hooks.ts';
import { useTheme } from '../theme.ts';
import { CardShell, type CardShellProps } from './CardShell.tsx';
import { ComplexView, ContinuousView, DateView, IdentifierView, ValuesView } from './views.tsx';

/** The number of values that the frequency table of a category asks for. */
const TABLE_VALUES = 200;
/** A discrete number has 50 values at most. */
const DISCRETE_VALUES = 50;
/** The number of repeated values on an identifier card. */
const REPEATED_VALUES = 20;
/** The largest number of bins in the histogram of value lengths. */
const LENGTH_BINS = 30;

/** The properties of the `ColumnCard` component. */
export interface ColumnCardProps {
  /** The dataset that the requests of the card read, with its Delta version. */
  dataset: Dataset;
  /** The column that the card shows. */
  column: ColumnInfo;
  /** The overview numbers of the column. Not set while the overview loads. */
  stats: OverviewColumn | undefined;
  /** The number of rows of the dataset. Not set while the overview loads. */
  rowCount: number | undefined;
  /** true if the distinct counts of the overview are estimates. */
  overviewApproximate: boolean;
  /** The SQL statements that gave the overview numbers of the column. Some cards show those numbers. */
  overviewSql: string[];
  /** true if the overview numbers belong to an older request while a newer request runs. */
  overviewStale?: boolean;
  /** true if the overview failed, or the user cancelled it. No new overview numbers arrive until "Refresh". */
  overviewStopped?: boolean;
  /** The settings of the card. Example: the number of bins, or the kind that the user selected. */
  card: Card;
  /** The settings of the feature. The card reads the default number of bins and the number of top values. */
  settings: BoardSettings;
  /** The user changed settings of the card. The board stores them. */
  onChange: (patch: Partial<Card>) => void;
  /** The user closed the card. */
  onClose: () => void;
  /** The user selected bars of a chart. The board adds the chip to the dataset. */
  onFilter?: (chip: Chip) => void;
}

/**
 * The properties that each kind of card gets.
 *
 * They are the properties of ColumnCard, but the overview numbers are
 * always set: ColumnCard draws a kind of card only after they arrived.
 */
interface KindProps extends ColumnCardProps {
  stats: OverviewColumn;
  rowCount: number;
  /** The properties of the frame that do not depend on the results. */
  shell: Pick<CardShellProps, 'column' | 'card' | 'kind' | 'detected' | 'kinds' | 'onChange' | 'onClose' | 'samplePercent'>;
}

/**
 * Put the states of the requests of a card together, for the frame of the card.
 *
 * @example
 * // The statistics are done and are an estimate. The histogram waits for a free place on Databricks.
 * summarize(props, [], stats, histogram)
 * // { stale: false, sql: ['SELECT ...'], approximate: true, error: undefined, cancelled: false, progress: 'queued' }
 *
 * @param first  SQL statements to put before the SQL of the results.
 * @param states  The states of the requests of the card.
 * @returns The SQL of the results that are done, the first error, whether a result is old or is an estimate, and whether the user cancelled a request.
 */
function summarize(props: KindProps, first: string[], ...states: Loadable<{ sql: string[]; approximate: boolean }, unknown>[]) {
  return {
    // The card shows the numbers of an older request while a newer request runs.
    stale: props.overviewStale === true || states.some((s) => s.status === 'done' && s.stale === true),
    sql: [...first, ...states.flatMap((s) => (s.status === 'done' ? s.result.sql : []))],
    approximate: states.some((s) => s.status === 'done' && s.result.approximate),
    error: states.map((s) => (s.status === 'error' ? s.error : undefined)).find((e) => e),
    cancelled: states.some((s) => s.status === 'cancelled'),
    // "queued" if a request waits for a free place on Databricks and no request runs.
    progress: states.some((s) => s.status === 'loading' && s.progress === 'running')
      ? ('running' as const)
      : states.some((s) => s.status === 'loading' && s.progress === 'queued')
        ? ('queued' as const)
        : undefined,
  };
}

/**
 * The card of a number column with many values: statistics and a histogram.
 *
 * The card first asks for the statistics ("numericStats"). The bins of the
 * histogram go from the smallest to the largest value, or from the 1st to
 * the 99th percentile with "Clip to 1%–99%". So the card sends the
 * "histogram" request only after the statistics arrived.
 *
 * When the user moves the "Bins" slider, the number next to the slider
 * changes at once. The card sends the new "histogram" request 300 ms after
 * the last change, and the old histogram stays on the screen, dimmed, until
 * the answer arrives. "Compute exactly" sends the "numericStats" request
 * again with `exact: true`.
 */
function ContinuousCard(props: KindProps) {
  const { dataset, column, card, settings, onChange } = props;
  const theme = useTheme();
  const ref = { name: column.name, typeText: column.typeText };
  const stats = useResult({ type: 'numericStats', dataset, columns: [ref], ...(card.exact ? { exact: true } : {}) });

  // The slider changes `bins` at once. The request uses the value 300 ms after the last change.
  const [bins, setBins] = useState(card.bins ?? settings.defaultBins);
  const settled = useDebounced(bins, 300);
  // Put the settled value in the settings of the card, so that the board stores it.
  useEffect(() => {
    if (settled !== (card.bins ?? settings.defaultBins)) onChange({ bins: settled });
  }, [settled]);

  const result = stats.status === 'done' ? stats.result : undefined;
  // The edges come from the newest statistics only. While new statistics load, the card keeps
  // the old histogram on the screen and does not ask for a histogram with the old edges.
  const current = fresh(stats);
  const edges = useMemo(() => {
    if (!current || current.nonNull === 0) return undefined;
    const first = current.percentiles[0];
    const last = current.percentiles[current.percentiles.length - 1];
    const [lo, hi] = card.clip && first && last ? [first.value, last.value] : [Number(current.min), Number(current.max)];
    return makeEdges(lo, hi, settled);
  }, [current, card.clip, settled]);
  const histogram = useResult(edges ? { type: 'histogram', dataset, columns: [ref], edges } : undefined);
  const hasRows = result !== undefined && result.nonNull > 0;

  return (
    <CardShell {...props.shell} {...summarize(props, [], stats, ...(hasRows ? [histogram] : []))} hasChart loading={stats.status === 'loading'}>
      {result && (
        <ContinuousView
          column={column}
          stats={result}
          histogram={hasRows && histogram.status === 'done' ? histogram.result : undefined}
          // The edges of the histogram that is on the screen. They can be older than the edges of the request that runs.
          edges={histogram.status === 'done' ? histogram.request.edges : edges}
          distinct={props.stats.distinct}
          bins={bins}
          card={card}
          theme={theme}
          onChange={onChange}
          onBins={setBins}
          onFilter={props.onFilter}
        />
      )}
    </CardShell>
  );
}

/**
 * The card of a column with few different values: a bar for each value and a frequency table.
 *
 * The card sends one "frequency" request: the 50 most frequent values for
 * a discrete number (all its values), or the 200 most frequent values for a
 * category. The search box and "Sort by" on the card change what the card
 * shows and send no request.
 *
 * @param props.valuesKind  'discrete': a number with 50 values at most. 'category': all other columns with few values.
 */
function ValuesCard(props: KindProps & { valuesKind: 'discrete' | 'category' }) {
  const { dataset, column, card, valuesKind } = props;
  const theme = useTheme();
  const top = valuesKind === 'discrete' ? DISCRETE_VALUES : TABLE_VALUES;
  const frequency = useResult({ type: 'frequency', dataset, columns: [{ name: column.name, typeText: column.typeText }], top });
  return (
    <CardShell {...props.shell} {...summarize(props, [], frequency)} hasChart loading={frequency.status === 'loading'}>
      {frequency.status === 'done' && (
        <ValuesView
          column={column}
          kind={valuesKind}
          frequency={frequency.result}
          distinct={props.stats.distinct}
          topValues={props.settings.topValues}
          card={card}
          theme={theme}
          onChange={props.onChange}
          onFilter={props.onFilter}
        />
      )}
    </CardShell>
  );
}

/**
 * The card of a column where almost every row has a different value, such as an ID.
 *
 * A chart of the values would have one bar for each row. The card shows
 * what helps with an ID: how many values are different, which values
 * repeat, and how long the values are.
 *
 * The card sends two requests at the start: "frequency" for the 20 most
 * frequent values, and "numericStats" with `measure: 'length'` for the
 * length of the shortest and of the longest value. When that answer
 * arrives, the card sends a "histogram" request for the lengths. "Compute exactly" sends an "overview" request
 * for this column with `exact: true`, for the exact distinct count.
 */
function IdentifierCard(props: KindProps) {
  const { dataset, column, card } = props;
  const theme = useTheme();
  const ref = { name: column.name, typeText: column.typeText };
  const frequency = useResult({ type: 'frequency', dataset, columns: [ref], top: REPEATED_VALUES });
  const lengthStats = useResult({ type: 'numericStats', dataset, columns: [ref], measure: 'length' });
  const lengthResult = fresh(lengthStats);
  const edges = useMemo(() => {
    if (!lengthResult || lengthResult.nonNull === 0) return undefined;
    // A length is a whole number. One bin for each length, if there are 30 different lengths or fewer.
    const min = Number(lengthResult.min);
    const max = Number(lengthResult.max);
    return makeEdges(min, max + 1, Math.min(LENGTH_BINS, max - min + 1));
  }, [lengthResult]);
  const lengths = useResult(edges ? { type: 'histogram', dataset, columns: [ref], edges, measure: 'length' } : undefined);
  // If the newest statistics tell that all values are null, there is no histogram. Do not show the one of an older request.
  const hasLengths = edges !== undefined || lengthResult === undefined;

  // The distinct count of the overview can be an estimate. "Compute exactly" asks for the exact count of this column.
  const exact = useResult(card.exact ? { type: 'overview', dataset, columns: [ref], exact: true } : undefined);
  const exactStats = exact.status === 'done' ? exact.result.columns[0] : undefined;
  const approximate = props.overviewApproximate && !exactStats;

  return (
    <CardShell
      {...props.shell}
      {...summarize(props, exactStats ? [] : props.overviewSql, frequency, lengthStats, ...(edges ? [lengths] : []), ...(card.exact ? [exact] : []))}
      approximate={approximate}
      hasChart
      loading={false}
    >
      <IdentifierView
        column={column}
        rowCount={props.rowCount}
        stats={exactStats ?? props.stats}
        approximate={approximate}
        frequency={frequency.status === 'done' ? frequency.result : undefined}
        lengths={hasLengths && lengths.status === 'done' ? lengths.result : undefined}
        lengthEdges={lengths.status === 'done' ? lengths.request.edges : edges}
        card={card}
        theme={theme}
        onFilter={props.onFilter}
      />
    </CardShell>
  );
}

/**
 * The card of a date or timestamp column: the number of rows in each period.
 *
 * The card sends one "dateCounts" request. The period is the one that the
 * user selected in the "Period" list. If the user selected none,
 * chooseGrain() in core/bins.ts selects it from the first and the last date
 * of the overview. A different period sends a new request. If all rows are
 * null, the card sends nothing.
 */
function DateCard(props: KindProps) {
  const { dataset, column, card, stats } = props;
  const theme = useTheme();
  const hasDates = stats.min !== undefined && stats.max !== undefined;
  const grain = card.grain ?? (hasDates ? chooseGrain(stats.min as string, stats.max as string) : 'day');
  const dateCounts = useResult(hasDates ? { type: 'dateCounts', dataset, columns: [{ name: column.name, typeText: column.typeText }], grain } : undefined);
  return (
    <CardShell {...props.shell} {...summarize(props, props.overviewSql, ...(hasDates ? [dateCounts] : []))} hasChart loading={false}>
      <DateView
        column={column}
        rowCount={props.rowCount}
        stats={stats}
        dateCounts={dateCounts.status === 'done' ? dateCounts.result : undefined}
        grain={grain}
        card={card}
        theme={theme}
        onChange={props.onChange}
        onFilter={props.onFilter}
      />
    </CardShell>
  );
}

/**
 * The detail card of one column.
 *
 * The card needs the overview numbers of the column to select its kind.
 * Until they arrive, the user sees the frame of the card with "Loading…".
 * Then the card shows the kind that the user selected in the kind list, or
 * the kind that detectKind() in core/kinds.ts selected.
 *
 * When the dataset changes, the overview numbers load again. The card keeps
 * the numbers that it had and shows them dimmed, so that it does not go
 * empty.
 *
 * @example
 * <ColumnCard dataset={pinned} column={{ name: 'amount', typeText: 'decimal(10,2)' }} stats={overview.stats.get('amount')} rowCount={overview.rowCount}
 *   overviewApproximate={overview.approximate} overviewSql={overview.sql.get('amount') ?? []} card={{ column: 'amount', pinned: false, expanded: true }}
 *   settings={settings} onChange={setCard('amount')} onClose={closeCard('amount')} onFilter={addFilter} />
 */
export function ColumnCard(props: ColumnCardProps) {
  const { column, card } = props;
  // While new overview numbers load, the card keeps the numbers that it had. The card then stays on the screen.
  const numbers = useLast(props.stats && props.rowCount !== undefined ? { stats: props.stats, rowCount: props.rowCount } : undefined);
  const stats = numbers?.stats;
  const rowCount = numbers?.rowCount;
  const overviewStale = props.overviewStale === true || (numbers !== undefined && !props.stats && !props.overviewStopped);
  const detected = stats ? detectKind(column.typeText, stats.distinct, stats.nonNull) : undefined;
  const kinds = useMemo(() => {
    const allowed = kindsFor(column.typeText);
    return detected && !allowed.includes(detected) ? [detected, ...allowed] : allowed;
  }, [column.typeText, detected]);

  if (!stats || rowCount === undefined || !detected) {
    // The overview numbers of the column are not here yet. The card needs them to select its kind.
    return (
      <CardShell
        column={column}
        card={card}
        kind="complex"
        detected="complex"
        kinds={[]}
        onChange={props.onChange}
        onClose={props.onClose}
        sql={[]}
        approximate={false}
        hasChart={false}
        loading
      />
    );
  }

  const kind: ColumnKind = card.kind && kinds.includes(card.kind) ? card.kind : detected;
  const kindProps: KindProps = {
    ...props,
    stats,
    rowCount,
    overviewStale,
    shell: { column, card, kind, detected, kinds, onChange: props.onChange, onClose: props.onClose, samplePercent: props.dataset.sample?.percent },
  };
  switch (kind) {
    case 'continuous':
      return <ContinuousCard {...kindProps} />;
    case 'discrete':
      return <ValuesCard {...kindProps} valuesKind="discrete" />;
    case 'category':
      return <ValuesCard {...kindProps} valuesKind="category" />;
    case 'identifier':
      return <IdentifierCard {...kindProps} />;
    case 'date':
      return <DateCard {...kindProps} />;
    case 'complex':
      return (
        <CardShell {...kindProps.shell} sql={props.overviewSql} approximate={false} hasChart={false} loading={false} stale={overviewStale}>
          <ComplexView column={column} rowCount={rowCount} stats={stats} />
        </CardShell>
      );
  }
}
