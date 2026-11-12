# How the extension works

**Summary:** The extension has three parts. The parser converts a `.py` file
to cells, and back. The kernel sends each cell to a Databricks cluster. The
client finds your workspace and your login. This page explains each part and
tells you where its code is.

## Where the code is

| File | What it does |
|---|---|
| `extension.js` | Starts the extension. Connects the three parts to VS Code. |
| `src/format.js` | The parser. Converts a `.py` file to cells, and back. |
| `src/kernel.js` | The kernel. Runs cells on the cluster and shows the results. |
| `src/client.js` | The client. Finds the workspace, the login and the cluster. Sends REST requests. |
| `package.json` | Tells VS Code the name of the extension, its commands and its settings. |
| `scripts/package.py` | Builds the `.vsix` install file. |
| `docs/` | This page. |
| `test/` | The tests and the fake Databricks server. See [test/README.md](../test/README.md). |
| `samples/` | Three small notebooks for the tests and the demo. |

The code is plain JavaScript. It has no build step and no packages to install.

## The file format

Databricks saves a Python notebook as a `.py` file with four types of special
comment:

```python
# Databricks notebook source        <- 1. The first line of each notebook file.
# MAGIC %md                         <- 2. "# MAGIC" lines hold content that is not Python.
# MAGIC # Sales report

# COMMAND ----------                <- 3. This line separates two cells.

# DBTITLE 1,Load the data           <- 4. The title of a cell (optional).
df = spark.table("sales")
```

## How the extension opens a file

`parseNotebook()` in `src/format.js` splits the file at each
`# COMMAND ----------` line. Then `parseCell()` looks at each part:

| Text in the file | Cell in the notebook |
|---|---|
| `# MAGIC %md` and more `# MAGIC` lines | A text cell. |
| `# MAGIC %sql` and more `# MAGIC` lines | An SQL cell. `%scala`, `%r` and `%sh` work in the same way. |
| `# MAGIC %run ./setup` | A Python cell that shows `%run ./setup`. |
| Lines without `# MAGIC` | A Python cell. |
| `# DBTITLE 1,Load the data` on the first line | The cell shows the title "Load the data" below it. |

A `.py` file that does not start with `# Databricks notebook source` opens as
text. If you open it as a notebook with "Open as Databricks Notebook", you get
one Python cell that contains all of the file.

## How the extension saves a file

The extension obeys one rule: **if you did not change a cell, the extension
writes the same bytes again.**

When the extension opens a file, each cell keeps a copy of its original text.
When you save, `serializeNotebook()` does this for each cell:

- You did not change the cell: the function writes the original text.
- You changed the cell, or the cell is new: the function writes the cell in
  the format that Databricks uses.

Example. The file contains an SQL cell on one line. Databricks usually writes
`%sql` on a line of its own:

```python
# MAGIC %sql select 1
```

If you open and save the file, the line stays the same. If you change the
query to `select 2`, the extension writes the cell in the Databricks format:

```python
# MAGIC %sql
# MAGIC select 2
```

The extension does not save results. A result never changes the file.

## How the extension runs a cell

When you run a cell, VS Code calls `Kernel.execute()` in `src/kernel.js`. The
kernel then does these steps:

1. **Find the workspace.** `Connection.resolve()` in `src/client.js` reads
   your settings, your environment variables and your Databricks files. The
   [README](../README.md#connect-to-your-workspace) lists the sequence.
2. **Start a session.** The first cell of a notebook tells the cluster to
   start a Python session. Databricks calls this session an "execution
   context". The session keeps your variables between cells. Each open
   notebook has its own session. If you stop or reset the notebook while the
   session starts, the kernel does not send the cell.
3. **Send the cell.** The kernel sends the text of the cell to the cluster
   with `POST /api/1.2/commands/execute`.
4. **Wait for the result.** The kernel asks the cluster for the status of the
   command with `GET /api/1.2/commands/status`. It asks again until the
   command is done. If the cluster reports text before the command is done,
   the kernel shows that text immediately. If the cluster does not answer a
   request in 30 seconds, the cell stops with an error.
5. **Show the result.** The kernel converts the result to a cell output:

   | Result from the cluster | What you see |
   |---|---|
   | Text | The text. |
   | Table | A table. A tool such as Copilot gets the table as text with tabs. |
   | Image | The image. |
   | Error | The error message in red. The cell shows a red cross. |

The kernel runs one cell at a time. If a cell fails, the kernel does not run
the cells after it.

When you close the notebook, the kernel deletes the session on the cluster.

## How `%run` works

The cluster cannot see the files on your disk. Thus the kernel does the work
of `%run`:

1. The kernel reads the other notebook from your disk.
2. The kernel splits it into cells with `parseNotebook()`.
3. The kernel runs each code cell in the session of the open notebook.

Example with the files in `samples/`:

```text
demo.py              contains  %run ./helpers/setup
helpers/setup.py     contains  %run ./constants  and  def greeting(name): ...
helpers/constants.py contains  PREFIX = "hello"
```

When you run the `%run` cell of `demo.py`, the kernel runs `constants.py`,
then the other cells of `setup.py`. After that, `greeting("world")` in
`demo.py` returns `"hello, world"`.

The kernel stops with an error if notebooks call each other more than 20
levels deep. This occurs when two notebooks call each other in a loop.

## How the extension works with Copilot

The extension gives VS Code a real notebook, with a kernel. Copilot agent mode
has tools to add a cell, edit a cell, run a cell and read a result. These tools
work with all VS Code notebooks, thus they work with this one.

Two things help Copilot:

- The kernel tells VS Code if each cell passed or failed. Copilot reads this
  value to know if its code worked.
- A table result contains the table as text. Copilot can read the text.

A cell that Copilot adds has no original text. The extension writes it in the
format that Databricks uses.
