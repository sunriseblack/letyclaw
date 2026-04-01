#!/usr/bin/env bash
set -euo pipefail

echo "=== Letyclaw Droplet Setup ==="

# Node.js 22 LTS
if ! node --version 2>/dev/null | grep -q "v22"; then
  echo "Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "Node.js 22 already installed: $(node --version)"
fi

# Claude Code CLI
echo "Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# Python + uv for MCP tools (Alpha Vantage, flights, etc.)
echo "Installing Python tooling for MCP tools..."
sudo apt-get install -y python3-pip python3-venv
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"

# UFW firewall
echo "Configuring UFW firewall..."
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# Obsidian Headless (vault sync)
echo "Installing obsidian-headless for Obsidian Sync..."
npm install -g obsidian-headless

# Filesystem permissions
echo "Setting filesystem permissions..."
mkdir -p ~/vault
chmod 700 ~/vault

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Run 'claude' to authenticate with your Max subscription"
echo "  2. Verify: claude -p 'say hello' --permission-mode bypassPermissions"
echo "  3. Set up Obsidian Sync:"
echo "     obsidian-headless --vault /root/vault"
echo "     # Follow prompts to authenticate and select your vault"
echo "     sudo cp systemd/obsidian-sync.service /etc/systemd/system/"
echo "     sudo systemctl enable --now obsidian-sync"
echo "  4. Copy config/letyclaw.example.yaml to config/letyclaw.yaml and customize"
echo "  5. Copy config/cron.example.yaml to config/cron.yaml and customize"
echo "  6. Run scripts/setup-mcp.sh to register MCP tools"
