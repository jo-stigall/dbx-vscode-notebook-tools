/**
 * The two demo tables: demo.shop.orders_2025 and demo.shop.orders_2026.
 *
 * The file makes the rows from a fixed seed, so the tables are the same on
 * each run. The tables have a column of each kind that the feature shows.
 *
 * The 2026 table is different from the 2025 table in six known ways. Compare
 * mode must find them:
 *
 * | Column        | Difference in 2026                                   |
 * |---------------|------------------------------------------------------|
 * | amount        | The values are higher (the median is about 35% more). |
 * | channel       | A new value: "marketplace".                          |
 * | discount_pct  | 35% of the rows are null. In 2025: 5%.               |
 * | coupon_code   | The column does not exist.                           |
 * | loyalty_tier  | The column is new.                                   |
 * | store_id      | The type is string. In 2025: int.                    |
 *
 * All other columns have the same distribution in the two tables.
 */
import { formatDay } from '../core/bins.ts';
import { typeFamily, type TypeFamily } from '../core/kinds.ts';
import type { TableName } from '../core/schema.ts';
import { makeRng, normal, weighted, type Rng } from './random.ts';

/**
 * One value in a demo column.
 *
 * | Type family | How the value is stored                     | Example                      |
 * |-------------|---------------------------------------------|------------------------------|
 * | integer     | number                                      | 3                            |
 * | decimal     | number of the smallest unit (`scale` digits) | 1999 for 19.99               |
 * | float       | number                                      | 2.5                          |
 * | string      | string                                      | 'EMEA'                       |
 * | boolean     | boolean                                     | true                         |
 * | date        | days after 1970-01-01                       | 20454 for 2026-01-01         |
 * | timestamp   | milliseconds after 1970-01-01               | 1767225600000                |
 * | complex     | 1 (the column has a value)                  | 1                            |
 *
 * null is a null in the table.
 */
export type DemoValue = number | string | boolean | null;

/**
 * One column of a demo table, with the value of each row.
 *
 * @example
 * // The column `amount` of demo.shop.orders_2026. The first row has the amount 23.16.
 * // { name: 'amount', typeText: 'decimal(10,2)', family: 'decimal', scale: 2, partition: false, values: [2316, ...] }
 */
export interface DemoColumn {
  name: string;
  /** The Databricks type. Example: 'decimal(10,2)'. */
  typeText: string;
  /** The group of the type, from typeFamily() in core/kinds.ts. It decides how `values` stores a value. */
  family: TypeFamily;
  /** For decimal columns: the number of digits after the decimal point. 0 for all other columns. */
  scale: number;
  /** true if this is a partition column of the table. */
  partition: boolean;
  /** One value for each row of the table. See DemoValue. */
  values: DemoValue[];
}

/** One demo table in memory: its columns with all values, and the facts that "tableDetails" reports. */
export interface DemoTable {
  name: TableName;
  /** The number of rows. Each column has this number of values. */
  rowCount: number;
  columns: DemoColumn[];
  /** The size that the board shows for the table. It is a fixed number, not the size of the rows in memory. */
  sizeBytes: number;
  /** The time of the last change, as ISO 8601 text. A fixed value. */
  lastModified: string;
  /** The Delta version. A fixed value. */
  version: string;
}

/** The number of milliseconds in one day. */
const DAY_MS = 86_400_000;

/**
 * Write a number with zeros in front, until it has `width` characters.
 *
 * @example
 * pad(7, 3)   // '007'
 */
const pad = (n: number, width: number) => String(n).padStart(width, '0');

/** The settings that are different between the two tables. */
interface Variant {
  /** All orders of the table are in this year. */
  year: number;
  /** The number of rows. */
  rows: number;
  /** The seed of the random numbers. The same seed gives the same rows. */
  seed: number;
  /** The median of `amount` is exp(amountMu). */
  amountMu: number;
  /** The values of `channel`, each with its weight. A larger weight gives more rows. */
  channels: readonly (readonly [string, number])[];
  /** The part of the rows in which `discount_pct` is null, from 0 to 1. */
  discountNullRate: number;
  /** true: `store_id` is a string such as 'S037'. false: it is an int such as 37. */
  storeIdAsString: boolean;
  /** true: the table has the column `coupon_code`. */
  hasCouponCode: boolean;
  /** true: the table has the column `loyalty_tier`. */
  hasLoyaltyTier: boolean;
  /** `sizeBytes`, `lastModified` and `version` go to the DemoTable as they are. */
  sizeBytes: number;
  lastModified: string;
  version: string;
}

/** The settings of the two demo tables. The key is the last part of the table name. */
const VARIANTS: Record<string, Variant> = {
  orders_2025: {
    year: 2025,
    rows: 100_000,
    seed: 2025,
    amountMu: 3.6,
    channels: [['web', 60], ['store', 30], ['phone', 10]],
    discountNullRate: 0.05,
    storeIdAsString: false,
    hasCouponCode: true,
    hasLoyaltyTier: false,
    sizeBytes: 3_412_774,
    lastModified: '2026-01-02T03:14:00.000Z',
    version: '7',
  },
  orders_2026: {
    year: 2026,
    rows: 110_000,
    seed: 2026,
    amountMu: 3.9,
    channels: [['web', 55], ['store', 25], ['phone', 8], ['marketplace', 12]],
    discountNullRate: 0.35,
    storeIdAsString: true,
    hasCouponCode: false,
    hasLoyaltyTier: true,
    sizeBytes: 3_771_332,
    lastModified: '2026-11-01T02:05:00.000Z',
    version: '42',
  },
};

/**
 * Select a time in the year. Saturdays and Sundays get about half of the orders of a weekday.
 *
 * @param yearStart  The start of the year, in milliseconds after 1970-01-01.
 * @param yearDays  The number of days of the year: 365 or 366.
 * @returns The time, in milliseconds after 1970-01-01 (UTC).
 */
function orderTime(rng: Rng, yearStart: number, yearDays: number): number {
  for (;;) {
    const ms = yearStart + Math.floor(rng() * yearDays * DAY_MS);
    const weekday = new Date(ms).getUTCDay();
    if ((weekday !== 0 && weekday !== 6) || rng() < 0.5) return ms;
  }
}

/**
 * Make all rows of one demo table from the seed of its variant.
 *
 * The function makes the rows one after the other and takes the random
 * numbers of all columns from one generator. Thus, if you change how one
 * column uses the random numbers, the values of the other columns change too.
 *
 * @example
 * const table = generate('orders_2026', VARIANTS.orders_2026);
 * table.rowCount                       // 110000
 * table.columns.map((c) => c.name)     // ['order_id', 'customer_id', 'order_ts', 'order_date', 'amount', ...]
 * table.columns[0].values[0]           // 5001000000: the first `order_id` of 2026
 *
 * @param tableName  The last part of the table name: 'orders_2025' or 'orders_2026'.
 */
function generate(tableName: string, v: Variant): DemoTable {
  const rng = makeRng(v.seed);
  const yearStart = Date.UTC(v.year, 0, 1);
  const yearDays = (Date.UTC(v.year + 1, 0, 1) - yearStart) / DAY_MS;

  const defs: [string, string, boolean?][] = [
    ['order_id', 'bigint'],
    ['customer_id', 'string'],
    ['order_ts', 'timestamp'],
    ['order_date', 'date', true],
    ['amount', 'decimal(10,2)'],
    ['quantity', 'int'],
    ['region', 'string'],
    ['channel', 'string'],
    ['status', 'string'],
    ['is_gift', 'boolean'],
    ['discount_pct', 'double'],
    ['weight_kg', 'double'],
    ['delivery_days', 'int'],
    ['postal_code', 'int'],
    ['store_id', v.storeIdAsString ? 'string' : 'int'],
    ...(v.hasCouponCode ? ([['coupon_code', 'string']] as [string, string][]) : []),
    ...(v.hasLoyaltyTier ? ([['loyalty_tier', 'string']] as [string, string][]) : []),
    ['items', 'array<string>'],
    ['shipping', 'struct<carrier:string,express:boolean>'],
  ];
  const columns: DemoColumn[] = defs.map(([name, typeText, partition]) => ({
    name,
    typeText,
    family: typeFamily(typeText),
    scale: typeText.startsWith('decimal') ? 2 : 0,
    partition: partition === true,
    values: new Array<DemoValue>(v.rows),
  }));
  const col = (name: string) => (columns.find((c) => c.name === name) as DemoColumn).values;
  const firstOrderId = 5_000_000_000 + (v.year - 2025) * 1_000_000;

  for (let i = 0; i < v.rows; i++) {
    const ts = orderTime(rng, yearStart, yearDays);
    col('order_id')[i] = firstOrderId + i;
    // rng() ** 2 makes some customers order much more frequently than others.
    col('customer_id')[i] = 'C' + pad(Math.floor(rng() ** 2 * 40_000), 5);
    col('order_ts')[i] = ts;
    col('order_date')[i] = Math.floor(ts / DAY_MS);
    col('amount')[i] = Math.min(500_000, Math.max(100, Math.round(Math.exp(v.amountMu + 0.7 * normal(rng)) * 100)));
    col('quantity')[i] = weighted(rng, [[1, 50], [2, 25], [3, 12], [4, 6], [5, 4], [6, 2], [8, 1]]);
    col('region')[i] = weighted(rng, [['AMER', 40], ['EMEA', 35], ['APAC', 18], ['LATAM', 7]]);
    col('channel')[i] = weighted(rng, v.channels);
    col('status')[i] = rng() < 0.01 ? null : weighted(rng, [['delivered', 82], ['shipped', 9], ['cancelled', 5], ['returned', 4]]);
    col('is_gift')[i] = rng() < 0.08;
    col('discount_pct')[i] = rng() < v.discountNullRate ? null : Math.round(rng() * 500) / 10;
    col('weight_kg')[i] = Math.round((0.1 - Math.log(1 - rng()) * 2.5) * 1000) / 1000;
    col('delivery_days')[i] = rng() < 0.03 ? null : 1 + Math.floor((rng() + rng() + rng()) * (14 / 3));
    col('postal_code')[i] = 10_000 + Math.floor(rng() ** 1.5 * 900) * 10;
    const store = 1 + Math.floor(rng() * 40);
    col('store_id')[i] = v.storeIdAsString ? 'S' + pad(store, 3) : store;
    if (v.hasCouponCode) col('coupon_code')[i] = rng() < 0.7 ? null : 'SAVE' + pad(Math.floor(rng() * 200), 3);
    if (v.hasLoyaltyTier) col('loyalty_tier')[i] = weighted(rng, [['none', 50], ['bronze', 25], ['silver', 17], ['gold', 8]]);
    col('items')[i] = rng() < 0.02 ? null : 1;
    col('shipping')[i] = rng() < 0.01 ? null : 1;
  }

  return {
    name: { catalog: 'demo', schema: 'shop', name: tableName },
    rowCount: v.rows,
    columns,
    sizeBytes: v.sizeBytes,
    lastModified: v.lastModified,
    version: v.version,
  };
}

/** The demo tables that demoTable() made already. The key is the last part of the table name, for example 'orders_2026'. */
const cache = new Map<string, DemoTable>();

/** The names of the demo tables: demo.shop.orders_2025 and demo.shop.orders_2026. */
export const DEMO_TABLE_NAMES: TableName[] = Object.keys(VARIANTS).map((name) => ({ catalog: 'demo', schema: 'shop', name }));

/**
 * Get a demo table. The function makes the rows the first time that you ask for the table.
 *
 * @example
 * demoTable({ catalog: 'demo', schema: 'shop', name: 'orders_2026' })?.rowCount   // 110000
 *
 * @returns The table, or undefined if no demo table has this name.
 */
export function demoTable(name: TableName): DemoTable | undefined {
  const variant = name.catalog === 'demo' && name.schema === 'shop' ? VARIANTS[name.name] : undefined;
  if (!variant) return undefined;
  let table = cache.get(name.name);
  if (!table) cache.set(name.name, (table = generate(name.name, variant)));
  return table;
}

/**
 * Write a stored value as Databricks writes it in a result.
 *
 * @example
 * // amountColumn has the type decimal(10,2), dateColumn the type date, tsColumn the type timestamp.
 * formatDemoValue(amountColumn, 1999)        // '19.99'
 * formatDemoValue(dateColumn, 20454)         // '2026-01-01'
 * formatDemoValue(tsColumn, 1767225600000)   // '2026-01-01T00:00:00.000Z'
 * formatDemoValue(regionColumn, 'EMEA')      // 'EMEA'
 *
 * @param value  A value of the column, in the form that DemoValue describes. Not null.
 */
export function formatDemoValue(column: DemoColumn, value: Exclude<DemoValue, null>): string {
  switch (column.family) {
    case 'decimal': {
      const n = value as number;
      const digits = pad(Math.abs(n), column.scale + 1);
      return (n < 0 ? '-' : '') + digits.slice(0, -column.scale) + '.' + digits.slice(-column.scale);
    }
    case 'date':
      return formatDay(value as number);
    case 'timestamp':
      return new Date(value as number).toISOString();
    default:
      return String(value);
  }
}
