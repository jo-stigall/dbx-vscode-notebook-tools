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

type Request =                                       // `columns` is a list, so two-column views fit later
  | { type: 'tableDetails'; dataset: Dataset }
  | { type: 'overview'; dataset: Dataset; columns: string[] }
  | { type: 'numericStats'; dataset: Dataset; columns: [string]; exact: boolean }
  | { type: 'histogram'; dataset: Dataset; columns: [string]; edges: BinEdges }
  | { type: 'frequency'; dataset: Dataset; columns: [string]; top: number; values?: string[] }
  | { type: 'dateCounts'; dataset: Dataset; columns: [string]; grain: Grain }
  | { type: 'driftBins'; dataset: Dataset; columns: [string]; cuts: string[] }
  | { type: 'validateFilter'; dataset: Dataset };

type Result = { type: Request['type']; sql: string[]; approximate: boolean; asOf: string } & ResultBody;
// BinEdges, Grain and ResultBody (one shape for each request type) come in milestone 2.
```

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

1. **Node.js (blocks milestone 2).** This computer has no Node.js. The
   feature needs npm packages and a build step. May I install Node.js with
   Homebrew? Without it I cannot add the driver, React, or TypeScript.
2. **Language.** The extension is plain JavaScript. I recommend TypeScript
   for `src/tableViz/` only, and no change to the existing files. Is a
   repository with two languages acceptable?
3. **Login sequence.** The extension looks at settings, then variables, then
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

## Proposals

None yet.
