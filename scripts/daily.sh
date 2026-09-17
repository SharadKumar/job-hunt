#!/bin/bash
# scripts/daily.sh — wrapper used by launchd to fire the daily orchestrator.
# Picks the agent CLI via HARNESS_CLI env var (defaults to "codex").
# Logs to state/journal/launchd/YYYY-MM-DD.log.

set -euo pipefail

# Resolve the repo root deterministically — launchd fires this with an
# arbitrary cwd, so never trust $PWD.
REPO_DIR="${REPO_DIR:-$(bash "$(dirname "$0")/../.claude/hooks/repo-root.sh" "$(dirname "$0")")}"
cd "$REPO_DIR"

DATE=$(date '+%Y-%m-%d')
LOG_DIR="$REPO_DIR/state/journal/launchd"
LOG_FILE="$LOG_DIR/$DATE.log"
mkdir -p "$LOG_DIR"

CLI="${HARNESS_CLI:-codex}"
PROMPT="Invoke the 'daily' skill (at .claude/skills/daily/SKILL.md) and follow it end-to-end. You are running headlessly so take safe defaults at any decision fork and log them for the user to review."
EXIT=0

{
  echo "=== $(date -Iseconds) starting daily run via $CLI ==="
  case "$CLI" in
    claude)
      # --output-format stream-json keeps logs parseable; --permission-mode auto + the
      # allowlist in .claude/settings.json keeps the headless run safe.
      claude -p --verbose --output-format=stream-json --permission-mode=auto "$PROMPT" || EXIT=$?
      ;;
    codex)
      codex exec "$PROMPT" || EXIT=$?
      ;;
    *)
      echo "Unknown HARNESS_CLI=$CLI" >&2
      exit 2
      ;;
  esac
  echo "=== $(date -Iseconds) finished daily run (exit $EXIT) ==="
} >>"$LOG_FILE" 2>&1

exit "$EXIT"
