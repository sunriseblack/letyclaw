# Letyclaw

A self-hostable multi-agent Telegram bot powered by Claude. Define topics, configure integrations, and get a personal AI assistant that handles different aspects of your life through separate conversation threads.

## Features

- **Multi-topic routing** — each Telegram topic maps to a specialized agent domain
- **Session persistence** — reply to any bot message to resume that conversation
- **32 MCP tools** — memory search, messaging, cron scheduling, image generation, voice calls, browser automation
- **Template-based agent instructions** — generated from your config, not hardcoded
- **Telegram setup wizard** — configure everything through a conversational flow
- **Optional integrations** — email, Slack, browser, voice calls, flights, market data
- **Cron scheduler** — automated tasks with hot-reload
- **Structured logging** — JSONL logs with 7-day retention

## Prerequisites

- **Node.js 22+**
- **Claude Code CLI** — installed and authenticated (`npm install -g @anthropic-ai/claude-code && claude auth login`)
- **Telegram Bot Token** — from [@BotFather](https://t.me/BotFather)
- **Telegram Group** — with Topics enabled and your bot added as admin

> **Note:** Letyclaw uses the Claude Code CLI (which requires a Claude subscription) as its AI backbone. Alternatively, you can set `ANTHROPIC_API_KEY` in your `.env` to use the API directly.

## Quick Start

```bash
# Clone
git clone https://github.com/your-username/letyclaw.git
cd letyclaw
npm install

# Setup via Telegram wizard
TELEGRAM_BOT_TOKEN=your-token npx tsx setup.ts

# Or manually: copy and edit the example config
cp config/letyclaw.example.yaml config/letyclaw.yaml

# Build and run
npm run build
npm start
```

## Setup Options

### Option 1: Telegram Wizard (recommended)

```bash
TELEGRAM_BOT_TOKEN=your-token npx tsx setup.ts
```

Send a message to your bot. The wizard walks you through:
1. Your name and bot name
2. Timezone
3. Group detection and topic creation
4. Integration selection

### Option 2: Manual Config

1. Copy `config/letyclaw.example.yaml` → `config/letyclaw.yaml`
2. Edit with your Telegram IDs, topics, and preferences
3. Run `npx tsx scripts/generate-claude-md.ts` to generate agent instructions

### Option 3: Docker

```bash
cp .env.example .env  # Edit with your tokens
cp config/letyclaw.example.yaml config/letyclaw.yaml  # Edit
docker compose up -d
```

## Configuration

### Environment Variables

Create a `.env` file:

```bash
# Required
TELEGRAM_BOT_TOKEN=your-bot-token

# Optional — Claude CLI is the default AI backend
# Set this to use the Anthropic API directly instead
ANTHROPIC_API_KEY=your-api-key

# Optional paths (defaults are platform-appropriate)
VAULT_PATH=./vault
SESSIONS_DIR=./sessions
CLAUDE_MODEL=claude-sonnet-4-6

# Optional integrations
OPENAI_API_KEY=          # For DALL-E image generation and TTS
VAPI_API_KEY=            # For AI voice calls
VAPI_PHONE_NUMBER_ID=
VAPI_ASSISTANT_ID=
ALPHA_VANTAGE_API_KEY=   # For market data
```

### Topic Config (`config/letyclaw.yaml`)

```yaml
agents:
  defaults:
    maxTurns: 10
    session:
      ttlHours: 24
      pruneAfterDays: 30
  list:
    - id: personal
      name: "Personal"
      maxTurns: 50
    - id: work
      name: "Work"
      maxTurns: 50

channels:
  telegram:
    chatId: -100YOUR_GROUP_ID
    accounts:
      - id: main
        allowFrom: [YOUR_USER_ID]
    routing:
      - agent: personal
        threadId: 2
      - agent: work
        threadId: 3
```

## Architecture

```
Telegram Message → bot.ts → Route by topic ID → Agent config
                                                     ↓
                                              Claude CLI subprocess
                                              (--resume for sessions)
                                                     ↓
                                              MCP tools available:
                                              • Memory (BM25 search)
                                              • Messaging (buttons, polls)
                                              • Cron (self-scheduling)
                                              • Media (images, TTS)
                                              • Voice (AI phone calls)
                                              • Browser (Playwright)
                                                     ↓
                                              Response → Telegram
```

### Key Files

| File | Purpose |
|------|---------|
| `bot.ts` | Main entry — Telegram bot, session management, Claude CLI |
| `config.ts` | YAML config loader |
| `lib.ts` | Session management, markdown conversion, message splitting |
| `cron.ts` | Cron job scheduler with hot-reload |
| `setup.ts` | Telegram setup wizard |
| `tools/letyclaw-mcp/` | 32 MCP tools (memory, sessions, messaging, cron, media, voice, extras) |
| `scripts/generate-claude-md.ts` | Template engine for agent instructions |

## Integrations

All integrations are optional. If the required API key isn't set, the integration is silently disabled.

| Integration | Required Env Var | What It Does |
|---|---|---|
| Email | `EMAIL_MCP_CONFIG` | Gmail/IMAP access via MCP |
| Slack | (via `claude.ai Slack`) | Read/send Slack messages |
| Browser | (auto-detected) | Web browsing via Playwright |
| Voice | `VAPI_API_KEY` | AI-powered phone calls |
| Flights | `fli-mcp` installed | Google Flights search |
| Market Data | `ALPHA_VANTAGE_API_KEY` | Stock/forex/crypto data |

## MCP Tools (32)

- **Memory (5):** search, get, save, delete, list
- **Sessions (7):** list, history, send, spawn sub-agents, yield, status
- **Messaging (6):** send, buttons, polls, reactions, typing, edit
- **Cron (3):** create, list, delete scheduled tasks
- **Media (3):** image processing, DALL-E generation, TTS
- **Voice (2):** AI phone calls, call status
- **Extras (6):** devices, canvas, agent context, cross-agent read

## Development

```bash
npm run build        # Compile TypeScript
npm test             # Run test suite
npm run test:watch   # Watch mode
npm run build:check  # Type-check without emitting
```

## Deployment

See [DEPLOY.md](DEPLOY.md) for server deployment instructions.

### Systemd (Linux)

```bash
sudo cp systemd/letyclaw-bot.service /etc/systemd/system/
sudo systemctl enable letyclaw-bot
sudo systemctl start letyclaw-bot
```

### Docker

```bash
docker compose up -d
```

## Session Model

- **New message** → fresh Claude CLI session with topic-specific prompt
- **Reply to bot message** → resumes the session that produced that message
- **Session TTL** → 24h (configurable), expired sessions fall back gracefully
- **Session pruning** → old sessions cleaned up after 30 days

## License

MIT
