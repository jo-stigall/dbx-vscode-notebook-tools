# Table visualization: design note

**Summary:** This note is the plan for the table visualization feature. It
tells you what the feature reuses from the extension, what it adds, and which
questions need your answer before the code starts. Question 1 blocks
milestone 2.

## What the feature reuses

| Existing part | How the feature uses it |
|---|---|
| `Connection` in `src/client.js` | Finds the workspace URL, the token and the cluster. Sends REST requests with the 30-second limit and the `https://` rule. Reads `~/.databrickscfg`. |
| "Select Cluster" and the cluster that VS Code remembers for each folder | The cluster for table queries is the same cluster. |
| Settings `dbxNotebook.profile`, `clusterId`, `cliPath` | No copies. New settings go in `dbxNotebook.tableViz.*`. |
| Command names | `dbxNotebook.tableViz.<name>`, category "Databricks Notebook". |
| `test/run-e2e.sh` | The integration tests in demo mode use the same method. |

The notebook kernel continues to use the Command Execution API. The feature
does not use that API.

## What the feature adds

- `src/tableViz/` with `core/`, `host/`, `webview/` and `demo/`, and
  `test/tableViz/`.
- A build step. The extension has none today.
- In the host: a list of SQL warehouses, a Unity Catalog client, a token in
  `SecretStorage`, a new token after a 401 answer, a status bar item, a tree
  of catalogs, a log channel (the extension has no log today) and a custom
  editor for `*.tableviz.json`.
- One change outside the feature folder: the error from `Connection.api()`
  gets a `status` field, so that callers can see a 401 or a 429.

## Chart library: Apache ECharts

ECharts has three things that Observable Plot does not have built in: a brush
to drag across a histogram, export to PNG and to SVG, and fill patterns. Fill
patterns let you tell A from B without color. It uses no `eval`. The cost is
a larger file (my estimate: about 0.5 MB after esbuild removes unused parts). One point is
not verified: the default tooltip writes inline styles, which a strict policy
can block. If it does, the feature draws its own tooltip.

## Types

```ts
type Dataset = {
  profile: string;                                   // kept for cross-workspace compare later
  table: { catalog: string; schema: string; name: string };
  filter?: string;                                   // SQL boolean expression
  version?: { kind: 'version'; n: string } | { kind: 'timestamp'; ts: string };
  sample?: { percent: number };
};
type ColumnKind = 'continuous' | 'discrete' | 'category' | 'identifier' | 'date' | 'complex';

type ColumnRef = { name: string; typeText: string };  // the type selects the aggregates, so a request alone gives its SQL

type Request =                                       // `columns` is a list, so two-column views fit later
  | { type: 'tableDetails'; dataset: Dataset }
  | { type: 'overview'; dataset: Dataset; columns: ColumnRef[] }
  | { type: 'numericStats'; dataset: Dataset; columns: [ColumnRef]; exact: boolean }
  | { type: 'histogram'; dataset: Dataset; columns: [ColumnRef]; edges: BinEdges }
  | { type: 'frequency'; dataset: Dataset; columns: [ColumnRef]; top: number; values?: string[] }
  | { type: 'dateCounts'; dataset: Dataset; columns: [ColumnRef]; grain: Grain }
  | { type: 'driftBins'; dataset: Dataset; columns: [ColumnRef]; cuts: string[] }
  | { type: 'validateFilter'; dataset: Dataset };

type Result = { type: Request['type']; sql: string[]; approximate: boolean; asOf: string } & ResultBody;
```

The schemas in `src/tableViz/core/schema.ts` are the source of these types.
The first six request types exist now. `driftBins` and `validateFilter` come
with compare mode and filters. `numericStats` and `histogram` have a
`measure` field: `'length'` measures the number of characters of a value,
for the card of an identifier column.

Numbers that can be larger than 2^53, and decimals, stay strings in all
results.

## Message protocol

```ts
type ToHost =
  | { id: string; type: 'request'; request: Request; refresh?: boolean }
  | { id: string; type: 'cancel' }
  | { id: string; type: 'command'; command: 'openSql' | 'export' | 'saveView' | 'addCompare'; args: unknown };
type ToWebview =
  | { id: string; type: 'result'; result: Result }
  | { id: string; type: 'progress'; state: 'queued' | 'running'; statementId?: string }
  | { id: string; type: 'error'; message: string; nextStep?: string; raw: string; sql: string[] }
  | { id: string; type: 'cancelled' };
```

Each side checks each message with a zod schema. Compare mode sends one
request for A and one for B. The host keeps a separate cache entry for each.

## New packages that the installed extension contains

| Package | License | Used for |
|---|---|---|
| `@databricks/sql` | Apache-2.0 | Queries on a cluster. The extension loads it only when you select a cluster. |
| `echarts` | Apache-2.0 | Charts. |
| `react`, `react-dom` | MIT | The webview. |
| `zod` | MIT | Message checks. |
| `@vscode/codicons` | CC-BY-4.0 (icons), MIT (code) | Icons. |

For the build only: `typescript`, `esbuild`, `@vscode/vsce`, `@types/vscode`.
I will pin exact versions when I install them.

## Where the docs differ from the brief

1. **The driver needs a new Node.js.** `@databricks/sql` 3.0.0 accepts only
   Node 22.23.4+, 24.22.1+ or 26.12.1+, because of a security fix. VS Code
   1.146 has Node 24.22.1. The extension says that it accepts VS Code 1.90,
   which has an older Node.
2. **`runAsync` does nothing** on the default Thrift path. One driver page
   also calls it deprecated. I will set it, as the brief says.
3. **The cluster HTTP path is not in the docs.** The form
   `sql/protocolv1/o/<workspace-id>/<cluster-id>` does not appear. The
   feature will build it and let you paste a different path.
4. **`databricks auth token` works for OAuth profiles only.** For a profile
   with a `token` line, the feature reads the token from the file, as the
   extension does today. No JSON output is documented for
   `databricks auth profiles`, so the feature reads `~/.databrickscfg`.
5. **`IDENTIFIER()` before runtime 18.0** does not accept a qualifier, and
   `IDENTIFIER('a.' || :t)` is deprecated from 18.0. The builders will pass
   the full quoted name in one marker: `IDENTIFIER(:tbl)`.
6. **The driver needs `preserveBigNumericPrecision: true`** to keep 64-bit
   integers and decimals exact.
7. **The driver has a `queryTags` option.** I will use it and not the
   `query_tags` text setting.
8. **No page gives the minimum runtime for named markers through the
   driver**, and no page describes a 429 answer. The floor is 13.3 LTS until
   a real cluster shows a higher one.
9. **The VS Code webview guide shows `webview.cspSource`, not a nonce.** I
   will use a nonce, as the brief says.

## Questions for you

Questions 1 and 3 have answers. For questions 2, 4 and 6, the code uses my
recommendation, because you gave no different answer. Questions 5 and 7 are
open, and no code depends on them yet.

1. **Node.js: answered.** You said yes on 2026-11-12. Node.js 24 is
   installed with Homebrew.
2. **Language.** The extension is plain JavaScript. I recommend TypeScript
   for `src/tableViz/` only, and no change to the existing files. Is a
   repository with two languages acceptable?
3. **Login sequence: answered.** You said on 2026-11-12 to keep the existing
   sequence. The text below is the question as I asked it.
   **Login sequence.** The extension looks at settings, then variables, then
   the project file, then the profile. The brief puts profiles first. I
   recommend the existing sequence, with the `SecretStorage` token last.
4. **Old VS Code.** I recommend that warehouses work on all versions, and
   that the feature refuses a cluster with a clear message if Node.js is too
   old. The other option is to require a newer VS Code for all of the
   extension.
5. **Install file.** `scripts/package.py` builds the `.vsix` today. May I
   replace it with `vsce package`, as the brief says?
6. **Tests.** The existing tests use no packages. I recommend Node's built-in
   test runner and seeded random data, as `test/format.test.js` does, and
   Playwright (build only) for the card screenshots.
7. **Pipeline.** The repository has no remote. I can add a GitHub Actions
   file, but I cannot run it.

## Not verified until a real workspace is available

`IDENTIFIER(:col)` in each position, time travel after `IDENTIFIER(:tbl)`,
the names of the cluster access modes in the Clusters API, how the driver
behaves in an esbuild bundle, and all live queries.

## Decisions in milestone 2

- An integer column is an "identifier" when almost all of its rows have a
  different value. The brief gives this rule for all types. A decimal or
  float column is never an identifier, because a measurement is also
  different in almost every row.
- The thumbnails in the overview are plain SVG, not ECharts. One page can
  show hundreds of them. ECharts comes with the column detail cards.
- No linter yet. The extension has none, and the TypeScript compiler checks
  the feature in strict mode.

## Decisions in milestone 3

- SQL: `min` and `max` are cast to STRING in the statement, so that a large
  integer or a decimal arrives with all its digits on both kinds of compute.
- SQL: the Delta version, the sample percent and the period of `date_trunc`
  are in the statement text, not in parameters. The schema permits only
  digits, date characters and four fixed words for them.
- SQL: the builders can write names between backticks in place of
  `IDENTIFIER()`. This is the fallback if a real workspace refuses
  `IDENTIFIER()` in some position.
- SQL: `frequency` gets the total row count from a window function in the
  same statement, so "Other" needs no second scan.
- The frequency table of a category shows the 200 most frequent values.
- The demo profiler puts the SQL of each request in its result, so that
  "Show SQL" works in demo mode. It does not run that SQL.
- The card tests draw each card as HTML text in Node.js. A screenshot of
  each card in each theme needs a browser tool (question 6).

## Decisions in milestone 4

- **REST client.** The feature has its own small REST client
  (`host/http.ts`). It gets the workspace URL and the token from the
  `Connection` class of the extension. I did not extend `Connection.api()`,
  as the brief says to do, for two reasons: the notebook kernel depends on
  its exact behaviour, and the tests of the brief (HTTP 401 and 429 through
  the runner, with a local server) need a client that works without VS Code.
- **Changes outside the feature folder.** `src/client.js` got named
  profiles, a list of profiles, a token in the secret store, and "ask the
  CLI again after a refused token". The connection of the notebooks does
  not change. `test/client.test.js` covers the new parts.
- **Profiles.** `@workspace` is the connection of the notebooks. A profile
  that you select by name uses only the URL and the token of that profile,
  not the environment variables.
- **The selection is for the VS Code workspace**, not for each folder of a
  workspace with more than one folder. The brief says "per workspace
  folder". A board is not in a folder, so I found no good rule for which
  folder to use.
- **Version pinning is in the requests.** The board reads the Delta version
  with the table details, then puts `VERSION AS OF` in each request. Thus
  "Show SQL" shows the version, and the cache key has it.
- **Refresh.** After "Refresh", each request tells the host one time not to
  answer from its cache.
- **The filter box and the sample control are in this milestone**, because
  the question for a large table offers them. Click-to-filter chips come in
  milestone 7. The Demo profile cannot use a filter until then.
- **A sample in the Demo profile** reads a fixed part of the demo rows.
- **Not from the docs.** I wrote the requests for the Unity Catalog API and
  the warehouses API from memory. The brief did not list their pages, and I
  did not read them. The fake workspace uses the same field names, so a
  wrong name passes all tests. The live tests are the check.
- **The view "Databricks Tables" is in the Explorer.** To filter it, click
  in the view and type. This is the "find" feature of VS Code trees. It
  filters the lines that are loaded.

## Decisions in milestone 5

- **The driver bundles.** esbuild makes one file from `@databricks/sql`
  3.0.0 (2.6 MB). The file loads in Node.js 24 and in VS Code 1.146. The
  two optional parts with native code (`lz4-napi` and the "kernel"
  packages) are not in the file. The runner turns LZ4 compression off and
  never sets `useKernel`.
- **The driver sends usage data by default** (`telemetryEnabled`). The
  brief did not know this. The runner sets it to `false`. It also sets
  `useCloudFetch: false`, so that the driver does not download results from
  cloud storage, which is not the workspace host.
- **Minimum runtime: 14.2.** `IDENTIFIER()` needs 13.3 LTS. For named
  parameters through the driver, no page that I read gives a number. From
  memory of the Python connector docs it is 14.2. A real cluster must
  confirm this. The constant is `MIN_RUNTIME` in `core/clusters.ts`.
- **Access modes.** The names of the modes in the Clusters API
  (`SINGLE_USER`, `USER_ISOLATION`, `DATA_SECURITY_MODE_*`) are from
  memory. An unknown mode is refused.
- **HTTP path.** The session reads the workspace ID from the header
  `x-databricks-org-id` of the REST answers, or from an Azure URL. If it
  finds neither, it asks for the path one time. I did not confirm that
  Databricks sends this header.
- **Old VS Code (question 4).** Warehouses work on all versions. For a
  cluster, the session checks the Node.js version and refuses with a
  message if it is too old.
- **A stopped cluster.** After the user says yes, the session calls the
  Clusters API to start the cluster and waits until it runs. This is the
  one request of the feature that changes something in the workspace.
- **A list cannot show a line as "off".** A cluster that cannot be used has
  a different icon and its reason, and a click on it shows the reason.
- **A change of compute applies to open boards.** Their next request goes
  to the new compute.

## Decisions in milestone 6

- **The date columns of the demo tables rank first.** The two tables hold
  different years, so their dates differ. That is a true difference. The
  three planted differences in the values (`discount_pct`, `channel`,
  `amount`) come next, and all other columns have a score near 0.
- **The drift of a date** uses the date as a number of days
  (`unix_date`), so that the same decile method works for numbers and dates.
- **A discrete number** (50 values or fewer) uses the value method, as a
  category does. A column of numbers with more values uses the deciles.
- **An ID column or a complex type** has no values to compare. Its score is
  over "null" and "not null" only.
- **A column whose types differ** is not compared until the user selects
  "Compare as text". This is the opt-in that the brief asks for. If the two
  types are numbers, the column is compared as numbers with no question.
- **"B must not re-run A" has one exception:** a histogram with shared bins.
  Its bins come from the range of A and B together, so a different B can
  need a different histogram of A. All requests for the overview and the
  drift score name one dataset only; a test proves that a change of B runs
  none of them again for A.
- **Three new requests:** `quantiles` (the deciles of A), `driftBins`
  (counts between cut points), and `valueCounts` (exact counts for the
  values that one top list lacks).
- **The drift of each matched column is computed when the board opens**,
  because the sort by drift needs all scores. A table with many columns
  sends many queries; the queue of the host limits how many run at one time.
- **The question for a very large table** looks at dataset A only.
- **Dataset B uses the profile of dataset A.** Two workspaces are out of
  scope, but the dataset type has the profile.

## Proposals

None yet.
