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
  // The builders write this text into the SQL statement, so the schema permits only the characters of a date and a time.
  z.strictObject({
    kind: z.literal('timestamp'),
    ts: z.string().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/),
  }),
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
  sample: z.strictObject({ percent: z.number().gte(0.01).lte(100) }).optional(),
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
 * What a request measures in a column.
 *
 * - 'value': the value, for a number column.
 * - 'length': the number of characters of the value as text. The card of an
 *   identifier column shows a histogram of the lengths.
 * - 'day': the date of the value, as a number of days after 1970-01-01. The
 *   drift score of a date column uses it.
 */
export const measureSchema = z.enum(['value', 'length', 'day']);
export type Measure = z.infer<typeof measureSchema>;

/** The percentiles in the statistics of a number column. */
export const PERCENTILES = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99] as const;

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
  z.strictObject({
    type: z.literal('overview'),
    dataset: datasetSchema,
    columns: z.array(columnRefSchema).min(1).max(50),
    /** true: count the different values exactly. This is slower. */
    exact: z.boolean().optional(),
  }),
  /** The count, the mean, the percentiles and other statistics of a number column. */
  z.strictObject({
    type: z.literal('numericStats'),
    dataset: datasetSchema,
    columns: oneColumn,
    measure: measureSchema.optional(),
    /** true: compute the percentiles exactly. This is slower. */
    exact: z.boolean().optional(),
  }),
  /** The number of rows in each bin of a number column. */
  z.strictObject({ type: z.literal('histogram'), dataset: datasetSchema, columns: oneColumn, edges: binEdgesSchema, measure: measureSchema.optional() }),
  /** The most frequent values of a column and their counts. */
  z.strictObject({ type: z.literal('frequency'), dataset: datasetSchema, columns: oneColumn, top: z.number().int().min(1).max(1000) }),
  /** The number of rows in each day, week, month or year of a date column. */
  z.strictObject({ type: z.literal('dateCounts'), dataset: datasetSchema, columns: oneColumn, grain: grainSchema }),
  /** Check that Databricks can read the filter of the dataset. The request reads no rows. */
  z.strictObject({ type: z.literal('validateFilter'), dataset: datasetSchema }),
  /** The values below which a given part of the rows is. Compare mode asks for the nine deciles of dataset A. */
  z.strictObject({
    type: z.literal('quantiles'),
    dataset: datasetSchema,
    columns: oneColumn,
    measure: measureSchema.optional(),
    /** Each number is more than 0 and less than 1. Example: [0.1, 0.2, ..., 0.9]. */
    probabilities: z.array(z.number().gt(0).lt(1)).min(1).max(20),
  }),
  /** The number of rows between each two cut points. Compare mode uses the same cut points for A and B. */
  z.strictObject({
    type: z.literal('driftBins'),
    dataset: datasetSchema,
    columns: oneColumn,
    measure: measureSchema.optional(),
    /** The cut points, smallest first. n cut points make n + 1 bins. */
    cuts: z.array(z.number()).min(1).max(20),
  }),
  /** The exact number of rows for each value in a list. Compare mode asks for the values that are in the top list of the other dataset only. */
  z.strictObject({ type: z.literal('valueCounts'), dataset: datasetSchema, columns: oneColumn, values: z.array(z.string()).min(1).max(200) }),
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
    type: z.literal('numericStats'),
    /** All rows of the dataset, nulls included. */
    rowCount: z.number(),
    nonNull: z.number(),
    zeros: z.number(),
    negatives: z.number(),
    /** min, max, mean and stddev are not set if all rows are null. */
    min: z.string().optional(),
    max: z.string().optional(),
    mean: z.number().optional(),
    /** The sample standard deviation. Not set if the column has fewer than two values. */
    stddev: z.number().optional(),
    /** One entry for each number in PERCENTILES. Example: { p: 0.5, value: 49.4 } is the median. */
    percentiles: z.array(z.strictObject({ p: z.number(), value: z.number() })),
  }),
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
  /** The filter is valid. If it is not valid, the request fails with an error that has the text from Databricks. */
  z.strictObject({ ...resultBase, type: z.literal('validateFilter') }),
  /** One value for each probability of the request. Empty if the column has no values. */
  z.strictObject({ ...resultBase, type: z.literal('quantiles'), values: z.array(z.number()) }),
  z.strictObject({
    ...resultBase,
    type: z.literal('driftBins'),
    rowCount: z.number(),
    nulls: z.number(),
    /** One count more than the request has cut points. Bin 0 has the values below the first cut point. */
    counts: z.array(z.number()),
  }),
  /** One entry for each value of the request, in the same sequence. A value that no row has gets the count 0. */
  z.strictObject({ ...resultBase, type: z.literal('valueCounts'), values: z.array(z.strictObject({ value: z.string(), count: z.number() })) }),
]);
export type Result = z.infer<typeof resultSchema>;
export type ResultOf<T extends Result['type']> = Extract<Result, { type: T }>;

/** The datasets of one board. B is set in compare mode only. */
export const boardDatasetsSchema = z.strictObject({ a: datasetSchema, b: datasetSchema.optional() });
export type BoardDatasets = z.infer<typeof boardDatasetsSchema>;

/** The settings of one detail card. A setting that is not set uses its default. */
export const cardSchema = z.strictObject({
  /** The name of the column that the card shows. */
  column: z.string(),
  /** true: the card stays on the board when you open a different column. */
  pinned: z.boolean(),
  /** The kind that the user selected. Not set: the feature decides the kind. */
  kind: columnKindSchema.optional(),
  bins: z.number().int().min(5).max(200).optional(),
  logScale: z.boolean().optional(),
  /** true: the histogram shows the range from the 1st to the 99th percentile. */
  clip: z.boolean().optional(),
  grain: grainSchema.optional(),
  sortBy: z.enum(['count', 'label']).optional(),
  /** true: the card shows the numbers of its chart as a table. */
  asTable: z.boolean().optional(),
  showSql: z.boolean().optional(),
  /** true: the card asked for exact numbers. */
  exact: z.boolean().optional(),
  /** Compare mode. true: the card shows one chart for A and one for B. false: one chart with the two datasets. */
  sideBySide: z.boolean().optional(),
  /** Compare mode. true: the charts show the number of rows. false: they show the percent of the rows of each dataset. */
  rawCounts: z.boolean().optional(),
});
export type Card = z.infer<typeof cardSchema>;

/** The settings of the feature that the webview needs. They come from the VS Code settings. */
export const boardSettingsSchema = z.strictObject({
  /** The number of bins of a new histogram. */
  defaultBins: z.number().int().min(5).max(200),
  /** The number of values in a category chart. */
  topValues: z.number().int().min(1).max(100),
  /** The board asks before the first full scan of a table that is larger than this number of bytes. */
  largeTableBytes: z.number().positive(),
  /** true: compare mode matches 'Region' with 'Region' only. false: it matches 'Region' with 'region' also. */
  matchColumnsCaseSensitive: z.boolean(),
});
export type BoardSettings = z.infer<typeof boardSettingsSchema>;
export const DEFAULT_SETTINGS: BoardSettings = { defaultBins: 30, topValues: 20, largeTableBytes: 100 * 1024 ** 3, matchColumnsCaseSensitive: false };

/** What the webview stores so that a board comes back after a window reload. It contains no data and no token. */
export const boardStateSchema = z.strictObject({
  datasets: boardDatasetsSchema,
  ui: z.strictObject({ search: z.string(), sort: z.enum(['table', 'nulls', 'distinct', 'drift']) }).optional(),
  cards: z.array(cardSchema).optional(),
  /** true: the user chose to scan a table that is larger than the size limit. */
  scanLarge: z.boolean().optional(),
  /** Compare mode: the names of the columns of A whose types differ from B, and that the user chose to compare as text. */
  asText: z.array(z.string()).optional(),
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
  z.strictObject({ type: z.literal('init'), datasets: boardDatasetsSchema, settings: boardSettingsSchema }),
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
