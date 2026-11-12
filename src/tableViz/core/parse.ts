/**
 * Convert the rows of a statement to the result of a request.
 *
 * Each function in this file is the partner of a builder in sql.ts: it
 * reads the columns that the builder asked for. The rows have the format of
 * QueryResult: each value is text or null.
 */
import type { QueryResult } from './runner.ts';
import { PERCENTILES, type OverviewColumn, type RequestOf, type ResultOf } from './schema.ts';

/** The fields of a result that the parsers do not set. The SQL profiler adds them. */
type Body<T extends ResultOf<'overview'>['type'] | 'tableDetails' | 'numericStats' | 'histogram' | 'frequency' | 'dateCounts'> = Omit<
  ResultOf<T>,
  'sql' | 'approximate' | 'asOf'
>;

/** The rows of a statement did not have the expected shape. This shows a defect in a builder or a parser, or a different Databricks version. */
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
 */
export function toCount(text: string | null): number {
  const n = text !== null && /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isSafeInteger(n)) throw new ParseError(`"${text}" is not a count.`);
  return n;
}

/**
 * Read a floating-point number. null and "NaN" give undefined.
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

/** The partner of the "overview" builder. */
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

/** The partner of the "numericStats" builder. */
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

/** The partner of the "dateCounts" builder. */
export function parseDateCounts(request: RequestOf<'dateCounts'>, result: QueryResult): Body<'dateCounts'> {
  const buckets: { start: string; count: number }[] = [];
  for (let i = 0; i < result.rows.length; i++) {
    const get = reader(result, i);
    const start = get('start');
    if (start !== null) buckets.push({ start: start.slice(0, 10), count: toCount(get('n')) });
  }
  return { type: 'dateCounts', grain: request.grain, buckets };
}

/** The facts of a Delta table that come from SQL. */
export interface DeltaFacts {
  format?: string;
  sizeBytes?: number;
  /** ISO 8601. */
  lastModified?: string;
  partitionColumns: string[];
}

/**
 * Read the one row of `DESCRIBE DETAIL`.
 *
 * `partitionColumns` is an array. A warehouse writes it as JSON text: '["order_date"]'.
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
    const time = text === null ? NaN : Date.parse(text);
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

/** Read the newest Delta version from `DESCRIBE HISTORY ... LIMIT 1`. Returns undefined if the result has no row. */
export function parseDescribeHistory(result: QueryResult): string | undefined {
  if (result.rows.length === 0) return undefined;
  const version = reader(result, 0)('version');
  return version !== null && /^\d+$/.test(version) ? version : undefined;
}
