#!/usr/bin/env bash
set -euo pipefail

REPO_PATH="$(dirname "$(dirname "$(realpath "$0")")")"
VAULT_PATH="${VAULT_PATH:-$HOME/vault}"

echo "=== Deploying unified super-agent ==="
echo "From: $REPO_PATH/agents/"
echo "To:   $VAULT_PATH/"
echo ""

# Deploy unified CLAUDE.md to vault root (Claude CLI reads this as project instructions)
UNIFIED_CLAUDE="$REPO_PATH/agents/unified/CLAUDE.md"
SHARED_TOOLS="$REPO_PATH/agents/shared/TOOLS.md"

if [ -f "$UNIFIED_CLAUDE" ]; then
  cp "$UNIFIED_CLAUDE" "$VAULT_PATH/CLAUDE.md"
  echo "  Deployed: CLAUDE.md (unified instructions) -> $VAULT_PATH/"
else
  echo "ERROR: $UNIFIED_CLAUDE not found"
  exit 1
fi

if [ -f "$SHARED_TOOLS" ]; then
  cp "$SHARED_TOOLS" "$VAULT_PATH/TOOLS.md"
  echo "  Deployed: TOOLS.md (Telegram formatting) -> $VAULT_PATH/"
fi

# Ensure per-domain directories exist (for memory, data files)
# Read agent IDs from config (fall back to example config)
CONFIG_FILE="$REPO_PATH/config/letyclaw.yaml"
if [ ! -f "$CONFIG_FILE" ]; then
  CONFIG_FILE="$REPO_PATH/config/letyclaw.example.yaml"
fi

if command -v node &>/dev/null && [ -f "$CONFIG_FILE" ]; then
  AGENT_IDS=$(node -e "
    const yaml = require('js-yaml');
    const fs = require('fs');
    const config = yaml.load(fs.readFileSync('$CONFIG_FILE', 'utf8'));
    (config.agents?.list || []).forEach(a => console.log(a.id));
  " 2>/dev/null || echo "personal")
else
  AGENT_IDS="personal"
fi

for agent in $AGENT_IDS; do
  mkdir -p "$VAULT_PATH/$agent/memory"
  echo "  Ensured: $VAULT_PATH/$agent/memory/"
done

# Fix ownership — deploy runs as root, bot runs as letyclaw
if id letyclaw &>/dev/null; then
  chown -R letyclaw:letyclaw "$VAULT_PATH/CLAUDE.md" "$VAULT_PATH/TOOLS.md" 2>/dev/null || true
  chown -R letyclaw:letyclaw "$VAULT_PATH/browser-profiles" 2>/dev/null || true
  for agent in $AGENT_IDS; do
    chown -R letyclaw:letyclaw "$VAULT_PATH/$agent" 2>/dev/null || true
  done
  echo "  Ownership: chown letyclaw:letyclaw on vault files"
fi

# Deploy systemd service file if changed
SERVICE_SRC="$REPO_PATH/systemd/letyclaw-bot.service"
SERVICE_DST="/etc/systemd/system/letyclaw-bot.service"
if [ -f "$SERVICE_SRC" ] && ! diff -q "$SERVICE_SRC" "$SERVICE_DST" &>/dev/null; then
  cp "$SERVICE_SRC" "$SERVICE_DST"
  systemctl daemon-reload
  echo "  Updated: letyclaw-bot.service (systemctl daemon-reload done)"
fi

echo ""
echo "=== Setting up letyclaw-tools MCP server ==="
bash "$REPO_PATH/scripts/setup-mcp.sh" "$REPO_PATH"

echo ""
echo "Done. Unified super-agent deployed + MCP tools registered."
