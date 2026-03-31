#!/bin/bash
#
# Setup Playwright browser for agentic browsing.
#
# Installs Chromium via Playwright and creates the browser profile directory
# for persistent sessions (cookies, localStorage, logins).
#
# Usage:
#   bash scripts/setup-browser.sh              # Defaults to $HOME/vault
#   VAULT_PATH=/path/to/vault bash scripts/setup-browser.sh
#

set -euo pipefail

VAULT_PATH="${VAULT_PATH:-$HOME/vault}"
BROWSER_PROFILE_DIR="${VAULT_PATH}/browser-profiles"

echo "=== Playwright Browser Setup ==="
echo "Vault:           ${VAULT_PATH}"
echo "Browser profiles: ${BROWSER_PROFILE_DIR}"
echo ""

# Install Playwright Chromium + system deps
echo "Installing Playwright Chromium..."
npx playwright install chromium
npx playwright install-deps chromium

# Create browser profile directory
mkdir -p "${BROWSER_PROFILE_DIR}"
echo "Created browser profile directory: ${BROWSER_PROFILE_DIR}"

# Verify Playwright MCP package is accessible
echo ""
echo "Verifying @playwright/mcp..."
npx @playwright/mcp@latest --help > /dev/null 2>&1 && echo "OK: @playwright/mcp is available" || {
  echo "WARNING: @playwright/mcp not responding. Run: npx @playwright/mcp@latest --help"
}

echo ""
echo "Done! Browser automation ready."
echo ""
echo "Next steps:"
echo "  1. Run scripts/setup-mcp.sh to register Playwright MCP with Claude CLI"
echo "  2. Run scripts/deploy-agents.sh to deploy updated AGENTS.md files"
echo "  3. Test: claude -p 'navigate to google.com and take a screenshot'"
