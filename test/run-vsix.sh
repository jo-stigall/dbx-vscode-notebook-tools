#!/bin/bash
# Test the packaged extension in a clean VS Code profile.
#
# Usage:
#     npm run test:vsix
#
# The script does three things:
#   1. It makes an empty profile in .vscode-test/vsix: no settings and no other extensions.
#   2. It installs the .vsix file in that profile, as a user does.
#   3. It runs the same steps as test/run-e2e.sh. The steps then use the installed
#      copy of the extension, not the files of this folder.
#
# This shows that the .vsix file contains all files that the extension needs.
#
# Build the .vsix file first: npm run package
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$ROOT/.vscode-test/vsix"
APP="${VSCODE_APP:-/Applications/Visual Studio Code.app}"
VERSION="$(python3 -c "import json; print(json.load(open('$ROOT/package.json'))['version'])")"
VSIX="$ROOT/dbx-notebook-$VERSION.vsix"

if [ ! -f "$VSIX" ]; then
  echo "$VSIX does not exist. Run: npm run package"
  exit 1
fi

rm -rf "$TMP"
mkdir -p "$TMP/ws" "$TMP/user" "$TMP/ext" "$TMP/runner"

# VS Code runs test steps only for an extension "in development". This empty extension has that role.
# The extension under test is the installed one.
cat > "$TMP/runner/package.json" <<JSON
{ "name": "runner", "publisher": "test", "version": "0.0.0", "engines": { "vscode": "*" } }
JSON

"$APP/Contents/Resources/app/bin/code" --install-extension "$VSIX" --extensions-dir "$TMP/ext" --user-data-dir "$TMP/user" >"$TMP/install.log" 2>&1
if ! ls "$TMP/ext" | grep -q "^local.dbx-notebook-$VERSION"; then
  echo "The install failed:"
  cat "$TMP/install.log"
  exit 1
fi

DBX_E2E_DIR="$TMP/ws" DBX_E2E_RESULT="$TMP/result.txt" DBX_E2E_EXPECT_PATH="$TMP/ext" "$APP/Contents/MacOS/Code" \
  --extensionDevelopmentPath="$TMP/runner" \
  --extensionTestsPath="$ROOT/test/e2e.js" \
  --user-data-dir="$TMP/user" \
  --extensions-dir="$TMP/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
  "$TMP/ws" >"$TMP/vscode.log" 2>&1
status=$?

cat "$TMP/result.txt" 2>/dev/null || { echo "no result file; VS Code log:"; tail -40 "$TMP/vscode.log"; }
exit $status
