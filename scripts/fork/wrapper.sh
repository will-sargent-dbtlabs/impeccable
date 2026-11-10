#!/bin/sh
set -eu
ENGINE="__IMPECCABLE_FORK_ENGINE__"
if [ ! -x "$ENGINE" ]; then
  echo "impeccable-fork: local engine missing at $ENGINE; rebuild with node scripts/fork/build.mjs and reinstall with node scripts/fork/install.mjs" >&2
  exit 127
fi
export IMPECCABLE_BIN="$ENGINE"
: "${IMPECCABLE_NO_TELEMETRY:=1}"; export IMPECCABLE_NO_TELEMETRY
: "${IMPECCABLE_NO_UPDATE_CHECK:=1}"; export IMPECCABLE_NO_UPDATE_CHECK
: "${IMPECCABLE_NO_REMOTE_CATALOG:=1}"; export IMPECCABLE_NO_REMOTE_CATALOG
export IMPECCABLE_PRO=off
WRAPPER_SELF=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
CODEX_DIR=${HOME:-}/.agents/skills/impeccable
CLAUDE_DIR=${HOME:-}/.claude/skills/impeccable
case "${IMPECCABLE_SELF:-}" in
  "$CODEX_DIR/scripts/impeccable")
    [ "${IMPECCABLE_SKILL_DIR:-}" = "$CODEX_DIR" ] || { echo 'impeccable-fork: invalid Codex launcher binding' >&2; exit 2; }
    : "${IMPECCABLE_PROVIDER_ID:=codex}"; export IMPECCABLE_PROVIDER_ID
    ;;
  "$CLAUDE_DIR/scripts/impeccable")
    [ "${IMPECCABLE_SKILL_DIR:-}" = "$CLAUDE_DIR" ] || { echo 'impeccable-fork: invalid Claude launcher binding' >&2; exit 2; }
    : "${IMPECCABLE_PROVIDER_ID:=claude-code}"; export IMPECCABLE_PROVIDER_ID
    ;;
  *)
    export IMPECCABLE_SELF="$WRAPPER_SELF"
    case "${IMPECCABLE_SKILL_DIR:-}" in
    "$CODEX_DIR"|*/.agents/skills/impeccable)
      : "${IMPECCABLE_PROVIDER_ID:=codex}"; export IMPECCABLE_PROVIDER_ID
      ;;
    "$CLAUDE_DIR"|*/.claude/skills/impeccable)
      : "${IMPECCABLE_PROVIDER_ID:=claude-code}"; export IMPECCABLE_PROVIDER_ID
      ;;
    *)
      if [ -n "${IMPECCABLE_SKILL_DIR:-}" ]; then
      : # An explicit, unrecognized skill directory has no safe provider inference.
      elif [ -d "$CODEX_DIR/reference" ]; then
      export IMPECCABLE_SKILL_DIR="$CODEX_DIR"
      : "${IMPECCABLE_PROVIDER_ID:=codex}"; export IMPECCABLE_PROVIDER_ID
      elif [ -d "$CLAUDE_DIR/reference" ]; then
      export IMPECCABLE_SKILL_DIR="$CLAUDE_DIR"
      : "${IMPECCABLE_PROVIDER_ID:=claude-code}"; export IMPECCABLE_PROVIDER_ID
      else
      unset IMPECCABLE_SKILL_DIR 2>/dev/null || true
      fi
      ;;
    esac
    ;;
esac
blocked=''
first_command=''
for arg in "$@"; do
  case "$arg" in --force|--help|-h|--json|--quiet|--verbose|-*) ;;
    *) first_command=$arg; break;;
  esac
done
case "$first_command" in
  skills|loop)
  route=$first_command
  found_route=0
  for arg in "$@"; do
    if [ "$found_route" -eq 0 ]; then
      [ "$arg" = "$route" ] && found_route=1
      continue
    fi
    case "$route:$arg" in
      skills:install|skills:update|skills:check|skills:link|loop:install|loop:update)
        blocked=$arg
        break
        ;;
    esac
  done
  ;;
  *)
  case "$first_command" in install|update|check|link) blocked=$first_command;; esac
  ;;
esac
if [ -n "$blocked" ]; then
  echo "impeccable-fork: upstream $blocked is disabled; rebuild locally with node scripts/fork/build.mjs" >&2
  exit 2
fi
exec "$ENGINE" "$@"
