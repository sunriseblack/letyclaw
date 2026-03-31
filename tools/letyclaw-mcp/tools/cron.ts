/**
 * Cron tools — Agent self-scheduling via cron.yaml management.
 *
 * Agents can create, list, and delete their own scheduled tasks.
 * Jobs are stored in config/cron.yaml and executed by cron.js.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { ok, error, AGENT } from "./_util.js";
import type { MCPToolDefinition, MCPResponse } from "../types.js";

const CRON_CONFIG = (): string => process.env.LETYCLAW_CRON_CONFIG || join(process.env.LETYCLAW_PROJECT_ROOT || process.cwd(), "config", "cron.yaml");

// ── Simple YAML parser/serializer for cron.yaml ──────────────────────
// cron.yaml format:
//   jobs:
//     - id: daily-standup
//       schedule: "0 9 * * *"
//       agent: personal
//       prompt: "Give me a morning briefing"
//       enabled: true

interface CronJob {
  id: string;
  [key: string]: string | number | boolean;
}

interface CronConfig {
  timezone?: string;
  jobs: CronJob[];
}

function loadCronConfig(): CronConfig {
  const configPath = CRON_CONFIG();
  if (!existsSync(configPath)) return { jobs: [] };
  const raw = readFileSync(configPath, "utf8");
  return parseSimpleYaml(raw);
}

function saveCronConfig(config: CronConfig): void {
  const configPath = CRON_CONFIG();
  // Ensure parent directory exists
  const dir = configPath.replace(/\/[^/]+$/, "");
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const yaml = serializeSimpleYaml(config);
  writeFileSync(configPath, yaml);
}

function parseSimpleYaml(text: string): CronConfig {
  const jobs: CronJob[] = [];
  let timezone = process.env.TZ || "UTC";
  let current: CronJob | null = null;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("timezone:")) {
      timezone = trimmed.replace("timezone:", "").trim().replace(/^"|"$/g, "");
      continue;
    }
    if (trimmed === "cron:" || trimmed === "jobs:" || trimmed === "jobs: []") continue;
    if (trimmed.startsWith("- id:")) {
      if (current) jobs.push(current);
      current = { id: trimmed.replace("- id:", "").trim().replace(/^"|"$/g, "") };
    } else if (current && trimmed.includes(":")) {
      const colonIdx = trimmed.indexOf(":");
      const key = trimmed.slice(0, colonIdx).trim();
      const rawVal = trimmed.slice(colonIdx + 1).trim().replace(/^"|"$/g, "");
      let val: string | boolean | number = rawVal;
      if (rawVal === "true") val = true;
      else if (rawVal === "false") val = false;
      else if (/^\d+$/.test(rawVal)) val = Number(rawVal);
      current[key] = val;
    }
  }
  if (current) jobs.push(current);
  return { timezone, jobs };
}

function serializeSimpleYaml(config: CronConfig): string {
  const tz = config.timezone || process.env.TZ || "UTC";
  if (!config.jobs || config.jobs.length === 0) return `cron:\n  timezone: "${tz}"\n  jobs: []\n`;
  let yaml = `cron:\n  timezone: "${tz}"\n  jobs:\n`;
  for (const job of config.jobs) {
    yaml += `    - id: "${job.id}"\n`;
    for (const [key, val] of Object.entries(job)) {
      if (key === "id") continue;
      const v = typeof val === "string" ? `"${val}"` : val;
      yaml += `      ${key}: ${v}\n`;
    }
  }
  return yaml;
}

// ── Tool definitions ──────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "cron_create",
    description:
      "Create a new scheduled task. The agent can schedule itself to run at specific times using cron syntax. Jobs are persisted in cron.yaml and executed by the cron daemon.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Unique job ID (e.g. 'daily-standup', 'weekly-report'). Lowercase, hyphens OK.",
        },
        schedule: {
          type: "string",
          description: "Cron expression (e.g. '0 9 * * *' for daily at 9am, '0 9 * * 1' for Mondays at 9am)",
        },
        prompt: { type: "string", description: "The prompt/task to execute on each run" },
        agent_id: { type: "string", description: "Agent ID to run as (default: current agent)" },
        topic_id: { type: "string", description: "Telegram topic to send results to (optional)" },
        enabled: { type: "boolean", description: "Whether the job is active (default: true)" },
        max_turns: { type: "number", description: "Max Claude turns per run (default: 10)" },
      },
      required: ["id", "schedule", "prompt"],
    },
  },
  {
    name: "cron_list",
    description:
      "List all scheduled cron jobs. Shows job IDs, schedules, agents, prompts, and enabled status.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Filter by agent ID (optional)" },
      },
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
  async cron_create({ id, schedule, prompt, agent_id, topic_id, enabled = true, max_turns = 10 }: Record<string, unknown>): Promise<MCPResponse> {
    if (!id) return error("id is required");
    if (!schedule) return error("schedule is required");
    if (!prompt) return error("prompt is required");
    if (!/^[a-z0-9-]+$/.test(id as string)) return error("id must be lowercase alphanumeric with hyphens only");

    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");

    // Validate cron expression (basic check: 5 space-separated fields)
    const fields = (schedule as string).trim().split(/\s+/);
    if (fields.length < 5 || fields.length > 6) {
      return error(`Invalid cron expression '${schedule}' — expected 5 fields (min hour dom mon dow)`);
    }

    const config = loadCronConfig();

    // Check for duplicate
    if (config.jobs.find((j) => j.id === id)) {
      return error(`Job '${id}' already exists. Delete it first or use a different ID.`);
    }

    const job: CronJob = {
      id: id as string,
      schedule: schedule as string,
      agent: agentId,
      prompt: prompt as string,
      enabled: enabled as boolean,
      maxTurns: max_turns as number,
    };
    if (topic_id) job.topicId = topic_id as string;
    config.jobs.push(job);

    saveCronConfig(config);
    return ok(JSON.stringify({
      created: true,
      job: { id, schedule, agent: agentId, enabled },
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
