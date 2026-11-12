# Databricks Source Notebooks

**Summary:** This VS Code extension opens a Databricks `.py` notebook file as
a notebook. It runs each cell on your Databricks cluster. It saves the file in
the same `.py` format that Databricks uses, so your git diffs stay small.

**Status:** Prototype. The tests use a fake Databricks server. No person has
run the extension on a real cluster. See
[Things that are not tested](#things-that-are-not-tested).

## What the extension does

Your team saves notebooks as `.py` files like this one:

```python
# Databricks notebook source
# MAGIC %md
# MAGIC # Sales report

# COMMAND ----------

# MAGIC %run ./helpers/setup

# COMMAND ----------

# MAGIC %sql
# MAGIC select region, sum(amount) from sales group by region

# COMMAND ----------

df = spark.table("sales")
display(df)
```

Without the extension, VS Code shows this file as text. With the extension:

- **You see a notebook.** The file above opens as four cells: a title, a
  `%run` cell, an SQL cell and a Python cell. Each result shows below its cell.
- **The cluster runs the cells.** `spark`, `dbutils` and `display()` work as
  they do in Databricks, because the code runs in the same place. Your
  computer runs no notebook code. You do not need Databricks Connect.
- **`%run` works.** `%run ./helpers/setup` runs the file `helpers/setup.py`
  from your disk. That file can contain `%run` and `%sql` cells.
- **The file stays the same.** If you change one cell and save, git shows a
  change in that cell only. The extension does not save results in the file.
- **Copilot can use the notebook.** Copilot agent mode can add a cell, run a
  cell and read the result. Copilot can also edit the `.py` file as text.

## Install the extension

1. Get the packages that the build uses. You need Node.js 22 or later for
   this step and the next step.

   ```bash
   npm install
   ```

2. Build the install file:

   ```bash
   npm run package
   ```

3. Install it in VS Code:

   ```bash
   code --install-extension dbx-notebook-0.0.1.vsix
   ```

A computer that only installs the `.vsix` file does not need Node.js. To try
the extension without a Databricks workspace, see
[test/README.md](test/README.md).

## Connect to your workspace

The extension needs three things: the URL of your workspace, a login and a
cluster. For each one, it looks in the numbered places below, starting at 1.
It uses the first value that it finds.

| The extension needs | Where it looks |
|---|---|
| Workspace URL | 1. Setting `dbxNotebook.host`. 2. Variable `DATABRICKS_HOST`. 3. The file `.databricks/.databricks.env` in your project. 4. Your profile in `~/.databrickscfg`. |
| Login | 1. Variable `DATABRICKS_TOKEN`. 2. The `token` in your profile. 3. The command `databricks auth token`. |
| Cluster | 1. The cluster that you selected with "Select Cluster". 2. Setting `dbxNotebook.clusterId`. 3. Variable `DATABRICKS_CLUSTER_ID`. 4. The `cluster_id` in your profile. |

Three rules protect your token:

- The workspace URL must start with `https://`. The extension refuses
  `http://`, because `http://` sends your token as plain text.
- The extension uses the `token` of a profile only if the `host` of that
  profile is the same workspace URL. Example: your profile is for workspace A,
  and the project names workspace B. The extension does not send the token of
  workspace A to workspace B. It asks `databricks auth token` for a token for
  workspace B.
- The extension is off in a project that you did not trust (VS Code
  "Restricted Mode").

VS Code remembers one selected cluster for each project folder. If a VS Code
window has two project folders, each folder can use a different cluster.

If you use the official Databricks extension in the same project, you
probably do not need to set anything. The official extension writes
`.databricks/.databricks.env`, and it installs the `databricks` command.

The cluster must be an all-purpose cluster, and it must run before you run a
cell. The extension does not start a cluster.

## Use the notebook

1. Open a notebook `.py` file. The file opens as a notebook if its first line
   is `# Databricks notebook source`.
2. Run a cell. The first cell is slow, because the cluster must start a
   session for the notebook.
3. If the extension asks for a cluster, select your cluster from the list.

More things that you can do:

| To do this | Do this |
|---|---|
| See the file as text | Right-click the tab, select "Reopen Editor With...", then "Text Editor". |
| Go back to the notebook | Click the notebook button at the top right of the text editor. |
| Change the language of a cell | Click the language name at the bottom right of the cell. |
| Delete all variables on the cluster | Click "Reset Execution Context" in the notebook toolbar. |
| Use a different cluster | Click "Select Cluster" in the notebook toolbar. |
| Stop a cell | Click the stop button of the cell. |

If Databricks does not answer a request in 30 seconds, the cell stops with an
error. The command can continue on the cluster. Click "Reset Execution
Context" to stop it.

A cell keeps its language when you replace its text. If you paste Python into
an SQL cell, the cluster reports an SQL error. Change the language of the cell
to Python first.

## Look at a table

**Summary:** The command "Visualize Table" opens a page that shows each
column of a Databricks table: its type, how many rows are null, how many
different values it has, and charts of its values. Databricks computes all
numbers. The extension never downloads the rows of the table.

This part is not complete, and no person has run it on a real workspace. It
works with SQL warehouses. It does not work with clusters yet, and it cannot
compare two tables yet. [docs/table-viz-design.md](docs/table-viz-design.md)
has the plan.

### Select the login and the warehouse

Run "Databricks Notebook: Select Profile and Compute for Tables". The first
list shows the logins that you can use:

| Entry in the list | What it uses |
|---|---|
| Notebook connection | The workspace of the notebooks. See [Connect to your workspace](#connect-to-your-workspace). |
| The name of a profile | That profile in `~/.databrickscfg`. If the profile has no `token` line, log in with `databricks auth login --profile <name>`. |
| A workspace URL | A token that you typed before. VS Code keeps it in its secret store, not in a file. |
| Demo | Two demo tables, `demo.shop.orders_2025` and `demo.shop.orders_2026`. No workspace and no login. |
| Type a workspace URL and a token… | Asks for the URL and a personal access token. |

The second list shows the SQL warehouses of the workspace, with their state
and size. The status bar then shows the login and the warehouse. Click it to
select a different one.

If the warehouse is stopped, the extension asks before the first query
starts it, because a warehouse that runs costs money.

### Open a table

| To do this | Do this |
|---|---|
| Open a table by its name | Run "Databricks Notebook: Visualize Table" and type `catalog.schema.table`. |
| Find a table | Open the view "Databricks Tables" in the Explorer. Open a catalog and a schema, then click a table. Click in the view and type to filter. |
| Keep a table at hand | Click the star on a table in the view. The table is then below "Favorites". |
| Open a table from code | In a `.sql` or `.py` file, right-click a name such as `main.sales.orders` and select "Visualize Table Under Cursor". |

The view reads the catalog with the REST API. It never starts a warehouse.

### Use the board

Click the name of a column to open its detail card. The card shows a chart
and a table that fit the column:

| Column | The card shows |
|---|---|
| A number with many values | A histogram, and the mean, the median and other statistics. |
| A number with few values, or a category | One bar for each value, and a table of the values with their counts. |
| An ID | The number of different values, the values that repeat, and the lengths of the values. |
| A date | The number of rows in each day, week, month or year. |

On each card you can change how the feature reads the column (for example, a
postal code is a category, not a number), show the chart as a table, show the
SQL behind the numbers, and pin the card so that it stays next to the next
card that you open.

Above the cards:

| Control | What it does |
|---|---|
| Filter | Type a SQL condition, for example `order_date >= '2026-01-01' AND region = 'EMEA'`. Databricks checks the condition before the board uses it. |
| Sample | Read a part of the rows only. This is faster and cheaper. All counts are then estimates, and each card shows "Sampled". |
| Refresh | Run all queries again. |
| Cancel | Stop the queries that run now. The extension also stops the query of a card that you close. |

"≈" before a number shows that Databricks estimated it.

### What the feature sends to Databricks

- Only `SELECT` and `DESCRIBE` statements. Each statement returns counts and
  statistics, never rows of the table.
- Each statement has the tag `feature` = `table-viz`, so that an
  administrator can find these queries in the query history.
- For a Delta table, all queries read the version that the table had when
  you opened the board. The cards then agree while a job writes to the table.
- Before the first query on a table larger than 100 GB, the board asks. You
  can use a sample or a filter.
- The extension runs 4 queries at the same time at most, and it cancels a
  query after 5 minutes. The settings change both numbers.

## Magic commands

| First line of the cell | What the extension does |
|---|---|
| `%md` | Shows the cell as text. Does not run it. |
| `%sql`, `%scala`, `%r` | Sends the cell to the cluster in that language. |
| `%sh` | Runs the cell in `bash` on the driver of the cluster. |
| `%run ./other` | Runs `other.py` from your disk in the session of this notebook. |
| `%python` | Runs the other lines of the cell as Python. |
| `%pip`, `%fs` and all others | Sends the cell to the cluster without a change. |

## Settings

| Setting | Default | What it does |
|---|---|---|
| `dbxNotebook.autoOpen` | on | Opens Databricks `.py` files as notebooks. Set it to off to open them as text. |
| `dbxNotebook.host` | empty | The URL of your workspace. Example: `https://adb-123.azuredatabricks.net`. |
| `dbxNotebook.profile` | empty | The name of your profile in `~/.databrickscfg`. Empty uses `DEFAULT`. |
| `dbxNotebook.clusterId` | empty | The ID of your cluster. Example: `0101-123456-abcdefgh`. |
| `dbxNotebook.cliPath` | empty | The path of the `databricks` command. Empty uses the one from the official extension. |
| `dbxNotebook.tableViz.defaultBins` | 30 | The number of bins of a new histogram in "Visualize Table". From 5 to 200. |
| `dbxNotebook.tableViz.topValues` | 20 | The number of values in the bar chart of a category column. From 1 to 100. |
| `dbxNotebook.tableViz.warehouseId` | empty | The ID of the SQL warehouse for "Visualize Table". A warehouse that you select from the list is used before this setting. |
| `dbxNotebook.tableViz.confirmComputeStart` | on | Ask before a query starts a stopped warehouse. |
| `dbxNotebook.tableViz.maxConcurrentQueries` | 4 | The largest number of queries that run at the same time. |
| `dbxNotebook.tableViz.queryTimeoutSeconds` | 300 | The time limit of one query, in seconds. |
| `dbxNotebook.tableViz.largeTableWarningGB` | 100 | The board asks before the first full scan of a table that is larger than this size. |

## Limits

- The extension opens Python notebooks only. It does not open `.sql`,
  `.scala` or `.r` notebook files.
- `%run` accepts a path that starts from the folder of the notebook, such as
  `./helpers/setup` or `../common`. It does not accept a workspace path such
  as `/Repos/team/project/setup`.
- `%run` ignores values after the path. `%run ./setup $env="dev"` runs
  `setup.py` but does not set `env`.
- The extension does not work with serverless compute or SQL warehouses.
- The extension shows no boxes for `dbutils.widgets` values.

## Things that are not tested

A real cluster must confirm each item in this list:

- All three login methods.
- A Personal Compute cluster.
- `%sql`, `%scala` and `%r` cells in the same session as Python cells.
- The results of `display(df)`, `displayHTML()` and plots.
- `%pip` and `%fs`.
- `dbutils.widgets` and `dbutils.notebook`.
- Text that shows while a cell runs. The extension shows such text if the
  cluster reports it. We do not know if a real cluster reports it.
- Copilot agent mode.

## More documentation

| File | What it tells you |
|---|---|
| [docs/how-it-works.md](docs/how-it-works.md) | How the extension opens, saves and runs a notebook. Where each part is in the code. |
| [test/README.md](test/README.md) | How to run the tests and the demo. What the fake Databricks server does. |
| [docs/table-viz-design.md](docs/table-viz-design.md) | The plan for the "Visualize Table" feature. |
