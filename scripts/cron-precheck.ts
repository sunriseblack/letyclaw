#!/usr/bin/env node
/**
 * Cron activity precheck — decides whether a per-domain maintenance cron is
 * worth spawning the LLM for. Called by cron.ts (via job.precheck) BEFORE the
 * Claude subprocess starts, so idle domains don't burn a full run just to read
 * one file and reply "[SKIP]".
 *
 * Usage:  node dist/scripts/cron-precheck.js <agentId> <topicId>
 *
 * Stdout:
 *   [SKIP]                       — today's log shows no real activity → skip LLM
 *   ACTIVITY userReq=.. tool=..  — there was activity → run the job
 *
 * Exit code is always 0; cron.ts skips ONLY when stdout contains "[SKIP]" on a
 * clean exit, so any error here (printed, non-zero, or thrown) fails open and
 * the job runs. Deliberately CONSERVATIVE: it skips only when the day's log has
 * zero user requests AND zero tool calls — a strict subset of what the agent
 * itself would [SKIP] — so it can never drop a real consolidation.
 *
 * "Activity" = lines the maintenance cron would actually consolidate:
 *   - request events with a non-zero msgId (a real user turn, not a cron tick)
 *   - any tool_call event (work done by a user turn or another cron, e.g. a
 *     briefing that discovered something worth remembering)
 * The maintenance cron's OWN run hasn't been logged yet at precheck time, so
 * there is no self-reference / circularity to exclude.
 */
import { existsSync, readFileSync } from "fs";
import { join } from "path";

function localDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.TZ || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function main(): void {
  const [agentId, topicId] = process.argv.slice(2);
  if (!agentId || !topicId) {
    // Misconfigured precheck — fail open (run the job).
    console.log("ACTIVITY (no args — running)");
    return;
  }
  const root = process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw";
  const file = join(root, "logs", `${localDate()}-${agentId}-topic${topicId}.jsonl`);
  if (!existsSync(file)) {
    console.log("[SKIP]");
    return;
  }

  let userReq = 0;
  let toolCalls = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as { event?: string; msgId?: number };
      if (o.event === "request" && typeof o.msgId === "number" && o.msgId !== 0) userReq++;
      else if (o.event === "tool_call") toolCalls++;
    } catch { /* skip malformed line */ }
  }

  if (userReq === 0 && toolCalls === 0) {
    console.log("[SKIP]");
    return;
  }
  console.log(`ACTIVITY userReq=${userReq} tool=${toolCalls}`);
}

try {
  main();
} catch (err) {
  // Fail open: print activity so the job runs rather than silently skipping.
  console.log(`ACTIVITY (precheck error: ${err instanceof Error ? err.message : String(err)})`);
}
