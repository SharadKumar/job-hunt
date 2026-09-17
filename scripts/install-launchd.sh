#!/bin/bash
# scripts/install-launchd.sh — install the daily harness job into macOS launchd.
# Idempotent: removes existing job first, then bootstraps fresh.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.job-hunt-harness.daily"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"

# Read the hour:minute from profile.md if present, otherwise default to 07:00
HOUR=7
MINUTE=0

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
    <string>codex</string>
    <key>PATH</key>
    <string>$HOME/.local/bin:$HOME/.nvm/versions/node/v24.18.0/bin:/Applications/Codex.app/Contents/Resources:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
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
echo "Verify: launchctl print gui/$UID/$LABEL"
echo "Test now: launchctl kickstart -k gui/$UID/$LABEL"
echo "Logs: $REPO_DIR/state/journal/launchd/"
