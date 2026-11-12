/**
 * The demo profiler: it answers requests from the demo tables in memory.
 *
 * It needs no Databricks workspace. It is also the reference for the SQL
 * profiler: for the same data, the two profilers must give the same numbers.
 * All numbers from this profiler are exact.
 */
import { binIndex, formatDay, truncateDay } from '../core/bins.ts';
import { isNumeric } from '../core/kinds.ts';
import { displayTableName } from '../core/names.ts';
import { CancelledError, ProfilerError, type ProfileOptions, type Profiler } from '../core/profiler.ts';
import type { ColumnRef, Dataset, OverviewColumn, Request, RequestOf, Result, ResultOf } from '../core/schema.ts';
import { demoTable, formatDemoValue, type DemoColumn, type DemoTable } from './data.ts';

const DAY_MS = 86_400_000;

// This folder is checked without Node.js or browser types, so declare the one global function that it uses.
declare const setTimeout: (callback: () => void, ms: number) => unknown;

/** Find the demo table of a dataset. */
function tableOf(dataset: Dataset): DemoTable {
  const table = demoTable(dataset.table);
  if (!table) {
    throw new ProfilerError(`The demo table ${displayTableName(dataset.table)} does not exist.`, {
      nextStep: 'Use demo.shop.orders_2025 or demo.shop.orders_2026.',
    });
  }
  if (dataset.filter?.trim()) {
    throw new ProfilerError('The Demo profile cannot use a filter yet.', { nextStep: 'Remove the filter.' });
  }
  return table;
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

export class DemoProfiler implements Profiler {
  async profile(request: Request, options: ProfileOptions = {}): Promise<Result> {
    options.onProgress?.('running');
    // Wait one turn, so that a cancel message can arrive, as it can with a real query.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    if (options.signal?.aborted) throw new CancelledError();

    const base = { sql: [], approximate: false, asOf: new Date().toISOString() };
    switch (request.type) {
      case 'tableDetails':
        return { ...base, ...this.tableDetails(request) };
      case 'overview':
        return { ...base, ...this.overview(request) };
      case 'histogram':
        return { ...base, ...this.histogram(request) };
      case 'frequency':
        return { ...base, ...this.frequency(request) };
      case 'dateCounts':
        return { ...base, ...this.dateCounts(request) };
    }
  }

  private tableDetails(request: RequestOf<'tableDetails'>): Omit<ResultOf<'tableDetails'>, 'sql' | 'approximate' | 'asOf'> {
    const table = tableOf(request.dataset);
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

  private histogram(request: RequestOf<'histogram'>): Omit<ResultOf<'histogram'>, 'sql' | 'approximate' | 'asOf'> {
    const column = columnOf(tableOf(request.dataset), request.columns[0]);
    if (!isNumeric(column.family)) {
      throw new ProfilerError(`The column ${column.name} is not a number, so it has no histogram.`);
    }
    const { edges } = request;
    const counts = new Array<number>(edges.bins).fill(0);
    let below = 0;
    let above = 0;
    for (const v of column.values) {
      if (v === null) continue;
      const i = binIndex(toNumber(column, v as number), edges);
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
