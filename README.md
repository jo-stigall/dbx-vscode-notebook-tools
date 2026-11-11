# Databricks Source Notebooks

Open Databricks `.py` source notebooks in VS Code's native notebook UI and run
cells on a Databricks cluster, with the file on disk staying the same plain
`.py` your team already commits.

Status: prototype. Tested end to end against a mock Databricks server only;
see [Not yet verified](#not-yet-verified).

## What it does

- **Notebook UI for `.py` files.** A file that starts with
  `# Databricks notebook source` opens as a notebook: `# COMMAND ----------`
  becomes cell breaks, `# MAGIC %md` becomes rendered markdown, `# MAGIC %sql`
  becomes a SQL cell, `# DBTITLE` shows as the cell title.
- **Clean diffs.** Saving writes the same source format. Cells you did not
  touch are written back byte for byte; outputs are never saved.
- **Runs on the cluster.** Every cell executes remotely in one execution
  context per notebook, so `spark`, `dbutils`, `display()` and variables behave
  as in the Databricks UI. Nothing runs on your laptop and Databricks Connect
  is not needed.
- **`%run` that works.** `%run ./other` executes the local copy of the other
  notebook in the same context, including its own `%run`, `%sql` and other
  magics.
- **Works with Copilot agent mode.** The notebook is a real VS Code notebook,
  so Copilot's notebook tools (edit cell, run cell, read output) apply. The
  file is also still plain text, so text-based edits work too.

## Install

    python3 scripts/package.py
    code --install-extension dbx-notebook-0.0.1.vsix

Or press F5 in this folder to try it in a development window.

## Connect to a workspace

The extension looks for a workspace, credentials and cluster in this order:

| | Looked up in |
|---|---|
| Workspace URL | `dbxNotebook.host` setting, `DATABRICKS_HOST`, the Databricks extension's `.databricks/.databricks.env`, `~/.databrickscfg` profile |
| Credentials | `DATABRICKS_TOKEN`, the profile's `token`, then `databricks auth token` (OAuth login via the Databricks CLI) |
| Cluster | "Databricks Notebook: Select Cluster", `dbxNotebook.clusterId`, `DATABRICKS_CLUSTER_ID`, the profile's `cluster_id` |

If you already use the official Databricks extension in the same folder, it
should pick everything up with no extra setup. The cluster must be an
all-purpose cluster and must be running.

## Use

- Open a notebook `.py` file. To see the raw text, use "Reopen Editor With..."
  and choose Text Editor. Turn off `dbxNotebook.autoOpen` to open as text by
  default and use the "Open as Databricks Notebook" button instead.
- Run cells as in any notebook. The first run creates the execution context.
- "Reset Execution Context" in the notebook toolbar clears all state (the
  equivalent of detach and re-attach).

## Limits

- Python notebooks only (`.py`); not `.sql`, `.scala` or `.r` source files.
- `%run` takes paths relative to the notebook. Workspace-absolute paths
  (`/Repos/...`) and `%run` arguments are not supported.
- Output streams only if the cluster reports partial results for a running
  command (unverified); otherwise it appears when the cell finishes.
- Serverless compute and SQL warehouses are not supported (the Command
  Execution API needs an all-purpose cluster).
- Interactive widgets panel: `dbutils.widgets` calls go to the cluster, but
  there is no widget UI.

## Not yet verified

These need a real workspace:

- Authentication paths (token, CLI OAuth, reading `.databricks/.databricks.env`).
- `%sql`, `%scala` and `%r` cells sharing one execution context.
- How `display(df)`, `displayHTML()` and matplotlib plots come back.
- `%pip` and `%fs`, which are passed to the cluster as written.
- `dbutils.widgets` and `dbutils.notebook` behaviour in this context.
- Copilot agent mode end to end.

## Develop

No build step and no dependencies; it is plain JavaScript.

    # unit tests for the .py <-> notebook conversion
    ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" test/format.test.js

    # end-to-end test in a throwaway VS Code instance against test/mock_databricks.py
    test/run-e2e.sh

| File | Purpose |
|---|---|
| `src/format.js` | Parse and serialize the Databricks source format |
| `src/client.js` | Find the workspace, credentials and cluster; REST calls |
| `src/kernel.js` | Run cells on the cluster; `%run` and other magics; render results |
| `extension.js` | Wires the above into VS Code |
