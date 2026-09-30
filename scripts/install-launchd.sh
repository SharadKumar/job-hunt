#!/bin/bash
# scripts/install-launchd.sh — install the daily harness job into macOS launchd.
# Idempotent: removes existing job first, then bootstraps fresh.

set -euo pipefail

REPO_DIR="$(bash "$(dirname "$0")/../.claude/hooks/repo-root.sh" "$(dirname "$0")")"
LABEL="com.job-hunt-harness.daily"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
INSTALL_CLI="${HARNESS_CLI:-codex}"
case "$INSTALL_CLI" in
  codex)
    APP_CODEX="/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
    if [ -z "${HARNESS_CLI_BIN:-}" ] && [ -x "$APP_CODEX" ]; then
      HARNESS_CLI_BIN="$APP_CODEX"
    fi
    ;;
  claude) ;;
  *) echo "Unknown HARNESS_CLI=$INSTALL_CLI" >&2; exit 2 ;;
esac
INSTALL_CLI_BIN="${HARNESS_CLI_BIN:-$(command -v "$INSTALL_CLI" || true)}"
if [ ! -x "$INSTALL_CLI_BIN" ]; then
  echo "Agent CLI is not executable: ${INSTALL_CLI_BIN:-$INSTALL_CLI}" >&2
  exit 2
fi

# Weekday working hours. Every trigger runs the full workflow to retry queued
# packages and continue preparation of unfinished applications.
START_HOUR="${HARNESS_START_HOUR:-7}"
END_HOUR="${HARNESS_END_HOUR:-17}"
INTERVAL_HOURS="${HARNESS_INTERVAL_HOURS:-2}"
MINUTE=0
if ! [[ "$START_HOUR" =~ ^[0-9]+$ && "$END_HOUR" =~ ^[0-9]+$ ]] \
  || [ "$START_HOUR" -gt 23 ] || [ "$END_HOUR" -gt 23 ] \
  || [ "$START_HOUR" -gt "$END_HOUR" ] \
  || ! [[ "$INTERVAL_HOURS" =~ ^(2|4)$ ]]; then
  echo "Schedule requires hours 0 to 23, start <= end, and interval 2 or 4" >&2
  exit 2
fi
CALENDAR_ENTRIES=""
for WEEKDAY in 1 2 3 4 5; do
  for ((HOUR=START_HOUR; HOUR<=END_HOUR; HOUR+=INTERVAL_HOURS)); do
    CALENDAR_ENTRIES+="    <dict><key>Hour</key><integer>$HOUR</integer><key>Minute</key><integer>$MINUTE</integer><key>Weekday</key><integer>$WEEKDAY</integer></dict>"$'\n'
  done
done

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO_DIR/scripts/daily.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>REPO_DIR</key>
    <string>$REPO_DIR</string>
    <key>HARNESS_CLI</key>
    <string>$INSTALL_CLI</string>
    <key>HARNESS_CLI_BIN</key>
    <string>$INSTALL_CLI_BIN</string>
    <key>PATH</key>
    <string>$HOME/.local/bin:$HOME/.nvm/versions/node/v24.18.0/bin:/Applications/Codex.app/Contents/Resources:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <array>
$CALENDAR_ENTRIES
  </array>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>$REPO_DIR/state/journal/launchd/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$REPO_DIR/state/journal/launchd/stderr.log</string>
</dict>
</plist>
EOF

# Bootstrap (remove + install). bootout may fail if not loaded — that's fine.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_PATH"

echo "Installed: $PLIST_PATH"
echo "Schedule: weekdays, every $INTERVAL_HOURS hours from $START_HOUR:00 through $END_HOUR:00 local time"
echo "Verify: launchctl print gui/$UID/$LABEL"
echo "Test now: launchctl kickstart -k gui/$UID/$LABEL"
echo "Logs: $REPO_DIR/state/journal/launchd/"
