/**
 * Compare one column in two datasets: which requests to send, and how to put the answers together.
 *
 * Each request names one dataset only. Thus the answer for dataset A stays
 * in the cache when the user changes dataset B, and no query for A runs
 * again. One exception: a histogram with shared bins. Its bins come from
 * the range of A and B together, so a different B can need a different
 * histogram of A.
 *
 * The functions get a function `ask` that sends a request. The webview
 * gives the function that talks to the host. A test gives a profiler.
 */
import { DECILES, driftOf, uniqueCuts, type Drift } from './drift.ts';
import { detectKind } from './kinds.ts';
import type { ColumnPair } from './match.ts';
import type { ColumnRef, Dataset, OverviewColumn, Request, ResultOf } from './schema.ts';

/** Sends one request and returns its result. */
export type Ask = <T extends Request>(request: T) => Promise<ResultOf<T['type']>>;

/** The number of values that the drift score of a category column reads from each dataset. */
export const DRIFT_TOP = 50;

/**
 * How a pair of columns is compared.
 *
 * | Kind         | The drift score uses                                        |
 * |--------------|-------------------------------------------------------------|
 * | 'values'     | the counts of the values of the two datasets                |
 * | 'continuous' | 10 bins cut at the deciles of A                             |
 * | 'date'       | 10 bins cut at the deciles of the dates of A                |
 * | 'nulls'      | only "null" and "not null": an ID or a complex type has no values to compare |
 * | 'skip'       | nothing: the types differ and the user did not ask to compare them as text |
 */
export type CompareKind = 'values' | 'continuous' | 'date' | 'nulls' | 'skip';

/**
 * Decide how to compare a pair of columns.
 *
 * @param asText  true if the user chose to compare this pair as text, although the types differ.
 */
export function compareKind(pair: ColumnPair, statsA: OverviewColumn, statsB: OverviewColumn, asText: boolean): CompareKind {
  if (pair.compareAs === 'text') return asText ? 'values' : 'skip';
  const a = detectKind(pair.a.typeText, statsA.distinct, statsA.nonNull);
  const b = detectKind(pair.b.typeText, statsB.distinct, statsB.nonNull);
  if (a === 'complex' || b === 'complex' || a === 'identifier' || b === 'identifier') return 'nulls';
  if (a === 'date' && b === 'date') return 'date';
  if (a === 'continuous' || b === 'continuous') return 'continuous';
  return 'values';
}

const refA = (pair: ColumnPair): ColumnRef => ({ name: pair.a.name, typeText: pair.a.typeText });
const refB = (pair: ColumnPair): ColumnRef => ({ name: pair.b.name, typeText: pair.b.typeText });

/**
 * Get the most frequent values of a column in A and in B, with exact counts for each value in the two lists.
 *
 * The top list of A can lack a value that is in the top list of B. The count
 * of that value in A is then not known: it can be 0 or less than the last
 * count in the list. The function asks for the exact counts of such values
 * and adds them to the end of the list.
 *
 * @param top  The number of values to read from each dataset.
 */
export async function comparedFrequency(
  ask: Ask,
  a: Dataset,
  b: Dataset,
  pair: ColumnPair,
  top: number
): Promise<{ a: ResultOf<'frequency'>; b: ResultOf<'frequency'> }> {
  const [fa, fb] = await Promise.all([
    ask({ type: 'frequency', dataset: a, columns: [refA(pair)], top }),
    ask({ type: 'frequency', dataset: b, columns: [refB(pair)], top }),
  ]);
  const complete = async (mine: ResultOf<'frequency'>, other: ResultOf<'frequency'>, dataset: Dataset, column: ColumnRef) => {
    // A list that is shorter than `top` has all values of the column. A value that is not in it has the count 0.
    if (mine.values.length < top) return mine;
    const have = new Set(mine.values.map((v) => v.value));
    const missing = other.values.map((v) => v.value).filter((value) => !have.has(value));
    if (missing.length === 0) return mine;
    const counts = await ask({ type: 'valueCounts', dataset, columns: [column], values: missing });
    return { ...mine, sql: [...mine.sql, ...counts.sql], values: [...mine.values, ...counts.values.filter((v) => v.count > 0)] };
  };
  const [completeA, completeB] = await Promise.all([complete(fa, fb, a, refA(pair)), complete(fb, fa, b, refB(pair))]);
  return { a: completeA, b: completeB };
}

/** One row of the frequency table in compare mode. */
export interface ComparedValue {
  label: string;
  /** One value, all null rows, or all values that the two lists do not show. */
  role: 'value' | 'null' | 'other';
  countA: number;
  countB: number;
  /** The count as a part of all rows of the dataset, from 0 to 1. */
  shareA: number;
  shareB: number;
  /** The value is in one dataset only. */
  onlyIn?: 'a' | 'b';
}

/**
 * Put the frequency results of A and B in one list of rows.
 *
 * The values are the union of the two lists. The function ranks them by the
 * larger of the two shares, so that a value that is frequent in one dataset
 * only is near the top. "Other" and "(null)" come last.
 *
 * @example
 * // A: web 60%, store 40%.  B: web 50%, store 38%, marketplace 12%.
 * comparedValues(a, b)
 * // web (0.60, 0.50), store (0.40, 0.38), marketplace (0, 0.12, onlyIn 'b')
 *
 * @param limit  Keep this number of values. The other values go into "Other".
 */
export function comparedValues(a: ResultOf<'frequency'>, b: ResultOf<'frequency'>, limit?: number): ComparedValue[] {
  const share = (count: number, total: number) => (total === 0 ? 0 : count / total);
  const inA = new Map(a.values.map((v) => [v.value, v.count]));
  const inB = new Map(b.values.map((v) => [v.value, v.count]));
  const all = [...new Set([...inA.keys(), ...inB.keys()])].map((label): ComparedValue => {
    const countA = inA.get(label) ?? 0;
    const countB = inB.get(label) ?? 0;
    return {
      label,
      role: 'value',
      countA,
      countB,
      shareA: share(countA, a.rowCount),
      shareB: share(countB, b.rowCount),
      ...(countA === 0 ? { onlyIn: 'b' as const } : countB === 0 ? { onlyIn: 'a' as const } : {}),
    };
  });
  // The larger share first. For the same share, the label decides, so that the sequence is the same on each run.
  all.sort((x, y) => Math.max(y.shareA, y.shareB) - Math.max(x.shareA, x.shareB) || (x.label < y.label ? -1 : 1));
  const rows = all.slice(0, limit ?? all.length);
  const shownA = rows.reduce((sum, r) => sum + r.countA, 0);
  const shownB = rows.reduce((sum, r) => sum + r.countB, 0);
  const otherA = a.rowCount - a.nulls - shownA;
  const otherB = b.rowCount - b.nulls - shownB;
  if (otherA > 0 || otherB > 0) {
    rows.push({ label: 'Other', role: 'other', countA: otherA, countB: otherB, shareA: share(otherA, a.rowCount), shareB: share(otherB, b.rowCount) });
  }
  if (a.nulls > 0 || b.nulls > 0) {
    rows.push({ label: '(null)', role: 'null', countA: a.nulls, countB: b.nulls, shareA: share(a.nulls, a.rowCount), shareB: share(b.nulls, b.rowCount) });
  }
  return rows;
}

/** The drift of a category column: over the values of the two datasets, with "Other" and null as their own values. */
export function frequencyDrift(a: ResultOf<'frequency'>, b: ResultOf<'frequency'>): Drift {
  const bins = comparedValues(a, b).map((row) => ({ label: row.label, a: row.countA, b: row.countB }));
  return driftOf('values', bins, a.rowCount, a.nulls, b.rowCount, b.nulls);
}

/** Write a cut point for a bin label. A cut point of a date column is a day number. */
function cutLabel(cut: number, isDate: boolean): string {
  if (isDate) return new Date(cut * 86_400_000).toISOString().slice(0, 10);
  return String(Number(cut.toPrecision(4)));
}

/**
 * Compute the drift of one pair of columns.
 *
 * | Kind                 | Requests                                                         |
 * |----------------------|------------------------------------------------------------------|
 * | 'values'             | "frequency" for A and B, and "valueCounts" for values that one list lacks |
 * | 'continuous', 'date' | "quantiles" for A (its deciles), then "driftBins" for A and B with those cut points |
 * | 'nulls'              | none: the overview numbers are enough                            |
 *
 * @param rowsA  All rows of dataset A, from the overview.
 * @returns The drift, or undefined for the kind 'skip'.
 */
export async function columnDrift(
  ask: Ask,
  a: Dataset,
  b: Dataset,
  pair: ColumnPair,
  kind: CompareKind,
  rowsA: number,
  statsA: OverviewColumn,
  rowsB: number,
  statsB: OverviewColumn
): Promise<Drift | undefined> {
  if (kind === 'skip') return undefined;
  const nullsA = rowsA - statsA.nonNull;
  const nullsB = rowsB - statsB.nonNull;
  const nullsOnly = () =>
    driftOf('nulls', [{ label: '(null)', a: nullsA, b: nullsB }, { label: 'Not null', a: statsA.nonNull, b: statsB.nonNull }], rowsA, nullsA, rowsB, nullsB);
  if (kind === 'nulls') return nullsOnly();

  if (kind === 'values') {
    const { a: fa, b: fb } = await comparedFrequency(ask, a, b, pair, DRIFT_TOP);
    return frequencyDrift(fa, fb);
  }

  const measure = kind === 'date' ? ('day' as const) : undefined;
  const deciles = await ask({ type: 'quantiles', dataset: a, columns: [refA(pair)], probabilities: DECILES, ...(measure ? { measure } : {}) });
  const cuts = uniqueCuts(deciles.values);
  // A has no values: there are no deciles. Compare the nulls only.
  if (cuts.length === 0) return nullsOnly();
  const [binsA, binsB] = await Promise.all([
    ask({ type: 'driftBins', dataset: a, columns: [refA(pair)], cuts, ...(measure ? { measure } : {}) }),
    ask({ type: 'driftBins', dataset: b, columns: [refB(pair)], cuts, ...(measure ? { measure } : {}) }),
  ]);
  const label = (i: number) => {
    const isDate = kind === 'date';
    if (i === 0) return `Below ${cutLabel(cuts[0] as number, isDate)}`;
    if (i === cuts.length) return `${cutLabel(cuts[i - 1] as number, isDate)} and above`;
    return `${cutLabel(cuts[i - 1] as number, isDate)} to ${cutLabel(cuts[i] as number, isDate)}`;
  };
  const bins = binsA.counts.map((count, i) => ({ label: label(i), a: count, b: binsB.counts[i] ?? 0 }));
  if (binsA.nulls > 0 || binsB.nulls > 0) bins.push({ label: '(null)', a: binsA.nulls, b: binsB.nulls });
  return driftOf('deciles', bins, binsA.rowCount, binsA.nulls, binsB.rowCount, binsB.nulls);
}
