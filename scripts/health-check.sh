#!/usr/bin/env bash
# Monitoring script — add to system crontab:
# */5 * * * * /opt/letyclaw/scripts/health-check.sh

systemctl is-active --quiet letyclaw-bot || {
  echo "$(date): Letyclaw bot down, restarting..." >> /var/log/letyclaw-health.log
  systemctl restart letyclaw-bot
}
