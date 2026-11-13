# Tests and demo

**Summary:** This folder contains the tests, one demo and a fake Databricks
server. You can run all of them on a computer that has VS Code, Python 3 and
Node.js 22 or later. You do not need a Databricks workspace.

To run all tests with one command:

```bash
npm install
npm test
```

That command checks the types, then runs the three groups of tests that this
page describes.

The installed extension contains this page but not the test files. Get the
test files from the repository.

| File | What it does | How long it takes |
|---|---|---|
| `format.test.js` | Tests the parser (`src/format.js`). | 1 second |
| `client.test.js` | Tests how the extension finds the workspace, the token and the cluster (`src/client.js`). | 1 second |
| `run-e2e.sh` + `e2e.js` | Tests the full extension in a VS Code window. | 30 seconds |
| `demo.sh` | Opens a VS Code window so that you can try the extension. | Until you close the window |
| `mock_databricks.py` | The fake Databricks server. The test and the demo start it. | |
| `tableViz/unit/` | Tests the pure code, the SQL and the demo data of "Visualize Table". | 1 second |
| `tableViz/webview/` | Tests the content of each kind of detail card. | 1 second |
| `tableViz/fake/` | A fake SQL warehouse, a fake workspace and a fake of the SQL driver. They answer from the demo tables. | |
| `tableViz/integration/workspace.cjs` | Tests "Visualize Table" in a VS Code window with the fake workspace. `e2e.js` runs it. | 5 seconds |
| `tableViz/live/` | Tests on a real Databricks workspace. They run only if you set four variables. | |
| `run-vsix.sh` | Installs the `.vsix` file in an empty VS Code profile and runs the test of the full extension on that copy. | 40 seconds |
| `tableViz/integration/demo.cjs` | Tests "Visualize Table" in a VS Code window. `e2e.js` runs it. | 2 seconds |
| `tableViz/harness/` | A page that shows a board in a normal browser. | |

## Test the parser

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/format.test.js
```

This command uses the JavaScript runtime in VS Code. If all tests pass, it
prints:

```text
15 passed
```

The most important tests make sure that a file does not change when you open
it and save it. One test does this for 5000 files that it makes from random
lines.

## Test the connection code

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/client.test.js
```

If all tests pass, the command prints:

```text
10 passed
```

The tests make sure that the extension obeys these rules:

- It does not send the token of a profile to a different workspace.
- It refuses a workspace URL that starts with `http://`. A server on your
  computer is the only exception.
- It stops a request that gets no answer.
- It remembers one selected cluster for each project folder.

## Test the code of "Visualize Table"

```bash
npm run test:unit
```

This command also runs the two tests above. Node.js runs the TypeScript files
in `tableViz/unit/` directly. It cannot run the `.tsx` file in
`tableViz/webview/`, so the command converts that file with esbuild first.
The last lines of the output give the number of tests that passed and failed:

```text
ℹ pass 157
ℹ fail 0
```

The tests make sure of these things:

- The demo tables contain the same rows on each run, and they contain the six
  known differences between 2025 and 2026.
- Each number from the demo profiler is equal to a direct count of the rows.
- Each value goes in exactly one histogram bin.
- The host refuses a message from the webview that has the wrong shape.
- Each SQL statement is equal to the text in `tableViz/unit/sql.test.ts.snapshot`.
  A table name or column name never goes into a statement without backticks.
- Each kind of detail card shows the correct numbers, and each button has a
  name for a screen reader.
- When no part of the board wants the answer of a query that still runs, the
  webview tells the host to cancel it. In compare mode, a change to dataset B
  stops the queries on the old B, and the queries on A continue
  (`tableViz/unit/requests.test.ts`).
- The warehouse runner asks for the state of a statement until it is done,
  cancels it on request and after the time limit, gets a new token after
  HTTP 401, and tries again after HTTP 429. A local server with a script
  plays the role of Databricks.
- The SQL profiler gives the same numbers as the demo profiler for each
  request type. A fake warehouse answers its statements from the demo tables.
- Browsing the catalog and searching for a table send no SQL statement.
- The table search reads the text as catalog, schema and table, puts the
  best match first, and continues when one catalog fails
  (`tableViz/unit/search.test.ts`).
- The drift maths gives the values that are computed by hand in the test,
  and a comparison of the two demo tables puts the known differences first.
- A change of dataset B runs no drift query for dataset A.
- A filter chip becomes SQL with parameters only, and in the Demo profile it
  selects the same rows as a direct count.
- The host runs no request while a saved view waits for the permission of
  the user. A saved view with a field that is not known is refused.
- The cluster runner gives the same rows as the warehouse runner. It cancels
  a statement on request and after the time limit, and it connects again
  with a new token when the token expired or the session ended. A fake of
  the SQL driver plays the role of the cluster.

If you change a SQL builder on purpose, write the snapshot file again and
read the difference before you commit it:

```bash
node --test --test-update-snapshots "test/tableViz/unit/sql.test.ts"
```

## Test the full extension

```bash
npm run test:e2e
```

This command builds "Visualize Table", then runs `test/run-e2e.sh`.

A second VS Code window opens for some seconds, then closes. This VS Code has
its own settings in the folder `.vscode-test`. It does not change your normal
VS Code.

The test opens `samples/demo.py`, runs cells, edits a cell and saves the file.
If all steps pass, the script prints:

```text
ok   the start of the extension does not load the table feature
ok   auto-opens as a notebook
ok   parses cells
ok   runs all cells with nested %run, SQL and display()
ok   saves an edit with a minimal diff
ok   re-runs a single cell with kept state
ok   streams partial output while a cell runs
ok   reports Python in a SQL cell as an error
ok   reports cell errors
ok   does not run a cell that you stop while the session starts
ok   deletes a session that you reset while it starts
ok   cancels a command that you stop while the cluster accepts it
ok   cancels a command when a status request fails
ok   writes new cells in Databricks format
ok   reopening as text sticks
ok   shows the notebook button only for a notebook file
ok   closes the text document before the notebook opens
ok   tableViz: Visualize Table opens a board
ok   tableViz: the overview of demo.shop.orders_2026 has the correct numbers
ok   tableViz: a statistics request gives numbers and the SQL behind them
ok   tableViz: Compare Tables opens a board that reads A and B
ok   tableViz: a saved view opens again with its filter and its card
ok   tableViz: a saved view from a different person asks before it runs a query
ok   tableViz: a workspace that is not trusted asks each time, and a wrong file makes no board
ok   tableViz: a bad table name opens no board
ok   tableViz: a missing table shows a plain error
ok   tableViz: the tree lists catalogs, schemas and tables without SQL
ok   tableViz: a board gets correct numbers from SQL statements on a warehouse
ok   tableViz: the cache answers a repeated request, and refresh runs it again
ok   tableViz: the tree keeps favorites and recent tables
ok   tableViz: Search Tables finds the tables of a schema and opens a board
ok   tableViz: Visualize Table shows a list of catalogs, schemas and tables
ok   tableViz: Visualize Table Under Cursor opens the table at the cursor
ok   tableViz: a cancel stops the statement on the workspace
ok   tableViz: an error from the workspace becomes a plain message
ok   tableViz: a statement starts a stopped warehouse when the question is off
ok   tableViz: the SQL driver for clusters loads in VS Code
ok   tableViz: a board gets correct numbers through the cluster runner
ok   tableViz: a cluster with a wrong access mode or an old runtime is refused
ok   tableViz: the extension starts a stopped cluster and waits until it runs
PASS
```

If a step fails, the script prints `FAIL` and the error. The file
`.vscode-test/vscode.log` contains the messages from VS Code.

## Test the packaged extension

```bash
npm run test:vsix
```

This command builds the `.vsix` file, installs it in an empty VS Code
profile (the folder `.vscode-test/vsix`), and runs the steps of the test
above on the installed copy. The first line of the output is:

```text
ok   runs the copy that was installed from the .vsix file
```

This shows that the `.vsix` file contains each file that the extension
needs, and that the notebook features and the Demo profile work after a
normal install.

## What the fake workspace does

The tests of "Visualize Table" cannot run SQL: SQLite and other local
databases do not know the Databricks functions. Thus the fake warehouse
(`tableViz/fake/warehouse.ts`) does not run the SQL. It recognizes each
statement that the extension builds, computes the same numbers from the demo
tables, and returns them as the rows that Databricks returns.

This shows that the builders, the runner and the parsers fit together. It
does not show that Databricks accepts each statement. Only the live tests
show that.

The test in VS Code loads the real SQL driver, but it does not connect with
it: a fake of the driver answers the statements. Thus no test shows that
the real driver can talk to a real cluster.

One thing has no automatic test: the questions "Start the warehouse?" and
"Start the cluster?". They are dialogs that a test cannot click.

## Test on a real workspace

These tests are off by default. To run them, set four variables:

| Variable | Value |
|---|---|
| `DATABRICKS_HOST` | The workspace URL. |
| `DATABRICKS_TOKEN` | A personal access token. |
| `TABLE_VIZ_TEST_WAREHOUSE_ID` | The ID of a SQL warehouse. |
| `TABLE_VIZ_TEST_SCHEMA` | A schema that the tests can write to, as `catalog.schema`. |
| `TABLE_VIZ_TEST_CLUSTER_ID` | Optional. The ID of an all-purpose cluster that runs. The tests then run a second time on the cluster. |

Load the demo tables into the schema one time. This script makes two tables
and writes about 210,000 rows:

```bash
npm run live:setup
```

Then run the tests:

```bash
npm run test:live
```

Each test sends a request to the workspace and to the demo profiler, and
expects the same numbers. No person has run the script or these tests yet.

## See a board in a browser

A board is a web page inside VS Code. The test page shows the same page in a
normal browser, with the demo tables. Use it to look at the page in each
theme.

```bash
npm run build
```

```bash
python3 -m http.server 8791 --bind 127.0.0.1 --directory dist/harness
```

Then open one of these addresses:

```text
http://localhost:8791/index.html?theme=dark
http://localhost:8791/index.html?theme=light&table=demo.shop.orders_2025
http://localhost:8791/index.html?theme=hc
http://localhost:8791/index.html?cards=amount&detail=1
http://localhost:8791/index.html?cards=amount&detail=1&delay=1500
http://localhost:8791/index.html?cards=amount,region,order_date&sql=1
http://localhost:8791/index.html?table=demo.shop.orders_2025&b=demo.shop.orders_2026&cards=amount,channel
```

`cards` opens detail cards at the start. `sql=1` shows the SQL of each card.
`detail=1` shows the first card as the detailed view of its column.
`delay=1500` makes each answer arrive 1.5 seconds late, so that you can see
how the page looks while it loads.
`large=1` makes the board ask before it reads all rows. `b` names a second
table: the board then compares the two tables. `confirm=1` shows the
question that a saved view asks before it runs.

The test page has no extension host, so it cannot write files. The export
commands and "Save View" do nothing visible there.

## Try the extension

```bash
test/demo.sh
```

A second VS Code window opens with a copy of `samples/demo.py`. Run cells,
change cells and save. Close the window to stop the demo.

Things to try:

- Click "Run All". The `%run` cell loads `greeting()` from
  `helpers/setup.py`.
- Add a Python cell with the code below. One number shows each second.

  ```python
  import time
  for i in range(10):
      print(i)
      time.sleep(1)
  ```

- Change a cell and save. Then right-click the tab and select "Reopen Editor
  With...", "Text Editor". Only your change is different in the file.

## What the fake server does

`mock_databricks.py` answers the REST requests that the extension sends to
Databricks. It is different from Databricks in these ways:

| With Databricks | With the fake server |
|---|---|
| The cluster runs Python. | Your computer runs Python. |
| SQL reads your Databricks tables. | SQL uses an empty SQLite database. `select 1 as id` works. `select * from sales` fails. |
| `spark` is a Spark session. | `spark` has one function: `spark.range(n)`. |
| `display(df)` shows a DataFrame. | `display(rows)` shows a list of dictionaries. |
| `dbutils`, Scala and R work. | `dbutils`, Scala and R do not work. |
| Databricks checks your token. | The server accepts all tokens. |

The fake server has two request paths that Databricks does not have. The test of
the full extension uses them:

| Request | What it does |
|---|---|
| `POST /mock/config {"context_delay": 2}` | A new session takes 2 seconds to start. |
| `POST /mock/config {"execute_delay": 2}` | The server waits 2 seconds before it accepts a command. |
| `POST /mock/config {"status_fails": true}` | Each status request of a command fails with HTTP 500. |
| `GET /mock/requests` | Returns the requests that the extension sent until now. |

The fake server reports the text that a command printed while the command
runs. We do not know if Databricks does this also.

A test that passes with the fake server shows that the extension sends the
correct requests and shows the answers correctly. It does not show that a real
cluster gives the same answers.
