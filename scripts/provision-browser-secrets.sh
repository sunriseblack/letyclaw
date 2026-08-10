#!/bin/bash
# Atomically provision browser aliases and exact HTTPS origin policy from a
# root-owned JSON file, then prove the restarted browser before deleting source.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-/root/letyclaw}"
SOURCE="${1:-}"
STATE_DIR="${BROWSER_STATE_DIR:-/var/lib/letyclaw-browser}"
VAULT_PATH="${VAULT_PATH:-/root/vault}"
SECRETS="${STATE_DIR}/secrets.env"
POLICY="${STATE_DIR}/secret-policy.json"
NAMES="/var/lib/letyclaw-browser-secret-names"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: browser secret provisioning must run as root" >&2
  exit 1
fi
if [ -z "$SOURCE" ] || [ -L "$SOURCE" ] || [ ! -f "$SOURCE" ]; then
  echo "Usage: sudo bash scripts/provision-browser-secrets.sh /root/private-browser-credentials.json" >&2
  exit 1
fi
if [ "$(stat -c %U "$SOURCE")" != "root" ] || [ $((8#$(stat -c %a "$SOURCE") & 077)) -ne 0 ]; then
  echo "ERROR: credential import source must be root-owned and mode 0600 or stricter" >&2
  exit 1
fi
if ! command -v flock &>/dev/null; then
  echo "ERROR: flock is required for browser provisioning" >&2
  exit 1
fi
exec 9>/run/lock/letyclaw-browser-deploy.lock
if ! flock -n 9; then
  echo "ERROR: another browser deployment/provisioning transaction is running" >&2
  exit 1
fi

TRANSACTION=$(mktemp -d /tmp/letyclaw-browser-secrets-rollback.XXXXXX)
PERMANENT_BACKUP="/var/lib/letyclaw-browser-import-backup/manual-$(date -u +%Y%m%dT%H%M%SZ)"
install -d -o root -g root -m 0700 "$PERMANENT_BACKUP"
WAS_ACTIVE=0
WAS_PROXY_ACTIVE=0
WAS_PROXY_SOCKET_ACTIVE=0
systemctl is-active --quiet playwright-mcp && WAS_ACTIVE=1 || true
systemctl is-active --quiet playwright-mcp-proxy.service && WAS_PROXY_ACTIVE=1 || true
systemctl is-active --quiet playwright-mcp-proxy.socket && WAS_PROXY_SOCKET_ACTIVE=1 || true

for entry in "secrets:${SECRETS}" "policy:${POLICY}" "names:${NAMES}"; do
  label=${entry%%:*}
  path=${entry#*:}
  if [ -L "$path" ]; then
    echo "ERROR: refusing symlinked browser credential state: $path" >&2
    exit 1
  fi
  if [ -f "$path" ]; then cp -a "$path" "$TRANSACTION/$label"; else touch "$TRANSACTION/$label.absent"; fi
done

rollback() {
  status=$?
  trap - EXIT INT TERM
  if [ "$status" -ne 0 ]; then
    systemctl stop playwright-mcp-proxy.service playwright-mcp-proxy.socket playwright-mcp 2>/dev/null || true
    for entry in "secrets:${SECRETS}" "policy:${POLICY}" "names:${NAMES}"; do
      label=${entry%%:*}
      path=${entry#*:}
      if [ -f "$TRANSACTION/$label" ]; then
        cp -a "$TRANSACTION/$label" "$path"
      elif [ -f "$TRANSACTION/$label.absent" ]; then
        rm -f "$path"
      fi
    done
    if [ "$WAS_ACTIVE" = "1" ]; then systemctl start playwright-mcp || true; fi
    if [ "$WAS_PROXY_SOCKET_ACTIVE" = "1" ]; then systemctl start playwright-mcp-proxy.socket || true; fi
    if [ "$WAS_PROXY_ACTIVE" = "1" ]; then systemctl start playwright-mcp-proxy.service || true; fi
  fi
  rm -rf "$TRANSACTION"
  exit "$status"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

systemctl stop playwright-mcp-proxy.service playwright-mcp-proxy.socket playwright-mcp
node "${PROJECT_ROOT}/dist/scripts/import-browser-secrets.js" \
  --source "$SOURCE" \
  --secrets "$SECRETS" \
  --policy "$POLICY" \
  --backup "${PERMANENT_BACKUP}/source.json" \
  --receipt "${PERMANENT_BACKUP}/receipt.json" \
  --owner-uid "$(id -u letyclaw-browser)" \
  --owner-gid "$(id -g letyclaw-browser)"

SKIP_SYSTEM_DEPS=1 SKIP_RUNTIME_INSTALL=1 \
  BROWSER_STATE_DIR="$STATE_DIR" VAULT_PATH="$VAULT_PATH" \
  bash "${PROJECT_ROOT}/scripts/setup-browser.sh"
systemctl start playwright-mcp
systemctl start playwright-mcp-proxy.socket
for _ in $(seq 1 60); do
  if [ -s /run/letyclaw-browser/ready ]; then break; fi
  sleep 1
done
test -s /run/letyclaw-browser/ready
PLAYWRIGHT_GATEWAY_TOKEN=$(sed -n 's/^PLAYWRIGHT_GATEWAY_TOKEN=//p' /etc/letyclaw-browser/gateway.env)
PLAYWRIGHT_MCP_URL=http://localhost:3100/mcp \
  PLAYWRIGHT_MCP_ARTIFACT_DIR="${VAULT_PATH}/browser-artifacts" \
  PLAYWRIGHT_MCP_WORKSPACE_ROOT="$VAULT_PATH" \
  PLAYWRIGHT_MCP_EXPECT_HEADFUL=1 \
  PLAYWRIGHT_GATEWAY_TOKEN="$PLAYWRIGHT_GATEWAY_TOKEN" \
  node "${PROJECT_ROOT}/dist/scripts/browser-smoke.js"
systemctl is-active --quiet playwright-mcp-proxy.service

node "${PROJECT_ROOT}/dist/scripts/import-browser-secrets.js" \
  --remove-source-from-receipt --source "$SOURCE" \
  --receipt "${PERMANENT_BACKUP}/receipt.json"
trap - EXIT INT TERM
rm -rf "$TRANSACTION"
echo "Browser aliases provisioned with exact-origin policy; protected source archived and removed."
