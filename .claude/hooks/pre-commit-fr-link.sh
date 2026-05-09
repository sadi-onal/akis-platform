#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# pre-commit-fr-link.sh
# Purpose: Enforce that any commit which touches AKIS product code (backend/,
#          frontend/, scripts/, etc.) carries an FR/NFR/F anchor in its message
#          so commits can be traced back to the PDP requirement they fulfil.
#
# Trigger:
#   - git pre-commit hook → invoked with the commit-message file path as $1
#     (`.git/COMMIT_EDITMSG`). Wire either as a real git hook OR via a Claude
#     Code PreToolUse hook that intercepts `git commit` Bash calls.
#
# Allowed without an anchor (doc/tooling/config-only commits):
#   - .claude/**       (developer tooling)
#   - docs/**          (any documentation)
#   - root *.md        (README, CHANGELOG, etc.)
#   - root config files (package.json, .gitignore, .editorconfig, etc.)
#
# Required for code commits: message must contain a token matching either
#   FR-N(.N)?  |  NFR-N(.N)?  |  F-N
# (e.g. FR-3.5, NFR-2, F-01).
#
# Bypass:
#   - export AKIS_SKIP_FR_HOOK=1   (skips entirely, exit 0)
#   - git commit --no-verify       (last resort; not recommended)
#
# Wiring suggestion (do NOT auto-edit settings.json — the user will paste this):
#   {
#     "hooks": {
#       "PreToolUse": [
#         {
#           "matcher": "Bash",
#           "hooks": [
#             {
#               "type": "command",
#               "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/pre-commit-fr-link.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }
# When wired as a Claude Code PreToolUse hook, the script reads the tool-event
# JSON from stdin and inspects `tool_input.command` for `git commit -m "..."`.
# When wired as a native git hook (`.git/hooks/pre-commit`), it reads the
# message file from $1.
# ------------------------------------------------------------------------------

set -euo pipefail

# 0. Bypass switch.
if [ "${AKIS_SKIP_FR_HOOK:-0}" = "1" ]; then
  exit 0
fi

ANCHOR_REGEX='\b(FR|NFR|F)-[0-9]+(\.[0-9]+)?\b'

# 1. Resolve commit message + changed files from whichever invocation mode.
msg=""
files=""

if [ "${1:-}" != "" ] && [ -f "${1:-/dev/null}" ]; then
  # Native git pre-commit mode: $1 = commit msg path.
  msg="$(cat "$1")"
  files="$(git diff --cached --name-only 2>/dev/null || true)"
else
  # Claude Code PreToolUse mode: tool event JSON on stdin.
  if [ -t 0 ]; then
    # No stdin and no $1 — nothing to check, allow.
    exit 0
  fi
  input="$(cat)"
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"

  # Only inspect git commit calls; let everything else through.
  case "$cmd" in
    *"git commit"*) ;;
    *) exit 0 ;;
  esac

  # Pull the message out of `-m "..."` or `-m '...'`. Best-effort.
  msg="$(printf '%s' "$cmd" | sed -nE "s/.*-m[[:space:]]*\"([^\"]*)\".*/\1/p; s/.*-m[[:space:]]*'([^']*)'.*/\1/p" | head -n1)"
  if [ -z "$msg" ]; then
    # Heredoc style or no -m — let it through; native hook can still catch.
    exit 0
  fi
  files="$(git diff --cached --name-only 2>/dev/null || true)"
fi

# 2. Determine whether the staged change set is "code" or "docs/tooling-only".
needs_anchor=0
if [ -z "$files" ]; then
  # Empty stage (e.g. amend with no path changes) — be permissive.
  needs_anchor=0
else
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      .claude/*) ;;                              # tooling
      docs/*) ;;                                 # docs
      *.md) ;;                                   # any .md (root README etc.)
      package.json|pnpm-lock.yaml|.gitignore|\
.editorconfig|.prettierrc*|.eslintrc*|tsconfig*|\
docker-compose*.yml|Caddyfile|*.code-workspace) ;;  # root config
      *)
        needs_anchor=1
        break
        ;;
    esac
  done <<EOF
$files
EOF
fi

# 3. If anchor required, enforce it.
if [ "$needs_anchor" = "1" ]; then
  if ! printf '%s' "$msg" | grep -Eq "$ANCHOR_REGEX"; then
    {
      echo ""
      echo "✗ FR/NFR/F bağlantısı eksik."
      echo ""
      echo "Bu commit kod değiştiriyor ama FR-/NFR-/F- ID referansı yok."
      echo "Mesaja örn. \`FR-3.5\` veya \`F-01\` ekle, ya da"
      echo "\`--no-verify\` ile bypass et (önerilmez)."
      echo ""
      echo "Bypass: AKIS_SKIP_FR_HOOK=1 git commit ..."
      echo ""
    } >&2
    exit 1
  fi
fi

exit 0
