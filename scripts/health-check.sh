#!/usr/bin/env bash
set -euo pipefail

# Read-only service liveness probe for an operator-owned cron or monitoring
# system. systemd owns restart policy; this probe records failures without
# hiding crash loops or assuming optional integrations are installed.
REQUIRED_UNITS="${LETYCLAW_HEALTH_CHECK_REQUIRED_UNITS:-letyclaw-bot.service}"
OPTIONAL_UNITS="${LETYCLAW_HEALTH_CHECK_OPTIONAL_UNITS:-}"
FAILED=0

check_unit() {
  local unit=$1 requirement=$2
  if ! [[ "$unit" =~ ^[A-Za-z0-9_.@-]+$ ]]; then
    logger -p daemon.err -t letyclaw-health "invalid_unit=$unit requirement=$requirement"
    FAILED=1
    return
  fi
  if ! systemctl is-active --quiet "$unit"; then
    logger -p daemon.warning -t letyclaw-health "inactive_unit=$unit requirement=$requirement"
    FAILED=1
  fi
}

for unit in $REQUIRED_UNITS; do check_unit "$unit" required; done
for unit in $OPTIONAL_UNITS; do check_unit "$unit" optional; done

exit "$FAILED"
