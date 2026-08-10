# Letyclaw

Self-hostable multi-agent Telegram bot powered by Claude. One Telegram group with forum topics, each topic routed to a specialized AI agent domain — personal assistant, work, health, finance, or anything you define.

```
Telegram Group (forum topics)
  |
  |-- Topic: Personal  ──> Claude CLI (with memory, browser, email, voice...)
  |-- Topic: Work      ──> Claude CLI (with Slack, calendar, project context...)
  |-- Topic: Health    ──> Claude CLI (with health data, protocols, tracking...)
  |-- Topic: Finance   ──> Claude CLI (with market data, transactions, budgets...)
  |-- Topic: [custom]  ──> Claude CLI (with whatever tools you configure)
```

**Key design decisions:**
- **Claude CLI as the AI backbone** — uses your Claude subscription (Pro/Max), no API keys needed for the AI itself
- **YAML-driven configuration** — define agents, routing, and behavior in a single config file
- **Scoped MCP toolsets** — memory, sessions, skills, messaging, cron, media, browser support, and connectors; startup reports the exact inventory
- **Single-user by design** — personal AI assistant, not a multi-tenant platform
- **Durable local state** — active sessions are atomic JSON, curated memory is Markdown + FTS5, and secret-scrubbed historical recall is SQLite/FTS5 derived from JSONL audit events

## Requirements

- **Node.js 22 LTS** or later
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`)
- **Claude Pro or Max subscription** (Max recommended for higher rate limits)
- **Telegram bot token** from [@BotFather](https://t.me/BotFather)
- A Telegram group with **forum topics enabled**

## Quick Start

```bash
# Clone
git clone https://github.com/sunriseblack/letyclaw.git
cd letyclaw

# Install and build
npm install
npm run build

# Configure
cp config/letyclaw.example.yaml config/letyclaw.yaml
cp config/cron.example.yaml config/cron.yaml
# Edit config/letyclaw.yaml with your Telegram IDs and agent definitions

# Set environment variables
export TELEGRAM_BOT_TOKEN=your-bot-token
export VAULT_PATH=$HOME/vault
export SESSIONS_DIR=$(pwd)/sessions

# Generate the shared prompt and one isolated instruction file per agent
node dist/scripts/generate-claude-md.js \
  --output "$VAULT_PATH/CLAUDE.md" \
  --domains-output "$VAULT_PATH/.letyclaw/domains"

# Register only the bundled local MCP server
claude mcp add --scope user --transport stdio letyclaw-tools -- \
  node "$(pwd)/dist/tools/letyclaw-mcp/server.js"

# Run
npm start
```

---

## Table of Contents

1. [Architecture](#architecture)
2. [Telegram Setup](#telegram-setup)
3. [Configuration](#configuration)
4. [Claude Code CLI Setup](#claude-code-cli-setup)
5. [Deployment: Mac Mini](#deployment-mac-mini)
6. [Deployment: VPS (Ubuntu/Debian)](#deployment-vps)
7. [Deployment: Docker](#deployment-docker)
8. [MCP Tools](#mcp-tools)
9. [Optional Integrations](#optional-integrations)
10. [Agent Instructions](#agent-instructions)
11. [Session Model](#session-model)
12. [Cron Jobs](#cron-jobs)
13. [Logging](#logging)
14. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Telegram (forum group with topics)                              │
│    Topic 2: Personal  ───┐                                       │
│    Topic 3: Work      ───┼──> bot.ts (message router)            │
│    Topic 4: Health    ───┘        │                              │
│                                   ▼                              │
│                        ┌──────────────────┐                      │
│                        │   Claude CLI      │                     │
│                        │   (subprocess)    │                     │
│                        │   --resume <sid>  │                     │
│                        └────────┬─────────┘                      │
│                                 │                                │
│               ┌─────────────────┼─────────────────┐              │
│               ▼                 ▼                  ▼              │
│        ┌────────────┐   ┌────────────┐    ┌────────────────┐     │
│        │ letyclaw-tools  │   │ playwright │    │ Cloud MCP      │     │
│        │ scoped MCP  │   │ MCP        │    │ (Gmail, Slack, │     │
│        │ toolsets    │   │ (browser)  │    │  Calendar...)  │     │
│        └────────────┘   └────────────┘    └────────────────┘     │
└──────────────────────────────────────────────────────────────────┘
```

**How it works:**

1. You send a message in a Telegram forum topic
2. `bot.ts` receives it, looks up which agent handles that topic (from `config/letyclaw.yaml`)
3. Spawns a Claude CLI subprocess with the message as prompt, using `--resume` for session continuity
4. Claude reads stable shared instructions from vault `CLAUDE.md`; the bot appends exactly one routed domain from the reviewed repository or `vault/.letyclaw/domains`, plus metadata for only the enabled skills
5. Claude uses MCP tools (memory, browser, email, etc.) as needed
6. Response streams back as NDJSON, gets parsed, and sent to Telegram

**Key files:**

| File | Purpose |
|------|---------|
| `bot.ts` | Main entry — Telegram polling, message routing, Claude CLI spawning |
| `config.ts` | YAML config loader with defaults |
| `lib.ts` | Session management, rate limiting, Markdown→Telegram HTML conversion |
| `cron.ts` | Scheduled job runner (node-cron) |
| `types.ts` | TypeScript interfaces |
| `config/letyclaw.yaml` | Agent definitions, Telegram routing, defaults |
| `config/cron.yaml` | Scheduled jobs |
| `agents/templates/` | Templates used to generate the default unified instructions |
| `agents/unified/CLAUDE.md` | Local generated copy of shared instructions (ignored by Git) |
| `agents/unified/domains/*.md` | Local generated per-topic instructions (ignored by Git) |
| `$VAULT_PATH/.letyclaw/domains/*.md` | Deployed routed instructions; only the active topic is appended |
| `agents/source/domains/*.md` | Optional reviewed overrides used by advanced deployments |
| `agents/shared/TOOLS.md` | Shared tool usage contract |
| `.claude/skills/*/SKILL.md` | Canonical on-demand skill packages |
| `tools/letyclaw-mcp/` | Custom MCP server; startup log is authoritative for tool count |
| `services/session-recall.ts` | Secret-scrubbed durable session search, browse, and anchored context |

---

## Telegram Setup

### Step 1: Create a Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot`
3. Choose a display name (e.g., "My AI Assistant")
4. Choose a username ending in `bot` (e.g., `my_ai_assistant_bot`)
5. **Save the API token** — this is your `TELEGRAM_BOT_TOKEN`

### Step 2: Disable Group Privacy

By default, bots only see commands (`/start`) in groups. You need the bot to see all messages:

1. In BotFather, send `/mybots`
2. Select your bot → **Bot Settings** → **Group Privacy**
3. Set to **Disabled** (bot receives all messages)

### Step 3: Create a Forum Group

1. Create a new Telegram group
2. Add your bot to the group
3. Make the bot an **admin** (required for forum topic access)
4. Go to **Group Settings** → **Topics** → **Enable Topics**
5. Create topics for each domain you want:
   - "Personal" (will get a thread ID, e.g., `2`)
   - "Work" (e.g., `3`)
   - "Health" (e.g., `4`)
   - etc.

### Step 4: Get Your IDs

You need three IDs for configuration:

**Your user ID:**
```bash
# Send a message in the group, then:
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep '"from"' -A5
# Look for "id": 123456789
```

Or message [@userinfobot](https://t.me/userinfobot) in a private chat.

**Group chat ID:**
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep '"chat"' -A5
# Look for "id": -100XXXXXXXXXX (negative number)
```

**Topic thread IDs:**
```bash
# Send a message in each topic, then check:
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | python3 -m json.tool | grep "message_thread_id"
```

Or right-click a message in a topic → **Copy Message Link** → the URL format is `https://t.me/c/XXXXXXXXXX/YY/ZZ` where `YY` is the thread ID.

### Optional: Telegram Setup Wizard

After `npm run build`, the wizard can create topics and generate the main
config, separate cron config, shared instructions, and isolated domain files:

```bash
export TELEGRAM_BOT_TOKEN=your-bot-token
export VAULT_PATH=$HOME/vault
node dist/setup.js
```

The integration choices update generated tool visibility and guidance; they do
not install credentials or external MCP services. Register `letyclaw-tools`
with the Quick Start command before launching the bot.

---

## Configuration

### Main Config: `config/letyclaw.yaml`

```yaml
bot:
  name: "Letyclaw"
  owner: "Owner"
  timezone: "UTC"

agents:
  defaults:
    maxTurns: 10           # Max Claude tool-use turns per request
    session:
      ttlHours: 24         # Session expires after 24h of inactivity
      pruneAfterDays: 30   # Delete session files after 30 days
    timeouts:
      claudeTotal: 1200000         # 20 min budget per Claude invocation
      claudeMaxContinuations: 2    # Fresh budgets after a still-working run
    rateLimit:
      maxRequests: 10      # Max requests per user per window
      windowMs: 60000      # Rate limit window (1 minute)

  list:
    - id: personal
      name: "Personal"
      maxTurns: 50         # Override default for complex tasks
      disabledToolsets: [browser, connectors, gdrive, gmail, media, ticktick, voice]

    - id: work
      name: "Work"
      maxTurns: 50
      disabledToolsets: [browser, connectors, gdrive, gmail, media, ticktick, voice]

    - id: health
      name: "Health"
      maxTurns: 10
      disabledToolsets: [browser, connectors, gdrive, gmail, media, ticktick, voice]

    - id: finance
      name: "Finance"
      maxTurns: 10
      disabledToolsets: [browser, connectors, gdrive, gmail, media, ticktick, voice]

channels:
  telegram:
    chatId: -100XXXXXXXXXX       # Your group chat ID
    accounts:
      - id: main
        allowFrom:
          - 123456789            # Your Telegram user ID
    routing:
      - agent: personal
        threadId: 2              # Map topic thread IDs to agents
      - agent: work
        threadId: 3
      - agent: health
        threadId: 4
      - agent: finance
        threadId: 5
```

Credential- and service-dependent toolsets are disabled in the public default.
After configuring an integration, remove only its name from that agent's
`disabledToolsets`. `enabledToolsets` is a stricter allow-list; when present,
every omitted bundled toolset is hidden.

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | **Yes** | — | Bot token from @BotFather |
| `VAULT_PATH` | No | `/root/vault` | Directory for agent workspaces and memory |
| `SESSIONS_DIR` | No | `/root/letyclaw/sessions` | Directory for session JSON files |
| `CLAUDE_PATH` | No | auto-detect | Path to Claude CLI binary |
| `CLAUDE_MODEL` | No | `claude-sonnet-4-6` | Model to use |
| `WHISPER_MODEL` | No | `/opt/whisper.cpp/models/ggml-base.bin` | Whisper model for voice transcription |
| `TELEGRAM_GROUP_ID` | No | from YAML | Override group ID from config |
| `TELEGRAM_ALLOW_USER` | No | from YAML | Override allowed user from config |
| `VAPI_API_KEY` | No | — | Enable voice calls (Vapi/Twilio) |
| `VAPI_PHONE_NUMBER_ID` | No | — | Vapi phone number |
| `VAPI_ASSISTANT_ID` | No | — | Vapi assistant |
| `VAPI_SERVER_URL` | No | — | Public Vapi webhook URL, for example `https://bot.example.com/voice/vapi` |
| `VAPI_SERVER_CREDENTIAL_ID` | No | — | Vapi bearer credential attached to webhook requests |
| `VAPI_WEBHOOK_SECRET` | No | — | Matching bearer secret used only by the isolated webhook service |
| `VAPI_INBOUND_TOPIC_ID` | No | — | Telegram topic for inbound callback outcomes |
| `ALPHA_VANTAGE_API_KEY` | No | — | Enable market data tools |

### Cron Config: `config/cron.yaml`

```yaml
cron:
  timezone: "UTC"              # Your IANA timezone
  jobs:
    - id: morning-briefing
      name: "Morning Briefing"
      schedule: "0 9 * * *"   # 9:00 AM daily
      agent: personal
      topicId: 2
      prompt: "Review current priorities using memory and return a concise briefing."
      delivery: signal       # signal, silent, or nudge (nudges stay disabled)
      maxTurns: 10
      enabled: false          # Shipped examples are opt-in

    - id: weekly-review
      name: "Weekly Review"
      schedule: "0 18 * * 5"  # Friday 6 PM
      agent: finance
      topicId: 5
      prompt: "Review this week's durable notes and summarize unresolved work."
      delivery: signal
      maxTurns: 10
      enabled: false
```

Cron config hot-reloads every 60 seconds — no restart needed.

---

## Claude Code CLI Setup

### Install

```bash
npm install -g @anthropic-ai/claude-code
```

### Authenticate

**On a machine with a browser (local Mac, desktop):**

```bash
claude login
# Opens browser for OAuth flow
# Token is saved locally
```

**On a headless server (VPS, Mac Mini over SSH):**

Option A — **Token transfer** (recommended):

```bash
# On your local machine:
claude setup-token
# Generates a long-lived OAuth token

# On the server, set it as an environment variable:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-your-token-here
```

Option B — **SSH port forwarding:**

```bash
# From your local machine:
ssh -L 8080:localhost:8080 user@your-server

# On the server:
claude login
# Opens a URL like http://localhost:8080/...
# Access it in your LOCAL browser (it's forwarded through SSH)
```

### Verify

```bash
claude -p "say hello" --dangerously-skip-permissions
```

### macOS Keychain Note

When running Claude CLI over SSH on macOS, it may fail to access the macOS Keychain. Fix by using the environment variable approach:

```bash
# In your launchd plist or shell profile:
export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-your-token
```

---

## Deployment: Mac Mini

The Mac Mini (especially M-series) is an excellent always-on server — it idles at 3-4 watts (~$5/year electricity).

### Prerequisites

```bash
# Install Node.js 22 via nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
nvm use 22

# Install Claude Code CLI
npm install -g @anthropic-ai/claude-code

# Authenticate Claude
claude login
```

### Prevent Sleep

```bash
# Prevent system sleep (display can still sleep)
sudo pmset -a sleep 0
sudo pmset -a disksleep 0
sudo pmset -a displaysleep 10

# Auto-restart after power failure
sudo pmset -a autorestart 1

# Wake on network access (for SSH)
sudo pmset -a womp 1

# Verify
pmset -g
```

### Enable SSH

**System Settings** → **General** → **Sharing** → **Remote Login** → **Enable**

Then harden SSH:

```bash
# Copy your key first
ssh-copy-id user@mac-mini-ip

# Edit /etc/ssh/sshd_config:
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
```

### Clone and Build

```bash
cd ~
git clone https://github.com/sunriseblack/letyclaw.git letyclaw
cd letyclaw
npm install
npm run build
cp config/letyclaw.example.yaml config/letyclaw.yaml
cp config/cron.example.yaml config/cron.yaml
# Edit both YAML files before generating instructions.
```

### Create Vault Directory

```bash
mkdir -p ~/vault
# Create domain directories matching your config
for domain in personal work health finance; do
  mkdir -p ~/vault/$domain/memory
done
```

### Deploy Agent Instructions

```bash
# Generate shared instructions plus the isolated routed domain files
node dist/scripts/generate-claude-md.js \
  --output "$HOME/vault/CLAUDE.md" \
  --domains-output "$HOME/vault/.letyclaw/domains"
# Compatibility copy for humans; the generated CLAUDE.md already embeds it.
cp agents/shared/TOOLS.md ~/vault/TOOLS.md
```

### Register MCP Tools

```bash
# Register letyclaw-tools MCP server with Claude CLI
claude mcp add --scope user --transport stdio letyclaw-tools -- \
  node "$(pwd)/dist/tools/letyclaw-mcp/server.js"
```

### Configure Environment

Create `~/letyclaw/.env`:

```bash
TELEGRAM_BOT_TOKEN=your-bot-token
VAULT_PATH=/Users/youruser/vault
SESSIONS_DIR=/Users/youruser/letyclaw/sessions
CLAUDE_MODEL=claude-sonnet-4-6
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...  # if needed for headless auth
```

### Create launchd Service

Create `~/Library/LaunchAgents/com.letyclaw.bot.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.letyclaw.bot</string>

    <key>ProgramArguments</key>
    <array>
        <string>/Users/youruser/.nvm/versions/node/v22.22.1/bin/node</string>
        <string>/Users/youruser/letyclaw/dist/bot.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/youruser/letyclaw</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>TELEGRAM_BOT_TOKEN</key>
        <string>your-bot-token</string>
        <key>VAULT_PATH</key>
        <string>/Users/youruser/vault</string>
        <key>SESSIONS_DIR</key>
        <string>/Users/youruser/letyclaw/sessions</string>
        <key>CLAUDE_PATH</key>
        <string>/Users/youruser/.nvm/versions/node/v22.22.1/bin/claude</string>
        <key>CLAUDE_MODEL</key>
        <string>claude-sonnet-4-6</string>
        <key>LETYCLAW_PROJECT_ROOT</key>
        <string>/Users/youruser/letyclaw</string>
        <key>NODE_ENV</key>
        <string>production</string>
        <key>PATH</key>
        <string>/Users/youruser/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>/Users/youruser/letyclaw/logs/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/youruser/letyclaw/logs/stderr.log</string>
</dict>
</plist>
```

Replace all instances of `youruser` with your macOS username.

### Start the Bot

```bash
mkdir -p ~/letyclaw/logs ~/letyclaw/sessions

# Load and start
launchctl load ~/Library/LaunchAgents/com.letyclaw.bot.plist

# Check status
launchctl list | grep letyclaw

# View logs
tail -f ~/letyclaw/logs/stderr.log
```

### Management Commands

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.letyclaw.bot.plist

# Restart (unload + load)
launchctl unload ~/Library/LaunchAgents/com.letyclaw.bot.plist
launchctl load ~/Library/LaunchAgents/com.letyclaw.bot.plist

# Check if running
launchctl list | grep letyclaw
# PID column shows process ID if running, "-" if stopped
```

### Optional: Playwright Browser

```bash
# Installs the browser revision matching the repo-pinned MCP release.
VAULT_PATH="$HOME/vault" BROWSER_STATE_DIR="$HOME/.local/share/letyclaw-browser" \
  bash scripts/setup-browser.sh
```

For a persistent macOS service, run the compiled `browser-gateway` with the same
private state/cache and the two `browser-artifacts` / `browser-uploads` exchange
directories. The gateway owns one private stdio MCP process, so tabs and forms
survive gaps between Claude HTTP clients without exposing upstream arbitrary
code tools. Use `browser_dom_query` for bounded read-only page extraction.
On Linux production, a separate low-privilege service bridges loopback HTTP to
the gateway's Unix socket so Chromium's cgroup can deny localhost/private egress.

### Updating

```bash
cd ~/letyclaw
git pull
npm install
npm run build
node dist/scripts/generate-claude-md.js \
  --output "$HOME/vault/CLAUDE.md" \
  --domains-output "$HOME/vault/.letyclaw/domains"

# Restart
launchctl unload ~/Library/LaunchAgents/com.letyclaw.bot.plist
launchctl load ~/Library/LaunchAgents/com.letyclaw.bot.plist
```

---

## Deployment: VPS

Tested on Ubuntu 24.04 (DigitalOcean, Hetzner). Minimum specs: 1 vCPU, 2GB RAM, 25GB SSD.

### Server Setup

```bash
# Run the setup script (installs Node.js 22, Claude CLI)
bash scripts/setup-droplet.sh

# Authenticate Claude CLI
claude login
# Use SSH port forwarding if headless (see Claude CLI Setup section)
```

### Security Hardening

```bash
# SSH key-only auth
sudo sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd

# Firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw limit 22/tcp    # Rate-limit SSH
sudo ufw enable

# fail2ban
sudo apt install -y fail2ban
sudo systemctl enable fail2ban

# Automatic security updates
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

### Deploy

```bash
# Clone
cd /root && git clone https://github.com/sunriseblack/letyclaw.git letyclaw
cd letyclaw

# Install and build
npm install
npm run build
cp config/letyclaw.example.yaml config/letyclaw.yaml
cp config/cron.example.yaml config/cron.yaml
# Edit both YAML files before continuing.

# Create env file with secrets
sudo mkdir -p /etc/letyclaw-bot
cat > /etc/letyclaw-bot/env << 'EOF'
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOW_USER=your-user-id
TELEGRAM_GROUP_ID=your-group-id
VAULT_PATH=/root/vault
SESSIONS_DIR=/root/letyclaw/sessions
CLAUDE_PATH=/usr/bin/claude
CLAUDE_MODEL=claude-sonnet-4-6
EOF
sudo chmod 600 /etc/letyclaw-bot/env

# Create runtime directories
mkdir -p sessions logs
mkdir -p /root/vault

# Create domain directories
for domain in personal work health finance; do
  mkdir -p /root/vault/$domain/memory
done

# Generate the public shared+routed instruction layout, then use the hardened
# deployment helper to install it and register configured MCP services.
node dist/scripts/generate-claude-md.js
bash scripts/deploy-agents.sh

# Run tests
npm test

# Install systemd service
sudo cp systemd/letyclaw-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable letyclaw-bot
sudo systemctl start letyclaw-bot

# Verify
journalctl -u letyclaw-bot -f
```

### Expected Startup Output

```
Letyclaw bot started (Claude CLI mode)
Model: claude-sonnet-4-6
Claude: /usr/bin/claude
Vault: /root/vault
Agents: topic:2->personal, topic:3->work, topic:4->health, topic:5->finance
```

### systemd Service Management

```bash
# Status
sudo systemctl status letyclaw-bot

# Logs (follow)
journalctl -u letyclaw-bot -f

# Restart
sudo systemctl restart letyclaw-bot

# Stop
sudo systemctl stop letyclaw-bot
```

### Updating (Routine)

```bash
cd /root/letyclaw
git pull
npm install
npm run build
node dist/scripts/generate-claude-md.js
bash scripts/deploy-agents.sh
sudo systemctl restart letyclaw-bot
journalctl -u letyclaw-bot -f --no-pager -n 20
```

The provided setup/deployment scripts create and permission the dedicated
`letyclaw` runtime user used by the systemd unit. Do not run the bot as root.

---

## Deployment: Docker

Docker is optional. The multi-stage image compiles with development dependencies,
then copies only production dependencies and runtime assets. `.dockerignore`
keeps local secrets, config, sessions, logs, and owner instructions out of image
layers. Compose mounts reviewed generated instructions read-only while leaving
the rest of the vault writable.

### Run with Docker

```bash
# Create and edit local config first
cp config/letyclaw.example.yaml config/letyclaw.yaml
cp config/cron.example.yaml config/cron.yaml

# Configure the token and headless Claude authentication
cat > .env << 'EOF'
TELEGRAM_BOT_TOKEN=your-bot-token
CLAUDE_MODEL=claude-sonnet-4-6
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-your-token
EOF

# Build locally once to generate the reviewed bind-mounted instructions
npm install
npm run build
node dist/scripts/generate-claude-md.js
test -s agents/unified/CLAUDE.md
test -s agents/unified/domains/personal.md

# Validate, build, and start
docker compose config
docker compose build

# Start
docker compose up -d

# Logs
docker compose logs -f letyclaw
```

The image registers only the bundled `letyclaw-tools` server. Stock Compose does
not install the host-isolated browser gateway or optional third-party MCPs. The
interactive Claude login flow is not suitable for this container path; provide
`CLAUDE_CODE_OAUTH_TOKEN` through `.env` and keep that file private.

---

## MCP Tools

The bot ships with a custom MCP server (`tools/letyclaw-mcp/`) organized into independently scoped toolsets. The startup log reports the authoritative count; the tables below cover the core harness surfaces.

### Memory (6 tools)

| Tool | Description |
|------|-------------|
| `memory_search` | Full-text search across memory files (SQLite FTS5 + BM25 ranking) |
| `memory_get` | Read a specific memory file by date or path |
| `memory_save` | Append timestamped entries to daily memory files |
| `memory_list` | List recent memory files (newest first) |
| `memory_delete` | Remove a memory file and its index entries |
| `memory_related` | Find notes connected by curated wikilinks |

Memory is stored as Markdown files (`{domain}/memory/YYYY-MM-DD.md`) with a SQLite FTS5 index for fast search. Saves are serialized per daily file, atomically renamed, and keep a last-known-good backup.

### Sessions and recall (10 tools)

| Tool | Description |
|------|-------------|
| `sessions_list` | Inspect the active session owned by the routed topic |
| `sessions_history` | Inspect its metadata and message mapping |
| `sessions_send` | Continue an owned session in a bounded leaf under the shared worker cap |
| `sessions_spawn` | Spawn a same-domain bounded leaf worker with inherited deny policy |
| `sessions_yield` | Stop a locally owned leaf or read its durable terminal result |
| `subagents` | List durable bounded-worker status and result previews |
| `session_status` | Check session metadata |
| `session_search` | Search secret-scrubbed durable recall and return stable anchors |
| `sessions_browse` | Browse conversation summaries with stable cursors |
| `session_context` | Read bounded chronological context around a search anchor |

Raw JSONL remains the short-lived audit trail. `session-recall.sqlite` stores only a scrubbed projection: user/assistant text, tool names/outcomes, and categorized errors—never raw tool arguments, results, stream payloads, or provider errors.

### Skills (2 tools)

| Tool | Description |
|------|-------------|
| `skills_list` | List metadata for skills enabled in the current run |
| `skill_view` | Read a complete enabled skill file or reference on demand |

### Open loops (6 tools)

The open-loop ledger tracks durable pending work across turns. It supports
idempotent open/update/close operations, filtered listing, direct lookup, and an
optional TickTick mirror. The current actionable set is injected into the next
turn without replaying raw conversations.

### Optional integration toolsets

The MCP server also includes scoped Gmail, Google Drive, TickTick, browser
credential-alias, media, voice, and Claude connector modules. The public config
hides credential-dependent modules with `disabledToolsets`. Remove a toolset
from that list only after configuring it. Agent and cron scopes can be tightened
further with `enabledToolsets`, `disabledToolsets`, and `disabledTools`.

### Messaging (7 tools)

| Tool | Description |
|------|-------------|
| `message_send` | Direct Telegram send (denied during normal agent turns) |
| `message_buttons` | Send inline keyboard buttons |
| `message_poll` | Create polls or quizzes |
| `message_react` | React to a message with an emoji |
| `message_edit` | Update a previously sent message |
| `message_typing` | Typing indicator (owned by the bot, denied to agents) |
| `message_document` | Deliver a bounded file/photo from an approved local path |

### Cron (7 tools)

| Tool | Description |
|------|-------------|
| `cron_create` | Create a scheduled job in `config/cron.yaml` |
| `cron_list` | List all scheduled jobs |
| `cron_delete` | Remove a job |
| `cron_update` | Update an existing job without replacing its identity |
| `cron_pause` | Disable a job and clear any pending one-off run |
| `cron_resume` | Re-enable a classified signal/silent job |
| `cron_run` | Queue a classified signal/silent job for one immediate scheduler run |

### Media (3 tools)

| Tool | Description |
|------|-------------|
| `image` | ImageMagick operations (resize, convert, compress) |
| `image_generate` | DALL-E 3 image generation |
| `tts` | Text-to-speech (OpenAI TTS, 6 voices) |

### Voice (2 tools)

| Tool | Description |
|------|-------------|
| `voice_call` | Vapi/Twilio call executor (approval path only; denied to agents) |
| `voice_call_status` | Get call transcript, duration, cost |

Requires `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `VAPI_ASSISTANT_ID`.

### Extras (6 tools)

| Tool | Description |
|------|-------------|
| `nodes_list` | List IoT devices |
| `nodes_control` | Send commands to devices |
| `canvas_create` | Create visual workspaces (diagrams, charts) |
| `canvas_update` | Update canvas content |
| `self_info` | Get current agent context (agent ID, topic, workspace) |
| `cross_agent_read` | Read-only access to other domains' files |

---

## Optional Integrations

All integrations beyond the core bot are optional. Keep their toolsets disabled
until credentials and services are configured; this avoids repeated
credential-error calls in a fresh installation.

### Email (read-only IMAP + approved Gmail send)

```bash
# Install the deployment-pinned read-only email MCP
claude mcp add --scope user --transport stdio email -- \
  /usr/bin/env MCP_EMAIL_READ_ONLY=true \
  npx -y @codefuturist/email-mcp@0.2.3 stdio

# Configure credentials
# See: https://github.com/codefuturist/email-mcp
mkdir -p ~/.config/email-mcp
# Create config.toml with your IMAP account settings; SMTP remains disabled.
```

The external email MCP is forced into read-only mode. Approved sends use the
bundled Gmail draft/SEND-trailer path; do not expose raw SMTP send tools to
normal agent turns.

### Browser Automation (Playwright)

```bash
# Production: the canonical deploy creates the isolated UID, installs pinned
# Chromium + first-host Linux dependencies, and starts the safe HTTP gateway.
sudo bash scripts/deploy-agents.sh

# Proves launch, navigation, safe tools, PNG/PDF output, coordinate control,
# the configured timezone, and browser state shared by sequential MCP clients.
npm run browser:smoke
```

### Flight Search

```bash
# Production setup installs and registers the optional server under the bot UID.
LETYCLAW_ENABLE_FLI_MCP=1 bash scripts/deploy-agents.sh
```

### Market Data (Alpha Vantage)

```bash
# Get a free API key: https://www.alphavantage.co/support/#api-key

# Store the key without putting it in shell history or MCP argv.
bash -c '
  set -eu
  install -d -m 700 "$HOME/.config/letyclaw"
  printf "Alpha Vantage API key: " >&2
  IFS= read -r -s key
  printf "\n" >&2
  umask 077
  printf "%s\n" "$key" > "$HOME/.config/letyclaw/marketdata-key"
'

# Production setup registers the redacting proxy under the bot UID.
LETYCLAW_ENABLE_MARKETDATA_MCP=1 bash scripts/deploy-agents.sh
```

The launcher pins `marketdata-mcp-server==0.3.1` and its production-verified
`mcp==1.28.1` SDK compatibility boundary.
Production deployment also performs an `initialize` + `tools/list` smoke under
the bot UID with a dummy key; it does not call a market-data tool or consume an
Alpha Vantage API request.

### Voice Calls (Vapi/Twilio)

Requires a [Vapi](https://vapi.ai) account with Twilio integration. Set these environment variables:

```bash
VAPI_API_KEY=your-vapi-key
VAPI_PHONE_NUMBER_ID=your-phone-id
VAPI_ASSISTANT_ID=your-assistant-id
VAPI_SERVER_URL=https://bot.example.com/voice/vapi
VAPI_SERVER_CREDENTIAL_ID=your-vapi-credential-id
```

Calls are stored before launch, correlated by a local request ID, monitored by
webhook plus API polling, and reported through a durable editable status when terminal. Configure the
separate webhook-service secret and inbound number routing as described in
[`docs/vapi-call-lifecycle.md`](docs/vapi-call-lifecycle.md). The live assistant
always identifies itself as automated; tasks that request human impersonation
are rejected before Vapi is called.

### Voice-to-Text (Whisper)

For voice message transcription in Telegram:

```bash
# Install whisper.cpp
git clone https://github.com/ggerganov/whisper.cpp /opt/whisper.cpp
cd /opt/whisper.cpp && make
bash models/download-ggml-model.sh base

# Set environment variable
export WHISPER_MODEL=/opt/whisper.cpp/models/ggml-base.bin
```

Also requires `ffmpeg` for audio conversion: `apt install ffmpeg` (Linux) or `brew install ffmpeg` (macOS).

### Claude Connectors (Gmail, Slack, Calendar, Notion, Drive)

Production connectors use a separately authenticated Claude home; the main bot
credential never inherits that connector session. Follow the credential
separation procedure in [`DEPLOY.md`](DEPLOY.md), then enable the connector
runtime explicitly:

```bash
LETYCLAW_ENABLE_CONNECTORS=1 bash scripts/deploy-agents.sh
```

---

## Agent Instructions

The default public setup generates one shared instruction file plus one
isolated routed file for every configured agent. Private topic facts are never
combined into the shared prompt.

### `CLAUDE.md` — Agent Instructions

`agents/unified/CLAUDE.md` and `agents/unified/domains/<agent-id>.md` are
generated from `config/letyclaw.yaml` and `agents/templates/`. The shared file
defines:
- Agent identity and behavior
- Shared safety and tool rules
- Memory system usage
- Topic IDs and names, but not topic-private instructions

At runtime, the bot appends only the active agent's routed file. It also exposes
enabled skill names/descriptions first; `skill_view` loads complete instructions
only when needed. After editing config or templates, regenerate and deploy:

```bash
npm run build
node dist/scripts/generate-claude-md.js
VAULT_PATH=$VAULT_PATH REPO_PATH=$(pwd) bash scripts/deploy-agents.sh
```

Advanced reviewed deployments may provide the complete `agents/source` layout;
the deployment helper prefers that layout when it is complete. Do not place
generated owner/domain facts under version control.

### `TOOLS.md` — Tool Usage Guide

Formatting rules, approval contracts, and integration guidance. The generator
embeds this contract in `CLAUDE.md`; the deployment helper also copies a
compatibility `TOOLS.md` beside it.

### Customizing for Your Domains

Create or customize topics as follows:

1. Edit `config/letyclaw.yaml` to define your agents and routing
2. Add `topics` metadata for custom per-domain facts (the runtime agents/routing schema is also supported)
3. Create domain directories in your vault: `mkdir -p ~/vault/{domain}/memory`
4. Regenerate the shared and routed files, review them, deploy, and restart

---

## Session Model

Sessions use a **reply-to-message** model for conversation continuity:

- **New message** (not a reply) → starts a fresh session OR continues the current session if within TTL
- **Reply to a bot message** → resumes the exact session that produced that message
- Sessions expire after `ttlHours` (default: 24 hours)
- Expired session replies gracefully fall back to a fresh session
- Session files are pruned after `pruneAfterDays` (default: 30 days)
- A separate secret-scrubbed recall index groups stable run/session lineage and is pruned by whole conversation on the same retention horizon

Session files are stored as JSON in `$SESSIONS_DIR`:

```
sessions/
  letyclaw-topic-2.json           # Unified continuity state for topic 2
  letyclaw-topic-3.json           # Unified continuity state for topic 3
  letyclaw-topic-4.json           # Unified continuity state for topic 4
  session-recall.sqlite       # Derived FTS recall index
  .subagents/                 # Capped worker records and verified process identity
```

The `letyclaw` filename prefix is the bot's physical session namespace. MCP session
tools authorize it through the current routed `agent_id` + `topic_id`; they do
not treat `letyclaw` as a cross-domain identity. `sessions_send` may resume only a
session ID already present in that topic's authoritative continuity file and
does not overwrite the bot's `currentSessionId`.

Each session file contains:
```json
{
  "currentSessionId": "abc-123-def",
  "createdAt": 1711900800000,
  "messageMap": {
    "456": "abc-123-def",
    "457": "abc-123-def"
  }
}
```

The `messageMap` links Telegram message IDs to Claude session IDs, enabling the reply-to-resume feature.

---

## Cron Jobs

Define scheduled jobs in `config/cron.yaml`. The bot checks for config changes every 60 seconds and hot-reloads.

```yaml
cron:
  timezone: "America/New_York"
  jobs:
    - id: daily-summary
      name: "Daily Summary"
      schedule: "0 21 * * *"        # 9 PM daily
      agent: personal
      topicId: 2
      prompt: "Summarize what happened today. Check memory for recent entries."
      delivery: signal
      maxTurns: 10
      enabled: true
```

Cron jobs run in isolated sessions (they never touch user conversation
sessions). `signal` jobs may deliver substantive results, `silent` jobs perform
maintenance without a final post, and `nudge` jobs are deliberately kept
disabled. Every job must declare its delivery policy.

---

## Logging

Structured JSONL logs in `logs/`:

```
logs/
  2026-03-31-personal-topic2.jsonl
  2026-03-31-work-topic3.jsonl
```

Events logged: `request`, `tool_call`, `tool_result`, `result`, `response`, `error`.

```bash
# Recent logs
tail -20 logs/$(date +%Y-%m-%d)-*.jsonl

# Find tool calls
grep tool_call logs/*.jsonl | python3 -m json.tool

# Errors only
grep '"event":"error"' logs/*.jsonl
```

Logs are auto-pruned after 7 days.

---

## Troubleshooting

### Bot not responding

```bash
# Check if running
# macOS:
launchctl list | grep letyclaw

# Linux:
systemctl status letyclaw-bot
journalctl -u letyclaw-bot -n 50 --no-pager
```

### Claude CLI errors

```bash
# Test Claude CLI directly
claude -p "say hello" --dangerously-skip-permissions

# Check authentication
claude auth status
```

### Session issues

```bash
# List active sessions
ls -la sessions/

# Force-clear all sessions (agents start fresh)
rm sessions/*.json
```

### MCP tools not visible

```bash
# Check registered MCP servers
claude mcp list

# Test letyclaw-tools
claude -p "use self_info tool to show current context" --dangerously-skip-permissions
```

### Agent instructions not picked up

```bash
# Verify CLAUDE.md is in the vault root
ls -la $VAULT_PATH/CLAUDE.md $VAULT_PATH/TOOLS.md

# Re-deploy on the VPS
VAULT_PATH=$VAULT_PATH REPO_PATH=$(pwd) bash scripts/deploy-agents.sh
```

### Rate limiting

If the bot stops responding after many rapid messages, check the rate limit config in `letyclaw.yaml`:

```yaml
rateLimit:
  maxRequests: 10    # Increase if needed
  windowMs: 60000
```

### Voice messages not transcribing

```bash
# Check whisper is installed
whisper-cli --help

# Check ffmpeg
ffmpeg -version

# Check model path
ls -la $WHISPER_MODEL
```

---

## Development

```bash
# Build
npm run build

# Type check only (no emit)
npm run build:check

# Run tests
npm test

# Watch mode
npm run test:watch

# Run locally
export TELEGRAM_BOT_TOKEN=your-token
export VAULT_PATH=$HOME/vault
npm start
```

### Project Structure

```
letyclaw/
  bot.ts              # Main entry point
  config.ts           # YAML config loader
  lib.ts              # Session management, formatting, utilities
  cron.ts             # Cron job scheduler
  types.ts            # TypeScript interfaces
  config/
    letyclaw.yaml     # Agent + routing config (local, ignored)
    letyclaw.example.yaml
    cron.yaml         # Scheduled jobs
  agents/
    templates/         # Generic instruction templates
    unified/CLAUDE.md  # Generated shared instructions (local)
    unified/domains/   # Generated routed domain instructions (local)
    source/domains/    # Optional reviewed overrides for advanced deployments
    shared/TOOLS.md    # Tool usage contract built into CLAUDE.md
  .claude/skills/      # Canonical on-demand skill packages
  tools/
    letyclaw-mcp/         # Scoped custom MCP server
      server.ts       # MCP server entry point
      types.ts        # Tool definitions
      tools/          # Tool implementations
        memory.ts, sessions.ts, skills.ts, messaging.ts,
        cron.ts, media.ts, voice.ts, connectors.ts, ...
  services/
    session-recall.ts # Durable secret-scrubbed conversation recall
    voice-relay.ts    # Vapi phone call handler
    health-webhook.ts # Health data integration
  scripts/
    setup-droplet.sh  # VPS initial setup
    setup-mcp.sh      # Register MCP servers
    setup-browser.sh  # Install Playwright
    deploy-agents.sh  # Deploy instructions to vault
  systemd/            # Linux systemd service files
  test/               # Test suite (vitest)
```

## License

MIT
