#!/bin/bash
# session-start.sh: the short brief (up to 4 lines) printed on every Claude Code session start.
# Stays tight to keep token cost low (the hook fires on every resume).

set -euo pipefail
# Resolve the repo root deterministically — headless / Codex runs do not
# reliably inherit the repo as cwd, and this file is also reached through the
# .codex/hooks/ symlink, so never trust $PWD.
HOOK_DIR="$(cd "$(dirname "$0")" && pwd -P)"
RESOLVER_DIR="$HOOK_DIR"
while [ ! -f "$RESOLVER_DIR/.claude/hooks/repo-root.sh" ] && [ "$RESOLVER_DIR" != "/" ]; do
  RESOLVER_DIR="$(dirname "$RESOLVER_DIR")"
done
if [ ! -f "$RESOLVER_DIR/.claude/hooks/repo-root.sh" ]; then
  echo "harness: cannot locate .claude/hooks/repo-root.sh from $HOOK_DIR" >&2
  exit 1
fi
REPO_DIR="$(bash "$RESOLVER_DIR/.claude/hooks/repo-root.sh" "$HOOK_DIR")"
cd "$REPO_DIR"

PIPELINE_DB="state/pipeline/pipeline.db"
PIPELINE_JSON="state/pipeline/opportunities.json"
JOURNAL_DIR="state/journal"

if [ ! -f "state/profile/profile.md" ]; then
  echo "harness: no profile yet. Run /setup (guided first run: profile, CV, positionings, channel logins, Sheet, schedule, autopilot)."
  exit 0
fi
if [ ! -f "$PIPELINE_DB" ] && [ ! -f "$PIPELINE_JSON" ]; then
  echo "harness: profile present, pipeline empty. Run /setup to finish first-run checks, or /hunt seek to populate."
  exit 0
fi

# One tsx call instead of six node -e parses of a multi-megabyte JSON file.
# Line 1: the counts. Line 2 (optional): the top tray row.
BRIEF=$(npx tsx tools/pipeline.ts summary --brief --top 2>/dev/null || echo "? pipeline")
COUNTS=$(printf '%s\n' "$BRIEF" | sed -n 1p)
TOP_SCORE=$(printf '%s\n' "$BRIEF" | sed -n 2p)
LAST_JOURNAL=$(ls -t "$JOURNAL_DIR"/*.md 2>/dev/null | head -1 | xargs -I {} basename {} .md 2>/dev/null || echo "(none)")

echo "harness: $COUNTS"
[ -n "$TOP_SCORE" ] && echo "       top tray: $TOP_SCORE"
echo "       last digest: $LAST_JOURNAL"
TODAY_SUMMARY="$JOURNAL_DIR/summary/$(TZ=Australia/Sydney date +%Y-%m-%d).md"
[ -f "$TODAY_SUMMARY" ] && echo "       today's summary: $TODAY_SUMMARY"
