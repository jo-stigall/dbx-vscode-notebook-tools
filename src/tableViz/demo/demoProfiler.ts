/**
 * The demo profiler: it answers requests from the demo tables in memory.
 *
 * It needs no Databricks workspace. It is also the reference for the SQL
 * profiler: for the same data, the two profilers must give the same numbers.
 * All numbers from this profiler are exact.
 *
 * Each result contains the SQL that the SQL profiler runs for the same
 * request. The demo profiler does not run that SQL. It is there so that
 * "Show SQL" works in demo mode.
 */
import { binIndex, formatDay, truncateDay } from '../core/bins.ts';
import { isNumeric } from '../core/kinds.ts';
import { displayTableName } from '../core/names.ts';
import { CancelledError, ProfilerError, type ProfileOptions, type Profiler } from '../core/profiler.ts';
import { PERCENTILES, type Chip, type ColumnRef, type Dataset, type Measure, type OverviewColumn, type Request, type RequestOf, type Result, type ResultOf } from '../core/schema.ts';
import { buildStatements, renderStatement } from '../core/sql.ts';
import { demoTable, formatDemoValue, type DemoColumn, type DemoTable } from './data.ts';

const DAY_MS = 86_400_000;

// This folder is checked without Node.js or browser types, so declare the one global function that it uses.
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** Sampled copies of the demo tables. The key is the table name and the percent. */
const samples = new Map<string, DemoTable>();

/**
 * Make a copy of a demo table that has about `percent` percent of the rows.
 *
 * The same rows are in the sample on each run: the function decides from the
 * row number, with no random numbers.
 */
function sampleOf(table: DemoTable, percent: number): DemoTable {
  const key = `${table.name.name}:${percent}`;
  let sample = samples.get(key);
  if (!sample) {
    // Multiply the row number with a large odd number to mix its bits, then compare the last 5 digits with the percent.
    const keep = (row: number) => (Math.imul(row + 1, 2654435761) >>> 0) % 100_000 < percent * 1000;
    const rows: number[] = [];
    for (let i = 0; i < table.rowCount; i++) if (keep(i)) rows.push(i);
    sample = { ...table, rowCount: rows.length, columns: table.columns.map((c) => ({ ...c, values: rows.map((i) => c.values[i] ?? null) })) };
    samples.set(key, sample);
  }
  return sample;
}

/** Copies of the demo tables that have only the rows of some filter chips. The key is the table name, the sample and the chips. */
const filtered = new Map<string, DemoTable>();

/** Tell if a value of a column meets the condition of a chip. */
function meets(column: DemoColumn, value: DemoColumn['values'][number], chip: Chip): boolean {
  if (chip.op === 'null') return value === null;
  if (value === null) return false;
  if (chip.op === 'eq') return formatDemoValue(column, value) === chip.value;
  let x: number;
  if (chip.measure === 'length') x = formatDemoValue(column, value).length;
  else if (chip.measure === 'day') x = column.family === 'timestamp' ? Math.floor((value as number) / DAY_MS) : (value as number);
  else x = toNumber(column, value as number);
  return x >= chip.lo && (chip.includeHi ? x <= chip.hi : x < chip.hi);
}

/** Make a copy of a table that has only the rows that meet all chips. */
function chipsOf(table: DemoTable, key: string, chips: Chip[]): DemoTable {
  let result = filtered.get(key);
  if (!result) {
    const tests = chips.map((chip) => ({ chip, column: columnOf(table, chip.column) }));
    const rows: number[] = [];
    for (let i = 0; i < table.rowCount; i++) if (tests.every(({ chip, column }) => meets(column, column.values[i] ?? null, chip))) rows.push(i);
    result = { ...table, rowCount: rows.length, columns: table.columns.map((c) => ({ ...c, values: rows.map((i) => c.values[i] ?? null) })) };
    // Keep the 20 newest copies. A user who clicks many filters does not fill the memory.
    if (filtered.size >= 20) filtered.delete(filtered.keys().next().value as string);
    filtered.set(key, result);
  }
  return result;
}

/**
 * Find the demo table of a dataset. If the dataset has a sample or filter chips, the result has only those rows.
 *
 * The Demo profile cannot run SQL, so it cannot use a filter that the user
 * typed. It can use filter chips, because a chip is a column, an operator
 * and values, not SQL.
 */
function tableOf(dataset: Dataset): DemoTable {
  const table = demoTable(dataset.table);
  if (!table) {
    throw new ProfilerError(`The demo table ${displayTableName(dataset.table)} does not exist.`, {
      nextStep: 'Use demo.shop.orders_2025 or demo.shop.orders_2026.',
    });
  }
  if (dataset.filter?.trim()) {
    throw new ProfilerError('The Demo profile cannot use a filter that you type, because it cannot run SQL.', {
      nextStep: 'Remove the filter. To filter the demo tables, click a bar of a chart.',
    });
  }
  const sampled = dataset.sample && dataset.sample.percent < 100 ? sampleOf(table, dataset.sample.percent) : table;
  if (!dataset.chips?.length) return sampled;
  return chipsOf(sampled, JSON.stringify([table.name.name, dataset.sample?.percent, dataset.chips]), dataset.chips);
}

/** Find a column of a demo table. */
function columnOf(table: DemoTable, ref: ColumnRef): DemoColumn {
  const column = table.columns.find((c) => c.name === ref.name);
  if (!column) {
    throw new ProfilerError(`The column ${ref.name} does not exist in ${displayTableName(table.name)}.`, {
      nextStep: 'Refresh the board to read the columns again.',
    });
  }
  return column;
}

/** Convert a stored value to the number that a chart uses. A decimal 1999 with scale 2 becomes 19.99. */
function toNumber(column: DemoColumn, value: number): number {
  return column.family === 'decimal' ? value / 10 ** column.scale : value;
}

/**
 * Get the numbers that a request measures: the values of a number column, or
 * the lengths of the values as text. The list does not contain the nulls.
 */
function measuredNumbers(column: DemoColumn, measure: Measure | undefined): number[] {
  const out: number[] = [];
  if (measure === 'day') {
    if (column.family !== 'date' && column.family !== 'timestamp') throw new ProfilerError(`The column ${column.name} is not a date.`);
    for (const v of column.values) if (v !== null) out.push(column.family === 'timestamp' ? Math.floor((v as number) / DAY_MS) : (v as number));
  } else if (measure === 'length') {
    if (column.family === 'complex') throw new ProfilerError(`The column ${column.name} has the type ${column.typeText}, so its values have no length.`);
    for (const v of column.values) if (v !== null) out.push(formatDemoValue(column, v).length);
  } else {
    if (!isNumeric(column.family)) throw new ProfilerError(`The column ${column.name} is not a number.`);
    for (const v of column.values) if (v !== null) out.push(toNumber(column, v as number));
  }
  return out;
}

/**
 * Get a percentile of sorted numbers, as the Databricks function `percentile` does:
 * if the position is between two values, the result is between them in the same proportion.
 *
 * @example
 * percentileOf([10, 20, 30, 40], 0.5)   // 25
 */
export function percentileOf(sorted: number[], p: number): number {
  const position = p * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  const low = sorted[below] as number;
  return low + ((sorted[above] as number) - low) * (position - below);
}

export class DemoProfiler implements Profiler {
  async profile(request: Request, options: ProfileOptions = {}): Promise<Result> {
    options.onProgress?.('running');
    // Wait one turn, so that a cancel message can arrive, as it can with a real query.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (options.signal?.aborted) throw new CancelledError();

    const base = { sql: buildStatements(request).map(renderStatement), approximate: false, asOf: new Date().toISOString() };
    switch (request.type) {
      case 'tableDetails':
        return { ...base, ...this.tableDetails(request) };
      case 'overview':
        return { ...base, ...this.overview(request) };
      case 'numericStats':
        return { ...base, ...this.numericStats(request) };
      case 'histogram':
        return { ...base, ...this.histogram(request) };
      case 'frequency':
        return { ...base, ...this.frequency(request) };
      case 'dateCounts':
        return { ...base, ...this.dateCounts(request) };
      case 'validateFilter':
        tableOf(request.dataset); // throws if the table does not exist or the dataset has a filter
        return { ...base, type: 'validateFilter' };
      case 'quantiles': {
        const sorted = measuredNumbers(columnOf(tableOf(request.dataset), request.columns[0]), request.measure).sort((a, b) => a - b);
        return { ...base, type: 'quantiles', values: sorted.length ? request.probabilities.map((p) => percentileOf(sorted, p)) : [] };
      }
      case 'driftBins': {
        const table = tableOf(request.dataset);
        const numbers = measuredNumbers(columnOf(table, request.columns[0]), request.measure);
        const counts = new Array<number>(request.cuts.length + 1).fill(0);
        for (const x of numbers) {
          // The bin of a value is the number of cut points that are not above it.
          let bin = 0;
          for (const cut of request.cuts) if (x >= cut) bin++;
          counts[bin] = (counts[bin] as number) + 1;
        }
        return { ...base, type: 'driftBins', rowCount: table.rowCount, nulls: table.rowCount - numbers.length, counts };
      }
      case 'valueCounts': {
        const column = columnOf(tableOf(request.dataset), request.columns[0]);
        const counts = new Map<string, number>(request.values.map((value) => [value, 0]));
        for (const v of column.values) {
          if (v === null) continue;
          const text = formatDemoValue(column, v);
          const n = counts.get(text);
          if (n !== undefined) counts.set(text, n + 1);
        }
        return { ...base, type: 'valueCounts', values: request.values.map((value) => ({ value, count: counts.get(value) ?? 0 })) };
      }
    }
  }

  private tableDetails(request: RequestOf<'tableDetails'>): Omit<ResultOf<'tableDetails'>, 'sql' | 'approximate' | 'asOf'> {
    // The facts of a table do not depend on the sample.
    const table = tableOf({ ...request.dataset, sample: undefined, chips: undefined });
    return {
      type: 'tableDetails',
      columns: table.columns.map((c) => ({ name: c.name, typeText: c.typeText, ...(c.partition ? { partition: true } : {}) })),
      tableType: 'table',
      format: 'delta',
      sizeBytes: table.sizeBytes,
      lastModified: table.lastModified,
      partitionColumns: table.columns.filter((c) => c.partition).map((c) => c.name),
      version: table.version,
    };
  }

  private overview(request: RequestOf<'overview'>): Omit<ResultOf<'overview'>, 'sql' | 'approximate' | 'asOf'> {
    const table = tableOf(request.dataset);
    const columns = request.columns.map((ref): OverviewColumn => {
      const column = columnOf(table, ref);
      let nonNull = 0;
      for (const v of column.values) if (v !== null) nonNull++;
      const out: OverviewColumn = { name: column.name, nonNull };
      if (column.family === 'complex') return out;

      out.distinct = new Set(column.values).size - (nonNull < column.values.length ? 1 : 0);
      const ordered = isNumeric(column.family) || column.family === 'date' || column.family === 'timestamp';
      if (ordered && nonNull > 0) {
        let min = Infinity;
        let max = -Infinity;
        let sum = 0;
        for (const v of column.values) {
          if (v === null) continue;
          const n = v as number;
          if (n < min) min = n;
          if (n > max) max = n;
          sum += n;
        }
        out.min = formatDemoValue(column, min);
        out.max = formatDemoValue(column, max);
        if (isNumeric(column.family)) out.mean = toNumber(column, sum / nonNull);
      }
      return out;
    });
    return { type: 'overview', rowCount: table.rowCount, columns };
  }

  private numericStats(request: RequestOf<'numericStats'>): Omit<ResultOf<'numericStats'>, 'sql' | 'approximate' | 'asOf'> {
    const table = tableOf(request.dataset);
    const column = columnOf(table, request.columns[0]);
    const numbers = measuredNumbers(column, request.measure);
    const n = numbers.length;
    const out: Omit<ResultOf<'numericStats'>, 'sql' | 'approximate' | 'asOf'> = {
      type: 'numericStats',
      rowCount: table.rowCount,
      nonNull: n,
      zeros: numbers.filter((x) => x === 0).length,
      negatives: numbers.filter((x) => x < 0).length,
      percentiles: [],
    };
    if (n === 0) return out;

    const sorted = [...numbers].sort((a, b) => a - b);
    const mean = numbers.reduce((a, b) => a + b, 0) / n;
    // Write min and max as the table stores them, so that a decimal keeps all its digits.
    const text = (x: number) =>
      request.measure === 'length' ? String(x) : formatDemoValue(column, column.family === 'decimal' ? Math.round(x * 10 ** column.scale) : x);
    out.min = text(sorted[0] as number);
    out.max = text(sorted[n - 1] as number);
    out.mean = mean;
    if (n > 1) out.stddev = Math.sqrt(numbers.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
    out.percentiles = PERCENTILES.map((p) => ({ p, value: percentileOf(sorted, p) }));
    return out;
  }

  private histogram(request: RequestOf<'histogram'>): Omit<ResultOf<'histogram'>, 'sql' | 'approximate' | 'asOf'> {
    const column = columnOf(tableOf(request.dataset), request.columns[0]);
    const { edges } = request;
    const counts = new Array<number>(edges.bins).fill(0);
    let below = 0;
    let above = 0;
    for (const x of measuredNumbers(column, request.measure)) {
      const i = binIndex(x, edges);
      if (i < 0) below++;
      else if (i >= edges.bins) above++;
      else counts[i] = (counts[i] as number) + 1;
    }
    return { type: 'histogram', counts, below, above };
  }

  private frequency(request: RequestOf<'frequency'>): Omit<ResultOf<'frequency'>, 'sql' | 'approximate' | 'asOf'> {
    const table = tableOf(request.dataset);
    const column = columnOf(table, request.columns[0]);
    if (column.family === 'complex') {
      throw new ProfilerError(`The column ${column.name} has the type ${column.typeText}, so its values cannot be counted.`);
    }
    const counts = new Map<Exclude<(typeof column.values)[number], null>, number>();
    let nulls = 0;
    for (const v of column.values) {
      if (v === null) nulls++;
      else counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const values = [...counts.entries()]
      .map(([value, count]) => ({ value: formatDemoValue(column, value), count }))
      // Most frequent first. For the same count, the smaller value first, so that the sequence is the same on each run.
      .sort((x, y) => y.count - x.count || (x.value < y.value ? -1 : x.value > y.value ? 1 : 0))
      .slice(0, request.top);
    return { type: 'frequency', rowCount: table.rowCount, nulls, values };
  }

  private dateCounts(request: RequestOf<'dateCounts'>): Omit<ResultOf<'dateCounts'>, 'sql' | 'approximate' | 'asOf'> {
    const column = columnOf(tableOf(request.dataset), request.columns[0]);
    if (column.family !== 'date' && column.family !== 'timestamp') {
      throw new ProfilerError(`The column ${column.name} is not a date, so it has no counts over time.`);
    }
    const counts = new Map<number, number>();
    for (const v of column.values) {
      if (v === null) continue;
      const day = column.family === 'timestamp' ? Math.floor((v as number) / DAY_MS) : (v as number);
      const start = truncateDay(day, request.grain);
      counts.set(start, (counts.get(start) ?? 0) + 1);
    }
    const buckets = [...counts.entries()].sort((x, y) => x[0] - y[0]).map(([start, count]) => ({ start: formatDay(start), count }));
    return { type: 'dateCounts', grain: request.grain, buckets };
  }
}
