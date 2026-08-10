#!/usr/bin/env bash
set -euo pipefail

# Opt-in root-capacity probe. Schedule it explicitly with cron or a systemd
# timer when the host needs it. Telemetry stays in journald; the probe never
# reads Telegram credentials or posts service messages into assistant topics.
readonly threshold_percent="${DISK_USAGE_WARN_THRESHOLD:-90}"

if ! [[ "$threshold_percent" =~ ^[0-9]+$ ]] || (( threshold_percent < 1 || threshold_percent > 100 )); then
  logger -p daemon.err -t disk-monitor "invalid_threshold_percent=${threshold_percent} mount=/"
  exit 2
fi

usage_percent="$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
if ! [[ "$usage_percent" =~ ^[0-9]+$ ]]; then
  logger -p daemon.err -t disk-monitor "disk_usage_probe_failed mount=/"
  exit 1
fi

if (( usage_percent > threshold_percent )); then
  logger -p daemon.warning -t disk-monitor \
    "disk_usage_percent=${usage_percent} threshold_percent=${threshold_percent} mount=/ host=${HOSTNAME:-unknown}"
fi
