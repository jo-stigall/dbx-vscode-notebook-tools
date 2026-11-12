# Tests and demo

**Summary:** This folder contains three tests, one demo and a fake Databricks
server. You can run all of them on a computer that has VS Code and Python 3.
You do not need Node.js or a Databricks workspace.

The installed extension contains this page but not the test files. Get the
test files from the repository.

| File | What it does | How long it takes |
|---|---|---|
| `format.test.js` | Tests the parser (`src/format.js`). | 1 second |
| `client.test.js` | Tests how the extension finds the workspace, the token and the cluster (`src/client.js`). | 1 second |
| `run-e2e.sh` + `e2e.js` | Tests the full extension in a VS Code window. | 30 seconds |
| `demo.sh` | Opens a VS Code window so that you can try the extension. | Until you close the window |
| `mock_databricks.py` | The fake Databricks server. The test and the demo start it. | |

## Test the parser

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/format.test.js
```

This command uses the JavaScript runtime in VS Code. If all tests pass, it
prints:

```text
13 passed
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
6 passed
```

The tests make sure that the extension obeys these rules:

- It does not send the token of a profile to a different workspace.
- It refuses a workspace URL that starts with `http://`. A server on your
  computer is the only exception.
- It stops a request that gets no answer.
- It remembers one selected cluster for each project folder.

## Test the full extension

```bash
test/run-e2e.sh
```

A second VS Code window opens for some seconds, then closes. This VS Code has
its own settings in the folder `.vscode-test`. It does not change your normal
VS Code.

The test opens `samples/demo.py`, runs cells, edits a cell and saves the file.
If all steps pass, the script prints:

```text
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
ok   writes new cells in Databricks format
ok   reopening as text sticks
PASS
```

If a step fails, the script prints `FAIL` and the error. The file
`.vscode-test/vscode.log` contains the messages from VS Code.

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
| `GET /mock/requests` | Returns the requests that the extension sent until now. |

The fake server reports the text that a command printed while the command
runs. We do not know if Databricks does this also.

A test that passes with the fake server shows that the extension sends the
correct requests and shows the answers correctly. It does not show that a real
cluster gives the same answers.
