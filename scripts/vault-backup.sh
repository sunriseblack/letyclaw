#!/usr/bin/env bash
set -euo pipefail
umask 077

# Encrypted off-host backup of durable vault data.
#
# Safe production defaults:
#   - a dedicated rclone destination, rejecting configured shared/team drives
#     unless the operator explicitly accepts that retention boundary;
#   - public-key GPG encryption before bytes leave the host;
#   - no browser session cookies, connector tokens, node_modules, or rebuildable
#     SQLite indexes unless BACKUP_INCLUDE_RUNTIME_STATE=1 is explicit;
#   - checksum verification before bounded retention runs.
#
# Required for the default mode:
#   BACKUP_GPG_RECIPIENT=<fingerprint or key id available in BACKUP_GPG_HOMEDIR>
# The matching private key must be stored OFF the production host and tested
# with a restore drill. See docs/vault-backup.md.

VAULT_PATH="${VAULT_PATH:-/root/vault}"
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/letyclaw-vault-backup}"
RCLONE_CONFIG="${RCLONE_CONFIG:-$BACKUP_STATE_DIR/rclone.conf}"
RCLONE_CONFIG_SOURCE="${RCLONE_CONFIG_SOURCE:-/root/.config/rclone/rclone.conf}"
BACKUP_EXPECTED_UID="${BACKUP_EXPECTED_UID:-0}"
BACKUP_EXPECTED_GID="${BACKUP_EXPECTED_GID:-0}"
BACKUP_RCLONE_SOURCE_GROUP="${BACKUP_RCLONE_SOURCE_GROUP:-letyclaw}"
BACKUP_RCLONE_SOURCE_GID="${BACKUP_RCLONE_SOURCE_GID:-}"
BACKUP_RCLONE_DEST="${BACKUP_RCLONE_DEST:-gdrive:letyclaw-backups/vault}"
BACKUP_GPG_HOMEDIR="${BACKUP_GPG_HOMEDIR:-/etc/letyclaw-backup/gnupg}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
BACKUP_ENCRYPTION="${BACKUP_ENCRYPTION:-gpg}"
BACKUP_ALLOW_PLAINTEXT="${BACKUP_ALLOW_PLAINTEXT:-0}"
BACKUP_ALLOW_SHARED_DRIVE="${BACKUP_ALLOW_SHARED_DRIVE:-0}"
BACKUP_INCLUDE_RUNTIME_STATE="${BACKUP_INCLUDE_RUNTIME_STATE:-0}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_PRUNE="${BACKUP_PRUNE:-1}"
BACKUP_MAX_DELETE="${BACKUP_MAX_DELETE:-2}"
BACKUP_LOCK_FILE="${BACKUP_LOCK_FILE:-/run/lock/letyclaw-vault-backup.lock}"
BACKUP_DIR=""
SEED_TMP=""

die() {
  echo "ERROR: $*" >&2
  exit 1
}

cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$SEED_TMP" ] || rm -f "$SEED_TMP"
  [ -z "$BACKUP_DIR" ] || rm -rf "$BACKUP_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

path_metadata() {
  if stat -c '%u %g %a %h' "$1" >/dev/null 2>&1; then
    stat -c '%u %g %a %h' "$1"
  else
    stat -f '%u %g %Lp %l' "$1"
  fi
}

validate_owned_directory() {
  local path=$1 expected_mode=$2 label=$3 metadata uid gid mode links
  [ ! -L "$path" ] || die "$label must not be a symlink: $path"
  [ -d "$path" ] || die "$label is not a directory: $path"
  metadata=$(path_metadata "$path") || die "could not inspect $label: $path"
  read -r uid gid mode links <<<"$metadata"
  [ "$uid" = "$BACKUP_EXPECTED_UID" ] && [ "$gid" = "$BACKUP_EXPECTED_GID" ] ||
    die "$label must be owned by uid:gid ${BACKUP_EXPECTED_UID}:${BACKUP_EXPECTED_GID}"
  [ "$mode" = "$expected_mode" ] || die "$label must have mode $expected_mode (found $mode)"
}

validate_owned_file() {
  local path=$1 label=$2 require_mode=${3:-} metadata uid gid mode links permissions
  [ ! -L "$path" ] || die "$label must not be a symlink: $path"
  [ -f "$path" ] || die "$label is not a regular file: $path"
  metadata=$(path_metadata "$path") || die "could not inspect $label: $path"
  read -r uid gid mode links <<<"$metadata"
  [ "$uid" = "$BACKUP_EXPECTED_UID" ] && [ "$gid" = "$BACKUP_EXPECTED_GID" ] ||
    die "$label must be owned by uid:gid ${BACKUP_EXPECTED_UID}:${BACKUP_EXPECTED_GID}"
  [ "$links" = "1" ] || die "$label must have exactly one hard link"
  if [ -n "$require_mode" ]; then
    [ "$mode" = "$require_mode" ] || die "$label must have mode $require_mode (found $mode)"
  else
    permissions=$((8#$mode))
    (( (permissions & 0077) == 0 )) || die "$label must not be accessible by group or other users (found mode $mode)"
  fi
}

validate_canonical_config() {
  local path=$1 metadata uid gid mode links group_entry resolved_gid
  if [ -n "$BACKUP_RCLONE_SOURCE_GID" ]; then
    resolved_gid=$BACKUP_RCLONE_SOURCE_GID
  else
    [[ "$BACKUP_RCLONE_SOURCE_GROUP" =~ ^[a-z_][a-z0-9_-]*[$]?$ ]] ||
      die "invalid canonical rclone reader group"
    command -v getent >/dev/null || die "getent is required to resolve the canonical rclone reader group"
    group_entry=$(getent group "$BACKUP_RCLONE_SOURCE_GROUP") ||
      die "canonical rclone reader group does not exist: $BACKUP_RCLONE_SOURCE_GROUP"
    IFS=: read -r _ _ resolved_gid _ <<<"$group_entry"
  fi
  [[ "$resolved_gid" =~ ^[0-9]+$ ]] || die "canonical rclone reader gid is invalid"
  [ ! -L "$path" ] || die "canonical rclone config must not be a symlink: $path"
  [ -f "$path" ] || die "canonical rclone config is not a regular file: $path"
  metadata=$(path_metadata "$path") || die "could not inspect canonical rclone config: $path"
  read -r uid gid mode links <<<"$metadata"
  [ "$uid" = "$BACKUP_EXPECTED_UID" ] ||
    die "canonical rclone config must be owned by uid $BACKUP_EXPECTED_UID"
  [ "$links" = "1" ] || die "canonical rclone config must have exactly one hard link"
  [ "$mode" = "640" ] && [ "$gid" = "$resolved_gid" ] ||
    die "canonical rclone config must be mode 640 with approved reader gid $resolved_gid (found $mode uid:gid $uid:$gid)"
}

configured_remotes() {
  rclone listremotes --ask-password=false --config "$1"
}

remote_uses_shared_drive() {
  local config=$1 remote=$2
  awk -v section="[$remote]" '
    $0 == section { in_remote = 1; next }
    /^\[/ { in_remote = 0 }
    in_remote && /^[[:space:]]*team_drive[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]\r]+$/, "", value)
      if (length(value) > 0) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$config"
}

# rclone refreshes Google OAuth tokens by atomically rewriting its config. The
# canonical multi-purpose config is mounted read-only, so seed one private copy
# into systemd's root-only StateDirectory and then reuse that writable copy on
# every run. Never overwrite it from the source: doing so would roll back a
# refreshed token. Invalid existing state fails closed instead of being healed
# from a potentially attacker-controlled path.
prepare_rclone_config() {
  local expected_config="$BACKUP_STATE_DIR/rclone.conf" source_remotes
  [ "$RCLONE_CONFIG" = "$expected_config" ] ||
    die "RCLONE_CONFIG must be the StateDirectory config: $expected_config"
  validate_owned_directory "$BACKUP_STATE_DIR" 700 "backup StateDirectory"

  exec 8>"$BACKUP_STATE_DIR/.rclone-config.lock"
  flock -w 30 8 || die "could not lock backup rclone config"

  if [ -e "$RCLONE_CONFIG" ] || [ -L "$RCLONE_CONFIG" ]; then
    validate_owned_file "$RCLONE_CONFIG" "private rclone config" 600
    return
  fi

  [ "$RCLONE_CONFIG_SOURCE" != "$RCLONE_CONFIG" ] || die "rclone source and private config must differ"
  [ -r "$RCLONE_CONFIG_SOURCE" ] || die "canonical rclone config is not readable: $RCLONE_CONFIG_SOURCE"
  validate_canonical_config "$RCLONE_CONFIG_SOURCE"
  source_remotes=$(configured_remotes "$RCLONE_CONFIG_SOURCE") || die "canonical rclone config is invalid"
  grep -Fxq "${REMOTE_NAME}:" <<<"$source_remotes" ||
    die "canonical rclone config does not contain remote: $REMOTE_NAME"

  SEED_TMP=$(mktemp "$BACKUP_STATE_DIR/.rclone.conf.seed.XXXXXX")
  # mktemp creates the destination as the current service identity (root in
  # production); writing into that inode avoids ownership surprises across GNU
  # and BSD install implementations.
  cat "$RCLONE_CONFIG_SOURCE" >"$SEED_TMP"
  chmod 600 "$SEED_TMP"
  validate_owned_file "$SEED_TMP" "staged private rclone config" 600
  configured_remotes "$SEED_TMP" >/dev/null || die "staged rclone config is invalid"

  # A hard link gives us no-clobber atomic publication on the same filesystem.
  # If another initializer won the race, validate its result rather than
  # overwriting it. Removing the staging name leaves the published file at one
  # hard link, which validate_owned_file enforces.
  if ln "$SEED_TMP" "$RCLONE_CONFIG" 2>/dev/null; then
    rm -f "$SEED_TMP"
    SEED_TMP=""
  else
    rm -f "$SEED_TMP"
    SEED_TMP=""
  fi
  validate_owned_file "$RCLONE_CONFIG" "private rclone config" 600
}

validate_remote_destination() {
  [[ "$BACKUP_RCLONE_DEST" == *:* ]] || die "BACKUP_RCLONE_DEST must be remote:path"
  REMOTE_NAME="${BACKUP_RCLONE_DEST%%:*}"
  REMOTE_PATH="${BACKUP_RCLONE_DEST#*:}"
  [[ "$REMOTE_NAME" =~ ^[A-Za-z0-9_-]+$ ]] || die "invalid rclone remote name"
  [ -n "$REMOTE_PATH" ] || die "refusing to back up to a remote root"
  [[ "$REMOTE_PATH" =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid characters in rclone destination path"
  [[ "$REMOTE_PATH" != /* && "$REMOTE_PATH" != */ && "$REMOTE_PATH" != *//* ]] ||
    die "BACKUP_RCLONE_DEST path must be a normalized relative path"
  case "/$REMOTE_PATH/" in
    */../*|*/./*) die "BACKUP_RCLONE_DEST path traversal is not allowed" ;;
  esac
}

validate_config() {
  [ -d "$VAULT_PATH" ] || die "vault path is not a directory: $VAULT_PATH"
  command -v tar >/dev/null || die "tar is required"
  command -v sha256sum >/dev/null || die "sha256sum is required"
  command -v flock >/dev/null || die "flock is required"
  command -v rclone >/dev/null || die "rclone is required"
  validate_remote_destination

  is_positive_integer "$BACKUP_RETENTION_DAYS" || die "BACKUP_RETENTION_DAYS must be a positive integer"
  is_positive_integer "$BACKUP_MAX_DELETE" || die "BACKUP_MAX_DELETE must be a positive integer"
  case "$BACKUP_PRUNE" in 0|1) ;; *) die "BACKUP_PRUNE must be 0 or 1" ;; esac
  case "$BACKUP_INCLUDE_RUNTIME_STATE" in 0|1) ;; *) die "BACKUP_INCLUDE_RUNTIME_STATE must be 0 or 1" ;; esac
  case "$BACKUP_ALLOW_SHARED_DRIVE" in 0|1) ;; *) die "BACKUP_ALLOW_SHARED_DRIVE must be 0 or 1" ;; esac

  case "$BACKUP_ENCRYPTION" in
    gpg)
      command -v gpg >/dev/null || die "gpg is required for encrypted backups"
      [ -n "$BACKUP_GPG_RECIPIENT" ] || die "BACKUP_GPG_RECIPIENT is required; plaintext backup is disabled"
      [ -d "$BACKUP_GPG_HOMEDIR" ] || die "GPG home is missing: $BACKUP_GPG_HOMEDIR"
      GPG_KEY_INFO=$(gpg --homedir "$BACKUP_GPG_HOMEDIR" --batch --lock-never \
        --no-auto-check-trustdb --with-colons --list-keys "$BACKUP_GPG_RECIPIENT" 2>/dev/null) ||
        die "GPG recipient key is not available in $BACKUP_GPG_HOMEDIR"
      grep -q '^fpr:' <<<"$GPG_KEY_INFO" || die "GPG recipient has no usable fingerprint"
      ;;
    none)
      [ "$BACKUP_ALLOW_PLAINTEXT" = "1" ] ||
        die "plaintext backup requires explicit BACKUP_ALLOW_PLAINTEXT=1 (not recommended)"
      ;;
    *) die "BACKUP_ENCRYPTION must be gpg or none" ;;
  esac

  prepare_rclone_config
  CONFIGURED_REMOTES=$(configured_remotes "$RCLONE_CONFIG") || die "private rclone config is invalid"
  grep -Fxq "${REMOTE_NAME}:" <<<"$CONFIGURED_REMOTES" ||
    die "private rclone config does not contain remote: $REMOTE_NAME"
  if remote_uses_shared_drive "$RCLONE_CONFIG" "$REMOTE_NAME" && \
     [ "$BACKUP_ALLOW_SHARED_DRIVE" != "1" ]; then
    die "selected rclone remote uses a shared/team drive; set BACKUP_ALLOW_SHARED_DRIVE=1 only after a privacy and retention review"
  fi
}

validate_config
if [ "${1:-}" = "--check-config" ]; then
  echo "Backup configuration valid: destination=$BACKUP_RCLONE_DEST encryption=$BACKUP_ENCRYPTION retention=${BACKUP_RETENTION_DAYS}d"
  exit 0
fi
[ "$#" -eq 0 ] || die "usage: $0 [--check-config]"

LOCK_DIR=$(dirname "$BACKUP_LOCK_FILE")
[ -d "$LOCK_DIR" ] || die "backup lock directory is missing: $LOCK_DIR"
exec 9>"$BACKUP_LOCK_FILE"
flock -n 9 || die "another vault backup is already running"

BACKUP_DIR=$(mktemp -d /tmp/letyclaw-vault-backup.XXXXXX)
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
BASE_NAME="vault-${TIMESTAMP}.tar.gz"
VAULT_PARENT=$(dirname "$VAULT_PATH")
VAULT_NAME=$(basename "$VAULT_PATH")

TAR_EXCLUDES=()
if [ "$BACKUP_INCLUDE_RUNTIME_STATE" != "1" ]; then
  TAR_EXCLUDES+=(
    "--exclude=${VAULT_NAME}/browser-profiles"
    "--exclude=${VAULT_NAME}/.gdrive"
    "--exclude=${VAULT_NAME}/*/.gmail"
    "--exclude=${VAULT_NAME}/*/node_modules"
    "--exclude=${VAULT_NAME}/*/memory/search.sqlite"
    "--exclude=${VAULT_NAME}/*/memory/search.sqlite-wal"
    "--exclude=${VAULT_NAME}/*/memory/search.sqlite-shm"
  )
fi

echo "$(date -u --iso-8601=seconds): creating vault backup (runtime_state=$BACKUP_INCLUDE_RUNTIME_STATE)"
if [ "$BACKUP_ENCRYPTION" = "gpg" ]; then
  BACKUP_FILE="${BASE_NAME}.gpg"
  LOCAL_FILE="$BACKUP_DIR/$BACKUP_FILE"
  # Stream directly into GPG: no plaintext archive is ever written to disk.
  tar --one-file-system -czf - "${TAR_EXCLUDES[@]}" -C "$VAULT_PARENT" "$VAULT_NAME" |
    gpg --homedir "$BACKUP_GPG_HOMEDIR" --batch --yes --lock-never \
      --no-auto-check-trustdb --no-random-seed-file --trust-model always \
      --compress-algo none --recipient "$BACKUP_GPG_RECIPIENT" \
      --encrypt --output "$LOCAL_FILE"
else
  BACKUP_FILE="$BASE_NAME"
  LOCAL_FILE="$BACKUP_DIR/$BACKUP_FILE"
  tar --one-file-system -czf "$LOCAL_FILE" "${TAR_EXCLUDES[@]}" -C "$VAULT_PARENT" "$VAULT_NAME"
fi
test -s "$LOCAL_FILE" || die "backup archive is empty"

LOCAL_HASH=$(sha256sum "$LOCAL_FILE" | awk '{print tolower($1)}')
REMOTE_FILE="${BACKUP_RCLONE_DEST}/${BACKUP_FILE}"
echo "$(date -u --iso-8601=seconds): uploading encrypted archive to $BACKUP_RCLONE_DEST"
rclone copyto "$LOCAL_FILE" "$REMOTE_FILE" \
  --config "$RCLONE_CONFIG" --ask-password=false --checksum --immutable \
  --contimeout 15s --timeout 2m --retries 3 --low-level-retries 10

# Verify the remote object rather than trusting a successful upload exit alone.
REMOTE_HASH=$(rclone hashsum SHA-256 "$REMOTE_FILE" --config "$RCLONE_CONFIG" --ask-password=false |
  awk 'NR == 1 { print tolower($1) }')
[ -n "$REMOTE_HASH" ] || die "remote SHA-256 checksum is unavailable"
[ "$REMOTE_HASH" = "$LOCAL_HASH" ] || die "remote checksum does not match local archive"
echo "$(date -u --iso-8601=seconds): verified $BACKUP_FILE sha256=$LOCAL_HASH"

if [ "$BACKUP_PRUNE" = "1" ]; then
  # The destination is a dedicated folder and the include pattern is narrower
  # than all files. max-delete limits the blast radius of clock/config errors.
  rclone delete "$BACKUP_RCLONE_DEST" --config "$RCLONE_CONFIG" \
    --ask-password=false \
    --min-age "${BACKUP_RETENTION_DAYS}d" \
    --include 'vault-*.tar.gz.gpg' --include 'vault-*.tar.gz' \
    --max-delete "$BACKUP_MAX_DELETE"
  echo "$(date -u --iso-8601=seconds): retention complete (>${BACKUP_RETENTION_DAYS}d, max-delete=$BACKUP_MAX_DELETE)"
fi

echo "$(date -u --iso-8601=seconds): backup complete: $BACKUP_FILE"
