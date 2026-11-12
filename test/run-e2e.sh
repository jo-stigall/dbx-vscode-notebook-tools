#!/bin/bash
# Run the end-to-end test (test/e2e.js) in a separate VS Code window.
#
# Usage:
#     test/run-e2e.sh              # use the folder .vscode-test in the project
#     test/run-e2e.sh /tmp/dbx     # use a different folder
#
# The script starts a second VS Code. That VS Code has its own settings and no
# other extensions, thus the test does not change your normal VS Code. A window
# opens for some seconds and closes when the test is done.
#
# The script prints one "ok" line for each step, then PASS or FAIL.
# The exit code is 0 if the test passed.
#
# Keep the path of the folder short. VS Code puts a socket file in the folder,
# and macOS does not accept a socket path longer than 103 characters.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="${1:-$ROOT/.vscode-test}"
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
