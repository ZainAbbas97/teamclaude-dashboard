#!/bin/sh
# Runs the dashboard as a macOS LaunchAgent: starts at login, restarts if it
# crashes, and opens http://localhost:4567 in your browser when it starts.
#   sh scripts/service.sh install | uninstall | restart | status
set -e

LABEL="local.teamclaude-dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LOG="$HOME/Library/Logs/teamclaude-dashboard.log"
DOMAIN="gui/$(id -u)"

install() {
  [ -n "$NODE" ] || { echo "node not found on PATH"; exit 1; }
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPEN_BROWSER</key><string>1</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$PLIST"
  echo "Installed. Dashboard starts at login: http://localhost:4567"
  echo "Logs: $LOG"
}

case "$1" in
  install) install ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed. The dashboard no longer starts at login." ;;
  restart) launchctl kickstart -k "$DOMAIN/$LABEL" && echo "Restarted." ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "state =|pid =" | sed 's/^[[:space:]]*//'
    else
      echo "Not installed."
    fi ;;
  *) echo "usage: sh scripts/service.sh install|uninstall|restart|status"; exit 1 ;;
esac
