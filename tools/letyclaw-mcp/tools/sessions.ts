/**
 * Session tools — list, inspect, spawn sub-agents, manage conversation sessions.
 *
 * Sessions live in: {SESSIONS_DIR}/{agentId}-topic-{topicId}.json
 * Sub-agents are tracked in-memory (spawned Claude CLI processes).
 */
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import type { ChildProcess } from "child_process";
import { spawn } from "child_process";
import { ok, error, VAULT, AGENT, SESSIONS_DIR } from "./_util.js";
import type { MCPToolDefinition, MCPResponse } from "../types.js";

const CLAUDE_PATH = (): string => process.env.CLAUDE_PATH || "claude";
const MODEL = (): string => process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// ── Sub-agent tracking (in-memory) ───────────────────────────────────

interface SubagentEntry {
  process: ChildProcess;
  agentId: string;
  prompt: string;
  startedAt: number;
  status: string;
  stdout: string;
  stderr: string;
  exitCode?: number | null;
  finishedAt?: number;
  yieldResult?: string;
}

const subagents = new Map<string, SubagentEntry>();
let subagentCounter = 0;
const SUBAGENT_MAX_AGE_MS = 30 * 60 * 1000; // prune after 30 minutes

function pruneSubagents(): void {
  const cutoff = Date.now() - SUBAGENT_MAX_AGE_MS;
  for (const [id, entry] of subagents) {
    if (entry.status !== "running" && (entry.finishedAt || 0) < cutoff) {
      subagents.delete(id);
    }
  }
}

function sessionFile(agentId: string, topicId: string): string {
  return join(SESSIONS_DIR(), `${agentId}-topic-${topicId}.json`);
}

// ── Tool definitions ──────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "sessions_list",
    description:
      "List all active sessions. Returns session IDs, agent IDs, topic IDs, creation times, and age.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Filter by agent ID (optional)" },
      },
    },
  },
  {
    name: "sessions_history",
    description:
      "Get metadata and message map for a specific session. Shows which messages belong to which session.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        topic_id: { type: "string", description: "Topic ID" },
      },
      required: ["agent_id", "topic_id"],
    },
  },
  {
    name: "sessions_send",
    description:
      "Send a message to an existing Claude CLI session (--resume). Returns the response. Use for continuing conversations with a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Claude CLI session ID to resume" },
        message: { type: "string", description: "Message to send" },
        agent_id: { type: "string", description: "Agent ID (determines working directory)" },
        max_turns: { type: "number", description: "Max turns (default: 5)" },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "sessions_spawn",
    description:
      "Spawn a sub-agent — a new Claude CLI process running independently. Returns a sub-agent ID for tracking. The sub-agent runs with its own session and can use all tools available to the parent agent.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task/prompt for the sub-agent" },
        agent_id: { type: "string", description: "Agent ID (determines workspace, default: current)" },
        model: { type: "string", description: "Model override (default: same as parent)" },
        max_turns: { type: "number", description: "Max turns (default: 10)" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "sessions_yield",
    description:
      "Signal that a sub-agent task is complete. Marks the sub-agent as done and returns its final output. Used by sub-agents to return control to the parent.",
    inputSchema: {
      type: "object",
      properties: {
        subagent_id: { type: "string", description: "Sub-agent ID to yield" },
        result: { type: "string", description: "Final result message" },
      },
      required: ["subagent_id"],
    },
  },
  {
    name: "subagents",
    description:
      "List all spawned sub-agents with their status (running, completed, failed), runtime, and output preview.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "session_status",
    description:
      "Get detailed status of a specific session — current session ID, age, message count, last activity.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        topic_id: { type: "string", description: "Topic ID" },
      },
      required: ["agent_id", "topic_id"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<MCPResponse>> = {
  async sessions_list({ agent_id }: Record<string, unknown>): Promise<MCPResponse> {
    if (!existsSync(SESSIONS_DIR())) return ok("No sessions directory found");

    const files = readdirSync(SESSIONS_DIR()).filter((f) => f.endsWith(".json"));
    const sessions: Record<string, unknown>[] = [];

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR(), file), "utf8")) as Record<string, unknown>;
        // Parse agent-topic from filename: {agentId}-topic-{topicId}.json
        const match = basename(file, ".json").match(/^(.+)-topic-(\d+)$/);
        if (!match) continue;
        const [, fileAgent, fileTopic] = match;
        if (agent_id && fileAgent !== agent_id) continue;

        const ageMs = Date.now() - ((data.createdAt as number) || 0);
        const ageHours = Math.round(ageMs / 3600000 * 10) / 10;
        const messageMap = data.messageMap as Record<string, unknown> | undefined;
        const messageCount = messageMap ? Object.keys(messageMap).length : 0;

        sessions.push({
          agent: fileAgent,
          topic: fileTopic,
          sessionId: (data.currentSessionId as string) || null,
          ageHours,
          messageCount,
          createdAt: data.createdAt ? new Date(data.createdAt as number).toISOString() : null,
        });
      } catch { /* ignore */ }
    }

    if (sessions.length === 0) return ok("No active sessions");
    return ok(JSON.stringify(sessions, null, 2));
  },

  async sessions_history({ agent_id, topic_id }: Record<string, unknown>): Promise<MCPResponse> {
    const file = sessionFile(agent_id as string, topic_id as string);
    if (!existsSync(file)) return error(`No session file for ${agent_id}/topic-${topic_id}`);

    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const ageMs = Date.now() - ((data.createdAt as number) || 0);

    return ok(JSON.stringify({
      currentSessionId: data.currentSessionId,
      createdAt: data.createdAt ? new Date(data.createdAt as number).toISOString() : null,
      ageHours: Math.round(ageMs / 3600000 * 10) / 10,
      messageCount: data.messageMap ? Object.keys(data.messageMap as Record<string, unknown>).length : 0,
      messageMap: (data.messageMap as Record<string, unknown>) || {},
    }, null, 2));
  },

  async sessions_send({ session_id, message, agent_id, max_turns = 5 }: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");

    const cwd = join(VAULT(), agentId);
    if (!existsSync(cwd)) return error(`Agent workspace not found: ${agentId}`);

    const args = [
      "-p", message as string,
      "--model", MODEL(),
      "--output-format", "stream-json",
      "--max-turns", String(max_turns),
      "--dangerously-skip-permissions",
      "--resume", session_id as string,
    ];

    try {
      const result = await runClaude(cwd, args, 120000);
      const parsed = parseResult(result);
      return ok(JSON.stringify({
        sessionId: parsed.sessionId,
        response: parsed.text,
      }, null, 2));
    } catch (err) {
      return error(`sessions_send failed: ${(err as Error).message}`);
    }
  },

  async sessions_spawn({ prompt, agent_id, model, max_turns = 10 }: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");

    const cwd = join(VAULT(), agentId);
    if (!existsSync(cwd)) return error(`Agent workspace not found: ${agentId}`);

    const id = `sub-${++subagentCounter}-${Date.now()}`;
    const args = [
      "-p", prompt as string,
      "--model", (model as string) || MODEL(),
      "--output-format", "stream-json",
      "--max-turns", String(max_turns),
      "--dangerously-skip-permissions",
    ];

    const child = spawn(CLAUDE_PATH(), args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    child.stdin!.end();

    let stdout = "", stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += d; });
    child.stderr!.on("data", (d: Buffer) => { stderr += d; });

    const entry: SubagentEntry = {
      process: child,
      agentId,
      prompt: (prompt as string).slice(0, 200),
      startedAt: Date.now(),
      status: "running",
      stdout: "",
      stderr: "",
    };
    subagents.set(id, entry);

    child.on("close", (code) => {
      entry.status = code === 0 ? "completed" : "failed";
      entry.stdout = stdout;
      entry.stderr = stderr;
      entry.exitCode = code;
      entry.finishedAt = Date.now();
    });

    child.on("error", (err) => {
      entry.status = "failed";
      entry.stderr = err.message;
      entry.finishedAt = Date.now();
    });

    // Kill after 5 minutes to prevent runaway sub-agents
    setTimeout(() => {
      if (entry.status === "running") {
        child.kill();
        entry.status = "timeout";
        entry.finishedAt = Date.now();
      }
    }, 300000);

    return ok(JSON.stringify({
      subagent_id: id,
      status: "spawned",
      agent: agentId,
      prompt: (prompt as string).slice(0, 200),
    }, null, 2));
  },

  async sessions_yield({ subagent_id, result }: Record<string, unknown>): Promise<MCPResponse> {
    const entry = subagents.get(subagent_id as string);
    if (!entry) return error(`Sub-agent '${subagent_id}' not found`);

    if (entry.status === "running") {
      entry.process.kill();
      entry.status = "yielded";
      entry.finishedAt = Date.now();
    }

    if (result) entry.yieldResult = result as string;

    return ok(JSON.stringify({
      subagent_id,
      status: entry.status,
      runtime_ms: (entry.finishedAt || Date.now()) - entry.startedAt,
      result: (result as string) || extractResult(entry),
    }, null, 2));
  },

  async subagents(): Promise<MCPResponse> {
    pruneSubagents();
    if (subagents.size === 0) return ok("No sub-agents have been spawned");

    const list: Record<string, unknown>[] = [];
    for (const [id, entry] of subagents) {
      const runtime = ((entry.finishedAt || Date.now()) - entry.startedAt) / 1000;
      list.push({
        id,
        agent: entry.agentId,
        status: entry.status,
        runtime_seconds: Math.round(runtime),
        prompt: entry.prompt,
        result_preview: entry.status !== "running"
          ? extractResult(entry).slice(0, 200)
          : "(still running)",
      });
    }

    return ok(JSON.stringify(list, null, 2));
  },

  async session_status({ agent_id, topic_id }: Record<string, unknown>): Promise<MCPResponse> {
    const file = sessionFile(agent_id as string, topic_id as string);
    if (!existsSync(file)) return error(`No session for ${agent_id}/topic-${topic_id}`);

    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const ageMs = Date.now() - ((data.createdAt as number) || 0);
    const messageMap = data.messageMap as Record<string, unknown> | undefined;
    const messages = messageMap ? Object.keys(messageMap) : [];
    const lastMsg = messages.length > 0 ? Math.max(...messages.map(Number)) : null;

    return ok(JSON.stringify({
      agent: agent_id,
      topic: topic_id,
      currentSessionId: data.currentSessionId,
      createdAt: data.createdAt ? new Date(data.createdAt as number).toISOString() : null,
      ageHours: Math.round(ageMs / 3600000 * 10) / 10,
      messageCount: messages.length,
      lastMessageId: lastMsg,
      isExpired: ageMs > 24 * 3600000,
    }, null, 2));
  },
};

// ── Internal helpers ──────────────────────────────────────────────────

interface ClaudeResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runClaude(cwd: string, args: string[], timeout = 120000): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_PATH(), args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    child.stdin!.end();
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += d; });
    child.stderr!.on("data", (d: Buffer) => { stderr += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, timeout);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

interface ParsedResult {
  sessionId: string | null;
  text: string;
}

function parseResult(result: ClaudeResult): ParsedResult {
  const lines = (result.stdout || "").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (obj.type === "result") return { sessionId: obj.session_id as string, text: (obj.result as string) || "" };
      if (obj.type === "assistant") {
        const message = obj.message as Record<string, unknown> | undefined;
        const contentArray = message?.content as Array<Record<string, unknown>> | undefined;
        if (contentArray) {
          const text = contentArray.filter((b) => b.type === "text").map((b) => b.text as string).join("\n");
          if (text) return { sessionId: obj.session_id as string, text };
        }
      }
    } catch { /* ignore */ }
  }
  return { sessionId: null, text: result.stdout?.slice(0, 500) || "(no output)" };
}

function extractResult(entry: SubagentEntry): string {
  if (entry.yieldResult) return entry.yieldResult;
  if (entry.stdout) {
    try {
      return parseResult({ code: null, stdout: entry.stdout, stderr: "" }).text;
    } catch { /* ignore */ }
  }
  return entry.stderr || "(no output)";
}
