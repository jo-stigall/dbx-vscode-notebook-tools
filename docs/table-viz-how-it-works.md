# How "Visualize Table" works

**Summary:** "Visualize Table" has three parts. A page in VS Code (the
board) shows the numbers and the charts. The extension host builds SQL and
sends it to Databricks. Databricks computes the numbers. This page follows
one request from a click to a chart, and it tells you where each part is in
the code.

Read the [README](../README.md#look-at-a-table) first if you want to use the
feature. Read [table-viz-design.md](table-viz-design.md) if you want to know
why a part is the way it is.

No person has run this feature on a real workspace. All tests use fake
servers and the demo tables.

## Words that this page uses

| Word | What it means | Example |
|---|---|---|
| Board | The page that shows one table, or two tables in compare mode. | The tab "orders_2026". |
| Card | The part of the board that shows one column in detail. | The histogram and the statistics of `amount`. |
| Dataset | A table, plus an optional filter, version and sample. | `main.shop.orders` where `region = 'EMEA'`, 10% sample. |
| Profile | The login that the feature uses. | `Demo`, or a profile in `~/.databrickscfg`. |
| Compute | The SQL warehouse or the cluster that runs the queries. | The warehouse "Starter Warehouse". |
| Request | One question about a dataset. | "Give me a histogram of `amount` with 30 bins." |
| Result | The answer to one request. | 30 counts, one for each bin. |
| Profiler | The code that answers a request. | The SQL profiler runs a query. The demo profiler counts rows in memory. |
| Runner | The code that sends one SQL statement to Databricks and gets the rows. | The warehouse runner, the cluster runner. |
| Host | The part of the extension that runs in VS Code itself (Node.js). | It holds the token and talks to Databricks. |
| Page | The part that runs in the webview (a browser inside VS Code). | It draws the board. It has no token and no network access. |

## The parts

```text
        PAGE (webview)                      HOST (Node.js)                        DATABRICKS

  Board, cards, charts        Board (host) and its dispatcher
  src/tableViz/webview/       src/tableViz/host/board.ts
        |                                   |
        |  "request" message                v
        +---------------------->  Profiler of the profile
                                  - "Demo":  demo/demoProfiler.ts   (no Databricks, no cache)
                                  - others:  Cache (core/cache.ts), then host/sqlProfiler.ts
                                            |
                                            |  core/sql.ts builds the statement
                                            v
                                  Limit on queries (core/limiter.ts)
                                            |
                                            v
                                  Runner                              SQL
                                  - host/statementRunner.ts  ------------------->  SQL warehouse
                                  - host/clusterRunner.ts    ------------------->  all-purpose cluster
                                            |
        |                                   |  core/parse.ts reads the rows
        |  "result" message                 v
        <----------------------+  Result
```

The page and the host send each other JSON messages. Each side checks each
message against a schema in `src/tableViz/core/schema.ts` before it uses the
message. A message with the wrong shape goes nowhere.

## Where the code is

`src/tableViz/` has four folders. Each folder can import from `core/`. The
folder `core/` imports from no other folder.

| Folder | What it contains | Runs in |
|---|---|---|
| `core/` | The shapes of requests and results, the SQL builders, the code that reads rows, the statistics for compare mode, the cache. It has no VS Code code and no browser code, so tests run it with Node.js only. | Host and page |
| `host/` | The login, the two runners, the SQL profiler, the list of catalogs and tables, the commands, the panel of the board. | Host |
| `webview/` | The React components of the board, the charts, the messages to the host. | Page |
| `demo/` | The two demo tables and the demo profiler. | Host (and the tests) |

The most important files:

| File | What it does |
|---|---|
| `core/schema.ts` | Defines each request, each result and each message. Start here. |
| `core/sql.ts` | Builds the SQL statement for each request. No other file writes SQL. |
| `core/parse.ts` | Converts the rows of a statement to a result. Each function is the partner of a builder in `sql.ts`. |
| `core/kinds.ts` | Decides how to show a column: histogram, bars, frequency table. |
| `core/profiler.ts` | Defines what a profiler is. Connects the messages of a board to a profiler (`createDispatcher`). |
| `core/compare.ts`, `core/drift.ts`, `core/match.ts` | Compare mode: match the columns of A and B, and compute the drift score. |
| `host/index.ts` | Starts the feature. `extension.js` loads it the first time that you use a command of the feature. |
| `host/session.ts` | Remembers the profile and the compute. Makes the profiler for a profile. |
| `host/sqlProfiler.ts` | Answers a request in three steps: build the SQL, run it, read the rows. |
| `host/statementRunner.ts` | Runs a statement on a SQL warehouse (Statement Execution API). |
| `host/clusterRunner.ts` | Runs a statement on a cluster (Databricks SQL Driver for Node.js). |
| `host/workspace.ts` | Lists warehouses, clusters, catalogs, schemas and tables with the REST API. It runs no SQL. |
| `host/tree.ts` | The view "Databricks Tables": catalogs, schemas, tables, favorites and recent tables. |
| `core/search.ts`, `host/search.ts`, `host/searchPicker.ts` | The search of the view: read the text, ask Unity Catalog for the tables that fit, show the list. |
| `host/browsePicker.ts` | The list of "Visualize Table" and "Compare Tables": favorite and recent tables, then catalogs, schemas and tables. |
| `host/board.ts` | Opens the panel of a board and answers its messages. |
| `webview/Board.tsx` | The board: the facts of the table, the cards and the overview. |
| `webview/rpc.ts`, `webview/hooks.ts` | Send a request to the host and give the answer to a component (`useResult`). |
| `webview/cards/` | The detail card of one column. |
| `webview/compare/` | The overview and the cards of compare mode. |
| `demo/demoProfiler.ts` | Answers each request from the demo tables. The tests compare the SQL profiler with it. |

The tests are in `test/tableViz/`. [test/README.md](../test/README.md) tells
you how to run them.

## What occurs when you open a table

Example: you run "Visualize Table" and select or paste `main.shop.orders`
in the list (`host/browsePicker.ts`). The list reads the catalogs, the
schemas and the tables with the REST API.

1. **The host opens a board.** `host/index.ts` makes a `Board`
   (`host/board.ts`). The board opens a webview panel and loads the page
   (`dist/tableViz/webview.js`).
2. **The page asks for the facts of the table.** `Board.tsx` sends the request
   `tableDetails`. The SQL profiler reads the columns from the Unity Catalog
   REST API, which needs no warehouse. For a Delta table it then runs
   `DESCRIBE DETAIL` and `DESCRIBE HISTORY` to get the size and the version.
   If these two statements fail, the board shows the columns without the
   size.
3. **The board asks before a large scan.** If the table is larger than
   100 GB, the board shows a question. You can continue, or you can add a
   filter or a sample first.
4. **The page asks for the overview.** `Overview.tsx` sends one `overview`
   request for each 25 columns. One statement gives the number of rows that
   are not null and the number of different values for all 25 columns. Thus
   Databricks reads the table one time for 25 columns, not 25 times.
5. **The page decides the kind of each column.** See the next section.
6. **You click a column.** `ColumnCard.tsx` sends the requests of that kind
   of column and shows a card.

## How the table search works

The search button of the view "Databricks Tables" opens a list. Example: you
type `shop.ord`.

1. **`parseSearch()` in `core/search.ts` reads the text.** The last part is
   the table (`ord`), and the part before it is the schema (`shop`). The
   button that you clicked gives the catalog, or "all catalogs".
2. **`searchTables()` in `host/search.ts` sends one request for each
   catalog,** four at the same time:
   `GET /api/2.1/unity-catalog/table-summaries?catalog_name=main&schema_name_pattern=%shop%&table_name_pattern=%ord%`.
   The request runs no SQL.
3. **The function sorts the tables.** A table with the same name as the text
   comes first, then the tables whose names start with the text.
4. **`host/searchPicker.ts` shows the list.** When you type more, it stops
   the requests of the old text and starts again. When you select a table,
   a board opens.

A catalog that the search cannot read does not stop the search. The list
shows a line that tells how many catalogs failed.

## How the board decides the kind of a column

`detectKind()` in `core/kinds.ts` uses the type of the column and its number
of different values. You can change the kind on the card.

| Type | Different values | Kind | The card shows | Requests |
|---|---|---|---|---|
| `double`, `decimal`, most integers | any | continuous | A histogram and statistics | `numericStats`, `histogram` |
| integer | 50 or fewer | discrete | One bar for each value | `frequency` |
| `string`, `boolean` | 10,000 or fewer | category | The top values, "Other" and null | `frequency` |
| `string`, integer | almost all rows are different | identifier | The lengths of the values, and the values that repeat | `frequency`, `numericStats` and `histogram` of the lengths |
| `date`, `timestamp` | any | date | The number of rows in each period | `dateCounts` |
| `array`, `map`, `struct` | any | complex | The type and the percent of nulls | none |

Example: `order_id` is a `bigint` with 100,000 rows and 100,000 different
values. It is an identifier. A histogram of its values tells you nothing, so
the card shows how long the values are and which values repeat.

## One request, from the click to the chart

Example: the card of the column `amount` needs a histogram with 4 bins from
0 to 500.

**1. The page sends a request.** `useResult()` in `webview/hooks.ts` gives the
request to `webview/rpc.ts`, which sends this message to the host:

```json
{
  "type": "request",
  "id": "7",
  "request": {
    "type": "histogram",
    "dataset": { "profile": "DEFAULT", "table": { "catalog": "main", "schema": "shop", "name": "orders" } },
    "columns": [{ "name": "amount", "typeText": "decimal(10,2)" }],
    "edges": { "lo": 0, "hi": 500, "bins": 4 }
  }
}
```

**2. The host looks in the cache.** If the same request ran before on the
same workspace, the cache gives the result and no query runs. "Refresh" on
the board deletes the stored result and runs the query again. The Demo
profile has no cache, because it runs no query.

**3. The SQL profiler builds the statement.** `core/sql.ts` returns this
text. Each name and each number is a parameter, so a column name can never
become SQL:

```sql
-- :c0 = '`amount`'   :lo = 0   :hi = 500   :bins = 4   :tbl = '`main`.`shop`.`orders`'
SELECT
  CASE WHEN CAST(IDENTIFIER(:c0) AS DOUBLE) = :hi THEN :bins
       ELSE width_bucket(CAST(IDENTIFIER(:c0) AS DOUBLE), :lo, :hi, :bins) END AS `bucket`,
  count(*) AS `n`
FROM IDENTIFIER(:tbl)
WHERE CAST(IDENTIFIER(:c0) AS DOUBLE) IS NOT NULL
GROUP BY 1
```

**4. The statement waits for a free place.** The host runs 4 statements at
the same time on a warehouse, and 2 on a cluster. The others wait. While a
statement waits or runs, the host sends a `progress` message with the state
`queued` or `running`. The card shows "Waiting for a free place on
Databricks…" or "Loading…".

**5. The runner sends the statement to Databricks.** Databricks returns one
row for each bin that is not empty, for example `(1, 812)`, `(2, 1403)`,
`(3, 590)`, `(4, 95)`. It returns no rows of the table.

**6. The host makes the result.** `parseHistogram()` in `core/parse.ts` puts
the counts in a list and sends this message:

```json
{
  "type": "result",
  "id": "7",
  "result": {
    "type": "histogram",
    "counts": [812, 1403, 590, 95],
    "below": 0,
    "above": 0,
    "sql": ["SELECT CASE WHEN ..."],
    "approximate": false,
    "asOf": "2026-11-12T09:30:00Z"
  }
}
```

**7. The page draws the chart.** `histogramBars()` in `core/derive.ts` makes
one bar for each bin: 0–125, 125–250, 250–375, 375–500. `webview/options.ts`
makes the settings for ECharts, and `webview/Chart.tsx` draws the bars. "Show
SQL" on the card shows the text from `sql`.

If Databricks reports an error, `core/errors.ts` converts it to one plain
sentence and one next step. The host then sends an `error` message, and the
card shows the sentence. The card always lets you open the original text.

## The requests and the messages

`core/schema.ts` defines ten kinds of request. Each request names one
dataset.

| Request | What the result contains | Who sends it |
|---|---|---|
| `tableDetails` | The columns of the table, its size and its version. | The board, when it opens. |
| `overview` | For each of 1 to 50 columns: the rows that are not null, the number of different values, the minimum, the maximum and the mean. | The overview. |
| `numericStats` | The statistics of one number column, for example the mean, the standard deviation and the percentiles. | The card of a number. |
| `histogram` | The number of rows in each bin. | The card of a number, and the small chart in the overview. |
| `frequency` | The most frequent values of a column and their counts. Example: the top 20 values of `channel`. | The card of a category. |
| `dateCounts` | The number of rows in each day, week, month or year. | The card of a date. |
| `validateFilter` | Nothing. Databricks checks that the filter is correct SQL. | The filter box. |
| `quantiles` | The values at given points of a column. Example: the nine values that divide `amount` into 10 parts with the same number of rows. | Compare mode. |
| `driftBins` | The number of rows between given borders. | Compare mode. |
| `valueCounts` | The counts of a given list of values. Example: how many rows of B have each top value of A. | Compare mode. |

The page and the host send these messages:

| From the page to the host | When |
|---|---|
| `ready` | The page loaded. The host answers with `init`. |
| `request` | A component needs a number. |
| `cancel` | No component wants the answer of a request that still runs. |
| `openSql` | You clicked "Open SQL in Editor". |
| `export` | You saved or copied a chart or a table. The page cannot write a file, so the host does it. |
| `copyText` | You clicked the copy icon next to a table name. The host puts the text on the clipboard. |
| `saveView` | You clicked "Save View". |
| `approve` | You clicked "Run the Queries" on a saved view. |

| From the host to the page | What it contains |
|---|---|
| `init` | The datasets of the board and the settings. |
| `progress` | A request waits (`queued`) or runs (`running`). |
| `result` | The answer to a request. |
| `error` | One plain sentence, the next step, the original text from Databricks, and the SQL. |
| `cancelled` | The request stopped before it had an answer. |

## How the board stops a query

A query costs money while it runs. The board stops a query that nobody
needs:

- You close a card, close the board, or change a filter. The page then sends
  a `cancel` message with the ID of the request.
- The host tells Databricks to cancel the statement.
- The host also cancels a statement that runs longer than 5 minutes.

Two components that ask for the same thing share one request. The page sends
`cancel` only when no component wants the answer.

## How compare mode works

Compare mode shows the same column in dataset A and in dataset B.

- **Each request names one dataset.** The page sends one request for A and
  one for B. The cache keeps the two answers apart. If you change B, the
  answers for A come from the cache. One exception: the histograms of a
  number column share their bins, and the bins come from the range of A and
  B together. A new B can thus need a new histogram of A.
- **`core/match.ts` matches the columns by name.** Example: `amount` in A
  goes with `amount` in B. A column that is only in A shows in the schema
  comparison, not in the list of pairs.
- **`core/drift.ts` gives each pair a drift score from 0 to 1.** 0: the
  column has the same shares of values in A and in B. 1: A and B have no
  value in common. The score is the Jensen-Shannon distance. Example: a
  column with the shares 90% / 10% in A and 10% / 90% in B has the score
  0.73.
- **The overview sorts by the drift score.** The columns that changed most
  come first.

For a number or a date, the score uses bins. The borders of the bins are
the deciles of A, so there are usually 10 bins. There are fewer if two or
more deciles are the same value: a column where each row has the same value
has 2 bins. If the column has no values in A, the score compares
the nulls only. For a category, the score uses the values of A and B, with
null as its own value.

## How the demo works

The profile `Demo` needs no workspace. `demo/data.ts` makes two tables,
`demo.shop.orders_2025` and `demo.shop.orders_2026`, from a fixed seed. The
tables contain the same rows on each computer. The 2026 table is different
from the 2025 table in six known ways, so that you can try compare mode.

`demo/demoProfiler.ts` answers each request with a direct count of the rows
in memory. It is also the reference for the tests: for the same rows, the
SQL profiler must give the same numbers.

## How a saved view works

"Save View" writes the state of the board to a `.tableviz.json` file: the
datasets, the filters and the open cards. The file contains no results and
no token.

When you open such a file, the board shows each dataset and each filter and
runs nothing. A filter is SQL, and the file can come from a different
person. The host refuses each request until you click "Run the Queries".

## How the build works

The notebook part of the extension is plain JavaScript. This feature is
TypeScript and React, so it has a build step:

```bash
npm run build
```

`scripts/build.mjs` uses esbuild and writes these files:

| File | What it contains | When the extension loads it |
|---|---|---|
| `dist/tableViz/host.js` | The code of `host/`, `core/` and `demo/`. | The first time that you use a command of the feature. |
| `dist/tableViz/driver.js` | The Databricks SQL Driver for Node.js. | The first time that a statement runs on a cluster. |
| `dist/tableViz/webview.js`, `webview.css` | The page. | When a board opens. |
| `dist/test/`, `dist/harness/` | Code for the tests and for the test page in a browser. | Never in the installed extension. |

`npm run package` runs the build and then makes the `.vsix` install file.

## How to add a new kind of request

Example: you want the number of rows for each day of the week.

1. **`core/schema.ts`:** add the request (`weekdayCounts`) and its result to
   the lists of requests and results.
2. **`core/sql.ts`:** add a builder that returns the statement. Use
   parameters for each name and each value.
3. **`core/parse.ts`:** add the function that converts the rows to the
   result.
4. **`host/sqlProfiler.ts`:** add a `case` that calls the parser. The
   profiler calls `buildStatements()` for each request before the `switch`.
5. **`demo/demoProfiler.ts`:** add a `case` that counts the rows of the demo
   tables. The tests then compare the two profilers.
6. **`webview/`:** call `useResult({ type: 'weekdayCounts', ... })` in a
   component and draw the result.
7. **Tests:** run `npm test`. The test of the SQL builders stores the text
   of each statement in `test/tableViz/unit/sql.test.ts.snapshot`. Write the
   file again as [test/README.md](../test/README.md) tells you, and read the
   difference.

If you add a request to `schema.ts` and forget the builder, the type check
(`npm run typecheck`) fails in `core/sql.ts`.
