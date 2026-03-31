#!/bin/bash
#
# Setup MCP servers for Claude CLI (letyclaw-tools + playwright).
#
# Registers at user scope for BOTH root and letyclaw users — bot.js runs as
# the letyclaw user, so MCP servers must be registered under that user too.
#
# Playwright MCP runs as a persistent SSE server (systemd service) so the
# browser stays alive across Claude CLI invocations. Tabs, form state, and
# navigation persist until the service is restarted.
#
# Usage:
#   bash scripts/setup-mcp.sh          # Register for production (auto-detect)
#   bash scripts/setup-mcp.sh $(pwd)   # Register for local development
#

set -euo pipefail

PROJECT_ROOT="${1:-$(dirname "$(dirname "$(realpath "$0")")")}"
SERVER_PATH="${PROJECT_ROOT}/tools/letyclaw-mcp/server.js"
VAULT_PATH="${VAULT_PATH:-$HOME/vault}"
BROWSER_PROFILE_DIR="${VAULT_PATH}/browser-profiles"
PLAYWRIGHT_PORT=3100

# Load .env so API keys are available (deploy-agents.sh calls us without sourcing .env)
if [ -f "${PROJECT_ROOT}/.env" ]; then
  set -a
  source "${PROJECT_ROOT}/.env"
  set +a
fi

# Ensure uv-installed tools are in PATH
export PATH="$HOME/.local/bin:$PATH"

echo "=== MCP Setup ==="
echo "Project root:    ${PROJECT_ROOT}"
echo "Server path:     ${SERVER_PATH}"
echo "Browser profile: ${BROWSER_PROFILE_DIR}"

# Check that the server file exists
if [ ! -f "${SERVER_PATH}" ]; then
  echo "Error: Server not found at ${SERVER_PATH}"
  echo "Run this script from the letyclaw project root or pass the path as an argument."
  exit 1
fi

# Check that @modelcontextprotocol/sdk is installed
if [ ! -d "${PROJECT_ROOT}/node_modules/@modelcontextprotocol/sdk" ]; then
  echo "Installing dependencies..."
  cd "${PROJECT_ROOT}" && npm install
fi

mkdir -p "${BROWSER_PROFILE_DIR}"

# Ensure uv/uvx is available (needed for fli + alphavantage MCP)
if ! command -v uvx &>/dev/null; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# Ensure fli (Google Flights MCP) is installed
if ! command -v fli-mcp &>/dev/null; then
  echo "Installing fli (Google Flights search)..."
  uv tool install flights
fi

# Fix permissions so letyclaw user can access uv-installed tools (bot runs as User=letyclaw)
if [ -d "$HOME/.local/share/uv" ]; then
  chmod o+rx "$HOME/.local/share/" 2>/dev/null || true
  chmod -R o+rX "$HOME/.local/share/uv/" 2>/dev/null || true
fi

# --- Deploy Playwright MCP as persistent systemd service ---
if [ -f "${PROJECT_ROOT}/systemd/playwright-mcp.service" ]; then
  cp "${PROJECT_ROOT}/systemd/playwright-mcp.service" /etc/systemd/system/playwright-mcp.service
  systemctl daemon-reload
  systemctl enable playwright-mcp 2>/dev/null || true
  systemctl restart playwright-mcp
  echo ""
  echo "Playwright MCP: persistent SSE server on port ${PLAYWRIGHT_PORT}"
  # Wait for server to be ready
  for i in 1 2 3 4 5; do
    if curl -s "http://127.0.0.1:${PLAYWRIGHT_PORT}/sse" --max-time 1 -o /dev/null 2>/dev/null; then
      echo "  Status: ready"
      break
    fi
    sleep 1
  done
fi

# Register MCP servers for a user
register_for_user() {
  local run_as="$1"
  local label="$2"

  echo ""
  echo "Registering MCP servers for ${label}..."

  ${run_as} claude mcp remove --scope user letyclaw-tools 2>/dev/null || true
  ${run_as} claude mcp remove --scope user playwright 2>/dev/null || true
  ${run_as} claude mcp remove --scope user email 2>/dev/null || true
  ${run_as} claude mcp remove --scope user fli 2>/dev/null || true
  ${run_as} claude mcp remove --scope user alphavantage 2>/dev/null || true

  ${run_as} claude mcp add --scope user --transport stdio letyclaw-tools -- \
    node "${SERVER_PATH}"

  # Playwright MCP runs as a persistent SSE server — browser stays alive
  # across Claude CLI invocations (tabs, forms, navigation persist)
  ${run_as} claude mcp add --scope user --transport sse playwright \
    "http://127.0.0.1:${PLAYWRIGHT_PORT}/sse"

  # Email MCP — IMAP/SMTP support
  # Credentials in ~/.config/email-mcp/config.toml (per-user, not in repo)
  ${run_as} claude mcp add --scope user --transport stdio email -- \
    npx -y @codefuturist/email-mcp stdio

  # fli — Google Flights search (search_flights + search_dates tools)
  ${run_as} claude mcp add --scope user --transport stdio fli -- \
    fli-mcp

  # Alpha Vantage — stocks, forex, crypto, commodities, economic indicators
  # API key baked into the command (env vars don't propagate to MCP subprocesses)
  if [ -n "${ALPHA_VANTAGE_API_KEY:-}" ]; then
    ${run_as} claude mcp add --scope user --transport stdio alphavantage -- \
      uvx --from marketdata-mcp-server marketdata-mcp "${ALPHA_VANTAGE_API_KEY}"
  else
    echo "  Warning: ALPHA_VANTAGE_API_KEY not set, skipping alphavantage MCP"
  fi

  echo "  Done: ${label}"
}

# Register for root (interactive / deploy use)
register_for_user "" "root"

# Register for letyclaw user (bot.js runtime) if the user exists
if id letyclaw &>/dev/null; then
  register_for_user "sudo -u letyclaw" "letyclaw (bot runtime)"
fi

echo ""
echo "Done! MCP servers registered: letyclaw-tools + playwright (SSE) + email (IMAP/SMTP) + fli (flights) + alphavantage"
echo ""
echo "Verify with: claude mcp list"
echo "Test with:   claude -p 'use self_info tool to show current context'"
echo ""
echo "letyclaw-tools (32 tools, stdio):"
echo "  Memory:    memory_search, memory_get, memory_save, memory_delete, memory_list"
echo "  Sessions:  sessions_list, sessions_history, sessions_send, sessions_spawn,"
echo "             sessions_yield, subagents, session_status"
echo "  Messaging: message_send, message_buttons, message_poll, message_react,"
echo "             message_typing, message_edit"
echo "  Cron:      cron_create, cron_list, cron_delete"
echo "  Media:     image, image_generate, tts"
echo "  Voice:     voice_call, voice_call_status"
echo "  Extras:    nodes_list, nodes_control, canvas_create, canvas_update,"
echo "             self_info, cross_agent_read"
echo ""
echo "playwright (browser automation, persistent SSE on :${PLAYWRIGHT_PORT}):"
echo "  browser_navigate, browser_click, browser_type, browser_snapshot,"
echo "  browser_screenshot, browser_fill, browser_select_option, browser_wait, etc."
echo "  Browser persists across messages — tabs and page state survive."
echo ""
echo "email (IMAP/SMTP via @codefuturist/email-mcp):"
echo "  Credentials: ~/.config/email-mcp/config.toml"
echo ""
echo "fli (Google Flights search via pip:flights):"
echo "  search_flights — one-way/round-trip flight search with filters"
echo "  search_dates — cheapest dates across flexible date ranges"
echo ""
echo "alphavantage (market data via marketdata-mcp-server, requires ALPHA_VANTAGE_API_KEY):"
echo "  Progressive discovery: TOOL_LIST, TOOL_GET, TOOL_CALL"
echo "  80+ tools: stocks, forex, crypto, commodities, economic indicators, technicals"
