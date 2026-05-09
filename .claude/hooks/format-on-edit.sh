#!/usr/bin/env bash
# PostToolUse hook: format edited files with Prettier inside backend/ or frontend/.
# Reads tool event JSON from stdin; exits 0 silently on any non-target path.
set -uo pipefail

input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.html|*.yml|*.yaml) ;;
  *) exit 0 ;;
esac

case "$file" in
  */akis-platform/backend/*) ws="${file%%/akis-platform/backend/*}/akis-platform/backend" ;;
  */akis-platform/frontend/*) ws="${file%%/akis-platform/frontend/*}/akis-platform/frontend" ;;
  *) exit 0 ;;
esac

[ -d "$ws" ] || exit 0
(cd "$ws" && pnpm exec prettier --write --log-level=warn "$file" >/dev/null 2>&1) || true
exit 0
