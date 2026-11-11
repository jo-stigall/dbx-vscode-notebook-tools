"""Tiny stand-in for the Databricks REST endpoints the extension calls.

For local testing without a workspace. Python commands are exec'd in a
per-context namespace on THIS machine; SQL runs in an in-memory SQLite
database. While a command runs, its status reports the text printed so far.
Prints the port it listens on as the first line of stdout.

    python3 test/mock_databricks.py [port]
"""
import contextlib
import io
import json
import sqlite3
import sys
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

contexts = {}  # context id -> python namespace
commands = {}  # command id -> {"out": StringIO, "result": dict or None, "cancelled": bool}


class FakeSpark:
    def range(self, n):
        return [{"id": i} for i in range(n)]


def new_namespace():
    ns = {"spark": FakeSpark(), "_displayed": None, "_db": sqlite3.connect(":memory:", check_same_thread=False)}

    def display(rows):
        ns["_displayed"] = rows

    ns["display"] = display
    return ns


def table(cols, rows):
    return {"resultType": "table", "schema": [{"name": c} for c in cols], "data": rows, "truncated": False}


def run(ns, language, command, out):
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
    cmd = {"out": io.StringIO(), "result": None, "cancelled": False}

    def work():
        cmd["result"] = run(ns, language, command, cmd["out"])

    threading.Thread(target=work, daemon=True).start()
    return cmd


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path == "/api/2.1/clusters/get":
            self.reply({"cluster_id": q.get("cluster_id"), "cluster_name": "mock", "state": "RUNNING"})
        elif url.path == "/api/2.1/clusters/list":
            self.reply({"clusters": [{"cluster_id": "mock", "cluster_name": "mock", "state": "RUNNING"}]})
        elif url.path == "/api/1.2/contexts/status":
            self.reply({"id": q.get("contextId"), "status": "Running" if q.get("contextId") in contexts else "Error"})
        elif url.path == "/api/1.2/commands/status":
            cid = q.get("commandId")
            cmd = commands.get(cid)
            if cmd is None:
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
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        path = urlparse(self.path).path
        if path == "/api/1.2/contexts/create":
            cid = uuid.uuid4().hex
            contexts[cid] = new_namespace()
            self.reply({"id": cid})
        elif path == "/api/1.2/contexts/destroy":
            contexts.pop(body.get("contextId"), None)
            self.reply({})
        elif path == "/api/1.2/commands/execute":
            ns = contexts.get(body.get("contextId"))
            if ns is None:
                return self.reply({"message": "ContextNotFound"}, 500)
            cid = uuid.uuid4().hex
            commands[cid] = start(ns, body.get("language"), body.get("command", ""))
            self.reply({"id": cid})
        elif path == "/api/1.2/commands/cancel":
            # The mock cannot stop a running thread; it just reports the command as cancelled.
            if body.get("commandId") in commands:
                commands[body["commandId"]]["cancelled"] = True
            self.reply({})
        else:
            self.reply({"message": "not found"}, 404)


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()
