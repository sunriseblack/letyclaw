import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "js-yaml";
import type { LoadedConfig, AgentConfig } from "./types.js";

// Project root is one level up from dist/ at runtime
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname.includes("/dist") ? join(__dirname, "..") : __dirname;

// ── Tool gate ───────────────────────────────────────────────
// Tools that must never fire autonomously from the agent loop. The approved
// SEND-button executor calls Gmail/voice handlers in-process, so denying these
// CLI tools enforces draft/approve/commit without removing approved actions.
// Playwright's generic code/network tools are RCE- or credential-equivalent;
// the audited browser gateway provides the safe browsing surface instead.
//
// KEEP IN SYNC with the defense-in-depth copy in
// tools/letyclaw-mcp/tools/sessions.ts.
export const DISALLOWED_TOOLS: readonly string[] = [
  "mcp__letyclaw-tools__gmail_send",
  "mcp__letyclaw-tools__gmail_send_draft",
  "mcp__letyclaw-tools__message_send",
  "mcp__letyclaw-tools__message_typing",
  "mcp__letyclaw-tools__voice_call",
  "mcp__playwright__browser_evaluate",
  "mcp__playwright__browser_network_request",
  "mcp__playwright__browser_network_requests",
  "mcp__playwright__browser_run_code",
  "mcp__playwright__browser_run_code_unsafe",
];

export const LETYCLAW_TOOLSETS: Record<string, readonly string[]> = {
  memory: ["memory_search", "memory_get", "memory_save", "memory_delete", "memory_list", "memory_related"],
  sessions: ["sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "sessions_yield", "subagents", "session_status", "session_search", "sessions_browse", "session_context"],
  messaging: ["message_send", "message_buttons", "message_poll", "message_react", "message_typing", "message_edit", "message_document"],
  cron: ["cron_create", "cron_list", "cron_delete", "cron_update", "cron_pause", "cron_resume", "cron_run"],
  media: ["image", "image_generate", "tts"],
  voice: ["voice_call", "voice_call_status"],
  extras: ["nodes_list", "nodes_control", "canvas_create", "canvas_update", "self_info", "cross_agent_read"],
  gdrive: ["gdrive_list", "gdrive_search", "gdrive_read", "gdrive_read_by_id"],
  ticktick: [
    "ticktick_list_projects", "ticktick_get_project", "ticktick_get_task",
    "ticktick_create_task", "ticktick_update_task", "ticktick_complete_task", "ticktick_delete_task",
  ],
  gmail: [
    "gmail_send", "gmail_create_draft", "gmail_send_draft", "gmail_list_drafts",
    "gmail_get_draft", "gmail_update_draft", "gmail_delete_draft",
  ],
  loops: ["loop_open", "loop_update", "loop_close", "loop_list", "loop_get", "loop_sync_ticktick"],
  connectors: ["connector_exec"],
  browser: ["browser_secret_names"],
  skills: ["skills_list", "skill_view"],
};

const ALL_LETYCLAW_TOOLS = Object.values(LETYCLAW_TOOLSETS).flat();

export interface ToolScopeOptions {
  allowSendTools?: boolean;
  enabledToolsets?: readonly string[];
  disabledToolsets?: readonly string[];
  disabledTools?: readonly string[];
}

function asStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return out.length ? [...new Set(out)] : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function qualifyLetyclawTool(tool: string): string {
  if (tool.startsWith("mcp__")) return tool;
  return `mcp__letyclaw-tools__${tool}`;
}

function toolsForToolsets(toolsets: readonly string[] | undefined): string[] {
  const tools: string[] = [];
  for (const name of toolsets ?? []) {
    const members = LETYCLAW_TOOLSETS[name.trim()];
    if (members) tools.push(...members);
  }
  return tools.map(qualifyLetyclawTool);
}

/**
 * Return the deny-list for one Claude spawn. Normal turns keep irreversible
 * sends blocked. The post-approval executor may enable Gmail send tools, while
 * paid voice calls remain on their dedicated in-process approval path.
 */
export function disallowedToolsFor(options: boolean | ToolScopeOptions = false): readonly string[] {
  const opts: ToolScopeOptions = typeof options === "boolean" ? { allowSendTools: options } : options;
  const disallowed = new Set<string>(DISALLOWED_TOOLS);

  if (opts.allowSendTools) {
    disallowed.delete("mcp__letyclaw-tools__gmail_send");
    disallowed.delete("mcp__letyclaw-tools__gmail_send_draft");
  }

  const enabledToolsets = asStringList(opts.enabledToolsets);
  if (enabledToolsets) {
    const allowed = new Set(toolsForToolsets(enabledToolsets));
    for (const tool of ALL_LETYCLAW_TOOLS) {
      const qualified = qualifyLetyclawTool(tool);
      if (!allowed.has(qualified)) disallowed.add(qualified);
    }
  }

  for (const tool of toolsForToolsets(asStringList(opts.disabledToolsets))) {
    disallowed.add(tool);
  }
  for (const tool of asStringList(opts.disabledTools) ?? []) {
    disallowed.add(qualifyLetyclawTool(tool));
  }

  return [...disallowed];
}

export function resolveBotIdentity(
  bot: { name?: unknown; owner?: unknown; timezone?: unknown } | undefined,
  cronTimezone?: unknown,
): { botName: string; ownerName: string; timezone: string } {
  return {
    botName: asNonEmptyString(bot?.name) ?? "Letyclaw",
    ownerName: asNonEmptyString(bot?.owner) ?? "Owner",
    timezone: asNonEmptyString(bot?.timezone) ?? asNonEmptyString(cronTimezone) ?? "UTC",
  };
}

// ── Raw YAML shape ───────────────────────────────────────────────────

interface RawAgentDefaults {
  maxTurns?: number;
  session?: { ttlHours?: number; pruneAfterDays?: number };
  timeouts?: { claudeTotal?: number; claudeMaxContinuations?: number };
  rateLimit?: { maxRequests?: number; windowMs?: number };
}

interface RawAgent {
  id: string;
  name: string;
  maxTurns?: number;
  skills?: string[];
  enabledToolsets?: string[];
  disabledToolsets?: string[];
  disabledTools?: string[];
}

interface RawConfig {
  bot?: {
    name?: string;
    owner?: string;
    timezone?: string;
  };
  agents?: {
    defaults?: RawAgentDefaults;
    list?: RawAgent[];
  };
  channels?: {
    telegram?: {
      chatId?: string | number;
      accounts?: Array<{ allowFrom?: number[] }>;
      routing?: Array<{ threadId: number; agent: string }>;
    };
  };
}

interface RawCronConfig {
  cron?: {
    timezone?: string;
    jobs?: Array<{
      id: string;
      name?: string;
      schedule: string;
      agent: string;
      topicId?: number;
      prompt: string;
      enabled?: boolean;
      delivery?: "signal" | "silent" | "nudge";
      runNow?: boolean;
      maxTurns?: number;
      // Optional ISO-8601 expiry. After this instant, the job is skipped
      // and pruned from cron.yaml. Used by agent-created "watch" crons.
      expiresAt?: string;
      // Optional code-owned probe. Runtime validation restricts this to the
      // bundled cron precheck script and matching agent/topic arguments.
      precheck?: string;
      // Treat a non-skip, zero-tool run as a failed execution.
      expectsTools?: boolean;
      skills?: string[];
      enabledToolsets?: string[];
      disabledToolsets?: string[];
      disabledTools?: string[];
    }>;
  };
}

export interface LoadConfigOptions {
  configPath?: string;
  cronConfigPath?: string;
}

// ── Loader ───────────────────────────────────────────────────────────

function loadYaml(path: string): unknown {
  try {
    return YAML.load(readFileSync(path, "utf8")) || {};
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: could not load ${path}: ${msg}`);
    return {};
  }
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const configPath = options.configPath ?? (
    existsSync(join(PROJECT_ROOT, "config/letyclaw.yaml"))
      ? join(PROJECT_ROOT, "config/letyclaw.yaml")
      : join(PROJECT_ROOT, "config/letyclaw.example.yaml")
  );
  const raw = loadYaml(configPath) as RawConfig;

  const defaults = raw.agents?.defaults ?? {};

  // Build agent list with defaults applied
  const agentList: AgentConfig[] = (raw.agents?.list ?? []).map((a) => ({
    ...a,
    maxTurns: a.maxTurns ?? defaults.maxTurns ?? 10,
    skills: asStringList(a.skills),
    enabledToolsets: asStringList(a.enabledToolsets),
    disabledToolsets: asStringList(a.disabledToolsets),
    disabledTools: asStringList(a.disabledTools),
  }));

  // Build agent lookup by id
  const agentsById: Record<string, AgentConfig> = {};
  for (const a of agentList) {
    agentsById[a.id] = a;
  }

  // Build topicId → agent routing map from telegram routing
  const routing: Record<number, { id: string; name: string; maxTurns: number }> = {};
  const routes = raw.channels?.telegram?.routing ?? [];
  for (const r of routes) {
    const agent = agentsById[r.agent];
    if (agent) {
      routing[r.threadId] = {
        id: agent.id,
        name: agent.name,
        maxTurns: agent.maxTurns,
      };
    }
  }

  // Session config
  const session = {
    ttlHours: defaults.session?.ttlHours ?? 24,
    pruneAfterDays: defaults.session?.pruneAfterDays ?? 30,
  };

  // Timeout config
  const timeouts = {
    claudeTotal: defaults.timeouts?.claudeTotal ?? 1200000,
    claudeMaxContinuations: defaults.timeouts?.claudeMaxContinuations ?? 2,
  };

  // Rate limit config
  const rateLimit = {
    maxRequests: defaults.rateLimit?.maxRequests ?? 10,
    windowMs: defaults.rateLimit?.windowMs ?? 60000,
  };

  // Telegram config
  const telegram = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: raw.channels?.telegram?.chatId
      ? Number(raw.channels.telegram.chatId)
      : Number(process.env.TELEGRAM_GROUP_ID),
    allowedUser: Number(
      raw.channels?.telegram?.accounts?.[0]?.allowFrom?.[0] ||
        process.env.TELEGRAM_ALLOW_USER,
    ),
  };

  // Cron config
  const cronConfigPath = options.cronConfigPath ?? (
    existsSync(join(PROJECT_ROOT, "config/cron.yaml"))
      ? join(PROJECT_ROOT, "config/cron.yaml")
      : join(PROJECT_ROOT, "config/cron.example.yaml")
  );
  const cronRaw = loadYaml(cronConfigPath) as RawCronConfig;
  const cronConfig = {
    timezone: cronRaw?.cron?.timezone || "UTC",
    // Keep disabled jobs in the loaded config: the scheduler reports their
    // state, enforces nudge policy, and consumes explicit runNow requests.
    jobs: (cronRaw?.cron?.jobs ?? []).map((job) => ({
      ...job,
      skills: asStringList(job.skills),
      enabledToolsets: asStringList(job.enabledToolsets),
      disabledToolsets: asStringList(job.disabledToolsets),
      disabledTools: asStringList(job.disabledTools),
    })),
  };
  const identity = resolveBotIdentity(raw.bot, cronConfig.timezone);

  return {
    ...identity,
    agents: agentsById,
    routing,
    session,
    timeouts,
    rateLimit,
    telegram,
    cron: cronConfig,
    vaultPath: process.env.VAULT_PATH || "/root/vault",
    whisperModel:
      process.env.WHISPER_MODEL ||
      "/opt/whisper.cpp/models/ggml-base.bin",
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    effort: process.env.CLAUDE_EFFORT || "max",
    claudePath:
      process.env.CLAUDE_PATH ||
      "claude",
    sessionsDir: process.env.SESSIONS_DIR || "/root/letyclaw/sessions",
  };
}
