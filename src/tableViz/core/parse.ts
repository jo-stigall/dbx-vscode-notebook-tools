/**
 * Convert the rows of a statement to the result of a request.
 *
 * Each function in this file is the partner of a builder in sql.ts: it
 * reads the columns that the builder asked for. The rows have the format of
 * QueryResult: each value is text or null.
 *
 * The examples in this file show the rows of a statement as a small table.
 * The first line has the column names. Each next line is one row.
 */
import type { QueryResult } from './runner.ts';
import { PERCENTILES, type OverviewColumn, type RequestOf, type ResultOf } from './schema.ts';

/**
 * A result without the fields `sql`, `approximate` and `asOf`.
 *
 * The parsers return this shape. The SQL profiler adds the three fields.
 */
type Body<T extends ResultOf<'overview'>['type'] | 'tableDetails' | 'numericStats' | 'histogram' | 'frequency' | 'dateCounts' | 'quantiles' | 'driftBins' | 'valueCounts'> = Omit<
  ResultOf<T>,
  'sql' | 'approximate' | 'asOf'
>;

/**
 * The error that a parser throws when the rows of a statement do not have the expected shape.
 *
 * This shows a defect in a builder or a parser, or a different Databricks version.
 *
 * @example
 * toCount('abc')   // throws ParseError: "abc" is not a count.
 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

/**
 * Get a function that reads a value of one row by its column name.
 *
 * @example
 * const get = reader(result, 0);
 * get('n')      // '110000'
 * get('nope')   // throws ParseError
 *
 * @param rowIndex  The number of the row, from 0.
 * @throws {ParseError}  If the result does not have this row.
 */
function reader(result: QueryResult, rowIndex: number): (name: string) => string | null {
  const row = result.rows[rowIndex];
  if (!row) throw new ParseError(`The result has no row ${rowIndex}.`);
  const index = new Map(result.columns.map((c, i) => [c.name, i]));
  return (name) => {
    const i = index.get(name);
    if (i === undefined) throw new ParseError(`The result has no column "${name}".`);
    return row[i] ?? null;
  };
}

/**
 * Read a count. A count is never null and never larger than a JavaScript number can hold exactly.
 *
 * @example
 * toCount('110000')   // 110000
 * toCount(null)       // throws ParseError
 * toCount('12.5')     // throws ParseError: the text must have digits only
 */
export function toCount(text: string | null): number {
  const n = text !== null && /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n)) throw new ParseError(`"${text}" is not a count.`);
  return n;
}

/**
 * Read a floating-point number. null, "NaN" and "Infinity" give undefined.
 *
 * @example
 * toNumber('63.0015')   // 63.0015
 * toNumber('1.0E21')    // 1e21
 * toNumber(null)        // undefined
 */
export function toNumber(text: string | null): number | undefined {
  if (text === null) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read the one row of an "overview" statement. The partner of the "overview" builder.
 *
 * The function reads the columns `c<i>_d`, `c<i>_min`, `c<i>_max` and
 * `c<i>_avg` only if the result has them. The builder leaves them out for
 * types that do not permit them.
 *
 * @example
 * // The request has one column, `amount`.
 * //   n       c0_nn   c0_d  c0_min  c0_max   c0_avg
 * //   110000  109500  8400  2.33    4999.00  63.0015
 * parseOverview(request, result)
 * // { type: 'overview', rowCount: 110000,
 * //   columns: [{ name: 'amount', nonNull: 109500, distinct: 8400, min: '2.33', max: '4999.00', mean: 63.0015 }] }
 */
export function parseOverview(request: RequestOf<'overview'>, result: QueryResult): Body<'overview'> {
  const get = reader(result, 0);
  const has = new Set(result.columns.map((c) => c.name));
  const columns = request.columns.map((ref, i): OverviewColumn => {
    const out: OverviewColumn = { name: ref.name, nonNull: toCount(get(`c${i}_nn`)) };
    if (has.has(`c${i}_d`)) out.distinct = toCount(get(`c${i}_d`));
    const min = has.has(`c${i}_min`) ? get(`c${i}_min`) : null;
    const max = has.has(`c${i}_max`) ? get(`c${i}_max`) : null;
    if (min !== null) out.min = min;
    if (max !== null) out.max = max;
    const mean = has.has(`c${i}_avg`) ? toNumber(get(`c${i}_avg`)) : undefined;
    if (mean !== undefined) out.mean = mean;
    return out;
  });
  return { type: 'overview', rowCount: toCount(get('n')), columns };
}

/**
 * Read the one row of a "numericStats" statement. The partner of the "numericStats" builder.
 *
 * @example
 * //   n       nn      zeros  negatives  min   max      mean     stddev  p0   p1   p2    p3    p4    p5     p6
 * //   110000  109500  12     0          2.33  4999.00  63.0015  41.2    4.1  9.9  31.5  49.4  80.2  140.7  212.3
 * parseNumericStats(result)
 * // { type: 'numericStats', rowCount: 110000, nonNull: 109500, zeros: 12, negatives: 0,
 * //   min: '2.33', max: '4999.00', mean: 63.0015, stddev: 41.2,
 * //   percentiles: [{ p: 0.01, value: 4.1 }, { p: 0.05, value: 9.9 }, ..., { p: 0.99, value: 212.3 }] }
 */
export function parseNumericStats(result: QueryResult): Body<'numericStats'> {
  const get = reader(result, 0);
  const out: Body<'numericStats'> = {
    type: 'numericStats',
    rowCount: toCount(get('n')),
    nonNull: toCount(get('nn')),
    // count_if gives null for a table with no rows on some versions. Read that as 0.
    zeros: toCount(get('zeros') ?? '0'),
    negatives: toCount(get('negatives') ?? '0'),
    percentiles: [],
  };
  const min = get('min');
  const max = get('max');
  if (min !== null) out.min = min;
  if (max !== null) out.max = max;
  const mean = toNumber(get('mean'));
  const stddev = toNumber(get('stddev'));
  if (mean !== undefined) out.mean = mean;
  if (stddev !== undefined) out.stddev = stddev;
  PERCENTILES.forEach((p, i) => {
    const value = toNumber(get(`p${i}`));
    if (value !== undefined) out.percentiles.push({ p, value });
  });
  return out;
}

/**
 * The partner of the "histogram" builder.
 *
 * The statement gives one row for each bucket that has rows. Bucket 0 is
 * "below the range", buckets 1 to `bins` are the bins, and bucket
 * `bins + 1` is "above the range".
 *
 * @example
 * // The request has `edges: { lo: 0, hi: 10, bins: 2 }`.
 * //   bucket  n
 * //   1       5
 * //   2       9
 * //   3       2
 * parseHistogram(request, result)   // { type: 'histogram', counts: [5, 9], below: 0, above: 2 }
 */
export function parseHistogram(request: RequestOf<'histogram'>, result: QueryResult): Body<'histogram'> {
  const { bins } = request.edges;
  const counts = new Array<number>(bins).fill(0);
  let below = 0;
  let above = 0;
  for (let i = 0; i < result.rows.length; i++) {
    const get = reader(result, i);
    const bucket = toCount(get('bucket'));
    const n = toCount(get('n'));
    if (bucket === 0) below += n;
    else if (bucket > bins) above += n;
    else counts[bucket - 1] = (counts[bucket - 1] as number) + n;
  }
  return { type: 'histogram', counts, below, above };
}

/**
 * The partner of the "frequency" builder.
 *
 * The statement gives the row of the null value first, if the column has
 * nulls, then the values, most frequent first. It asks for one row more
 * than `top`, so that `top` values remain if there is a null row.
 *
 * @example
 * // The request has `top: 2`.
 * //   value  n   total
 * //   NULL   5   100
 * //   web    60  100
 * //   store  30  100
 * parseFrequency(request, result)
 * // { type: 'frequency', rowCount: 100, nulls: 5, values: [{ value: 'web', count: 60 }, { value: 'store', count: 30 }] }
 */
export function parseFrequency(request: RequestOf<'frequency'>, result: QueryResult): Body<'frequency'> {
  let nulls = 0;
  let rowCount = 0;
  const values: { value: string; count: number }[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const get = reader(result, i);
    const value = get('value');
    const n = toCount(get('n'));
    rowCount = toCount(get('total'));
    if (value === null) nulls = n;
    else if (values.length < request.top) values.push({ value, count: n });
  }
  return { type: 'frequency', rowCount, nulls, values };
}

/**
 * Read the rows of a "dateCounts" statement: one row for each period. The partner of the "dateCounts" builder.
 *
 * @example
 * // The request has `grain: 'month'`.
 * //   start       n
 * //   2026-01-01  4
 * //   2026-03-01  7
 * parseDateCounts(request, result)
 * // { type: 'dateCounts', grain: 'month', buckets: [{ start: '2026-01-01', count: 4 }, { start: '2026-03-01', count: 7 }] }
 */
export function parseDateCounts(request: RequestOf<'dateCounts'>, result: QueryResult): Body<'dateCounts'> {
  const buckets: { start: string; count: number }[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const get = reader(result, i);
    const start = get('start');
    if (start !== null) buckets.push({ start: start.slice(0, 10), count: toCount(get('n')) });
  }
  return { type: 'dateCounts', grain: request.grain, buckets };
}

/**
 * Read the one row of a "quantiles" statement. The partner of the "quantiles" builder.
 *
 * If the column has no values, all percentiles are null and the list is empty.
 *
 * @example
 * // The request has `probabilities: [0.1, 0.5, 0.9]`.
 * //   q0   q1    q2
 * //   9.9  49.4  140.7
 * parseQuantiles(request, result)   // { type: 'quantiles', values: [9.9, 49.4, 140.7] }
 */
export function parseQuantiles(request: RequestOf<'quantiles'>, result: QueryResult): Body<'quantiles'> {
  const get = reader(result, 0);
  const values: number[] = [];
  request.probabilities.forEach((_, i) => {
    const value = toNumber(get(`q${i}`));
    if (value !== undefined) values.push(value);
  });
  return { type: 'quantiles', values: values.length === request.probabilities.length ? values : [] };
}

/**
 * Read the rows of a "driftBins" statement: one row for each bucket that has rows. The partner of the "driftBins" builder.
 *
 * Bucket -1 has the nulls. Buckets 0 to `cuts.length` are the bins.
 *
 * @example
 * // The request has `cuts: [12.5, 49.4]`, thus 3 bins.
 * //   bucket  n
 * //   -1      5
 * //   0       40
 * //   2       55
 * parseDriftBins(request, result)   // { type: 'driftBins', rowCount: 100, nulls: 5, counts: [40, 0, 55] }
 *
 * @throws {ParseError}  If a bucket number is not from -1 to `cuts.length`.
 */
export function parseDriftBins(request: RequestOf<'driftBins'>, result: QueryResult): Body<'driftBins'> {
  const counts = new Array<number>(request.cuts.length + 1).fill(0);
  let nulls = 0;
  for (let i = 0; i < result.rows.length; i++) {
    const get = reader(result, i);
    const bucket = Number(get('bucket'));
    const n = toCount(get('n'));
    if (bucket === -1) nulls += n;
    else if (Number.isInteger(bucket) && bucket >= 0 && bucket < counts.length) counts[bucket] = (counts[bucket] as number) + n;
    else throw new ParseError(`"${get('bucket')}" is not a bucket of ${counts.length} bins.`);
  }
  return { type: 'driftBins', rowCount: nulls + counts.reduce((a, b) => a + b, 0), nulls, counts };
}

/**
 * Read the rows of a "valueCounts" statement. The partner of the "valueCounts" builder.
 *
 * The result has one entry for each value of the request. A value without a row gets the count 0.
 *
 * @example
 * // The request has `values: ['fax', 'phone']`.
 * //   value  n
 * //   phone  4
 * parseValueCounts(request, result)
 * // { type: 'valueCounts', values: [{ value: 'fax', count: 0 }, { value: 'phone', count: 4 }] }
 */
export function parseValueCounts(request: RequestOf<'valueCounts'>, result: QueryResult): Body<'valueCounts'> {
  const found = new Map<string, number>();
  for (let i = 0; i < result.rows.length; i++) {
    const get = reader(result, i);
    const value = get('value');
    if (value !== null) found.set(value, toCount(get('n')));
  }
  return { type: 'valueCounts', values: request.values.map((value) => ({ value, count: found.get(value) ?? 0 })) };
}

/** The facts of a Delta table that come from SQL. parseDescribeDetail() makes them. */
export interface DeltaFacts {
  /** The storage format. Example: 'delta'. */
  format?: string;
  /** The size of the table on disk, in bytes. */
  sizeBytes?: number;
  /** The time of the last change of the table. ISO 8601. */
  lastModified?: string;
  /** The names of the partition columns. Empty if the table has no partitions. */
  partitionColumns: string[];
}

/**
 * Read a time. A time without a time zone is UTC.
 *
 * @example
 * parseUtc('2026-11-10 06:15:00')        // the same as Date.parse('2026-11-10T06:15:00Z')
 * parseUtc('2026-11-10T08:15:00+02:00')  // the same number: the text has a time zone
 * parseUtc('yesterday')                  // NaN
 *
 * @returns Milliseconds since 1970, as from Date.parse(). NaN if the text is not a time.
 */
function parseUtc(text: string): number {
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(text.trim())) return Date.parse(text);
  const utc = Date.parse(text.trim().replace(' ', 'T') + 'Z');
  return Number.isNaN(utc) ? Date.parse(text) : utc;
}

/**
 * Read the one row of `DESCRIBE DETAIL`.
 *
 * `partitionColumns` is an array. A warehouse writes it as JSON text: '["order_date"]'.
 * The function leaves out each fact that the row does not have or that it cannot read.
 *
 * `lastModified` can come without a time zone: '2026-11-10 06:15:00'. The
 * function reads such a time as UTC, because a Databricks session uses UTC
 * by default. It does not use the time zone of this computer.
 *
 * @example
 * //   format  sizeInBytes  lastModified              partitionColumns
 * //   delta   52428800     2026-11-10T06:15:00.000Z  ["order_date"]
 * parseDescribeDetail(result)
 * // { format: 'delta', sizeBytes: 52428800, lastModified: '2026-11-10T06:15:00.000Z', partitionColumns: ['order_date'] }
 * // The text '2026-11-10 06:15:00' gives the same `lastModified`.
 */
export function parseDescribeDetail(result: QueryResult): DeltaFacts {
  const get = reader(result, 0);
  const has = new Set(result.columns.map((c) => c.name));
  const facts: DeltaFacts = { partitionColumns: [] };
  if (has.has('format')) facts.format = get('format') ?? undefined;
  if (has.has('sizeInBytes')) {
    const size = toNumber(get('sizeInBytes'));
    if (size !== undefined) facts.sizeBytes = size;
  }
  if (has.has('lastModified')) {
    const text = get('lastModified');
    const time = text === null ? NaN : parseUtc(text);
    if (!Number.isNaN(time)) facts.lastModified = new Date(time).toISOString();
  }
  if (has.has('partitionColumns')) {
    try {
      const parsed: unknown = JSON.parse(get('partitionColumns') ?? '[]');
      if (Array.isArray(parsed)) facts.partitionColumns = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      // The text is not JSON. Leave the list empty.
    }
  }
  return facts;
}

/**
 * Read the newest Delta version from `DESCRIBE HISTORY ... LIMIT 1`.
 *
 * @example
 * //   version  timestamp
 * //   42       2026-11-10T06:15:00.000Z
 * parseDescribeHistory(result)   // '42'
 *
 * @returns The version number as text. undefined if the result has no row, or if the version is not a number.
 */
export function parseDescribeHistory(result: QueryResult): string | undefined {
  if (result.rows.length === 0) return undefined;
  const version = reader(result, 0)('version');
  return version !== null && /^\d+$/.test(version) ? version : undefined;
}
