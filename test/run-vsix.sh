#!/bin/bash
# Test the packaged extension in a clean VS Code profile.
#
# Usage:
#     npm run test:vsix            # build the .vsix file, then run this script
#     test/run-vsix.sh             # use the .vsix file that is in the project folder
#     VSCODE_APP="$HOME/Applications/Visual Studio Code.app" test/run-vsix.sh
#                                  # use a VS Code that is not in /Applications
#
# The script does three things:
#   1. It makes an empty profile in .vscode-test/vsix: no settings and no other extensions.
#      It deletes the old content of that folder first.
#   2. It installs the .vsix file in that profile, as a user does.
#   3. It runs the same steps as test/run-e2e.sh. The steps then use the installed
#      copy of the extension, not the files of this folder.
#
# This shows that the .vsix file contains all files that the extension needs.
#
# Build the .vsix file first: npm run package
# The script reads the version in package.json and looks for dbx-notebook-<version>.vsix
# in the project folder.
#
# The script prints one "ok" line for each step, then PASS or FAIL. The first line is:
#     ok   runs the copy that was installed from the .vsix file
# The exit code is 0 if the test passed.
#
# If the .vsix file does not exist, or if the install fails, the script prints
# the reason and stops with the exit code 1. A window of VS Code does not open.
#
# The folder .vscode-test/vsix keeps these files for a look after a failure:
#     install.log    the messages of the install
#     vscode.log     the messages of VS Code during the test
#     result.txt     the lines that the script printed
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

# Install the .vsix file. The folder of the installed copy starts with "local.dbx-notebook-<version>".
"$APP/Contents/Resources/app/bin/code" --install-extension "$VSIX" --extensions-dir "$TMP/ext" --user-data-dir "$TMP/user" >"$TMP/install.log" 2>&1
if ! ls "$TMP/ext" | grep -q "^local.dbx-notebook-$VERSION"; then
  echo "The install failed:"
  cat "$TMP/install.log"
  exit 1
fi

# Run the steps of test/e2e.js. DBX_E2E_EXPECT_PATH makes the first step fail
# if VS Code loaded the extension from a folder other than the installed copy.
DBX_E2E_DIR="$TMP/ws" DBX_E2E_RESULT="$TMP/result.txt" DBX_E2E_EXPECT_PATH="$TMP/ext" "$APP/Contents/MacOS/Code" \
  --extensionDevelopmentPath="$TMP/runner" \
  --extensionTestsPath="$ROOT/test/e2e.js" \
  --user-data-dir="$TMP/user" \
  --extensions-dir="$TMP/ext" \
  --disable-workspace-trust --skip-welcome --skip-release-notes --disable-updates \
  "$TMP/ws" >"$TMP/vscode.log" 2>&1
status=$?

# Print the result. If VS Code stopped before it wrote the result file, print the end of its log.
cat "$TMP/result.txt" 2>/dev/null || { echo "no result file; VS Code log:"; tail -40 "$TMP/vscode.log"; }
exit $status
