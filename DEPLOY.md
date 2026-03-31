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
