#!/bin/bash
# Setup CodeKeeper as a Linux systemd service
# Usage: sudo bash scripts/setup-systemd.sh

set -euo pipefail

CODEKEEPER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_NAME="codekeeper"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root (use sudo)"
    exit 1
fi

echo "=== CodeKeeper Linux Service Setup ==="
echo "CodeKeeper directory: $CODEKEEPER_DIR"

# Find Node.js
NODE_PATH="$(command -v node || true)"
if [ -z "$NODE_PATH" ]; then
    echo "Node.js not found in PATH. Please install Node.js >= 22 first."
    exit 1
fi

echo "Node.js found: $NODE_PATH"

# Get the user to run as (default to current SUDO_USER or $USER)
RUN_USER="${SUDO_USER:-${USER:-root}}"
RUN_USER_HOME="$(eval echo ~$RUN_USER)"

# Create systemd service file
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=CodeKeeper — Code Orchestrator & Review Node
After=network.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$CODEKEEPER_DIR
ExecStart=$NODE_PATH $CODEKEEPER_DIR/dist/index.js --daemon
Restart=always
RestartSec=10
Environment="CODEKEEPER_CONFIG=$CODEKEEPER_DIR/config/projects.yaml"
Environment="CODEKEEPER_LOG_DIR=$RUN_USER_HOME/Logs/codekeeper"
Environment="PATH=/usr/local/bin:/usr/bin:/bin"
Environment="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}"
Environment="GITLAB_TOKEN=${GITLAB_TOKEN:-}"

[Install]
WantedBy=multi-user.target
EOF

# Create log directory
mkdir -p "$RUN_USER_HOME/Logs/codekeeper"
chown -R "$RUN_USER:$RUN_USER" "$RUN_USER_HOME/Logs/codekeeper" 2>/dev/null || true

# Reload systemd and enable service
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

# Start service
systemctl start "$SERVICE_NAME"

# Verify
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo ""
    echo "✅ CodeKeeper service installed and running!"
    echo "   Service: $SERVICE_NAME"
    echo "   Logs: journalctl -u $SERVICE_NAME -f"
    echo "   Config: $CODEKEEPER_DIR/config/projects.yaml"
    echo ""
    echo "Commands:"
    echo "   Status:  sudo systemctl status $SERVICE_NAME"
    echo "   Stop:    sudo systemctl stop $SERVICE_NAME"
    echo "   Restart: sudo systemctl restart $SERVICE_NAME"
    echo "   Logs:    sudo journalctl -u $SERVICE_NAME -f"
else
    echo "❌ Failed to start service. Check logs:"
    echo "   sudo journalctl -u $SERVICE_NAME --no-pager"
    exit 1
fi
