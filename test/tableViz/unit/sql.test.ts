/**
 * Snapshot tests for the SQL builders in src/tableViz/core/sql.ts.
 *
 * The file sql.test.ts.snapshot contains the expected SQL of each case. If
 * you change a builder on purpose, write the file again:
 *
 *     node --test --test-update-snapshots "test/tableViz/unit/sql.test.ts"
 *
 * Then read the changes to the snapshot file before you commit them.
 *
 * The last three tests have no snapshot. They check rules that each
 * statement must obey: a table name or a column name is always in backticks,
 * the schema refuses a version or a sample that could carry SQL text, and
 * each statement starts with SELECT or DESCRIBE.
 *
 * Run all unit tests: npm run test:unit
 * Run this file only: node --test test/tableViz/unit/sql.test.ts
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { Dataset, Request } from '../../../src/tableViz/core/schema.ts';
import { requestSchema } from '../../../src/tableViz/core/schema.ts';
import { buildStatements, renderStatement } from '../../../src/tableViz/core/sql.ts';

/** A dataset with simple names and no filter: the table `main.sales.orders`. */
const plain: Dataset = { profile: 'p', table: { catalog: 'main', schema: 'sales', name: 'orders' } };
/** A dataset with each kind of difficult name: a space, a backtick, non-ASCII letters and a reserved word. */
const odd: Dataset = { profile: 'p', table: { catalog: 'główny', schema: 'sales data', name: 'select`from' } };
/** A dataset with each optional part: a filter, a Delta version and a sample of 12.5 percent. */
const full: Dataset = { ...plain, filter: "order_date >= '2026-01-01' AND region = 'EMEA'", version: { kind: 'version', n: '42' }, sample: { percent: 12.5 } };

/** A number column with a simple name. */
const amount = { name: 'amount', typeText: 'decimal(10,2)' };
/** Columns with each kind of difficult name: a space, a backtick, a non-ASCII letter and a reserved word. */
const oddColumns = [
  { name: 'unit price', typeText: 'double' },
  { name: 'we`ird', typeText: 'string' },
  { name: 'zamówienie', typeText: 'bigint' },
  { name: 'select', typeText: 'date' },
];

/**
 * Write all statements of a request as one text, for the snapshot file.
 *
 * The text of a statement starts with one comment line for each parameter,
 * for example a line that starts with `-- :tbl =`. A line with `;` separates
 * two statements.
 *
 * @param names  'identifier' (the default) puts each name in a parameter of `IDENTIFIER()`. 'backtick' writes each name into the SQL text, in backticks.
 */
const render = (request: Request, names?: 'identifier' | 'backtick') =>
  buildStatements(requestSchema.parse(request), { names })
    .map(renderStatement)
    .join('\n;\n');

/** Compare a text with the snapshot file. The text goes into the file as it is, so that the SQL is easy to read. */
const snapshot = (t: TestContext, text: string) => t.assert.snapshot(text, { serializers: [(value) => String(value)] });

test('tableDetails', (t) => {
  snapshot(t, render({ type: 'tableDetails', dataset: plain }));
  snapshot(t, render({ type: 'tableDetails', dataset: odd }));
});

test('overview: one statement for all column types', (t) => {
  const columns = [
    { name: 'order_id', typeText: 'bigint' },
    amount,
    { name: 'region', typeText: 'string' },
    { name: 'is_gift', typeText: 'boolean' },
    { name: 'order_date', typeText: 'date' },
    { name: 'order_ts', typeText: 'timestamp' },
    { name: 'items', typeText: 'array<string>' },
  ];
  snapshot(t, render({ type: 'overview', dataset: plain, columns }));
  snapshot(t, render({ type: 'overview', dataset: plain, columns: [amount], exact: true }));
});

test('overview: difficult names', (t) => {
  snapshot(t, render({ type: 'overview', dataset: odd, columns: oddColumns }));
  snapshot(t, render({ type: 'overview', dataset: odd, columns: oddColumns }, 'backtick'));
});

test('overview: filter, version and sample', (t) => {
  snapshot(t, render({ type: 'overview', dataset: full, columns: [amount] }));
  snapshot(t, render({ type: 'overview', dataset: { ...plain, version: { kind: 'timestamp', ts: '2026-11-01T02:05:00Z' } }, columns: [amount] }));
});

test('numericStats', (t) => {
  snapshot(t, render({ type: 'numericStats', dataset: plain, columns: [amount] }));
  snapshot(t, render({ type: 'numericStats', dataset: full, columns: [amount], exact: true }));
  snapshot(t, render({ type: 'numericStats', dataset: odd, columns: [{ name: 'we`ird', typeText: 'string' }], measure: 'length' }));
});

test('histogram', (t) => {
  snapshot(t, render({ type: 'histogram', dataset: plain, columns: [amount], edges: { lo: 0.5, hi: 5000, bins: 30 } }));
  snapshot(t, render({ type: 'histogram', dataset: full, columns: [amount], edges: { lo: -10, hi: 1e21, bins: 200 } }));
  snapshot(t, render({ type: 'histogram', dataset: odd, columns: [{ name: 'we`ird', typeText: 'string' }], edges: { lo: 1, hi: 40, bins: 10 }, measure: 'length' }, 'backtick'));
});

test('frequency', (t) => {
  snapshot(t, render({ type: 'frequency', dataset: plain, columns: [{ name: 'region', typeText: 'string' }], top: 20 }));
  snapshot(t, render({ type: 'frequency', dataset: full, columns: [{ name: 'unit price', typeText: 'double' }], top: 50 }));
});

test('dateCounts', (t) => {
  snapshot(t, render({ type: 'dateCounts', dataset: plain, columns: [{ name: 'order_ts', typeText: 'timestamp' }], grain: 'week' }));
  snapshot(t, render({ type: 'dateCounts', dataset: full, columns: [{ name: 'select', typeText: 'date' }], grain: 'month' }, 'backtick'));
});

test('validateFilter', (t) => {
  snapshot(t, render({ type: 'validateFilter', dataset: full }));
  snapshot(t, render({ type: 'validateFilter', dataset: plain }));
});

test('quantiles, driftBins and valueCounts', (t) => {
  snapshot(t, render({ type: 'quantiles', dataset: plain, columns: [amount], probabilities: [0.1, 0.5, 0.9] }));
  snapshot(t, render({ type: 'quantiles', dataset: full, columns: [{ name: 'order_ts', typeText: 'timestamp' }], probabilities: [0.5], measure: 'day' }));
  snapshot(t, render({ type: 'driftBins', dataset: full, columns: [amount], cuts: [10, 20.5, 1e6] }));
  snapshot(t, render({ type: 'driftBins', dataset: odd, columns: [{ name: 'select', typeText: 'date' }], cuts: [20454], measure: 'day' }, 'backtick'));
  snapshot(t, render({ type: 'valueCounts', dataset: full, columns: [{ name: 'we`ird', typeText: 'string' }], values: ["it's", 'x`; DROP TABLE t; --', ''] }));
});

test('a name never goes into the SQL text without backticks', () => {
  const evil = "x`; DROP TABLE t; --";
  const dataset: Dataset = { profile: 'p', table: { catalog: evil, schema: evil, name: evil } };
  const requests: Request[] = [
    { type: 'tableDetails', dataset },
    { type: 'overview', dataset, columns: [{ name: evil, typeText: 'int' }] },
    { type: 'numericStats', dataset, columns: [{ name: evil, typeText: 'int' }] },
    { type: 'histogram', dataset, columns: [{ name: evil, typeText: 'int' }], edges: { lo: 0, hi: 1, bins: 5 } },
    { type: 'frequency', dataset, columns: [{ name: evil, typeText: 'int' }], top: 5 },
    { type: 'dateCounts', dataset, columns: [{ name: evil, typeText: 'date' }], grain: 'day' },
  ];
  for (const request of requests) {
    // With IDENTIFIER(): the name is only in a parameter.
    for (const statement of buildStatements(request)) {
      assert.ok(!statement.sql.includes('DROP'), statement.sql);
      assert.ok(statement.params.some((p) => p.value.includes('x``; DROP TABLE t; --')), 'the parameter has the quoted name');
    }
    // With backticks: each backtick in the name is written twice, so the name cannot end early.
    for (const statement of buildStatements(request, { names: 'backtick' })) {
      assert.ok(!statement.sql.replaceAll('`x``; DROP TABLE t; --`', '').includes('DROP'), statement.sql);
    }
  }
});

test('the schema refuses a version or a sample that is not a plain value', () => {
  const bad: unknown[] = [
    { ...plain, version: { kind: 'version', n: '42; DROP TABLE t' } },
    { ...plain, version: { kind: 'timestamp', ts: "2026-01-01' OR '1'='1" } },
    { ...plain, version: { kind: 'timestamp', ts: 'yesterday' } },
    { ...plain, sample: { percent: 0 } },
    { ...plain, sample: { percent: 101 } },
    { ...plain, sample: { percent: '10 PERCENT) --' } },
  ];
  for (const dataset of bad) assert.equal(requestSchema.safeParse({ type: 'tableDetails', dataset }).success, false, JSON.stringify(dataset));
});

test('each statement reads data only', () => {
  const requests: Request[] = [
    { type: 'tableDetails', dataset: full },
    { type: 'overview', dataset: full, columns: [amount] },
    { type: 'numericStats', dataset: full, columns: [amount] },
    { type: 'histogram', dataset: full, columns: [amount], edges: { lo: 0, hi: 1, bins: 5 } },
    { type: 'frequency', dataset: full, columns: [amount], top: 5 },
    { type: 'dateCounts', dataset: full, columns: [{ name: 'd', typeText: 'date' }], grain: 'day' },
  ];
  for (const request of requests) {
    for (const { sql, params } of buildStatements(request)) {
      assert.match(sql, /^(SELECT|DESCRIBE)\b/);
      assert.ok(!sql.includes(';'), 'one statement in each call');
      // Each marker in the text has a parameter, and each parameter has a marker.
      const markers = new Set([...sql.matchAll(/(?<![:\w]):([a-z]\w*)/g)].map((m) => m[1]));
      assert.deepEqual([...markers].sort(), params.map((p) => p.name).sort(), sql);
    }
  }
});
