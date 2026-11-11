#!/bin/bash
# Try the extension by hand without a Databricks workspace: opens a separate
# VS Code window (own profile, no other extensions) on a copy of samples/,
# connected to the local mock server. Close the window to stop.
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
