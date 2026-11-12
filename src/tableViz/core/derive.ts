/**
 * Turn results into the rows that the cards show: frequency tables, bars and date periods.
 *
 * The functions in this file compute nothing from the table. They only
 * arrange numbers that a result already contains.
 *
 * The file also has other small functions for the board. They send no
 * request. They handle the list of open cards, the filter chips, the
 * question before a large scan, CSV text and file names.
 */
import { binBounds, formatDay } from './bins.ts';
import { typeFamily, type TypeFamily } from './kinds.ts';
import { datasetVersionSchema, type BinEdges, type Card, type Chip, type ColumnKind, type ColumnRef, type Dataset, type DatasetVersion, type Grain, type Measure, type ResultOf } from './schema.ts';

/** One row of a frequency table. */
export interface FrequencyRow {
  /** The text that the table shows: the value, "(null)" or "Other". */
  label: string;
  /** What the row is: one value of the column, all null rows, or all values that the list does not show. */
  role: 'value' | 'null' | 'other';
  /** The number of rows. */
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
 * @param options.sortBy  'count' (default): most frequent first. 'label': in the sequence of the values.
 * @param options.numeric  true if the values are numbers. With `sortBy: 'label'`, '9' then comes before '10'.
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

/** The number of milliseconds in one day. */
const DAY_MS = 86_400_000;

/**
 * Get the day number of a date: the number of days after 1970-01-01.
 *
 * The function reads the first 10 characters (YYYY-MM-DD) and ignores a time.
 *
 * @example
 * dayOf('2026-01-01')                 // 20454
 * dayOf('2026-01-01T23:59:59.000Z')   // 20454
 */
const dayOf = (iso: string) => Math.round(Date.parse(iso.slice(0, 10) + 'T00:00:00Z') / DAY_MS);

/**
 * Get the first day of the period after the period that starts on `day`.
 *
 * @example
 * nextPeriod(20454, 'week')    // 20461: 2026-01-01 plus 7 days
 * nextPeriod(20454, 'month')   // 20485: 2026-02-01
 * nextPeriod(20454, 'year')    // 20819: 2027-01-01
 */
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
 *
 * @param min  The first date, as ISO 8601 text. The function ignores a time.
 * @param max  The last date.
 */
export function spanDays(min: string, max: string): number {
  return dayOf(max) - dayOf(min);
}

/**
 * List the kinds that a user can select for a column of a type.
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
 * Open the detailed view of a column on a board.
 *
 * The new card goes first, as a detailed view. It replaces the cards that
 * are not pinned. If the column has a small card, that card becomes the
 * detailed view.
 *
 * @example
 * // 'region' is pinned, 'amount' is not. The user opens 'channel'.
 * openCard([{ column: 'amount', pinned: false }, { column: 'region', pinned: true }], 'channel')
 * // [{ column: 'channel', pinned: false, expanded: true }, { column: 'region', pinned: true }]
 *
 * @returns The new list of cards. The same list if the column has a detailed view.
 */
export function openCard(cards: Card[], column: string): Card[] {
  const existing = cards.find((c) => c.column === column);
  if (existing) return existing.expanded ? cards : cards.map((c) => (c === existing ? { ...c, expanded: true } : c));
  return [{ column, pinned: false, expanded: true }, ...cards.filter((c) => c.pinned)];
}

/**
 * Tell if the board must ask before it reads all rows of a dataset.
 *
 * The board asks when the table is larger than the limit and the dataset has
 * no filter and no sample. A filter or a sample makes the scan small. The
 * board does not ask if the user already chose to read all rows.
 *
 * @example
 * const limit = 100 * 1024 ** 3;   // 100 GB
 * mustAskBeforeScan(500 * 1024 ** 3, orders, limit, false)                          // true
 * mustAskBeforeScan(500 * 1024 ** 3, { ...orders, sample: { percent: 1 } }, limit, false)   // false
 * mustAskBeforeScan(undefined, orders, limit, false)                               // false: the size is not known
 *
 * @param sizeBytes  The size of the table on disk, from DESCRIBE DETAIL. Undefined for a view, or if DESCRIBE DETAIL failed.
 * @param limitBytes  The limit, from the setting `largeTableBytes`.
 * @param confirmed  true if the user clicked "Read all rows" for this dataset.
 */
export function mustAskBeforeScan(sizeBytes: number | undefined, dataset: Dataset, limitBytes: number, confirmed: boolean): boolean {
  return sizeBytes !== undefined && sizeBytes > limitBytes && !dataset.filter && !dataset.sample && !confirmed;
}

/**
 * Tell if a filter does not name a partition column of the table.
 *
 * A query with such a filter reads all partitions. The function looks for
 * the name as a full word, in upper or lower case. It does not read the SQL,
 * so a name in a string or a comment also counts.
 *
 * @example
 * missesPartition("region = 'EMEA'", ['order_date'])              // true
 * missesPartition("order_date >= '2026-01-01'", ['order_date'])   // false
 * missesPartition("region = 'EMEA'", [])                          // false: the table has no partitions
 * missesPartition("update_date > x AND date = y", ['date'])       // false: the second "date" is the column
 */
export function missesPartition(filter: string | undefined, partitionColumns: string[]): boolean {
  if (!filter?.trim() || partitionColumns.length === 0) return false;
  const text = filter.toLowerCase();
  const part = /[\p{L}\p{N}_]/u;
  return !partitionColumns.some((column) => {
    const name = column.toLowerCase();
    // The name must be a full word: "date" is not in "update_date". Look at each place where the name occurs.
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      if (!part.test(text[at - 1] ?? ' ') && !part.test(text[at + name.length] ?? ' ')) return true;
    }
    return false;
  });
}

/**
 * Put the date counts of A and B on one list of periods, for a chart with a shared axis.
 *
 * The list has each period from the first period of the two datasets to the
 * last one. A period that a dataset has no rows in gets the count 0.
 *
 * @example
 * sharedPeriods([{ start: '2026-01-01', count: 4 }], [{ start: '2026-03-01', count: 7 }], 'month')
 * // { starts: ['2026-01-01', '2026-02-01', '2026-03-01'], a: [4, 0, 0], b: [0, 0, 7] }
 */
export function sharedPeriods(
  a: { start: string; count: number }[],
  b: { start: string; count: number }[],
  grain: Grain
): { starts: string[]; a: number[]; b: number[] } {
  const countsA = new Map(a.map((bucket) => [bucket.start, bucket.count]));
  const countsB = new Map(b.map((bucket) => [bucket.start, bucket.count]));
  const all = [...new Set([...countsA.keys(), ...countsB.keys()])].sort();
  const { periods } = fillPeriods(all.map((start) => ({ start, count: 0 })), grain);
  const starts = periods.map((period) => period.start);
  return { starts, a: starts.map((start) => countsA.get(start) ?? 0), b: starts.map((start) => countsB.get(start) ?? 0) };
}

/**
 * Read the text of the "Version" box of a dataset.
 *
 * @example
 * parseVersion('')                      // undefined: the newest version
 * parseVersion('42')                    // { kind: 'version', n: '42' }
 * parseVersion('2026-11-01 02:05')      // { kind: 'timestamp', ts: '2026-11-01 02:05' }
 * parseVersion('yesterday')             // 'invalid'
 *
 * @returns The version. undefined for an empty box. 'invalid' for text that is not a version number or a date and time.
 */
export function parseVersion(text: string): DatasetVersion | undefined | 'invalid' {
  const value = text.trim();
  if (!value) return undefined;
  const parsed = datasetVersionSchema.safeParse(/^\d+$/.test(value) ? { kind: 'version', n: value } : { kind: 'timestamp', ts: value });
  return parsed.success ? parsed.data : 'invalid';
}

/**
 * Make the filter chip for a click on a bar of a value.
 *
 * @example
 * chipForValue(region, 'value', 'EMEA')    // { op: 'eq', column: region, value: 'EMEA' }
 * chipForValue(region, 'null', '(null)')   // { op: 'null', column: region }
 * chipForValue(region, 'other', 'Other')   // undefined
 *
 * @param role  What the bar is: one value, the null rows, or "Other".
 * @param label  The value of the bar, as text.
 * @returns The chip, or undefined for "Other": "all values that the chart does not show" is not one condition.
 */
export function chipForValue(column: ColumnRef, role: 'value' | 'null' | 'other', label: string): Chip | undefined {
  if (role === 'other') return undefined;
  return role === 'null' ? { op: 'null', column } : { op: 'eq', column, value: label };
}

/**
 * Make the filter chip for a click on a bin of a histogram, or a drag across some bins.
 *
 * @example
 * chipForBins(amount, { lo: 0, hi: 100, bins: 4 }, 1, 2)   // { op: 'range', column: amount, lo: 25, hi: 75 }
 * chipForBins(amount, { lo: 0, hi: 100, bins: 4 }, 3, 3)   // { op: 'range', column: amount, lo: 75, hi: 100, includeHi: true }
 *
 * @param first  The number of the first selected bin, from 0.
 * @param last  The number of the last selected bin.
 * @param measure  What the histogram measures. Omit it for the value of a number column.
 */
export function chipForBins(column: ColumnRef, edges: BinEdges, first: number, last: number, measure?: Measure): Chip {
  const from = Math.max(0, Math.min(first, last));
  const to = Math.min(edges.bins - 1, Math.max(first, last));
  const lo = binBounds(edges, from)[0];
  const hi = binBounds(edges, to)[1];
  // The last bin contains the value `hi`. See binIndex().
  return { op: 'range', column, lo, hi, ...(measure ? { measure } : {}), ...(to === edges.bins - 1 ? { includeHi: true } : {}) };
}

/**
 * Make the filter chip for a click on a period of a date chart, or a drag across some periods.
 *
 * @example
 * // The user drags from January 2026 to February 2026 on a month chart.
 * chipForPeriods(orderDate, '2026-01-01', '2026-02-01', 'month')
 * // { op: 'range', column: orderDate, measure: 'day', lo: 20454, hi: 20513 }
 * // 20454 is 2026-01-01. 20513 is 2026-03-01: the range ends before the first day of the next period.
 *
 * @param first  The start of the first selected period, as YYYY-MM-DD.
 * @param last  The start of the last selected period.
 */
export function chipForPeriods(column: ColumnRef, first: string, last: string, grain: Grain): Chip {
  const [from, to] = [dayOf(first), dayOf(last)].sort((x, y) => x - y) as [number, number];
  return { op: 'range', column, measure: 'day', lo: from, hi: nextPeriod(to, grain) };
}

/**
 * Write a filter chip for a person to read.
 *
 * @example
 * chipLabel({ op: 'eq', column: region, value: 'EMEA' })                       // 'region = EMEA'
 * chipLabel({ op: 'null', column: discount })                                  // 'discount_pct is null'
 * chipLabel({ op: 'range', column: amount, lo: 25, hi: 75 })                   // 'amount: 25 to 75'
 * chipLabel({ op: 'range', column: orderDate, measure: 'day', lo: 20454, hi: 20485 })   // 'order_date: 2026-01-01 to 2026-01-31'
 * chipLabel({ op: 'range', column: orderId, measure: 'length', lo: 8, hi: 12 })          // 'length of order_id: 8 to 12'
 */
export function chipLabel(chip: Chip): string {
  const name = chip.column.name;
  if (chip.op === 'eq') return `${name} = ${chip.value}`;
  if (chip.op === 'null') return `${name} is null`;
  const number = (x: number) => String(Number(x.toPrecision(6)));
  // A date range ends on the day before `hi`.
  if (chip.measure === 'day') return `${name}: ${formatDay(chip.lo)} to ${formatDay(chip.hi - 1)}`;
  return `${chip.measure === 'length' ? `length of ${name}` : name}: ${number(chip.lo)} to ${number(chip.hi)}`;
}

/**
 * Add a chip to a dataset. The function does not add a chip that the dataset already has.
 *
 * @example
 * const emea = { op: 'eq', column: region, value: 'EMEA' };
 * const filtered = addChip(orders, emea)   // { ...orders, chips: [emea] }
 * addChip(filtered, emea)                  // filtered: no change
 *
 * @returns A new dataset. The same dataset if it has the chip, or has 20 chips.
 */
export function addChip(dataset: Dataset, chip: Chip): Dataset {
  const chips = dataset.chips ?? [];
  const key = JSON.stringify(chip);
  if (chips.length >= 20 || chips.some((c) => JSON.stringify(c) === key)) return dataset;
  return { ...dataset, chips: [...chips, chip] };
}

/**
 * Remove the chip at a position from a dataset.
 *
 * @example
 * removeChip({ ...orders, chips: [emea, largeAmount] }, 0)   // { ...orders, chips: [largeAmount] }
 * removeChip({ ...orders, chips: [emea] }, 0)                // { ...orders, chips: undefined }
 *
 * @param index  The position of the chip in `dataset.chips`, from 0.
 * @returns A new dataset.
 */
export function removeChip(dataset: Dataset, index: number): Dataset {
  const chips = (dataset.chips ?? []).filter((_, i) => i !== index);
  return { ...dataset, chips: chips.length ? chips : undefined };
}

/**
 * Write rows of cells as CSV text.
 *
 * The function puts quotation marks around a cell that contains a comma, a
 * quotation mark or a line break. It writes each quotation mark in such a
 * cell two times. It puts an apostrophe before a cell that starts with
 * =, +, - or @. Thus a spreadsheet program does not run the cell as a
 * formula. A negative number keeps its minus sign. Each row ends with "\r\n".
 *
 * @example
 * toCsv([['Value', 'Rows'], ['web, mobile', '60,352'], ['say "hi"', '1']])
 * // 'Value,Rows\r\n"web, mobile","60,352"\r\n"say ""hi""",1\r\n'
 * toCsv([['=SUM(A1:A9)', '-12.5', '-n/a']])
 * // "'=SUM(A1:A9),-12.5,'-n/a\r\n"
 */
export function toCsv(rows: string[][]): string {
  const cell = (text: string) => {
    const safe = /^[=+@]/.test(text) || (/^-/.test(text) && !/^-[\d.,]+%?$/.test(text)) ? `'${text}` : text;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return rows.map((row) => row.map(cell).join(',') + '\r\n').join('');
}

/**
 * Make a file name from parts. The name has only letters, digits, "-", "_" and ".".
 *
 * The function changes each group of other characters to one "_", and joins
 * the parts with "_".
 *
 * @example
 * fileName(['orders 2026', 'unit/price'], 'csv')   // 'orders_2026_unit_price.csv'
 * fileName([], 'png')                              // 'table.png': the name when no part has a usable character
 */
export function fileName(parts: string[], extension: string): string {
  const base = parts
    .map((part) => part.replace(/[^\p{L}\p{N}_.-]+/gu, '_').replace(/^_+|_+$/g, ''))
    .filter(Boolean)
    .join('_');
  return `${base || 'table'}.${extension}`;
}
