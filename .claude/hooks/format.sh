#!/usr/bin/env bash
# PostToolUse Edit|Write: format the edited file with prettier, if installed.
set -uo pipefail
path=$(jq -r '.tool_input.file_path // empty' | tr -d '\r')
[ -n "$path" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
[ -e node_modules/.bin/prettier ] || exit 0
node_modules/.bin/prettier --write --ignore-unknown "$path" >/dev/null 2>&1 || true
exit 0
