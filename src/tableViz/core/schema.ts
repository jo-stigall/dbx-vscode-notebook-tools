/**
 * The shapes of all data that goes between the webview and the extension host.
 *
 * Each shape is a zod schema. The TypeScript types come from the schemas, so
 * the types and the checks cannot be different. The host and the webview
 * check each message with these schemas before they use it.
 *
 * The data model has three levels:
 *
 * - A Dataset is a table plus an optional filter, version and sample.
 * - A Request asks for one aggregate of a dataset, for example a histogram.
 * - A Result is the answer to one Request.
 *
 * @example
 * const request = requestSchema.parse({
 *   type: 'histogram',
 *   dataset: { profile: 'Demo', table: { catalog: 'demo', schema: 'shop', name: 'orders_2026' } },
 *   columns: [{ name: 'amount', typeText: 'decimal(10,2)' }],
 *   edges: { lo: 0, hi: 500, bins: 30 },
 * });
 */
import * as z from 'zod';

/** A table name with three parts. Example: main.sales.orders. */
export const tableNameSchema = z.strictObject({
  catalog: z.string().min(1),
  schema: z.string().min(1),
  name: z.string().min(1),
});
export type TableName = z.infer<typeof tableNameSchema>;

/** A Delta version of a table: a version number or a time. */
export const datasetVersionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('version'), n: z.string().regex(/^\d+$/) }),
  z.strictObject({ kind: z.literal('timestamp'), ts: z.string().min(1) }),
]);
export type DatasetVersion = z.infer<typeof datasetVersionSchema>;

/**
 * A table or view plus three optional modifiers. All charts and tables in the
 * feature show a dataset.
 *
 * `profile` is the name of the Databricks login. It is part of the dataset so
 * that a later version can compare two workspaces.
 */
export const datasetSchema = z.strictObject({
  profile: z.string().min(1),
  table: tableNameSchema,
  /** A SQL boolean expression. Example: "region = 'EMEA'". */
  filter: z.string().optional(),
  version: datasetVersionSchema.optional(),
  /** When set, queries read this percent of the rows, and counts are estimates. */
  sample: z.strictObject({ percent: z.number().gt(0).lte(100) }).optional(),
});
export type Dataset = z.infer<typeof datasetSchema>;

/** How the feature shows a column. See detectKind() in kinds.ts. */
export const columnKindSchema = z.enum(['continuous', 'discrete', 'category', 'identifier', 'date', 'complex']);
export type ColumnKind = z.infer<typeof columnKindSchema>;

/** A column in a request: its name and its Databricks type, for example "decimal(10,2)". */
export const columnRefSchema = z.strictObject({ name: z.string().min(1), typeText: z.string().min(1) });
export type ColumnRef = z.infer<typeof columnRefSchema>;

/** One column of a table, as the table overview shows it. */
export const columnInfoSchema = z.strictObject({
  name: z.string(),
  typeText: z.string(),
  comment: z.string().optional(),
  partition: z.boolean().optional(),
});
export type ColumnInfo = z.infer<typeof columnInfoSchema>;

/** The bins of a histogram: `bins` bins of equal width from `lo` to `hi`. See bins.ts. */
export const binEdgesSchema = z.strictObject({
  lo: z.number(),
  hi: z.number(),
  bins: z.number().int().min(1).max(200),
});
export type BinEdges = z.infer<typeof binEdgesSchema>;

export const grainSchema = z.enum(['day', 'week', 'month', 'year']);
export type Grain = z.infer<typeof grainSchema>;

const oneColumn = z.tuple([columnRefSchema]);

/**
 * A question about a dataset. Each request type becomes one aggregate query.
 *
 * `columns` is a list in each request, so that a later version can add
 * requests about two columns together.
 */
export const requestSchema = z.discriminatedUnion('type', [
  /** The columns of the table, its size, its last change and its partition columns. */
  z.strictObject({ type: z.literal('tableDetails'), dataset: datasetSchema }),
  /** The row count, plus the null count, distinct count, min, max and mean of each column. */
  z.strictObject({ type: z.literal('overview'), dataset: datasetSchema, columns: z.array(columnRefSchema).min(1).max(50) }),
  /** The number of rows in each bin of a number column. */
  z.strictObject({ type: z.literal('histogram'), dataset: datasetSchema, columns: oneColumn, edges: binEdgesSchema }),
  /** The most frequent values of a column and their counts. */
  z.strictObject({ type: z.literal('frequency'), dataset: datasetSchema, columns: oneColumn, top: z.number().int().min(1).max(1000) }),
  /** The number of rows in each day, week, month or year of a date column. */
  z.strictObject({ type: z.literal('dateCounts'), dataset: datasetSchema, columns: oneColumn, grain: grainSchema }),
]);
export type Request = z.infer<typeof requestSchema>;
export type RequestOf<T extends Request['type']> = Extract<Request, { type: T }>;

/** The fields that each result has. */
const resultBase = {
  /** The SQL statements that gave the numbers. Empty if no SQL ran. */
  sql: z.array(z.string()),
  /** true if a number in the result is an estimate, for example an approximate distinct count. */
  approximate: z.boolean(),
  /** The time of the data: when the query ran. ISO 8601. */
  asOf: z.string(),
};

/** The numbers of one column in the table overview. Values are strings so that large integers and decimals stay exact. */
export const overviewColumnSchema = z.strictObject({
  name: z.string(),
  /** The number of rows where the column is not null. */
  nonNull: z.number(),
  /** The number of different values. Not set for types that cannot be counted, such as map. */
  distinct: z.number().optional(),
  min: z.string().optional(),
  max: z.string().optional(),
  /** Numbers only. */
  mean: z.number().optional(),
});
export type OverviewColumn = z.infer<typeof overviewColumnSchema>;

export const resultSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...resultBase,
    type: z.literal('tableDetails'),
    columns: z.array(columnInfoSchema),
    tableType: z.enum(['table', 'view']),
    format: z.string().optional(),
    sizeBytes: z.number().optional(),
    lastModified: z.string().optional(),
    partitionColumns: z.array(z.string()),
    /** The Delta version that all queries of this dataset read. */
    version: z.string().optional(),
  }),
  z.strictObject({ ...resultBase, type: z.literal('overview'), rowCount: z.number(), columns: z.array(overviewColumnSchema) }),
  z.strictObject({
    ...resultBase,
    type: z.literal('histogram'),
    /** One count for each bin. */
    counts: z.array(z.number()),
    /** The number of values less than `edges.lo`. */
    below: z.number(),
    /** The number of values greater than `edges.hi`. */
    above: z.number(),
  }),
  z.strictObject({
    ...resultBase,
    type: z.literal('frequency'),
    /** All rows of the dataset, nulls included. */
    rowCount: z.number(),
    nulls: z.number(),
    /** The most frequent values, most frequent first. The list does not contain null. */
    values: z.array(z.strictObject({ value: z.string(), count: z.number() })),
  }),
  z.strictObject({
    ...resultBase,
    type: z.literal('dateCounts'),
    grain: grainSchema,
    /** One entry for each period that has rows, oldest first. `start` is the first day of the period, as YYYY-MM-DD. */
    buckets: z.array(z.strictObject({ start: z.string(), count: z.number() })),
  }),
]);
export type Result = z.infer<typeof resultSchema>;
export type ResultOf<T extends Result['type']> = Extract<Result, { type: T }>;

/** The datasets of one board. B is set in compare mode only. */
export const boardDatasetsSchema = z.strictObject({ a: datasetSchema, b: datasetSchema.optional() });
export type BoardDatasets = z.infer<typeof boardDatasetsSchema>;

/** What the webview stores so that a board comes back after a window reload. It contains no data and no token. */
export const boardStateSchema = z.strictObject({
  datasets: boardDatasetsSchema,
  ui: z.strictObject({ search: z.string(), sort: z.enum(['table', 'nulls', 'distinct']) }).optional(),
});
export type BoardState = z.infer<typeof boardStateSchema>;

/** A message from the webview to the extension host. */
export const toHostSchema = z.discriminatedUnion('type', [
  /** The webview started and can receive messages. */
  z.strictObject({ type: z.literal('ready') }),
  /** Run a request. `refresh: true` ignores the cache. */
  z.strictObject({ type: z.literal('request'), id: z.string().min(1), request: requestSchema, refresh: z.boolean().optional() }),
  /** Stop the request with this id. */
  z.strictObject({ type: z.literal('cancel'), id: z.string().min(1) }),
]);
export type ToHost = z.infer<typeof toHostSchema>;

/** A message from the extension host to the webview. */
export const toWebviewSchema = z.discriminatedUnion('type', [
  /** The answer to "ready": the datasets that the board shows. */
  z.strictObject({ type: z.literal('init'), datasets: boardDatasetsSchema }),
  z.strictObject({ type: z.literal('result'), id: z.string(), result: resultSchema }),
  z.strictObject({ type: z.literal('progress'), id: z.string(), state: z.enum(['queued', 'running']), statementId: z.string().optional() }),
  z.strictObject({
    type: z.literal('error'),
    id: z.string(),
    /** A plain message. Example: "The table does not exist." */
    message: z.string(),
    /** What the user can do. Example: "Check the name of the table." */
    nextStep: z.string().optional(),
    /** The error text from Databricks. */
    raw: z.string(),
    sql: z.array(z.string()),
  }),
  z.strictObject({ type: z.literal('cancelled'), id: z.string() }),
]);
export type ToWebview = z.infer<typeof toWebviewSchema>;
