# Deployment Guide

## Prerequisites

- Any Linux server (Ubuntu/Debian recommended)
- Node.js 22 LTS
- Claude Code CLI installed and authenticated
- Telegram bot token from @BotFather

## Environment Variables

Create `/etc/letyclaw/env` on the server (mode 600):

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
VAULT_PATH=/opt/letyclaw/vault
SESSIONS_DIR=/opt/letyclaw/sessions
CLAUDE_MODEL=claude-sonnet-4-6

# Optional integrations
# OPENAI_API_KEY=
# VAPI_API_KEY=
# VAPI_PHONE_NUMBER_ID=
# VAPI_ASSISTANT_ID=
# ALPHA_VANTAGE_API_KEY=
```

## Obsidian Vault Setup

The vault directory (`VAULT_PATH`) is an [Obsidian](https://obsidian.md/) vault. Agent memory files are stored as Obsidian-compatible markdown (daily notes with `## HH:MM` headers), and the SQLite FTS5 search index is built on top of these same files. This means you can browse and edit agent memories directly in the Obsidian app on any device.

### Stack

```
Obsidian app (phone/desktop) ←→ Obsidian Sync cloud ←→ obsidian-headless (VPS)
                                                              ↓
                                                        /root/vault/
                                                              ↓
                                                        Letyclaw bot
                                                        (reads/writes .md files,
                                                         SQLite FTS5 index)
```

### Setting up Obsidian Sync on the VPS

1. **Create the vault in Obsidian** on your local device and enable Obsidian Sync (requires an Obsidian subscription).

2. **Install obsidian-headless** on the VPS:

   ```bash
   # Install obsidian-headless (headless Obsidian client for sync)
   # See: https://github.com/nichochar/obsidian-headless
   npm install -g obsidian-headless
   ```

3. **Authenticate and initialize the vault:**

   ```bash
   mkdir -p /root/vault
   obsidian-headless --vault /root/vault
   # Follow the prompts to log in with your Obsidian account
   # and select the remote vault to sync
   # Ctrl+C once initial sync completes
   ```

4. **Install the systemd service:**

   ```bash
   sudo cp systemd/obsidian-sync.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable obsidian-sync
   sudo systemctl start obsidian-sync
   ```

5. **Verify sync is running:**

   ```bash
   systemctl status obsidian-sync
   ls /root/vault/   # Should show your vault contents
   ```

6. **Set `VAULT_PATH`** in your env file:

   ```bash
   # In /etc/letyclaw/env
   VAULT_PATH=/root/vault
   ```

### Vault structure

Letyclaw creates per-agent directories inside the vault:

```
/root/vault/
├── personal/
│   ├── memory/
│   │   ├── 2026-03-28.md      # Daily memory notes (## HH:MM entries)
│   │   ├── 2026-03-29.md
│   │   └── search.sqlite      # FTS5 search index (auto-generated, not synced)
│   ├── AGENTS.md               # Agent identity/instructions
│   └── TOOLS.md                # Tool documentation
├── work/
│   ├── memory/
│   │   └── ...
│   └── AGENTS.md
└── ...
```

### .obsidianignore

Add a `.obsidianignore` file at the vault root to exclude non-markdown files from Obsidian Sync:

```
*.sqlite
*.sqlite-wal
*.sqlite-shm
```

### Backup

The vault is backed up independently via `vault-backup.service` (daily tarball, 30-day retention). This is separate from Obsidian Sync and acts as a safety net.

```bash
sudo cp systemd/vault-backup.service systemd/vault-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable vault-backup.timer
sudo systemctl start vault-backup.timer
```

## First-Time Deployment

```bash
# 1. Clone repo
cd /opt && git clone https://github.com/your-username/letyclaw.git
cd letyclaw

# 2. Install dependencies and build
npm install
npm run build

# 3. Create env file
sudo mkdir -p /etc/letyclaw
sudo cp .env.example /etc/letyclaw/env
# Edit with real values:
sudo nano /etc/letyclaw/env
sudo chmod 600 /etc/letyclaw/env

# 4. Configure topics
cp config/letyclaw.example.yaml config/letyclaw.yaml
# Edit with your Telegram IDs and topic setup:
nano config/letyclaw.yaml

# 5. Generate agent instructions
npx tsx scripts/generate-claude-md.ts

# 6. Create runtime directories
mkdir -p vault sessions logs

# 7. Register MCP tools
bash scripts/setup-mcp.sh

# 8. Run tests
npm test

# 9. Install systemd service
sudo cp systemd/letyclaw-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable letyclaw-bot
sudo systemctl start letyclaw-bot

# 10. Verify
journalctl -u letyclaw-bot -f
```

## Updating

```bash
cd /opt/letyclaw
git pull
npm install
npm run build
npx tsx scripts/generate-claude-md.ts
sudo systemctl restart letyclaw-bot
journalctl -u letyclaw-bot -f --no-pager -n 20
```

## Session Model

Sessions use a **reply-to-message** model:

- **New message** (not a reply) = fresh session with topic-specific prompt
- **Reply to a bot message** = resume the session that produced that message
- Sessions expire after **24 hours** (configurable via `ttlHours`)
- Expired session replies gracefully fall back to a fresh session
- Session files are pruned after 30 days

## Logging

Structured JSONL logs in `logs/`:

- File per day per topic: `logs/YYYY-MM-DD-{agent}-topic{id}.jsonl`
- Events: `request`, `tool_call`, `tool_result`, `result`, `response`, `error`
- Auto-pruned after 7 days

## Troubleshooting

**Bot not responding:**
```bash
journalctl -u letyclaw-bot -n 50 --no-pager
systemctl status letyclaw-bot
```

**Claude CLI errors:**
```bash
claude -p "say hello" --dangerously-skip-permissions
```

**Session issues:**
```bash
ls -la sessions/
rm sessions/*.json  # Force-clear all sessions
```

**MCP tools not visible:**
```bash
claude mcp list
```
