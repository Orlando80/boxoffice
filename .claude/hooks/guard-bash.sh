#!/usr/bin/env bash
# PreToolUse Bash|PowerShell: block destructive or deploy-affecting commands.
set -euo pipefail
cmd=$(jq -r '.tool_input.command // empty' | tr -d '\r')

block() { echo "Blocked: $1. Ask a human to run it, or find a safer alternative." >&2; exit 2; }

# Production hostnames: the bare app hostnames. Preview (-pr-N) and -staging hosts are allowed.
# Update when real domains exist.
PROD_HOSTS='boxoffice-(api|web|admin|scanner|worker)\.fly\.dev|(^|[^a-z0-9.-])boxoffice\.app'

if grep -qiE '(^|[;&|(]\s*|\s)rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-r\s+-f|-f\s+-r|--recursive\s+--force|--force\s+--recursive)' <<<"$cmd"; then
  block "rm -rf"
fi
if grep -qiE 'Remove-Item\b.*-Recurse\b.*-Force\b|Remove-Item\b.*-Force\b.*-Recurse\b' <<<"$cmd"; then
  block "Remove-Item -Recurse -Force"
fi
if grep -qE '(^|\s)--force(\s|=|$)|git\s+push\b.*\s-f(\s|$)' <<<"$cmd"; then
  block "--force"
fi
if grep -qiE '(^|[;&|(]\s*)(fly|flyctl)(\.exe)?(\s|$)' <<<"$cmd"; then
  block "fly CLI (deploys go through deploy.yml)"
fi
if grep -qiE '(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|iex|Invoke-Expression)\b' <<<"$cmd"; then
  block "piping a download into a shell"
fi
if grep -qiE "$PROD_HOSTS" <<<"$cmd"; then
  block "production hostname"
fi
exit 0
