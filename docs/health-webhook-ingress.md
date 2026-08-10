# Health webhook HTTPS migration

The health webhook should be reachable only through an existing nginx TLS
virtual host. The application listens on loopback after the cutover.

Set deployment-specific values before following this runbook:

```bash
export PROJECT_ROOT=/root/letyclaw
export PUBLIC_BASE_URL=https://bot.example.com
export NGINX_SITE=/etc/nginx/sites-enabled/bot.example.com
export VAULT_PATH=/root/vault
```

Target request contract:

```text
POST ${PUBLIC_BASE_URL}/health/apple
Authorization: Bearer <HEALTH_WEBHOOK_SECRET>
Content-Type: application/json
```

Do not put the bearer token in the URL, nginx configuration, access log, or
shell history.

## Phase 1: add HTTPS without removing direct ingress

```bash
cd "$PROJECT_ROOT"
install -o root -g root -m 0644 \
  nginx/conf.d/letyclaw-health-webhook-rate-limit.conf \
  /etc/nginx/conf.d/letyclaw-health-webhook-rate-limit.conf
install -o root -g root -m 0644 \
  nginx/snippets/letyclaw-health-webhook.conf \
  /etc/nginx/snippets/letyclaw-health-webhook.conf
```

Inside the existing TLS `server { ... }` block, add exactly once:

```nginx
include /etc/nginx/snippets/letyclaw-health-webhook.conf;
```

Keep backups outside `sites-enabled/`; nginx may load every file there,
including files with backup suffixes. Validate and reload:

```bash
nginx -t
systemctl reload nginx
curl --fail --silent --show-error http://127.0.0.1:8788/health
test "$(curl --silent --output /dev/null --write-out '%{http_code}' \
  -X POST "$PUBLIC_BASE_URL/health/apple" \
  -H 'Content-Type: application/json' --data '{}')" = 401
```

Alternatively, a deployment can let `scripts/deploy-agents.sh` install and
transactionally validate these files:

```bash
LETYCLAW_ENABLE_HEALTH_WEBHOOK=1 \
LETYCLAW_NGINX_SITE="$NGINX_SITE" \
bash scripts/deploy-agents.sh
```

Update the phone Shortcut to the HTTPS endpoint while preserving its bearer
header. Continue only after a real phone request returns 200, the matching
`POST /health/apple -> 200` journal line exists, and the expected daily file is
newly modified. `/health` and a synthetic 401 prove routing, not the phone flow.

## Phase 2: close direct ingress

```bash
cd "$PROJECT_ROOT"
install -d -o root -g root -m 0755 \
  /etc/systemd/system/health-webhook.service.d
install -o root -g root -m 0644 \
  systemd/health-webhook-loopback.conf \
  /etc/systemd/system/health-webhook.service.d/loopback.conf
systemctl daemon-reload
systemctl restart health-webhook
systemctl is-active --quiet health-webhook
ss -lntp | grep -E '127\.0\.0\.1:8788\b'
curl --fail --silent --show-error http://127.0.0.1:8788/health
```

Remove every public firewall allow rule for port 8788. With UFW:

```bash
RULES=$(ufw status numbered | sed -n \
  '/8788\/tcp.*ALLOW IN/s/^\[[[:space:]]*\([0-9][0-9]*\)\].*/\1/p' | sort -rn)
for rule in $RULES; do ufw --force delete "$rule"; done
if ufw status numbered | grep -Eq '8788/tcp.*ALLOW IN'; then
  echo 'ERROR: a public 8788 allow rule remains' >&2
  exit 1
fi
```

From another host, confirm HTTPS still returns 401 without credentials and the
server's public address no longer accepts TCP port 8788. Then run the real phone
request again and correlate its 200 with both the journal and storage:

```bash
journalctl -u health-webhook --since '10 minutes ago' --no-pager \
  | grep -E 'POST /health/apple -> 200'
find "$VAULT_PATH/health/daily-data" -maxdepth 1 \
  -name 'apple-health-*.json' -mmin -10 -ls
```

## Rollback

If HTTPS fails after cutover, temporarily reopen the direct route, remove the
loopback drop-in, restart the service, and verify the listener before reverting
the client URL:

```bash
ufw allow 8788/tcp comment 'Health webhook rollback'
rm -f /etc/systemd/system/health-webhook.service.d/loopback.conf
systemctl daemon-reload
systemctl restart health-webhook
systemctl is-active --quiet health-webhook
ss -lntp | grep -E '(0\.0\.0\.0|\[::\]):8788\b'
```

Re-run `nginx -t` before every reload, monitor certificate renewal, and treat a
public 8788 listener as configuration drift. Do not IP-allowlist a mobile phone;
TLS plus the high-entropy bearer token is the stable control.
