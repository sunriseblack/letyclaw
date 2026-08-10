#!/usr/bin/env bash
set -euo pipefail
umask 077

# Split the legacy application .env into least-privilege, service-specific
# environment files. Values are copied byte-for-byte and never sourced or
# printed, so shell syntax inside a secret cannot execute during deployment.

SOURCE_ENV="${SOURCE_ENV:-/etc/letyclaw-bot/env}"
SERVICE_ENV_ROOT="${SERVICE_ENV_ROOT:-/etc}"
SERVICE_ENV_UID="${SERVICE_ENV_UID:-0}"
SERVICE_ENV_GID="${SERVICE_ENV_GID:-0}"
SOURCE_ENV_UID="${SOURCE_ENV_UID:-0}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

path_metadata() {
  if stat -c '%u %a %h' "$1" >/dev/null 2>&1; then
    stat -c '%u %a %h' "$1"
  else
    stat -f '%u %Lp %l' "$1"
  fi
}

[[ "$SERVICE_ENV_UID" =~ ^[0-9]+$ && "$SERVICE_ENV_GID" =~ ^[0-9]+$ && "$SOURCE_ENV_UID" =~ ^[0-9]+$ ]] ||
  die "service/source uid and gid settings must be numeric"
validate_source_env() {
  local source_env=$1 source_uid source_mode source_links
  [ ! -L "$source_env" ] || die "source env must not be a symlink: $source_env"
  [ -f "$source_env" ] || die "source env is not a regular file: $source_env"
  read -r source_uid source_mode source_links <<<"$(path_metadata "$source_env")"
  [ "$source_uid" = "$SOURCE_ENV_UID" ] || die "source env has unexpected owner: $source_env"
  { [ "$source_mode" = 600 ] || [ "$source_mode" = 640 ]; } ||
    die "source env must have mode 600 or 640: $source_env"
  [ "$source_links" = 1 ] || die "source env must have exactly one hard link: $source_env"
}

copy_keys() {
  local source_env=$1 target_dir=$2 target_file=$3 required_keys=$4 tmp key count required_key line raw compact
  shift 4

  validate_source_env "$source_env"

  install -d -o "$SERVICE_ENV_UID" -g "$SERVICE_ENV_GID" -m 0700 "$target_dir"
  tmp=$(mktemp "$target_dir/.env.XXXXXX")
  trap 'rm -f "$tmp"' RETURN

  for key in "$@"; do
    count=$(grep -Ec "^${key}=" "$source_env" || true)
    [ "$count" -le 1 ] || { echo "ERROR: duplicate $key in $source_env" >&2; return 1; }
    if [ "$count" -eq 1 ]; then
      grep -E "^${key}=" "$source_env" >> "$tmp"
    fi
  done

  if [ -n "$required_keys" ]; then
    while IFS= read -r required_key; do
      line=$(grep -E "^${required_key}=" "$tmp" || true)
      raw=${line#*=}
      compact=${raw//[[:space:]]/}
      [ -n "$compact" ] && [ "$compact" != '""' ] && [ "$compact" != "''" ] || {
        echo "ERROR: required $required_key is missing or empty in $source_env" >&2
        return 1
      }
    done < <(tr ',' '\n' <<<"$required_keys")
  fi

  chown "$SERVICE_ENV_UID:$SERVICE_ENV_GID" "$tmp"
  chmod 0600 "$tmp"
  # Atomic publication in the root-only destination directory. Replacing a
  # stale symlink changes the directory entry itself and never follows it.
  mv -f "$tmp" "$target_file"
  tmp=""
  trap - RETURN
}

copy_keys \
  "$SOURCE_ENV" \
  "$SERVICE_ENV_ROOT/letyclaw-health-webhook" \
  "$SERVICE_ENV_ROOT/letyclaw-health-webhook/env" \
  HEALTH_WEBHOOK_SECRET \
  HEALTH_WEBHOOK_SECRET HEALTH_WEBHOOK_PORT HEALTH_WEBHOOK_MAX_BODY_BYTES VAULT_PATH \
  VAPI_WEBHOOK_SECRET VAPI_ASSISTANT_ID VAPI_SERVER_URL VAPI_SERVER_CREDENTIAL_ID VAPI_INBOUND_TOPIC_ID

# The optional legacy relay stays disabled in normal production, but retain a
# minimal environment so a future explicitly approved rollout cannot regain
# access to the bot's Telegram, Vapi, Gmail, or connector credentials.
copy_keys \
  "$SOURCE_ENV" \
  "$SERVICE_ENV_ROOT/letyclaw-voice-relay" \
  "$SERVICE_ENV_ROOT/letyclaw-voice-relay/env" \
  "" \
  ANTHROPIC_API_KEY VOICE_DEFAULT_MODEL

echo "Provisioned least-privilege service environments"
