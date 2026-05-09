#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# post-doc-write.sh
# Purpose: Keep docs/product/00-README.md's status table in sync when any
#          PDP doc (`docs/product/NN-<name>.md`) is created or modified, so the
#          umbrella doc never lies about progress.
#
# Behaviour:
#   - On a brand-new PDP file (just created, frontmatter lacks Status: ✅) →
#     mark its row in 00-README's table as `✍️ Taslak`.
#   - On a modify where the file's frontmatter shows `Status: ✅ Onaylandı`  →
#     mark its row as `✅ <YYYY-MM-DD>` (today's date).
#   - Other modifies (e.g. mid-draft edits) leave the table untouched.
#
# Trigger:
#   - PostToolUse hook for Write|Edit|MultiEdit on docs/product/*.md
#     OR a native post-commit hook scanning the diff. In Claude Code mode the
#     edited file path is in stdin JSON `.tool_input.file_path`; legacy mode
#     receives the path as $1.
#
# Bypass:
#   - export AKIS_SKIP_DOC_HOOK=1
#
# Wiring suggestion (paste into .claude/settings.json — do NOT auto-edit it):
#   {
#     "hooks": {
#       "PostToolUse": [
#         {
#           "matcher": "Edit|Write|MultiEdit",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/post-doc-write.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }
# Note: format-on-edit.sh already lives under PostToolUse Edit|Write|MultiEdit.
# Both hooks can coexist — list them both inside the same matcher block.
# ------------------------------------------------------------------------------

set -euo pipefail

# 0. Bypass switch.
if [ "${AKIS_SKIP_DOC_HOOK:-0}" = "1" ]; then
  exit 0
fi

# 1. Resolve target file path.
file=""
if [ "${1:-}" != "" ]; then
  file="$1"
else
  if [ -t 0 ]; then
    exit 0  # no stdin, no arg → nothing to do.
  fi
  input="$(cat)"
  file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
fi
[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

# 2. Filter: only PDP files under docs/product/ matching NN-<slug>.md, and
#    skip 00-README itself (we update it; we don't react to its own writes).
case "$file" in
  */docs/product/00-README.md) exit 0 ;;
  */docs/product/[0-9][0-9]-*.md) ;;
  *) exit 0 ;;
esac

# 3. Locate the umbrella README.
readme=""
case "$file" in
  *"/akis-platform/"*) readme="${file%%/akis-platform/*}/akis-platform/docs/product/00-README.md" ;;
  *) exit 0 ;;
esac
[ -f "$readme" ] || {
  echo "post-doc-write: 00-README.md not found at $readme; skipping" >&2
  exit 0
}

# 4. Parse frontmatter Status: of the edited file.
#    Frontmatter is the first --- ... --- block, top of file.
status_line="$(awk '
  BEGIN { in_fm = 0; lines = 0 }
  NR == 1 && /^---[[:space:]]*$/ { in_fm = 1; next }
  in_fm && /^---[[:space:]]*$/ { exit }
  in_fm { print }
' "$file" | grep -E '^[Ss]tatus[[:space:]]*:' | head -n1 || true)"

is_approved=0
if printf '%s' "$status_line" | grep -Eq '✅[[:space:]]*Onayland'; then
  is_approved=1
fi

# 5. Derive doc-id (filename without extension) — used to find the row.
basefile="$(basename "$file")"
doc_id="${basefile%.md}"

# 6. Derive new cell text.
today="$(date +%Y-%m-%d)"
if [ "$is_approved" = "1" ]; then
  new_cell="✅ ${today}"
else
  new_cell="✍️ Taslak"
fi

# 7. Update the row in 00-README. We expect a Markdown table row whose first
#    non-pipe column contains the doc-id (e.g. `01-requirements`). We update
#    the LAST column of that row to $new_cell. If no matching row exists,
#    leave the file alone and warn — the umbrella may not list this doc yet.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

awk -v id="$doc_id" -v cell="$new_cell" '
  BEGIN { changed = 0 }
  {
    line = $0
    # Match a table row containing the doc-id as a token within a cell.
    # Heuristic: row starts with `|`, contains `| <id>` with surrounding
    # word-boundary punctuation (space, backtick, or bracket).
    if (line ~ /^[[:space:]]*\|/ && line ~ ("[ |`\\[]" id "[ |`\\]]")) {
      # Replace last cell content (between final two pipes).
      n = split(line, cols, "|")
      if (n >= 3) {
        cols[n-1] = " " cell " "
        rebuilt = ""
        for (i = 1; i <= n; i++) {
          rebuilt = rebuilt cols[i]
          if (i < n) rebuilt = rebuilt "|"
        }
        print rebuilt
        changed = 1
        next
      }
    }
    print line
  }
  END { exit (changed ? 0 : 2) }
' "$readme" > "$tmp"
rc=$?

if [ "$rc" = "0" ]; then
  mv "$tmp" "$readme"
  trap - EXIT
elif [ "$rc" = "2" ]; then
  echo "post-doc-write: no row for '$doc_id' in 00-README.md; status table unchanged" >&2
  # Not an error — the umbrella doc may not list this doc yet.
else
  echo "post-doc-write: awk failed (rc=$rc); leaving 00-README.md untouched" >&2
fi

exit 0
