#!/bin/bash
# Setup CodeKeeper as a macOS launchd service

set -euo pipefail

CODEKEEPER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_NAME="com.codekeeper.review.plist"
PLIST_PATH="$CODEKEEPER_DIR/scripts/$PLIST_NAME"
LAUNCHD_DIR="$HOME/Library/LaunchAgents"
INSTALLED_PLIST="$LAUNCHD_DIR/$PLIST_NAME"

echo "=== CodeKeeper macOS Service Setup ==="
echo "CodeKeeper directory: $CODEKEEPER_DIR"

# Create launchd directory
mkdir -p "$LAUNCHD_DIR"

# Generate plist
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codekeeper.review</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>$CODEKEEPER_DIR/dist/index.js</string>
        <string>--daemon</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$CODEKEEPER_DIR</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>CODEKEEPER_CONFIG</key>
        <string>$CODEKEEPER_DIR/config/projects.yaml</string>
        <key>CODEKEEPER_LOG_DIR</key>
        <string>$HOME/Logs/codekeeper</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Logs/codekeeper/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Logs/codekeeper/launchd.err.log</string>
</dict>
</plist>
EOF

# Install plist
cp "$PLIST_PATH" "$INSTALLED_PLIST"

# Unload if already loaded (ignore errors)
launchctl unload "$INSTALLED_PLIST" 2>/dev/null || true

# Load service
launchctl load "$INSTALLED_PLIST"

# Verify
if launchctl list | grep -q "com.codekeeper.review"; then
    echo "✅ CodeKeeper service installed and running"
    echo "   Logs: $HOME/Logs/codekeeper/"
    echo "   Stop: launchctl unload $INSTALLED_PLIST"
else
    echo "❌ Failed to start service. Check logs:"
    echo "   $HOME/Logs/codekeeper/launchd.err.log"
    exit 1
fi
