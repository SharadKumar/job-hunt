#!/bin/bash
# scripts/install-ui-launchd.sh — keep the local approval UI running under launchd.
#
# Renders templates/launchd/com.job-hunt-harness.ui.plist with this checkout's
# path and installs it to ~/Library/LaunchAgents. Idempotent: it boots the job
# out before bootstrapping it back in, so running it twice is the same as
# running it once.
#
#   bash scripts/install-ui-launchd.sh              # render + install + load
#   bash scripts/install-ui-launchd.sh --dry-run    # print the rendered plist, change nothing
#   bash scripts/install-ui-launchd.sh --uninstall  # unload and remove the plist
#   bash scripts/install-ui-launchd.sh --port 7799  # a port other than 7788
#
# The job binds 127.0.0.1 only. To reach the UI from a phone, see the comment
# in the template and the README's "Local UI" section.
#
# When portless (https://portless.sh) is installed, the script also registers a
# static route so the supervised port is reachable as https://job-hunt.localhost
# as well as on 127.0.0.1. --uninstall removes the route again.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.job-hunt-harness.ui"
TEMPLATE="$REPO_DIR/templates/launchd/$LABEL.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${HARNESS_UI_PORT:-7788}"
PORTLESS_NAME="job-hunt"
MODE="install"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --uninstall) MODE="uninstall" ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$MODE" = "uninstall" ]; then
  launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo "Removed: $PLIST_PATH"
  if command -v portless >/dev/null 2>&1; then
    portless alias --remove "$PORTLESS_NAME" >/dev/null 2>&1 \
      && echo "Removed portless route: $PORTLESS_NAME" \
      || echo "No portless route to remove: $PORTLESS_NAME"
  fi
  exit 0
fi

[ -f "$TEMPLATE" ] || { echo "Missing template: $TEMPLATE" >&2; exit 1; }

# A launchd job inherits almost no PATH, so the node that runs the UI has to be
# named here. The current shell's PATH is the one that works on this machine.
RENDER_PATH="$PATH"

render() {
  sed -e "s#__REPO_DIR__#$REPO_DIR#g" \
      -e "s#__PATH__#$RENDER_PATH#g" \
      -e "s#__PORT__#$PORT#g" \
      "$TEMPLATE"
}

if [ "$MODE" = "dry-run" ]; then
  render
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$REPO_DIR/state/journal/launchd"
render > "$PLIST_PATH"
plutil -lint "$PLIST_PATH" >/dev/null

# Bootstrap (remove + install). bootout fails when it was not loaded; fine.
launchctl bootout "gui/$UID/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$PLIST_PATH"

echo "Installed: $PLIST_PATH"
echo "UI: http://127.0.0.1:$PORT"

# portless is optional. When it is there, point its stable name at the port the
# job just took: `alias` is a static route to an already-running server, which
# is exactly what a launchd-supervised UI is. Re-registering the same name is
# how you move it to a new port, so this stays idempotent.
if command -v portless >/dev/null 2>&1; then
  if portless alias "$PORTLESS_NAME" "$PORT" >/dev/null 2>&1; then
    echo "portless: $(portless get "$PORTLESS_NAME" 2>/dev/null || echo "https://$PORTLESS_NAME.localhost")"
    echo "portless: run 'portless trust' once if the browser distrusts the certificate"
  else
    echo "portless: found on PATH but 'portless alias $PORTLESS_NAME $PORT' failed; the UI is still on http://127.0.0.1:$PORT" >&2
  fi
fi
echo "Verify: launchctl print gui/$UID/$LABEL"
echo "Restart: launchctl kickstart -k gui/$UID/$LABEL"
echo "Logs: $REPO_DIR/state/journal/launchd/ui.log"
echo "Remove: bash scripts/install-ui-launchd.sh --uninstall"
