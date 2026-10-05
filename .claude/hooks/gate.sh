#!/usr/bin/env bash
# Stop: refuse to finish while typecheck, lint or tests are red for affected packages.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# Nothing to gate until the monorepo skeleton exists.
[ -f turbo.json ] || exit 0

# Workspace not installed yet: skip rather than fail on a missing turbo/pnpm.
if [ ! -e node_modules/.bin/turbo ] || ! command -v pnpm >/dev/null 2>&1; then
  echo "gate: workspace not installed (run pnpm install); skipping" >&2
  exit 0
fi

if git rev-parse --verify -q origin/main >/dev/null; then
  filter=(--filter='...[origin/main]')
elif git rev-parse --verify -q HEAD~1 >/dev/null; then
  filter=(--filter='...[HEAD~1]')
else
  filter=()
fi

out=$(pnpm turbo typecheck lint test "${filter[@]}" 2>&1)
if [ $? -ne 0 ]; then
  echo "Gate failed. Fix before finishing:" >&2
  echo "$out" | tail -60 >&2
  exit 2
fi
exit 0
