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

1. Build the install file:

   ```bash
   python3 scripts/package.py
   ```

2. Install it in VS Code:

   ```bash
   code --install-extension dbx-notebook-0.0.1.vsix
   ```

You do not need Node.js. To try the extension without a Databricks workspace,
see [test/README.md](test/README.md).

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
