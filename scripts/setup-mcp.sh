#!/bin/bash
#
# Setup MCP servers for Claude CLI (letyclaw-tools + playwright).
#
# Registers at user scope for BOTH root and letyclaw users — bot.ts runs as
# the letyclaw user, so MCP servers must be registered under that user too.
#
# A safe gateway owns Playwright over private stdio and exposes only filtered
# browser tools over loopback HTTP. Tabs, cookies, and forms persist across
# short Claude CLI invocations.
#
# Usage:
#   bash scripts/setup-mcp.sh          # Register for production (/root/letyclaw)
#   bash scripts/setup-mcp.sh $(pwd)   # Register for local development
#

set -euo pipefail

PROJECT_ROOT="${1:-/root/letyclaw}"
SERVER_PATH="${PROJECT_ROOT}/dist/tools/letyclaw-mcp/server.js"
VAULT_PATH="${VAULT_PATH:-/root/vault}"
BROWSER_STATE_DIR="${BROWSER_STATE_DIR:-/var/lib/letyclaw-browser}"
BROWSER_PROFILE_DIR="${BROWSER_STATE_DIR}/profile"
BROWSER_ARTIFACT_DIR="${VAULT_PATH}/browser-artifacts"
PLAYWRIGHT_MCP_VERSION="0.0.78"
EMAIL_MCP_VERSION="0.2.3"
PLAYWRIGHT_PORT=3100
LETYCLAW_ENABLE_BROWSER_MCP="${LETYCLAW_ENABLE_BROWSER_MCP:-1}"
LETYCLAW_ENABLE_EMAIL_MCP="${LETYCLAW_ENABLE_EMAIL_MCP:-0}"
LETYCLAW_ENABLE_FLI_MCP="${LETYCLAW_ENABLE_FLI_MCP:-0}"
LETYCLAW_ENABLE_MARKETDATA_MCP="${LETYCLAW_ENABLE_MARKETDATA_MCP:-0}"
LETYCLAW_ENABLE_AMPLITUDE_MCP="${LETYCLAW_ENABLE_AMPLITUDE_MCP:-0}"

if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" -eq 0 ] && [ "$PROJECT_ROOT" = "/root/letyclaw" ]; then
  NODE_BIN=/usr/bin/node
  NPM_BIN=/usr/bin/npm
  NPX_BIN=/usr/bin/npx
  CLAUDE_BIN=/usr/bin/claude
else
  NODE_BIN="${LETYCLAW_NODE_BIN:-$(command -v node || true)}"
  NPM_BIN="${LETYCLAW_NPM_BIN:-$(command -v npm || true)}"
  NPX_BIN="${LETYCLAW_NPX_BIN:-$(command -v npx || true)}"
  CLAUDE_BIN="${LETYCLAW_CLAUDE_BIN:-$(command -v claude || true)}"
fi
[ -x "$NODE_BIN" ] || { echo "ERROR: Node.js executable is unavailable: ${NODE_BIN:-<unset>}" >&2; exit 1; }
[ -x "$NPM_BIN" ] || { echo "ERROR: npm executable is unavailable: ${NPM_BIN:-<unset>}" >&2; exit 1; }
[ -x "$NPX_BIN" ] || { echo "ERROR: npx executable is unavailable: ${NPX_BIN:-<unset>}" >&2; exit 1; }
[ -x "$CLAUDE_BIN" ] || { echo "ERROR: Claude executable is unavailable: ${CLAUDE_BIN:-<unset>}" >&2; exit 1; }

for feature_flag in \
  LETYCLAW_ENABLE_BROWSER_MCP \
  LETYCLAW_ENABLE_EMAIL_MCP \
  LETYCLAW_ENABLE_FLI_MCP \
  LETYCLAW_ENABLE_MARKETDATA_MCP \
  LETYCLAW_ENABLE_AMPLITUDE_MCP; do
  case "${!feature_flag}" in
    0|1) ;;
    *) echo "ERROR: $feature_flag must be 0 or 1" >&2; exit 1 ;;
  esac
done

# Serialize CI and manual browser transactions on the host. Both paths swap
# units/releases and stop the same persistent profile, so overlap is unsafe.
if [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = "Linux" ]; then
  if ! command -v flock &>/dev/null; then
    echo "ERROR: flock is required for browser deployment" >&2
    exit 1
  fi
  exec 9>/run/lock/letyclaw-browser-deploy.lock
  if ! flock -n 9; then
    echo "ERROR: another browser deployment is already running" >&2
    exit 1
  fi
fi

# Ensure uv-installed tools are in PATH
export PATH="$HOME/.local/bin:$PATH"

echo "=== MCP Setup ==="
echo "Project root:    ${PROJECT_ROOT}"
echo "Server path:     ${SERVER_PATH}"
echo "Browser profile: ${BROWSER_PROFILE_DIR}"
echo "Browser output:  ${BROWSER_ARTIFACT_DIR}"

# Check that the server file exists
if [ ! -f "${SERVER_PATH}" ]; then
  echo "Error: Server not found at ${SERVER_PATH}"
  echo "Run this script from the letyclaw-bot project root or pass the path as an argument."
  exit 1
fi

# Check that @modelcontextprotocol/sdk is installed
if [ ! -d "${PROJECT_ROOT}/node_modules/@modelcontextprotocol/sdk" ]; then
  echo "Installing dependencies..."
  cd "${PROJECT_ROOT}" && "$NPM_BIN" install
fi

# Ensure uv/uvx is available only when an opted-in Python MCP needs it.
if { [ "$LETYCLAW_ENABLE_FLI_MCP" = "1" ] || [ "$LETYCLAW_ENABLE_MARKETDATA_MCP" = "1" ]; } && \
   ! command -v uvx &>/dev/null; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# Resolve and handshake the exact stdio package before any browser downtime or
# MCP config mutation. Run only under the bot UID with a dummy key: automatic
# deployment must not execute a public Python dependency tree as root.
if [ "$LETYCLAW_ENABLE_MARKETDATA_MCP" = "1" ] && \
   [ "$(id -u)" -eq 0 ] && [ "$PROJECT_ROOT" = "/root/letyclaw" ]; then
  id letyclaw &>/dev/null || { echo "ERROR: letyclaw runtime user is missing" >&2; exit 1; }
  sudo -u letyclaw env -i \
    HOME="$(getent passwd letyclaw | cut -d: -f6)" \
    PATH="$PATH" \
    LANG="${LANG:-C.UTF-8}" \
    /usr/bin/node "${PROJECT_ROOT}/dist/scripts/smoke-marketdata-mcp.js"
fi

# Ensure fli (Google Flights MCP) is installed
if [ "$LETYCLAW_ENABLE_FLI_MCP" = "1" ] && ! command -v fli-mcp &>/dev/null; then
  echo "Installing fli (Google Flights search)..."
  uv tool install flights
fi

# Fix permissions so letyclaw user can access uv-installed tools (bot runs as User=letyclaw)
if [ -d "$HOME/.local/share/uv" ]; then
  chmod o+rx "$HOME/.local/share/" 2>/dev/null || true
  chmod -R o+rX "$HOME/.local/share/uv/" 2>/dev/null || true
fi

# --- Deploy Playwright MCP as persistent systemd service ---
if [ "$LETYCLAW_ENABLE_BROWSER_MCP" = "1" ] && \
   [ -f "${PROJECT_ROOT}/systemd/playwright-mcp.service" ]; then
  if ! grep -Fq "/mcp-${PLAYWRIGHT_MCP_VERSION}/mcp/node_modules/@playwright/mcp/cli.js" \
    "${PROJECT_ROOT}/systemd/playwright-mcp.service"; then
    echo "ERROR: browser unit and setup script disagree on Playwright MCP version" >&2
    exit 1
  fi
  if ! id letyclaw-browser &>/dev/null; then
    useradd --system --create-home --home-dir /var/lib/letyclaw-browser \
      --shell /usr/sbin/nologin --user-group letyclaw-browser
  fi
  if ! id letyclaw-browser-proxy &>/dev/null; then
    useradd --system --create-home --home-dir /var/lib/letyclaw-browser-proxy \
      --shell /usr/sbin/nologin --user-group letyclaw-browser-proxy
  fi
  if id -nG letyclaw-browser | tr ' ' '\n' | grep -qx letyclaw; then
    gpasswd -d letyclaw-browser letyclaw >/dev/null
  fi
  if ! command -v xvfb-run &>/dev/null || ! command -v xauth &>/dev/null; then
    apt-get update
    apt-get install -y xvfb xauth
  fi
  GATEWAY_ENV_DIR=/etc/letyclaw-browser
  GATEWAY_ENV_FILE="${GATEWAY_ENV_DIR}/gateway.env"
  if [ -L "$GATEWAY_ENV_FILE" ]; then
    echo "ERROR: refusing symlinked browser gateway environment file" >&2
    exit 1
  fi
  install -d -o root -g root -m 0700 "$GATEWAY_ENV_DIR"
  if [ ! -f "$GATEWAY_ENV_FILE" ]; then
    GATEWAY_ENV_TMP=$(mktemp "${GATEWAY_ENV_FILE}.tmp.XXXXXX")
    chmod 0600 "$GATEWAY_ENV_TMP"
    printf 'PLAYWRIGHT_GATEWAY_TOKEN=%s\n' "$(openssl rand -hex 32)" > "$GATEWAY_ENV_TMP"
    mv "$GATEWAY_ENV_TMP" "$GATEWAY_ENV_FILE"
  fi
  chown root:root "$GATEWAY_ENV_FILE"
  chmod 0600 "$GATEWAY_ENV_FILE"
  PLAYWRIGHT_GATEWAY_TOKEN=$(sed -n 's/^PLAYWRIGHT_GATEWAY_TOKEN=//p' "$GATEWAY_ENV_FILE")
  if ! printf '%s' "$PLAYWRIGHT_GATEWAY_TOKEN" | grep -Eq '^[A-Fa-f0-9]{64}$'; then
    echo "ERROR: invalid browser gateway token file" >&2
    exit 1
  fi

  # Build an immutable, content-addressed gateway release before touching the
  # live service. It carries its own MCP SDK dependencies, so unit rollback also
  # rolls back executable code rather than relaunching the failed repo build.
  GATEWAY_RELEASE_ROOT=/var/lib/letyclaw-browser-gateway
  GATEWAY_PACKAGE_DIR="${PROJECT_ROOT}/browser-gateway-runtime"
  GATEWAY_FILES=(browser-gateway browser-gateway-core browser-file-broker browser-safe-dom browser-secret-policy)
  for gateway_file in "${GATEWAY_FILES[@]}"; do
    test -s "${PROJECT_ROOT}/dist/services/${gateway_file}.js"
  done
  test -s "${GATEWAY_PACKAGE_DIR}/package.json"
  test -s "${GATEWAY_PACKAGE_DIR}/package-lock.json"
  GATEWAY_CONTENT_HASH=$(
    for gateway_file in "${GATEWAY_FILES[@]}"; do
      sha256sum "${PROJECT_ROOT}/dist/services/${gateway_file}.js"
    done
    sha256sum "${GATEWAY_PACKAGE_DIR}/package.json" "${GATEWAY_PACKAGE_DIR}/package-lock.json"
  )
  GATEWAY_CONTENT_HASH=$(printf '%s\n' "$GATEWAY_CONTENT_HASH" | sha256sum | cut -c1-20)
  GATEWAY_RELEASE="${GATEWAY_RELEASE_ROOT}/releases/${GATEWAY_CONTENT_HASH}"
  install -d -o root -g root -m 0755 "${GATEWAY_RELEASE_ROOT}/releases"
  if [ ! -d "$GATEWAY_RELEASE" ]; then
    GATEWAY_STAGE="${GATEWAY_RELEASE}.stage.$$"
    rm -rf "$GATEWAY_STAGE"
    install -d -o root -g root -m 0755 "$GATEWAY_STAGE/services"
    for gateway_file in "${GATEWAY_FILES[@]}"; do
      install -o root -g root -m 0644 \
        "${PROJECT_ROOT}/dist/services/${gateway_file}.js" \
        "$GATEWAY_STAGE/services/${gateway_file}.js"
    done
    install -o root -g root -m 0644 "${GATEWAY_PACKAGE_DIR}/package.json" "$GATEWAY_STAGE/package.json"
    install -o root -g root -m 0644 "${GATEWAY_PACKAGE_DIR}/package-lock.json" "$GATEWAY_STAGE/package-lock.json"
    /usr/bin/npm ci --prefix "$GATEWAY_STAGE" --omit=dev --ignore-scripts
    /usr/bin/node --check "$GATEWAY_STAGE/services/browser-gateway.js"
    mv "$GATEWAY_STAGE" "$GATEWAY_RELEASE"
  fi
  test -s "$GATEWAY_RELEASE/services/browser-gateway.js"
  OLD_GATEWAY_TARGET=$(readlink -f "${GATEWAY_RELEASE_ROOT}/current" 2>/dev/null || true)

  # Complete every fallible package/browser download while the currently
  # working service is still online. A registry outage must not take browsing
  # down during an otherwise unrelated deploy.
  SKIP_SYSTEM_DEPS=0 \
    BROWSER_PREPARE_ONLY=1 \
    PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
    BROWSER_STATE_DIR="$BROWSER_STATE_DIR" \
    VAULT_PATH="$VAULT_PATH" \
    bash "${PROJECT_ROOT}/scripts/setup-browser.sh"

  # Fail before stopping the working service if an earlier/manual install has
  # aliases without the now-required exact-origin policy.
  if [ -s "${BROWSER_STATE_DIR}/secrets.env" ] && \
     grep -Eq '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=' "${BROWSER_STATE_DIR}/secrets.env"; then
    if [ ! -s "${BROWSER_STATE_DIR}/secret-policy.json" ]; then
      echo "ERROR: existing browser aliases require ${BROWSER_STATE_DIR}/secret-policy.json" >&2
      exit 1
    fi
    "$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/import-browser-secrets.js" \
      --validate-existing \
      --secrets "${BROWSER_STATE_DIR}/secrets.env" \
      --policy "${BROWSER_STATE_DIR}/secret-policy.json"
  fi

  LEGACY_BROWSER_SECRETS_SOURCE="${LETYCLAW_LEGACY_BROWSER_SECRETS_SOURCE:-}"
  LEGACY_BROWSER_SECRETS_BACKUP="/var/lib/letyclaw-browser-import-backup/legacy-browser-secrets.json"
  LEGACY_BROWSER_SECRETS_RECEIPT="/var/lib/letyclaw-browser-import-backup/legacy-browser-secrets-receipt.json"
  MIGRATED_LEGACY_BROWSER_SECRETS=0

  BROWSER_BACKUP=$(mktemp -d /tmp/letyclaw-browser-rollback.XXXXXX)
  ROOT_CLAUDE_CONFIG=/root/.claude.json
  LETYCLAW_HOME=$(getent passwd letyclaw | cut -d: -f6)
  LETYCLAW_CLAUDE_CONFIG="${LETYCLAW_HOME}/.claude.json"
  for config_entry in "root:${ROOT_CLAUDE_CONFIG}" "letyclaw:${LETYCLAW_CLAUDE_CONFIG}"; do
    config_label=${config_entry%%:*}
    config_path=${config_entry#*:}
    if [ -L "$config_path" ]; then
      echo "ERROR: refusing symlinked Claude MCP config: $config_path" >&2
      exit 1
    fi
    if [ -f "$config_path" ]; then
      cp -a "$config_path" "$BROWSER_BACKUP/${config_label}.claude.json"
    else
      touch "$BROWSER_BACKUP/${config_label}.claude.absent"
    fi
  done
  OLD_MCP_ACTIVE=0
  OLD_MCP_ENABLED=0
  OLD_PROXY_ACTIVE=0
  OLD_PROXY_SOCKET_ACTIVE=0
  OLD_PROXY_SOCKET_ENABLED=0
  OLD_ANCHOR_ACTIVE=0
  OLD_ANCHOR_ENABLED=0
  systemctl is-active --quiet playwright-mcp && OLD_MCP_ACTIVE=1 || true
  systemctl is-enabled --quiet playwright-mcp && OLD_MCP_ENABLED=1 || true
  systemctl is-active --quiet playwright-mcp-proxy && OLD_PROXY_ACTIVE=1 || true
  systemctl is-active --quiet playwright-mcp-proxy.socket && OLD_PROXY_SOCKET_ACTIVE=1 || true
  systemctl is-enabled --quiet playwright-mcp-proxy.socket && OLD_PROXY_SOCKET_ENABLED=1 || true
  systemctl is-active --quiet playwright-anchor && OLD_ANCHOR_ACTIVE=1 || true
  systemctl is-enabled --quiet playwright-anchor && OLD_ANCHOR_ENABLED=1 || true
  if [ -f /etc/systemd/system/playwright-mcp.service ]; then
    cp /etc/systemd/system/playwright-mcp.service "$BROWSER_BACKUP/playwright-mcp.service"
  fi
  if [ -f /etc/systemd/system/playwright-mcp-proxy.service ]; then
    cp /etc/systemd/system/playwright-mcp-proxy.service "$BROWSER_BACKUP/playwright-mcp-proxy.service"
  fi
  if [ -f /etc/systemd/system/playwright-mcp-proxy.socket ]; then
    cp /etc/systemd/system/playwright-mcp-proxy.socket "$BROWSER_BACKUP/playwright-mcp-proxy.socket"
  fi
  if [ -f /etc/systemd/system/playwright-anchor.service ]; then
    cp /etc/systemd/system/playwright-anchor.service "$BROWSER_BACKUP/playwright-anchor.service"
  fi
  ISOLATED_PROFILE_HAD_DATA=0
  if [ -d "$BROWSER_PROFILE_DIR" ] && [ -n "$(find "$BROWSER_PROFILE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    ISOLATED_PROFILE_HAD_DATA=1
  fi

  rollback_browser_deploy() {
    status=$?
    trap - EXIT INT TERM
    # Rollback is best-effort across every saved surface, followed by one
    # explicit compatibility proof. Do not let errexit abort midway and leave
    # a superficially restored but unverified browser runtime.
    set +e
    if [ "$status" -ne 0 ]; then
      echo "Browser deploy failed; restoring the previous units..." >&2
      systemctl stop playwright-mcp-proxy.service playwright-mcp-proxy.socket playwright-mcp playwright-anchor 2>/dev/null || true
      if [ -f "$BROWSER_BACKUP/playwright-mcp.service" ]; then
        cp "$BROWSER_BACKUP/playwright-mcp.service" /etc/systemd/system/playwright-mcp.service
      else
        rm -f /etc/systemd/system/playwright-mcp.service
      fi
      if [ -f "$BROWSER_BACKUP/playwright-anchor.service" ]; then
        cp "$BROWSER_BACKUP/playwright-anchor.service" /etc/systemd/system/playwright-anchor.service
      else
        rm -f /etc/systemd/system/playwright-anchor.service
      fi
      if [ -f "$BROWSER_BACKUP/playwright-mcp-proxy.service" ]; then
        cp "$BROWSER_BACKUP/playwright-mcp-proxy.service" /etc/systemd/system/playwright-mcp-proxy.service
      else
        rm -f /etc/systemd/system/playwright-mcp-proxy.service
      fi
      if [ -f "$BROWSER_BACKUP/playwright-mcp-proxy.socket" ]; then
        cp "$BROWSER_BACKUP/playwright-mcp-proxy.socket" /etc/systemd/system/playwright-mcp-proxy.socket
      else
        rm -f /etc/systemd/system/playwright-mcp-proxy.socket
      fi
      systemctl daemon-reload
      if [ -n "$OLD_GATEWAY_TARGET" ]; then
        ln -sfn "$OLD_GATEWAY_TARGET" "${GATEWAY_RELEASE_ROOT}/current"
      else
        rm -f "${GATEWAY_RELEASE_ROOT}/current"
      fi
      if [ "$ISOLATED_PROFILE_HAD_DATA" = "0" ]; then
        rm -rf "$BROWSER_PROFILE_DIR" "${BROWSER_STATE_DIR}/.legacy-profile-imported"
      fi
      if [ "$MIGRATED_LEGACY_BROWSER_SECRETS" = "1" ] && \
         [ ! -e "$LEGACY_BROWSER_SECRETS_SOURCE" ] && [ -f "$LEGACY_BROWSER_SECRETS_BACKUP" ]; then
        install -d -o letyclaw -g letyclaw -m 0700 "$(dirname "$LEGACY_BROWSER_SECRETS_SOURCE")"
        install -o letyclaw -g letyclaw -m 0600 \
          "$LEGACY_BROWSER_SECRETS_BACKUP" "$LEGACY_BROWSER_SECRETS_SOURCE"
      fi
      for config_entry in "root:${ROOT_CLAUDE_CONFIG}" "letyclaw:${LETYCLAW_CLAUDE_CONFIG}"; do
        config_label=${config_entry%%:*}
        config_path=${config_entry#*:}
        if [ -f "$BROWSER_BACKUP/${config_label}.claude.json" ]; then
          cp -a "$BROWSER_BACKUP/${config_label}.claude.json" "$config_path"
        elif [ -f "$BROWSER_BACKUP/${config_label}.claude.absent" ]; then
          rm -f "$config_path"
        fi
      done
      if [ "$OLD_MCP_ENABLED" = "1" ]; then
        systemctl enable playwright-mcp 2>/dev/null || true
      else
        systemctl disable playwright-mcp 2>/dev/null || true
      fi
      if [ "$OLD_MCP_ACTIVE" = "1" ]; then systemctl start playwright-mcp || true; fi
      if [ "$OLD_PROXY_SOCKET_ENABLED" = "1" ]; then
        systemctl enable playwright-mcp-proxy.socket 2>/dev/null || true
      else
        systemctl disable playwright-mcp-proxy.socket 2>/dev/null || true
      fi
      if [ "$OLD_PROXY_SOCKET_ACTIVE" = "1" ]; then systemctl start playwright-mcp-proxy.socket || true; fi
      if [ "$OLD_PROXY_ACTIVE" = "1" ]; then systemctl start playwright-mcp-proxy.service || true; fi
      if [ "$OLD_ANCHOR_ENABLED" = "1" ]; then systemctl enable playwright-anchor 2>/dev/null || true; fi
      if [ "$OLD_ANCHOR_ACTIVE" = "1" ]; then systemctl start playwright-anchor || true; fi

      BROWSER_ROLLBACK_OK=1
      for saved_unit in playwright-mcp.service playwright-mcp-proxy.service playwright-mcp-proxy.socket playwright-anchor.service; do
        if [ -f "$BROWSER_BACKUP/$saved_unit" ]; then
          cmp -s "$BROWSER_BACKUP/$saved_unit" "/etc/systemd/system/$saved_unit" || BROWSER_ROLLBACK_OK=0
        elif [ -e "/etc/systemd/system/$saved_unit" ]; then
          BROWSER_ROLLBACK_OK=0
        fi
      done
      for config_entry in "root:${ROOT_CLAUDE_CONFIG}" "letyclaw:${LETYCLAW_CLAUDE_CONFIG}"; do
        config_label=${config_entry%%:*}
        config_path=${config_entry#*:}
        if [ -f "$BROWSER_BACKUP/${config_label}.claude.json" ]; then
          cmp -s "$BROWSER_BACKUP/${config_label}.claude.json" "$config_path" || BROWSER_ROLLBACK_OK=0
        elif [ -f "$BROWSER_BACKUP/${config_label}.claude.absent" ] && [ -e "$config_path" ]; then
          BROWSER_ROLLBACK_OK=0
        fi
      done
      if [ -n "$OLD_GATEWAY_TARGET" ]; then
        [ "$(readlink -f "${GATEWAY_RELEASE_ROOT}/current" 2>/dev/null || true)" = "$OLD_GATEWAY_TARGET" ] || BROWSER_ROLLBACK_OK=0
      elif [ -e "${GATEWAY_RELEASE_ROOT}/current" ] || [ -L "${GATEWAY_RELEASE_ROOT}/current" ]; then
        BROWSER_ROLLBACK_OK=0
      fi
      if [ "$OLD_MCP_ENABLED" = "1" ]; then
        systemctl is-enabled --quiet playwright-mcp || BROWSER_ROLLBACK_OK=0
      else
        systemctl is-enabled --quiet playwright-mcp && BROWSER_ROLLBACK_OK=0
      fi
      if [ "$OLD_PROXY_SOCKET_ENABLED" = "1" ]; then
        systemctl is-enabled --quiet playwright-mcp-proxy.socket || BROWSER_ROLLBACK_OK=0
      else
        systemctl is-enabled --quiet playwright-mcp-proxy.socket && BROWSER_ROLLBACK_OK=0
      fi
      if [ "$OLD_ANCHOR_ENABLED" = "1" ]; then
        systemctl is-enabled --quiet playwright-anchor || BROWSER_ROLLBACK_OK=0
      else
        systemctl is-enabled --quiet playwright-anchor && BROWSER_ROLLBACK_OK=0
      fi

      # A previously active gateway must become genuinely ready again, not
      # merely enter systemd's active state. The gateway writes this ready file
      # only after its private Chromium/MCP process and Unix socket are usable.
      if [ "$OLD_MCP_ACTIVE" = "1" ]; then
        for _ in $(seq 1 60); do
          if systemctl is-active --quiet playwright-mcp && \
             [ -s /run/letyclaw-browser/ready ] && [ -S /run/letyclaw-browser-socket/gateway.sock ]; then
            break
          fi
          sleep 1
        done
        systemctl is-active --quiet playwright-mcp || BROWSER_ROLLBACK_OK=0
        [ -s /run/letyclaw-browser/ready ] || BROWSER_ROLLBACK_OK=0
        [ -S /run/letyclaw-browser-socket/gateway.sock ] || BROWSER_ROLLBACK_OK=0
      elif systemctl is-active --quiet playwright-mcp; then
        BROWSER_ROLLBACK_OK=0
      fi
      if [ "$OLD_PROXY_SOCKET_ACTIVE" = "1" ]; then
        systemctl is-active --quiet playwright-mcp-proxy.socket || BROWSER_ROLLBACK_OK=0
      elif systemctl is-active --quiet playwright-mcp-proxy.socket; then
        BROWSER_ROLLBACK_OK=0
      fi
      if [ "$OLD_PROXY_ACTIVE" = "1" ]; then
        systemctl is-active --quiet playwright-mcp-proxy.service || BROWSER_ROLLBACK_OK=0
      elif systemctl is-active --quiet playwright-mcp-proxy.service; then
        BROWSER_ROLLBACK_OK=0
      fi
      if [ "$OLD_ANCHOR_ACTIVE" = "1" ]; then
        systemctl is-active --quiet playwright-anchor || BROWSER_ROLLBACK_OK=0
      elif systemctl is-active --quiet playwright-anchor; then
        BROWSER_ROLLBACK_OK=0
      fi

      if [ "$BROWSER_ROLLBACK_OK" -eq 1 ]; then
        echo "Previous browser/MCP runtime restored and verified" >&2
      else
        echo "ERROR: previous browser/MCP runtime failed rollback verification" >&2
        if [ "${LETYCLAW_STOP_RUNTIME_ON_MCP_ROLLBACK_FAILURE:-0}" = "1" ]; then
          systemctl stop letyclaw-bot health-webhook >/dev/null 2>&1 || true
          echo "ERROR: bot and webhook stopped because browser compatibility is unproven" >&2
        fi
      fi
    fi
    rm -rf "$BROWSER_BACKUP"
    exit "$status"
  }
  trap rollback_browser_deploy EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  # Stop only for the profile copy and atomic unit swap. The old profile is
  # copied, not moved, so rollback can start the old service unchanged.
  systemctl disable --now playwright-anchor 2>/dev/null || true
  systemctl stop playwright-mcp-proxy.service playwright-mcp-proxy.socket playwright-mcp 2>/dev/null || true
  SKIP_SYSTEM_DEPS=1 \
    SKIP_RUNTIME_INSTALL=1 \
    PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
    BROWSER_STATE_DIR="$BROWSER_STATE_DIR" \
    VAULT_PATH="$VAULT_PATH" \
    bash "${PROJECT_ROOT}/scripts/setup-browser.sh"

  if [ -n "$LEGACY_BROWSER_SECRETS_SOURCE" ] && [ -f "$LEGACY_BROWSER_SECRETS_SOURCE" ]; then
    "$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/import-browser-secrets.js" \
      --source "$LEGACY_BROWSER_SECRETS_SOURCE" \
      --secrets "${BROWSER_STATE_DIR}/secrets.env" \
      --policy "${BROWSER_STATE_DIR}/secret-policy.json" \
      --backup "$LEGACY_BROWSER_SECRETS_BACKUP" \
      --receipt "$LEGACY_BROWSER_SECRETS_RECEIPT" \
      --owner-uid "$(id -u letyclaw-browser)" \
      --owner-gid "$(id -g letyclaw-browser)"
    MIGRATED_LEGACY_BROWSER_SECRETS=1
    # Rebuild the names-only index after importing values.
    SKIP_SYSTEM_DEPS=1 SKIP_RUNTIME_INSTALL=1 \
      PLAYWRIGHT_MCP_VERSION="$PLAYWRIGHT_MCP_VERSION" \
      BROWSER_STATE_DIR="$BROWSER_STATE_DIR" VAULT_PATH="$VAULT_PATH" \
      bash "${PROJECT_ROOT}/scripts/setup-browser.sh"
  fi

  cp "${PROJECT_ROOT}/systemd/playwright-mcp.service" /etc/systemd/system/playwright-mcp.service
  cp "${PROJECT_ROOT}/systemd/playwright-mcp-proxy.service" /etc/systemd/system/playwright-mcp-proxy.service
  cp "${PROJECT_ROOT}/systemd/playwright-mcp-proxy.socket" /etc/systemd/system/playwright-mcp-proxy.socket
  rm -f /etc/systemd/system/playwright-anchor.service
  GATEWAY_LINK_TMP="${GATEWAY_RELEASE_ROOT}/.current.$$"
  ln -s "$GATEWAY_RELEASE" "$GATEWAY_LINK_TMP"
  mv -Tf "$GATEWAY_LINK_TMP" "${GATEWAY_RELEASE_ROOT}/current"
  systemd-analyze verify \
    /etc/systemd/system/playwright-mcp.service \
    /etc/systemd/system/playwright-mcp-proxy.service \
    /etc/systemd/system/playwright-mcp-proxy.socket
  systemctl daemon-reload
  systemctl enable playwright-mcp playwright-mcp-proxy.socket
  systemctl is-enabled --quiet playwright-mcp
  systemctl is-enabled --quiet playwright-mcp-proxy.socket
  systemctl restart playwright-mcp
  systemctl restart playwright-mcp-proxy.socket
  systemctl is-active --quiet playwright-mcp-proxy.socket
  echo ""
  echo "Playwright gateway: private Unix socket + safe loopback HTTP proxy on ${PLAYWRIGHT_PORT}/mcp"

  BROWSER_READY="/run/letyclaw-browser/ready"
  for _ in $(seq 1 60); do
    if [ -s "$BROWSER_READY" ]; then break; fi
    sleep 1
  done
  if [ ! -s "$BROWSER_READY" ]; then
    echo "  Browser gateway: ✗ FAILED — private Chromium did not become ready"
    echo "  Check: systemctl status playwright-mcp"
    echo "  Check: journalctl -u playwright-mcp -n 100"
    exit 1
  fi
  test -S /run/letyclaw-browser-socket/gateway.sock
  test "$(stat -c %U:%G:%a /run/letyclaw-browser-socket/gateway.sock)" = "letyclaw-browser:letyclaw-browser-proxy:660"
  PROXY_LISTENER=$(ss -H -ltnp | awk '$4 == "127.0.0.1:3100" { print }')
  printf '%s\n' "$PROXY_LISTENER" | grep -Fq '127.0.0.1:3100'
  printf '%s\n' "$PROXY_LISTENER" | grep -Fq 'systemd'
  echo "  Browser gateway: ✓ (isolated identity + persistent context + heartbeat)"

  # Real smoke: browser launch + navigation + screenshot + a second sequential
  # HTTP client. `initialize` alone is a false green because Chromium launches
  # lazily and cannot detect profile locks, missing binaries, or output EACCES.
  PLAYWRIGHT_MCP_URL="http://localhost:${PLAYWRIGHT_PORT}/mcp" \
    PLAYWRIGHT_MCP_ARTIFACT_DIR="$BROWSER_ARTIFACT_DIR" \
    PLAYWRIGHT_MCP_WORKSPACE_ROOT="$VAULT_PATH" \
    PLAYWRIGHT_MCP_EXPECT_HEADFUL=1 \
    PLAYWRIGHT_GATEWAY_TOKEN="$PLAYWRIGHT_GATEWAY_TOKEN" \
    "$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/browser-smoke.js"
  systemctl is-active --quiet playwright-mcp-proxy.service
  sudo -u letyclaw test -r "${BROWSER_ARTIFACT_DIR}/letyclaw-browser-smoke-example.png"
  sudo -u letyclaw test -r "${BROWSER_ARTIFACT_DIR}/letyclaw-browser-smoke-example.pdf"
  echo "  PNG/PDF artifact delivery: ✓ (readable by letyclaw bot UID)"

  # Only remove the synced plaintext source after the new isolated browser has
  # launched and passed the real smoke. A root-only backup remains available.
  if [ "$MIGRATED_LEGACY_BROWSER_SECRETS" = "1" ]; then
    "$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/import-browser-secrets.js" \
      --remove-source-from-receipt \
      --source "$LEGACY_BROWSER_SECRETS_SOURCE" \
      --receipt "$LEGACY_BROWSER_SECRETS_RECEIPT"
    echo "Removed configured legacy plaintext browser credentials after protected import"
  fi

fi

# Run the system Claude CLI with an explicit home and PATH. This avoids writing
# the runtime user's MCP config into root's home and prevents an interactive
# NVM shell from changing which Node executes the CLI wrapper.
run_claude_for_user() {
  local account=$1
  shift
  if [ -z "$account" ]; then
    PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin" "$CLAUDE_BIN" "$@"
  else
    local account_home
    account_home=$(getent passwd "$account" | cut -d: -f6)
    [ -n "$account_home" ] || { echo "ERROR: no home found for $account" >&2; return 1; }
    sudo -u "$account" env \
      HOME="$account_home" \
      PATH="/root/.local/bin:/usr/local/bin:/usr/bin:/bin" \
      "$CLAUDE_BIN" "$@"
  fi
}

assert_email_read_only_config() {
  local account=$1 account_home config_path expected_uid actual_uid mode
  if [ -z "$account" ]; then
    account_home=$HOME
    expected_uid=$(id -u)
  else
    account_home=$(getent passwd "$account" | cut -d: -f6)
    expected_uid=$(id -u "$account")
  fi
  config_path="$account_home/.config/email-mcp/config.toml"
  [ -f "$config_path" ] && [ ! -L "$config_path" ] || {
    echo "ERROR: email MCP config must be a regular non-symlink file: $config_path" >&2
    return 1
  }
  actual_uid=$(stat -c %u "$config_path" 2>/dev/null || stat -f %u "$config_path")
  [ "$actual_uid" = "$expected_uid" ] || {
    echo "ERROR: email MCP config has the wrong owner: $config_path" >&2
    return 1
  }
  mode=$(stat -c %a "$config_path" 2>/dev/null || stat -f %Lp "$config_path")
  [ $((8#$mode & 8#077)) -eq 0 ] || {
    echo "ERROR: email MCP config must not be accessible by group or other users: $config_path" >&2
    return 1
  }
  awk '
    /^[[:space:]]*\[settings\][[:space:]]*(#.*)?$/ { in_settings = 1; next }
    /^[[:space:]]*\[/ { in_settings = 0 }
    in_settings && /^[[:space:]]*read_only[[:space:]]*=[[:space:]]*true[[:space:]]*(#.*)?$/ { safe = 1 }
    END { exit(safe ? 0 : 1) }
  ' "$config_path" || {
    echo "ERROR: email MCP requires [settings] read_only = true in $config_path" >&2
    return 1
  }
}

# Register MCP servers for a user.
register_for_user() {
  local account="$1"
  local label="$2"

  echo ""
  echo "Registering MCP servers for ${label}..."

  run_claude_for_user "$account" mcp remove --scope user letyclaw-tools 2>/dev/null || true
  run_claude_for_user "$account" mcp remove --scope user playwright 2>/dev/null || true
  run_claude_for_user "$account" mcp remove --scope user email 2>/dev/null || true
  run_claude_for_user "$account" mcp remove --scope user fli 2>/dev/null || true
  run_claude_for_user "$account" mcp remove --scope user alphavantage 2>/dev/null || true
  run_claude_for_user "$account" mcp remove --scope user amplitude 2>/dev/null || true

  run_claude_for_user "$account" mcp add --scope user --transport stdio letyclaw-tools -- \
    "$NODE_BIN" "${SERVER_PATH}"

  # Playwright MCP runs as a persistent streamable-HTTP server — browser stays
  # alive across Claude CLI invocations (tabs, forms, navigation persist).
  # The safe gateway serves /mcp (not /sse), requires its private bearer, and
  # rejects non-loopback Host headers before parsing the request body.
  # --header is variadic in Claude Code, so it must come after the positional
  # name and URL or it consumes both and reports "missing required argument".
  if [ "$LETYCLAW_ENABLE_BROWSER_MCP" = "1" ]; then
    run_claude_for_user "$account" mcp add --scope user --transport http playwright \
      "http://localhost:${PLAYWRIGHT_PORT}/mcp" \
      --header "Authorization: Bearer ${PLAYWRIGHT_GATEWAY_TOKEN}"
  fi

  # Optional third-party email MCP. Force its own read-only mode so SMTP,
  # mailbox mutation, draft-send, and scheduling tools are not registered.
  # Account aliases and credentials remain local to config.toml.
  if [ "$LETYCLAW_ENABLE_EMAIL_MCP" = "1" ]; then
    # Production needs email only in the bot account. Avoid copying mailbox
    # credentials into root's Claude profile merely for deploy-time convenience.
    if [ -n "$account" ] || ! id letyclaw >/dev/null 2>&1; then
      assert_email_read_only_config "$account"
      run_claude_for_user "$account" mcp add --scope user --transport stdio email -- \
        /usr/bin/env MCP_EMAIL_READ_ONLY=true \
        "$NPX_BIN" -y "@codefuturist/email-mcp@${EMAIL_MCP_VERSION}" stdio
    else
      echo "  Skipped email MCP for root; production email is scoped to the bot account"
    fi
  fi

  # Optional Google Flights search.
  if [ "$LETYCLAW_ENABLE_FLI_MCP" = "1" ]; then
    FLI_MCP_BIN=$(command -v fli-mcp)
    run_claude_for_user "$account" mcp add --scope user --transport stdio fli -- \
      "$FLI_MCP_BIN"
  fi

  # Alpha Vantage — stocks, forex, crypto, commodities, economic indicators.
  # Never put the key in registered argv: Claude prints stdio commands on
  # successful registration. The proxy reads protected runtime credentials and
  # redacts upstream HTTP errors before they reach Claude or CI/session logs.
  if [ "$LETYCLAW_ENABLE_MARKETDATA_MCP" = "1" ]; then
    run_claude_for_user "$account" mcp add --scope user --transport stdio alphavantage -- \
      "$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/marketdata-mcp-proxy.js"
  fi

  # Optional Amplitude product analytics (OAuth, remote HTTP).
  if [ "$LETYCLAW_ENABLE_AMPLITUDE_MCP" = "1" ]; then
    run_claude_for_user "$account" mcp add --scope user --transport http amplitude \
      "https://mcp.amplitude.com/mcp"
  fi

  echo "  Done: ${label}"
}

# Register for root (interactive / deploy use)
register_for_user "" "root"

# Register for letyclaw user (bot.ts runtime) if the user exists
if id letyclaw &>/dev/null; then
  register_for_user "letyclaw" "letyclaw (bot runtime)"
fi

if [ "$LETYCLAW_ENABLE_BROWSER_MCP" = "1" ]; then
  # The old profile was retained until the new gateway, smoke, and MCP client
  # registrations all succeeded. Move it out of the synced/model-readable vault
  # now; a root-only rollback copy remains without exposing cookies to Claude.
  LEGACY_PROFILE_SOURCE="${VAULT_PATH}/browser-profiles"
  if [ -e "$LEGACY_PROFILE_SOURCE" ]; then
    if [ -L "$LEGACY_PROFILE_SOURCE" ] || [ ! -d "$LEGACY_PROFILE_SOURCE" ]; then
      echo "ERROR: legacy browser profile is not a regular directory" >&2
      exit 1
    fi
    if find "$LEGACY_PROFILE_SOURCE" -xdev -type l -print -quit | grep -q .; then
      echo "ERROR: refusing to archive a legacy browser profile containing symlinks" >&2
      exit 1
    fi
    PROFILE_BACKUP_PARENT="/var/lib/letyclaw-browser-import-backup"
    install -d -o root -g root -m 0700 "$PROFILE_BACKUP_PARENT"
    PROFILE_BACKUP="${PROFILE_BACKUP_PARENT}/browser-profiles-$(date -u +%Y%m%dT%H%M%SZ)"
    if [ -e "$PROFILE_BACKUP" ]; then
      echo "ERROR: legacy browser profile backup already exists: $PROFILE_BACKUP" >&2
      exit 1
    fi
    mv "$LEGACY_PROFILE_SOURCE" "$PROFILE_BACKUP"
    echo "Archived legacy browser profile outside the synced vault"
  fi

  # MCP registration and legacy migration are part of the browser transaction:
  # disarm rollback only after the gateway, both client configs, and any one-time
  # profile move have all completed successfully.
  if [ -n "${BROWSER_BACKUP:-}" ]; then
    trap - EXIT INT TERM
    rm -rf "$BROWSER_BACKUP"
  fi
fi

echo ""
echo "Done! Required MCP server registered: letyclaw-tools"
echo "Optional MCPs: browser=$LETYCLAW_ENABLE_BROWSER_MCP email=$LETYCLAW_ENABLE_EMAIL_MCP flights=$LETYCLAW_ENABLE_FLI_MCP marketdata=$LETYCLAW_ENABLE_MARKETDATA_MCP amplitude=$LETYCLAW_ENABLE_AMPLITUDE_MCP"
echo ""
echo "Verify with: claude mcp list"
echo "Test with:   claude -p 'use self_info tool to show current context'"
echo ""
echo "letyclaw-tools (custom stdio server; startup log has exact tool count):"
echo "  Memory:    memory_search, memory_get, memory_save, memory_delete, memory_list,"
echo "             memory_related"
echo "  Sessions:  sessions_list, sessions_history, sessions_send, sessions_spawn,"
echo "             sessions_yield, subagents, session_status, session_search,"
echo "             sessions_browse, session_context"
echo "  Skills:    skills_list, skill_view"
echo "  Messaging: message_send, message_buttons, message_poll, message_react,"
echo "             message_typing, message_edit"
echo "  Cron:      cron_create, cron_list, cron_delete"
echo "  Media:     image, image_generate, tts"
echo "  Voice:     voice_call, voice_call_status"
echo "  Extras:    nodes_list, nodes_control, canvas_create, canvas_update,"
echo "             self_info, cross_agent_read"
echo ""
echo "playwright (browser automation, shared persistent HTTP context on :${PLAYWRIGHT_PORT}):"
echo "  browser_navigate, browser_click, browser_type, browser_snapshot,"
echo "  browser_take_screenshot, browser_fill_form, browser_select_option,"
echo "  browser_wait_for, browser_file_upload, browser_tabs, etc."
echo "  Browser tabs, form state, and authenticated sessions persist across messages."
echo ""
echo "email (optional read-only IMAP via @codefuturist/email-mcp@${EMAIL_MCP_VERSION}):"
echo "  Write/send tools are disabled with MCP_EMAIL_READ_ONLY=true"
echo "  Account aliases and credentials: ~/.config/email-mcp/config.toml"
echo ""
echo "fli (Google Flights search via pip:flights):"
echo "  search_flights — one-way/round-trip flight search with filters"
echo "  search_dates — cheapest dates across flexible date ranges"
echo ""
echo "alphavantage (market data via marketdata-mcp-server, requires ALPHA_VANTAGE_API_KEY):"
echo "  Progressive discovery: TOOL_LIST, TOOL_GET, TOOL_CALL"
echo "  80+ tools: stocks, forex, crypto, commodities, economic indicators, technicals"
echo ""
echo "amplitude (product analytics, remote HTTP + OAuth):"
echo "  search, query_chart, query_dataset, get_charts, get_dashboard,"
echo "  get_experiments, get_cohorts, get_event_properties, get_users,"
echo "  create_chart, create_dashboard, get_feedback_insights, etc."
echo "  First-time: run 'claude' then '/mcp' to complete OAuth"
