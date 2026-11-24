#!/bin/bash
# scripts/install-intake-launchd.sh — poll the person's Twenty decisions every
# five minutes (plan F11), so an approval or a halt is applied between daily
# runs. Twenty store only. Idempotent: replaces an existing job.
set -euo pipefail
REPO_DIR="$(bash "$(dirname "$0")/../.claude/hooks/repo-root.sh" "$(dirname "$0")")"
LABEL="com.job-hunt-harness.intake"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$REPO_DIR/state/logs/journal/launchd"
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
  <array><string>$NPM_BIN</string><string>run</string><string>-s</string><string>twenty:intake</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HARNESS_STORE</key><string>twenty</string>
    <key>TMPDIR</key><string>/tmp</string>
    <key>PATH</key><string>$(dirname "$NPM_BIN"):/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/intake.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/intake.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
echo "Installed: $PLIST_PATH (every 5 minutes; log $LOG_DIR/intake.log)"
