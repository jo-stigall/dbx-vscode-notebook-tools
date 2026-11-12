"""A fake Databricks server for tests. It runs on your computer.

The server answers the same REST requests that the extension sends to
Databricks. Use it to test the extension when you have no Databricks workspace.

How the fake server is different from Databricks:

- It runs Python code on THIS computer, not on a cluster.
- It runs SQL in an empty SQLite database. There are no Databricks tables.
- `spark` has one function, `spark.range(n)`. It returns a list, not a DataFrame.
- `display(rows)` accepts a list of dictionaries only.
- It cannot run Scala, R or `dbutils`.
- It accepts all tokens.

While a command runs, the server reports the text that the command printed
until now. We do not know if Databricks does this also.

Start the server:

    python3 test/mock_databricks.py          # the server selects a free port
    python3 test/mock_databricks.py 8765     # use port 8765

The server prints the port number on the first line of its output.

The server has two requests that Databricks does not have. Tests use them:

    POST /mock/config {"context_delay": 3}   # a new session is "Pending" for 3 seconds
    POST /mock/config {"execute_delay": 2}   # the server waits 2 seconds before it accepts a command
    POST /mock/config {"status_fails": true} # each status request of a command fails with HTTP 500
    GET  /mock/requests                      # the requests until now, for example ["POST /api/1.2/contexts/create"]
    POST /mock/requests                      # forget the requests until now
"""
import contextlib
import io
import json
import sqlite3
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

# Session ID -> the variables of that session. Databricks calls a session an "execution context".
contexts = {}

# Command ID -> {"out": the text printed until now, "result": None while the command runs, "cancelled": bool}
commands = {}

# Session ID -> the time when the session becomes ready.
ready_at = {}

# "context_delay": the number of seconds that a new session is "Pending".
# "execute_delay": the number of seconds that the server waits before it accepts a command.
# "status_fails": true makes each status request of a command fail with HTTP 500.
# Set them with POST /mock/config.
config = {"context_delay": 0, "execute_delay": 0, "status_fails": False}

# The requests that the extension sent, for example "POST /api/1.2/commands/execute". Read it with GET /mock/requests.
requests = []


class FakeSpark:
    """A small replacement for the `spark` object of Databricks."""

    def range(self, n):
        """Return rows with the numbers 0 to n-1.

        Example: FakeSpark().range(2) returns [{"id": 0}, {"id": 1}].
        """
        return [{"id": i} for i in range(n)]


def new_namespace():
    """Make the variables that each new session starts with.

    The session gets `spark`, `display()` and an empty SQLite database for SQL cells.
    """
    ns = {"spark": FakeSpark(), "_displayed": None, "_db": sqlite3.connect(":memory:", check_same_thread=False)}

    def display(rows):
        """Show rows as a table. Example: display([{"id": 1, "label": "a"}])."""
        ns["_displayed"] = rows

    ns["display"] = display
    return ns


def table(cols, rows):
    """Make a table result in the format that Databricks uses.

    Example: table(["id"], [[1], [2]]) returns
    {"resultType": "table", "schema": [{"name": "id"}], "data": [[1], [2]], "truncated": False}.
    """
    return {"resultType": "table", "schema": [{"name": c} for c in cols], "data": rows, "truncated": False}


def run(ns, language, command, out):
    """Run one command and return its result in the format that Databricks uses.

    ns: the variables of the session. Python code can read and change them.
    language: "python" or "sql". Other languages return an error result.
    command: the code to run.
    out: the function writes the text that Python prints into this StringIO object.

    The result is one of these:
    - {"resultType": "text", "data": "..."}: the text that the code printed.
    - A table result: for SQL, and for Python code that calls display().
    - {"resultType": "error", "summary": "...", "cause": "..."}: the code failed.
    """
    if language == "sql":
        try:
            cur = ns["_db"].execute(command)
            return table([d[0] for d in cur.description or []], [list(r) for r in cur.fetchall()])
        except sqlite3.Error as e:
            return {"resultType": "error", "summary": f"SQL error: {e}", "cause": f"SQL error: {e}\n\n{command}"}
    if language != "python":
        return {"resultType": "error", "summary": f"mock: {language} is not supported", "cause": ""}
    ns["_displayed"] = None
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(command, "<command>", "exec"), ns)
    except Exception as e:  # noqa: BLE001
        return {"resultType": "error", "summary": f"{type(e).__name__}: {e}", "cause": traceback.format_exc()}
    rows = ns["_displayed"]
    if rows is not None:
        cols = list(rows[0].keys()) if rows else []
        return table(cols, [[r[c] for c in cols] for r in rows])
    return {"resultType": "text", "data": out.getvalue().rstrip("\n")}


def start(ns, language, command):
    """Start a command in a second thread and return immediately.

    The server can then answer status requests while the command runs.
    The returned dictionary gets its "result" when the command is done.
    """
    cmd = {"out": io.StringIO(), "result": None, "cancelled": False}

    def work():
        cmd["result"] = run(ns, language, command, cmd["out"])

    threading.Thread(target=work, daemon=True).start()
    return cmd


class Handler(BaseHTTPRequestHandler):
    """Answers the REST requests of the extension.

    GET  /api/2.1/clusters/get       one cluster with the name "mock". It always runs.
    GET  /api/2.1/clusters/list      a list that contains the "mock" cluster.
    POST /api/1.2/contexts/create    makes a session and returns its ID.
    GET  /api/1.2/contexts/status    "Pending" until the session is ready, then "Running".
    POST /api/1.2/contexts/destroy   deletes a session.
    POST /api/1.2/commands/execute   starts a command and returns its ID.
    GET  /api/1.2/commands/status    "Running" with the text until now, or "Finished" with the result.
    POST /api/1.2/commands/cancel    the status of the command becomes "Cancelled".
    """

    def log_message(self, *args):
        """Do not print a line for each request."""

    def reply(self, body, status=200):
        """Send `body` to the extension as JSON."""
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        """Answer a GET request. See the list in the class description."""
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/mock/requests":
            return self.reply(requests)
        requests.append(f"GET {url.path}")
        if url.path == "/api/2.1/clusters/get":
            self.reply({"cluster_id": q.get("cluster_id"), "cluster_name": "mock", "state": "RUNNING"})
        elif url.path == "/api/2.1/clusters/list":
            self.reply({"clusters": [{"cluster_id": "mock", "cluster_name": "mock", "state": "RUNNING"}]})
        elif url.path == "/api/1.2/contexts/status":
            cid = q.get("contextId")
            status = "Error" if cid not in contexts else "Pending" if time.time() < ready_at[cid] else "Running"
            self.reply({"id": cid, "status": status})
        elif url.path == "/api/1.2/commands/status":
            cid = q.get("commandId")
            cmd = commands.get(cid)
            if config["status_fails"]:
                self.reply({"message": "mock: status_fails is on"}, 500)
            elif cmd is None:
                self.reply({"message": "no such command"}, 404)
            elif cmd["cancelled"]:
                self.reply({"id": cid, "status": "Cancelled"})
            elif cmd["result"] is None:
                partial = cmd["out"].getvalue().rstrip("\n")
                self.reply({"id": cid, "status": "Running", "results": {"resultType": "text", "data": partial}})
            else:
                self.reply({"id": cid, "status": "Finished", "results": cmd["result"]})
        else:
            self.reply({"message": "not found"}, 404)

    def do_POST(self):
        """Answer a POST request. See the list in the class description."""
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        path = urlparse(self.path).path
        if path == "/mock/config":
            config.update(body)
            return self.reply(config)
        if path == "/mock/requests":
            requests.clear()
            return self.reply([])
        requests.append(f"POST {path}")
        if path == "/api/1.2/contexts/create":
            cid = uuid.uuid4().hex
            contexts[cid] = new_namespace()
            ready_at[cid] = time.time() + config["context_delay"]
            self.reply({"id": cid})
        elif path == "/api/1.2/contexts/destroy":
            contexts.pop(body.get("contextId"), None)
            self.reply({})
        elif path == "/api/1.2/commands/execute":
            ns = contexts.get(body.get("contextId"))
            if ns is None:
                return self.reply({"message": "ContextNotFound"}, 500)
            time.sleep(config["execute_delay"])
            cid = uuid.uuid4().hex
            commands[cid] = start(ns, body.get("language"), body.get("command", ""))
            self.reply({"id": cid})
        elif path == "/api/1.2/commands/cancel":
            # Python cannot stop a thread. The code continues, but the server reports "Cancelled".
            if body.get("commandId") in commands:
                commands[body["commandId"]]["cancelled"] = True
            self.reply({})
        else:
            self.reply({"message": "not found"}, 404)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()
