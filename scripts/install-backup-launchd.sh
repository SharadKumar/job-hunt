#!/bin/bash
# scripts/install-backup-launchd.sh — back up the Twenty workspace to R2 every
# day at 02:30 local time (npm run twenty:backup). Until R2 credentials and
# state/twenty/backup-recipient.txt exist the job prints `skipped` and exits 0.
# Idempotent: replaces an existing job.
set -euo pipefail
REPO_DIR="$(bash "$(dirname "$0")/../.claude/hooks/repo-root.sh" "$(dirname "$0")")"
LABEL="com.job-hunt-harness.backup"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO_DIR/state/logs/backup"
NPM_BIN="$(command -v npm || true)"
[ -n "$NPM_BIN" ] || { echo "npm not found on PATH" >&2; exit 2; }
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>ProgramArguments</key>
  <array><string>$NPM_BIN</string><string>run</string><string>-s</string><string>twenty:backup</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HARNESS_STORE</key><string>twenty</string>
    <key>TMPDIR</key><string>/tmp</string>
    <key>PATH</key><string>$(dirname "$NPM_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$LOG_DIR/backup.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/backup.log</string>
</dict>
</plist>
PLIST
plutil -lint "$PLIST_PATH" >/dev/null
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "Installed: $PLIST_PATH (daily at 02:30; log $LOG_DIR/backup.log)"
