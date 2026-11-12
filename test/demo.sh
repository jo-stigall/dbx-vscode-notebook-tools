#!/bin/bash
# Try the extension without a Databricks workspace.
#
# Usage:
#     test/demo.sh               # the fake server uses port 8765
#     PORT=9000 test/demo.sh     # use a different port
#
# The script does three things:
#   1. It copies samples/ to .vscode-test/demo. Your edits do not change samples/.
#   2. It starts the fake Databricks server (test/mock_databricks.py).
#   3. It opens demo.py in a second VS Code. That VS Code has its own settings
#      and no other extensions.
#
# Close the VS Code window to stop the script and the fake server.
#
# The fake server runs Python on this computer and SQL in an empty SQLite
# database. It has no Databricks tables.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$ROOT/.vscode-test"
CODE="${VSCODE_BIN:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
PORT="${PORT:-8765}"

rm -rf "$TMP/demo"
mkdir -p "$TMP/demo-user" "$TMP/ext"
cp -R "$ROOT/samples" "$TMP/demo"

python3 "$ROOT/test/mock_databricks.py" "$PORT" >/dev/null &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT

DATABRICKS_HOST="http://127.0.0.1:$PORT" DATABRICKS_TOKEN=mock-token DATABRICKS_CLUSTER_ID=mock \
DATABRICKS_CONFIG_FILE="$TMP/no-such-databrickscfg" "$CODE" \
  --extensionDevelopmentPath="$ROOT" \
  --user-data-dir="$TMP/demo-user" \
  --extensions-dir="$TMP/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
  "$TMP/demo" "$TMP/demo/demo.py" >/dev/null 2>&1
