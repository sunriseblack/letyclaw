#!/usr/bin/env node
/**
 * Queue one existing cron job through the bot's normal scheduler.
 * Usage: sudo -u letyclaw node scripts/run-cron-once.mjs <job-id>
 *
 * This intentionally does not spawn Claude or post to Telegram itself. The
 * scheduler owns delivery classification, topic serialization, provider-error
 * filtering, direct-artifact dedupe, retry safety, and session mapping. Keeping
 * this helper as a thin cron_run client prevents a manual retry from becoming
 * a second, weaker notification pipeline.
 */
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
process.env.LETYCLAW_PROJECT_ROOT ||= projectRoot;

const jobId = process.argv[2];
if (!jobId) {
  console.error("usage: node scripts/run-cron-once.mjs <job-id>");
  process.exit(1);
}

const { handlers } = await import("../dist/tools/letyclaw-mcp/tools/cron.js");
const result = await handlers.cron_run({ id: jobId });
const message = result.content.find((item) => item.type === "text")?.text || "cron_run returned no status";

if (result.isError) {
  console.error(`[run-cron-once] refused: ${message}`);
  process.exit(1);
}

console.log(`[run-cron-once] queued through scheduler: ${message}`);
