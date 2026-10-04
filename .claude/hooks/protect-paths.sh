#!/usr/bin/env bash
# PreToolUse Edit|Write: block edits to generated, secret or human-only paths.
set -euo pipefail
# Normalise Windows paths (C:\a\b) so the patterns below match on every OS.
path=$(jq -r '.tool_input.file_path // empty' | tr -d '\r' | tr '\\' '/')
case "$path" in
  */.env.example) ;;
  */packages/db/migrations/*) echo "Migrations are generated: run pnpm db:new <name> instead." >&2; exit 2 ;;
  */.env*|*/infra/*secret*)   echo "Secrets files are off-limits. Use fly secrets / GH secrets." >&2; exit 2 ;;
  */.github/workflows/deploy.yml) echo "deploy.yml changes require a human; describe the change instead." >&2; exit 2 ;;
esac
exit 0
