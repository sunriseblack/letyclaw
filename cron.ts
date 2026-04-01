import cron from "node-cron";
import type { LoadedConfig, RunClaudeFn, SendToTopicFn } from "./types.js";

export function startCronJobs(config: LoadedConfig, runClaude: RunClaudeFn, sendToTopic: SendToTopicFn): () => void {
  const { timezone, jobs } = config.cron;
  const agentLocks = new Map<string, boolean>();
  const tasks: Array<{ stop(): void }> = [];

  for (const job of jobs) {
    if (!job.topicId) {
      console.warn(`[cron] job "${job.name || job.id}" has no matching topic — skipped`);
      continue;
    }

    const agent = config.agents[job.agent];
    if (!agent) {
      console.warn(`[cron] job "${job.name || job.id}" references unknown agent "${job.agent}" — skipped`);
      continue;
    }

    const task = cron.schedule(job.schedule, async () => {
      const lockKey = job.agent;
      if (agentLocks.get(lockKey)) {
        console.log(`[cron] "${job.name || job.id}" skipped — agent "${job.agent}" busy`);
        return;
      }

      agentLocks.set(lockKey, true);
      console.log(`[cron] "${job.name || job.id}" running (agent: ${job.agent})`);

      try {
        const response = await runClaude(
          job.agent,
          job.topicId!,
          job.prompt.trim(),
          { maxTurns: job.maxTurns || agent.maxTurns || 10 }
        );

        const text = typeof response === "string" ? response : JSON.stringify(response);

        // Skip detection: [SKIP] marker or very short response
        if (text.includes("[SKIP]") || text.length < 20) {
          console.log(`[cron] "${job.name || job.id}" — agent skipped (no content)`);
          return;
        }

        await sendToTopic(job.topicId!, text);
        console.log(`[cron] "${job.name || job.id}" delivered to topic:${job.topicId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[cron] "${job.name || job.id}" failed:`, msg);
      } finally {
        agentLocks.set(lockKey, false);
      }
    }, { timezone, scheduled: true });

    tasks.push(task);
    console.log(`[cron] registered: "${job.name || job.id}" [${job.schedule}] → ${job.agent} (topic:${job.topicId})`);
  }

  // Return stop function for hot-reload
  return () => {
    for (const t of tasks) t.stop();
    tasks.length = 0;
  };
}
