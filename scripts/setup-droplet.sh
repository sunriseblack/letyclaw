#!/usr/bin/env bash
set -euo pipefail

# Bootstrap the host prerequisites shared by a default Letyclaw deployment.
# Optional integrations are opt-in so a fresh install does not acquire browser,
# sync, analytics, or firewall policy the operator did not request.
PROJECT_ROOT="${LETYCLAW_PROJECT_ROOT:-/root/letyclaw}"
VAULT_PATH="${VAULT_PATH:-/root/vault}"
RUNTIME_USER="${LETYCLAW_RUNTIME_USER:-letyclaw}"
INSTALL_OBSIDIAN_HEADLESS="${INSTALL_OBSIDIAN_HEADLESS:-0}"
INSTALL_UV="${INSTALL_UV:-0}"
CONFIGURE_UFW="${CONFIGURE_UFW:-0}"

for flag in INSTALL_OBSIDIAN_HEADLESS INSTALL_UV CONFIGURE_UFW; do
  case "${!flag}" in
    0|1) ;;
    *) echo "ERROR: $flag must be 0 or 1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
else
  command -v sudo >/dev/null 2>&1 || {
    echo "ERROR: run as root or install sudo" >&2
    exit 1
  }
  SUDO=(sudo)
fi

echo "=== Letyclaw host setup ==="
echo "Project: $PROJECT_ROOT"
echo "Vault:   $VAULT_PATH"
echo "User:    $RUNTIME_USER"

# Production units deliberately use distro-stable absolute paths. Do not accept
# an interactive NVM shell as proof that the service runtime exists.
SYSTEM_NODE=/usr/bin/node
SYSTEM_NPM=/usr/bin/npm
SYSTEM_CLAUDE=/usr/bin/claude
node_major=0
if [ -x "$SYSTEM_NODE" ]; then
  node_major=$($SYSTEM_NODE --version | sed -E 's/^v([0-9]+).*/\1/')
fi
if ! [[ "$node_major" =~ ^[0-9]+$ ]] || [ "$node_major" -lt 22 ]; then
  echo "Installing Node.js 22 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | "${SUDO[@]}" bash -
  "${SUDO[@]}" apt-get install -y nodejs
else
  echo "System Node.js is compatible: $($SYSTEM_NODE --version)"
fi
[ -x "$SYSTEM_NODE" ] && [ -x "$SYSTEM_NPM" ] || {
  echo "ERROR: NodeSource installation did not provide /usr/bin/node and /usr/bin/npm" >&2
  exit 1
}
node_major=$($SYSTEM_NODE --version | sed -E 's/^v([0-9]+).*/\1/')
if ! [[ "$node_major" =~ ^[0-9]+$ ]] || [ "$node_major" -lt 22 ]; then
  echo "ERROR: /usr/bin/node must be Node.js 22 or later" >&2
  exit 1
fi

echo "Installing/updating Claude Code CLI..."
"${SUDO[@]}" "$SYSTEM_NPM" install --global --prefix /usr @anthropic-ai/claude-code
[ -x "$SYSTEM_CLAUDE" ] || {
  echo "ERROR: Claude Code installation did not provide /usr/bin/claude" >&2
  exit 1
}

if [ "$INSTALL_OBSIDIAN_HEADLESS" = "1" ]; then
  echo "Installing Obsidian Headless..."
  "${SUDO[@]}" "$SYSTEM_NPM" install --global --prefix /usr obsidian-headless
fi

if [ "$INSTALL_UV" = "1" ]; then
  echo "Installing Python/uv for opted-in Python MCP integrations..."
  "${SUDO[@]}" apt-get install -y python3 python3-venv
  if ! command -v uvx >/dev/null 2>&1; then
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
fi

if ! id "$RUNTIME_USER" >/dev/null 2>&1; then
  "${SUDO[@]}" useradd --system --create-home --home-dir "/home/$RUNTIME_USER" \
    --shell /usr/sbin/nologin --user-group "$RUNTIME_USER"
fi
"${SUDO[@]}" install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0700 "$VAULT_PATH"
"${SUDO[@]}" install -d -o "$RUNTIME_USER" -g "$RUNTIME_USER" -m 0700 \
  "$PROJECT_ROOT/sessions" "$PROJECT_ROOT/logs"

if [ "$CONFIGURE_UFW" = "1" ]; then
  echo "Applying the opt-in UFW web-host policy..."
  "${SUDO[@]}" apt-get install -y ufw
  "${SUDO[@]}" ufw allow 22/tcp
  "${SUDO[@]}" ufw allow 80/tcp
  "${SUDO[@]}" ufw allow 443/tcp
  "${SUDO[@]}" ufw --force enable
fi

echo ""
echo "=== Host setup complete ==="
echo "Next steps:"
echo "  1. Authenticate Claude Code for $RUNTIME_USER."
echo "  2. Copy config/letyclaw.example.yaml to config/letyclaw.yaml and edit it."
echo "  3. Create /etc/letyclaw-bot/env from .env.example (mode 0600)."
echo "  4. Run npm ci && npm run build && bash scripts/deploy-agents.sh."
echo "  5. Follow DEPLOY.md before enabling any optional service."
