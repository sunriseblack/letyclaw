// ── Config types ─────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  maxTurns: number;
}

export type RoutingEntry = AgentConfig;

export interface SessionConfig {
  ttlHours: number;
  pruneAfterDays: number;
}

export interface TimeoutConfig {
  claudeTotal: number;
  claudeNoOutput: number;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface TelegramConfig {
  token: string | undefined;
  chatId: number;
  allowedUser: number;
}

export interface CronJobConfig {
  id: string;
  name?: string;
  schedule: string;
  agent: string;
  topicId?: number;
  prompt: string;
  enabled?: boolean;
  maxTurns?: number;
}

export interface CronConfig {
  timezone: string;
  jobs: CronJobConfig[];
}

export interface LoadedConfig {
  agents: Record<string, AgentConfig>;
  routing: Record<number, RoutingEntry>;
  session: SessionConfig;
  timeouts: TimeoutConfig;
  rateLimit: RateLimitConfig;
  telegram: TelegramConfig;
  cron: CronConfig;
  vaultPath: string;
  whisperModel: string;
  model: string;
  claudePath: string;
  sessionsDir: string;
}

// ── Session types ────────────────────────────────────────────────────

export interface SessionData {
  currentSessionId: string | null;
  createdAt: number;
  messageMap: Record<string, string>;
}

// ── Claude output types ──────────────────────────────────────────────

export interface ParsedClaudeResult {
  sessionId: string | undefined;
  text: string;
}

export interface RunClaudeResult {
  text: string;
  sessionId: string | undefined;
  resumed: boolean;
  rawStream: string;
}

// ── Function signatures ──────────────────────────────────────────────

export type RunClaudeFn = (
  agentId: string,
  topicId: number,
  prompt: string,
  opts?: { maxTurns?: number },
) => Promise<string>;

export type SendToTopicFn = (
  topicId: number,
  text: string,
) => Promise<number[]>;
