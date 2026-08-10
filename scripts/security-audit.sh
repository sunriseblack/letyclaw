#!/usr/bin/env bash
set -euo pipefail

# Read-only security checks for the current Letyclaw deployment. Paths are
# configurable so the audit remains useful for non-default installations.
PROJECT_ROOT="${LETYCLAW_PROJECT_ROOT:-${REPO_PATH:-/root/letyclaw}}"
VAULT_PATH="${LETYCLAW_VAULT_PATH:-${VAULT_PATH:-/root/vault}}"
RUNTIME_USER="${LETYCLAW_RUNTIME_USER:-letyclaw}"
BOT_ENV_FILE="${LETYCLAW_BOT_ENV_FILE:-/etc/letyclaw-bot/env}"
CONFIG_FILE="${LETYCLAW_CONFIG_FILE:-$PROJECT_ROOT/config/letyclaw.yaml}"
DOMAIN_DIR="$VAULT_PATH/.letyclaw/domains"

PASS=0
FAIL=0
SKIP=0

pass() {
  echo "  PASS: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo "  FAIL: $1"
  FAIL=$((FAIL + 1))
}

skip() {
  echo "  SKIP: $1"
  SKIP=$((SKIP + 1))
}

check() {
  local description=$1
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$description"
  else
    fail "$description"
  fi
}

file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1" 2>/dev/null
}

has_mode() {
  local expected=$1 path=$2
  [ "$(file_mode "$path")" = "$expected" ]
}

is_regular_file() {
  [ -f "$1" ] && [ ! -L "$1" ]
}

has_configured_values() {
  is_regular_file "$CONFIG_FILE" || return 1
  ! grep -Eq 'YOUR_(GROUP|USER)_ID_HERE|YOUR_[A-Z0-9_]+|<[^>]*(token|id)[^>]*>' "$CONFIG_FILE"
}

has_routed_domains() {
  [ -d "$DOMAIN_DIR" ] &&
    find "$DOMAIN_DIR" -maxdepth 1 -type f -name '*.md' -size +0c -print -quit | grep -q .
}

instructions_are_read_only() {
  local path mode
  for path in "$VAULT_PATH/CLAUDE.md" "$VAULT_PATH/TOOLS.md" "$DOMAIN_DIR"/*.md; do
    is_regular_file "$path" || return 1
    mode=$(file_mode "$path") || return 1
    # Reject group/other write bits. The deployer normally installs 0640.
    [ $((8#$mode & 8#022)) -eq 0 ] || return 1
  done
}

browser_users_are_isolated() {
  local account
  for account in letyclaw-browser letyclaw-browser-proxy; do
    id "$account" >/dev/null 2>&1 || continue
    if id -nG "$account" | tr ' ' '\n' | grep -qx "$RUNTIME_USER"; then
      return 1
    fi
  done
}

has_no_direct_browser_mcp() {
  local runtime_home config
  runtime_home=$(getent passwd "$RUNTIME_USER" 2>/dev/null | cut -d: -f6 || true)
  for config in \
    "$PROJECT_ROOT/.mcp.json" \
    "/root/.claude.json" \
    "${runtime_home:+$runtime_home/.claude.json}"; do
    [ -n "$config" ] && [ -f "$config" ] || continue
    # Claude clients must use the filtered loopback gateway, never spawn the
    # raw Playwright package themselves.
    if grep -Eq '@playwright/mcp|playwright-mcp[^-]*(--|$)' "$config"; then
      return 1
    fi
  done
}

runtime_contract_is_consistent() {
  local major drift
  [ -x /usr/bin/node ] && [ -x /usr/bin/claude ] || return 1
  major=$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')
  [[ "$major" =~ ^[0-9]+$ ]] && [ "$major" -ge 22 ] || return 1
  ! grep -Rqs '/root/.nvm' "$PROJECT_ROOT/systemd" || return 1
  drift=$(grep -RhE '^ExecStart(Pre|Post)?=.*node([[:space:]]|$)' \
    "$PROJECT_ROOT/systemd" 2>/dev/null | grep -Fv '/usr/bin/node' || true)
  [ -z "$drift" ] || return 1
  grep -Fqx 'ExecStart=/usr/bin/node dist/bot.js' \
    "$PROJECT_ROOT/systemd/letyclaw-bot.service" || return 1
  grep -Fqx 'Environment=CLAUDE_PATH=/usr/bin/claude' \
    "$PROJECT_ROOT/systemd/letyclaw-bot.service"
}

echo "=== Letyclaw security audit ==="
echo "Project: $PROJECT_ROOT"
echo "Vault:   $VAULT_PATH"
echo "User:    $RUNTIME_USER"
echo ""

echo "--- Configuration and secrets ---"
check "system Node/Claude paths match the checked-in unit contract" runtime_contract_is_consistent
check "runtime config exists and contains no example placeholders" has_configured_values
check "bot environment is a regular, non-symlink file" is_regular_file "$BOT_ENV_FILE"
check "bot environment mode is 0600" has_mode 600 "$BOT_ENV_FILE"

echo "--- Trusted instructions and writable state ---"
check "vault exists with mode 0700" has_mode 700 "$VAULT_PATH"
check "shared CLAUDE.md is a regular file" is_regular_file "$VAULT_PATH/CLAUDE.md"
check "shared TOOLS.md is a regular file" is_regular_file "$VAULT_PATH/TOOLS.md"
check "at least one non-empty routed domain is deployed" has_routed_domains
check "trusted instruction files are not group/other writable" instructions_are_read_only

echo "--- MCP and identity isolation ---"
check "Claude configuration does not launch raw Playwright MCP" has_no_direct_browser_mcp
check "browser service identities are outside the bot group" browser_users_are_isolated

echo "--- systemd services ---"
if command -v systemctl >/dev/null 2>&1 && \
   systemctl list-unit-files letyclaw-bot.service >/dev/null 2>&1; then
  check "letyclaw-bot.service is enabled" systemctl is-enabled --quiet letyclaw-bot.service
  check "letyclaw-bot.service is active" systemctl is-active --quiet letyclaw-bot.service
  if [ "$(systemctl show -p User --value letyclaw-bot.service 2>/dev/null)" = "$RUNTIME_USER" ]; then
    pass "letyclaw-bot.service runs as $RUNTIME_USER"
  else
    fail "letyclaw-bot.service runs as $RUNTIME_USER"
  fi
  check "main Claude token refresh timer is enabled" systemctl is-enabled --quiet claude-token-refresh.timer
  check "main Claude token refresh timer is active" systemctl is-active --quiet claude-token-refresh.timer
  check "Claude auth probe timer is enabled" systemctl is-enabled --quiet claude-auth-check.timer
  check "Claude auth probe timer is active" systemctl is-active --quiet claude-auth-check.timer

  for unit in \
    health-webhook.service \
    obsidian-sync.service \
    playwright-mcp.service \
    playwright-mcp-proxy.socket \
    vault-backup.timer; do
    if systemctl is-enabled --quiet "$unit" 2>/dev/null; then
      check "$unit is active when enabled" systemctl is-active --quiet "$unit"
    else
      skip "$unit is optional and disabled"
    fi
  done
else
  skip "systemd service checks (letyclaw-bot.service is not installed here)"
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed, $SKIP skipped ==="
if [ "$FAIL" -eq 0 ]; then
  echo "All applicable checks passed."
else
  echo "ACTION REQUIRED: resolve failed checks before go-live."
  exit 1
fi
