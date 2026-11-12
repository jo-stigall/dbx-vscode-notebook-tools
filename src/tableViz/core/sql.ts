/**
 * Build the SQL statement for each request.
 *
 * This file is the only place that writes SQL. The same text runs on a SQL
 * warehouse and on a cluster. Each statement obeys these rules:
 *
 * - It reads data only: SELECT or DESCRIBE.
 * - It returns aggregates, never the rows of the table.
 * - Each value is a named parameter (`:name`) with a type.
 * - Each table name and column name is a parameter inside `IDENTIFIER()`.
 *   Databricks then reads the parameter as a name, never as SQL.
 * - The filter of the dataset is the only text from the user that goes into
 *   the statement.
 *
 * A few parts cannot be parameters: the Delta version, the sample percent,
 * and the period of a date chart. The schema in schema.ts permits only
 * digits, date characters and fixed words for them.
 *
 * @example
 * buildStatements({
 *   type: 'histogram',
 *   dataset: { profile: 'p', table: { catalog: 'main', schema: 'sales', name: 'orders' } },
 *   columns: [{ name: 'amount', typeText: 'double' }],
 *   edges: { lo: 0, hi: 500, bins: 30 },
 * })
 * // [{
 * //   sql: 'SELECT\n  CASE WHEN CAST(IDENTIFIER(:c0) AS DOUBLE) = :hi THEN :bins ...',
 * //   params: [
 * //     { name: 'c0', value: '`amount`', type: 'STRING' },
 * //     { name: 'lo', value: '0', type: 'DOUBLE' }, ...
 * //     { name: 'tbl', value: '`main`.`sales`.`orders`', type: 'STRING' },
 * //   ],
 * // }]
 */
import { isNumeric, typeFamily } from './kinds.ts';
import { quoteIdentifier, quoteTableName } from './names.ts';
import { PERCENTILES, type Chip, type ColumnRef, type Dataset, type Grain, type Measure, type Request, type RequestOf } from './schema.ts';

/**
 * One named parameter of a statement. `value` is text for all types.
 *
 * @example
 * { name: 'bins', value: '30', type: 'INT' }                          // the marker in the SQL is :bins
 * { name: 'tbl', value: '`main`.`shop`.`orders`', type: 'STRING' }
 */
export interface SqlParam {
  /** The name without the colon. */
  name: string;
  value: string;
  /** The Databricks type that the runner gives to the value. */
  type: 'STRING' | 'INT' | 'DOUBLE';
}

/**
 * One SQL statement and its parameters.
 *
 * @example
 * {
 *   sql: 'DESCRIBE DETAIL IDENTIFIER(:tbl)',
 *   params: [{ name: 'tbl', value: '`main`.`shop`.`orders`', type: 'STRING' }],
 * }
 */
export interface Statement {
  /** The SQL text, with a marker such as `:tbl` in the place of each parameter. */
  sql: string;
  params: SqlParam[];
}

/** How buildStatements() writes the names of tables and columns. */
export interface BuildOptions {
  /**
   * How the statement names tables and columns.
   *
   * - 'identifier' (default): `IDENTIFIER(:tbl)`. The name is a parameter.
   * - 'backtick': `` `main`.`sales`.`orders` ``. The name is in the SQL text,
   *   between backticks, with each backtick in the name written twice. Use it
   *   only where Databricks does not accept `IDENTIFIER()`.
   */
  names?: 'identifier' | 'backtick';
}

/**
 * Collects the parameters of one statement and writes the parts that all statements share.
 *
 * A builder makes one `Parts` for each statement. It calls the methods to
 * get pieces of SQL text, and each method adds the parameters of its piece
 * to `params`. At the end, the builder returns its SQL text with `params`.
 *
 * @example
 * const parts = new Parts({});
 * parts.column({ name: 'amount', typeText: 'double' })   // 'IDENTIFIER(:c0)'
 * parts.column({ name: 'amount', typeText: 'double' })   // 'IDENTIFIER(:c0)': the same parameter
 * parts.param('bins', 30, 'INT')                         // ':bins'
 * parts.from(orders)                                     // 'FROM IDENTIFIER(:tbl)'
 * parts.from({ ...orders, version: { kind: 'version', n: '42' }, sample: { percent: 1 } })
 * // 'FROM IDENTIFIER(:tbl) VERSION AS OF 42 TABLESAMPLE (1 PERCENT)'
 * parts.where({ ...orders, filter: "region = 'EMEA'" }, 'IDENTIFIER(:c0) IS NOT NULL')
 * // "\nWHERE (\n  region = 'EMEA'\n) AND IDENTIFIER(:c0) IS NOT NULL"
 * parts.params
 * // [{ name: 'c0', value: '`amount`', type: 'STRING' }, { name: 'bins', value: '30', type: 'INT' },
 * //  { name: 'tbl', value: '`main`.`shop`.`orders`', type: 'STRING' }, ...]
 */
class Parts {
  /** The parameters of the statement, in the sequence in which the methods added them. */
  readonly params: SqlParam[] = [];
  /** How the methods write the names of tables and columns. See BuildOptions. */
  private readonly names: 'identifier' | 'backtick';
  /** The marker of each column that the statement already names, by column name. Example: 'amount' -> ':c0'. */
  private readonly columnNames = new Map<string, string>();

  constructor(options: BuildOptions) {
    this.names = options.names ?? 'identifier';
  }

  /** Add a parameter and return its marker, for example ':bins'. */
  param(name: string, value: string | number, type: SqlParam['type']): string {
    this.params.push({ name, value: String(value), type });
    return ':' + name;
  }

  /** Write a column reference. The same column gets the same parameter each time. */
  column(ref: ColumnRef): string {
    if (this.names === 'backtick') return quoteIdentifier(ref.name);
    let marker = this.columnNames.get(ref.name);
    if (!marker) {
      marker = this.param('c' + this.columnNames.size, quoteIdentifier(ref.name), 'STRING');
      this.columnNames.set(ref.name, marker);
    }
    return `IDENTIFIER(${marker})`;
  }

  /** Write the table name, without the version and the sample. */
  tableName(dataset: Dataset): string {
    if (this.names === 'backtick') return quoteTableName(dataset.table);
    return `IDENTIFIER(${this.param('tbl', quoteTableName(dataset.table), 'STRING')})`;
  }

  /** Write the FROM clause: the table, then its Delta version and its sample if the dataset has them. */
  from(dataset: Dataset): string {
    let sql = 'FROM ' + this.tableName(dataset);
    if (dataset.version?.kind === 'version') sql += ` VERSION AS OF ${dataset.version.n}`;
    if (dataset.version?.kind === 'timestamp') sql += ` TIMESTAMP AS OF '${dataset.version.ts}'`;
    if (dataset.sample) sql += ` TABLESAMPLE (${Number(dataset.sample.percent.toFixed(4))} PERCENT)`;
    return sql;
  }

  /**
   * Write the condition of one filter chip. Each value is a parameter (`f0`, `f1lo`, `f1hi`, ...).
   *
   * @example
   * // { op: 'eq', column: region, value: 'EMEA' }        ->  CAST(IDENTIFIER(:c0) AS STRING) = :f0
   * // { op: 'range', column: amount, lo: 10, hi: 20 }    ->  (CAST(IDENTIFIER(:c0) AS DOUBLE) >= :f0lo AND CAST(IDENTIFIER(:c0) AS DOUBLE) < :f0hi)
   */
  private chip(chip: Chip, index: number): string {
    const column = this.column(chip.column);
    if (chip.op === 'null') return `${column} IS NULL`;
    if (chip.op === 'eq') return `CAST(${column} AS STRING) = ${this.param(`f${index}`, chip.value, 'STRING')}`;
    const x = `CAST(${measured(column, chip.measure)} AS DOUBLE)`;
    const lo = this.param(`f${index}lo`, chip.lo, 'DOUBLE');
    const hi = this.param(`f${index}hi`, chip.hi, 'DOUBLE');
    return `(${x} >= ${lo} AND ${x} ${chip.includeHi ? '<=' : '<'} ${hi})`;
  }

  /**
   * Write the WHERE clause from the filter of the dataset, its filter chips, and one more condition.
   *
   * The filter is on its own lines. A `--` comment at the end of the filter
   * then cannot remove the text after it.
   *
   * @returns The clause with a line break before it, or '' if there is no condition.
   */
  where(dataset: Dataset, extra?: string): string {
    const filter = dataset.filter?.trim();
    const conditions = [...(filter ? [`(\n  ${filter}\n)`] : []), ...(dataset.chips ?? []).map((chip, i) => this.chip(chip, i)), ...(extra ? [extra] : [])];
    return conditions.length ? '\nWHERE ' + conditions.join(' AND ') : '';
  }
}

/**
 * Write the expression that a number request measures.
 *
 * | Measure  | Expression                              |
 * |----------|-----------------------------------------|
 * | 'value'  | the column                              |
 * | 'length' | the number of characters of the column as text |
 * | 'day'    | the date of the column, as days after 1970-01-01 |
 *
 * @example
 * measured('IDENTIFIER(:c0)', undefined)   // 'IDENTIFIER(:c0)'
 * measured('IDENTIFIER(:c0)', 'length')    // 'length(CAST(IDENTIFIER(:c0) AS STRING))'
 * measured('IDENTIFIER(:c0)', 'day')       // 'unix_date(CAST(IDENTIFIER(:c0) AS DATE))'
 *
 * @param column  The SQL text of the column, from `Parts.column()`.
 */
function measured(column: string, measure: Measure | undefined): string {
  if (measure === 'length') return `length(CAST(${column} AS STRING))`;
  if (measure === 'day') return `unix_date(CAST(${column} AS DATE))`;
  return column;
}

/**
 * The statements for "tableDetails": the size, the partition columns and the
 * last change of the table, and its current Delta version.
 *
 * The columns of the table do not come from SQL. They come from the Unity
 * Catalog REST API, which does not start a warehouse.
 *
 * @example
 * // For main.shop.orders, the two statements are:
 * //   DESCRIBE DETAIL IDENTIFIER(:tbl)
 * //   DESCRIBE HISTORY IDENTIFIER(:tbl) LIMIT 1
 * // Each has the parameter :tbl = '`main`.`shop`.`orders`'.
 */
function tableDetails(request: RequestOf<'tableDetails'>, options: BuildOptions): Statement[] {
  const detail = new Parts(options);
  const history = new Parts(options);
  return [
    { sql: `DESCRIBE DETAIL ${detail.tableName(request.dataset)}`, params: detail.params },
    { sql: `DESCRIBE HISTORY ${history.tableName(request.dataset)} LIMIT 1`, params: history.params },
  ];
}

/**
 * The statement for "overview": one scan that gives the row count and, for
 * each column, the numbers that its type permits.
 *
 * | Type of the column         | Numbers                                  |
 * |----------------------------|------------------------------------------|
 * | array, map, struct, …      | not-null count                           |
 * | string, boolean            | not-null count, distinct count           |
 * | date, timestamp            | those, plus min and max                  |
 * | number                     | those, plus mean                         |
 *
 * The result has one row. The columns of column number i are named `c<i>_nn`,
 * `c<i>_d`, `c<i>_min`, `c<i>_max` and `c<i>_avg`. With `exact: true`, the
 * statement uses `count(DISTINCT ...)` in the place of `approx_count_distinct`.
 *
 * @example
 * // The request has the columns `amount` (decimal) and `channel` (string).
 * // SELECT
 * //   count(*) AS `n`,
 * //   count(IDENTIFIER(:c0)) AS `c0_nn`,
 * //   approx_count_distinct(IDENTIFIER(:c0)) AS `c0_d`,
 * //   CAST(min(IDENTIFIER(:c0)) AS STRING) AS `c0_min`,
 * //   CAST(max(IDENTIFIER(:c0)) AS STRING) AS `c0_max`,
 * //   avg(CAST(IDENTIFIER(:c0) AS DOUBLE)) AS `c0_avg`,
 * //   count(IDENTIFIER(:c1)) AS `c1_nn`,
 * //   approx_count_distinct(IDENTIFIER(:c1)) AS `c1_d`
 * // FROM IDENTIFIER(:tbl)
 */
function overview(request: RequestOf<'overview'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const select = ['count(*) AS `n`'];
  request.columns.forEach((ref, i) => {
    const column = parts.column(ref);
    const family = typeFamily(ref.typeText);
    select.push(`count(${column}) AS \`c${i}_nn\``);
    if (family === 'complex') return;
    select.push(request.exact ? `count(DISTINCT ${column}) AS \`c${i}_d\`` : `approx_count_distinct(${column}) AS \`c${i}_d\``);
    if (family === 'string' || family === 'boolean') return;
    // CAST AS STRING keeps all digits of a large integer or a decimal.
    select.push(`CAST(min(${column}) AS STRING) AS \`c${i}_min\``, `CAST(max(${column}) AS STRING) AS \`c${i}_max\``);
    if (isNumeric(family)) select.push(`avg(CAST(${column} AS DOUBLE)) AS \`c${i}_avg\``);
  });
  const sql = `SELECT\n  ${select.join(',\n  ')}\n${parts.from(request.dataset)}${parts.where(request.dataset)}`;
  return [{ sql, params: parts.params }];
}

/**
 * The statement for "numericStats": counts, min, max, mean, standard
 * deviation and seven percentiles, in one scan.
 *
 * The inner query computes the percentiles as one array. The outer query
 * gives each percentile its own column (`p0` to `p6`), so that the result is
 * one row of plain values. With `exact: true`, the statement uses
 * `percentile` in the place of `approx_percentile`.
 *
 * @example
 * // SELECT `n`, `nn`, `zeros`, `negatives`, `min`, `max`, `mean`, `stddev`, `p`[0] AS `p0`, ..., `p`[6] AS `p6`
 * // FROM (
 * //   SELECT
 * //     count(*) AS `n`,
 * //     count(IDENTIFIER(:c0)) AS `nn`,
 * //     count_if(IDENTIFIER(:c0) = 0) AS `zeros`,
 * //     ...
 * //     approx_percentile(CAST(IDENTIFIER(:c0) AS DOUBLE), array(0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99)) AS `p`
 * //   FROM IDENTIFIER(:tbl)
 * // )
 */
function numericStats(request: RequestOf<'numericStats'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const x = measured(parts.column(request.columns[0]), request.measure);
  const percentile = request.exact ? 'percentile' : 'approx_percentile';
  const inner = [
    'count(*) AS `n`',
    `count(${x}) AS \`nn\``,
    `count_if(${x} = 0) AS \`zeros\``,
    `count_if(${x} < 0) AS \`negatives\``,
    `CAST(min(${x}) AS STRING) AS \`min\``,
    `CAST(max(${x}) AS STRING) AS \`max\``,
    `avg(CAST(${x} AS DOUBLE)) AS \`mean\``,
    `stddev(CAST(${x} AS DOUBLE)) AS \`stddev\``,
    `${percentile}(CAST(${x} AS DOUBLE), array(${PERCENTILES.join(', ')})) AS \`p\``,
  ];
  const outer = ['`n`', '`nn`', '`zeros`', '`negatives`', '`min`', '`max`', '`mean`', '`stddev`', ...PERCENTILES.map((_, i) => `\`p\`[${i}] AS \`p${i}\``)];
  const sql =
    `SELECT ${outer.join(', ')}\nFROM (\n  SELECT\n    ${inner.join(',\n    ')}\n  ` +
    `${parts.from(request.dataset)}${parts.where(request.dataset).replace(/\n/g, '\n  ')}\n)`;
  return [{ sql, params: parts.params }];
}

/**
 * The statement for "histogram": the number of rows in each bin.
 *
 * `width_bucket` gives bucket 1 to `bins` for a value in the range. It gives
 * 0 for a value below `lo`, and `bins + 1` for a value at or above `hi`. The
 * CASE puts the value `hi` in the last bin, as binIndex() in bins.ts does.
 * Thus the largest value of a column is not "above the range".
 *
 * @example
 * // The parameters are :lo = 0, :hi = 500 and :bins = 30.
 * // SELECT
 * //   CASE WHEN CAST(IDENTIFIER(:c0) AS DOUBLE) = :hi THEN :bins ELSE width_bucket(CAST(IDENTIFIER(:c0) AS DOUBLE), :lo, :hi, :bins) END AS `bucket`,
 * //   count(*) AS `n`
 * // FROM IDENTIFIER(:tbl)
 * // WHERE CAST(IDENTIFIER(:c0) AS DOUBLE) IS NOT NULL
 * // GROUP BY 1
 */
function histogram(request: RequestOf<'histogram'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const x = `CAST(${measured(parts.column(request.columns[0]), request.measure)} AS DOUBLE)`;
  const lo = parts.param('lo', request.edges.lo, 'DOUBLE');
  const hi = parts.param('hi', request.edges.hi, 'DOUBLE');
  const bins = parts.param('bins', request.edges.bins, 'INT');
  const sql =
    `SELECT\n  CASE WHEN ${x} = ${hi} THEN ${bins} ELSE width_bucket(${x}, ${lo}, ${hi}, ${bins}) END AS \`bucket\`,\n  count(*) AS \`n\`\n` +
    `${parts.from(request.dataset)}${parts.where(request.dataset, `${x} IS NOT NULL`)}\nGROUP BY 1`;
  return [{ sql, params: parts.params }];
}

/**
 * The statement for "frequency": the most frequent values and their counts.
 *
 * Each row also has the count of all rows (`total`), so that the caller can
 * compute "Other" as the remainder. The row of the null value, if there is
 * one, comes first. Thus the statement asks for one row more than `top`.
 *
 * @example
 * // For `top: 20`, the parameter is :limit = 21.
 * // SELECT `value`, `n`, sum(`n`) OVER () AS `total`
 * // FROM (
 * //   SELECT CAST(IDENTIFIER(:c0) AS STRING) AS `value`, count(*) AS `n`
 * //   FROM IDENTIFIER(:tbl)
 * //   GROUP BY 1
 * // )
 * // ORDER BY CASE WHEN `value` IS NULL THEN 0 ELSE 1 END, `n` DESC, `value`
 * // LIMIT :limit
 */
function frequency(request: RequestOf<'frequency'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const column = parts.column(request.columns[0]);
  const from = parts.from(request.dataset);
  const where = parts.where(request.dataset).replace(/\n/g, '\n  ');
  const limit = parts.param('limit', request.top + 1, 'INT');
  const sql =
    'SELECT `value`, `n`, sum(`n`) OVER () AS `total`\n' +
    `FROM (\n  SELECT CAST(${column} AS STRING) AS \`value\`, count(*) AS \`n\`\n  ${from}${where}\n  GROUP BY 1\n)\n` +
    `ORDER BY CASE WHEN \`value\` IS NULL THEN 0 ELSE 1 END, \`n\` DESC, \`value\`\nLIMIT ${limit}`;
  return [{ sql, params: parts.params }];
}

/** The period names that `date_trunc` accepts. The statement contains one of these fixed words, never text from a user. */
const TRUNC_UNITS: Record<Grain, string> = { day: 'DAY', week: 'WEEK', month: 'MONTH', year: 'YEAR' };

/**
 * The statement for "dateCounts": the number of rows in each day, week, month or year. A week starts on Monday.
 *
 * @example
 * // For `grain: 'month'`:
 * // SELECT
 * //   CAST(CAST(date_trunc('MONTH', IDENTIFIER(:c0)) AS DATE) AS STRING) AS `start`,
 * //   count(*) AS `n`
 * // FROM IDENTIFIER(:tbl)
 * // WHERE IDENTIFIER(:c0) IS NOT NULL
 * // GROUP BY 1
 * // ORDER BY 1
 */
function dateCounts(request: RequestOf<'dateCounts'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const column = parts.column(request.columns[0]);
  const sql =
    `SELECT\n  CAST(CAST(date_trunc('${TRUNC_UNITS[request.grain]}', ${column}) AS DATE) AS STRING) AS \`start\`,\n  count(*) AS \`n\`\n` +
    `${parts.from(request.dataset)}${parts.where(request.dataset, `${column} IS NOT NULL`)}\nGROUP BY 1\nORDER BY 1`;
  return [{ sql, params: parts.params }];
}

/**
 * The statement for "validateFilter": ask Databricks to read the filter, with `LIMIT 0` so that it reads no rows.
 *
 * If the filter is not valid, the statement fails, and the error text tells why.
 *
 * @example
 * // For the filter "region = 'EMEA'":
 * // SELECT 1 AS `ok`
 * // FROM IDENTIFIER(:tbl)
 * // WHERE (
 * //   region = 'EMEA'
 * // )
 * // LIMIT 0
 */
function validateFilter(request: RequestOf<'validateFilter'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const sql = `SELECT 1 AS \`ok\`\n${parts.from(request.dataset)}${parts.where(request.dataset)}\nLIMIT 0`;
  return [{ sql, params: parts.params }];
}

/**
 * The statement for "quantiles": approximate percentiles, one result column (`q0`, `q1`, ...) for each probability.
 *
 * @example
 * // For `probabilities: [0.1, 0.5, 0.9]`:
 * // SELECT `q`[0] AS `q0`, `q`[1] AS `q1`, `q`[2] AS `q2`
 * // FROM (
 * //   SELECT approx_percentile(CAST(IDENTIFIER(:c0) AS DOUBLE), array(0.1, 0.5, 0.9)) AS `q`
 * //   FROM IDENTIFIER(:tbl)
 * // )
 */
function quantiles(request: RequestOf<'quantiles'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const x = `CAST(${measured(parts.column(request.columns[0]), request.measure)} AS DOUBLE)`;
  const outer = request.probabilities.map((_, i) => `\`q\`[${i}] AS \`q${i}\``).join(', ');
  const sql =
    `SELECT ${outer}\nFROM (\n  SELECT approx_percentile(${x}, array(${request.probabilities.join(', ')})) AS \`q\`\n  ` +
    `${parts.from(request.dataset)}${parts.where(request.dataset).replace(/\n/g, '\n  ')}\n)`;
  return [{ sql, params: parts.params }];
}

/**
 * The statement for "driftBins": the number of rows between each two cut points.
 *
 * The bucket of a value is the number of cut points that are not above it.
 * Thus a value below the first cut point gets 0, and a value at or above the
 * last one gets `cuts.length`. The bucket of a null is -1.
 *
 * @example
 * // For `cuts: [12.5, 49.4]`, the parameters are :k0 = 12.5 and :k1 = 49.4.
 * // SELECT
 * //   CASE WHEN CAST(IDENTIFIER(:c0) AS DOUBLE) IS NULL THEN -1 ELSE
 * //     CASE WHEN CAST(IDENTIFIER(:c0) AS DOUBLE) >= :k0 THEN 1 ELSE 0 END +
 * //     CASE WHEN CAST(IDENTIFIER(:c0) AS DOUBLE) >= :k1 THEN 1 ELSE 0 END
 * //   END AS `bucket`,
 * //   count(*) AS `n`
 * // FROM IDENTIFIER(:tbl)
 * // GROUP BY 1
 * // The amount 30 gets bucket 1: it is at or above 12.5, and below 49.4.
 */
function driftBins(request: RequestOf<'driftBins'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const x = `CAST(${measured(parts.column(request.columns[0]), request.measure)} AS DOUBLE)`;
  const steps = request.cuts.map((cut, i) => `CASE WHEN ${x} >= ${parts.param(`k${i}`, cut, 'DOUBLE')} THEN 1 ELSE 0 END`);
  const sql =
    `SELECT\n  CASE WHEN ${x} IS NULL THEN -1 ELSE\n    ${steps.join(' +\n    ')}\n  END AS \`bucket\`,\n  count(*) AS \`n\`\n` +
    `${parts.from(request.dataset)}${parts.where(request.dataset)}\nGROUP BY 1`;
  return [{ sql, params: parts.params }];
}

/**
 * The statement for "valueCounts": the number of rows for each value in a list. A value with no rows gives no result row.
 *
 * @example
 * // For `values: ['fax', 'phone']`, the parameters are :v0 = 'fax' and :v1 = 'phone'.
 * // SELECT CAST(IDENTIFIER(:c0) AS STRING) AS `value`, count(*) AS `n`
 * // FROM IDENTIFIER(:tbl)
 * // WHERE CAST(IDENTIFIER(:c0) AS STRING) IN (:v0, :v1)
 * // GROUP BY 1
 */
function valueCounts(request: RequestOf<'valueCounts'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const x = `CAST(${parts.column(request.columns[0])} AS STRING)`;
  const list = request.values.map((value, i) => parts.param(`v${i}`, value, 'STRING')).join(', ');
  const sql = `SELECT ${x} AS \`value\`, count(*) AS \`n\`\n${parts.from(request.dataset)}${parts.where(request.dataset, `${x} IN (${list})`)}\nGROUP BY 1`;
  return [{ sql, params: parts.params }];
}

/**
 * Build the statements for a request.
 *
 * Most requests need one statement. "tableDetails" needs two. The top of
 * this file shows an example for a "histogram" request.
 *
 * @example
 * // With the option `names: 'backtick'`, the names are in the SQL text and are not parameters:
 * buildStatements({ type: 'validateFilter', dataset: { profile: 'p', table: { catalog: 'main', schema: 'shop', name: 'orders' } } }, { names: 'backtick' })
 * // [{ sql: 'SELECT 1 AS `ok`\nFROM `main`.`shop`.`orders`\nLIMIT 0', params: [] }]
 */
export function buildStatements(request: Request, options: BuildOptions = {}): Statement[] {
  switch (request.type) {
    case 'tableDetails':
      return tableDetails(request, options);
    case 'overview':
      return overview(request, options);
    case 'numericStats':
      return numericStats(request, options);
    case 'histogram':
      return histogram(request, options);
    case 'frequency':
      return frequency(request, options);
    case 'dateCounts':
      return dateCounts(request, options);
    case 'validateFilter':
      return validateFilter(request, options);
    case 'quantiles':
      return quantiles(request, options);
    case 'driftBins':
      return driftBins(request, options);
    case 'valueCounts':
      return valueCounts(request, options);
  }
}

/**
 * Write a statement for a person to read: the parameters as comments, then the SQL.
 *
 * The value of a STRING parameter is between single quotation marks, and
 * each single quotation mark in the value is there two times.
 *
 * @example
 * renderStatement({ sql: 'SELECT count(*) FROM IDENTIFIER(:tbl)', params: [{ name: 'tbl', value: '`main`.`sales`.`orders`', type: 'STRING' }] })
 * // -- :tbl = '`main`.`sales`.`orders`'
 * // SELECT count(*) FROM IDENTIFIER(:tbl)
 */
export function renderStatement(statement: Statement): string {
  const lines = statement.params.map((p) => `-- :${p.name} = ${p.type === 'STRING' ? `'${p.value.replace(/'/g, "''")}'` : p.value}`);
  return [...lines, statement.sql].join('\n');
}

/**
 * Write a statement so that a person can run it in a SQL editor: with each value in the text, not as a parameter.
 *
 * The input is the text of renderStatement(): the parameters as comments,
 * then the SQL. The function puts the value of each parameter in the place
 * of its marker.
 *
 * @example
 * inlineRendered("-- :tbl = '`main`.`sales`.`orders`'\n-- :limit = 21\nSELECT 1 FROM IDENTIFIER(:tbl) LIMIT :limit")
 * // "SELECT 1 FROM IDENTIFIER('`main`.`sales`.`orders`') LIMIT 21"
 */
export function inlineRendered(rendered: string): string {
  const lines = rendered.split('\n');
  const values = new Map<string, string>();
  let start = 0;
  for (; start < lines.length; start++) {
    const match = /^-- :(\w+) = (.*)$/.exec(lines[start] as string);
    if (!match) break;
    // In a Databricks string, a backslash starts an escape. Write it two times so that it stays a backslash.
    values.set(match[1] as string, (match[2] as string).replace(/\\/g, '\\\\'));
  }
  return lines
    .slice(start)
    .join('\n')
    .replace(/(?<![:\w]):(\w+)/g, (marker, name: string) => values.get(name) ?? marker);
}
