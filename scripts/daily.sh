#!/bin/bash
# scripts/daily.sh — wrapper used by launchd to fire the daily orchestrator.
#
# Picks the agent CLI via HARNESS_CLI (defaults to "claude" for existing installs).
# Logs to state/journal/launchd/YYYY-MM-DD.log.
#
# Three things launchd needs that a bare `claude -p` does not give us:
#   * a watchdog — an agent CLI that wedges on a prompt would otherwise hold the
#     slot until the next day's run; HARNESS_TIMEOUT_MIN (default 150) bounds it
#     and a timed-out run exits 124, like coreutils `timeout`.
#   * a failure trail — a nonzero exit writes a short failure block to
#     state/journal/summary/<date>.md (never clobbering a real summary) and asks
#     tools/daily-summary.ts to raise the macOS notification.
#   * log rotation — these logs run 5-6 MB/day and nothing else prunes them.
#
# Env overrides: HARNESS_CLI, HARNESS_CLI_BIN (the binary/path to execute, for
# tests), HARNESS_TIMEOUT_MIN, HARNESS_TIMEOUT_SEC (wins; tests use seconds),
# HARNESS_LOG_RETENTION_DAYS, REPO_DIR, HARNESS_DAILY_MODEL (Sonnet for Claude,
# gpt-6-sol for Codex), HARNESS_REUSE_FRONT_HALF=1 (resume a completed,
# healthy report from this local day without repeating discovery or Jev calls).

set -euo pipefail

# Resolve the repo root deterministically — launchd fires this with an
# arbitrary cwd, so never trust $PWD.
REPO_DIR="${REPO_DIR:-$(bash "$(dirname "$0")/../.claude/hooks/repo-root.sh" "$(dirname "$0")")}"
cd "$REPO_DIR"

DATE=$(date '+%Y-%m-%d')
unset HARNESS_SEEK_VERIFICATION_REQUIRED
LOG_DIR="$REPO_DIR/state/journal/launchd"
LOG_FILE="$LOG_DIR/$DATE.log"
SUMMARY_DIR="$REPO_DIR/state/journal/summary"
mkdir -p "$LOG_DIR"

# Rotate before writing today's log, so a wedged run still leaves the disk sane.
find "$LOG_DIR" -maxdepth 1 -type f -name '*.log' -mtime "+${HARNESS_LOG_RETENTION_DAYS:-14}" -delete 2>/dev/null || true

CLI="${HARNESS_CLI:-claude}"
CLI_BIN="${HARNESS_CLI_BIN:-$CLI}"
case "$CLI" in
  claude|codex) ;;
  *)
    echo "Unknown HARNESS_CLI=$CLI" >&2
    exit 2
    ;;
esac

TIMEOUT_SEC="${HARNESS_TIMEOUT_SEC:-$(( ${HARNESS_TIMEOUT_MIN:-150} * 60 ))}"
KILL_GRACE_SEC="${HARNESS_KILL_GRACE_SEC:-30}"
PROMPT="Invoke the 'daily' skill (at .claude/skills/daily/SKILL.md) and continue from the deterministic front half recorded in state/journal/front-half/$DATE.json. Also read state/journal/priority/$DATE.json if present: include its confirmed sends and blockers in today's journal, and never retry an uncertain priority attempt. Do not repeat Sheet pull, saved-job import, channel hunts, classification, scoring or deterministic dedup. You are running headlessly so take safe defaults at any decision fork and log them for the user to review."
EXIT=0
TIMED_OUT=0

# "<sent> <blocked>" off the daily summary's own Numbers table, or nothing.
# The table is the run's own arithmetic, and the columns are read by name so a
# new column between them cannot silently shift the answer.
notify_counts() {
  local file="$SUMMARY_DIR/$DATE.md"
  [ -f "$file" ] || return 0
  awk -F'|' '
    function number(cell) { return match(cell, /[0-9]+/) ? substr(cell, RSTART, RLENGTH) : "" }
    /^\| *Sent today *\|/ {
      for (i = 2; i < NF; i++) { gsub(/^ +| +$/, "", $i); col[$i] = i }
      header = 1
      next
    }
    header && /^\|[-:| ]+\|$/ { next }
    header && /^\|/ {
      if (col["Sent today"] == "" || col["Manual"] == "") exit
      printf "%s %s", number($(col["Sent today"])), number($(col["Manual"]))
      exit
    }
  ' "$file"
}

# `exec` so $! is the CLI itself, not a wrapper subshell the signals would stop at.
run_cli() {
  if [ "$CLI" = "claude" ]; then
    # --output-format stream-json keeps logs parseable; --permission-mode auto +
    # the allowlist in .claude/settings.json keeps the headless run safe.
    exec "$CLI_BIN" -p --model "${HARNESS_DAILY_MODEL:-sonnet}" --verbose --output-format=stream-json --permission-mode=auto "$PROMPT"
  else
    # The scheduled run needs network access for channel adapters and Vercel,
    # plus local writes for pipeline state. Send authority remains in
    # autopilot:submit and its deterministic gates, not in this CLI setting.
    export LETTER_CRITIC_CLI="${LETTER_CRITIC_CLI:-codex}"
    export CODEX_CLI_BIN="${CODEX_CLI_BIN:-$CLI_BIN}"
    # Writer and resume-critic subagents need a persisted parent thread.
    # --ephemeral prevents their spawn in the current Codex CLI.
    CODEX_MODEL="${HARNESS_DAILY_MODEL:-gpt-6-sol}"
    export HARNESS_DAILY_MODEL="$CODEX_MODEL"
    exec "$CLI_BIN" exec --json --model "$CODEX_MODEL" --sandbox danger-full-access -C "$REPO_DIR" \
      "$PROMPT The running Codex model is $CODEX_MODEL. Record that exact model id in agent-fallback provenance; never claim a different model."
  fi
}

{
  echo "=== $(date -Iseconds) starting daily run via $CLI (timeout ${TIMEOUT_SEC}s) ==="

  FRONT_EXIT=0
  PRIORITY_EXIT=0
  if [ "${HARNESS_REUSE_FRONT_HALF:-0}" = "1" ]; then
    REPORT="$REPO_DIR/state/journal/front-half/$DATE.json"
    if node -e '
      const fs = require("node:fs");
      const [file, localDate] = process.argv.slice(1);
      const report = JSON.parse(fs.readFileSync(file, "utf8"));
      const finished = new Date(report.finished_at);
      const date = new Intl.DateTimeFormat("en-CA", {
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(finished);
      if (report.schema_version !== 2 || report.running !== false || report.ok !== true ||
          report.degraded === true || !Number.isFinite(finished.getTime()) || date !== localDate) process.exit(1);
    ' "$REPORT" "$DATE"; then
      echo "=== $(date -Iseconds) reusing completed front half $REPORT ==="
    else
      echo "=== $(date -Iseconds) cannot reuse front half: missing, stale or unhealthy report $REPORT ===" >&2
      FRONT_EXIT=2
    fi
  else
    # Prepared, critic-passed packages should not wait behind a long channel
    # discovery scan. The priority pass re-pulls decisions and expires explicit
    # deadlines before using the ordinary autopilot gate and adapter.
    PRIORITY_STARTED=$(date -u +%s)
    npm run -s daily:priority || PRIORITY_EXIT=$?
    echo "=== $(date -Iseconds) priority pass exit $PRIORITY_EXIT ==="
    PRIORITY_REPORT="$REPO_DIR/state/journal/priority/$DATE.json"
    if [ -f "$PRIORITY_REPORT" ] && node -e '
      const report = require(process.argv[1]);
      if (new Date(report.started_at).getTime() < (Number(process.argv[2]) - 1) * 1000 ||
          report.channel_health?.seek?.verification_required !== true ||
          report.channel_health?.seek?.observed_this_pass !== true) process.exit(1);
    ' "$PRIORITY_REPORT" "$PRIORITY_STARTED"; then
      export HARNESS_SEEK_VERIFICATION_REQUIRED=1
      echo "=== $(date -Iseconds) SEEK verification required in priority pass; skipping SEEK in front half ==="
    fi
    npm run -s daily:front-half || FRONT_EXIT=$?
  fi
  echo "=== $(date -Iseconds) deterministic front half exit $FRONT_EXIT ==="

  # An explicit reuse request must never fall through to the agent when its
  # source report is missing or unhealthy. The ordinary run still lets the
  # back half recover already-valid packages after a fresh front-half error.
  if [ "${HARNESS_REUSE_FRONT_HALF:-0}" = "1" ] && [ "$FRONT_EXIT" -ne 0 ]; then
    EXIT="$FRONT_EXIT"
  else

  run_cli &
  CLI_PID=$!

  ELAPSED=0
  while kill -0 "$CLI_PID" 2>/dev/null; do
    if [ "$ELAPSED" -ge "$TIMEOUT_SEC" ]; then
      TIMED_OUT=1
      echo "=== $(date -Iseconds) timeout after ${TIMEOUT_SEC}s, terminating $CLI (pid $CLI_PID) ==="
      kill -TERM "$CLI_PID" 2>/dev/null || true
      GRACE=0
      while kill -0 "$CLI_PID" 2>/dev/null && [ "$GRACE" -lt "$KILL_GRACE_SEC" ]; do
        sleep 1
        GRACE=$((GRACE + 1))
      done
      if kill -0 "$CLI_PID" 2>/dev/null; then
        echo "=== $(date -Iseconds) still alive after ${KILL_GRACE_SEC}s, sending KILL ==="
        kill -KILL "$CLI_PID" 2>/dev/null || true
      fi
      break
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
  done

  wait "$CLI_PID" || EXIT=$?
  if [ "$TIMED_OUT" -eq 1 ]; then EXIT=124; fi
  fi
  # A successful back half cannot turn a failed priority or discovery pass
  # into a healthy run. Still let it recover already-valid packages first.
  if [ "$EXIT" -eq 0 ] && [ "$FRONT_EXIT" -ne 0 ]; then EXIT="$FRONT_EXIT"; fi
  if [ "$EXIT" -eq 0 ] && [ "$PRIORITY_EXIT" -ne 0 ]; then EXIT="$PRIORITY_EXIT"; fi

  if [ "$EXIT" -ne 0 ]; then
    mkdir -p "$SUMMARY_DIR"
    # daily-summary first: if it can still produce a real summary that is the
    # better artefact, and it also raises the notification. Our failure block is
    # the fallback for when it cannot (or is not there at all).
    if [ -f "$REPO_DIR/tools/daily-summary.ts" ]; then
      npx tsx tools/daily-summary.ts --notify || echo "daily-summary --notify failed (tolerated)"
    fi
    if [ ! -f "$SUMMARY_DIR/$DATE.md" ]; then
      {
        echo "# Daily run $DATE"
        echo
        if [ "$TIMED_OUT" -eq 1 ]; then
          echo "Run failed (exit $EXIT): $CLI exceeded the ${TIMEOUT_SEC}s watchdog and was killed."
        elif [ "$FRONT_EXIT" -ne 0 ]; then
          echo "Run failed (exit $EXIT): deterministic front half exited $FRONT_EXIT; see the log for back-half recovery outcomes."
        elif [ "$PRIORITY_EXIT" -ne 0 ]; then
          echo "Run failed (exit $EXIT): prepared-package priority pass exited $PRIORITY_EXIT; see the priority report and log for recovery outcomes."
        else
          echo "Run failed (exit $EXIT): $CLI exited nonzero before the orchestrator finished."
        fi
        echo
        echo "- Log: $LOG_FILE"
        echo "- Submission totals are unverified. Check the pipeline and channel confirmations before retrying; never retry an uncertain send."
      } >"$SUMMARY_DIR/$DATE.md"
    fi
  fi

  # A one-line push, for a person who is not at the machine at 07:00.
  # HARNESS_NOTIFY_URL is any url that accepts a POST body: an ntfy topic
  # (https://ntfy.sh/<your-topic>) is the easy one. Unset, nothing is sent.
  # A failed POST is logged and tolerated: the run already did its work, and a
  # notification service being down is not a reason to report a failed run.
  if [ -n "${HARNESS_NOTIFY_URL:-}" ]; then
    COUNTS=$(notify_counts || true)
    SENT=$(printf '%s' "$COUNTS" | cut -d' ' -f1)
    BLOCKED=$(printf '%s' "$COUNTS" | cut -d' ' -f2)
    MESSAGE="Job hunt $DATE: sent ${SENT:-?}, blocked ${BLOCKED:-?}, exit $EXIT"
    if curl -fsS -m 10 -d "$MESSAGE" "$HARNESS_NOTIFY_URL" >/dev/null 2>&1; then
      echo "notified: $MESSAGE"
    else
      echo "notify POST failed (tolerated): $MESSAGE"
    fi
  fi

  echo "=== $(date -Iseconds) finished daily run (exit $EXIT) ==="
} >>"$LOG_FILE" 2>&1

exit "$EXIT"
