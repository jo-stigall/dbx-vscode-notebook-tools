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
import { PERCENTILES, type ColumnRef, type Dataset, type Grain, type Measure, type Request, type RequestOf } from './schema.ts';

/** One named parameter of a statement. `value` is text for all types. */
export interface SqlParam {
  name: string;
  value: string;
  type: 'STRING' | 'INT' | 'DOUBLE';
}

/** One SQL statement and its parameters. */
export interface Statement {
  sql: string;
  params: SqlParam[];
}

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

/** Collects the parameters of one statement and writes the parts that all statements share. */
class Parts {
  readonly params: SqlParam[] = [];
  private readonly names: 'identifier' | 'backtick';
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
   * Write the WHERE clause from the filter of the dataset and one more condition.
   *
   * The filter is on its own lines. A `--` comment at the end of the filter
   * then cannot remove the text after it.
   *
   * @returns The clause with a line break before it, or '' if there is no condition.
   */
  where(dataset: Dataset, extra?: string): string {
    const filter = dataset.filter?.trim();
    const conditions = [...(filter ? [`(\n  ${filter}\n)`] : []), ...(extra ? [extra] : [])];
    return conditions.length ? '\nWHERE ' + conditions.join(' AND ') : '';
  }
}

/** Write the expression that a number request measures: the column as a number, or the length of the column as text. */
function measured(column: string, measure: Measure | undefined): string {
  return measure === 'length' ? `length(CAST(${column} AS STRING))` : column;
}

/**
 * The statements for "tableDetails": the size, the partition columns and the
 * last change of the table, and its current Delta version.
 *
 * The columns of the table do not come from SQL. They come from the Unity
 * Catalog REST API, which does not start a warehouse.
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
 * `c<i>_d`, `c<i>_min`, `c<i>_max` and `c<i>_avg`.
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
 * one row of plain values.
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
 * `width_bucket` gives bucket 1 to `bins` for a value in the range, 0 for a
 * value below `lo`, and `bins + 1` for a value at or above `hi`. The CASE
 * puts the value `hi` in the last bin, as binIndex() in bins.ts does. Thus
 * the largest value of a column is not "above the range".
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

/** The statement for "dateCounts": the number of rows in each day, week, month or year. A week starts on Monday. */
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
 * If the filter is not valid, the statement fails, and the error text tells why.
 */
function validateFilter(request: RequestOf<'validateFilter'>, options: BuildOptions): Statement[] {
  const parts = new Parts(options);
  const sql = `SELECT 1 AS \`ok\`\n${parts.from(request.dataset)}${parts.where(request.dataset)}\nLIMIT 0`;
  return [{ sql, params: parts.params }];
}

/**
 * Build the statements for a request.
 *
 * Most requests need one statement. "tableDetails" needs two.
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
  }
}

/**
 * Write a statement for a person to read: the parameters as comments, then the SQL.
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
