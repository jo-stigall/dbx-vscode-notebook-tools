"""Run notebook cells in a Python process on this computer.

The kernel "Local Python" (src/localKernel.js) starts this script with the
Python of your project, for example `.venv/bin/python`. The script then runs
each cell that the kernel sends. Python code runs on this computer. Spark
code goes to the cluster through Databricks Connect.

The script keeps the variables between cells, as a notebook does.

The kernel and the script send each other one JSON object on each line.

The kernel writes a request to the standard input of the script:

    {"id": 1, "language": "python", "code": "print(1 + 1)"}

`language` is "python", "sql" or "shell".

The script writes messages to its standard output:

    {"type": "ready", "python": "3.12.4", "executable": "/project/.venv/bin/python"}
    {"id": 1, "type": "stream", "text": "2\\n"}
    {"id": 1, "type": "table", "schema": [{"name": "id"}], "data": [[1]], "truncated": false}
    {"id": 1, "type": "html", "data": "<b>hi</b>"}
    {"id": 1, "type": "image", "mime": "image/png", "data": "<base64>"}
    {"id": 1, "type": "done", "ok": true}
    {"id": 1, "type": "done", "ok": false, "cancelled": false, "summary": "NameError: ...", "trace": "..."}

To stop a cell, the kernel sends the signal SIGINT to the script. Python then
raises KeyboardInterrupt in the cell, and the script answers with
`"cancelled": true`. The variables stay.

The script needs Python 3.8 or later. It uses only the standard library.
`spark` needs the package `databricks-connect` in the same Python.
"""
import ast
import base64
import io
import json
import linecache
import os
import subprocess
import sys
import traceback

# The largest number of rows that display() sends for one table.
MAX_ROWS = 1000


class Channel:
    """Sends messages to the kernel.

    The script keeps the original standard output for the messages. After
    that, file descriptor 1 points to the standard error. Thus a program that
    a cell starts cannot write into the messages.
    """

    def __init__(self):
        self.out = os.fdopen(os.dup(1), "w", encoding="utf-8")
        os.dup2(2, 1)
        self.id = None  # the ID of the request that runs now

    def send(self, message):
        """Write one message. Example: send({"type": "stream", "text": "hi"})."""
        if "id" not in message and self.id is not None:
            message = dict(message, id=self.id)
        self.out.write(json.dumps(message, default=str) + "\n")
        self.out.flush()


class Stream(io.TextIOBase):
    """Replaces sys.stdout and sys.stderr. Sends the text that a cell prints to the kernel."""

    encoding = "utf-8"

    def __init__(self, channel):
        self.channel = channel

    def writable(self):
        return True

    def write(self, text):
        if text:
            self.channel.send({"type": "stream", "text": str(text)})
        return len(text)

    def isatty(self):
        return False


class Missing:
    """Stands in for `spark` or `dbutils` when the script cannot make the real object.

    A cell that uses the object gets an error that tells the reason.
    Example: Missing("spark", "No module named 'databricks.connect'").sql("select 1")
    raises RuntimeError("spark is not available: No module named ...").
    """

    def __init__(self, name, reason):
        self.__dict__["_name"] = name
        self.__dict__["_reason"] = reason

    def __getattr__(self, attribute):
        raise RuntimeError("%s is not available: %s" % (self._name, self._reason))

    def __repr__(self):
        return "<%s is not available: %s>" % (self._name, self._reason)


def make_spark():
    """Connect to the cluster with Databricks Connect.

    Databricks Connect reads the workspace URL, the login and the cluster
    from the environment variables that the kernel sets, for example
    DATABRICKS_HOST and DATABRICKS_CLUSTER_ID.
    """
    try:
        from databricks.connect import DatabricksSession
    except ImportError as e:
        return Missing(
            "spark",
            "%s. Install Databricks Connect in this Python (%s), for example: uv pip install databricks-connect" % (e, sys.executable),
        )
    try:
        return DatabricksSession.builder.getOrCreate()
    except Exception as e:  # noqa: BLE001
        return Missing("spark", "Databricks Connect did not start (%s: %s)" % (type(e).__name__, e))


def make_dbutils():
    """Make `dbutils` from the Databricks SDK. The SDK is a part of Databricks Connect."""
    try:
        from databricks.sdk import WorkspaceClient

        return WorkspaceClient().dbutils
    except Exception as e:  # noqa: BLE001
        return Missing("dbutils", "%s: %s" % (type(e).__name__, e))


class Lazy:
    """Makes `spark` or `dbutils` when a cell uses it for the first time.

    Thus the first cell starts fast, and a notebook that does not use Spark
    needs no Databricks Connect.
    """

    def __init__(self, namespace, name, make):
        self.__dict__["_slot"] = (namespace, name, make)

    def _real(self):
        namespace, name, make = self._slot
        real = make()
        if namespace.get(name) is self:
            namespace[name] = real
        self.__dict__["_slot"] = (namespace, name, lambda: real)
        return real

    def __getattr__(self, attribute):
        return getattr(self._real(), attribute)

    def __repr__(self):
        return repr(self._real())


def table_message(columns, rows):
    """Make a table message from column names and rows. It sends MAX_ROWS rows at most."""
    return {
        "type": "table",
        "schema": [{"name": str(c)} for c in columns],
        "data": [list(r) for r in rows[:MAX_ROWS]],
        "truncated": len(rows) > MAX_ROWS,
    }


def display_message(value):
    """Convert a value to the message that shows it.

    | Value                          | Message                         |
    |--------------------------------|---------------------------------|
    | Spark DataFrame                | a table with the first 1000 rows |
    | pandas DataFrame               | a table with the first 1000 rows |
    | list of dictionaries           | a table                          |
    | matplotlib figure              | an image                         |
    | other                          | the text of repr(value)          |
    """
    module = type(value).__module__ or ""
    if module.startswith("pyspark") and hasattr(value, "limit") and hasattr(value, "columns"):
        rows = value.limit(MAX_ROWS + 1).collect()
        return table_message(value.columns, [list(r) for r in rows])
    if module.startswith("pandas") and hasattr(value, "columns") and hasattr(value, "head"):
        head = value.head(MAX_ROWS + 1)
        message = table_message(list(head.columns), head.astype(object).where(head.notna(), None).values.tolist())
        message["truncated"] = len(value) > MAX_ROWS
        return message
    if module.startswith("matplotlib") and hasattr(value, "savefig"):
        return figure_message(value)
    if isinstance(value, list) and value and all(isinstance(r, dict) for r in value):
        columns = list(value[0].keys())
        return table_message(columns, [[r.get(c) for c in columns] for r in value])
    return {"type": "stream", "text": repr(value) + "\n"}


def figure_message(figure):
    """Make an image message from a matplotlib figure."""
    data = io.BytesIO()
    figure.savefig(data, format="png", bbox_inches="tight")
    return {"type": "image", "mime": "image/png", "data": base64.b64encode(data.getvalue()).decode("ascii")}


def send_figures(channel):
    """Send each open matplotlib figure as an image, then close the figures.

    This is what a notebook does at the end of a cell that makes a plot.
    The function does nothing if the cell did not import matplotlib.
    """
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    for number in pyplot.get_fignums():
        channel.send(figure_message(pyplot.figure(number)))
    pyplot.close("all")


def run_python(code, namespace):
    """Run Python code in the namespace of the notebook.

    If the last statement is an expression, the function prints its value,
    as a notebook does. Example: the cell "x = 2\\nx + 1" prints "3".
    """
    # An error message can then show the line of the cell that failed.
    linecache.cache["<cell>"] = (len(code), None, code.splitlines(True), "<cell>")
    tree = ast.parse(code, "<cell>", "exec")
    last = tree.body[-1] if tree.body else None
    if isinstance(last, ast.Expr):
        tree.body.pop()
        exec(compile(tree, "<cell>", "exec"), namespace)
        value = eval(compile(ast.Expression(last.value), "<cell>", "eval"), namespace)
        if value is not None:
            print(repr(value))
    else:
        exec(compile(tree, "<cell>", "exec"), namespace)


def run_sql(code, namespace, channel):
    """Run one SQL statement with `spark.sql()` and show the result as a table.

    The result is also in the variable `_sqldf`, as in Databricks.
    """
    result = namespace["spark"].sql(code.strip().rstrip(";"))
    namespace["_sqldf"] = result
    if not hasattr(result, "columns") or result.columns:
        channel.send(display_message(result))


def run_shell(code):
    """Run shell commands on this computer and print their output while they run.

    The function uses bash if the computer has it.
    """
    bash = "/bin/bash" if os.path.exists("/bin/bash") else None
    process = subprocess.Popen(code, shell=True, executable=bash, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        for line in process.stdout:
            print(line, end="")
    except KeyboardInterrupt:
        process.kill()
        raise
    finally:
        process.wait()
    if process.returncode != 0:
        raise RuntimeError("%%sh exited with code %d" % process.returncode)


def short_trace():
    """Get the error text of the exception that occurs now, without the lines of this script."""
    kind, error, tb = sys.exc_info()
    frames = [f for f in traceback.extract_tb(tb) if f.filename != __file__]
    lines = ["Traceback (most recent call last):\n"] + traceback.format_list(frames) if frames else []
    return "".join(lines + traceback.format_exception_only(kind, error)).rstrip("\n")


def main():
    """Read requests until the kernel closes the standard input."""
    channel = Channel()
    sys.stdout = sys.stderr = Stream(channel)
    os.environ.setdefault("MPLBACKEND", "Agg")  # matplotlib must not open a window

    # A notebook in Databricks can import files from its own folder and from the top of the project.
    # The kernel starts this script in the folder of the notebook.
    sys.path[0] = os.getcwd()
    for extra in filter(None, os.environ.get("DBX_NOTEBOOK_PATHS", "").split(os.pathsep)):
        if extra not in sys.path:
            sys.path.append(extra)

    namespace = {"__name__": "__main__"}
    namespace["spark"] = Lazy(namespace, "spark", make_spark)
    namespace["dbutils"] = Lazy(namespace, "dbutils", make_dbutils)
    namespace["display"] = lambda value: channel.send(display_message(value))
    namespace["displayHTML"] = lambda html: channel.send({"type": "html", "data": str(html)})

    channel.send({"type": "ready", "python": sys.version.split()[0], "executable": sys.executable})

    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            continue  # the stop signal came after the cell was done
        if not line:
            return
        request = json.loads(line)
        channel.id = request["id"]
        done = {"type": "done", "ok": True}
        try:
            if request["language"] == "sql":
                run_sql(request["code"], namespace, channel)
            elif request["language"] == "shell":
                run_shell(request["code"])
            else:
                run_python(request["code"], namespace)
            send_figures(channel)
        except KeyboardInterrupt:
            done = {"type": "done", "ok": False, "cancelled": True}
        except BaseException as e:  # noqa: BLE001  (a cell can call sys.exit())
            done = {"type": "done", "ok": False, "cancelled": False, "summary": "%s: %s" % (type(e).__name__, e), "trace": short_trace()}
        try:
            channel.send(done)
        except KeyboardInterrupt:
            channel.send(done)
        channel.id = None


if __name__ == "__main__":
    main()
