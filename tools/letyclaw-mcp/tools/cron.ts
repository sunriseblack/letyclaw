/**
 * Cron tools — agent self-scheduling via cron.yaml management.
 *
 * Agents can create, list, update, pause/resume, delete, and request a one-off
 * run for scheduled tasks. Jobs are stored in config/cron.yaml and executed by
 * cron.js.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "fs";
import { join } from "path";
import YAML from "js-yaml";
import cron from "node-cron";
import { ok, error, AGENT } from "./_util.js";
import type { MCPToolDefinition, MCPResponse } from "../types.js";
import { parseCronPrecheck } from "../../../cron-precheck-policy.js";

const CRON_CONFIG = (): string => process.env.LETYCLAW_CRON_CONFIG || join(process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw", "config", "cron.yaml");

interface CronJob {
  id: string;
  [key: string]: unknown;
}

interface CronConfig {
  timezone?: string;
  jobs: CronJob[];
}

interface CronYaml {
  cron?: {
    timezone?: string;
    jobs?: CronJob[];
  };
}

function loadCronConfig(): CronConfig {
  const configPath = CRON_CONFIG();
  if (!existsSync(configPath)) return { jobs: [] };
  const raw = readFileSync(configPath, "utf8");
  const parsed = YAML.load(raw) as CronYaml | null;
  return {
    timezone: parsed?.cron?.timezone || process.env.TZ || "UTC",
    jobs: (parsed?.cron?.jobs ?? []) as CronJob[],
  };
}

function saveCronConfig(config: CronConfig): void {
  const configPath = CRON_CONFIG();
  const dir = configPath.replace(/\/[^/]+$/, "");
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const yaml = YAML.dump(
    { cron: { timezone: config.timezone || process.env.TZ || "UTC", jobs: config.jobs } },
    { lineWidth: -1 },
  );
  // Atomic tmp+rename (NOT in-place writeFileSync): the runtime (letyclaw) owns the
  // config DIR but deploys leave cron.yaml itself root-owned, so an in-place
  // write hits EACCES. rename only needs the writable dir and self-heals owner.
  const tmp = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tmp, yaml);
  renameSync(tmp, configPath);
}

function asStringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const out = raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
  return out.length ? [...new Set(out)] : undefined;
}

function parseTopicId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function validateCronExpression(schedule: unknown): string | null {
  if (typeof schedule !== "string" || !schedule.trim()) return "schedule is required";
  if (!cron.validate(schedule.trim())) return `Invalid cron expression '${schedule}'`;
  return null;
}

function parseExpiresAt(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("expires_at must be an ISO-8601 string");
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new Error(`expires_at '${value}' is not a valid ISO-8601 datetime`);
  if (t < Date.now()) throw new Error(`expires_at '${value}' is in the past`);
  return new Date(t).toISOString();
}

function findJob(config: CronConfig, id: unknown): { job: CronJob; idx: number } | null {
  if (typeof id !== "string" || !id.trim()) return null;
  const idx = config.jobs.findIndex((j) => j.id === id);
  return idx >= 0 ? { job: config.jobs[idx]!, idx } : null;
}

function applyPatchFields(job: CronJob, args: Record<string, unknown>): string | null {
  if (args.schedule !== undefined) {
    const cronErr = validateCronExpression(args.schedule);
    if (cronErr) return cronErr;
    job.schedule = args.schedule;
  }
  if (args.prompt !== undefined) {
    if (typeof args.prompt !== "string" || !args.prompt.trim()) return "prompt must be a non-empty string";
    job.prompt = args.prompt;
  }
  if (args.agent_id !== undefined) {
    if (typeof args.agent_id !== "string" || !args.agent_id.trim()) return "agent_id must be a non-empty string";
    job.agent = args.agent_id;
  }
  if (args.topic_id !== undefined) {
    const topicId = parseTopicId(args.topic_id);
    if (topicId === undefined && args.topic_id !== null && args.topic_id !== "") return "topic_id must be a positive integer";
    if (topicId === undefined) delete job.topicId;
    else job.topicId = topicId;
  }
  if (args.enabled !== undefined) {
    if (typeof args.enabled !== "boolean") return "enabled must be boolean";
    job.enabled = args.enabled;
  }
  if (args.delivery !== undefined) {
    if (args.delivery !== "signal" && args.delivery !== "silent" && args.delivery !== "nudge") {
      return "delivery must be signal, silent, or nudge";
    }
    job.delivery = args.delivery;
  }
  if (args.max_turns !== undefined) {
    if (typeof args.max_turns !== "number" || !Number.isFinite(args.max_turns) || args.max_turns < 1) return "max_turns must be a positive number";
    job.maxTurns = args.max_turns;
  }
  if (args.expires_at !== undefined) {
    try {
      const expiresAt = parseExpiresAt(args.expires_at);
      if (expiresAt === null) delete job.expiresAt;
      else if (expiresAt) job.expiresAt = expiresAt;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  if (args.precheck !== undefined) {
    if (args.precheck === null || args.precheck === "") delete job.precheck;
    else if (typeof args.precheck === "string") {
      const parsed = parseCronPrecheck(args.precheck, {
        projectRoot: process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw",
        agentId: typeof job.agent === "string" ? job.agent : undefined,
        topicId: typeof job.topicId === "number" ? job.topicId : undefined,
      });
      if (!parsed) {
        return "precheck must be the repo-owned activity probe for this job: node <LETYCLAW_PROJECT_ROOT>/dist/scripts/cron-precheck.js <agent_id> <topic_id>";
      }
      job.precheck = args.precheck.trim();
    } else return "precheck must be a string";
  }
  if (args.expects_tools !== undefined) {
    if (typeof args.expects_tools !== "boolean") return "expects_tools must be boolean";
    job.expectsTools = args.expects_tools;
  }

  const arrayFields: Array<[string, string]> = [
    ["skills", "skills"],
    ["enabled_toolsets", "enabledToolsets"],
    ["disabled_toolsets", "disabledToolsets"],
    ["disabled_tools", "disabledTools"],
  ];
  for (const [inputName, storedName] of arrayFields) {
    if (!(inputName in args)) continue;
    if (args[inputName] === null) {
      delete job[storedName];
      continue;
    }
    const values = asStringList(args[inputName]);
    if (values) job[storedName] = values;
    else delete job[storedName];
  }

  return null;
}

// ── Tool definitions ──────────────────────────────────────────────────

const cronJobFields = {
  id: {
    type: "string",
    description: "Unique job ID (e.g. 'daily-standup', 'weekly-report'). Lowercase, hyphens OK. For watch crons, prefix with 'watch-' e.g. 'watch-pcx-replies-20260525'.",
  },
  schedule: {
    type: "string",
    description: "Cron expression (e.g. '0 9 * * *' for daily at 9am, '*/15 * * * *' for every 15 min)",
  },
  prompt: { type: "string", description: "The prompt/task to execute on each run" },
  agent_id: { type: "string", description: "Agent ID to run as (default: current agent)" },
  topic_id: { type: "string", description: "Telegram topic to send results to (optional)" },
  enabled: { type: "boolean", description: "Whether the job is active (default: true)" },
  delivery: {
    type: "string",
    enum: ["signal", "silent", "nudge"],
    description: "Required delivery policy. Use signal only for a substantive requested result or watch hit, silent for maintenance, and nudge for reminders/check-ins. Nudge jobs are stored disabled and cannot run until changed to signal.",
  },
  max_turns: { type: "number", description: "Max Claude turns per run (default: 10)" },
  expires_at: {
    type: "string",
    description: "ISO-8601 datetime after which the job auto-deletes (e.g. '2026-06-01T19:00:00+02:00'). REQUIRED for watch crons. Pass empty string to clear in cron_update.",
  },
  precheck: {
    type: "string",
    description: "Optional safe activity precheck. Only `node <LETYCLAW_PROJECT_ROOT>/dist/scripts/cron-precheck.js <agent_id> <topic_id>` is accepted; arbitrary shell is rejected.",
  },
  expects_tools: {
    type: "boolean",
    description: "If true, a run with zero tool calls is treated as failed/retriable.",
  },
  skills: {
    type: "array",
    items: { type: "string" },
    description: "Optional skill names loaded into the prompt for this job.",
  },
  enabled_toolsets: {
    type: "array",
    items: { type: "string" },
    description: "Optional allow-list of letyclaw MCP toolsets (memory, sessions, messaging, cron, media, voice, extras, gdrive, ticktick, gmail, loops, connectors, browser, skills).",
  },
  disabled_toolsets: {
    type: "array",
    items: { type: "string" },
    description: "Optional deny-list of letyclaw MCP toolsets.",
  },
  disabled_tools: {
    type: "array",
    items: { type: "string" },
    description: "Optional deny-list of individual letyclaw tools, e.g. ['message_send', 'cron_delete'].",
  },
} as const;

export const definitions: MCPToolDefinition[] = [
  {
    name: "cron_create",
    description:
      "Create a new scheduled task. The agent can schedule itself to run at specific times using cron syntax. " +
      "Jobs are persisted in cron.yaml and executed by the cron daemon. " +
      "For 'watch' jobs (poll inbox for a reply, check prices for a week), ALWAYS set expires_at — otherwise the job runs forever.",
    inputSchema: {
      type: "object",
      properties: cronJobFields,
      required: ["id", "schedule", "prompt", "delivery"],
    },
  },
  {
    name: "cron_list",
    description:
      "List all scheduled cron jobs. Shows job IDs, schedules, agents, prompts, enabled status, expiry, skill, and tool-scope settings.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Filter by agent ID (optional)" },
      },
    },
  },
  {
    name: "cron_update",
    description:
      "Patch an existing scheduled cron job. Use this to change schedule, prompt, topic, expiry, skill/tool settings, or enabled state without deleting the job.",
    inputSchema: {
      type: "object",
      properties: cronJobFields,
      required: ["id"],
    },
  },
  {
    name: "cron_pause",
    description: "Pause a scheduled cron job by setting enabled=false without deleting it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job ID to pause" } },
      required: ["id"],
    },
  },
  {
    name: "cron_resume",
    description: "Resume a paused scheduled cron job by setting enabled=true.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job ID to resume" } },
      required: ["id"],
    },
  },
  {
    name: "cron_run",
    description:
      "Request a one-off immediate run of a cron job. Sets runNow=true; the bot hot-reload clears it and runs the job once, even if the job is paused.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Job ID to run once" } },
      required: ["id"],
    },
  },
  {
    name: "cron_delete",
    description:
      "Delete a scheduled cron job by ID. Removes it from cron.yaml permanently.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Job ID to delete" },
      },
      required: ["id"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<MCPResponse>> = {
  async cron_create(args: Record<string, unknown>): Promise<MCPResponse> {
    const { id, schedule, prompt, agent_id, enabled = true, max_turns = 10, expires_at } = args;
    if (!id) return error("id is required");
    if (!prompt) return error("prompt is required");
    if (args.delivery !== "signal" && args.delivery !== "silent" && args.delivery !== "nudge") {
      return error("delivery is required and must be signal, silent, or nudge");
    }
    if (!/^[a-z0-9-]+$/.test(id as string)) return error("id must be lowercase alphanumeric with hyphens only");

    const cronErr = validateCronExpression(schedule);
    if (cronErr) return error(cronErr);
    if (typeof prompt !== "string" || !prompt.trim()) return error("prompt must be a non-empty string");
    if (typeof enabled !== "boolean") return error("enabled must be boolean");
    if (typeof max_turns !== "number" || !Number.isFinite(max_turns) || max_turns < 1) return error("max_turns must be a positive number");

    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");

    let expiresAtIso: string | undefined;
    try {
      const parsed = parseExpiresAt(expires_at);
      if (parsed) expiresAtIso = parsed;
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }

    // Watch-style IDs (prefix 'watch-') REQUIRE expires_at to prevent
    // forgotten polls from running forever.
    if ((id as string).startsWith("watch-") && !expiresAtIso) {
      return error("watch-prefixed jobs must include expires_at (ISO-8601). Pick a sensible deadline (e.g. 7 days out).");
    }

    const topicId = parseTopicId(args.topic_id);
    if (topicId === undefined && args.topic_id !== undefined && args.topic_id !== null && args.topic_id !== "") {
      return error("topic_id must be a positive integer");
    }

    const config = loadCronConfig();
    if (config.jobs.find((j) => j.id === id)) {
      return error(`Job '${id}' already exists. Delete it first or use a different ID.`);
    }

    const job: CronJob = {
      id: id as string,
      schedule: schedule as string,
      agent: agentId,
      prompt,
      enabled: args.delivery === "nudge" ? false : enabled,
      delivery: args.delivery,
      maxTurns: max_turns,
    };
    if (topicId !== undefined) job.topicId = topicId;
    if (expiresAtIso) job.expiresAt = expiresAtIso;

    const patchErr = applyPatchFields(job, args);
    if (patchErr) return error(patchErr);
    if (job.delivery === "nudge") job.enabled = false;

    config.jobs.push(job);
    saveCronConfig(config);
    return ok(JSON.stringify({
      created: true,
      job: { id, schedule, agent: agentId, enabled: job.enabled, delivery: job.delivery, expiresAt: expiresAtIso },
      note: "Changes take effect within 60 seconds",
    }, null, 2));
  },

  async cron_list({ agent_id }: Record<string, unknown>): Promise<MCPResponse> {
    const config = loadCronConfig();
    let jobs = config.jobs || [];

    if (agent_id) {
      jobs = jobs.filter((j) => j.agent === agent_id);
    }

    if (jobs.length === 0) return ok("No scheduled jobs");
    return ok(JSON.stringify(jobs, null, 2));
  },

  async cron_update(args: Record<string, unknown>): Promise<MCPResponse> {
    const config = loadCronConfig();
    const found = findJob(config, args.id);
    if (!found) return error(`Job '${String(args.id || "")}' not found`);

    const patchErr = applyPatchFields(found.job, args);
    if (patchErr) return error(patchErr);
    if (found.job.delivery === "nudge") {
      found.job.enabled = false;
      delete found.job.runNow;
    }
    if (found.job.id.startsWith("watch-") && !found.job.expiresAt) {
      return error("watch-prefixed jobs must keep expires_at. Set a new future expires_at instead of clearing it.");
    }
    saveCronConfig(config);

    return ok(JSON.stringify({
      updated: true,
      job: found.job,
      note: "Changes take effect within 60 seconds",
    }, null, 2));
  },

  async cron_pause({ id }: Record<string, unknown>): Promise<MCPResponse> {
    const config = loadCronConfig();
    const found = findJob(config, id);
    if (!found) return error(`Job '${String(id || "")}' not found`);
    found.job.enabled = false;
    saveCronConfig(config);
    return ok(JSON.stringify({ paused: true, job: found.job, note: "Changes take effect within 60 seconds" }, null, 2));
  },

  async cron_resume({ id }: Record<string, unknown>): Promise<MCPResponse> {
    const config = loadCronConfig();
    const found = findJob(config, id);
    if (!found) return error(`Job '${String(id || "")}' not found`);
    if (found.job.delivery === "nudge") {
      return error("Nudge jobs cannot be resumed. Change delivery to signal only for an explicitly requested alert.");
    }
    if (found.job.delivery !== "signal" && found.job.delivery !== "silent") {
      return error("Job has no valid delivery policy and cannot be resumed.");
    }
    found.job.enabled = true;
    saveCronConfig(config);
    return ok(JSON.stringify({ resumed: true, job: found.job, note: "Changes take effect within 60 seconds" }, null, 2));
  },

  async cron_run({ id }: Record<string, unknown>): Promise<MCPResponse> {
    const config = loadCronConfig();
    const found = findJob(config, id);
    if (!found) return error(`Job '${String(id || "")}' not found`);
    if (found.job.delivery === "nudge") {
      return error("Nudge jobs cannot be run. Change delivery to signal only for an explicitly requested alert.");
    }
    if (found.job.delivery !== "signal" && found.job.delivery !== "silent") {
      return error("Job has no valid delivery policy and cannot run.");
    }
    found.job.runNow = true;
    saveCronConfig(config);
    return ok(JSON.stringify({ runQueued: true, job: found.job, note: "The bot will run this once on the next cron reload (within 60 seconds)" }, null, 2));
  },

  async cron_delete({ id }: Record<string, unknown>): Promise<MCPResponse> {
    if (!id) return error("id is required");

    const config = loadCronConfig();
    const idx = config.jobs.findIndex((j) => j.id === id);
    if (idx === -1) return error(`Job '${id}' not found`);

    const removed = config.jobs.splice(idx, 1)[0];
    saveCronConfig(config);

    return ok(JSON.stringify({
      deleted: true,
      job: removed,
      note: "Changes take effect within 60 seconds",
    }, null, 2));
  },
};
