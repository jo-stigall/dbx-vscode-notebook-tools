/**
 * Turn results into the rows that the cards show: frequency tables, bars and date periods.
 *
 * The functions in this file compute nothing from the table. They only
 * arrange numbers that a result already contains.
 */
import { binBounds, formatDay } from './bins.ts';
import { typeFamily, type TypeFamily } from './kinds.ts';
import type { BinEdges, Card, ColumnKind, Grain, ResultOf } from './schema.ts';

/** One row of a frequency table. */
export interface FrequencyRow {
  /** The text that the table shows: the value, "(null)" or "Other". */
  label: string;
  /** What the row is: one value of the column, all null rows, or all values that the list does not show. */
  role: 'value' | 'null' | 'other';
  count: number;
  /** The count as a part of all rows, from 0 to 1. */
  share: number;
  /** The share of this row plus all rows before it. Not set for the "null" and "other" rows. */
  cumulative?: number;
}

/**
 * Make the rows of a frequency table from a "frequency" result.
 *
 * The value rows come first, then "Other" (all values that are not in the
 * list), then "(null)". The function leaves out "Other" and "(null)" if
 * their count is 0.
 *
 * @example
 * // 100 rows: 60 'web', 30 'store', 4 'phone', 1 'fax', 5 null. The result has the top 2 values.
 * frequencyRows(result, { sortBy: 'count' })
 * // [
 * //   { label: 'web',    role: 'value', count: 60, share: 0.60, cumulative: 0.60 },
 * //   { label: 'store',  role: 'value', count: 30, share: 0.30, cumulative: 0.90 },
 * //   { label: 'Other',  role: 'other', count: 5,  share: 0.05 },
 * //   { label: '(null)', role: 'null',  count: 5,  share: 0.05 },
 * // ]
 *
 * @param options.limit  Use only the first `limit` values of the result. The rest goes into "Other".
 * @param options.sortBy  'count': most frequent first. 'label': in the sequence of the values. Numbers sort as numbers.
 * @param options.numeric  true if the values are numbers. Used with `sortBy: 'label'`.
 */
export function frequencyRows(
  result: ResultOf<'frequency'>,
  options: { limit?: number; sortBy?: 'count' | 'label'; numeric?: boolean } = {}
): FrequencyRow[] {
  const total = result.rowCount;
  const share = (count: number) => (total === 0 ? 0 : count / total);
  const values = result.values.slice(0, options.limit ?? result.values.length);
  if (options.sortBy === 'label') {
    values.sort((a, b) => (options.numeric ? Number(a.value) - Number(b.value) : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  }
  let running = 0;
  const rows: FrequencyRow[] = values.map((v) => {
    running += v.count;
    return { label: v.value, role: 'value', count: v.count, share: share(v.count), cumulative: share(running) };
  });
  const other = total - result.nulls - running;
  if (other > 0) rows.push({ label: 'Other', role: 'other', count: other, share: share(other) });
  if (result.nulls > 0) rows.push({ label: '(null)', role: 'null', count: result.nulls, share: share(result.nulls) });
  return rows;
}

/** One bar of a histogram. */
export interface HistogramBar {
  /** 'bin' for a bin of the range. 'below' and 'above' hold the values outside the range. */
  role: 'bin' | 'below' | 'above';
  /** The start of the bin. For 'below': not set. */
  from?: number;
  /** The end of the bin. For 'above': not set. */
  to?: number;
  count: number;
}

/**
 * Make the bars of a histogram from a "histogram" result.
 *
 * The "below" bar comes first and the "above" bar comes last. The function
 * leaves them out if their count is 0.
 *
 * @example
 * histogramBars({ counts: [5, 9], below: 0, above: 2, ... }, { lo: 0, hi: 10, bins: 2 })
 * // [
 * //   { role: 'bin', from: 0, to: 5, count: 5 },
 * //   { role: 'bin', from: 5, to: 10, count: 9 },
 * //   { role: 'above', from: 10, count: 2 },
 * // ]
 */
export function histogramBars(result: ResultOf<'histogram'>, edges: BinEdges): HistogramBar[] {
  const bars: HistogramBar[] = [];
  if (result.below > 0) bars.push({ role: 'below', to: edges.lo, count: result.below });
  result.counts.forEach((count, i) => {
    const [from, to] = binBounds(edges, i);
    bars.push({ role: 'bin', from, to, count });
  });
  if (result.above > 0) bars.push({ role: 'above', from: edges.hi, count: result.above });
  return bars;
}

const DAY_MS = 86_400_000;
const dayOf = (iso: string) => Math.round(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY_MS);

/** Get the first day of the period after the period that starts on `day`. */
function nextPeriod(day: number, grain: Grain): number {
  if (grain === 'day') return day + 1;
  if (grain === 'week') return day + 7;
  const d = new Date(day * DAY_MS);
  const next = grain === 'month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) : Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  return Math.round(next / DAY_MS);
}

/** The largest number of periods that fillPeriods() makes. A day chart of 30 years has about 11,000 periods. */
export const MAX_PERIODS = 20_000;

/**
 * Add the periods that have no rows to the buckets of a "dateCounts" result.
 *
 * A "dateCounts" result contains only the periods that have rows. A chart
 * needs all periods from the first to the last, so that a gap in the data
 * shows as a gap in the chart.
 *
 * @example
 * fillPeriods([{ start: '2026-01-01', count: 4 }, { start: '2026-03-01', count: 7 }], 'month')
 * // {
 * //   periods: [{ start: '2026-01-01', count: 4 }, { start: '2026-02-01', count: 0 }, { start: '2026-03-01', count: 7 }],
 * //   empty: 1,
 * // }
 *
 * @returns `periods`: all periods, oldest first. `empty`: the number of periods with no rows. If there are more than
 * MAX_PERIODS periods, the function returns the buckets without a change and `empty` is not set.
 */
export function fillPeriods(
  buckets: { start: string; count: number }[],
  grain: Grain
): { periods: { start: string; count: number }[]; empty: number | undefined } {
  if (buckets.length === 0) return { periods: [], empty: 0 };
  const counts = new Map(buckets.map((b) => [dayOf(b.start), b.count]));
  const first = dayOf((buckets[0] as { start: string }).start);
  const last = dayOf((buckets[buckets.length - 1] as { start: string }).start);
  const periods: { start: string; count: number }[] = [];
  let empty = 0;
  for (let day = first; day <= last; day = nextPeriod(day, grain)) {
    if (periods.length >= MAX_PERIODS) return { periods: buckets, empty: undefined };
    const count = counts.get(day) ?? 0;
    if (count === 0) empty++;
    periods.push({ start: formatDay(day), count });
  }
  return { periods, empty };
}

/**
 * Get the number of days from the first date to the last date.
 *
 * @example
 * spanDays('2026-01-01', '2026-12-31T23:59:59.000Z')   // 364
 */
export function spanDays(min: string, max: string): number {
  return dayOf(max) - dayOf(min);
}

/**
 * The kinds that a user can select for a column of a type.
 *
 * The first kind in each list is not always the kind that detectKind()
 * selects. The list only tells which kinds make sense for the type.
 *
 * @example
 * kindsFor('int')             // ['continuous', 'discrete', 'category', 'identifier']
 * kindsFor('string')          // ['category', 'identifier']
 * kindsFor('array<string>')   // ['complex']
 */
export function kindsFor(typeText: string): ColumnKind[] {
  const byFamily: Record<TypeFamily, ColumnKind[]> = {
    integer: ['continuous', 'discrete', 'category', 'identifier'],
    decimal: ['continuous', 'discrete', 'category', 'identifier'],
    float: ['continuous', 'discrete', 'category', 'identifier'],
    string: ['category', 'identifier'],
    boolean: ['category'],
    date: ['date', 'category'],
    timestamp: ['date', 'category'],
    complex: ['complex'],
  };
  return byFamily[typeFamily(typeText)];
}

/**
 * Open the card of a column on a board.
 *
 * The new card goes first. It replaces the cards that are not pinned.
 *
 * @example
 * // 'region' is pinned, 'amount' is not. The user opens 'channel'.
 * openCard([{ column: 'amount', pinned: false }, { column: 'region', pinned: true }], 'channel')
 * // [{ column: 'channel', pinned: false }, { column: 'region', pinned: true }]
 *
 * @returns The new list of cards. The same list if the column has a card.
 */
export function openCard(cards: Card[], column: string): Card[] {
  if (cards.some((c) => c.column === column)) return cards;
  return [{ column, pinned: false }, ...cards.filter((c) => c.pinned)];
}
