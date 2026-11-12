/**
 * A fake SQL warehouse for tests: it answers the statements of sql.ts from the demo tables.
 *
 * The fake does not run SQL. It recognizes each statement that the builders
 * make, asks the demo profiler for the same numbers, and writes them as the
 * rows that Databricks returns for that statement. A test can then send a
 * request through the real builders, the real runner and the real parsers,
 * and compare the answer with the demo profiler.
 *
 * The fake knows only the statements of sql.ts with `IDENTIFIER()` names.
 * It ignores a filter, a version and a sample.
 *
 * The fake is different from a SQL warehouse of Databricks in these ways:
 *
 * - It does not run SQL. SQLite and other local databases do not know the
 *   Databricks functions, so no test on this computer can run the statements.
 * - It reads the two demo tables only (`demo.shop.orders_2025` and
 *   `demo.shop.orders_2026`). Each other table gives TABLE_OR_VIEW_NOT_FOUND.
 * - It gives exact numbers where Databricks gives estimates (distinct counts
 *   and percentiles).
 *
 * A test that passes with the fake shows that the builders, the runner and
 * the parsers fit together. It does not show that Databricks accepts each
 * statement. Only the tests in test/tableViz/live show that.
 *
 * The fake workspace (workspace.ts), the fake driver (driver.ts) and the unit
 * tests call `answerStatement`. Run the unit tests with `npm run test:unit`.
 */
import { parseTableName } from '../../../src/tableViz/core/names.ts';
import type { QueryColumn, QueryResult } from '../../../src/tableViz/core/runner.ts';
import type { ColumnRef, Dataset, Grain, Measure, Result, ResultOf, Request } from '../../../src/tableViz/core/schema.ts';
import type { Statement } from '../../../src/tableViz/core/sql.ts';
import { demoTable } from '../../../src/tableViz/demo/data.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';

/** The demo profiler that computes the numbers of each answer. */
const profiler = new DemoProfiler();

/**
 * An error that the fake reports as Databricks does: with an error code and a SQLSTATE.
 *
 * `code` is the error code of Databricks, for example 'TABLE_OR_VIEW_NOT_FOUND'.
 * `sqlState` is the SQLSTATE of that error, for example '42P01'.
 *
 * @example
 * throw new FakeSqlError('[TABLE_OR_VIEW_NOT_FOUND] The table or view `demo`.`shop`.`orders_1999` cannot be found. SQLSTATE: 42P01', 'TABLE_OR_VIEW_NOT_FOUND', '42P01');
 */
export class FakeSqlError extends Error {
  readonly code: string;
  readonly sqlState: string;
  constructor(message: string, code: string, sqlState: string) {
    super(message);
    this.code = code;
    this.sqlState = sqlState;
  }
}

/** Remove the backticks of a quoted name. '`we``ird`' gives 'we`ird'. */
const unquote = (quoted: string) => quoted.slice(1, -1).replace(/``/g, '`');

/**
 * Make a result from column names and rows.
 *
 * Each value becomes text, as in the JSON_ARRAY format of Databricks. `null`
 * and `undefined` become `null`. Each column gets the type name 'STRING'.
 *
 * @example
 * rowsOf(['bucket', 'n'], [[1, 250], [2, undefined]])
 * // {
 * //   columns: [{ name: 'bucket', typeName: 'STRING' }, { name: 'n', typeName: 'STRING' }],
 * //   rows: [['1', '250'], ['2', null]],
 * // }
 */
function rowsOf(names: string[], rows: (string | number | null | undefined)[][]): QueryResult {
  const columns: QueryColumn[] = names.map((name) => ({ name, typeName: 'STRING' }));
  return { columns, rows: rows.map((row) => row.map((v) => (v === null || v === undefined ? null : String(v)))) };
}

/**
 * Answer one statement with the rows that Databricks returns for it.
 *
 * The function does not read the SQL as a database does. It finds the type
 * of the statement from a fixed piece of its text, for example
 * `width_bucket(` for a histogram. The parameter `tbl` names the table, and
 * the parameters `c0`, `c1`, ... name the columns.
 *
 * @example
 * const dataset = { profile: 'p', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } };
 * const [statement] = buildStatements({ type: 'frequency', dataset, columns: [{ name: 'status', typeText: 'string' }], top: 5 });
 * const answer = await answerStatement(statement);
 * answer.columns.map((c) => c.name)   // ['value', 'n', 'total']
 * answer.rows[0]                      // [null, '1123', '110000']: 1,123 of 110,000 rows have no status
 *
 * @param statement  A statement from `buildStatements` in sql.ts, with `IDENTIFIER()` names.
 * @returns The columns and the rows. Each value is text or null.
 * @throws {FakeSqlError}  If the table of the statement is not a demo table.
 * @throws {Error}  If the statement is not one that sql.ts makes.
 */
export async function answerStatement(statement: Statement): Promise<QueryResult> {
  const { sql, params } = statement;
  // Get the value of the parameter with this name. undefined if the statement has no such parameter.
  const param = (name: string) => params.find((p) => p.name === name)?.value;
  const table = parseTableName(param('tbl') ?? '');
  const demo = table && demoTable(table);
  if (!table || !demo) {
    throw new FakeSqlError(`[TABLE_OR_VIEW_NOT_FOUND] The table or view ${param('tbl')} cannot be found. SQLSTATE: 42P01`, 'TABLE_OR_VIEW_NOT_FOUND', '42P01');
  }
  const dataset: Dataset = { profile: 'Demo', table };
  // Get the column that a parameter names. Example: the parameter `c0` has the value '`amount`', which gives { name: 'amount', typeText: 'decimal(10,2)' }.
  const ref = (marker: string): ColumnRef => {
    const name = unquote(param(marker) ?? '');
    const column = demo.columns.find((c) => c.name === name);
    if (!column) throw new FakeSqlError(`[UNRESOLVED_COLUMN.WITH_SUGGESTION] A column with name \`${name}\` cannot be resolved. SQLSTATE: 42703`, 'UNRESOLVED_COLUMN.WITH_SUGGESTION', '42703');
    return { name, typeText: column.typeText };
  };
  // Send one request to the demo profiler.
  const ask = <T extends Request>(request: T) => profiler.profile(request) as Promise<ResultOf<T['type']>>;
  // The measure of a request is not a parameter. The SQL text shows it: `length(CAST(` is 'length', `unix_date(` is 'day'.
  const measure: Measure | undefined = sql.includes('length(CAST(') ? 'length' : sql.includes('unix_date(') ? 'day' : undefined;

  if (sql.startsWith('DESCRIBE DETAIL ')) {
    const partitions = demo.columns.filter((c) => c.partition).map((c) => c.name);
    // Databricks writes the time of the last change as "2026-11-01 02:05:00".
    const lastModified = demo.lastModified.replace('T', ' ').replace(/\.\d+Z$/, '');
    return rowsOf(['format', 'name', 'lastModified', 'partitionColumns', 'numFiles', 'sizeInBytes'], [['delta', param('tbl'), lastModified, JSON.stringify(partitions), 4, demo.sizeBytes]]);
  }
  if (sql.startsWith('DESCRIBE HISTORY ')) {
    return rowsOf(['version', 'timestamp', 'operation'], [[demo.version, '2026-11-01 02:05:00', 'WRITE']]);
  }
  if (sql.startsWith('SELECT\n  count(*) AS `n`,')) {
    const columns = params.filter((p) => /^c\d+$/.test(p.name)).map((p) => ref(p.name));
    const result = await ask({ type: 'overview', dataset, columns });
    const names = ['n'];
    const row: (string | number | undefined)[] = [result.rowCount];
    result.columns.forEach((c, i) => {
      // Give only the columns that the statement asks for.
      const add = (suffix: string, value: string | number | undefined) => {
        if (sql.includes(`\`c${i}_${suffix}\``)) {
          names.push(`c${i}_${suffix}`);
          row.push(value);
        }
      };
      add('nn', c.nonNull);
      add('d', c.distinct);
      add('min', c.min);
      add('max', c.max);
      add('avg', c.mean);
    });
    return rowsOf(names, [row]);
  }
  if (sql.includes(' AS `p`\n')) {
    const r = await ask({ type: 'numericStats', dataset, columns: [ref('c0')], measure });
    const names = ['n', 'nn', 'zeros', 'negatives', 'min', 'max', 'mean', 'stddev', ...r.percentiles.map((_, i) => `p${i}`)];
    const row = [r.rowCount, r.nonNull, r.zeros, r.negatives, r.min, r.max, r.mean, r.stddev, ...r.percentiles.map((p) => p.value)];
    // With no values, Databricks gives one row of nulls for the percentiles.
    while (names.length < 15) names.push(`p${names.length - 8}`), row.push(undefined);
    return rowsOf(names, [row]);
  }
  if (sql.includes('width_bucket(')) {
    const edges = { lo: Number(param('lo')), hi: Number(param('hi')), bins: Number(param('bins')) };
    const r = await ask({ type: 'histogram', dataset, columns: [ref('c0')], edges, measure });
    // Bucket 0 is below the range, 1 to `bins` are the bins, `bins + 1` is above. Databricks gives no row for an empty bucket.
    const rows = [[0, r.below], ...r.counts.map((n, i) => [i + 1, n]), [edges.bins + 1, r.above]].filter(([, n]) => (n as number) > 0);
    return rowsOf(['bucket', 'n'], rows);
  }
  if (sql.includes('sum(`n`) OVER ()')) {
    const limit = Number(param('limit'));
    const r = await ask({ type: 'frequency', dataset, columns: [ref('c0')], top: 1000 });
    const rows: (string | number | null)[][] = [];
    if (r.nulls > 0) rows.push([null, r.nulls, r.rowCount]);
    for (const v of r.values) rows.push([v.value, v.count, r.rowCount]);
    return rowsOf(['value', 'n', 'total'], rows.slice(0, limit));
  }
  if (sql.startsWith('SELECT 1 AS `ok`')) return rowsOf(['ok'], []);
  if (sql.includes(' AS `q`\n')) {
    const probabilities = (/array\(([^)]*)\)/.exec(sql)?.[1] ?? '').split(',').map(Number);
    const r = await ask({ type: 'quantiles', dataset, columns: [ref('c0')], measure, probabilities });
    // With no values, Databricks gives one row of nulls.
    return rowsOf(probabilities.map((_, i) => `q${i}`), [probabilities.map((_, i) => r.values[i])]);
  }
  if (sql.includes('THEN -1 ELSE')) {
    const cuts = params.filter((p) => /^k\d+$/.test(p.name)).map((p) => Number(p.value));
    const r = await ask({ type: 'driftBins', dataset, columns: [ref('c0')], measure, cuts });
    return rowsOf(['bucket', 'n'], [[-1, r.nulls], ...r.counts.map((n, i) => [i, n])].filter(([, n]) => (n as number) > 0));
  }
  if (sql.includes(' IN (:v0')) {
    const values = params.filter((p) => /^v\d+$/.test(p.name)).map((p) => p.value);
    const r = await ask({ type: 'valueCounts', dataset, columns: [ref('c0')], values });
    return rowsOf(['value', 'n'], r.values.filter((v) => v.count > 0).map((v) => [v.value, v.count]));
  }
  const trunc = /date_trunc\('(DAY|WEEK|MONTH|YEAR)'/.exec(sql);
  if (trunc) {
    const r = await ask({ type: 'dateCounts', dataset, columns: [ref('c0')], grain: (trunc[1] as string).toLowerCase() as Grain });
    return rowsOf(['start', 'n'], r.buckets.map((b) => [b.start, b.count]));
  }
  throw new Error(`The fake warehouse does not know this statement:\n${sql}`);
}

/**
 * Remove the fields that are different on each run or between the two profilers, so that a test can compare two results.
 *
 * The fields are `sql`, `asOf` (the time of the query) and `approximate`.
 *
 * @example
 * const viaSql = await sqlProfiler.profile(request);
 * const expected = await demoProfiler.profile(request);
 * assert.deepEqual(comparable(viaSql), comparable(expected));
 */
export function comparable(result: Result): Omit<Result, 'sql' | 'asOf' | 'approximate'> {
  const { sql: _sql, asOf: _asOf, approximate: _approximate, ...rest } = result;
  return rest;
}
