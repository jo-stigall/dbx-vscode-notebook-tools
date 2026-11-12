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

/**
 * Sends one request and returns its result.
 *
 * @example
 * const result = await ask({ type: 'frequency', dataset, columns: [{ name: 'channel', typeText: 'string' }], top: 20 });
 * result.values   // TypeScript knows that the result of a "frequency" request has `values`
 */
export type Ask = <T extends Request>(request: T) => Promise<ResultOf<T['type']>>;

/** The number of values that the drift score of a category column reads from each dataset. */
export const DRIFT_TOP = 50;

/**
 * How compare mode compares a pair of columns. compareKind() selects the kind.
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
 * The function gets the kind of each column from detectKind(), then applies
 * the first rule that matches:
 *
 * 1. The types differ and are not both numbers: 'values' if `asText` is true, 'skip' if not.
 * 2. One column is an identifier or a complex type: 'nulls'.
 * 3. The two columns are dates: 'date'.
 * 4. One column is continuous: 'continuous'.
 * 5. All other pairs: 'values'.
 *
 * @example
 * // `amount` is a double with 8,400 different values in A.
 * compareKind(amountPair, { name: 'amount', nonNull: 109500, distinct: 8400 }, { name: 'amount', nonNull: 95000, distinct: 8100 }, false)
 * // 'continuous'
 * // `order_id` is a bigint, and each row has a different value.
 * compareKind(orderIdPair, { name: 'order_id', nonNull: 110000, distinct: 110000 }, { name: 'order_id', nonNull: 95000, distinct: 95000 }, false)
 * // 'nulls'
 * // `zip` is an int in A and a string in B, so `pair.compareAs` is 'text'.
 * compareKind(zipPair, statsA, statsB, false)   // 'skip'
 * compareKind(zipPair, statsA, statsB, true)    // 'values'
 *
 * @param statsA  The overview numbers of the column in A. The function uses `distinct` and `nonNull`.
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

/** Get the column of dataset A from a pair, in the shape that a request needs: the name and the type only. */
const refA = (pair: ColumnPair): ColumnRef => ({ name: pair.a.name, typeText: pair.a.typeText });
/** Get the column of dataset B from a pair, in the shape that a request needs. */
const refB = (pair: ColumnPair): ColumnRef => ({ name: pair.b.name, typeText: pair.b.typeText });

/**
 * Get the most frequent values of a column in A and in B, with exact counts for each value in the two lists.
 *
 * The top list of A can lack a value that is in the top list of B. The count
 * of that value in A is then not known: it can be 0 or less than the last
 * count in the list. The function asks for the exact counts of such values
 * and adds them to the end of the list.
 *
 * @example
 * // A: web 60, store 30, phone 10.  B: web 50, marketplace 40, store 10.
 * const { a, b } = await comparedFrequency(ask, datasetA, datasetB, channelPair, 2);
 * // The top 2 of A are web and store. The top 2 of B are web and marketplace.
 * // The function asks A for the count of 'marketplace', and B for the count of 'store'.
 * // a.values: web 60, store 30                    'marketplace' has the count 0 in A, so the function does not add it
 * // b.values: web 50, marketplace 40, store 10
 *
 * @param ask  Sends a request. The function sends two "frequency" requests, then zero to two "valueCounts" requests.
 * @param top  The number of values to read from each dataset.
 * @returns The "frequency" results of A and B. `sql` of each result also has the "valueCounts" statement, if one ran.
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
  /** The text that the table shows: the value, "(null)" or "Other". */
  label: string;
  /** One value, all null rows, or all values that the two lists do not show. */
  role: 'value' | 'null' | 'other';
  countA: number;
  countB: number;
  /** The count as a part of all rows of the dataset, from 0 to 1. */
  shareA: number;
  shareB: number;
  /** Set if the value has rows in one dataset only. */
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

/**
 * Compute the drift of a category column from the frequency results of A and B.
 *
 * Each value of the two lists is one bin. "Other" and "(null)" are bins too.
 *
 * @example
 * // A: web 60, store 40.  B: web 50, store 38, marketplace 12.
 * frequencyDrift(a, b)
 * // { score: 0.2519..., psi: 0.8693..., nullRateA: 0, nullRateB: 0, method: 'values',
 * //   bins: [{ label: 'web', a: 60, b: 50 }, { label: 'store', a: 40, b: 38 }, { label: 'marketplace', a: 0, b: 12 }] }
 */
export function frequencyDrift(a: ResultOf<'frequency'>, b: ResultOf<'frequency'>): Drift {
  const bins = comparedValues(a, b).map((row) => ({ label: row.label, a: row.countA, b: row.countB }));
  return driftOf('values', bins, a.rowCount, a.nulls, b.rowCount, b.nulls);
}

/**
 * Write a cut point for a bin label. A cut point of a date column is a day number.
 *
 * @example
 * cutLabel(49.4321, false)   // '49.43': four significant digits
 * cutLabel(20454, true)      // '2026-01-01'
 */
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
 * If dataset A has no values in the column, there are no deciles. The
 * function then compares the nulls only, as for the kind 'nulls'.
 *
 * @example
 * // The deciles of `amount` in A are 10, 20, ... 90, so each bin of A has 100 of its 1,000 rows.
 * // B has fewer small amounts and more large amounts.
 * await columnDrift(ask, datasetA, datasetB, amountPair, 'continuous', 1000, statsA, 1000, statsB)
 * // { score: 0.1397..., psi: 0.1098..., nullRateA: 0, nullRateB: 0, method: 'deciles',
 * //   bins: [{ label: 'Below 10', a: 100, b: 50 }, { label: '10 to 20', a: 100, b: 50 }, { label: '20 to 30', a: 100, b: 100 },
 * //          ..., { label: '80 to 90', a: 100, b: 150 }, { label: '90 and above', a: 100, b: 150 }] }
 *
 * @param ask  Sends a request. See the table for the requests that each kind sends.
 * @param kind  How to compare the pair, from compareKind().
 * @param rowsA  All rows of dataset A, from the overview.
 * @param statsA  The overview numbers of the column in A. The function uses `nonNull`.
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
