#!/usr/bin/env node
/**
 * letyclaw-tools MCP Server
 *
 * Custom tool server for letyclaw-bot that provides a suite of OpenClaw-equivalent
 * tools to Claude CLI via the Model Context Protocol (MCP). The authoritative
 * count is logged at startup (allDefinitions.length); the per-module figures
 * below are a guide, not a contract.
 *
 * Tools are organized into focused modules:
 *   Memory (6)    — BM25 search, CRUD over agent memory files
 *   Sessions (10) — List, inspect, search logs, spawn sub-agents, manage conversations
 *   Messaging (7) — Rich Telegram messaging (buttons, polls, reactions, file/document send)
 *   Cron (7)      — Agent self-scheduling via cron.yaml
 *   Media (3)     — Image processing, DALL-E generation, TTS
 *   Voice (2)     — AI-powered phone calls via Vapi (Deepgram STT + Claude + TTS)
 *   Extras (6)    — Devices, canvas, agent context
 *   GDrive (4)    — Google Drive access via configured rclone remotes
 *   TickTick (7)  — Task tracker CRUD via TickTick Open API (OAuth2)
 *   Gmail (7)     — Send/draft mail via Gmail API (bypasses blocked SMTP on droplet)
 *   Loops (6)     — Open-loops ledger: durable, updatable "what's pending" state (+ TickTick mirror)
 *   Connectors (1)— Authenticated Claude connector execution
 *   Browser (1)   — Protected Playwright credential-alias discovery
 *   Skills (2)    — Progressive catalog + complete on-demand skill reads
 *
 * Environment variables (passed from bot.js via Claude CLI):
 *   LETYCLAW_AGENT_ID        — Current agent identifier
 *   LETYCLAW_TOPIC_ID        — Current Telegram topic/thread ID
 *   LETYCLAW_VAULT_PATH      — Path to vault (agent workspaces)
 *   LETYCLAW_SESSIONS_DIR    — Path to session files
 *   LETYCLAW_CHAT_ID         — Telegram chat/group ID
 *   LETYCLAW_PROJECT_ROOT    — Path to letyclaw-bot project root
 *   LETYCLAW_SKILLS          — JSON array of skills enabled for this run
 *   TELEGRAM_BOT_TOKEN   — Telegram bot token (for messaging tools)
 *   OPENAI_API_KEY       — OpenAI API key (for image_generate, tts)
 *   VAPI_API_KEY         — Vapi API key (for voice_call)
 *   VAPI_PHONE_NUMBER_ID — Vapi phone number ID (for voice_call)
 *   VAPI_ASSISTANT_ID    — Vapi assistant ID (for voice_call)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { MCPToolDefinition, MCPHandler } from "./types.js";

import { definitions as memoryDefs, handlers as memoryHandlers } from "./tools/memory.js";
import { definitions as sessionDefs, handlers as sessionHandlers } from "./tools/sessions.js";
import { definitions as messagingDefs, handlers as messagingHandlers } from "./tools/messaging.js";
import { definitions as cronDefs, handlers as cronHandlers } from "./tools/cron.js";
import { definitions as mediaDefs, handlers as mediaHandlers } from "./tools/media.js";
import { definitions as extrasDefs, handlers as extrasHandlers } from "./tools/extras.js";
import { definitions as voiceDefs, handlers as voiceHandlers } from "./tools/voice.js";
import { definitions as gdriveDefs, handlers as gdriveHandlers } from "./tools/gdrive.js";
import { definitions as ticktickDefs, handlers as ticktickHandlers } from "./tools/ticktick.js";
import { definitions as gmailDefs, handlers as gmailHandlers } from "./tools/gmail.js";
import { definitions as loopsDefs, handlers as loopsHandlers } from "./tools/loops.js";
import { definitions as connectorDefs, handlers as connectorHandlers } from "./tools/connectors.js";
import { definitions as browserDefs, handlers as browserHandlers } from "./tools/browser.js";
import { definitions as skillDefs, handlers as skillHandlers } from "./tools/skills.js";

// ── Merge all definitions and handlers ────────────────────────────────

const allDefinitions: MCPToolDefinition[] = [
  ...memoryDefs,
  ...sessionDefs,
  ...messagingDefs,
  ...cronDefs,
  ...mediaDefs,
  ...extrasDefs,
  ...voiceDefs,
  ...gdriveDefs,
  ...ticktickDefs,
  ...gmailDefs,
  ...loopsDefs,
  ...connectorDefs,
  ...browserDefs,
  ...skillDefs,
];

const allHandlers: Record<string, MCPHandler> = {
  ...memoryHandlers,
  ...sessionHandlers,
  ...messagingHandlers,
  ...cronHandlers,
  ...mediaHandlers,
  ...extrasHandlers,
  ...voiceHandlers,
  ...gdriveHandlers,
  ...ticktickHandlers,
  ...gmailHandlers,
  ...loopsHandlers,
  ...connectorHandlers,
  ...browserHandlers,
  ...skillHandlers,
};

// ── Create MCP Server ─────────────────────────────────────────────────

const server = new Server(
  {
    name: "letyclaw-tools",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// ── List tools ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allDefinitions };
});

// ── Call tools ────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const handler = allHandlers[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Error: Unknown tool '${name}'` }],
      isError: true,
    };
  }

  try {
    return await handler(args || {});
  } catch (err) {
    console.error(`[letyclaw-tools] ${name} error:`, err);
    return {
      content: [{ type: "text", text: `Error in ${name}: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[letyclaw-tools] MCP server started — ${allDefinitions.length} tools registered`);
  console.error(`[letyclaw-tools] Agent: ${process.env.LETYCLAW_AGENT_ID || "(none)"}, Topic: ${process.env.LETYCLAW_TOPIC_ID || "(none)"}`);
}

main().catch((err: unknown) => {
  console.error("[letyclaw-tools] Fatal:", err);
  process.exit(1);
});
