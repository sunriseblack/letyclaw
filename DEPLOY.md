# Letyclaw deployment guide

This guide describes the hardened Linux/systemd deployment. A local Mac or
container can run the Node process directly and skip Linux-only services.

## Prerequisites

- Ubuntu/Debian host or equivalent Linux system with systemd
- Node.js 22 or later
- Claude Code CLI installed and authenticated
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- a Telegram forum group, allowed user ID, and topic-to-agent routing
- optional integrations only when enabled: nginx, rclone/GPG, Obsidian
  Headless, Vapi, uv/uvx, email MCP, or Amplitude

`scripts/setup-droplet.sh` installs only the required host prerequisites by
default. Its optional changes are explicit:

```bash
INSTALL_OBSIDIAN_HEADLESS=1 \
INSTALL_UV=1 \
CONFIGURE_UFW=1 \
bash scripts/setup-droplet.sh
```

Review firewall policy before setting `CONFIGURE_UFW=1`.

## Default layout and path overrides

The checked-in systemd units use these production defaults:

| Purpose | Default |
|---|---|
| Repository | `/root/letyclaw` |
| Vault | `/root/vault` |
| Runtime user/group | `letyclaw:letyclaw` |
| Node.js runtime | `/usr/bin/node` (22+) |
| Claude CLI | `/usr/bin/claude` |
| Bot environment | `/etc/letyclaw-bot/env` |
| Sessions/logs | `/root/letyclaw/sessions`, `/root/letyclaw/logs` |

Deployment scripts accept `REPO_PATH`, `LETYCLAW_PROJECT_ROOT`, `VAULT_PATH`,
and integration-specific variables documented below. If the repository or
vault lives elsewhere, render matching systemd units or provide drop-ins for
every `WorkingDirectory`, executable, bind path, and environment path before
starting services. Changing only a shell variable does not rewrite systemd
sandbox paths.

`setup-droplet.sh` installs NodeSource Node.js and the global Claude CLI into
those `/usr/bin` paths. An interactive NVM installation is not a substitute:
systemd does not load a login shell. Both setup and deployment verify the
absolute runtime contract before changing services.

## Configuration

```bash
cd /root/letyclaw
cp config/letyclaw.example.yaml config/letyclaw.yaml
cp config/cron.example.yaml config/cron.yaml
${EDITOR:-vi} config/letyclaw.yaml

install -d -o root -g root -m 0700 /etc/letyclaw-bot
install -o root -g root -m 0600 .env.example /etc/letyclaw-bot/env
${EDITOR:-vi} /etc/letyclaw-bot/env
```

At minimum, set:

```dotenv
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_ALLOW_USER=<numeric Telegram user id>
TELEGRAM_GROUP_ID=<negative forum group id>
VAULT_PATH=/root/vault
SESSIONS_DIR=/root/letyclaw/sessions
```

Do not put secrets in the YAML file or repository. Optional variables are
listed in `.env.example`.

## First deployment

```bash
cd /root
git clone <repository-url> letyclaw
cd letyclaw

bash scripts/setup-droplet.sh
npm ci
npm run build
npm test

# Generate the public shared instructions and one isolated file per configured
# agent. Review both outputs before installing them into the trusted vault.
node dist/scripts/generate-claude-md.js
test -s agents/unified/CLAUDE.md
find agents/unified/domains -maxdepth 1 -type f -name '*.md' -size +0c -print

install -d -o letyclaw -g letyclaw -m 0700 sessions logs
chown letyclaw:letyclaw config/cron.yaml
chmod 0660 config/cron.yaml

# Builds reviewed shared instructions, deploys routed domains/skills, provisions
# isolated service environments, installs units, and registers required MCPs.
bash scripts/deploy-agents.sh
```

By default, `deploy-agents.sh` installs the generated public
`agents/unified/CLAUDE.md` and `agents/unified/domains/*.md`. A private advanced
deployment may instead provide all four role files under `agents/source/` plus
`agents/source/domains/*.md`; a complete advanced layout takes precedence.
Set `LETYCLAW_INSTRUCTION_MODE=unified` or `source` to make the choice explicit.
The script fails before changing trusted instructions when neither layout is
complete. It never invents a personal or company domain taxonomy.

Shared and routed instructions are root-owned and read-only to the bot. Domain
workspaces remain writable. Regenerate and review both the shared file and the
domain directory after changing agent configuration or templates.

Install and start the required units:

```bash
install -o root -g root -m 0644 \
  systemd/letyclaw-bot.service /etc/systemd/system/letyclaw-bot.service
systemctl daemon-reload
systemctl enable --now letyclaw-bot
systemctl status letyclaw-bot --no-pager
```

The webhook, browser, sync, backup, and voice units are optional. Enable only
the integrations you configured and verified.

## MCP integrations

The custom `letyclaw-tools` MCP is always registered. Other registrations are
opt-in so a generic install neither downloads nor authenticates unrelated
services:

```bash
LETYCLAW_ENABLE_BROWSER_MCP=1 \
LETYCLAW_ENABLE_EMAIL_MCP=0 \
LETYCLAW_ENABLE_FLI_MCP=0 \
LETYCLAW_ENABLE_MARKETDATA_MCP=0 \
LETYCLAW_ENABLE_AMPLITUDE_MCP=0 \
bash scripts/setup-mcp.sh /root/letyclaw
```

Each flag must be `0` or `1`. Disabled optional registrations are removed so
the resulting Claude configuration is deterministic.

The repository-level `.mcp.json` is intentionally limited to the local
`letyclaw-tools` server. Do not add raw Playwright or unpinned third-party MCP
launchers there: use `setup-mcp.sh` so optional services receive their version,
identity, credential, smoke-test, and rollback controls.

### Browser MCP

The default-enabled browser deployment creates separate browser and proxy
identities, a private Unix-socket gateway, a loopback HTTP listener, protected
credential aliases, bounded uploads, and a persistent Chromium profile outside
the vault. It performs a real navigation/screenshot/PDF smoke test before
committing the transaction. See `scripts/setup-browser.sh` and
`scripts/provision-browser-secrets.sh`.

### Email MCP

With `LETYCLAW_ENABLE_EMAIL_MCP=1`, account aliases and connection credentials
come only from the bot user's `/home/letyclaw/.config/email-mcp/config.toml`
(or the current user's config in a local install without the service account).
Production setup deliberately does not copy mailbox credentials into root's
Claude profile. The package's schema currently requires both IMAP and SMTP
sections. Before registration, setup requires the config to be owned by that
user, inaccessible to group/other users, and to contain:

```toml
[settings]
read_only = true
```

Setup also pins the package and passes `MCP_EMAIL_READ_ONLY=true` as defense in
depth. In the pinned release, the TOML setting is the authoritative control: it
prevents registration of email send, mailbox mutation, draft-send, and
scheduling tools. Letyclaw does not assume account names or addresses. Test
every configured account before granting agent access.

Do not disable that read-only boundary just because the built-in custom Gmail
tools have send denials: a third-party MCP has different tool names and can
bypass that list. Approved sends should use the custom Gmail draft/send flow,
whose outbound approval trailer is validated by the bot. An operator who wants
another write-capable email MCP must scope and audit its exact tools
independently rather than enabling it through the generic setup path.

### Market data

With `LETYCLAW_ENABLE_MARKETDATA_MCP=1`, setup performs a real MCP
`initialize`/`tools/list` handshake with a dummy key before browser downtime.
Runtime credentials are passed only through the isolated proxy environment and
redacted from both output streams. Configure `ALPHA_VANTAGE_API_KEY` or the
protected key file described by `scripts/marketdata-mcp-proxy.ts`.

## Claude credentials and connectors

The main bot credential and the optional claude.ai connector credential use
separate homes:

- main: `/home/letyclaw/.claude`
- connector: `/root/letyclaw/sessions/connector-home/.claude`

The hourly refresh services share a cross-process credential lock with runtime
and health probes. A candidate credential is installed only after its token and
expiry rotate safely; a failed post-rotation probe preserves the rotated token
to avoid discarding the only valid refresh token.

```bash
systemctl enable --now claude-token-refresh.timer claude-auth-check.timer

# Enable only after separately authenticating the connector home. This also
# installs and activates the connector refresh/health timers.
LETYCLAW_ENABLE_CONNECTORS=1 bash scripts/deploy-agents.sh
```

Monitor with:

```bash
journalctl -u claude-token-refresh.service -n 50 --no-pager
journalctl -u claude-auth-check.service -n 50 --no-pager
journalctl -u claude-connector-refresh.service -n 50 --no-pager
journalctl -u claude-connector-check.service -n 50 --no-pager
```

Connector writes are accepted only when the provider tool result supplies an
artifact matching the final completion marker. Ambiguous timeouts open a
same-run circuit breaker; verify target state before retrying.

## Optional HTTPS webhook

Set dedicated webhook/Vapi values in `/etc/letyclaw-health-webhook/env`, then
install `health-webhook.service`. Keep the direct port closed publicly and use
the two-phase TLS procedure in [docs/health-webhook-ingress.md](docs/health-webhook-ingress.md).

`deploy-agents.sh` touches nginx only when the active TLS site is explicit:

```bash
LETYCLAW_ENABLE_HEALTH_WEBHOOK=1 \
LETYCLAW_NGINX_SITE=/etc/nginx/sites-enabled/bot.example.com \
bash scripts/deploy-agents.sh
```

Without `LETYCLAW_NGINX_SITE`, nginx deployment is skipped even if nginx is
installed.

## Optional Obsidian sync

The unit runs as `letyclaw`, not root. Override its neutral defaults in
`/etc/letyclaw-obsidian/env`:

```dotenv
OBSIDIAN_VAULT_NAME=<remote vault name>
OBSIDIAN_VAULT_PATH=/root/vault
OBSIDIAN_DEVICE_NAME=<unique device name>
```

Authenticate Obsidian Headless as the `letyclaw` user before enabling
`obsidian-sync.service`.

## Optional encrypted backup

Backups are encrypted before upload, use a private writable rclone config in a
root-only StateDirectory, verify the remote checksum, and bound retention.
Follow [docs/vault-backup.md](docs/vault-backup.md) and complete a restore drill
before enabling `vault-backup.timer`.

## Optional disk-capacity monitoring

`scripts/check-disk.sh` writes a warning to journald when `/` crosses the
configured threshold. It does not read bot credentials or notify Telegram.
Deployment does not install a private cron entry implicitly. To opt in, add a
reviewed `/etc/cron.d/letyclaw-disk-monitor` entry such as:

```cron
DISK_USAGE_WARN_THRESHOLD=90
17 */6 * * * root /root/letyclaw/scripts/check-disk.sh
```

Keep the file root-owned and mode `0644`, then verify with
`journalctl -t disk-monitor` after a controlled threshold test.

## Routine update

Preserve runtime-owned files and deploy an exact reviewed revision:

```bash
cd /root/letyclaw
git fetch origin
git merge --ff-only origin/main
npm ci
npm run build
npm test
bash scripts/deploy-agents.sh
systemctl restart letyclaw-bot
```

The GitHub deployment workflow adds a transactional boundary around source,
dependencies, runtime cron state, reviewed instructions, systemd refresh units,
and browser setup. On failure it restores the previous files and unit states
and proves compatibility before restarting the bot/webhook.

## Verification checklist

```bash
systemctl is-active --quiet letyclaw-bot
journalctl -u letyclaw-bot -n 100 --no-pager
sudo -u letyclaw test -w /root/letyclaw/config/cron.yaml
sudo -u letyclaw claude mcp list
npm run build:check
npm test
bash scripts/security-audit.sh
```

Then verify behavior at the original boundary:

1. send a new message in every configured Telegram topic;
2. reply to a bot response and confirm session continuity;
3. exercise memory and cron tools in a disposable test;
4. smoke each enabled optional integration;
5. for writes, verify the provider artifact rather than trusting assistant text;
6. for webhooks, correlate a real client request with journal and persisted data.

## Troubleshooting

Bot/runtime:

```bash
systemctl status letyclaw-bot --no-pager
journalctl -u letyclaw-bot -n 100 --no-pager
```

MCP/browser:

```bash
sudo -u letyclaw claude mcp list
systemctl status playwright-mcp playwright-mcp-proxy.socket --no-pager
journalctl -u playwright-mcp -n 100 --no-pager
```

Webhook:

```bash
systemctl status health-webhook --no-pager
curl --fail --silent --show-error http://127.0.0.1:8788/health
nginx -t
```

Do not delete sessions, credentials, browser profiles, or backup state as a
first troubleshooting step. Preserve evidence, identify the exact failed
surface, and use the documented rollback path.
