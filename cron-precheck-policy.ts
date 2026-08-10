import { join, resolve } from "path";

export interface ParsedCronPrecheck {
  script: string;
  agentId: string;
  topicId: number;
}

/**
 * Parse the one supported cron precheck without invoking a shell.
 *
 * Prechecks are persisted by an autonomous tool, so accepting arbitrary shell
 * text would turn a prompt injection into durable code execution. The only
 * supported form is the repo-owned activity probe with inert agent/topic args.
 */
export function parseCronPrecheck(
  value: unknown,
  opts: { projectRoot?: string; agentId?: string; topicId?: number } = {},
): ParsedCronPrecheck | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 4 || parts[0] !== "node") return null;

  const projectRoot = resolve(opts.projectRoot || process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw");
  const script = join(projectRoot, "dist", "scripts", "cron-precheck.js");
  if (resolve(parts[1]!) !== script) return null;

  const agentId = parts[2]!;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return null;
  if (opts.agentId && agentId !== opts.agentId) return null;

  const topicId = Number(parts[3]);
  if (!Number.isSafeInteger(topicId) || topicId <= 0) return null;
  if (opts.topicId !== undefined && topicId !== opts.topicId) return null;

  return { script, agentId, topicId };
}
