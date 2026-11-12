/**
 * The bins of a histogram, and the periods of a date chart.
 *
 * All code that puts a number in a bin uses the functions in this file. Thus
 * two datasets that you compare always have the same bins.
 */
import type { BinEdges, Grain } from './schema.ts';

/**
 * Make bins of equal width for the range from `lo` to `hi`.
 *
 * If all values are the same (`lo` equals `hi`), the function returns one bin
 * that contains that value. Thus no code divides by zero.
 *
 * @example
 * makeEdges(0, 100, 4)   // { lo: 0, hi: 100, bins: 4 }: the bins are 0-25, 25-50, 50-75, 75-100
 * makeEdges(7, 7, 30)    // { lo: 7, hi: 8, bins: 1 }
 *
 * @param lo  The smallest value.
 * @param hi  The largest value.
 * @param bins  The number of bins that you want, from 1 to 200.
 */
export function makeEdges(lo: number, hi: number, bins: number): BinEdges {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`Cannot make bins from ${lo} to ${hi}.`);
  if (hi < lo) [lo, hi] = [hi, lo];
  if (hi === lo) {
    // Add 1, or more if 1 is too small to change a very large number.
    const step = Math.max(1, Math.abs(lo) * 1e-9);
    return { lo, hi: lo + step, bins: 1 };
  }
  return { lo, hi, bins: Math.min(200, Math.max(1, Math.floor(bins))) };
}

/**
 * Find the bin of a value.
 *
 * A value on the border between two bins goes in the higher bin. The value
 * `hi` goes in the last bin, so that the largest value of a column is not
 * "above the range".
 *
 * @example
 * const edges = { lo: 0, hi: 100, bins: 4 };
 * binIndex(10, edges)    // 0
 * binIndex(25, edges)    // 1
 * binIndex(100, edges)   // 3: the last bin
 * binIndex(-5, edges)    // -1: below the range
 * binIndex(101, edges)   // 4: above the range
 *
 * @returns The bin number from 0 to `bins - 1`. -1 if the value is below `lo`. `bins` if the value is above `hi`.
 */
export function binIndex(value: number, edges: BinEdges): number {
  const { lo, hi, bins } = edges;
  if (value < lo) return -1;
  if (value > hi) return bins;
  const i = Math.floor(((value - lo) / (hi - lo)) * bins);
  return Math.min(bins - 1, Math.max(0, i));
}

/**
 * Get the start and the end of one bin.
 *
 * @example
 * binBounds({ lo: 0, hi: 100, bins: 4 }, 1)   // [25, 50]
 */
export function binBounds(edges: BinEdges, index: number): [number, number] {
  const width = (edges.hi - edges.lo) / edges.bins;
  return [edges.lo + index * width, index === edges.bins - 1 ? edges.hi : edges.lo + (index + 1) * width];
}

const DAY_MS = 86_400_000;

/**
 * Select the period for a date chart from the time between the first and the last date.
 *
 * | Time between the dates | Period |
 * |------------------------|--------|
 * | 92 days or less        | day    |
 * | 2 years or less        | week   |
 * | 20 years or less       | month  |
 * | more                   | year   |
 *
 * @example
 * chooseGrain('2026-01-01', '2026-12-31')   // 'week'
 *
 * @param min  The first date, as ISO 8601 text.
 * @param max  The last date, as ISO 8601 text.
 */
export function chooseGrain(min: string, max: string): Grain {
  const days = (Date.parse(max) - Date.parse(min)) / DAY_MS;
  if (!(days > 92)) return 'day';
  if (days <= 731) return 'week';
  if (days <= 7305) return 'month';
  return 'year';
}

/**
 * Get the first day of the period that contains a date. This is what `date_trunc` does in Databricks.
 *
 * A week starts on Monday.
 *
 * @example
 * truncateDay(Date.UTC(2026, 10, 12) / 86_400_000, 'month')   // the day number of 2026-11-01
 *
 * @param day  The date as a number of days after 1970-01-01.
 * @returns The first day of the period, as a number of days after 1970-01-01.
 */
export function truncateDay(day: number, grain: Grain): number {
  if (grain === 'day') return day;
  if (grain === 'week') return day - ((((day + 3) % 7) + 7) % 7); // 1970-01-01 was a Thursday
  const d = new Date(day * DAY_MS);
  const first = grain === 'month' ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) : Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.round(first / DAY_MS);
}

/**
 * Write a day number as YYYY-MM-DD.
 *
 * @example
 * formatDay(0)   // '1970-01-01'
 */
export function formatDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
