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
 * The file also has the shapes of the messages (`toHostSchema`,
 * `toWebviewSchema`), of the settings of a board, and of a saved view.
 *
 * Each schema is a strict object: a message with a field that the schema
 * does not name fails the check.
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
/** A table name. Example: `{ catalog: 'main', schema: 'shop', name: 'orders' }`. */
export type TableName = z.infer<typeof tableNameSchema>;

/**
 * A Delta version of a table: a version number or a time.
 *
 * The builders write the version into the text of the SQL statement. Thus
 * `n` can have digits only, and `ts` can have only the characters of a date
 * and a time.
 *
 * @example
 * { kind: 'version', n: '42' }
 * { kind: 'timestamp', ts: '2026-11-01 02:05' }
 */
export const datasetVersionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('version'), n: z.string().regex(/^\d+$/) }),
  // The builders write this text into the SQL statement, so the schema permits only the characters of a date and a time.
  z.strictObject({
    kind: z.literal('timestamp'),
    ts: z.string().regex(/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/),
  }),
]);
/** A Delta version of a table: `{ kind: 'version', n: '42' }` or `{ kind: 'timestamp', ts: '2026-11-01 02:05' }`. */
export type DatasetVersion = z.infer<typeof datasetVersionSchema>;

/**
 * A column in a request: its name and its Databricks type, for example "decimal(10,2)".
 *
 * The builders in sql.ts select the aggregates from the type. Thus a request
 * alone gives its SQL, and the host does not read the table first.
 */
export const columnRefSchema = z.strictObject({ name: z.string().min(1), typeText: z.string().min(1) });
/** A column in a request. Example: `{ name: 'amount', typeText: 'decimal(10,2)' }`. */
export type ColumnRef = z.infer<typeof columnRefSchema>;

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
/** What a request measures in a column: 'value', 'length' or 'day'. See `measureSchema`. */
export type Measure = z.infer<typeof measureSchema>;

/**
 * A filter chip: one condition that the user made with a click on a chart.
 *
 * The chips of a dataset combine with AND.
 *
 * | op      | Meaning                                   | Made by                          |
 * |---------|-------------------------------------------|----------------------------------|
 * | 'eq'    | the column, as text, is equal to `value`  | a click on a bar of a value      |
 * | 'null'  | the column is null                        | a click on the "(null)" bar      |
 * | 'range' | the column is from `lo` to `hi`           | a click or a drag on a histogram or a date chart |
 *
 * A chip has no SQL text. The builders make the SQL from its parts, with
 * parameters, so a chip cannot contain SQL from a file.
 *
 * @example
 * { op: 'eq', column: { name: 'region', typeText: 'string' }, value: 'EMEA' }
 * { op: 'range', column: { name: 'amount', typeText: 'decimal(10,2)' }, lo: 25, hi: 75 }
 */
export const chipSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('eq'), column: columnRefSchema, value: z.string() }),
  z.strictObject({ op: z.literal('null'), column: columnRefSchema }),
  z.strictObject({
    op: z.literal('range'),
    column: columnRefSchema,
    /** What `lo` and `hi` measure. 'day' for a date column: days after 1970-01-01. */
    measure: measureSchema.optional(),
    /** The start of the range. A value equal to `lo` is in the range. */
    lo: z.number(),
    /** The end of the range. A value equal to `hi` is not in the range, unless `includeHi` is true. */
    hi: z.number(),
    /** true: a value equal to `hi` is in the range. The last bin of a histogram uses it. */
    includeHi: z.boolean().optional(),
  }),
]);
/** One filter chip. Example: `{ op: 'null', column: { name: 'discount_pct', typeText: 'double' } }`. See `chipSchema`. */
export type Chip = z.infer<typeof chipSchema>;

/**
 * A table or view plus optional modifiers: a filter, filter chips, a version
 * and a sample. All charts and tables in the feature show a dataset.
 *
 * `profile` is the name of the Databricks login. It is part of the dataset so
 * that a later version can compare two workspaces.
 *
 * @example
 * // 1 percent of the EMEA rows of main.shop.orders, as the table was at version 42.
 * {
 *   profile: 'DEFAULT',
 *   table: { catalog: 'main', schema: 'shop', name: 'orders' },
 *   filter: "region = 'EMEA'",
 *   version: { kind: 'version', n: '42' },
 *   sample: { percent: 1 },
 * }
 */
export const datasetSchema = z.strictObject({
  /** Example: 'DEFAULT', a profile in `~/.databrickscfg`. The profile 'Demo' has the built-in demo tables. */
  profile: z.string().min(1),
  table: tableNameSchema,
  /** A SQL boolean expression. Example: "region = 'EMEA'". */
  filter: z.string().optional(),
  /** Conditions from clicks on charts. They combine with AND, and with the filter. */
  chips: z.array(chipSchema).max(20).optional(),
  /** The Delta version that the queries read. Not set: the newest version of the table. */
  version: datasetVersionSchema.optional(),
  /** When set, queries read this percent of the rows, and counts are estimates. */
  sample: z.strictObject({ percent: z.number().gte(0.01).lte(100) }).optional(),
});
/** A table or view plus an optional filter, filter chips, version and sample. See `datasetSchema` for an example. */
export type Dataset = z.infer<typeof datasetSchema>;

/**
 * How the feature shows a column. detectKind() in kinds.ts selects the kind, and the user can change it on the card.
 *
 * - 'continuous': a number column with many different values. The card shows a histogram.
 * - 'discrete': a number column with few different values. The card shows one bar for each value.
 * - 'category': a string or boolean column. The card shows the most frequent values.
 * - 'identifier': almost each row has a different value, as in an ID column. The card shows the lengths of the values.
 * - 'date': a date or timestamp column. The card shows the number of rows in each period.
 * - 'complex': an array, map, struct or other type whose values the feature does not read. The feature counts its nulls only.
 */
export const columnKindSchema = z.enum(['continuous', 'discrete', 'category', 'identifier', 'date', 'complex']);
/** The kind of a column: 'continuous', 'discrete', 'category', 'identifier', 'date' or 'complex'. See `columnKindSchema`. */
export type ColumnKind = z.infer<typeof columnKindSchema>;

/** One column of a table, as the table overview shows it. A "tableDetails" result has one for each column. */
export const columnInfoSchema = z.strictObject({
  name: z.string(),
  /** The Databricks type of the column. Example: 'decimal(10,2)'. */
  typeText: z.string(),
  /** The comment of the column in Unity Catalog. */
  comment: z.string().optional(),
  /** true: the column is a partition column of the table. */
  partition: z.boolean().optional(),
});
/** One column of a table. Example: `{ name: 'order_date', typeText: 'date', partition: true }`. */
export type ColumnInfo = z.infer<typeof columnInfoSchema>;

/** The bins of a histogram: `bins` bins of equal width from `lo` to `hi`. See bins.ts. */
export const binEdgesSchema = z.strictObject({
  lo: z.number(),
  hi: z.number(),
  bins: z.number().int().min(1).max(200),
});
/** The bins of a histogram. Example: `{ lo: 0, hi: 100, bins: 4 }` makes the bins 0-25, 25-50, 50-75 and 75-100. */
export type BinEdges = z.infer<typeof binEdgesSchema>;

/** The period of a date chart. The chart has one bar for each day, week, month or year. */
export const grainSchema = z.enum(['day', 'week', 'month', 'year']);
/** The period of a date chart: 'day', 'week', 'month' or 'year'. */
export type Grain = z.infer<typeof grainSchema>;

/** The `columns` field of a request about one column: a list with exactly one column. */
const oneColumn = z.tuple([columnRefSchema]);

/** The percentiles in the statistics of a number column. 0.5 is the median. */
export const PERCENTILES = [0.01, 0.05, 0.25, 0.5, 0.75, 0.95, 0.99] as const;

/**
 * A question about a dataset. Each request type becomes one aggregate query.
 *
 * The webview sends a request to the host in a "request" message. The host
 * answers with a result of the same type.
 *
 * `columns` is a list in each request, so that a later version can add
 * requests about two columns together.
 *
 * Some requests have a `measure` field. If it is not set, the request
 * measures the value of the column. See `measureSchema`.
 *
 * @example
 * // "How many rows does each of the 20 most frequent values of `channel` have?"
 * {
 *   type: 'frequency',
 *   dataset: { profile: 'DEFAULT', table: { catalog: 'main', schema: 'shop', name: 'orders' } },
 *   columns: [{ name: 'channel', typeText: 'string' }],
 *   top: 20,
 * }
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
/** A question about a dataset. The field `type` tells which of the ten request types it is. See `requestSchema` for an example. */
export type Request = z.infer<typeof requestSchema>;
/**
 * The request of one type.
 *
 * @example
 * function histogram(request: RequestOf<'histogram'>) {
 *   request.edges   // TypeScript knows that a "histogram" request has `edges`
 * }
 */
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

/**
 * The numbers of one column in the table overview.
 *
 * `min` and `max` are text, so that large integers and decimals keep all
 * their digits.
 */
export const overviewColumnSchema = z.strictObject({
  name: z.string(),
  /** The number of rows where the column is not null. */
  nonNull: z.number(),
  /** The number of different values. Not set for a complex type such as map: the feature does not count its values. */
  distinct: z.number().optional(),
  /** The smallest and the largest value. Set only for number, date and timestamp columns that have a value. */
  min: z.string().optional(),
  max: z.string().optional(),
  /** Numbers only. */
  mean: z.number().optional(),
});
/** The numbers of one column in the table overview. Example: `{ name: 'amount', nonNull: 109500, distinct: 8400, min: '2.33', max: '4999.00', mean: 63.0015 }`. */
export type OverviewColumn = z.infer<typeof overviewColumnSchema>;

/**
 * The answer to one request. A result has the same `type` as its request.
 *
 * The host sends a result to the webview in a "result" message.
 *
 * @example
 * // The answer to a "frequency" request about `channel` with `top: 2`. The table has 100 rows.
 * {
 *   type: 'frequency',
 *   sql: ["-- :c0 = '`channel`'\n...\nSELECT `value`, `n`, ..."],
 *   approximate: false,
 *   asOf: '2026-11-12T09:30:00.000Z',
 *   rowCount: 100,
 *   nulls: 5,
 *   values: [{ value: 'web', count: 60 }, { value: 'store', count: 30 }],
 * }
 */
export const resultSchema = z.discriminatedUnion('type', [
  /** The columns of the table, and the facts about its storage. */
  z.strictObject({
    ...resultBase,
    type: z.literal('tableDetails'),
    columns: z.array(columnInfoSchema),
    tableType: z.enum(['table', 'view']),
    /** The storage format. Example: 'delta'. */
    format: z.string().optional(),
    /** The size of the table on disk, in bytes. Not set for a view, or if `DESCRIBE DETAIL` failed. */
    sizeBytes: z.number().optional(),
    /** The time of the last change of the table. ISO 8601. */
    lastModified: z.string().optional(),
    partitionColumns: z.array(z.string()),
    /** The Delta version that all queries of this dataset read. */
    version: z.string().optional(),
  }),
  /** The row count of the dataset, and the numbers of each column of the request. */
  z.strictObject({ ...resultBase, type: z.literal('overview'), rowCount: z.number(), columns: z.array(overviewColumnSchema) }),
  /** The statistics of one number column. */
  z.strictObject({
    ...resultBase,
    type: z.literal('numericStats'),
    /** All rows of the dataset, nulls included. */
    rowCount: z.number(),
    /** The number of rows where the column is not null. */
    nonNull: z.number(),
    /** The number of rows where the value is 0. */
    zeros: z.number(),
    /** The number of rows where the value is less than 0. */
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
  /** The counts of one histogram. The bins are the `edges` of the request. */
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
  /** The most frequent values of one column. */
  z.strictObject({
    ...resultBase,
    type: z.literal('frequency'),
    /** All rows of the dataset, nulls included. */
    rowCount: z.number(),
    /** The number of rows where the column is null. */
    nulls: z.number(),
    /** The most frequent values, most frequent first. The list does not contain null. */
    values: z.array(z.strictObject({ value: z.string(), count: z.number() })),
  }),
  /** The number of rows in each period of one date column. */
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
  /** The number of rows between each two cut points of the request. */
  z.strictObject({
    ...resultBase,
    type: z.literal('driftBins'),
    /** All rows of the dataset, nulls included. */
    rowCount: z.number(),
    /** The number of rows where the column is null. These rows are in no bin. */
    nulls: z.number(),
    /** One count more than the request has cut points. Bin 0 has the values below the first cut point. */
    counts: z.array(z.number()),
  }),
  /** One entry for each value of the request, in the same sequence. A value that no row has gets the count 0. */
  z.strictObject({ ...resultBase, type: z.literal('valueCounts'), values: z.array(z.strictObject({ value: z.string(), count: z.number() })) }),
]);
/** The answer to one request. The field `type` tells which of the ten result types it is. See `resultSchema` for an example. */
export type Result = z.infer<typeof resultSchema>;
/**
 * The result of one type.
 *
 * @example
 * const result: ResultOf<'histogram'> = await ask(histogramRequest);
 * result.counts   // [5, 9]: TypeScript knows that a "histogram" result has `counts`
 */
export type ResultOf<T extends Result['type']> = Extract<Result, { type: T }>;

/** The datasets of one board. B is set in compare mode only. */
export const boardDatasetsSchema = z.strictObject({ a: datasetSchema, b: datasetSchema.optional() });
/** The datasets of one board: `{ a }`, or `{ a, b }` in compare mode. */
export type BoardDatasets = z.infer<typeof boardDatasetsSchema>;

/**
 * The settings of one detail card. A setting that is not set uses its default.
 *
 * The webview keeps the cards in the board state, and a saved view stores them.
 *
 * @example
 * { column: 'amount', pinned: true, expanded: true, bins: 50, logScale: true }
 */
export const cardSchema = z.strictObject({
  /** The name of the column that the card shows. */
  column: z.string(),
  /** true: the card stays on the board when you open a different column. */
  pinned: z.boolean(),
  /**
   * true: the card is the detailed view of the column. It uses the full
   * width of the board, and its chart is larger and has axis titles, labels
   * on the bars, and lines for the mean and the median.
   * false: a small card, so that several cards fit side by side.
   */
  expanded: z.boolean().optional(),
  /** The kind that the user selected. Not set: the feature decides the kind. */
  kind: columnKindSchema.optional(),
  /** The number of bins of the histogram. Not set: the setting `defaultBins`. */
  bins: z.number().int().min(5).max(200).optional(),
  /** true: the axis of the counts has a logarithmic scale. */
  logScale: z.boolean().optional(),
  /** true: the histogram shows the range from the 1st to the 99th percentile. */
  clip: z.boolean().optional(),
  /** The period of the date chart. Not set: the feature selects it from the range of the dates. */
  grain: grainSchema.optional(),
  /** The sequence of the bars of a category chart. 'count': most frequent first. 'label': in the sequence of the values. */
  sortBy: z.enum(['count', 'label']).optional(),
  /** true: the card shows the numbers of its chart as a table. */
  asTable: z.boolean().optional(),
  /** true: the card shows the SQL statements that gave its numbers. */
  showSql: z.boolean().optional(),
  /** true: the card asked for exact numbers. */
  exact: z.boolean().optional(),
  /** Compare mode. true: the card shows one chart for A and one for B. false: one chart with the two datasets. */
  sideBySide: z.boolean().optional(),
  /** Compare mode. true: the charts show the number of rows. false: they show the percent of the rows of each dataset. */
  rawCounts: z.boolean().optional(),
});
/** The settings of one detail card. Example: `{ column: 'amount', pinned: false, expanded: true }`. See `cardSchema`. */
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
/** The settings of the feature that the webview needs. The host sends them in the "init" message. */
export type BoardSettings = z.infer<typeof boardSettingsSchema>;
/** The settings of a board when the user did not change them. Example: 30 bins, and a question before a full scan of a table larger than 100 GB. */
export const DEFAULT_SETTINGS: BoardSettings = { defaultBins: 30, topValues: 20, largeTableBytes: 100 * 1024 ** 3, matchColumnsCaseSensitive: false };

/**
 * What the webview stores so that a board comes back after a window reload. It contains no data and no token.
 *
 * The webview also sends it to the host in a "saveView" message, and gets it
 * back in the "init" message of a saved view.
 *
 * @example
 * {
 *   datasets: { a: { profile: 'DEFAULT', table: { catalog: 'main', schema: 'shop', name: 'orders' } } },
 *   ui: { search: 'amount', sort: 'nulls' },
 *   cards: [{ column: 'amount', pinned: true, expanded: true }],
 * }
 */
export const boardStateSchema = z.strictObject({
  datasets: boardDatasetsSchema,
  /** The text in the search box of the table overview, and the sequence of its rows. */
  ui: z.strictObject({ search: z.string(), sort: z.enum(['table', 'nulls', 'distinct', 'drift']) }).optional(),
  /** The detail cards that are open, in the sequence of the board. */
  cards: z.array(cardSchema).optional(),
  /** true: the user chose to scan a table that is larger than the size limit. */
  scanLarge: z.boolean().optional(),
  /** Compare mode: the same for dataset B. */
  scanLargeB: z.boolean().optional(),
  /** Compare mode: the names of the columns of A whose types differ from B, and that the user chose to compare as text. */
  asText: z.array(z.string()).optional(),
});
/** What a board shows: its datasets, its open cards and the state of its table overview. See `boardStateSchema`. */
export type BoardState = z.infer<typeof boardStateSchema>;

/**
 * A saved view: the content of a `.tableviz.json` file.
 *
 * The file holds what the board shows, not what the tables contain: the
 * datasets with their filters, the open cards and their settings. It has
 * no data and no token.
 *
 * The filter of a dataset is SQL text, and it runs with the login of the
 * person who opens the file. Thus the extension shows the filters and asks
 * before it runs the queries of a view that it did not see before.
 *
 * `ui`, `cards` and `asText` are the same as in the board state.
 *
 * @example
 * {
 *   "tableViz": 1,
 *   "datasets": { "a": { "profile": "DEFAULT", "table": { "catalog": "main", "schema": "shop", "name": "orders" }, "filter": "region = 'EMEA'" } },
 *   "cards": [{ "column": "amount", "pinned": true, "expanded": true }]
 * }
 */
export const savedViewSchema = z.strictObject({
  /** The version of the file format. */
  tableViz: z.literal(1),
  datasets: boardDatasetsSchema,
  ui: boardStateSchema.shape.ui,
  cards: z.array(cardSchema).max(50).optional(),
  asText: z.array(z.string()).optional(),
});
/** The content of a `.tableviz.json` file. See `savedViewSchema` for an example. */
export type SavedView = z.infer<typeof savedViewSchema>;

/**
 * A message from the webview to the extension host.
 *
 * The webview makes the `id` of a "request" message. Each answer of the host
 * has the same `id`, and a "cancel" message names the request by it.
 *
 * @example
 * { type: 'request', id: 'r17', request: { type: 'tableDetails', dataset }, refresh: true }
 * { type: 'cancel', id: 'r17' }
 */
export const toHostSchema = z.discriminatedUnion('type', [
  /** The webview started and can receive messages. */
  z.strictObject({ type: z.literal('ready') }),
  /** Open SQL statements of a card in a text editor. The webview got these statements in results. */
  z.strictObject({ type: z.literal('openSql'), sql: z.array(z.string().max(200_000)).min(1).max(50) }),
  /**
   * Save a chart or the tables of a card to a file, or copy them.
   * `text` holds CSV or SVG. `base64` holds a PNG image.
   */
  z.strictObject({
    type: z.literal('export'),
    action: z.enum(['save', 'copy']),
    /** A file name without a folder. Example: 'orders_2026_amount.csv'. */
    name: z.string().min(1).max(200),
    format: z.enum(['csv', 'svg', 'png']),
    text: z.string().max(20_000_000).optional(),
    base64: z.string().max(30_000_000).optional(),
  }),
  /** Write the board to a `.tableviz.json` file. */
  z.strictObject({ type: z.literal('saveView'), state: boardStateSchema }),
  /** The user read the datasets and filters of a saved view and permits its queries. */
  z.strictObject({ type: z.literal('approve') }),
  /** Run a request. `refresh: true` ignores the cache. */
  z.strictObject({ type: z.literal('request'), id: z.string().min(1), request: requestSchema, refresh: z.boolean().optional() }),
  /** Stop the request with this id. */
  z.strictObject({ type: z.literal('cancel'), id: z.string().min(1) }),
]);
/** A message from the webview to the extension host. The field `type` tells which message it is. See `toHostSchema`. */
export type ToHost = z.infer<typeof toHostSchema>;

/**
 * A message from the extension host to the webview.
 *
 * For each "request" message, the host sends zero or more "progress"
 * messages, then one "result", "error" or "cancelled" message.
 *
 * @example
 * { type: 'progress', id: 'r17', state: 'running', statementId: '01f0-...' }
 * { type: 'error', id: 'r17', message: 'The table main.shop.orders does not exist, or you are not permitted to see it.',
 *   nextStep: 'Check the name of the table. ...', raw: '[TABLE_OR_VIEW_NOT_FOUND] ...', sql: ['DESCRIBE DETAIL ...'] }
 */
export const toWebviewSchema = z.discriminatedUnion('type', [
  /** The answer to "ready": the datasets that the board shows. */
  z.strictObject({
    type: z.literal('init'),
    datasets: boardDatasetsSchema,
    settings: boardSettingsSchema,
    /** The cards and settings of a saved view. Not set for a new board. */
    state: boardStateSchema.optional(),
    /** true: show the datasets and filters and ask the user, before any query runs. For a saved view that the extension did not see before. */
    confirm: z.boolean().optional(),
  }),
  /** The answer to the request with this id. */
  z.strictObject({ type: z.literal('result'), id: z.string(), result: resultSchema }),
  /**
   * The state of the query of a request changed.
   * 'queued': the query waits, because the largest permitted number of queries runs.
   * 'running': the host sent the statement to Databricks. `statementId` is set after Databricks accepts the statement.
   */
  z.strictObject({ type: z.literal('progress'), id: z.string(), state: z.enum(['queued', 'running']), statementId: z.string().optional() }),
  /** The request with this id failed. */
  z.strictObject({
    type: z.literal('error'),
    id: z.string(),
    /** A plain message. Example: "The table does not exist." */
    message: z.string(),
    /** What the user can do. Example: "Check the name of the table." */
    nextStep: z.string().optional(),
    /** The error text from Databricks. */
    raw: z.string(),
    /** The SQL statements of the request, so that the user can open them. */
    sql: z.array(z.string()),
  }),
  /** The host stopped the request with this id, because the webview sent "cancel" or the board closed. */
  z.strictObject({ type: z.literal('cancelled'), id: z.string() }),
]);
/** A message from the extension host to the webview. The field `type` tells which message it is. See `toWebviewSchema`. */
export type ToWebview = z.infer<typeof toWebviewSchema>;
