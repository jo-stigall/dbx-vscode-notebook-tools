#!/bin/bash
# Launches a throwaway VS Code instance (its own profile, no other extensions),
# loads this extension, and runs test/e2e.js against the mock Databricks server.
# Usage: test/run-e2e.sh [scratch-dir]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="${1:-$ROOT/.vscode-test}" # keep this path short: VS Code puts a socket in it
CODE="${VSCODE_BIN:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"

rm -rf "$TMP/ws" "$TMP/result.txt"
mkdir -p "$TMP/ws" "$TMP/user" "$TMP/ext"

DBX_E2E_DIR="$TMP/ws" DBX_E2E_RESULT="$TMP/result.txt" "$CODE" \
  --extensionDevelopmentPath="$ROOT" \
  --extensionTestsPath="$ROOT/test/e2e.js" \
  --user-data-dir="$TMP/user" \
  --extensions-dir="$TMP/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
  "$TMP/ws" >"$TMP/vscode.log" 2>&1
status=$?

cat "$TMP/result.txt" 2>/dev/null || { echo "no result file; VS Code log:"; tail -40 "$TMP/vscode.log"; }
exit $status
