#!/usr/bin/env bash
# PreToolUse Write|Edit for the qa agent: QA may only write test files.
set -euo pipefail
path=$(jq -r '.tool_input.file_path // empty' | tr -d '\r' | tr '\\' '/')
case "$path" in
  */test/*|*/tests/*|*/__tests__/*|*/e2e/*) exit 0 ;;
  *.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx) exit 0 ;;
esac
echo "QA writes tests only; '$path' is not a test file. Report the defect to dev instead." >&2
exit 2
