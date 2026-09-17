#!/bin/bash
# session-start.sh — 6-line brief printed on every Claude Code session start.
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

PIPELINE="state/pipeline/opportunities.json"
JOURNAL_DIR="state/journal"

if [ ! -f "state/profile/profile.md" ]; then
  echo "harness: no profile yet. Run /setup (guided first run: profile, CV, positionings, channel logins, Sheet, schedule, autopilot)."
  exit 0
fi
if [ ! -f "$PIPELINE" ]; then
  echo "harness: profile present, pipeline empty. Run /setup to finish first-run checks, or /hunt seek to populate."
  exit 0
fi

TOTAL=$(node -e "const r=require('./$PIPELINE');console.log(r.length)" 2>/dev/null || echo "?")
AWAIT=$(node -e "const r=require('./$PIPELINE');console.log(r.filter(x=>x.status==='awaiting_approval').length)" 2>/dev/null || echo "?")
MANUAL=$(node -e "const r=require('./$PIPELINE');console.log(r.filter(x=>x.status==='manual_action_needed').length)" 2>/dev/null || echo "?")
SUBMITTED=$(node -e "const r=require('./$PIPELINE');console.log(r.filter(x=>x.status==='submitted').length)" 2>/dev/null || echo "?")
QUEUE=$(node -e "const r=require('./$PIPELINE');console.log(r.filter(x=>x.status==='shortlisted').length)" 2>/dev/null || echo "?")
PARKED=$(node -e "const r=require('./$PIPELINE');console.log(r.filter(x=>x.status==='parked').length)" 2>/dev/null || echo "?")
TOP_SCORE=$(node -e "const r=require('./$PIPELINE');const s=r.filter(x=>x.status==='awaiting_approval').sort((a,b)=>(b.score||0)-(a.score||0))[0];if(s)console.log(\`\${s.score} \${s.title.slice(0,40)} @ \${s.company}\`)" 2>/dev/null || echo "")
LAST_JOURNAL=$(ls -t "$JOURNAL_DIR"/*.md 2>/dev/null | head -1 | xargs -I {} basename {} .md 2>/dev/null || echo "(none)")

echo "harness: $TOTAL pipeline | $QUEUE queue | $PARKED parked | $AWAIT awaiting | $MANUAL manual | $SUBMITTED submitted"
[ -n "$TOP_SCORE" ] && echo "       top tray: $TOP_SCORE"
echo "       last digest: $LAST_JOURNAL"
TODAY_SUMMARY="$JOURNAL_DIR/summary/$(TZ=Australia/Sydney date +%Y-%m-%d).md"
[ -f "$TODAY_SUMMARY" ] && echo "       today's summary: $TODAY_SUMMARY"
