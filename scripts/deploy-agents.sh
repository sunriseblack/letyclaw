#!/usr/bin/env bash
set -euo pipefail

VAULT_PATH="${VAULT_PATH:-/root/vault}"
REPO_PATH="${REPO_PATH:-/root/letyclaw}"
LETYCLAW_ENABLE_HEALTH_WEBHOOK="${LETYCLAW_ENABLE_HEALTH_WEBHOOK:-0}"
LETYCLAW_ENABLE_CONNECTORS="${LETYCLAW_ENABLE_CONNECTORS:-0}"
LETYCLAW_ENABLE_BROWSER_MCP="${LETYCLAW_ENABLE_BROWSER_MCP:-1}"
LETYCLAW_INSTRUCTION_MODE="${LETYCLAW_INSTRUCTION_MODE:-auto}"

for feature_flag in LETYCLAW_ENABLE_HEALTH_WEBHOOK LETYCLAW_ENABLE_CONNECTORS LETYCLAW_ENABLE_BROWSER_MCP; do
  case "${!feature_flag}" in
    0|1) ;;
    *) echo "ERROR: $feature_flag must be 0 or 1" >&2; exit 1 ;;
  esac
done
case "$LETYCLAW_INSTRUCTION_MODE" in
  auto|source|unified) ;;
  *) echo "ERROR: LETYCLAW_INSTRUCTION_MODE must be auto, source, or unified" >&2; exit 1 ;;
esac

# setup-droplet.sh and the checked-in systemd units share one production
# runtime contract. Fail before mutating users, vault instructions, or units if
# an interactive NVM shell is masking a broken system service installation.
[ -x /usr/bin/node ] || { echo "ERROR: /usr/bin/node is missing; run scripts/setup-droplet.sh" >&2; exit 1; }
[ -x /usr/bin/claude ] || { echo "ERROR: /usr/bin/claude is missing; run scripts/setup-droplet.sh" >&2; exit 1; }
SYSTEM_NODE_MAJOR=$(/usr/bin/node --version | sed -E 's/^v([0-9]+).*/\1/')
if ! [[ "$SYSTEM_NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$SYSTEM_NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: /usr/bin/node must be Node.js 22 or later" >&2
  exit 1
fi
if grep -Rqs '/root/.nvm' "$REPO_PATH/systemd"; then
  echo "ERROR: systemd units drifted from the /usr/bin Node/Claude runtime contract" >&2
  exit 1
fi
RUNTIME_DRIFT=$(grep -RhE '^ExecStart(Pre|Post)?=.*node([[:space:]]|$)' \
  "$REPO_PATH/systemd" 2>/dev/null | grep -Fv '/usr/bin/node' || true)
if [ -n "$RUNTIME_DRIFT" ]; then
  echo "ERROR: a systemd ExecStart command uses Node outside /usr/bin/node:" >&2
  echo "$RUNTIME_DRIFT" >&2
  exit 1
fi
grep -Fqx 'ExecStart=/usr/bin/node dist/bot.js' "$REPO_PATH/systemd/letyclaw-bot.service" || {
  echo "ERROR: letyclaw-bot.service does not use /usr/bin/node" >&2
  exit 1
}
grep -Fqx 'Environment=CLAUDE_PATH=/usr/bin/claude' "$REPO_PATH/systemd/letyclaw-bot.service" || {
  echo "ERROR: letyclaw-bot.service does not use /usr/bin/claude" >&2
  exit 1
}

# The internet-facing webhook must not share the bot's UID: same-UID processes
# can inspect each other's /proc environment despite ProtectProc=invisible.
if [ "$LETYCLAW_ENABLE_HEALTH_WEBHOOK" = "1" ] && ! id letyclaw-webhook &>/dev/null; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin letyclaw-webhook
  echo "Created isolated system user: letyclaw-webhook"
fi

# Browser automation has a separate identity from the bot/Claude process. This
# prevents browser profile cookies, dotenv secrets, and either process's /proc
# environment from being readable across the trust boundary.
if [ "$LETYCLAW_ENABLE_BROWSER_MCP" = "1" ] && ! id letyclaw-browser &>/dev/null; then
  useradd --system --create-home --home-dir /var/lib/letyclaw-browser \
    --shell /usr/sbin/nologin --user-group letyclaw-browser
  echo "Created isolated system user: letyclaw-browser"
fi
if [ "$LETYCLAW_ENABLE_BROWSER_MCP" = "1" ] && \
   id -nG letyclaw-browser | tr ' ' '\n' | grep -qx letyclaw; then
  gpasswd -d letyclaw-browser letyclaw >/dev/null
fi
echo "=== Deploying Letyclaw ==="
echo "From: $REPO_PATH/agents/"
echo "To:   $VAULT_PATH/"
echo ""

# Prefer the optional advanced layout when it is complete. The public setup
# instead generates a shared file plus one isolated file per configured domain.
# Both layouts preserve the runtime invariant that bot.ts appends only the
# active domain's rules.
SRC="$REPO_PATH/agents/source"
UNIFIED_SRC="$REPO_PATH/agents/unified"
OUT="$VAULT_PATH/CLAUDE.md"
SHARED_TOOLS="$REPO_PATH/agents/shared/TOOLS.md"
DOMAIN_DST="$VAULT_PATH/.letyclaw/domains"
SOURCE_READY=1
UNIFIED_READY=1

for f in IDENTITY.md SOUL.md USER.md AGENTS.md; do
  [ -s "$SRC/$f" ] || SOURCE_READY=0
done
[ -d "$SRC/domains" ] && find "$SRC/domains" -maxdepth 1 -type f -name '*.md' -print -quit | grep -q . \
  || SOURCE_READY=0
[ -s "$UNIFIED_SRC/CLAUDE.md" ] || UNIFIED_READY=0
[ -d "$UNIFIED_SRC/domains" ] && find "$UNIFIED_SRC/domains" -maxdepth 1 -type f -name '*.md' -print -quit | grep -q . \
  || UNIFIED_READY=0
[ -s "$SHARED_TOOLS" ] || {
  echo "ERROR: shared tool contract is missing: $SHARED_TOOLS" >&2
  exit 1
}

case "$LETYCLAW_INSTRUCTION_MODE" in
  auto)
    if [ "$SOURCE_READY" -eq 1 ]; then
      INSTRUCTION_MODE=source
    elif [ "$UNIFIED_READY" -eq 1 ]; then
      INSTRUCTION_MODE=unified
    else
      echo "ERROR: no complete agent instruction layout is ready" >&2
      echo "Expected either agents/source/{IDENTITY,SOUL,USER,AGENTS}.md plus agents/source/domains/*.md," >&2
      echo "or generated agents/unified/CLAUDE.md plus agents/unified/domains/*.md." >&2
      echo "Run the setup wizard or instruction generator, review the output, then deploy again." >&2
      exit 1
    fi
    ;;
  source)
    [ "$SOURCE_READY" -eq 1 ] || {
      echo "ERROR: LETYCLAW_INSTRUCTION_MODE=source requires the complete agents/source layout" >&2
      exit 1
    }
    INSTRUCTION_MODE=source
    ;;
  unified)
    [ "$UNIFIED_READY" -eq 1 ] || {
      echo "ERROR: LETYCLAW_INSTRUCTION_MODE=unified requires generated agents/unified/CLAUDE.md and agents/unified/domains/*.md" >&2
      exit 1
    }
    INSTRUCTION_MODE=unified
    ;;
esac

if [ "$INSTRUCTION_MODE" = "source" ]; then
  DOMAIN_SRC="$SRC/domains"
else
  DOMAIN_SRC="$UNIFIED_SRC/domains"
fi

# Treat the selected domain catalog as the source of truth. Deployments may
# define any domain names; the public release assumes no personal/work taxonomy.
DOMAIN_NAMES=()
DOMAIN_FILES=("$DOMAIN_SRC"/*.md)
for domain_file in "${DOMAIN_FILES[@]}"; do
  domain_name=${domain_file##*/}
  domain_name=${domain_name%.md}
  if [[ ! "$domain_name" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "ERROR: invalid domain filename: $domain_file" >&2
    exit 1
  fi
  DOMAIN_NAMES+=("$domain_name")
done
if [ "${#DOMAIN_NAMES[@]}" -eq 0 ]; then
  echo "ERROR: no domain files found in $DOMAIN_SRC" >&2
  exit 1
fi

mkdir -p "$VAULT_PATH"
OUT_STAGE=$(mktemp "$VAULT_PATH/.CLAUDE.md.stage.XXXXXX")
trap 'rm -f "$OUT_STAGE"' EXIT INT TERM
if [ "$INSTRUCTION_MODE" = "source" ]; then
  # Order: IDENTITY → SOUL → USER → AGENTS → shared TOOLS.
  {
    echo "<!-- BUILT BY scripts/deploy-agents.sh from agents/source/. DO NOT EDIT. -->"
    echo "<!-- Shared source files only: IDENTITY.md, SOUL.md, USER.md, AGENTS.md, TOOLS.md -->"
    echo ""
    for f in IDENTITY.md SOUL.md USER.md AGENTS.md; do
      cat "$SRC/$f"
      echo ""
      echo "---"
      echo ""
    done
    cat "$SHARED_TOOLS"
    echo ""
  } > "$OUT_STAGE"
  ROLE_COUNT=4
else
  cp "$UNIFIED_SRC/CLAUDE.md" "$OUT_STAGE"
  ROLE_COUNT=0
fi
if [ ! -s "$OUT_STAGE" ]; then
  echo "ERROR: staged CLAUDE.md is empty" >&2
  exit 1
fi
if id letyclaw &>/dev/null; then chown root:letyclaw "$OUT_STAGE"; fi
chmod 640 "$OUT_STAGE"
mv "$OUT_STAGE" "$OUT"
trap - EXIT INT TERM

# Stage the complete domain catalog on the vault filesystem, verify it, then
# swap atomically. This is a parity/recovery mirror; bot.ts prefers the reviewed
# repository copy, and the service mounts both instruction surfaces read-only.
DOMAIN_PARENT=$(dirname "$DOMAIN_DST")
mkdir -p "$DOMAIN_PARENT"
DOMAIN_STAGE=$(mktemp -d "$DOMAIN_PARENT/.domains-stage.XXXXXX")
DOMAIN_OLD="$DOMAIN_PARENT/.domains-old.$$"
for f in "$DOMAIN_SRC"/*.md; do
  [ -f "$f" ] || continue
  cp "$f" "$DOMAIN_STAGE/$(basename "$f")"
done
DOMAIN_COUNT=$(find "$DOMAIN_SRC" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')
DEPLOYED_DOMAIN_COUNT=$(find "$DOMAIN_STAGE" -maxdepth 1 -type f -name '*.md' | wc -l | tr -d ' ')
if [ "$DOMAIN_COUNT" -eq 0 ] || [ "$DEPLOYED_DOMAIN_COUNT" -ne "$DOMAIN_COUNT" ]; then
  echo "ERROR: domain deploy verification failed (expected=$DOMAIN_COUNT deployed=$DEPLOYED_DOMAIN_COUNT)" >&2
  rm -rf "$DOMAIN_STAGE"
  exit 1
fi
while IFS= read -r -d '' domain_file; do
  base=$(basename "$domain_file")
  if ! cmp -s "$domain_file" "$DOMAIN_STAGE/$base"; then
    echo "ERROR: staged domain mismatch: $base" >&2
    rm -rf "$DOMAIN_STAGE"
    exit 1
  fi
done < <(find "$DOMAIN_SRC" -maxdepth 1 -type f -name '*.md' -print0)
if id letyclaw &>/dev/null; then
  chown -R root:letyclaw "$DOMAIN_STAGE"
fi
find "$DOMAIN_STAGE" -type d -exec chmod 750 {} +
find "$DOMAIN_STAGE" -type f -exec chmod 640 {} +
restore_domains() {
  status=$?
  trap - EXIT INT TERM
  rm -rf "$DOMAIN_STAGE"
  if [ -d "$DOMAIN_OLD" ] && [ ! -e "$DOMAIN_DST" ]; then
    mv "$DOMAIN_OLD" "$DOMAIN_DST"
  fi
  exit "$status"
}
trap restore_domains EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
if [ -e "$DOMAIN_DST" ]; then mv "$DOMAIN_DST" "$DOMAIN_OLD"; fi
mv "$DOMAIN_STAGE" "$DOMAIN_DST"
rm -rf "$DOMAIN_OLD"
trap - EXIT INT TERM

if [ "$INSTRUCTION_MODE" = "source" ]; then
  echo "  Built: shared CLAUDE.md from $ROLE_COUNT advanced role files + TOOLS.md → $VAULT_PATH/"
else
  echo "  Deployed: generated public CLAUDE.md → $VAULT_PATH/"
fi
echo "  Deployed: $DEPLOYED_DOMAIN_COUNT routed domain file(s) → $DOMAIN_DST/"

if [ -f "$SHARED_TOOLS" ]; then
  cp "$SHARED_TOOLS" "$VAULT_PATH/TOOLS.md"
  echo "  Deployed: TOOLS.md compatibility copy → $VAULT_PATH/"
fi

# Cleanup stale per-domain AGENTS.md files left over from the pre-source layout.
# These were never auto-loaded by Claude CLI on bot spawn, so removing them is
# a no-op behaviorally — but reduces drift confusion for anyone reading the vault.
for d in "${DOMAIN_NAMES[@]}"; do
  if [ -f "$VAULT_PATH/$d/AGENTS.md" ]; then
    rm -f "$VAULT_PATH/$d/AGENTS.md"
    echo "  Removed: $VAULT_PATH/$d/AGENTS.md (stale)"
  fi
done

# Deploy skills (Claude Code slash commands available to letyclaw)
SKILLS_SRC="$REPO_PATH/.claude/skills"
SKILLS_DST="$VAULT_PATH/.claude/skills"
if [ -d "$SKILLS_SRC" ]; then
  # Skills are directory packages (`name/SKILL.md`), not flat markdown files.
  # Stage on the vault filesystem, verify, then swap. Seed from the current
  # destination so live-only local skills are preserved; repo packages win.
  SKILLS_PARENT=$(dirname "$SKILLS_DST")
  mkdir -p "$SKILLS_PARENT"
  SKILLS_STAGE=$(mktemp -d "$SKILLS_PARENT/.skills-stage.XXXXXX")
  SKILLS_OLD="$SKILLS_PARENT/.skills-old.$$"
  if [ -d "$SKILLS_DST" ]; then
    cp -a "$SKILLS_DST"/. "$SKILLS_STAGE"/
  fi
  cp -R "$SKILLS_SRC"/. "$SKILLS_STAGE"/
  # Remove legacy flat copies for skills that now have directory packages.
  for skill_file in "$SKILLS_SRC"/*/SKILL.md; do
    [ -f "$skill_file" ] || continue
    rm -f "$SKILLS_STAGE/$(basename "$(dirname "$skill_file")").md"
  done
  EXPECTED_SKILLS=$(find "$SKILLS_SRC" -type f -name SKILL.md | wc -l | tr -d ' ')
  DEPLOYED_SKILLS=$(find "$SKILLS_STAGE" -type f -name SKILL.md | wc -l | tr -d ' ')
  if [ "$EXPECTED_SKILLS" -eq 0 ] || [ "$DEPLOYED_SKILLS" -lt "$EXPECTED_SKILLS" ]; then
    echo "ERROR: skill deploy verification failed (expected=$EXPECTED_SKILLS deployed=$DEPLOYED_SKILLS)" >&2
    rm -rf "$SKILLS_STAGE"
    exit 1
  fi
  while IFS= read -r -d '' skill_file; do
    rel=${skill_file#"$SKILLS_SRC"/}
    if [ ! -f "$SKILLS_STAGE/$rel" ] || ! cmp -s "$skill_file" "$SKILLS_STAGE/$rel"; then
      echo "ERROR: staged skill mismatch: $rel" >&2
      rm -rf "$SKILLS_STAGE"
      exit 1
    fi
  done < <(find "$SKILLS_SRC" -type f -name SKILL.md -print0)

  # mktemp creates the staging root as root:root 0700. Normalize the complete
  # tree before the rename so the bot never observes an unreadable live skills
  # directory if this script is interrupted immediately after the swap.
  if id letyclaw &>/dev/null; then
    chown -R root:letyclaw "$SKILLS_STAGE"
  fi
  find "$SKILLS_STAGE" -type d -exec chmod 750 {} +
  find "$SKILLS_STAGE" -type f -exec chmod 640 {} +

  restore_skills() {
    status=$?
    trap - EXIT INT TERM
    rm -rf "$SKILLS_STAGE"
    if [ -d "$SKILLS_OLD" ] && [ ! -e "$SKILLS_DST" ]; then
      mv "$SKILLS_OLD" "$SKILLS_DST"
    fi
    exit "$status"
  }
  trap restore_skills EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [ -e "$SKILLS_DST" ]; then mv "$SKILLS_DST" "$SKILLS_OLD"; fi
  mv "$SKILLS_STAGE" "$SKILLS_DST"
  rm -rf "$SKILLS_OLD"
  trap - EXIT INT TERM
  echo "  Deployed: $DEPLOYED_SKILLS skill package(s) → $SKILLS_DST/"
fi

# Ensure per-domain directories exist (for memory, data files)
# Deploy Obsidian Bases dashboards per domain
BASES_SRC="$REPO_PATH/bases"
for domain in "${DOMAIN_NAMES[@]}"; do
  mkdir -p "$VAULT_PATH/$domain/memory"
  echo "  Ensured: $VAULT_PATH/$domain/memory/"

  if [ -f "$BASES_SRC/memory-dashboard.base" ]; then
    sed "s/{{DOMAIN}}/$domain/g" "$BASES_SRC/memory-dashboard.base" \
      > "$VAULT_PATH/$domain/Memory Dashboard.base"
    echo "  Deployed: $domain/Memory Dashboard.base"
  fi
done

# Fix ownership — reviewed instructions and skills are readable but never
# writable by the bot. Per-domain memory and workspaces stay bot-owned.
if id letyclaw &>/dev/null; then
  chown root:letyclaw "$VAULT_PATH/CLAUDE.md" "$VAULT_PATH/TOOLS.md" 2>/dev/null || true
  chown -R root:letyclaw "$VAULT_PATH/.claude" "$VAULT_PATH/.letyclaw" 2>/dev/null || true
  chmod 640 "$VAULT_PATH/CLAUDE.md" "$VAULT_PATH/TOOLS.md" 2>/dev/null || true
  find "$VAULT_PATH/.claude" "$VAULT_PATH/.letyclaw" -type d -exec chmod 750 {} + 2>/dev/null || true
  find "$VAULT_PATH/.claude" "$VAULT_PATH/.letyclaw" -type f -exec chmod 640 {} + 2>/dev/null || true
  for domain in "${DOMAIN_NAMES[@]}"; do
    chown -R letyclaw:letyclaw "$VAULT_PATH/$domain" 2>/dev/null || true
  done
  # If a health domain exists, its ingestion directory is the one vault subtree
  # shared with the distinct webhook UID. Deployments without health support do
  # not get a surprise domain or writable directory.
  if [ "$LETYCLAW_ENABLE_HEALTH_WEBHOOK" = "1" ]; then
    install -d -o letyclaw -g letyclaw -m 0770 "$VAULT_PATH/health/daily-data"
    chgrp -R letyclaw "$VAULT_PATH/health/daily-data"
    chmod -R g+rwX,o-rwx "$VAULT_PATH/health/daily-data"
  fi
  if [ -d "$REPO_PATH/config" ]; then
    chown letyclaw:letyclaw "$REPO_PATH/config" 2>/dev/null || true
    if [ -f "$REPO_PATH/config/cron.yaml" ]; then
      chown letyclaw:letyclaw "$REPO_PATH/config/cron.yaml" 2>/dev/null || true
      chmod 660 "$REPO_PATH/config/cron.yaml" 2>/dev/null || true
    fi
  fi
  echo "  Ownership: reviewed instructions root:letyclaw read-only; domain workspaces and cron config letyclaw-owned"
fi

# Split shared secrets only for an enabled webhook. Optional services must not
# make the default bot deployment require unrelated credentials.
if [ "$LETYCLAW_ENABLE_HEALTH_WEBHOOK" = "1" ]; then
  SOURCE_ENV="${LETYCLAW_SHARED_ENV_FILE:-/etc/letyclaw-bot/env}" \
    bash "$REPO_PATH/scripts/provision-service-envs.sh"
fi
# Connector health is journal-only and never needs a copied bot credential.
rm -f /etc/letyclaw-connector-health/env

# Cross-UID Vapi inbox: the webhook writes 0660 envelopes and the bot consumes
# them. Create this boundary only when the public webhook is enabled.
if [ "$LETYCLAW_ENABLE_HEALTH_WEBHOOK" = "1" ]; then
  install -d -o letyclaw -g letyclaw -m 0770 /var/lib/letyclaw-vapi
  install -d -o letyclaw -g letyclaw -m 0770 /var/lib/letyclaw-vapi/events
  install -d -o letyclaw -g letyclaw -m 0770 /var/lib/letyclaw-vapi/inbound-context
fi

# Keep the public health/Vapi ingress in the same reviewed release as the
# webhook code. Stage backups, validate the complete nginx configuration, and
# roll both files back if validation or reload fails. Hosts without nginx (for
# example a local Mac Mini install) intentionally skip this VPS-only step.
NGINX_SITE="${LETYCLAW_NGINX_SITE:-}"
if [ -n "$NGINX_SITE" ]; then
  [ "$LETYCLAW_ENABLE_HEALTH_WEBHOOK" = "1" ] || {
    echo "ERROR: LETYCLAW_NGINX_SITE requires LETYCLAW_ENABLE_HEALTH_WEBHOOK=1" >&2
    exit 1
  }
  command -v nginx >/dev/null 2>&1 || { echo "ERROR: LETYCLAW_NGINX_SITE is set but nginx is unavailable" >&2; exit 1; }
  command -v systemctl >/dev/null 2>&1 || { echo "ERROR: LETYCLAW_NGINX_SITE is set but systemctl is unavailable" >&2; exit 1; }
  [ -d /etc/nginx ] || { echo "ERROR: LETYCLAW_NGINX_SITE is set but /etc/nginx is missing" >&2; exit 1; }
  [ -f "$NGINX_SITE" ] || { echo "ERROR: configured nginx TLS site does not exist: $NGINX_SITE" >&2; exit 1; }
  NGINX_RATE_SRC="$REPO_PATH/nginx/conf.d/letyclaw-health-webhook-rate-limit.conf"
  NGINX_RATE_DST="/etc/nginx/conf.d/letyclaw-health-webhook-rate-limit.conf"
  NGINX_SNIPPET_SRC="$REPO_PATH/nginx/snippets/letyclaw-health-webhook.conf"
  NGINX_SNIPPET_DST="/etc/nginx/snippets/letyclaw-health-webhook.conf"
  NGINX_BACKUP_DIR=$(mktemp -d /etc/nginx/.letyclaw-ingress-backup.XXXXXX)
  NGINX_CHANGED=""

  backup_and_install_nginx() {
    local src=$1 dst=$2 key=$3
    [ -f "$src" ] || { echo "ERROR: missing nginx source: $src" >&2; return 1; }
    if [ -f "$dst" ] && cmp -s "$src" "$dst"; then return 0; fi
    if [ -e "$dst" ]; then cp -a "$dst" "$NGINX_BACKUP_DIR/$key"; else : > "$NGINX_BACKUP_DIR/$key.absent"; fi
    install -d -o root -g root -m 0755 "$(dirname "$dst")"
    install -o root -g root -m 0644 "$src" "$dst"
    NGINX_CHANGED="yes"
  }

  restore_nginx_file() {
    local key=$1 dst=$2
    if [ -f "$NGINX_BACKUP_DIR/$key.absent" ]; then
      rm -f "$dst"
    elif [ -f "$NGINX_BACKUP_DIR/$key" ]; then
      cp -a "$NGINX_BACKUP_DIR/$key" "$dst"
    fi
  }

  NGINX_DEPLOY_OK=0
  rollback_nginx() {
    local status=$?
    trap - EXIT INT TERM
    if [ "$NGINX_DEPLOY_OK" -ne 1 ] && [ -n "$NGINX_CHANGED" ]; then
      restore_nginx_file rate-limit "$NGINX_RATE_DST"
      restore_nginx_file snippet "$NGINX_SNIPPET_DST"
      nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
      echo "ERROR: nginx ingress update rolled back" >&2
    fi
    rm -rf "$NGINX_BACKUP_DIR"
    exit "$status"
  }
  trap rollback_nginx EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  backup_and_install_nginx "$NGINX_RATE_SRC" "$NGINX_RATE_DST" rate-limit
  backup_and_install_nginx "$NGINX_SNIPPET_SRC" "$NGINX_SNIPPET_DST" snippet
  grep -Fq 'include /etc/nginx/snippets/letyclaw-health-webhook.conf;' "$NGINX_SITE" || {
    echo "ERROR: configured nginx TLS site does not include the Letyclaw webhook snippet: $NGINX_SITE" >&2
    exit 1
  }
  nginx -t
  # Reload even when the files already match: they may have been copied by an
  # interrupted/manual rollout without the running master loading them.
  systemctl reload nginx
  if [ -n "$NGINX_CHANGED" ]; then
    echo "  Updated and reloaded nginx health/Vapi ingress"
  else
    echo "  Verified and reloaded nginx health/Vapi ingress"
  fi
  NGINX_DEPLOY_OK=1
  trap - EXIT INT TERM
  rm -rf "$NGINX_BACKUP_DIR"
elif command -v nginx >/dev/null 2>&1 && [ -d /etc/nginx ]; then
  echo "  Skipped nginx ingress install (set LETYCLAW_NGINX_SITE to the active TLS site to enable it)"
fi

# Deploy systemd service files if changed (sync any drift back to repo source)
RELOAD_NEEDED=""
RESTART_LIST=""
RUNTIME_UNITS=(letyclaw-bot)
if [ "$LETYCLAW_ENABLE_HEALTH_WEBHOOK" = "1" ]; then
  RUNTIME_UNITS+=(health-webhook)
fi
for unit in "${RUNTIME_UNITS[@]}"; do
  SRC="$REPO_PATH/systemd/${unit}.service"
  DST="/etc/systemd/system/${unit}.service"
  if [ -f "$SRC" ] && ! diff -q "$SRC" "$DST" &>/dev/null; then
    cp "$SRC" "$DST"
    RELOAD_NEEDED="yes"
    if [ "${LETYCLAW_DEFER_RUNTIME_RESTARTS:-0}" = "1" ] || \
       { [ "$unit" = "letyclaw-bot" ] && [ "${LETYCLAW_DEFER_BOT_RESTART:-0}" = "1" ]; }; then
      echo "  Updated: ${unit}.service (restart deferred to release boundary)"
    else
      RESTART_LIST="$RESTART_LIST $unit"
      echo "  Updated: ${unit}.service"
    fi
  fi
done
# Do not copy the browser backend/proxy/socket units here: setup-mcp.sh must
# snapshot the currently working set before installing the candidate so its
# smoke-test rollback is real rather than restoring the just-copied candidate.
# Keep the hardened Twilio relay unit in sync for a future explicit rollout,
# but do not start it during normal deploys. Current voice calls use Vapi
# directly, and production has no createCall caller, DB rows, or proxy route.
VOICE_RELAY_SRC="$REPO_PATH/systemd/voice-relay.service"
VOICE_RELAY_DST="/etc/systemd/system/voice-relay.service"
if [ -f "$VOICE_RELAY_SRC" ] && ! diff -q "$VOICE_RELAY_SRC" "$VOICE_RELAY_DST" &>/dev/null; then
  cp "$VOICE_RELAY_SRC" "$VOICE_RELAY_DST"
  RELOAD_NEEDED="yes"
  echo "  Updated: voice-relay.service (kept disabled)"
fi
for unit in vault-backup.service vault-backup.timer claude-auth-check.service claude-auth-check.timer claude-token-refresh.service claude-token-refresh.timer claude-connector-refresh.service claude-connector-refresh.timer claude-connector-check.service claude-connector-check.timer; do
  SRC="$REPO_PATH/systemd/$unit"
  DST="/etc/systemd/system/$unit"
  if [ -f "$SRC" ] && ! diff -q "$SRC" "$DST" &>/dev/null; then
    cp "$SRC" "$DST"
    RELOAD_NEEDED="yes"
    echo "  Updated: $unit"
  fi
done
if [ -n "$RELOAD_NEEDED" ]; then
  systemctl daemon-reload
  for u in $RESTART_LIST; do
    systemctl restart "$u"
  done
  echo "  Reloaded systemd + restarted:$RESTART_LIST"
fi
if [ -f "$VOICE_RELAY_DST" ]; then
  systemctl disable --now voice-relay.service
  echo "  Disabled: voice-relay.service (optional legacy relay)"
fi

# This is an operational safety monitor, not an optional application service.
# Keep it active after first install and repair accidental disablement on later
# deploys. The oneshot records to journal and fails closed when auth is unhealthy.
REFRESH_TIMERS=(claude-token-refresh.timer)
REFRESH_TIMERS+=(claude-auth-check.timer)
if [ "$LETYCLAW_ENABLE_CONNECTORS" = "1" ]; then
  REFRESH_TIMERS+=(claude-connector-refresh.timer claude-connector-check.timer)
fi
for timer in "${REFRESH_TIMERS[@]}"; do
  if [ -f "/etc/systemd/system/$timer" ]; then
    systemctl enable --now "$timer"
    systemctl is-enabled --quiet "$timer"
    systemctl is-active --quiet "$timer"
    echo "  Enabled: $timer"
  fi
done

echo ""
echo "=== Setting up letyclaw-tools MCP server ==="
if [ "${LETYCLAW_DEFER_MCP_SETUP:-0}" = "1" ]; then
  echo "MCP/browser transaction deferred to the release boundary"
else
  bash "$REPO_PATH/scripts/setup-mcp.sh" "$REPO_PATH"
fi

echo ""
echo "Done. Letyclaw instructions and runtime units deployed."
