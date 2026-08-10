import cron from "node-cron";
import { spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import YAML from "js-yaml";
import type { LoadedConfig } from "./types.js";
import { looksLikeAuthFailure, looksLikeProviderFailure } from "./lib.js";
import { parseCronPrecheck } from "./cron-precheck-policy.js";

type RunClaudeFn = (
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
) => Promise<{
  text: string;
  sessionId?: string;
  toolCount?: number;
  numTurns?: number;
  directMessageCount?: number;
}>;

type SendToTopicFn = (
  topicId: number,
  text: string,
  sourceSessionId?: string,
) => Promise<number[]>;

// Optional: record (msg_id → cron sessionId) so user replies to a cron-sent
// message can resume that specific cron session and pick up its context.
type RecordCronIdsFn = (topicId: number, sentIds: number[], sessionId: string) => void;
type RunAtomicFn = <T>(topicId: number, task: () => Promise<T>) => Promise<T>;

interface JobRunOutcome {
  ok: boolean;
  /** Safe only when the completed result proves that no tool was called and
   * delivery never began. A crashed subprocess may already have side effects. */
  retry: boolean;
}

function removeJobFromYaml(jobId: string): void {
  const path = process.env.LETYCLAW_CRON_CONFIG || join(process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw", "config", "cron.yaml");
  if (!existsSync(path)) return;
  try {
    const raw = YAML.load(readFileSync(path, "utf8")) as { cron?: { timezone?: string; jobs?: Array<Record<string, unknown>> } } | null;
    if (!raw?.cron?.jobs) return;
    const before = raw.cron.jobs.length;
    raw.cron.jobs = raw.cron.jobs.filter((j) => j.id !== jobId);
    if (raw.cron.jobs.length === before) return;
    // Atomic tmp+rename: an in-place write needs write perm on the FILE, which
    // fails when a deploy (git/cp as root) leaves cron.yaml root-owned. rename
    // only needs the (letyclaw-owned) config dir and lands the file letyclaw-owned.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, YAML.dump(raw, { lineWidth: -1 }));
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[cron] failed to remove expired job '${jobId}' from yaml:`, err instanceof Error ? err.message : String(err));
  }
}

function patchJobInYaml(jobId: string, update: (job: Record<string, unknown>) => boolean): void {
  const path = process.env.LETYCLAW_CRON_CONFIG || join(process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw", "config", "cron.yaml");
  if (!existsSync(path)) return;
  try {
    const raw = YAML.load(readFileSync(path, "utf8")) as { cron?: { timezone?: string; jobs?: Array<Record<string, unknown>> } } | null;
    if (!raw?.cron?.jobs) return;
    const job = raw.cron.jobs.find((j) => j.id === jobId);
    if (!job || !update(job)) return;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, YAML.dump(raw, { lineWidth: -1 }));
    renameSync(tmp, path);
  } catch (err) {
    console.error(`[cron] failed to patch job '${jobId}' in yaml:`, err instanceof Error ? err.message : String(err));
  }
}

function clearRunNowFromYaml(jobId: string): void {
  patchJobInYaml(jobId, (job) => {
    if (job.runNow !== true) return false;
    delete job.runNow;
    return true;
  });
}

// Delay between the initial failure and the single auto-retry. Long enough
// that whatever transient (Anthropic 529, IMAP hang, MCP startup race)
// caused the first failure likely recovered; short enough that briefings
// still land while they're useful.
const RETRY_DELAY_MS = 5 * 60_000;

// Stable failure categories keep journal review useful without leaking
// operational chatter into user topics.
function classifyFailure(msg: string): string {
  const m = msg.toLowerCase();
  if (looksLikeAuthFailure(m)) return "Claude auth/access";
  if (m.includes("timeout") || m.includes("etimedout")) return "timeout";
  if (m.includes("overloaded") || m.includes("529")) return "Anthropic overloaded";
  if (m.includes("session") && m.includes("expired")) return "session expired";
  if (m.includes("rate") && m.includes("limit")) return "rate limit";
  return "error";
}

function isSkipResponse(text: string): boolean {
  return /^\[SKIP\](?:\s|$)/i.test(text.trim());
}

// Run a single cron-job execution. Used for both the initial fire and the
// one auto-retry. Failures remain in the journal; they are never posted to a
// user topic.
// Automatic re-execution is allowed only when the completed result proves it
// made zero tool calls and Telegram delivery has not started. A timeout/crash
// is ambiguous: tools may already have changed external state.
async function runJobOnce(
  job: import("./types.js").CronJobConfig,
  agent: { maxTurns?: number },
  runClaude: RunClaudeFn,
  sendToTopic: SendToTopicFn,
  recordCronIds: RecordCronIdsFn | undefined,
  isRetry: boolean,
): Promise<JobRunOutcome> {
  const label = job.name || job.id;
  const tag = isRetry ? " (retry)" : "";
  let result: Awaited<ReturnType<RunClaudeFn>> | undefined;
  let deliveryStarted = false;

  try {
    const runOptions: {
      maxTurns: number;
      skills?: string[];
      enabledToolsets?: string[];
      disabledToolsets?: string[];
      disabledTools?: string[];
    } = { maxTurns: job.maxTurns || agent.maxTurns || 10 };
    if (job.skills?.length) runOptions.skills = job.skills;
    if (job.enabledToolsets?.length) runOptions.enabledToolsets = job.enabledToolsets;
    if (job.disabledToolsets?.length) runOptions.disabledToolsets = job.disabledToolsets;
    if (job.delivery === "silent") {
      runOptions.disabledToolsets = [...new Set([...(runOptions.disabledToolsets ?? []), "messaging"])];
    }
    if (job.disabledTools?.length) runOptions.disabledTools = job.disabledTools;

    result = await runClaude(
      job.agent,
      job.topicId!,
      job.prompt.trim(),
      runOptions,
    );

    const text = typeof result.text === "string" ? result.text : JSON.stringify(result.text);

    // Provider auth/access errors can arrive as a clean CLI result (exit 0),
    // which previously let a short error string be sent as successful cron
    // output. Reject them for every job, even when `expectsTools` is unset.
    if (text.trim().length > 0 && text.trim().length < 400 && looksLikeProviderFailure(text)) {
      throw new Error(`Claude provider failure: ${text.trim().slice(0, 200)}`);
    }

    // Briefings / named-tool crons that finish having called ZERO tools didn't
    // do their job — the subprocess aborted before step 1 and would otherwise
    // ship a canned 43-char string as if it were the day's briefing. Treat that
    // as a failure so it flows through the retry/surface path below, NOT a
    // delivery. (A legitimate no-op replies "[SKIP]" and is handled next.)
    if (job.expectsTools && !isSkipResponse(text) && (result.toolCount ?? 0) === 0) {
      throw new Error(`no tool calls (expected real work — likely an aborted run that produced "${text.slice(0, 60).replace(/\s+/g, " ")}")`);
    }

    if (isSkipResponse(text)) {
      console.log(`[cron] "${label}"${tag} — agent skipped (no content)`);
      return { ok: true, retry: false };
    }

    if (job.delivery === "silent") {
      console.warn(`[cron] "${label}"${tag} — suppressed ${text.length}-char maintenance response`);
      return { ok: true, retry: false };
    }

    // Some signal jobs intentionally deliver an artifact/button through a
    // dedicated messaging tool. That direct delivery is the one user-visible
    // outcome; never follow it with the model's "sent" confirmation text.
    if ((result.directMessageCount ?? 0) > 0) {
      console.log(`[cron] "${label}"${tag} — direct delivery complete; final confirmation suppressed`);
      return { ok: true, retry: false };
    }

    deliveryStarted = true;
    const sentIds = await sendToTopic(job.topicId!, text, result.sessionId);
    if (result.sessionId && sentIds.length > 0 && recordCronIds) {
      recordCronIds(job.topicId!, sentIds, result.sessionId);
    }
    console.log(`[cron] "${label}"${tag} delivered to topic:${job.topicId}`);
    return { ok: true, retry: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind = classifyFailure(msg);
    console.error(`[cron] "${label}"${tag} failed (${kind}):`, msg);

    const explicitlySafe = !!err && typeof err === "object" &&
      (err as { safeToRetryClaudeAttempt?: unknown }).safeToRetryClaudeAttempt === true;
    const safeToRetry = !isRetry && !deliveryStarted && (result?.toolCount === 0 || explicitlySafe);
    console.error(
      `[cron] "${label}"${tag} user-visible failure suppressed; ` +
      `${safeToRetry ? "retry scheduled" : "no retry"}`,
    );

    return { ok: false, retry: safeToRetry };
  }
}

export function startCronJobs(
  config: LoadedConfig,
  runClaude: RunClaudeFn,
  sendToTopic: SendToTopicFn,
  recordCronIds?: RecordCronIdsFn,
  runAtomically: RunAtomicFn = async (_topicId, task) => task(),
): () => void {
  const { timezone, jobs } = config.cron;
  // Serialize jobs per agent without dropping distinct schedules. The old
  // boolean lock silently skipped a job when another long run crossed its fire
  // time (two weekly health jobs were lost this way on 2026-07-05). Promise
  // tails queue one execution per job; repeat fires of the same job coalesce so
  // a stuck run cannot grow an unbounded backlog.
  const agentTails = new Map<string, Promise<void>>();
  const pendingJobs = new Set<string>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const tasks: Array<{ stop(): void }> = [];
  let stopped = false;

  for (const job of jobs) {
    if (job.delivery !== "signal" && job.delivery !== "silent" && job.delivery !== "nudge") {
      console.warn(`[cron] job "${job.name || job.id}" has no valid delivery policy — skipped`);
      if (job.runNow) clearRunNowFromYaml(job.id);
      continue;
    }
    if (job.delivery === "nudge") {
      console.log(`[cron] nudge disabled: "${job.name || job.id}" [${job.schedule}]`);
      if (job.runNow) clearRunNowFromYaml(job.id);
      continue;
    }
    if (!job.topicId) {
      console.warn(`[cron] job "${job.name || job.id}" has no matching topic — skipped`);
      continue;
    }

    const agent = config.agents[job.agent];
    if (!agent) {
      console.warn(`[cron] job "${job.name || job.id}" references unknown agent "${job.agent}" — skipped`);
      continue;
    }

    let task: { stop(): void } | undefined;
    const runScheduled = async (isRetry = false) => {
      if (stopped) return;
      // A real schedule/runNow fire supersedes a pending delayed retry for the
      // same job. This prevents a recovered manual run from being duplicated.
      if (!isRetry) {
        const pendingRetry = retryTimers.get(job.id);
        if (pendingRetry) {
          clearTimeout(pendingRetry);
          retryTimers.delete(job.id);
        }
      }
      // Expiry check (for agent-created "watch" crons with expiresAt).
      // If past expiry, drop the job from cron.yaml and stop the task so
      // it doesn't fire again until next bot restart re-loads config.
      if (job.expiresAt) {
        const exp = Date.parse(job.expiresAt);
        if (Number.isFinite(exp) && exp < Date.now()) {
          console.log(`[cron] "${job.name || job.id}" expired (${job.expiresAt}) — removing`);
          removeJobFromYaml(job.id);
          try { task?.stop(); } catch { /* best effort */ }
          return;
        }
      }

      // Code-owned activity precheck: cheap gate that decides whether the LLM
      // is worth spawning at all. Skip ONLY on a clean exit that prints
      // "[SKIP]" — any non-zero exit, missing marker, timeout, or thrown error
      // falls through and runs the job (fail-open: never skip on a flaky gate).
      if (job.precheck) {
        try {
          const projectRoot = process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw";
          const parsed = parseCronPrecheck(job.precheck, {
            projectRoot,
            agentId: job.agent,
            topicId: job.topicId,
          });
          if (!parsed) {
            console.error(`[cron] "${job.name || job.id}" rejected unsafe/invalid precheck (running anyway)`);
          } else {
            const pc = spawnSync(process.execPath, [parsed.script, parsed.agentId, String(parsed.topicId)], {
              encoding: "utf8",
              timeout: 30_000,
              env: {
                PATH: process.env.PATH,
                LETYCLAW_PROJECT_ROOT: projectRoot,
                TZ: config.timezone || timezone || process.env.TZ || "UTC",
              },
            });
            const out = `${pc.stdout || ""}${pc.stderr || ""}`;
            if (pc.status === 0 && /\[SKIP\]/.test(out)) {
              console.log(`[cron] "${job.name || job.id}" precheck → SKIP (LLM not spawned)`);
              return;
            }
          }
        } catch (err) {
          console.error(`[cron] "${job.name || job.id}" precheck errored (running anyway):`, err instanceof Error ? err.message : String(err));
        }
      }

      if (pendingJobs.has(job.id)) {
        console.log(`[cron] "${job.name || job.id}" coalesced — already queued/running`);
        return;
      }

      const lockKey = job.agent;
      const previous = agentTails.get(lockKey);
      pendingJobs.add(job.id);
      if (previous) {
        console.log(`[cron] "${job.name || job.id}" queued — agent "${job.agent}" busy`);
      }
      const queued = (previous ?? Promise.resolve())
        .catch((err) => {
          console.error(`[cron] prior ${job.agent} job rejected:`, err instanceof Error ? err.message : String(err));
        })
        .then(async () => {
          if (stopped) return;
          console.log(`[cron] "${job.name || job.id}" running (agent: ${job.agent})`);
          const outcome = await runAtomically(job.topicId!, () => runJobOnce(
            job, agent, runClaude, sendToTopic, recordCronIds, isRetry,
          ));
          if (outcome.retry && !isRetry && !stopped) {
            const timer = setTimeout(() => {
              retryTimers.delete(job.id);
              void runScheduled(true).catch((e) =>
                console.error(`[cron] "${job.name || job.id}" retry threw:`, e instanceof Error ? e.message : String(e)),
              );
            }, RETRY_DELAY_MS);
            retryTimers.set(job.id, timer);
          }
        });
      agentTails.set(lockKey, queued);
      try {
        await queued;
      } finally {
        pendingJobs.delete(job.id);
        if (agentTails.get(lockKey) === queued) agentTails.delete(lockKey);
      }
    };

    if (job.enabled !== false) {
      // node-cron v4 schedules start immediately; the removed v3 `scheduled`
      // option is no longer necessary.
      if (!cron.validate(job.schedule)) {
        console.warn(`[cron] job "${job.name || job.id}" has invalid schedule "${job.schedule}" — skipped`);
      } else {
        task = cron.schedule(job.schedule, () => runScheduled(false), { timezone });
        tasks.push(task);
        console.log(`[cron] registered: "${job.name || job.id}" [${job.schedule}] → ${job.agent} (topic:${job.topicId})`);
      }
    } else {
      console.log(`[cron] disabled: "${job.name || job.id}" [${job.schedule}] → ${job.agent} (topic:${job.topicId})`);
    }

    if (job.runNow === true) {
      clearRunNowFromYaml(job.id);
      console.log(`[cron] runNow: "${job.name || job.id}" queued for immediate run`);
      void runScheduled(false).catch((err) => {
        console.error(`[cron] runNow "${job.name || job.id}" failed:`, err instanceof Error ? err.message : String(err));
      });
    }
  }

  // Return stop function for hot-reload
  return () => {
    stopped = true;
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
    for (const t of tasks) t.stop();
    tasks.length = 0;
  };
}
