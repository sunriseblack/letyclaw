import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import YAML from "js-yaml";
import type { LoadedConfig, AgentConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Raw YAML shape ───────────────────────────────────────────────────

interface RawAgentDefaults {
  maxTurns?: number;
  session?: { ttlHours?: number; pruneAfterDays?: number };
  timeouts?: { claudeTotal?: number; claudeNoOutput?: number };
  rateLimit?: { maxRequests?: number; windowMs?: number };
}

interface RawAgent {
  id: string;
  name: string;
  maxTurns?: number;
}

interface RawConfig {
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
      maxTurns?: number;
    }>;
  };
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

export function loadConfig(): LoadedConfig {
  const configPath = existsSync(join(__dirname, "config/letyclaw.yaml"))
    ? join(__dirname, "config/letyclaw.yaml")
    : join(__dirname, "config/letyclaw.example.yaml");
  const raw = loadYaml(configPath) as RawConfig;

  const defaults = raw.agents?.defaults ?? {};

  // Build agent list with defaults applied
  const agentList: AgentConfig[] = (raw.agents?.list ?? []).map((a) => ({
    ...a,
    maxTurns: a.maxTurns ?? defaults.maxTurns ?? 10,
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
    claudeTotal: defaults.timeouts?.claudeTotal ?? 600000,
    claudeNoOutput: defaults.timeouts?.claudeNoOutput ?? 180000,
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
  const cronConfigPath = existsSync(join(__dirname, "config/cron.yaml"))
    ? join(__dirname, "config/cron.yaml")
    : join(__dirname, "config/cron.example.yaml");
  const cronRaw = loadYaml(cronConfigPath) as RawCronConfig;
  const cronConfig = {
    timezone: cronRaw?.cron?.timezone || "UTC",
    jobs: (cronRaw?.cron?.jobs ?? []).filter((j) => j.enabled !== false),
  };

  return {
    agents: agentsById,
    routing,
    session,
    timeouts,
    rateLimit,
    telegram,
    cron: cronConfig,
    vaultPath: process.env.VAULT_PATH || join(homedir(), "vault"),
    whisperModel:
      process.env.WHISPER_MODEL ||
      "whisper-cli",
    model: process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    claudePath:
      process.env.CLAUDE_PATH ||
      "claude",
    sessionsDir: process.env.SESSIONS_DIR || join(process.cwd(), "sessions"),
  };
}
