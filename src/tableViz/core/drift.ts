/**
 * The drift score: one number that tells how different a column is in two datasets.
 *
 * The score exists to rank columns, so that the columns that changed most
 * come first. It is not a test of significance. With millions of rows, each
 * small difference is "significant", and that tells the user nothing.
 *
 * All functions take counts for the same list of bins or values in dataset
 * A and in dataset B. The compare code makes those lists: for a category,
 * the values of the two datasets, with null as its own value; for a number
 * or a date, 10 bins cut at the deciles of A, plus a bin for null.
 */

/** Divide each count by the sum of all counts. A list of zeros stays a list of zeros. */
function shares(counts: number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => (total === 0 ? 0 : c / total));
}

/**
 * The Jensen-Shannon distance of two lists of counts, with logarithms to base 2.
 *
 * The result is from 0 to 1. 0: the two datasets have the same shares in
 * each bin. 1: no bin has rows in the two datasets. The result is the same
 * if you swap A and B.
 *
 * @example
 * jsDistance([50, 50], [50, 50])     // 0
 * jsDistance([100, 0], [0, 100])     // 1
 * jsDistance([90, 10], [10, 90])     // 0.728...
 * jsDistance([500, 500], [5, 5])     // 0: only the shares count, not the sizes
 *
 * @param a  The counts of dataset A, one for each bin.
 * @param b  The counts of dataset B, for the same bins in the same sequence.
 * @returns The distance. 0 if one dataset has no rows: there is nothing to compare.
 */
export function jsDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`The two lists have ${a.length} and ${b.length} bins.`);
  const p = shares(a);
  const q = shares(b);
  if (p.every((x) => x === 0) || q.every((x) => x === 0)) return 0;
  // The divergence of P and Q from their mean M: 0.5 * KL(P||M) + 0.5 * KL(Q||M).
  let divergence = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = p[i] as number;
    const qi = q[i] as number;
    const m = (pi + qi) / 2;
    if (pi > 0) divergence += 0.5 * pi * Math.log2(pi / m);
    if (qi > 0) divergence += 0.5 * qi * Math.log2(qi / m);
  }
  // Rounding can give a number a little below 0 or above 1.
  return Math.sqrt(Math.min(1, Math.max(0, divergence)));
}

/** The share that psi() uses for a bin that has no rows, so that it does not divide by zero. */
export const PSI_SMOOTHING = 0.0001;

/**
 * The Population Stability Index of two lists of counts.
 *
 * Some teams work to its usual limits: below 0.1 is "no change", 0.1 to 0.25
 * is "some change", above 0.25 is "large change". A bin with no rows gets a
 * very small share (PSI_SMOOTHING), because the formula has a logarithm of
 * each share.
 *
 * @example
 * psi([50, 50], [50, 50])   // 0
 * psi([90, 10], [80, 20])   // 0.081...
 *
 * @param a  The counts of dataset A (the "expected" dataset).
 * @param b  The counts of dataset B (the "actual" dataset), for the same bins.
 * @returns The index. 0 if one dataset has no rows.
 */
export function psi(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`The two lists have ${a.length} and ${b.length} bins.`);
  const p = shares(a);
  const q = shares(b);
  if (p.every((x) => x === 0) || q.every((x) => x === 0)) return 0;
  let index = 0;
  for (let i = 0; i < p.length; i++) {
    const pi = Math.max(p[i] as number, PSI_SMOOTHING);
    const qi = Math.max(q[i] as number, PSI_SMOOTHING);
    index += (qi - pi) * Math.log(qi / pi);
  }
  return index;
}

/** The drift of one column. */
export interface Drift {
  /** The Jensen-Shannon distance, from 0 to 1. The overview sorts by this number. */
  score: number;
  /** The Population Stability Index. */
  psi: number;
  /** The part of the rows that is null in A and in B, from 0 to 1. */
  nullRateA: number;
  nullRateB: number;
  /** How the bins were made, for the text below the score. */
  method: 'values' | 'deciles' | 'nulls';
  /** The names of the bins and their counts in A and B. */
  bins: { label: string; a: number; b: number }[];
}

/**
 * Compute the drift from the counts of the bins.
 *
 * @param bins  The bins or values. The null bin must be in the list, if the column has nulls.
 * @param rowsA  All rows of dataset A.
 * @param nullsA  The null rows of dataset A.
 */
export function driftOf(method: Drift['method'], bins: Drift['bins'], rowsA: number, nullsA: number, rowsB: number, nullsB: number): Drift {
  const a = bins.map((bin) => bin.a);
  const b = bins.map((bin) => bin.b);
  return {
    score: jsDistance(a, b),
    psi: psi(a, b),
    nullRateA: rowsA === 0 ? 0 : nullsA / rowsA,
    nullRateB: rowsB === 0 ? 0 : nullsB / rowsB,
    method,
    bins,
  };
}

/**
 * Make cut points from the deciles of dataset A.
 *
 * A column with few different values has the same number at more than one
 * decile. The function keeps each number one time, so some columns get
 * fewer than 10 bins.
 *
 * @example
 * uniqueCuts([1, 1, 2, 2, 2, 5, 7, 7, 9])   // [1, 2, 5, 7, 9]
 */
export function uniqueCuts(deciles: number[]): number[] {
  return [...new Set(deciles.filter((d) => Number.isFinite(d)))].sort((x, y) => x - y);
}

/** The probabilities of the nine deciles: 0.1, 0.2, ... 0.9. */
export const DECILES = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
