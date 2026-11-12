/**
 * Tests for the demo tables and the demo profiler in src/tableViz/demo.
 *
 * The profiler tests compute each number a second time, with simple code that
 * reads the rows directly, and compare the two answers.
 *
 * Run: npm run test:unit
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeEdges } from '../../../src/tableViz/core/bins.ts';
import { createDispatcher, CancelledError, ProfilerError, type Profiler } from '../../../src/tableViz/core/profiler.ts';
import type { Dataset, ResultOf, ToWebview } from '../../../src/tableViz/core/schema.ts';
import { resultSchema, toWebviewSchema } from '../../../src/tableViz/core/schema.ts';
import { demoTable, formatDemoValue, type DemoColumn, type DemoTable } from '../../../src/tableViz/demo/data.ts';
import { DemoProfiler } from '../../../src/tableViz/demo/demoProfiler.ts';
import { makeRng } from '../../../src/tableViz/demo/random.ts';

const name = (table: string) => ({ catalog: 'demo', schema: 'shop', name: table });
const dataset = (table: string): Dataset => ({ profile: 'Demo', table: name(table) });
const t25 = demoTable(name('orders_2025')) as DemoTable;
const t26 = demoTable(name('orders_2026')) as DemoTable;
const column = (table: DemoTable, columnName: string) => table.columns.find((c) => c.name === columnName) as DemoColumn;
const ref = (table: DemoTable, columnName: string) => ({ name: columnName, typeText: column(table, columnName).typeText });
const nullRate = (c: DemoColumn) => c.values.filter((v) => v === null).length / c.values.length;
const profiler = new DemoProfiler();

test('the random numbers are the same on each run', () => {
  const rng = makeRng(42);
  assert.deepEqual([rng(), rng()], [0.6011037519201636, 0.44829055899754167]);
});

test('the demo tables have the documented size and the same rows on each run', () => {
  assert.equal(t25.rowCount, 100_000);
  assert.equal(t26.rowCount, 110_000);
  for (const table of [t25, t26]) for (const c of table.columns) assert.equal(c.values.length, table.rowCount, c.name);
  // A fixed sample of values. If the generator changes, these values change.
  assert.equal(column(t26, 'order_id').values[0], 5_001_000_000);
  assert.equal(formatDemoValue(column(t26, 'amount'), column(t26, 'amount').values[0] as number), '23.16');
  assert.equal(column(t26, 'region').values[109_999], 'APAC');
  assert.equal(demoTable(name('no_such_table')), undefined);
  assert.equal(demoTable({ catalog: 'main', schema: 'shop', name: 'orders_2026' }), undefined);
});

test('the demo tables contain a column of each type family', () => {
  const families = new Set(t26.columns.map((c) => c.family));
  for (const f of ['integer', 'decimal', 'float', 'string', 'boolean', 'date', 'timestamp', 'complex']) assert.ok(families.has(f as never), f);
});

test('the six planted differences are in the data', () => {
  const names25 = t25.columns.map((c) => c.name);
  const names26 = t26.columns.map((c) => c.name);
  // One column dropped, one added, one with a different type.
  assert.deepEqual(names25.filter((n) => !names26.includes(n)), ['coupon_code']);
  assert.deepEqual(names26.filter((n) => !names25.includes(n)), ['loyalty_tier']);
  assert.deepEqual(
    names25.filter((n) => names26.includes(n) && column(t25, n).typeText !== column(t26, n).typeText),
    ['store_id']
  );
  // A null rate that jumps.
  assert.ok(Math.abs(nullRate(column(t25, 'discount_pct')) - 0.05) < 0.01);
  assert.ok(Math.abs(nullRate(column(t26, 'discount_pct')) - 0.35) < 0.01);
  // A new category value.
  assert.ok(!column(t25, 'channel').values.includes('marketplace'));
  const share = column(t26, 'channel').values.filter((v) => v === 'marketplace').length / t26.rowCount;
  assert.ok(Math.abs(share - 0.12) < 0.01, `marketplace share ${share}`);
  // A shifted number distribution.
  const median = (c: DemoColumn) => (c.values.filter((v) => v !== null) as number[]).sort((a, b) => a - b)[Math.floor(c.values.length / 2)] as number;
  const ratio = median(column(t26, 'amount')) / median(column(t25, 'amount'));
  assert.ok(ratio > 1.25 && ratio < 1.45, `median ratio ${ratio}`);
  // A control column does not change.
  const mean = (c: DemoColumn) => (c.values as number[]).reduce((a, b) => a + b, 0) / c.values.length;
  assert.ok(Math.abs(mean(column(t26, 'weight_kg')) / mean(column(t25, 'weight_kg')) - 1) < 0.02);
});

test('formatDemoValue writes values as Databricks does', () => {
  const amount = column(t26, 'amount');
  assert.equal(formatDemoValue(amount, 1999), '19.99');
  assert.equal(formatDemoValue(amount, 5), '0.05');
  assert.equal(formatDemoValue(amount, -1999), '-19.99');
  assert.equal(formatDemoValue(amount, 500000), '5000.00');
  assert.equal(formatDemoValue(column(t26, 'order_date'), 20454), '2026-01-01');
  assert.equal(formatDemoValue(column(t26, 'order_ts'), Date.UTC(2026, 0, 1)), '2026-01-01T00:00:00.000Z');
  assert.equal(formatDemoValue(column(t26, 'is_gift'), true), 'true');
  assert.equal(formatDemoValue(column(t26, 'order_id'), 5_001_000_000), '5001000000');
});

test('tableDetails returns the columns and the table facts', async () => {
  const r = (await profiler.profile({ type: 'tableDetails', dataset: dataset('orders_2026') })) as ResultOf<'tableDetails'>;
  assert.equal(r.columns.length, 18);
  assert.deepEqual(r.columns[0], { name: 'order_id', typeText: 'bigint' });
  assert.deepEqual(r.partitionColumns, ['order_date']);
  assert.equal(r.columns.find((c) => c.name === 'order_date')?.partition, true);
  assert.equal(r.version, '42');
  assert.equal(r.sizeBytes, 3_771_332);
  assert.ok(resultSchema.safeParse(r).success);
});

test('overview numbers are equal to a direct count of the rows', async () => {
  for (const table of [t25, t26]) {
    const r = (await profiler.profile({
      type: 'overview',
      dataset: { profile: 'Demo', table: table.name },
      columns: table.columns.map((c) => ({ name: c.name, typeText: c.typeText })),
    })) as ResultOf<'overview'>;
    assert.ok(resultSchema.safeParse(r).success);
    assert.equal(r.rowCount, table.rowCount);
    assert.equal(r.approximate, false);
    for (const got of r.columns) {
      const c = column(table, got.name);
      const present = c.values.filter((v) => v !== null);
      assert.equal(got.nonNull, present.length, c.name);
      if (c.family === 'complex') {
        assert.deepEqual(Object.keys(got).sort(), ['name', 'nonNull'], c.name);
        continue;
      }
      assert.equal(got.distinct, new Set(present).size, c.name);
      if (c.family === 'string' || c.family === 'boolean') {
        assert.equal(got.min, undefined, c.name);
        continue;
      }
      const numbers = present as number[];
      const sorted = [...numbers].sort((a, b) => a - b);
      assert.equal(got.min, formatDemoValue(c, sorted[0] as number), c.name);
      assert.equal(got.max, formatDemoValue(c, sorted[sorted.length - 1] as number), c.name);
      if (c.family === 'date' || c.family === 'timestamp') {
        assert.equal(got.mean, undefined, c.name);
      } else {
        const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length / (c.family === 'decimal' ? 100 : 1);
        assert.ok(Math.abs((got.mean as number) - mean) < 1e-9 * Math.max(1, Math.abs(mean)), c.name);
      }
    }
  }
});

test('overview: known numbers of demo.shop.orders_2026', async () => {
  const r = (await profiler.profile({
    type: 'overview',
    dataset: dataset('orders_2026'),
    columns: ['order_id', 'channel', 'is_gift', 'quantity'].map((n) => ref(t26, n)),
  })) as ResultOf<'overview'>;
  const by = Object.fromEntries(r.columns.map((c) => [c.name, c]));
  assert.equal(by.order_id?.distinct, 110_000);
  assert.equal(by.order_id?.min, '5001000000');
  assert.equal(by.order_id?.max, '5001109999');
  assert.equal(by.channel?.distinct, 4);
  assert.equal(by.is_gift?.distinct, 2);
  assert.equal(by.quantity?.distinct, 7);
  assert.equal(by.quantity?.min, '1');
  assert.equal(by.quantity?.max, '8');
});

test('histogram: the counts add up to the rows that are not null', async () => {
  for (const [columnName, bins] of [['amount', 30], ['discount_pct', 20], ['weight_kg', 200], ['quantity', 5]] as const) {
    const c = column(t26, columnName);
    const numbers = (c.values.filter((v) => v !== null) as number[]).map((v) => (c.family === 'decimal' ? v / 100 : v));
    const edges = makeEdges(Math.min(...numbers), Math.max(...numbers), bins);
    const r = (await profiler.profile({ type: 'histogram', dataset: dataset('orders_2026'), columns: [ref(t26, columnName)], edges })) as ResultOf<'histogram'>;
    assert.equal(r.counts.length, edges.bins);
    assert.equal(r.below + r.above, 0, columnName);
    assert.equal(r.counts.reduce((a, b) => a + b, 0), numbers.length, columnName);
  }
  // Edges that are narrower than the data: the rest is "below" and "above".
  const amounts = (column(t26, 'amount').values as number[]).map((v) => v / 100);
  const r = (await profiler.profile({
    type: 'histogram',
    dataset: dataset('orders_2026'),
    columns: [ref(t26, 'amount')],
    edges: { lo: 20, hi: 100, bins: 8 },
  })) as ResultOf<'histogram'>;
  assert.equal(r.below, amounts.filter((v) => v < 20).length);
  assert.equal(r.above, amounts.filter((v) => v > 100).length);
  assert.equal(r.below + r.above + r.counts.reduce((a, b) => a + b, 0), amounts.length);
  assert.equal(r.counts[0], amounts.filter((v) => v >= 20 && v < 30).length);
});

test('frequency: the most frequent values, with nulls apart', async () => {
  const r = (await profiler.profile({ type: 'frequency', dataset: dataset('orders_2026'), columns: [ref(t26, 'status')], top: 3 })) as ResultOf<'frequency'>;
  const values = column(t26, 'status').values;
  assert.equal(r.rowCount, 110_000);
  assert.equal(r.nulls, values.filter((v) => v === null).length);
  assert.deepEqual(r.values.map((v) => v.value), ['delivered', 'shipped', 'cancelled']);
  assert.equal(r.values[0]?.count, values.filter((v) => v === 'delivered').length);

  const all = (await profiler.profile({ type: 'frequency', dataset: dataset('orders_2026'), columns: [ref(t26, 'quantity')], top: 50 })) as ResultOf<'frequency'>;
  assert.equal(all.nulls + all.values.reduce((a, v) => a + v.count, 0), 110_000);
  assert.equal(all.values.length, 7);
});

test('dateCounts: one bucket for each period, oldest first', async () => {
  for (const columnName of ['order_date', 'order_ts']) {
    const month = (await profiler.profile({ type: 'dateCounts', dataset: dataset('orders_2026'), columns: [ref(t26, columnName)], grain: 'month' })) as ResultOf<'dateCounts'>;
    assert.equal(month.buckets.length, 12, columnName);
    assert.equal(month.buckets[0]?.start, '2026-01-01');
    assert.equal(month.buckets[11]?.start, '2026-12-01');
    assert.equal(month.buckets.reduce((a, b) => a + b.count, 0), 110_000);
    const january = column(t26, 'order_date').values.filter((d) => (d as number) < Date.UTC(2026, 1, 1) / 86_400_000).length;
    assert.equal(month.buckets[0]?.count, january);
  }
  const year = (await profiler.profile({ type: 'dateCounts', dataset: dataset('orders_2025'), columns: [ref(t25, 'order_date')], grain: 'year' })) as ResultOf<'dateCounts'>;
  assert.deepEqual(year.buckets, [{ start: '2025-01-01', count: 100_000 }]);
});

test('the profiler gives a clear error for a bad request', async () => {
  const bad = [
    profiler.profile({ type: 'tableDetails', dataset: dataset('orders_1999') }),
    profiler.profile({ type: 'overview', dataset: dataset('orders_2026'), columns: [{ name: 'no_such_column', typeText: 'int' }] }),
    profiler.profile({ type: 'histogram', dataset: dataset('orders_2026'), columns: [ref(t26, 'region')], edges: { lo: 0, hi: 1, bins: 2 } }),
    profiler.profile({ type: 'frequency', dataset: dataset('orders_2026'), columns: [ref(t26, 'items')], top: 5 }),
    profiler.profile({ type: 'dateCounts', dataset: dataset('orders_2026'), columns: [ref(t26, 'amount')], grain: 'day' }),
    profiler.profile({ type: 'tableDetails', dataset: { ...dataset('orders_2026'), filter: "region = 'EMEA'" } }),
  ];
  for (const p of bad) await assert.rejects(p, ProfilerError);
});

/** Make a dispatcher that collects the messages that it sends. */
function harness(profilerFor: (profile: string) => Profiler) {
  const sent: ToWebview[] = [];
  const ready: unknown[] = [];
  const dispatcher = createDispatcher({
    profilerFor,
    post: (m) => sent.push(m),
    makeSignal: () => {
      const c = new AbortController();
      return { signal: c.signal, cancel: () => c.abort() };
    },
    onOther: (m) => void ready.push(m),
  });
  return { dispatcher, sent, ready };
}

test('dispatcher: a request gets progress, then a result', async () => {
  const { dispatcher, sent, ready } = harness(() => profiler);
  await dispatcher.handle({ type: 'ready' });
  assert.deepEqual(ready, [{ type: 'ready' }]);
  await dispatcher.handle({ type: 'request', id: 'r1', request: { type: 'tableDetails', dataset: dataset('orders_2026') } });
  assert.deepEqual(sent.map((m) => m.type), ['progress', 'result']);
  for (const m of sent) assert.ok(toWebviewSchema.safeParse(m).success);
  assert.equal(dispatcher.exchanges.length, 1);
  assert.equal(dispatcher.exchanges[0]?.response?.type, 'result');
});

test('dispatcher: errors, unknown profiles and bad messages', async () => {
  const { dispatcher, sent } = harness((profile) => {
    if (profile !== 'Demo') throw new ProfilerError(`The profile ${profile} cannot be used.`, { nextStep: 'Select the Demo profile.' });
    return profiler;
  });
  await dispatcher.handle({ type: 'request', id: 'r1', request: { type: 'tableDetails', dataset: dataset('orders_1999') } });
  await dispatcher.handle({ type: 'request', id: 'r2', request: { type: 'tableDetails', dataset: { ...dataset('orders_2026'), profile: 'prod' } } });
  await dispatcher.handle({ type: 'request', id: 'r3', request: { type: 'runSql', sql: 'DROP TABLE x' } });
  await dispatcher.handle('not a message');
  const errors = sent.filter((m) => m.type === 'error');
  assert.equal(errors.length, 2);
  assert.match(errors[0]?.message ?? '', /orders_1999 does not exist/);
  assert.equal(errors[1]?.nextStep, 'Select the Demo profile.');
  assert.equal(dispatcher.exchanges.length, 2, 'a message with a bad shape is ignored');

  // An error that is not a ProfilerError does not show its text as the main message.
  const broken = harness(() => ({ profile: async () => { throw new TypeError('boom'); } }));
  await broken.dispatcher.handle({ type: 'request', id: 'r4', request: { type: 'tableDetails', dataset: dataset('orders_2026') } });
  assert.deepEqual(broken.sent[0], { type: 'error', id: 'r4', message: 'The request failed.', raw: 'boom', sql: [] });
});

test('dispatcher: cancel stops a request that runs', async () => {
  // A profiler that waits until the signal fires.
  const slow: Profiler = {
    profile: (_request, options) =>
      new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new CancelledError()))),
  };
  const { dispatcher, sent } = harness(() => slow);
  const done = dispatcher.handle({ type: 'request', id: 'r1', request: { type: 'tableDetails', dataset: dataset('orders_2026') } });
  await dispatcher.handle({ type: 'cancel', id: 'no-such-request' });
  await dispatcher.handle({ type: 'cancel', id: 'r1' });
  await done;
  assert.deepEqual(sent, [{ type: 'cancelled', id: 'r1' }]);

  const second = harness(() => slow);
  const pending = second.dispatcher.handle({ type: 'request', id: 'r2', request: { type: 'tableDetails', dataset: dataset('orders_2026') } });
  second.dispatcher.cancelAll();
  await pending;
  assert.deepEqual(second.sent, [{ type: 'cancelled', id: 'r2' }]);
});

test('numericStats: equal to a direct computation', async () => {
  const { percentileOf } = await import('../../../src/tableViz/demo/demoProfiler.ts');
  assert.equal(percentileOf([10, 20, 30, 40], 0.5), 25);
  assert.equal(percentileOf([10, 20, 30, 40], 0), 10);
  assert.equal(percentileOf([10, 20, 30, 40], 1), 40);
  assert.equal(percentileOf([7], 0.99), 7);

  for (const columnName of ['amount', 'discount_pct', 'quantity', 'weight_kg']) {
    const c = column(t26, columnName);
    const numbers = (c.values.filter((v) => v !== null) as number[]).map((v) => (c.family === 'decimal' ? v / 100 : v)).sort((a, b) => a - b);
    const r = (await profiler.profile({ type: 'numericStats', dataset: dataset('orders_2026'), columns: [ref(t26, columnName)] })) as ResultOf<'numericStats'>;
    assert.ok(resultSchema.safeParse(r).success);
    assert.equal(r.rowCount, 110_000);
    assert.equal(r.nonNull, numbers.length, columnName);
    assert.equal(r.zeros, numbers.filter((x) => x === 0).length, columnName);
    assert.equal(r.negatives, 0);
    assert.equal(Number(r.min), numbers[0], columnName);
    assert.equal(Number(r.max), numbers[numbers.length - 1], columnName);
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    assert.ok(Math.abs((r.mean as number) - mean) < 1e-9 * Math.abs(mean), columnName);
    const variance = numbers.reduce((a, x) => a + (x - mean) ** 2, 0) / (numbers.length - 1);
    assert.ok(Math.abs((r.stddev as number) - Math.sqrt(variance)) < 1e-9 * Math.sqrt(variance), columnName);
    assert.deepEqual(r.percentiles.map((x) => x.p), [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99]);
    // The median is between the two middle values.
    const median = r.percentiles[3]?.value as number;
    assert.ok(median >= (numbers[Math.floor((numbers.length - 1) / 2)] as number) && median <= (numbers[Math.ceil((numbers.length - 1) / 2)] as number), columnName);
    // The percentiles do not decrease.
    for (let i = 1; i < r.percentiles.length; i++) assert.ok((r.percentiles[i]?.value as number) >= (r.percentiles[i - 1]?.value as number));
  }
  // A decimal keeps its digits in min and max.
  const amount = (await profiler.profile({ type: 'numericStats', dataset: dataset('orders_2026'), columns: [ref(t26, 'amount')] })) as ResultOf<'numericStats'>;
  assert.match(amount.min as string, /^\d+\.\d{2}$/);
});

test('numericStats and histogram can measure the length of the values', async () => {
  const stats = (await profiler.profile({ type: 'numericStats', dataset: dataset('orders_2026'), columns: [ref(t26, 'customer_id')], measure: 'length' })) as ResultOf<'numericStats'>;
  assert.equal(stats.min, '6'); // 'C' and five digits
  assert.equal(stats.max, '6');
  assert.equal(stats.stddev, 0);
  const coupon = (await profiler.profile({ type: 'numericStats', dataset: dataset('orders_2025'), columns: [ref(t25, 'coupon_code')], measure: 'length' })) as ResultOf<'numericStats'>;
  assert.equal(coupon.nonNull, column(t25, 'coupon_code').values.filter((v) => v !== null).length);
  assert.equal(coupon.min, '7'); // 'SAVE' and three digits
  const h = (await profiler.profile({
    type: 'histogram',
    dataset: dataset('orders_2026'),
    columns: [ref(t26, 'order_id')],
    edges: makeEdges(10, 10, 30),
    measure: 'length',
  })) as ResultOf<'histogram'>;
  assert.deepEqual(h.counts, [110_000]);
  await assert.rejects(profiler.profile({ type: 'numericStats', dataset: dataset('orders_2026'), columns: [ref(t26, 'items')], measure: 'length' }), ProfilerError);
  await assert.rejects(profiler.profile({ type: 'numericStats', dataset: dataset('orders_2026'), columns: [ref(t26, 'region')] }), ProfilerError);
});

test('each result contains the SQL of its request', async () => {
  const r = await profiler.profile({ type: 'frequency', dataset: dataset('orders_2026'), columns: [ref(t26, 'region')], top: 20 });
  assert.equal(r.sql.length, 1);
  assert.match(r.sql[0] as string, /^-- :c0 = '`region`'\n-- :tbl = '`demo`.`shop`.`orders_2026`'\n-- :limit = 21\nSELECT/);
});
