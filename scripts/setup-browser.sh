#!/bin/bash
# Prepare the pinned, isolated Playwright browser runtime.
set -euo pipefail

VAULT_PATH="${VAULT_PATH:-/root/vault}"
PLAYWRIGHT_MCP_VERSION="0.0.78"
RUNTIME_USER="${PLAYWRIGHT_RUNTIME_USER:-}"
if [ -z "$RUNTIME_USER" ] && [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = "Linux" ] && id letyclaw &>/dev/null; then
  if ! id letyclaw-browser &>/dev/null; then
    useradd --system --create-home --home-dir /var/lib/letyclaw-browser \
      --shell /usr/sbin/nologin --user-group letyclaw-browser
    echo "Created isolated system user: letyclaw-browser"
  fi
  RUNTIME_USER="letyclaw-browser"
fi
if [ -z "$RUNTIME_USER" ] && id letyclaw-browser &>/dev/null; then RUNTIME_USER="letyclaw-browser"; fi
RUNTIME_GROUP="${PLAYWRIGHT_RUNTIME_GROUP:-${RUNTIME_USER:-$(id -gn)}}"
BROWSER_NODE_BIN="${BROWSER_NODE_BIN:-}"
if [ -z "$BROWSER_NODE_BIN" ]; then
  if [ -x /usr/bin/node ]; then BROWSER_NODE_BIN=/usr/bin/node;
  else BROWSER_NODE_BIN=$(command -v node); fi
fi
BROWSER_NPM_BIN="${BROWSER_NPM_BIN:-}"
if [ -z "$BROWSER_NPM_BIN" ]; then
  if [ -x /usr/bin/npm ]; then BROWSER_NPM_BIN=/usr/bin/npm;
  else BROWSER_NPM_BIN=$(command -v npm); fi
fi

if [ -z "${BROWSER_STATE_DIR:-}" ]; then
  if [ -n "$RUNTIME_USER" ]; then BROWSER_STATE_DIR="/var/lib/letyclaw-browser";
  else BROWSER_STATE_DIR="${VAULT_PATH}/.browser-state"; fi
fi
if [ -z "${BROWSER_CACHE_DIR:-}" ]; then
  if [ -n "$RUNTIME_USER" ]; then BROWSER_CACHE_DIR="/var/cache/letyclaw-browser";
  else BROWSER_CACHE_DIR="${VAULT_PATH}/.browser-cache"; fi
fi
if [ -z "${BROWSER_SECRET_NAMES_FILE:-}" ]; then
  if id letyclaw &>/dev/null; then BROWSER_SECRET_NAMES_FILE="/var/lib/letyclaw-browser-secret-names";
  else BROWSER_SECRET_NAMES_FILE="${VAULT_PATH}/.browser-secret-names"; fi
fi

BROWSER_PROFILE_DIR="${BROWSER_STATE_DIR}/profile"
BROWSER_SECRETS_FILE="${BROWSER_STATE_DIR}/secrets.env"
BROWSER_SECRET_POLICY_FILE="${BROWSER_STATE_DIR}/secret-policy.json"
BROWSER_ARTIFACT_DIR="${VAULT_PATH}/browser-artifacts"
BROWSER_UPLOAD_DIR="${VAULT_PATH}/browser-uploads"
BROWSER_STAGE_DIR="${BROWSER_STATE_DIR}/staged-uploads"
LEGACY_PROFILE_DIR="${VAULT_PATH}/browser-profiles"
MIGRATION_MARKER="${BROWSER_STATE_DIR}/.legacy-profile-imported"
IMMUTABLE_RUNTIME=0
if [ -z "${BROWSER_RUNTIME_DIR:-}" ]; then
  if [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = "Linux" ] && [ -n "$RUNTIME_USER" ]; then
    BROWSER_RUNTIME_DIR="/var/lib/letyclaw-browser-runtime/mcp-${PLAYWRIGHT_MCP_VERSION}"
    IMMUTABLE_RUNTIME=1
  else
    BROWSER_RUNTIME_DIR="${BROWSER_CACHE_DIR}/runtime-mcp-${PLAYWRIGHT_MCP_VERSION}"
  fi
fi
MCP_INSTALL_DIR="${BROWSER_RUNTIME_DIR}/mcp"
BROWSER_BIN_DIR="${BROWSER_RUNTIME_DIR}/ms-playwright"
PREPARE_ONLY="${BROWSER_PREPARE_ONLY:-0}"
SKIP_RUNTIME_INSTALL="${SKIP_RUNTIME_INSTALL:-0}"
if [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = "Linux" ]; then
  SYSTEM_DEPS_MARKER="${BROWSER_SYSTEM_DEPS_MARKER:-/var/lib/letyclaw-browser-system-deps-${PLAYWRIGHT_MCP_VERSION}-v1}"
else
  SYSTEM_DEPS_MARKER="${BROWSER_SYSTEM_DEPS_MARKER:-${BROWSER_CACHE_DIR}/.system-deps-installed}"
fi

fail_if_symlink() {
  if [ -L "$1" ]; then
    echo "ERROR: refusing symlink in privileged browser setup: $1" >&2
    exit 1
  fi
}

require_real_directory() {
  fail_if_symlink "$1"
  if [ -e "$1" ] && [ ! -d "$1" ]; then
    echo "ERROR: expected directory: $1" >&2
    exit 1
  fi
}

runtime_home() {
  if [ -n "$RUNTIME_USER" ]; then getent passwd "$RUNTIME_USER" | cut -d: -f6;
  else printf '%s\n' "$HOME"; fi
}

run_as_browser_user() {
  local home
  home=$(runtime_home)
  if [ -n "$RUNTIME_USER" ] && [ "$(id -un)" != "$RUNTIME_USER" ]; then
    sudo -u "$RUNTIME_USER" env \
      HOME="$home" PATH="$(dirname "$BROWSER_NODE_BIN"):/usr/local/bin:/usr/bin:/bin" \
      PLAYWRIGHT_BROWSERS_PATH="$BROWSER_BIN_DIR" \
      npm_config_cache="${BROWSER_CACHE_DIR}/npm" \
      "$@"
  else
    HOME="$home" PLAYWRIGHT_BROWSERS_PATH="$BROWSER_BIN_DIR" \
      npm_config_cache="${BROWSER_CACHE_DIR}/npm" "$@"
  fi
}

prepare_owned_dir() {
  local path="$1" mode="$2" owner="$3" group="$4"
  require_real_directory "$path"
  if [ ! -d "$path" ]; then
    if [ "$(id -u)" -eq 0 ]; then install -d -o "$owner" -g "$group" -m "$mode" "$path";
    else install -d -m "$mode" "$path"; fi
  fi
}

echo "=== Playwright Browser Setup ==="
echo "Runtime user:     ${RUNTIME_USER:-$(id -un)}"
echo "Private state:    ${BROWSER_STATE_DIR}"
echo "Private cache:    ${BROWSER_CACHE_DIR}"
echo "Pinned runtime:   ${BROWSER_RUNTIME_DIR}"
echo "Artifact exchange: ${BROWSER_ARTIFACT_DIR}"
echo "Upload exchange:   ${BROWSER_UPLOAD_DIR}"
echo "Playwright MCP:    ${PLAYWRIGHT_MCP_VERSION}"

# The browser identity and cache are created before any network/package work.
prepare_owned_dir "$BROWSER_CACHE_DIR" 0700 "${RUNTIME_USER:-$(id -un)}" "$RUNTIME_GROUP"
prepare_owned_dir "${BROWSER_CACHE_DIR}/npm" 0700 "${RUNTIME_USER:-$(id -un)}" "$RUNTIME_GROUP"
run_as_browser_user chmod 0700 "$BROWSER_CACHE_DIR" "${BROWSER_CACHE_DIR}/npm"

verify_browser_runtime() {
  if [ ! -f "${MCP_INSTALL_DIR}/node_modules/@playwright/mcp/cli.js" ]; then
    echo "ERROR: pinned Playwright MCP CLI is missing from runtime" >&2
    exit 1
  fi
  installed_version=$(run_as_browser_user "$BROWSER_NODE_BIN" -p \
    "require('${MCP_INSTALL_DIR}/node_modules/@playwright/mcp/package.json').version")
  if [ "$installed_version" != "$PLAYWRIGHT_MCP_VERSION" ]; then
    echo "ERROR: immutable MCP runtime has unexpected version: $installed_version" >&2
    exit 1
  fi
  if ! find "$BROWSER_BIN_DIR" -mindepth 1 -maxdepth 1 -type d -name 'chromium-*' -print -quit | grep -q .; then
    echo "ERROR: pinned Chromium revision is missing from runtime" >&2
    exit 1
  fi
  if [ "$IMMUTABLE_RUNTIME" = "1" ]; then
    if find "$BROWSER_RUNTIME_DIR" -xdev ! -user root -print -quit | grep -q . || \
       find "$BROWSER_RUNTIME_DIR" -xdev \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
      echo "ERROR: browser runtime must be root-owned with no group/other writes" >&2
      exit 1
    fi
    while IFS= read -r -d '' runtime_link; do
      runtime_target=$(readlink -f "$runtime_link" 2>/dev/null || true)
      case "$runtime_target" in
        "${BROWSER_RUNTIME_DIR}"/*) ;;
        *) echo "ERROR: browser runtime symlink escapes its immutable release: $runtime_link" >&2; exit 1 ;;
      esac
    done < <(find "$BROWSER_RUNTIME_DIR" -xdev -type l -print0)
  fi
}

if [ "$SKIP_RUNTIME_INSTALL" != "1" ]; then
  require_real_directory "$BROWSER_RUNTIME_DIR"
  if [ ! -d "$BROWSER_RUNTIME_DIR" ]; then
    RUNTIME_PARENT=$(dirname "$BROWSER_RUNTIME_DIR")
    require_real_directory "$RUNTIME_PARENT"
    if [ "$IMMUTABLE_RUNTIME" = "1" ]; then
      install -d -o root -g root -m 0755 "$RUNTIME_PARENT"
      RUNTIME_STAGE="${BROWSER_RUNTIME_DIR}.stage.$$"
      rm -rf "$RUNTIME_STAGE"
      install -d -o "$RUNTIME_USER" -g "$RUNTIME_GROUP" -m 0700 "$RUNTIME_STAGE"
    else
      install -d -m 0750 "$RUNTIME_PARENT"
      RUNTIME_STAGE="${BROWSER_RUNTIME_DIR}.stage.$$"
      rm -rf "$RUNTIME_STAGE"
      install -d -m 0700 "$RUNTIME_STAGE"
    fi
    FINAL_RUNTIME_DIR="$BROWSER_RUNTIME_DIR"
    BROWSER_RUNTIME_DIR="$RUNTIME_STAGE"
    MCP_INSTALL_DIR="${BROWSER_RUNTIME_DIR}/mcp"
    BROWSER_BIN_DIR="${BROWSER_RUNTIME_DIR}/ms-playwright"
    echo "Installing pinned MCP and Chromium into staging..."
    if ! run_as_browser_user "$BROWSER_NPM_BIN" install \
      --prefix "$MCP_INSTALL_DIR" \
      --no-save --omit=dev --package-lock=false --ignore-scripts=false \
      "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"; then
      rm -rf "$RUNTIME_STAGE"
      exit 1
    fi
    run_as_browser_user "$BROWSER_NODE_BIN" \
      "${MCP_INSTALL_DIR}/node_modules/playwright/cli.js" install chromium
    if [ "$IMMUTABLE_RUNTIME" = "1" ]; then
      chown -hR root:root "$RUNTIME_STAGE"
      chmod -R u=rwX,go=rX "$RUNTIME_STAGE"
    fi
    BROWSER_RUNTIME_DIR="$FINAL_RUNTIME_DIR"
    MCP_INSTALL_DIR="${BROWSER_RUNTIME_DIR}/mcp"
    BROWSER_BIN_DIR="${BROWSER_RUNTIME_DIR}/ms-playwright"
    mv "$RUNTIME_STAGE" "$BROWSER_RUNTIME_DIR"
  fi
  verify_browser_runtime
  echo "Verified immutable browser runtime: MCP ${PLAYWRIGHT_MCP_VERSION}"

  if [ "${SKIP_SYSTEM_DEPS:-0}" != "1" ] && [ "$(uname -s)" = "Linux" ] && [ ! -f "$SYSTEM_DEPS_MARKER" ]; then
    echo "Installing Chromium system dependencies (first host setup)..."
    PLAYWRIGHT_BROWSERS_PATH="$BROWSER_BIN_DIR" \
      "$BROWSER_NODE_BIN" "${MCP_INSTALL_DIR}/node_modules/playwright/cli.js" install-deps chromium
    install -o root -g root -m 0644 /dev/null "$SYSTEM_DEPS_MARKER"
  fi
fi

CLI_PATH="${MCP_INSTALL_DIR}/node_modules/@playwright/mcp/cli.js"
if [ ! -f "$CLI_PATH" ]; then
  echo "ERROR: pinned Playwright MCP CLI is missing: $CLI_PATH" >&2
  exit 1
fi
run_as_browser_user "$BROWSER_NODE_BIN" "$CLI_PATH" --version

# Package downloads are deliberately complete before setup-mcp stops the old
# browser. Prepare-only mode makes routine deploys resilient to npm outages.
if [ "$PREPARE_ONLY" = "1" ]; then
  echo "Browser runtime prepared; live profile was not touched."
  exit 0
fi

if command -v systemctl &>/dev/null && systemctl is-active --quiet playwright-mcp; then
  echo "ERROR: state/profile setup requires playwright-mcp to be stopped; use scripts/setup-mcp.sh" >&2
  exit 1
fi

prepare_owned_dir "$BROWSER_STATE_DIR" 0700 "${RUNTIME_USER:-$(id -un)}" "$RUNTIME_GROUP"

# One-time ownership migration from the earlier same-UID implementation. Root
# never recursively chmods a tree containing symlinks.
if [ -n "$RUNTIME_USER" ] && [ "$(stat -c %U "$BROWSER_STATE_DIR")" != "$RUNTIME_USER" ]; then
  if find "$BROWSER_STATE_DIR" -xdev \( -type l -o \( -type f -links +1 \) \) -print -quit | grep -q .; then
    echo "ERROR: refusing ownership migration because browser state contains symlinks or hardlinks" >&2
    exit 1
  fi
  chown -hR "$RUNTIME_USER:$RUNTIME_GROUP" "$BROWSER_STATE_DIR"
fi
run_as_browser_user chmod 0700 "$BROWSER_STATE_DIR"

require_real_directory "$LEGACY_PROFILE_DIR"
require_real_directory "$BROWSER_PROFILE_DIR"
profile_has_data=0
if [ -d "$BROWSER_PROFILE_DIR" ] && [ -n "$(find "$BROWSER_PROFILE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  profile_has_data=1
fi

if [ -d "$LEGACY_PROFILE_DIR" ] && [ "$profile_has_data" = "0" ]; then
  if command -v systemctl &>/dev/null && systemctl is-active --quiet playwright-mcp; then
    echo "ERROR: refusing to import a live Chromium profile" >&2
    exit 1
  fi
  if find "$LEGACY_PROFILE_DIR" -xdev -type l -print -quit | grep -q .; then
    echo "ERROR: refusing legacy browser profile containing symlinks" >&2
    exit 1
  fi
  import_dir="${BROWSER_STATE_DIR}/.profile-import.$$"
  rm -rf "$import_dir"
  mkdir -m 0700 "$import_dir"
  if cp --help 2>/dev/null | grep -q -- --reflink; then
    cp -a --reflink=auto "$LEGACY_PROFILE_DIR"/. "$import_dir"/
  else
    cp -a "$LEGACY_PROFILE_DIR"/. "$import_dir"/
  fi
  if [ -n "$RUNTIME_USER" ]; then chown -hR "$RUNTIME_USER:$RUNTIME_GROUP" "$import_dir"; fi
  rmdir "$BROWSER_PROFILE_DIR" 2>/dev/null || true
  mv "$import_dir" "$BROWSER_PROFILE_DIR"
  install -m 0600 /dev/null "$MIGRATION_MARKER"
  if [ -n "$RUNTIME_USER" ]; then chown "$RUNTIME_USER:$RUNTIME_GROUP" "$MIGRATION_MARKER"; fi
  echo "Copied authenticated legacy profile into isolated state (source retained for rollback)"
elif [ -d "$LEGACY_PROFILE_DIR" ] && [ "$profile_has_data" = "1" ] && [ ! -f "$MIGRATION_MARKER" ]; then
  echo "ERROR: both legacy and isolated profiles contain data with no migration marker" >&2
  echo "Inspect both profiles, then create $MIGRATION_MARKER only after choosing the isolated copy." >&2
  exit 1
fi

prepare_owned_dir "$BROWSER_PROFILE_DIR" 0700 "${RUNTIME_USER:-$(id -un)}" "$RUNTIME_GROUP"
run_as_browser_user chmod 0700 "$BROWSER_PROFILE_DIR"
prepare_owned_dir "$BROWSER_STAGE_DIR" 0700 "${RUNTIME_USER:-$(id -un)}" "$RUNTIME_GROUP"
run_as_browser_user chmod 0700 "$BROWSER_STAGE_DIR"
fail_if_symlink "$BROWSER_SECRETS_FILE"
if [ -e "$BROWSER_SECRETS_FILE" ] && [ ! -f "$BROWSER_SECRETS_FILE" ]; then
  echo "ERROR: browser secrets path is not a regular file" >&2
  exit 1
fi
if [ ! -e "$BROWSER_SECRETS_FILE" ]; then
  if [ -n "$RUNTIME_USER" ] && [ "$(id -un)" != "$RUNTIME_USER" ]; then
    sudo -u "$RUNTIME_USER" install -m 0600 /dev/null "$BROWSER_SECRETS_FILE"
  else
    install -m 0600 /dev/null "$BROWSER_SECRETS_FILE"
  fi
fi
if [ -n "$RUNTIME_USER" ] && [ "$(stat -c %U "$BROWSER_SECRETS_FILE")" != "$RUNTIME_USER" ]; then
  chown "$RUNTIME_USER:$RUNTIME_GROUP" "$BROWSER_SECRETS_FILE"
fi
run_as_browser_user chmod 0600 "$BROWSER_SECRETS_FILE"
fail_if_symlink "$BROWSER_SECRET_POLICY_FILE"
if [ ! -e "$BROWSER_SECRET_POLICY_FILE" ]; then
  policy_tmp="${BROWSER_SECRET_POLICY_FILE}.tmp.$$"
  printf '{}\n' > "$policy_tmp"
  chmod 0600 "$policy_tmp"
  if [ -n "$RUNTIME_USER" ]; then chown "$RUNTIME_USER:$RUNTIME_GROUP" "$policy_tmp"; fi
  mv "$policy_tmp" "$BROWSER_SECRET_POLICY_FILE"
fi
if [ ! -f "$BROWSER_SECRET_POLICY_FILE" ]; then
  echo "ERROR: browser secret policy is not a regular file" >&2
  exit 1
fi
run_as_browser_user chmod 0600 "$BROWSER_SECRET_POLICY_FILE"

# Artifacts are browser-owned and only group-readable by letyclaw, so the model
# cannot plant output symlinks. Uploads are letyclaw-owned and only group-readable
# by the browser; the gateway O_NOFOLLOW-copies regular files into private
# staging before giving a path to upstream Playwright.
require_real_directory "$BROWSER_ARTIFACT_DIR"
require_real_directory "$BROWSER_UPLOAD_DIR"
if id letyclaw &>/dev/null && [ "$(id -u)" -eq 0 ]; then
  if [ ! -d "$BROWSER_ARTIFACT_DIR" ]; then
    install -d -o "$RUNTIME_USER" -g letyclaw -m 2750 "$BROWSER_ARTIFACT_DIR"
  fi
  if [ "$(stat -c %U:%G "$BROWSER_ARTIFACT_DIR")" != "$RUNTIME_USER:letyclaw" ]; then
    echo "ERROR: artifact exchange must be owned by $RUNTIME_USER:letyclaw" >&2
    exit 1
  fi
  # Only root can retain setgid when the owner deliberately is not a member of
  # the consumer group. Running chmod as the owner silently clears this bit.
  chmod 2750 "$BROWSER_ARTIFACT_DIR"

  if [ ! -d "$BROWSER_UPLOAD_DIR" ]; then
    install -d -o letyclaw -g "$RUNTIME_GROUP" -m 2750 "$BROWSER_UPLOAD_DIR"
  fi
  if [ "$(stat -c %U:%G "$BROWSER_UPLOAD_DIR")" != "letyclaw:$RUNTIME_GROUP" ]; then
    echo "ERROR: upload exchange must be owned by letyclaw:$RUNTIME_GROUP" >&2
    exit 1
  fi
  chmod 2750 "$BROWSER_UPLOAD_DIR"
else
  install -d -m 0750 "$BROWSER_ARTIFACT_DIR" "$BROWSER_UPLOAD_DIR"
fi

# Publish aliases only. The bot's UID can read this index but cannot traverse
# the private state directory or read the dotenv values/profile.
fail_if_symlink "$BROWSER_SECRET_NAMES_FILE"
names_tmp=$(mktemp "${BROWSER_SECRET_NAMES_FILE}.tmp.XXXXXX")
trap 'rm -f "$names_tmp"' EXIT
sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\1/p' \
  "$BROWSER_SECRETS_FILE" | sort -u > "$names_tmp"
if id letyclaw &>/dev/null && [ "$(id -u)" -eq 0 ]; then
  install -o root -g letyclaw -m 0640 "$names_tmp" "$BROWSER_SECRET_NAMES_FILE"
else
  install -m 0600 "$names_tmp" "$BROWSER_SECRET_NAMES_FILE"
fi
rm -f "$names_tmp"
trap - EXIT

echo "Prepared isolated profile, exchange directories, and names-only secret index."
