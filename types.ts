// ── Config types ─────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  maxTurns: number;
  skills?: string[];
  enabledToolsets?: string[];
  disabledToolsets?: string[];
  disabledTools?: string[];
}

export interface RoutingEntry {
  id: string;
  name: string;
  maxTurns: number;
}

export interface SessionConfig {
  ttlHours: number;
  pruneAfterDays: number;
}

export interface TimeoutConfig {
  claudeTotal: number;
  // How many times a run that hits claudeTotal mid-work is resumed with a
  // continuation turn before the turn is surfaced as a failure.
  claudeMaxContinuations: number;
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
  // Autonomous delivery policy. Signal jobs may publish substantive results;
  // silent jobs run maintenance without publishing; nudge jobs stay disabled.
  // Missing values fail closed in the scheduler so runtime-only jobs cannot
  // silently introduce a new notification channel.
  delivery?: "signal" | "silent" | "nudge";
  // Set by cron_run to trigger a one-off run on the next scheduler reload/tick
  // without waiting for the cron expression.
  runNow?: boolean;
  maxTurns?: number;
  // Optional ISO-8601 expiry. After this instant, the job is skipped and
  // pruned from cron.yaml on the next fire. Used by agent-created "watch"
  // crons that should auto-disable instead of running forever.
  expiresAt?: string;
  // Optional code-owned activity probe run BEFORE spawning the LLM. Arbitrary
  // shell is rejected; only scripts/cron-precheck.ts with matching agent/topic
  // args is accepted. A clean "[SKIP]" avoids an idle Claude subprocess.
  precheck?: string;
  // If true, a run that finishes with ZERO tool calls (and didn't [SKIP]) is
  // treated as a failed run and routed through the retry/surface path, instead
  // of delivering its (usually canned/aborted) short reply as if it were real
  // output. Set on briefings and named-tool crons that must do real work.
  expectsTools?: boolean;
  // Optional reusable workflow docs loaded into the prompt for this job.
  skills?: string[];
  // Optional letyclaw-tools visibility controls. enabledToolsets is an allow-list
  // over known letyclaw MCP tool modules; disabled* fields are deny-lists.
  enabledToolsets?: string[];
  disabledToolsets?: string[];
  disabledTools?: string[];
}

export interface CronConfig {
  timezone: string;
  jobs: CronJobConfig[];
}

export interface LoadedConfig {
  botName: string;
  ownerName: string;
  timezone: string;
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
  effort: string;
  claudePath: string;
  sessionsDir: string;
}

// ── Session types ────────────────────────────────────────────────────

export interface SessionData {
  currentSessionId: string | null;
  createdAt: number;
  // Last time a real user turn touched this session. Session rotation is keyed
  // off idle time since this, NOT createdAt — an actively-used conversation
  // must never rotate mid-stream. Optional for back-compat with files written
  // before this field existed (shouldRotateSession falls back to createdAt).
  lastActivityAt?: number;
  messageMap: Record<string, string>;
}

// ── Claude output types ──────────────────────────────────────────────

export interface ClaudeStreamOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ParsedClaudeResult {
  sessionId: string | undefined;
  text: string;
  isError?: boolean;
  subtype?: string;
}

// A single structured event extracted live from the Claude stream, stamped
// with its real arrival time (`ts`). Lets per-tool timing be reconstructed
// instead of every tool_call sharing the run-end timestamp.
export interface StreamLogEvent {
  ts: string;
  event: "init" | "tool_call" | "tool_result" | "result";
  [key: string]: unknown;
}

export interface RunClaudeResult {
  text: string;
  sessionId: string | undefined;
  resumed: boolean;
  fellBackToFresh: boolean;
  rawStream: string;
  // Events collected live as the stream arrived (with real per-event ts).
  // Preferred over re-parsing rawStream post-hoc, which loses timing and the
  // tool_result blocks that arrive in `user`-type stream messages.
  streamEvents?: StreamLogEvent[];
  // Number of tool_use blocks seen in the stream. Lets the cron path detect a
  // run that produced no tool activity (aborted/no-op) vs. real work.
  toolCount?: number;
  // num_turns from the final `result` stream event, when present.
  numTurns?: number;
}

// ── Function signatures ──────────────────────────────────────────────

export type RunClaudeFn = (
  agentId: string,
  topicId: number,
  prompt: string,
  opts?: {
    maxTurns?: number;
    skills?: string[];
    enabledToolsets?: string[];
    disabledToolsets?: string[];
    disabledTools?: string[];
  },
) => Promise<string>;

export type SendToTopicFn = (
  topicId: number,
  text: string,
) => Promise<number[]>;
