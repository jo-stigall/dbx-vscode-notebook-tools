/**
 * Load the two demo tables into a real Databricks schema, for the live tests.
 *
 * Usage (see env.ts for the variables):
 *
 *     npm run live:setup
 *
 * The script makes or replaces `orders_2025` and `orders_2026` in the schema
 * TABLE_VIZ_TEST_SCHEMA, and inserts the same rows that the Demo profile
 * has. It writes about 210,000 rows with 2 CREATE statements and 105 INSERT
 * statements.
 *
 * For each table and each group of rows, the script prints one line:
 *
 *     `main`.`table_viz_test`.`orders_2025`: create
 *     `main`.`table_viz_test`.`orders_2025`: 2000 of 100000 rows
 *     ...
 *     Done.
 *
 * If a statement fails, the script prints the message of the error and
 * stops with the exit code 1. Run it again: it replaces the tables.
 *
 * This script is not a part of the extension. The extension reads data
 * only. This script is the one place that writes to Databricks.
 *
 * NOT VERIFIED: this script was written without access to a workspace.
 */
import { quoteIdentifier, quoteTableName } from '../../../src/tableViz/core/names.ts';
import { demoTable, formatDemoValue, DEMO_TABLE_NAMES, type DemoColumn, type DemoValue } from '../../../src/tableViz/demo/data.ts';
import { liveClients, liveEnv } from './env.ts';

/** The number of rows in one INSERT statement. */
const BATCH = 2000;

/**
 * Write one value as a SQL literal of the type of its column.
 *
 * The script writes the values into the SQL text, not into parameters. The
 * values come from the demo tables, not from a user.
 *
 * @example
 * // `amount` is the column `amount decimal(10,2)` of a demo table, and so on.
 * literal(amount, 2316)        // '23.16': the demo table stores a decimal as cents
 * literal(orderDate, 20454)    // "DATE'2026-01-01'": the demo table stores a date as days after 1970-01-01
 * literal(weightKg, 1.5)       // '1.5D'
 * literal(region, "O'Brien")   // "'O\\'Brien'": a backslash goes before the quotation mark
 * literal(discountPct, null)   // 'NULL'
 *
 * @param column  The column of the demo table. Its type family selects the form of the literal.
 * @param value  The value as the demo table stores it.
 */
function literal(column: DemoColumn, value: DemoValue): string {
  if (value === null) return 'NULL';
  const text = formatDemoValue(column, value);
  switch (column.family) {
    case 'integer':
    case 'decimal':
      return text;
    case 'float':
      return `${text}D`;
    case 'boolean':
      return text;
    case 'date':
      return `DATE'${text}'`;
    case 'timestamp':
      return `TIMESTAMP'${text}'`;
    case 'string':
      return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    case 'complex':
      // The demo tables keep only "has a value" for a complex column. Write a small fixed value.
      return column.typeText.startsWith('array') ? "array('item')" : "named_struct('carrier', 'post', 'express', false)";
  }
}

/**
 * Make the two tables and insert their rows, 2000 rows in each statement.
 *
 * @throws {Error}  If one of the four environment variables is missing, or if Databricks refuses a statement.
 */
async function main(): Promise<void> {
  const env = liveEnv();
  if (!env) throw new Error('Set DATABRICKS_HOST, DATABRICKS_TOKEN, TABLE_VIZ_TEST_WAREHOUSE_ID and TABLE_VIZ_TEST_SCHEMA (catalog.schema).');
  const { runner } = liveClients(env);
  const run = (sql: string) => runner.run({ sql, params: [] });

  for (const name of DEMO_TABLE_NAMES) {
    const demo = demoTable(name);
    if (!demo) continue;
    const target = quoteTableName({ catalog: env.catalog, schema: env.schema, name: name.name });
    const columns = demo.columns.map((c) => `${quoteIdentifier(c.name)} ${c.typeText}`).join(', ');
    console.log(`${target}: create`);
    await run(`CREATE OR REPLACE TABLE ${target} (${columns})`);
    for (let start = 0; start < demo.rowCount; start += BATCH) {
      const rows: string[] = [];
      for (let i = start; i < Math.min(start + BATCH, demo.rowCount); i++) {
        rows.push('(' + demo.columns.map((c) => literal(c, c.values[i] ?? null)).join(', ') + ')');
      }
      await run(`INSERT INTO ${target} VALUES\n${rows.join(',\n')}`);
      console.log(`${target}: ${Math.min(start + BATCH, demo.rowCount)} of ${demo.rowCount} rows`);
    }
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
