import TelegramBot from "node-telegram-bot-api";
import type {
  CallbackQuery,
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  MaybeInaccessibleMessage,
  Message,
  SendMessageParams,
} from "node-telegram-bot-api";
import { spawn, execFileSync } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { randomUUID } from "crypto";
import { mkdirSync, unlinkSync, appendFileSync, readdirSync, statSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadConfig, DISALLOWED_TOOLS, disallowedToolsFor } from "./config.js";
import { startCronJobs } from "./cron.js";
import { startMcpHealthMonitor, getMcpState } from "./services/mcp-health.js";
import { renderLoopsBlock } from "./tools/letyclaw-mcp/tools/loops-db.js";
import {
  SessionRecallStore,
  createRecallRunRef,
  type RecallRunRef,
} from "./services/session-recall.js";
import type { LoadedConfig, RoutingEntry, SessionData, RunClaudeResult, StreamLogEvent } from "./types.js";
import {
  dateInTimeZone,
  substituteDateTokens,
  isRateLimited as _isRateLimited,
  loadSession,
  saveSession,
  shouldRotateSession,
  lookupSessionByMessageId,
  createSession,
  pruneOldSessions as _pruneOldSessions,
  drainPendingMessageIds,
  pickRepliedAttachment,
  buildTopicPrompt,
  loadDomainContext,
  loadSkillContext,
  voiceTranscriptionTimeoutMs,
  replaceSendRow,
  isSessionExpiredError,
  parseClaudeResult,
  looksLikeAuthFailure,
  looksLikeProviderFailure,
  createKeyedSerialQueue,
  canSafelyRetryClaudeAttempt,
  appendClaudeAttemptEvents,
  completeMissingToolResults,
  latestSessionIdFromEvents,
  collectClaudeStreamEvent,
  redactToolInputForLog,
  redactToolResultForLog,
  runConnectorClaude,
  connectorWriteHasProviderProof,
  parseApprovedExecutionReply,
  parseConnectorApprovedExecutionReply,
  mdToTelegramHtml,
  splitMessage,
  htmlToPlainText,
  isTelegramHtmlParseError,
  extractCleanupTrailer,
  saveCleanupToken,
  claimCleanupToken,
  unclaimCleanupToken,
  commitCleanupToken,
  updateCleanupToken,
  pruneStaleCleanupTokens,
  parseAdherenceCallback,
  extractFoodLogTrailers,
  saveFoodLogToken,
  claimFoodLogToken,
  unclaimFoodLogToken,
  commitFoodLogToken,
  pruneStaleFoodLogTokens,
  extractSendTrailers,
  extractObsidianLinks,
  describeSendTarget,
  saveSendToken,
  claimSendToken,
  commitSendToken,
  unclaimSendToken,
  deleteSendToken,
  pruneStaleSendTokens,
  resolveGmailAttachments,
} from "./lib.js";
import type { StoredSendPayload, SendKind } from "./lib.js";
import { handlers as gmailHandlers } from "./tools/letyclaw-mcp/tools/gmail.js";
import {
  handlers as voiceHandlers,
  normalizeVoiceCallArgs,
  parseVoiceCallStartResult,
  validateVapiConfiguration,
} from "./tools/letyclaw-mcp/tools/voice.js";
import { handlers as cronHandlers } from "./tools/letyclaw-mcp/tools/cron.js";
import { handlers as ticktickHandlers } from "./tools/letyclaw-mcp/tools/ticktick.js";
import {
  bindVapiProviderCall,
  createVapiCall,
  getVapiCall,
  isTerminalVapiState,
  listStaleUnboundVapiCalls,
  markVapiCallFailed,
  setVapiStatusMessageForClaim,
  type VapiCallRow,
} from "./services/vapi-call-store.js";
import { startVoiceCallMonitor } from "./services/voice-call-monitor.js";
import { writeVapiInboundContext } from "./services/vapi-inbound-context.js";
import { appendFoodLog } from "./services/health-food-log.js";

// --- Project root (handles running from dist/) ---
const __botDirname = dirname(fileURLToPath(import.meta.url));
const BOT_PROJECT_ROOT = __botDirname.includes("/dist") ? join(__botDirname, "..") : __botDirname;

// --- Load config ---
const config: LoadedConfig = loadConfig();
const {
  botName: BOT_NAME,
  ownerName: OWNER_NAME,
  timezone: TIMEZONE,
  routing: AGENTS,
  telegram: { token: BOT_TOKEN, allowedUser: ALLOWED_USER, chatId: GROUP_ID },
  vaultPath: VAULT_PATH,
  whisperModel: WHISPER_MODEL,
  model: MODEL,
  effort: EFFORT,
  claudePath: CLAUDE_PATH,
  sessionsDir: SESSIONS_DIR,
} = config;

// Export the loaded identity/calendar metadata to every in-process tool and
// child MCP server. The YAML config is the runtime source of truth.
process.env.LETYCLAW_BOT_NAME = BOT_NAME;
process.env.LETYCLAW_OWNER_NAME = OWNER_NAME;
process.env.TZ = TIMEZONE;

const ROUTED_TOPIC_IDS = Object.keys(AGENTS)
  .map(Number)
  .filter(Number.isSafeInteger)
  .sort((a, b) => a - b);
const DEFAULT_TOPIC_ID = ROUTED_TOPIC_IDS[0] ?? 2;
const DEFAULT_AGENT_ID = AGENTS[DEFAULT_TOPIC_ID]?.id ?? Object.keys(config.agents)[0] ?? "default";
const CLEANUP_AGENT_ID = process.env.LETYCLAW_CLEANUP_AGENT_ID || DEFAULT_AGENT_ID;
const HEALTH_AGENT_ID = process.env.LETYCLAW_HEALTH_AGENT_ID || "health";

function isHealthTopic(topicId: number | undefined): topicId is number {
  return topicId !== undefined && AGENTS[topicId]?.id === HEALTH_AGENT_ID;
}

const SESSION_TTL = config.session.ttlHours * 60 * 60 * 1000;
const CLAUDE_TIMEOUT = config.timeouts.claudeTotal;

// User turn injected when a run that hit CLAUDE_TIMEOUT is auto-resumed. The
// interrupted run's last tool call may or may not have completed, so the model
// must verify recent side-effectful actions before redoing them.
const TIMEOUT_CONTINUATION_PROMPT =
  "[SYSTEM] Your previous run was stopped by a hard per-run time limit mid-work. " +
  "The conversation state is intact, but your last in-flight tool call may or may not have completed. " +
  "Continue the original task from where you stopped. Before redoing any side-effectful action " +
  "(creating pages/tasks, sending messages, writing files), check whether it already happened. " +
  "You are on a fresh time budget of the same length — prioritize finishing and delivering the result " +
  "over further exploration; if the task is large, deliver what you have plus what remains.";

// --- Bind lib functions to config ---
const rateLimiter = new Map<number, number[]>();
const isRateLimited = (userId: number): boolean => _isRateLimited(rateLimiter, userId, config.rateLimit);

// Unified agent ID for session management (all topics share one namespace)
const UNIFIED_AGENT = "letyclaw";

// --- Session management ---
mkdirSync(SESSIONS_DIR, { recursive: true });

// --- Cleanup-button storage (briefing trailers) ---
const CLEANUP_DIR = join(VAULT_PATH, CLEANUP_AGENT_ID, "cleanup-pending");
const CLEANUP_TTL_HOURS = 48;
mkdirSync(CLEANUP_DIR, { recursive: true });

// --- Send-approval button storage (SEND trailers) ---
const SEND_DIR = join(SESSIONS_DIR, ".send-pending");
const SEND_TTL_HOURS = 48;
mkdirSync(SEND_DIR, { recursive: true });

// --- Food-log button storage (Health response trailers) ---
const FOOD_LOG_DIR = join(SESSIONS_DIR, ".food-log-pending");
const FOOD_LOG_TTL_HOURS = 48;
mkdirSync(FOOD_LOG_DIR, { recursive: true });

// --- Structured logging ---
const LOGS_DIR = join(BOT_PROJECT_ROOT, "logs");
const LOG_RETENTION_DAYS = 7;
mkdirSync(LOGS_DIR, { recursive: true });

const RECALL_DB_PATH = join(SESSIONS_DIR, "session-recall.sqlite");
let recallStore: SessionRecallStore | null = null;
let recallHealthError: string | null = null;
try {
  recallStore = new SessionRecallStore(RECALL_DB_PATH);
} catch (err) {
  // Never destroy/recreate a damaged recall DB automatically: JSONL only
  // covers seven days, so a rebuild could silently discard older retained
  // evidence. User turns continue and /status exposes the degraded index.
  recallHealthError = err instanceof Error ? err.message : String(err);
  console.error(`[recall] unavailable: ${recallHealthError}`);
}

// Persist a truncated copy of the agent's response text (and cleanup/send
// trailers' metadata). Without it, tone / language-compliance / link presence /
// whether a SEND trailer ever rendered are all un-auditable after the fact —
// the logs only ever held `responseLen`. Default ON; flip off via env if the
// retention/PII trade-off ever changes. Capped to keep log files small (still
// inside the 7-day retention window — these are not a permanent archive).
const LOG_RESPONSE_TEXT = process.env.LETYCLAW_LOG_RESPONSE_TEXT !== "false";
const RESPONSE_TEXT_MAX = 4000;

function logFile(agentId: string, topicId: number, ts?: string): string {
  const parsed = ts ? new Date(ts) : new Date();
  const date = dateInTimeZone(Number.isNaN(parsed.getTime()) ? new Date() : parsed, TIMEZONE);
  return join(LOGS_DIR, `${date}-${agentId}-topic${topicId}.jsonl`);
}

// `ts` defaults to write-time, but stream events pass their real arrival time so
// per-tool timing survives (otherwise every tool_call shares the run-end ts).
function logEntry(
  agentId: string,
  topicId: number,
  entry: Record<string, unknown>,
  ts?: string,
  runRef?: RecallRunRef,
): void {
  const eventTs = ts || new Date().toISOString();
  const eventId = randomUUID();
  const enriched = runRef
    ? {
      ...entry,
      eventId,
      runId: runRef.runId,
      conversationId: runRef.conversationId,
    }
    : entry;
  const file = logFile(agentId, topicId, eventTs);
  let appended = false;
  try {
    appendFileSync(file, JSON.stringify({ ts: eventTs, ...enriched }) + "\n");
    appended = true;
  } catch { /* JSONL failure must not fail the user turn */ }

  // JSONL-first ordering makes any missed SQLite write repairable by startup
  // backfill. Only run-scoped signal events enter recall; operational chatter
  // without a runRef stays in the short-lived audit log only.
  if (appended && recallStore && runRef) {
    try {
      recallStore.indexLogEvent({
        eventKey: `event:${eventId}`,
        runId: runRef.runId,
        conversationId: runRef.conversationId,
        ts: eventTs,
        agentId,
        topicId,
        mode: runRef.mode,
        entry: enriched,
        sourceFile: file,
      });
      recallHealthError = null;
    } catch (err) {
      recallHealthError = err instanceof Error ? err.message : String(err);
      console.error(`[recall] index failed: ${recallHealthError}`);
    }
  }
}

function bindRecallRun(runRef: RecallRunRef, sessionId: string | undefined): void {
  const cleanSessionId = sessionId?.trim();
  if (!cleanSessionId) return;
  const nextConversationId = `session:${cleanSessionId}`;
  if (runRef.conversationId === nextConversationId) return;
  if (recallStore) {
    try {
      recallStore.bindRun(runRef.runId, cleanSessionId, runRef.conversationId);
      recallHealthError = null;
    } catch (err) {
      recallHealthError = err instanceof Error ? err.message : String(err);
      console.error(`[recall] session bind failed: ${recallHealthError}`);
    }
  }
  runRef.conversationId = nextConversationId;
}

function createTrackedRunRef(
  runId: string,
  resumeSessionId: string | undefined,
  mode: "user" | "cron",
): RecallRunRef {
  const runRef = createRecallRunRef(runId, resumeSessionId, mode);
  if (resumeSessionId && recallStore) {
    try {
      runRef.conversationId = recallStore.resolveConversation(resumeSessionId) ?? runRef.conversationId;
      recallHealthError = null;
    } catch (err) {
      recallHealthError = err instanceof Error ? err.message : String(err);
      console.error(`[recall] lineage lookup failed: ${recallHealthError}`);
    }
  }
  return runRef;
}

function registerRecallSession(runRef: RecallRunRef, sessionId: string | undefined): void {
  const cleanSessionId = sessionId?.trim();
  if (!cleanSessionId || !recallStore) return;
  try {
    recallStore.registerSession(cleanSessionId, runRef.conversationId);
    recallHealthError = null;
  } catch (err) {
    recallHealthError = err instanceof Error ? err.message : String(err);
    console.error(`[recall] lineage registration failed: ${recallHealthError}`);
  }
}

function pruneOldLogs(): void {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
  let pruned = 0;
  try {
    for (const f of readdirSync(LOGS_DIR)) {
      const p = join(LOGS_DIR, f);
      if (f.endsWith(".jsonl") && statSync(p).mtimeMs < cutoff) {
        unlinkSync(p);
        pruned++;
      }
    }
  } catch { /* ignore */ }
  if (pruned > 0) console.log(`[logs] pruned ${pruned} old log file(s)`);
}
pruneOldLogs();
if (recallStore) {
  try {
    const stats = recallStore.backfillJsonl(LOGS_DIR, Date.now() - LOG_RETENTION_DAYS * 86_400_000);
    console.log(
      `[recall] ready: ${recallStore.count()} event(s); backfill inserted=${stats.inserted} ` +
      `duplicates=${stats.duplicates} malformed=${stats.malformed}`,
    );
  } catch (err) {
    recallHealthError = err instanceof Error ? err.message : String(err);
    console.error(`[recall] backfill failed: ${recallHealthError}`);
  }
}
setInterval(pruneOldLogs, 6 * 60 * 60 * 1000);

// --- Session pruning ---
function pruneOldSessions(): void {
  const pruned = _pruneOldSessions(SESSIONS_DIR, config.session.pruneAfterDays);
  if (pruned > 0) console.log(`[sessions] pruned ${pruned} old session(s)`);
  if (recallStore) {
    try {
      const recallPruned = recallStore.prune(config.session.pruneAfterDays);
      if (recallPruned > 0) console.log(`[recall] pruned ${recallPruned} stale event(s)`);
      recallHealthError = null;
    } catch (err) {
      recallHealthError = err instanceof Error ? err.message : String(err);
      console.error(`[recall] prune failed: ${recallHealthError}`);
    }
  }
}

pruneOldSessions();
setInterval(pruneOldSessions, 6 * 60 * 60 * 1000);

function pruneStaleCleanups(): void {
  const pruned = pruneStaleCleanupTokens(CLEANUP_DIR, CLEANUP_TTL_HOURS);
  if (pruned > 0) console.log(`[cleanup] pruned ${pruned} stale token(s)`);
}
pruneStaleCleanups();
setInterval(pruneStaleCleanups, 6 * 60 * 60 * 1000);

function pruneStaleSends(): void {
  const pruned = pruneStaleSendTokens(SEND_DIR, SEND_TTL_HOURS);
  if (pruned > 0) console.log(`[send] pruned ${pruned} stale token(s)`);
}
pruneStaleSends();
setInterval(pruneStaleSends, 6 * 60 * 60 * 1000);

function pruneStaleFoodLogs(): void {
  const pruned = pruneStaleFoodLogTokens(FOOD_LOG_DIR, FOOD_LOG_TTL_HOURS);
  if (pruned > 0) console.log(`[food] pruned ${pruned} stale token(s)`);
}
pruneStaleFoodLogs();
setInterval(pruneStaleFoodLogs, 6 * 60 * 60 * 1000);

// --- Orphaned MCP subprocess reaper ---
// Belt-and-suspenders for the process-group kill in runClaudeProcess. Catches
// MCP children that escaped (parent crashed before settle, SIGTERM didn't
// propagate, ad-hoc `claude` runs from outside the bot, etc.).
//
// Earlier attempt: filter by ppid=1. WRONG — Claude CLI spawns MCPs (or
// npx does) with detached/double-fork, so legit MCP children show ppid=1
// while their grandparent Claude CLI is still alive and using them.
// So we can't use ppid=1 alone.
//
// Current logic: an MCP is orphaned if EITHER
//   (a) its process group leader is dead (signal 0 → ESRCH); OR
//   (b) ppid==1 AND no live process in the entire system claims this MCP
//       as a descendant (gone-from-tree check).
//
// (a) catches the common case where the parent claude died cleanly.
// (b) catches the case where PID reuse made the dead pgid look "alive"
//     (some other unrelated process now owns that PID number). This is
//     why MIN_AGE_SECS used to need to be 30min — to avoid racing a
//     legit short-lived MCP. 5min is enough now that (b) also catches.
//
// Hard exclusions:
//   - argv must contain `-mcp` (email-mcp, fli-mcp, marketdata-mcp, letyclaw-mcp)
//   - skip playwright (port-based systemd service)
//   - skip processes younger than MIN_AGE_SECS — they may be mid-startup
//
// Tunable: MIN_AGE_SECS. 5 min is well past typical MCP startup (~5-10s)
// and well under the 20-min CLAUDE_TIMEOUT, so a still-legitimate MCP
// can't be 5 min old without an alive parent. Lower threshold = orphans
// reaped faster = subsequent claude spawns aren't poisoned by them.
function reapStaleMcpSubprocesses(): void {
  const MIN_AGE_SECS = 5 * 60;
  try {
    const out = execFileSync("ps", ["-eo", "pid,ppid,pgid,etimes,args"], { encoding: "utf8" });
    type Row = { pid: number; ppid: number; pgid: number; etime: number; args: string };
    const rows: Row[] = [];
    for (const line of out.split("\n").slice(1)) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      if (!m) continue;
      rows.push({
        pid: parseInt(m[1]!, 10),
        ppid: parseInt(m[2]!, 10),
        pgid: parseInt(m[3]!, 10),
        etime: parseInt(m[4]!, 10),
        args: m[5]!,
      });
    }

    // Walk-up-ppid-chain check for (b). We don't need a live-pid set
    // because rows.find() against the snapshot is the same answer.
    const hasLiveAncestor = (start: number): boolean => {
      // Walk up the ppid chain. Stop at 1 (init), at a cycle, or when ppid
      // points to a non-existent pid. If we never pass through a claude
      // ancestor, treat as no-live-ancestor → orphan.
      const seen = new Set<number>();
      let cur = start;
      while (cur > 1 && !seen.has(cur)) {
        seen.add(cur);
        const row = rows.find((r) => r.pid === cur);
        if (!row) return false;
        if (/^claude\b/.test(row.args) || / claude\b/.test(row.args)) return true;
        cur = row.ppid;
      }
      return false;
    };

    for (const r of rows) {
      if (r.etime < MIN_AGE_SECS) continue;
      if (!/-mcp\b/.test(r.args)) continue;
      if (/playwright/i.test(r.args)) continue;

      let orphan = false;
      let reason = "";
      // (a) process group leader dead?
      try { process.kill(r.pgid, 0); /* leader alive */ } catch {
        orphan = true; reason = `pgid=${r.pgid} dead`;
      }
      // (b) ppid==1 and no claude ancestor anywhere in the tree?
      if (!orphan && r.ppid === 1 && !hasLiveAncestor(r.pid)) {
        orphan = true; reason = `ppid=1, no claude ancestor in tree`;
      }
      if (!orphan) continue;

      try {
        process.kill(r.pid, "SIGTERM");
        console.warn(
          `[reaper] killed orphaned MCP pid=${r.pid} pgid=${r.pgid} ppid=${r.ppid} age=${r.etime}s ` +
          `reason="${reason}" args=${r.args.slice(0, 100)}`,
        );
      } catch { /* already gone or not ours */ }
    }
  } catch (err) {
    console.error("[reaper] failed:", err instanceof Error ? err.message : String(err));
  }
}
reapStaleMcpSubprocesses();
setInterval(reapStaleMcpSubprocesses, 5 * 60 * 1000);

// --- Per-topic concurrency ---
// One serialization chain PER TOPIC, shared by BOTH the user-message path and
// the cron/health-trigger path. Sessions are keyed by topicId (the session
// file is letyclaw-topic-<topicId>.json, UNIFIED_AGENT namespace), so anything
// that runs `claude --resume` and writes that file must serialize on topicId.
// Previously the user path locked on `${agent.id}-${topicId}` and cron locked
// on `agentId` alone — the two keyspaces never aligned, so a 09:00 briefing and
// a user message in the same topic could run two concurrent --resume on one
// session (conversation fork + last-writer-wins on the session file). Keying
// both on topicId fixes that and still serializes same-topic cron double-fires
// (cron tick vs health-webhook trigger).
const runOnTopicLock = createKeyedSerialQueue<number>();
let voiceMonitor: ReturnType<typeof startVoiceCallMonitor> | null = null;

// --- Graceful shutdown ---
let shuttingDown = false;
const activeProcesses = new Set<ChildProcess>();

// --- Run a command as a promise using spawn ---
function runCmd(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] } as SpawnOptions);
    let stdout = "", stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.stdout!.on("data", (d: Buffer) => { stdout += d; });
    child.stderr!.on("data", (d: Buffer) => { stderr += d; });
    child.on("close", (code: number | null) => settle(() => {
      code === 0 ? resolve(stdout) : reject(new Error(stderr || `${cmd} exit ${code}`));
    }));
    child.on("error", (err) => settle(() => reject(err)));
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill();
        const errTail = stderr.trim() ? `; stderr: ${stderr.trim().slice(-500)}` : "";
        settle(() => reject(new Error(`${cmd} timeout after ${opts.timeout}ms${errTail}`)));
      }, opts.timeout);
    }
  });
}

// --- Telegram file download helpers ---
// Fetch a Telegram file (by file_id) to /tmp so the agent can read it. Used for
// both the incoming message's own attachments and ones pulled from a reply.
// Returns the local path, or null on failure (logged, non-fatal).
async function downloadTelegramDocument(fileId: string, fileName: string | undefined, msgId: number): Promise<string | null> {
  try {
    const file = await bot.getFile(fileId);
    const ext = (fileName?.split(".").pop() || file.file_path?.split(".").pop() || "bin").toLowerCase();
    const safeName = (fileName || `doc-${msgId}.${ext}`).replace(/[^a-zA-Z0-9._-]/g, "_");
    const tmpPath = `/tmp/doc-${msgId}-${safeName}`;
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    await runCmd("curl", ["-sL", url, "-o", tmpPath], { timeout: 30000 });
    return tmpPath;
  } catch (err) {
    console.error("Document handling error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function downloadTelegramPhoto(fileId: string, msgId: number): Promise<string | null> {
  try {
    const file = await bot.getFile(fileId);
    const ext = file.file_path?.split(".").pop() || "jpg";
    const tmpPath = `/tmp/photo-${msgId}.${ext}`;
    const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    await runCmd("curl", ["-sL", url, "-o", tmpPath], { timeout: 15000 });
    return tmpPath;
  } catch (err) {
    console.error("Photo handling error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// --- Voice transcription ---
// whisper.cpp on the droplet runs slower than wall-clock, and every invocation
// is capped at 5 min (voiceTranscriptionTimeoutMs). A long voice note therefore
// can't be transcribed in one shot — it gets split into <=VOICE_CHUNK_SEC
// sub-clips that each finish comfortably under the cap, transcribed sequentially
// (whisper already saturates all 4 cores, so running chunks in parallel would
// only add contention, not speed), then the partial transcripts are joined.
// Short clips keep the single-run fast path.
const VOICE_CHUNK_SEC = 60;      // sub-clip length; per-chunk timeout (270s) stays uncapped
const VOICE_MAX_SEC = 20 * 60;   // safety ceiling: transcribe at most this much audio
const VOICE_HEADSUP_SEC = 180;   // tell the user it'll take a while past this length

// A long voice note blocks its own message handler for many minutes while
// whisper grinds. Other messages in the same topic keep being processed
// concurrently, and the agent — not yet holding the (still-cooking) transcript —
// used to FABRICATE one when asked "where's my transcript?". Track in-flight
// transcriptions per topic so those concurrent turns get told to wait instead.
const pendingVoiceTranscriptions = new Map<number, { etaAt: number }>();

function voiceTranscriptionNote(topicId: number | undefined): string {
  if (topicId === undefined) return "";
  const p = pendingVoiceTranscriptions.get(topicId);
  if (!p) return "";
  const remainMin = Math.max(1, Math.ceil((p.etaAt - Date.now()) / 60_000));
  return `[SYSTEM: A voice note the user sent is still being transcribed locally in the background (~${remainMin} min left). You do NOT have its text yet — it will arrive as a separate message when ready. If the user asks about that transcript, tell them it's still processing and to hold; do NOT invent, summarize, or reconstruct it from memory or earlier context.]\n\n`;
}

async function whisperRun(filePath: string, durationSec: number): Promise<string> {
  const timeoutMs = voiceTranscriptionTimeoutMs(durationSec);
  const stdout = await runCmd("whisper-cli", [
    // Greedy decoding (-bs 1 -bo 1) instead of whisper.cpp's default
    // 5-beam / best-of-5 search: ~5x faster on CPU for negligible accuracy loss.
    "-m", WHISPER_MODEL, "-nt", "-l", "auto", "-bs", "1", "-bo", "1", "-f", filePath
  ], { timeout: timeoutMs });
  return stdout.trim();
}

async function transcribeVoice(filePath: string, durationSec?: number): Promise<string | null> {
  try {
    // Short enough to clear the 5-min cap in a single run.
    if (!durationSec || durationSec <= VOICE_CHUNK_SEC) {
      console.log(`[voice] transcribing ${durationSec ? `${durationSec}s` : "unknown duration"} clip (single run)`);
      return await whisperRun(filePath, durationSec ?? VOICE_CHUNK_SEC);
    }

    const truncated = durationSec > VOICE_MAX_SEC;
    const effectiveSec = truncated ? VOICE_MAX_SEC : durationSec;
    const nChunks = Math.ceil(effectiveSec / VOICE_CHUNK_SEC);
    console.log(`[voice] transcribing ${durationSec}s clip in ${nChunks}×${VOICE_CHUNK_SEC}s chunks${truncated ? ` (capped at ${VOICE_MAX_SEC}s)` : ""}`);

    // Split the 16kHz mono wav into fixed-length pieces, each re-encoded into a
    // standalone wav. `-t` bounds the audio read to the ceiling; `.slice` is a
    // belt-and-suspenders guard in case the segmenter over-produces.
    const dir = `${filePath}.chunks`;
    mkdirSync(dir, { recursive: true });
    try {
      await runCmd("ffmpeg", [
        "-i", filePath, "-t", String(effectiveSec),
        "-f", "segment", "-segment_time", String(VOICE_CHUNK_SEC),
        "-c:a", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y",
        `${dir}/chunk-%03d.wav`,
      ], { timeout: 60_000 });

      const parts = readdirSync(dir).filter((f) => f.endsWith(".wav")).sort().slice(0, nChunks);
      const out: string[] = [];
      let ok = 0;
      for (let i = 0; i < parts.length; i++) {
        try {
          const seg = await whisperRun(`${dir}/${parts[i]}`, VOICE_CHUNK_SEC);
          if (seg) { out.push(seg); ok++; }
          console.log(`[voice] chunk ${i + 1}/${parts.length} done (${seg.length} chars)`);
        } catch (err) {
          // One bad sub-clip shouldn't sink the whole transcript — mark the gap.
          console.error(`[voice] chunk ${i + 1}/${parts.length} failed:`, err instanceof Error ? err.message : String(err));
          out.push("[…inaudible…]");
        }
      }
      if (ok === 0) return null;
      let text = out.join(" ").replace(/\s+/g, " ").trim();
      if (truncated) {
        const mins = Math.round(VOICE_MAX_SEC / 60);
        text += `\n\n[voice note exceeded ${mins} min — transcript cut off at ${mins} min]`;
      }
      return text;
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  } catch (err) {
    console.error("Whisper transcription failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

// --- Run Claude CLI as async subprocess ---
interface ClaudeProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runClaudeProcess(cwd: string, args: string[], extraEnv: Record<string, string> = {}, onLine?: (line: string) => void): Promise<ClaudeProcessResult> {
  return new Promise((resolve, reject) => {
    // detached: true puts Claude CLI + its MCP children in a new process group,
    // so we can reap the whole group on exit (Claude CLI doesn't always kill
    // npx-spawned MCP subprocesses, which otherwise leak and eat RAM)
    const child: ChildProcess = spawn(CLAUDE_PATH, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        PATH: `/root/.local/bin:/usr/local/bin:/usr/bin:/bin`,
        // Disable Claude CLI's deferred-tool ToolSearch — load all MCP tools
        // upfront. Trade-off: ~5-10k extra tokens per turn for tool defs, but
        // eliminates the 3-5 turn ToolSearch tax on first request of every
        // session. We're on subscription billing, so latency > token cost.
        ENABLE_TOOL_SEARCH: "false",
        LETYCLAW_VAULT_PATH: VAULT_PATH,
        LETYCLAW_SESSIONS_DIR: SESSIONS_DIR,
        LETYCLAW_CHAT_ID: String(GROUP_ID),
        LETYCLAW_PROJECT_ROOT: process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw",
        LETYCLAW_BOT_NAME: BOT_NAME,
        LETYCLAW_OWNER_NAME: OWNER_NAME,
        TZ: TIMEZONE,
        ...extraEnv,
      },
    });

    activeProcesses.add(child);
    child.stdin!.end();

    let stdout = "", stderr = "";
    let killed = false;
    let settled = false;
    let lineBuf = "";

    const flushLineBuf = (): void => {
      if (!onLine || !lineBuf.trim()) return;
      const finalLine = lineBuf;
      lineBuf = "";
      try { onLine(finalLine); } catch { /* never let logging break a run */ }
    };

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid == null) return;
      try { process.kill(-child.pid, signal); } catch { /* already gone */ }
    };

    const reapGroup = (): void => {
      // SIGTERM first, SIGKILL after grace — reaps surviving MCP descendants
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 2000).unref();
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      activeProcesses.delete(child);
      clearTimeout(overallTimer);
      // stream-json normally newline-terminates each event, but a timeout can
      // cut the process after a complete final JSON object and before its `\n`.
      // Flush it so retry safety cannot miss a last-moment tool_call.
      flushLineBuf();
      reapGroup();
      fn();
    };

    // stdout is still buffered in full (parseClaudeResult needs the whole
    // stream). Additionally, when onLine is provided, split on newlines as data
    // arrives so each stream event can be logged with its real arrival time.
    // Purely additive — a throw in onLine can't affect the resolve/reject path.
    child.stdout!.on("data", (d: Buffer) => {
      stdout += d;
      if (!onLine) return;
      lineBuf += d.toString();
      let nl: number;
      while ((nl = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        if (line.trim()) { try { onLine(line); } catch { /* never let logging break a run */ } }
      }
    });
    child.stderr!.on("data", (d: Buffer) => { stderr += d; });

    // Single overall timeout — the no-output watchdog was removed because
    // it kept killing legit work (long tool calls / model thinking emit
    // no streaming output for minutes). The orphan-reaper below catches
    // any MCP children that survive the process-group kill.
    const overallTimer = setTimeout(() => {
      killed = true;
      settle(() => reject(new Error("timeout")));
    }, CLAUDE_TIMEOUT);

    child.on("close", (code: number | null) => {
      settle(() => { if (!killed) resolve({ code, stdout, stderr }); });
    });

    child.on("error", (err: Error) => {
      settle(() => reject(err));
    });
  });
}

// --- Build Claude CLI args ---
function buildClaudeArgs(
  prompt: string,
  maxTurns: number,
  resumeSessionId?: string,
  disallowed: readonly string[] = DISALLOWED_TOOLS,
  systemContext?: string,
): string[] {
  const args = [
    "-p", prompt,
    "--model", MODEL,
    "--effort", EFFORT,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(maxTurns),
    "--dangerously-skip-permissions",
    // Remove the irreversible send tools from the agent's context. The
    // SEND-approval button (executeSend) calls the gmail handlers directly
    // in-process, so this enforces the approval flow with no capability loss.
    ...(disallowed.length ? ["--disallowedTools", ...disallowed] : []),
    ...(systemContext?.trim() ? ["--append-system-prompt", systemContext.trim()] : []),
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  return args;
}

interface RunClaudeOptions {
  maxTurns?: number;
  resumeSessionId?: string;
  runId?: string;
  allowSendTools?: boolean;
  skills?: string[];
  enabledToolsets?: string[];
  disabledToolsets?: string[];
  disabledTools?: string[];
}

function mergeUnique(...lists: Array<readonly string[] | undefined>): string[] | undefined {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const raw of list ?? []) {
      const v = raw.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
  }
  return out.length ? out : undefined;
}

function mergeEnabledToolsets(
  agentToolsets: readonly string[] | undefined,
  runToolsets: readonly string[] | undefined,
): string[] | undefined {
  const agentList = mergeUnique(agentToolsets);
  const runList = mergeUnique(runToolsets);
  if (agentList && runList) {
    const runSet = new Set(runList);
    const intersection = agentList.filter((x) => runSet.has(x));
    return intersection.length ? intersection : ["__none__"];
  }
  return runList ?? agentList;
}

/**
 * Run Claude CLI for a given agent.
 */
type RetryTaggedError = Error & {
  safeToRetryClaudeAttempt?: boolean;
  streamEvents?: StreamLogEvent[];
  // Session id observed via the stream before the run died. Lets the error
  // path map the turn's messages to the session so a reply still resumes it.
  discoveredSessionId?: string;
};

function tagClaudeAttemptError(
  error: unknown,
  safeToRetry: boolean,
  streamEvents?: readonly StreamLogEvent[],
): RetryTaggedError {
  const tagged = (error instanceof Error ? error : new Error(String(error))) as RetryTaggedError;
  tagged.safeToRetryClaudeAttempt = safeToRetry;
  if (streamEvents?.length) tagged.streamEvents = [...streamEvents];
  return tagged;
}

function isExplicitlySafeClaudeRetry(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as { safeToRetryClaudeAttempt?: unknown }).safeToRetryClaudeAttempt === true;
}

async function runClaude(
  agentId: string,
  topicId: number,
  userMessage: string,
  {
    maxTurns = 10,
    resumeSessionId,
    runId: requestedRunId,
    allowSendTools = false,
    skills,
    enabledToolsets,
    disabledToolsets,
    disabledTools,
  }: RunClaudeOptions = {},
): Promise<RunClaudeResult> {
  const cwd = VAULT_PATH;
  const agentCfg = config.agents[agentId];
  const effectiveRunId = requestedRunId?.trim() || randomUUID();

  // Always include topic context — even on resume, it helps orient the model.
  // Also inject the domain's OPEN LOOPS block as working memory so tracked state
  // (what's pending / already handled) rides every user AND cron turn — the
  // single fix for items being re-derived from raw signals and re-nagged.
  let openLoopsBlock = "";
  try { openLoopsBlock = renderLoopsBlock(agentId); } catch { /* never block a turn on the ledger */ }
  const skillNames = mergeUnique(agentCfg?.skills, skills);
  const skillsBlock = loadSkillContext(skillNames, {
    projectRoot: BOT_PROJECT_ROOT,
    vaultPath: VAULT_PATH,
    agentId,
  });
  const domainBlock = loadDomainContext(agentId, {
    projectRoot: BOT_PROJECT_ROOT,
    vaultPath: VAULT_PATH,
  });
  if (!domainBlock) throw new Error(`Domain instructions are missing for '${agentId}'`);
  const systemContext = [domainBlock, skillsBlock].filter(Boolean).join("\n\n");
  const prompt = buildTopicPrompt(agentId, topicId, userMessage, openLoopsBlock, undefined, OWNER_NAME);
  let effectiveEnabledToolsets = mergeEnabledToolsets(agentCfg?.enabledToolsets, enabledToolsets);
  if (effectiveEnabledToolsets && skillNames?.length) {
    effectiveEnabledToolsets = mergeUnique(effectiveEnabledToolsets, ["skills"]);
  }
  const scopedDisallowed = disallowedToolsFor({
    allowSendTools,
    enabledToolsets: effectiveEnabledToolsets,
    disabledToolsets: mergeUnique(agentCfg?.disabledToolsets, disabledToolsets),
    disabledTools: mergeUnique(agentCfg?.disabledTools, disabledTools),
  });
  const agentEnv = {
    LETYCLAW_AGENT_ID: agentId,
    LETYCLAW_TOPIC_ID: String(topicId || ""),
    LETYCLAW_RUN_ID: effectiveRunId,
    LETYCLAW_SKILLS: JSON.stringify(skillNames ?? []),
    // Detached workers are leaf agents. They receive the exact policy this
    // parent run sees and may only tighten it in sessions.ts.
    LETYCLAW_DISALLOWED_TOOLS: JSON.stringify(scopedDisallowed),
    LETYCLAW_SUBAGENT_DEPTH: "0",
    LETYCLAW_SESSION_TTL_HOURS: String(config.session.ttlHours),
  };
  const args = buildClaudeArgs(prompt, maxTurns, resumeSessionId, scopedDisallowed, systemContext);

  // Keep every attempt for auditability, while tracking the latest attempt
  // separately for retry safety and final-run metrics. Previously runProc
  // replaced `collected`, so a failed first attempt vanished after a retry.
  let allCollected: StreamLogEvent[] = [];
  let lastAttemptEvents: StreamLogEvent[] = [];
  let attemptNumber = 0;
  const runProc = async (a: string[]): Promise<ClaudeProcessResult> => {
    const attempt = ++attemptNumber;
    const events: StreamLogEvent[] = [];
    try {
      const processResult = await runClaudeProcess(cwd, a, agentEnv, (line) => collectClaudeStreamEvent(line, events));
      const completeEvents = completeMissingToolResults(events, `exit ${processResult.code ?? "unknown"}`);
      const merged = appendClaudeAttemptEvents(allCollected, completeEvents, attempt);
      lastAttemptEvents = merged.attemptEvents;
      allCollected = merged.all;
      return processResult;
    } catch (err) {
      const completeEvents = completeMissingToolResults(events, "process error or timeout");
      const merged = appendClaudeAttemptEvents(allCollected, completeEvents, attempt);
      lastAttemptEvents = merged.attemptEvents;
      allCollected = merged.all;
      throw tagClaudeAttemptError(err, canSafelyRetryClaudeAttempt(lastAttemptEvents), allCollected);
    }
  };

  let result: ClaudeProcessResult;
  let effectiveResumeSessionId = resumeSessionId;
  let fellBackToFresh = false;
  // A hard timeout mid-work is a checkpoint, not a verdict. The on-disk
  // session holds everything the run learned, so resume it with a
  // continuation turn (fresh claudeTotal budget) instead of throwing the
  // progress away. Resuming APPENDS a turn — it never replays executed tools —
  // so it is side-effect safe even when the run died with a write in flight
  // This preserves progress when a long connector workflow reaches the limit.
  const maxContinuations = config.timeouts.claudeMaxContinuations;
  let continuations = 0;
  let sameSessionRetryUsed = false;
  let attemptArgs = args;
  for (;;) {
    try {
      result = await runProc(attemptArgs);
      break;
    } catch (err) {
      const discoveredSessionId = latestSessionIdFromEvents(allCollected) ?? effectiveResumeSessionId;
      const isTimeout = err instanceof Error && err.message === "timeout";
      if (isTimeout && discoveredSessionId && continuations < maxContinuations) {
        continuations++;
        console.warn(`[${agentId}] run hit ${CLAUDE_TIMEOUT}ms mid-work, continuing session ${discoveredSessionId} (${continuations}/${maxContinuations})`);
        logEntry(agentId, topicId, { event: "continuation", attempt: continuations, of: maxContinuations, sessionId: discoveredSessionId });
        effectiveResumeSessionId = discoveredSessionId;
        attemptArgs = buildClaudeArgs(
          TIMEOUT_CONTINUATION_PROMPT,
          maxTurns,
          discoveredSessionId,
          scopedDisallowed,
          systemContext,
        );
        continue;
      }
      // Subprocess failure (watchdog, crash, network blip). If we were
      // resuming, retry the SAME session once — the on-disk session is
      // intact, only the in-memory subprocess died. Falling back to fresh
      // would silently drop conversation context, so we never do that here.
      // Truly expired sessions are caught later via isSessionExpiredError.
      if (effectiveResumeSessionId && !sameSessionRetryUsed && canSafelyRetryClaudeAttempt(lastAttemptEvents)) {
        sameSessionRetryUsed = true;
        console.log(`[${agentId}] session resume failed (${err instanceof Error ? err.message : String(err)}), retrying same session`);
        continue;
      }
      if (effectiveResumeSessionId) {
        console.warn(`[${agentId}] session resume failed after tool activity — refusing unsafe whole-turn replay`);
      }
      const tagged = tagClaudeAttemptError(err, isExplicitlySafeClaudeRetry(err), allCollected);
      tagged.discoveredSessionId = discoveredSessionId;
      throw tagged;
    }
  }

  // Only fall back to fresh for session-specific errors, not all non-zero exits
  if (effectiveResumeSessionId && isSessionExpiredError(result.stdout, result.stderr)) {
    if (!canSafelyRetryClaudeAttempt(lastAttemptEvents)) {
      throw tagClaudeAttemptError(new Error("Claude session expired after tool activity; refusing unsafe whole-turn replay"), false, allCollected);
    }
    console.log(`[${agentId}] session expired, retrying fresh`);
    result = await runProc(buildClaudeArgs(prompt, maxTurns, undefined, scopedDisallowed, systemContext));
    effectiveResumeSessionId = undefined;
    fellBackToFresh = true;
  }

  // Transient auth blip: the CLI sometimes surfaces a 401 "Failed to
  // authenticate" AS the run's result text even when the token is valid (seen
  // mid multi-tool turn on 2026-06-20, token healthy before AND after). Retry
  // ONCE. We inspect only the short FINAL result text — not the raw stream — so
  // a tool result that merely mentions "401" can't trigger a whole-turn re-run
  // (which could double-execute side effects). A genuinely dead token just
  // yields the same error on retry and surfaces normally; the hourly auth
  // monitor is what catches persistent death, not this.
  const parsedResult = (r: ClaudeProcessResult): ReturnType<typeof parseClaudeResult> | null => {
    try { return parseClaudeResult(r.stdout); } catch { return null; }
  };
  const isShortAuthFailure = (text: string): boolean => {
    const trimmed = text.trim();
    return trimmed.length > 0 && trimmed.length < 400 && looksLikeAuthFailure(trimmed);
  };

  let finalParsed = parsedResult(result);
  let finalText = finalParsed?.text ?? "";
  if (isShortAuthFailure(finalText)) {
    if (canSafelyRetryClaudeAttempt(lastAttemptEvents)) {
      // Safe to retry only when the failed attempt made no tool calls. Replaying
      // a turn after side effects could duplicate sends or writes.
      console.log(`[${agentId}] transient auth failure in result, retrying once`);
      result = await runProc(buildClaudeArgs(
        prompt,
        maxTurns,
        effectiveResumeSessionId,
        scopedDisallowed,
        systemContext,
      ));
      finalParsed = parsedResult(result);
      finalText = finalParsed?.text ?? "";
    }
  }

  // A provider control-plane error is not an answer. Throw so user turns surface
  // an execution error and cron/trigger paths enter their retry + alert flow
  // instead of delivering the provider error as if the job succeeded.
  if (finalParsed?.isError || (finalText.trim().length > 0 && finalText.trim().length < 400 && looksLikeProviderFailure(finalText))) {
    const subtype = finalParsed?.subtype ? ` (${finalParsed.subtype})` : "";
    throw tagClaudeAttemptError(
      new Error(`Claude provider failure${subtype}: ${finalText.trim().slice(0, 200) || "unknown error"}`),
      canSafelyRetryClaudeAttempt(lastAttemptEvents),
      allCollected,
    );
  }

  // Parse and return result + raw stream for logging
  const parseAndReturn = (stdout: string): RunClaudeResult => {
    const parsed = parseClaudeResult(stdout);
    const resultEvent = lastAttemptEvents.find((e) => e.event === "result");
    return {
      text: parsed.text,
      sessionId: parsed.sessionId,
      resumed: !!effectiveResumeSessionId,
      fellBackToFresh,
      rawStream: stdout,
      streamEvents: allCollected,
      toolCount: lastAttemptEvents.filter((e) => e.event === "tool_call").length,
      numTurns: typeof resultEvent?.turns === "number" ? resultEvent.turns : undefined,
    };
  };

  if (result.code === 0) return parseAndReturn(result.stdout);

  if (result.stdout) {
    try { return parseAndReturn(result.stdout); } catch { /* ignore */ }
  }

  throw tagClaudeAttemptError(
    new Error(`Claude failed: ${(result.stderr || `exit ${result.code}`).slice(0, 200)}`),
    canSafelyRetryClaudeAttempt(lastAttemptEvents),
    allCollected,
  );
}

// --- Telegram bot ---
// The library default retries failed getUpdates every 300ms, which produced a
// 13-request burst during one Telegram 502 incident. One second keeps normal
// long-poll responsiveness while avoiding an avoidable retry storm.
const bot = new TelegramBot(BOT_TOKEN!, {
  polling: { interval: 1_000, params: { timeout: 10 } },
  // Bound every Bot API request so one broken socket cannot hold the voice
  // monitor (or shutdown) indefinitely. Let our durable queues retry 429s;
  // library-level retry_after sleeps are intentionally disabled.
  request: { timeoutMs: 20_000, maxRetriesOn429: 0 },
});
type SendMessageOptions = Omit<SendMessageParams, "chat_id" | "text">;

let pollingErrorCount = 0;
bot.on("polling_error", (err) => {
  pollingErrorCount++;
  if (pollingErrorCount === 1 || pollingErrorCount % 10 === 0) {
    console.error(`[telegram] polling error #${pollingErrorCount}:`, err instanceof Error ? err.message : String(err));
  }
});

function callbackTopicId(message: MaybeInaccessibleMessage | undefined): number | undefined {
  return message && "message_thread_id" in message ? message.message_thread_id : undefined;
}

// --- Inline-button callback handler ---
// Used for supplement-adherence and food-log buttons. Each callback records
// the structured Health action and edits its own row in place to confirm.
const activeCallbackTasks = new Set<Promise<void>>();

async function processCallbackQuery(query: CallbackQuery): Promise<void> {
  if (query.from?.id !== ALLOWED_USER) return;
  const data = query.data || "";
  // Audit: the user tapped a button. Skip the pure spinner-dismiss callbacks.
  if (data && !data.endsWith(":noop")) {
    const tapTopic = callbackTopicId(query.message) ?? DEFAULT_TOPIC_ID;
    logEntry(routingForTopic(tapTopic)?.id ?? DEFAULT_AGENT_ID, tapTopic, { event: "button_tap", data });
  }
  try {
    if (data.startsWith("adherence:")) {
      const adherence = parseAdherenceCallback(data);
      const topicId = callbackTopicId(query.message);
      if (!adherence || !isHealthTopic(topicId)) {
        await bot.answerCallbackQuery(query.id, { text: "This health action is not valid here" });
        return;
      }
      const { level, slot } = adherence;
      const date = dateInTimeZone(new Date(), TIMEZONE);
      const month = date.slice(0, 7);
      const adhDir = join(VAULT_PATH, "health", "adherence");
      mkdirSync(adhDir, { recursive: true });
      const file = join(adhDir, `${month}.csv`);
      if (!statSync(file, { throwIfNoEntry: false })) {
        appendFileSync(file, "date,slot,level\n");
      }
      appendFileSync(file, `${date},${slot},${level}\n`);
      const labels = {
        full: "✓ all taken",
        partial: "~ partial",
        none: "✗ skipped",
      } as const;
      const confirm = `💊 ${slot} stack — ${labels[level]}  (logged to ${month}.csv)`;
      if (query.message) {
        await bot.editMessageText(confirm, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
        }).catch(() => { /* ignore edit failure */ });
      }
      await bot.answerCallbackQuery(query.id, { text: "Logged" });
      return;
    }
    if (data === "foodlog:noop") {
      await bot.answerCallbackQuery(query.id);
      return;
    }
    if (data.startsWith("foodlog:")) {
      await handleFoodLogCallback(query, data.slice("foodlog:".length));
      return;
    }
    if (data === "cleanup:noop") {
      await bot.answerCallbackQuery(query.id);
      return;
    }
    if (data.startsWith("cleanup:")) {
      await handleCleanupCallback(query, data.slice("cleanup:".length));
      return;
    }
    if (data === "send:noop") {
      await bot.answerCallbackQuery(query.id);
      return;
    }
    if (data.startsWith("send:")) {
      const [, token, action] = data.split(":");
      if (!token || !action) {
        await bot.answerCallbackQuery(query.id, { text: "Bad callback" });
        return;
      }
      await handleSendCallback(query, token, action);
      return;
    }
    // Unknown callback — just dismiss the spinner
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error("[callback_query] error:", err instanceof Error ? err.message : String(err));
    await bot.answerCallbackQuery(query.id, { text: "Error logging" }).catch(() => {});
  }
}

bot.on("callback_query", (query) => {
  if (shuttingDown) {
    void bot.answerCallbackQuery(query.id, { text: "Bot is restarting — please try again shortly" }).catch(() => {});
    return;
  }
  const task = processCallbackQuery(query).catch((err) => {
    console.error("[callback_query] unhandled error:", err instanceof Error ? err.message : String(err));
  });
  activeCallbackTasks.add(task);
  void task.finally(() => { activeCallbackTasks.delete(task); });
});

// --- Food-log button handler ---
// Health responses carry a validated, persisted meal payload. One tap writes
// that exact suggestion to the health food CSV; it never routes through a
// conversational "confirm" turn that could lose or reinterpret the meal.
async function handleFoodLogCallback(query: CallbackQuery, token: string): Promise<void> {
  const callbackData = `foodlog:${token}`;
  const replaceRow = (row: InlineKeyboardButton[]): Promise<unknown> => {
    if (!query.message) return Promise.resolve();
    const currentKeyboard = "reply_markup" in query.message
      ? query.message.reply_markup?.inline_keyboard
      : undefined;
    const rows = currentKeyboard && currentKeyboard.length > 0
      ? currentKeyboard.map((currentRow) => currentRow.some((button) => button.callback_data === callbackData) ? row : currentRow)
      : [row];
    return bot.editMessageReplyMarkup(
      { inline_keyboard: rows },
      { chat_id: query.message.chat.id, message_id: query.message.message_id },
    ).catch(() => { /* cosmetic confirmation only */ });
  };

  const payload = claimFoodLogToken(FOOD_LOG_DIR, token);
  if (!payload) {
    await bot.answerCallbackQuery(query.id, { text: "Food log expired or already processed" }).catch(() => {});
    return;
  }

  const callbackTopic = callbackTopicId(query.message);
  const topicId = payload.topicId ?? callbackTopic;
  if (!isHealthTopic(topicId) || (callbackTopic !== undefined && callbackTopic !== topicId)) {
    // Food trailers are accepted only from the Health topic. This keeps an
    // arbitrary callback in another domain from writing health data.
    unclaimFoodLogToken(FOOD_LOG_DIR, token);
    await bot.answerCallbackQuery(query.id, { text: "This food log is not valid here" }).catch(() => {});
    return;
  }

  const originalRow: InlineKeyboardButton[] = [{
    text: payload.label || "🍽 Log food",
    callback_data: callbackData,
  }];
  await bot.answerCallbackQuery(query.id, { text: "Logging food…" }).catch(() => {});
  await replaceRow([{ text: "🍽 Logging food…", callback_data: "foodlog:noop" }]);

  try {
    const result = appendFoodLog(VAULT_PATH, payload);
    const committed = commitFoodLogToken(FOOD_LOG_DIR, token);
    if (!committed) console.error(`[food] could not finalize token ${token} after logging`);
    const stats = [
      result.caloriesKcal === undefined ? undefined : `${result.caloriesKcal} kcal`,
      result.proteinG === undefined ? undefined : `${result.proteinG} g protein`,
    ].filter((value): value is string => value !== undefined);
    const summary = `✓ Logged ${result.entryCount} meal${result.entryCount === 1 ? "" : "s"}${stats.length ? ` · ${stats.join(", ")}` : ""}`;
    await replaceRow([{ text: summary, callback_data: "foodlog:noop" }]);
    logEntry(HEALTH_AGENT_ID, topicId, {
      event: "food_log_saved",
      token,
      date: payload.date,
      entries: result.entryCount,
      calories_kcal: result.caloriesKcal,
      protein_g: result.proteinG,
      committed,
    });
    await bot.answerCallbackQuery(query.id, { text: "Food logged" }).catch(() => {});
  } catch (err) {
    unclaimFoodLogToken(FOOD_LOG_DIR, token);
    console.error("[food] log write failed:", err instanceof Error ? err.message : String(err));
    await replaceRow(originalRow);
    await bot.answerCallbackQuery(query.id, { text: "Could not log food — try again" }).catch(() => {});
  }
}

// --- Cleanup-button handler ---
// User tapped "🧹 Clean up (N)" on a morning/evening briefing. Look up
// the persisted item list, spawn the configured cleanup agent to execute deletes,
// and edit the message's button row to reflect status.
async function handleCleanupCallback(query: CallbackQuery, token: string): Promise<void> {
  const stored = claimCleanupToken(CLEANUP_DIR, token);
  const editMarkup = (text: string): Promise<unknown> => {
    if (!query.message) return Promise.resolve();
    return bot.editMessageReplyMarkup(
      { inline_keyboard: [[{ text, callback_data: "cleanup:noop" }]] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id },
    ).catch(() => { /* ignore edit failure */ });
  };

  if (!stored || !stored.items?.length) {
    await bot.answerCallbackQuery(query.id, { text: "Cleanup expired or already processed" });
    await editMarkup("✓ Cleanup already done");
    return;
  }

  const count = stored.items.length;
  await bot.answerCallbackQuery(query.id, { text: `Cleaning up ${count}…` });
  await editMarkup(`🧹 Cleaning up ${count}…`);

  const topicId = stored.topicId ?? callbackTopicId(query.message) ?? DEFAULT_TOPIC_ID;
  const cleanupPath = join(CLEANUP_DIR, `${token}.claimed`);
  const cleanupPrompt = [
    `Cleanup task — process ${cleanupPath}.`,
    "",
    "Read the JSON. For each item, delete the exact email using the account alias",
    "stored on that item. Pass the alias through unchanged to the matching email",
    "tool; never guess an account or substitute a different mailbox.",
    "",
    "Track the count of successful deletes vs failures. Do NOT call",
    "message_send or write to memory — the bot edits the briefing message",
    "based on your reply.",
    "",
    "Final response: a single line in the form `DONE: X/Y` (deleted X of",
    "Y total) — nothing else.",
  ].join("\n");

  try {
    const result = await runClaude(CLEANUP_AGENT_ID, topicId, cleanupPrompt, { maxTurns: Math.max(15, count + 5) });
    const reply = (result.text || "").trim();
    const m = reply.match(/DONE:\s*(\d+)\s*\/\s*(\d+)/i);
    const committed = commitCleanupToken(CLEANUP_DIR, token);
    if (!committed) {
      throw new Error("cleanup token could not be committed after execution");
    }
    if (m && Number(m[2]) === count && Number(m[1]) <= count) {
      const ok = Number(m[1]);
      const total = Number(m[2]);
      const status = ok === total ? `✅ Cleaned up ${ok}/${total}` : `⚠️ Cleaned up ${ok}/${total}`;
      await editMarkup(status);
    } else {
      await editMarkup("⚠️ Cleanup outcome unknown — review the mailbox");
    }
  } catch (err) {
    console.error("[cleanup] agent run failed:", err instanceof Error ? err.message : String(err));
    const retryable = isExplicitlySafeClaudeRetry(err);
    if (retryable) unclaimCleanupToken(CLEANUP_DIR, token);
    else commitCleanupToken(CLEANUP_DIR, token);
    await editMarkup(
      retryable ? "❌ Cleanup failed — tap to retry" : "⚠️ Cleanup outcome unknown — review the mailbox",
    ).catch(() => {});
    // Restore the original button only when the failed attempt is proven to
    // have crossed no tool boundary. Ambiguous cleanup runs are never replayed.
    if (retryable && query.message) {
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [[{ text: `🧹 Clean up (${count})`, callback_data: `cleanup:${token}` }]] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id },
      ).catch(() => {});
      return; // Keep the token around for retry
    }
  }
}

// --- Send-button handler ---
// Agent emitted a SEND trailer; bot attached [✉️ Send] [✏️ Edit] [✕ Cancel].
// The user tapped one. Execute according to action:
//   do     → run executeSend(payload) and edit the button row to reflect status
//   edit   → strip buttons, ack with a hint that the user can reply with changes
//   cancel → strip buttons, ack canceled
async function handleSendCallback(
  query: CallbackQuery,
  token: string,
  action: string,
): Promise<void> {
  // Edit ONLY this token's row, preserving any other bundled SEND rows (and the
  // cleanup row) in the same message. Uses the tap-time keyboard snapshot; a
  // rare rapid double-tap of two different rows could briefly revert the other.
  const replaceRow = (newRow: InlineKeyboardButton[]): Promise<unknown> => {
    if (!query.message) return Promise.resolve();
    const currentKeyboard = "reply_markup" in query.message
      ? query.message.reply_markup?.inline_keyboard
      : undefined;
    const rows = replaceSendRow(currentKeyboard, token, newRow);
    return bot.editMessageReplyMarkup(
      { inline_keyboard: rows as InlineKeyboardButton[][] },
      { chat_id: query.message.chat.id, message_id: query.message.message_id },
    ).catch(() => { /* ignore edit failure */ });
  };
  const editButtons = (text: string): Promise<unknown> =>
    replaceRow([{ text, callback_data: "send:noop" }]);

  if (action !== "cancel" && action !== "edit" && action !== "do") {
    await bot.answerCallbackQuery(query.id, { text: "Unknown action" }).catch(() => {});
    return;
  }

  // Claim every terminal button action, not only Send. Otherwise a delayed
  // Cancel/Edit callback can delete a `.claimed` token while Send is crossing
  // its provider boundary, or falsely show Canceled after the call started.
  // Whichever action wins this atomic rename is the only action that applies.
  const payload = claimSendToken(SEND_DIR, token);
  if (!payload) {
    await bot.answerCallbackQuery(query.id, { text: "Already processed or expired" }).catch(() => {});
    await editButtons("✓ Already processed");
    return;
  }

  if (action === "cancel") {
    await bot.answerCallbackQuery(query.id, { text: "Canceled" }).catch(() => {});
    await editButtons("✕ Canceled");
    deleteSendToken(SEND_DIR, token);
    return;
  }

  if (action === "edit") {
    await bot.answerCallbackQuery(query.id, { text: "Send canceled — reply to revise" }).catch(() => {});
    await editButtons("✏️ Reply to revise");
    deleteSendToken(SEND_DIR, token);
    return;
  }

  // The token is now exclusively claimed. Immediately before invoking any
  // approved handler we establish a durable, non-retryable boundary so an
  // ambiguous timeout can never duplicate the side effect.
  const kindIcon = payload.kind === "gmail" ? "✉️" : payload.kind === "slack" ? "💬" : payload.kind === "voice" ? "📞" : "▶️";
  const topicId =
    payload.topicId ?? callbackTopicId(query.message) ?? DEFAULT_TOPIC_ID;
  const sendLogAgent = routingForTopic(topicId)?.id ?? DEFAULT_AGENT_ID;
  const t0 = Date.now();
  let executionInvoked = false;
  let executionSucceeded = false;
  let localCallId: string | undefined;
  try {
    if (payload.kind === "voice") {
      // Validate all non-billable inputs/config and persist intent before the
      // at-most-once provider boundary. A crash after Vapi accepts the POST can
      // then be reconciled by call name/metadata or reported as unknown safely.
      const normalized = normalizeVoiceCallArgs({
        phone_number: payload.phone_number,
        task: payload.task,
        caller_name: payload.caller_name,
        first_message: payload.first_message,
        language: payload.language,
        max_duration_minutes: payload.max_duration_minutes,
        request_id: token,
      });
      validateVapiConfiguration();
      localCallId = token;
      // Persisted with the approval token before Telegram delivery, so even an
      // immediate tap cannot race the later message-id -> session mapping.
      const sourceSessionId = payload.sourceSessionId || (query.message
        ? lookupSessionByMessageId(SESSIONS_DIR, UNIFIED_AGENT, topicId, query.message.message_id) ?? undefined
        : undefined);
      createVapiCall({
        localId: localCallId,
        approvalToken: token,
        agentId: sendLogAgent,
        topicId,
        chatId: query.message?.chat.id ?? GROUP_ID,
        approvalMessageId: query.message?.message_id,
        sourceSessionId,
        phoneNumber: normalized.phoneNumber,
        task: normalized.task,
        callerName: normalized.callerName,
        firstMessage: normalized.firstMessage,
        language: normalized.language,
        maxDurationSeconds: normalized.maxDurationSeconds,
      });
    }

    const establishExecutionBoundary = (): void => {
      const tombstoned = commitSendToken(SEND_DIR, token, {
        kind: payload.kind,
        outcome: "unknown",
        phase: "execution_started",
        started_at: new Date().toISOString(),
      });
      if (!tombstoned) {
        console.error(`[send] ${payload.kind} token ${token} could not be write-ahead tombstoned`);
        throw new Error("could not establish the at-most-once execution boundary");
      }
      executionInvoked = true;
    };

    // Callback acknowledgements are best-effort UI feedback. Telegram can
    // reject a stale callback even though the approved action is still valid.
    await bot.answerCallbackQuery(query.id, { text: `Sending…` }).catch((err: Error) => {
      console.error("[send] callback acknowledgement failed:", err.message);
    });
    await editButtons(`${kindIcon} Sending…`);

    // For voice, the durable row already exists before the cosmetic awaits.
    // Commit only now, immediately adjacent to the provider call, so a crash
    // during Telegram feedback is truthfully recoverable as "not started".
    establishExecutionBoundary();
    const result = await executeSend(payload, topicId, { token, localCallId });
    executionSucceeded = true;
    // Returning from executeSend proves success. Enrich the write-ahead
    // tombstone before ANY Telegram edit/confirmation; UI failure is never a
    // reason to repeat an externally successful action.
    commitSendToken(SEND_DIR, token, {
      kind: payload.kind,
      outcome: "success",
      phase: "execution_completed",
      summary: result.summary,
      ...(result.callId ? {
        provider: "vapi",
        call_id: result.callId,
        provider_status: result.providerStatus,
      } : {}),
    });
    const ms = Date.now() - t0;
    logEntry(sendLogAgent, topicId, {
      event: "send_executed",
      token,
      kind: payload.kind,
      ok: true,
      summary: result.summary,
      ...(result.callId ? {
        provider: "vapi",
        call_id: result.callId,
        provider_status: result.providerStatus,
      } : {}),
      ms,
    });
    await editButtons(`✓ ${result.summary}`);
    // Voice approval already updates the tapped button to "Calling". Do not
    // create a second queued/progress message; the monitor will publish one
    // terminal outcome when the provider supplies it.
    // Every successful action keeps a short-lived `.committed` audit/dedupe
    // tombstone; stale pruning removes it after the configured token TTL.
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (executionInvoked && !executionSucceeded && payload.kind === "voice" && localCallId) {
      // executeSend durably records Vapi's accepted provider id before the
      // SQLite bind. If a later local step throws, recover that exact id now
      // instead of publishing an ambiguous outcome and waiting for the stale
      // launch sweep. This never re-POSTs the call.
      const recoveredProvider = recoverCommittedVoiceProviderBinding(
        localCallId,
        token,
        sendLogAgent,
        topicId,
      );
      if (recoveredProvider) {
        executionSucceeded = true;
        void voiceMonitor?.tick();
      }
    }
    if (executionInvoked && executionSucceeded) {
      logEntry(sendLogAgent, topicId, {
        event: "send_confirmation_error",
        token,
        kind: payload.kind,
        action_ok: true,
        retryable: false,
        error: msg.slice(0, 300),
        ms: Date.now() - t0,
      });
      console.error("[send] action committed; confirmation failed and will not be retried:", msg);
      await editButtons(payload.kind === "voice"
        ? "✓ Call launch accepted — monitoring continues"
        : "✓ Action completed — confirmation unavailable").catch(() => {});
      return;
    }
    if (executionInvoked) {
      const definitiveFailure = err instanceof SendExecutionFailure && err.outcome === "not_started";
      if (payload.kind === "voice" && localCallId) {
        markVapiCallFailed(localCallId, msg, !definitiveFailure);
        void voiceMonitor?.tick();
      }
      commitSendToken(SEND_DIR, token, {
        kind: payload.kind,
        outcome: definitiveFailure ? "failed" : "unknown",
        phase: definitiveFailure ? "execution_rejected" : "execution_returned_error",
        error: msg.slice(0, 300),
      });
      logEntry(sendLogAgent, topicId, {
        event: definitiveFailure ? "send_failed" : "send_outcome_unknown",
        token,
        kind: payload.kind,
        outcome: definitiveFailure ? "failed" : "unknown",
        retryable: false,
        error: msg.slice(0, 300),
        ms: Date.now() - t0,
      });
      console.error(definitiveFailure
        ? "[send] provider definitively rejected action:"
        : "[send] execution outcome unknown; automatic retry disabled:", msg);
      await editButtons(definitiveFailure
        ? "❌ Call was not started"
        : "⚠️ Outcome unknown — verify before new approval").catch(() => {});
      if (query.message && payload.kind !== "voice") {
        await bot.sendMessage(
          query.message.chat.id,
          definitiveFailure
            ? `❌ ${kindIcon} action was rejected before it started: ${msg.slice(0, 300)}`
            : `⚠️ ${kindIcon} action outcome is unknown. It will not be retried automatically. Verify the external system before creating a new approval.`,
          { message_thread_id: topicId },
        ).catch(() => {});
      }
      return;
    }
    logEntry(sendLogAgent, topicId, { event: "send_executed", token, kind: payload.kind, ok: false, error: msg.slice(0, 300), ms: Date.now() - t0 });
    console.error("[send] execute failed:", msg);
    await editButtons(`❌ Failed — tap message to retry`).catch(() => {});
    // Restore the original keyboard so the user can retry
    if (query.message) {
      // Put the claimed token back so a retry tap can claim it again.
      unclaimSendToken(SEND_DIR, token);
      // Restore ONLY this row to [Send][Edit][Cancel] for retry — keep the other
      // bundled rows intact.
      await replaceRow(buildSendKeyboard(token, payload.label || "", payload.kind).inline_keyboard[0]!).catch(() => {});
      // Persist a hint of the failure for debugging
      await bot.sendMessage(query.message.chat.id, `Send failed: ${msg.slice(0, 300)}`, {
        message_thread_id: topicId,
      }).catch(() => {});
      return; // Keep token for retry
    }
    // No message/label to rebuild a retry button — drop the claimed token so
    // it doesn't linger until the stale-prune sweep.
    deleteSendToken(SEND_DIR, token);
  }
}

// Build the [Send] [Edit] [Cancel] inline keyboard for a SEND payload.
function buildSendKeyboard(
  token: string,
  sendLabel: string,
  kind: SendKind,
): InlineKeyboardMarkup {
  const defaultLabel = kind === "gmail" ? "✉️ Send" : kind === "slack" ? "💬 Send" : kind === "voice" ? "📞 Call" : "▶️ Execute";
  return {
    inline_keyboard: [[
      { text: sendLabel || defaultLabel, callback_data: `send:${token}:do` },
      { text: "✏️ Edit", callback_data: `send:${token}:edit` },
      { text: "✕ Cancel", callback_data: `send:${token}:cancel` },
    ]],
  };
}

const approvedToolHandlers: Record<string, ((args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>) | undefined> = {
  cron_create: cronHandlers.cron_create,
  cron_update: cronHandlers.cron_update,
  cron_pause: cronHandlers.cron_pause,
  cron_resume: cronHandlers.cron_resume,
  cron_delete: cronHandlers.cron_delete,
  cron_run: cronHandlers.cron_run,
  ticktick_create_task: ticktickHandlers.ticktick_create_task,
  ticktick_update_task: ticktickHandlers.ticktick_update_task,
  ticktick_complete_task: ticktickHandlers.ticktick_complete_task,
  ticktick_delete_task: ticktickHandlers.ticktick_delete_task,
};

interface SendExecutionResult {
  summary: string;
  callId?: string;
  providerStatus?: string;
}

class SendExecutionFailure extends Error {
  constructor(message: string, readonly outcome: "not_started" | "unknown") {
    super(message);
    this.name = "SendExecutionFailure";
  }
}

interface SendExecutionContext {
  token: string;
  localCallId?: string;
}

// Execute a SEND payload. Returns a short status for the button plus durable
// provider identifiers that must survive the approval boundary.
async function executeSend(
  payload: StoredSendPayload,
  topicId: number,
  context: SendExecutionContext,
): Promise<SendExecutionResult> {
  if (payload.kind === "gmail") {
    const handler = payload.draft_id ? gmailHandlers.gmail_send_draft : gmailHandlers.gmail_send;
    if (!handler) throw new Error("gmail handler not loaded");
    // Ensure the MCP module sees the right token dir on whichever box bot.ts runs on
    process.env.LETYCLAW_SESSIONS_DIR = process.env.LETYCLAW_SESSIONS_DIR || SESSIONS_DIR;
    const args = payload.draft_id
      ? { account: payload.account, draft_id: payload.draft_id }
      : {
          account: payload.account,
          to: payload.to,
          cc: payload.cc,
          bcc: payload.bcc,
          subject: payload.subject,
          body: payload.body,
          body_html: payload.body_html,
          // Resolve any path-based attachments to inline content here (in-process,
          // where the file lives and gmail_send is permitted). Throws a clear
          // error if a referenced file is missing or outside the allow-list.
          attachments: resolveGmailAttachments(payload.attachments, [VAULT_PATH, "/tmp"]),
          thread_id: payload.thread_id,
          reply_to_message_id: payload.reply_to_message_id,
          in_reply_to_refs: payload.in_reply_to_refs,
        };
    const res = await handler(args as Record<string, unknown>);
    if (res.isError) throw new Error(res.content[0]?.text || "gmail send failed");
    return { summary: "Sent" };
  }

  if (payload.kind === "voice") {
    // Place the call in-process on tap — the agent can't call voice_call
    // directly (it's in DISALLOWED_TOOLS), so this button IS the call path.
    const handler = voiceHandlers.voice_call;
    if (!handler) throw new Error("voice handler not loaded");
    process.env.LETYCLAW_SESSIONS_DIR = process.env.LETYCLAW_SESSIONS_DIR || SESSIONS_DIR;
    const res = await handler({
      phone_number: payload.phone_number,
      task: payload.task,
      caller_name: payload.caller_name,
      first_message: payload.first_message,
      language: payload.language,
      max_duration_minutes: payload.max_duration_minutes,
      request_id: context.localCallId || context.token,
      agent_id: routingForTopic(topicId)?.id || DEFAULT_AGENT_ID,
      topic_id: topicId,
    } as Record<string, unknown>);
    if (res.isError) {
      const outcome = res.structuredContent?.outcome === "not_started" ? "not_started" : "unknown";
      throw new SendExecutionFailure(res.content[0]?.text || "voice call failed", outcome);
    }
    const started = parseVoiceCallStartResult(res);
    if (!context.localCallId) throw new SendExecutionFailure("durable local call id is missing", "unknown");
    // Persist the provider id in the already-committed approval tombstone
    // before the SQLite bind. If the bind fails, startup reconciliation still
    // has the exact accepted call id and can resume without redialing.
    commitSendToken(SEND_DIR, context.token, {
      provider: "vapi",
      call_id: started.callId,
      provider_status: started.status,
      phase: "provider_accepted",
    });
    const localCall = getVapiCall(context.localCallId);
    if (localCall) {
      try {
        writeVapiInboundContext({
          localId: localCall.local_id,
          providerCallId: started.callId,
          phoneNumber: localCall.phone_number,
          callerName: localCall.caller_name,
          task: localCall.task,
          language: localCall.language,
        });
      } catch (err) {
        console.error("[voice] inbound callback context persistence failed:", err instanceof Error ? err.message : String(err));
      }
    }
    try {
      bindVapiProviderCall(context.localCallId, started.callId, started.status);
    } catch (err) {
      // Provider acceptance is already proven and the exact id is durable in
      // the committed tombstone. Do not misreport this as a launch failure:
      // webhook metadata or interrupted-launch reconciliation can repair the
      // SQLite binding without redialing.
      console.error(
        `[voice] Vapi accepted ${started.callId}; SQLite binding will be reconciled:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    return {
      summary: "Calling",
      callId: started.callId,
      ...(started.status ? { providerStatus: started.status } : {}),
    };
  }

  if (payload.kind === "tool") {
    const toolName = payload.tool_name;
    if (!toolName) throw new Error("tool_name missing");
    const handler = approvedToolHandlers[toolName];
    if (!handler) throw new Error(`tool not approved for direct execution: ${toolName}`);
    process.env.LETYCLAW_SESSIONS_DIR = process.env.LETYCLAW_SESSIONS_DIR || SESSIONS_DIR;
    process.env.LETYCLAW_PROJECT_ROOT = process.env.LETYCLAW_PROJECT_ROOT || BOT_PROJECT_ROOT;
    process.env.LETYCLAW_CRON_CONFIG = process.env.LETYCLAW_CRON_CONFIG || CRON_CONFIG_PATH;
    const res = await handler(payload.tool_args ?? {});
    if (res.isError) throw new Error(res.content[0]?.text || `${toolName} failed`);
    return { summary: toolName.replace(/_/g, " ").slice(0, 60) };
  }

  if (payload.kind === "connector" || payload.kind === "slack") {
    // Post-approval claude.ai connector write (calendar add, Slack post, Notion
    // write). Runs against the isolated account session that HAS the connectors —
    // NOT the bot's setup-token (which has none). This is what makes "add to my
    // calendar" / Slack posts actually land after the user taps Send.
    const connPrompt = [
      "You are the post-approval EXECUTION step for a claude.ai connector action.",
      `${OWNER_NAME} already approved by tapping Send, so carry it out directly — do NOT`,
      "ask for approval or emit any trailer. Use the right connector (Google",
      "Calendar / Slack / Notion / Drive / Gmail) to do exactly this:",
      "",
      payload.instruction ?? "",
      "",
      "When a write is confirmed by the provider, reply with exactly:",
      "SEND_OK: <one-line summary> | ARTIFACT: <provider ID, URL, or locator>",
      "Never emit SEND_OK without that provider-returned artifact.",
      "If it fails, reply with: SEND_FAIL: <reason>",
    ].join("\n").trim();
    const conn = await runConnectorClaude(connPrompt, { maxTurns: 12 });
    const parsed = parseConnectorApprovedExecutionReply(conn.text);
    if (conn.ok && parsed.status === "ok" &&
        connectorWriteHasProviderProof(parsed.artifact, conn.toolEvidence)) {
      return { summary: parsed.summary.slice(0, 60) };
    }
    if (parsed.status === "fail") throw new Error(parsed.reason.slice(0, 200));
    if (!conn.ok) throw new Error(`connector execution transport/provider failure: ${conn.text.slice(0, 160)}`);
    throw new Error(
      `connector action returned without provider-backed SEND_OK proof: ${conn.text.slice(0, 160)}`,
    );
  }

  // agent → spawn a one-shot Claude with the instruction. Reuse the
  // current topic's agent for context unless the payload specifies one.
  // This runs ONLY after the user tapped Send, so it's the post-approval step:
  // the send tools (gmail_send) are allowed here (allowSendTools) and the prompt
  // overrides the standing "emit a SEND trailer" rule so the executor actually
  // performs the action instead of looping back into another trailer.
  const agentId = payload.agent_id || routingForTopic(topicId)?.id || DEFAULT_AGENT_ID;
  const prompt = [
    `You are the post-approval EXECUTION step. ${OWNER_NAME} already approved this exact`,
    "action by tapping the Send button, so the standing 'never send without",
    "approval / emit a SEND trailer' rule does NOT apply here — the send tools",
    "(gmail_send etc.) ARE available to you now. Carry out the instruction below",
    "directly and exactly; do NOT emit another SEND trailer or ask for approval.",
    "",
    payload.instruction ?? "",
    "",
    "When done, reply with exactly: SEND_OK: <one-line summary>",
    "If it fails, reply with: SEND_FAIL: <reason>",
  ].join("\n").trim();
  const result = await runClaude(agentId, topicId, prompt, { maxTurns: 6, allowSendTools: true });
  const text = (result.text || "").trim();
  const parsed = parseApprovedExecutionReply(text);
  if (parsed.status === "ok") return { summary: parsed.summary.slice(0, 60) };
  if (parsed.status === "fail") throw new Error(parsed.reason.slice(0, 200));
  throw new Error(`agent action returned without an unambiguous SEND_OK/SEND_FAIL marker: ${text.slice(0, 160)}`);
}

// Helper: which agent owns a topic (used by executeSend's agent fallback).
function routingForTopic(topicId: number): RoutingEntry | null {
  return AGENTS[topicId] ?? null;
}

const processedMessages = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [key, time] of processedMessages) {
    if (time < cutoff) processedMessages.delete(key);
  }
}, 60000);

// --- /status report builder ---
function runtimeHealthLine(label: string, fileName: string): string {
  const file = join(LOGS_DIR, fileName);
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as { status?: unknown; since?: unknown };
    if (state.status !== "ok" && state.status !== "broken") throw new Error("invalid status");
    const checkedAt = statSync(file).mtimeMs;
    const checkedAgeHours = Math.max(0, (Date.now() - checkedAt) / 3_600_000);
    const checkedAge = checkedAgeHours < 1
      ? `${Math.round(checkedAgeHours * 60)}m ago`
      : `${checkedAgeHours.toFixed(1)}h ago`;
    if (checkedAgeHours > 3) {
      return `  ! ${label}: stale (last known ${state.status}, checked ${checkedAge})`;
    }
    if (state.status === "ok") return `  ✓ ${label}: ok (checked ${checkedAge})`;
    const since = typeof state.since === "number" ? state.since : checkedAt;
    const brokenHours = Math.max(0, (Date.now() - since) / 3_600_000);
    const brokenFor = brokenHours < 1
      ? `${Math.round(brokenHours * 60)}m`
      : `${brokenHours.toFixed(1)}h`;
    return `  ✗ ${label}: broken for ${brokenFor} (checked ${checkedAge})`;
  } catch {
    return `  ? ${label}: no monitor state`;
  }
}

function buildStatusReport(): string {
  const lines: string[] = [`**${BOT_NAME} status**`, ""];

  // Push alerts are intentionally disabled. Explicit /status remains the
  // concise place to inspect the two credentials that can stop real work.
  lines.push("**Runtime health**");
  lines.push(runtimeHealthLine("Claude provider auth", ".claude-auth-monitor.json"));
  lines.push(runtimeHealthLine("Claude connectors", ".connector-health-monitor.json"));

  // MCP server health
  const mcp = getMcpState();
  lines.push("", "**MCP servers** (last check: " + (mcp.lastCheck ? mcp.lastCheck.slice(11, 19) + " UTC" : "never") + ")");
  if (Object.keys(mcp.servers).length === 0) {
    lines.push("  no data yet — first check pending");
  } else {
    const sym = (s: string): string => s === "ok" ? "✓" : s === "auth" ? "!" : "✗";
    for (const [name, st] of Object.entries(mcp.servers).sort()) {
      lines.push(`  ${sym(st)} ${name}`);
    }
  }

  // Last memory save per domain
  lines.push("", "**Memory** (last save per domain)");
  const domains = Object.keys(config.agents).sort();
  for (const d of domains) {
    const dir = join(VAULT_PATH, d, "memory");
    let latest: { name: string; mtimeMs: number } | null = null;
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        const m = statSync(join(dir, f)).mtimeMs;
        if (!latest || m > latest.mtimeMs) latest = { name: f, mtimeMs: m };
      }
    } catch { /* missing dir */ }
    if (latest) {
      const ageHrs = (Date.now() - latest.mtimeMs) / 3600000;
      const ageStr = ageHrs < 24 ? `${ageHrs.toFixed(1)}h ago` : `${(ageHrs / 24).toFixed(1)}d ago`;
      lines.push(`  ${d}: ${latest.name} (${ageStr})`);
    } else {
      lines.push(`  ${d}: (none)`);
    }
  }

  // Active sessions
  lines.push("", "**Sessions**");
  let sessionCount = 0;
  let mostRecent = 0;
  try {
    for (const f of readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      sessionCount++;
      const m = statSync(join(SESSIONS_DIR, f)).mtimeMs;
      if (m > mostRecent) mostRecent = m;
    }
  } catch { /* ignore */ }
  const recentStr = mostRecent ? `${((Date.now() - mostRecent) / 60000).toFixed(0)} min ago` : "n/a";
  lines.push(`  ${sessionCount} session file(s), most recent activity: ${recentStr}`);
  if (!recallStore) {
    lines.push(`  ✗ recall index unavailable${recallHealthError ? `: ${recallHealthError.slice(0, 180)}` : ""}`);
  } else {
    try {
      const count = recallStore.count();
      lines.push(`  ✓ searchable recall: ${count} event(s), ${config.session.pruneAfterDays}d conversation retention`);
      if (recallHealthError) lines.push(`  ! last recall error: ${recallHealthError.slice(0, 180)}`);
    } catch (err) {
      lines.push(`  ✗ recall index error: ${String(err).slice(0, 180)}`);
    }
  }

  // Today's error count
  lines.push("", "**Errors today**");
  const today = dateInTimeZone(new Date(), TIMEZONE);
  let errorCount = 0;
  try {
    for (const f of readdirSync(LOGS_DIR)) {
      if (!f.startsWith(today)) continue;
      const content = readFileSync(join(LOGS_DIR, f), "utf8");
      for (const line of content.split("\n")) {
        if (line.includes('"event":"error"')) errorCount++;
      }
    }
  } catch { /* ignore */ }
  lines.push(`  ${errorCount} error event(s) across all topics`);

  return lines.join("\n");
}

// --- sendToTopic returns sent message IDs for session mapping ---
async function sendToTopic(topicId: number, markdownText: string, sourceSessionId?: string): Promise<number[]> {
  // Pull off the optional <!--CLEANUP-START-->...<!--CLEANUP-END--> trailer
  // before rendering. Briefings emit it; everything else passes through.
  const cleanupExtract = extractCleanupTrailer(markdownText);
  let cleanText = cleanupExtract.clean;
  const cleanupPayload = cleanupExtract.payload;
  let cleanupToken: string | null = null;
  if (cleanupPayload) {
    try {
      cleanupToken = saveCleanupToken(CLEANUP_DIR, cleanupPayload, { topicId });
    } catch (err) {
      console.error("[cleanup] failed to save token:", err instanceof Error ? err.message : String(err));
    }
  }

  // Health meal suggestions can carry a structured food-log trailer. It is
  // stripped from the visible reply and turns into a one-tap Log button below.
  // Other domains may not create health records, even if a model emits the
  // marker due to untrusted message content.
  const foodExtract = extractFoodLogTrailers(cleanText);
  cleanText = foodExtract.clean;

  // Then pull off any <!--SEND-START-->...<!--SEND-END--> trailers — drafts
  // that need the user's tap-to-approve before letyclaw actually sends them.
  const sendExtract = extractSendTrailers(cleanText);
  cleanText = sendExtract.clean;

  // Pull any obsidian:// links and turn each into a tappable "Open in Obsidian"
  // button. Telegram rejects obsidian:// as a button URL and ignores it as a
  // text-link tap, so we point the button at an https redirect that hands off
  // to the app. Covers every outbound path (cron, interactive, triggers).
  const obsidianExtract = extractObsidianLinks(cleanText);
  cleanText = obsidianExtract.clean;
  const foodLogTokens: Array<{ token: string; label: string; entryCount: number }> = [];
  const sendTokens: Array<{ token: string; label: string; kind: SendKind }> = [];
  // Machine-derived "what this button will actually do" lines, surfaced in the
  // message body so the user approves against the real resolved target — not the
  // model's prose, which a prompt injection could make lie.
  const sendTargetLines: string[] = [];
  const sendLogAgent = routingForTopic(topicId)?.id ?? DEFAULT_AGENT_ID;
  for (const reason of foodExtract.errors) {
    console.error(`[food] trailer dropped: ${reason}`);
    logEntry(sendLogAgent, topicId, { event: "food_log_trailer_error", reason });
  }
  if (isHealthTopic(topicId)) {
    for (const payload of foodExtract.payloads) {
      try {
        const token = saveFoodLogToken(FOOD_LOG_DIR, payload, { topicId });
        const label = payload.label || "🍽 Log food";
        foodLogTokens.push({ token, label, entryCount: payload.entries.length });
        logEntry(HEALTH_AGENT_ID, topicId, {
          event: "food_log_prepared",
          token,
          date: payload.date,
          entries: payload.entries.length,
          label,
        });
      } catch (err) {
        console.error("[food] failed to save token:", err instanceof Error ? err.message : String(err));
      }
    }
  } else if (foodExtract.payloads.length > 0) {
    logEntry(sendLogAgent, topicId, {
      event: "food_log_trailer_ignored",
      reason: `food logs are only accepted in topics routed to '${HEALTH_AGENT_ID}'`,
      count: foodExtract.payloads.length,
    });
  }
  // A trailer that was present but unusable no longer disappears silently: the
  // user sees SEND_FALLBACK_NOTE in the message, and we log why so it's auditable
  // and the agent can confirm a button failed instead of guessing.
  for (const reason of sendExtract.errors) {
    console.error(`[send] trailer dropped: ${reason}`);
    logEntry(sendLogAgent, topicId, { event: "send_trailer_error", reason });
  }
  for (const sp of sendExtract.payloads) {
    try {
      const defaultLabel = sp.kind === "gmail" ? "✉️ Send" : sp.kind === "slack" ? "💬 Send" : sp.kind === "voice" ? "📞 Call" : "▶️ Execute";
      const storedPayload = { ...sp, label: sp.label || defaultLabel };
      const token = saveSendToken(SEND_DIR, storedPayload, { topicId, sourceSessionId });
      sendTokens.push({ token, label: storedPayload.label, kind: sp.kind });
      sendTargetLines.push(describeSendTarget(storedPayload, OWNER_NAME));
      // Audit preparation separately from delivery. A token can be persisted even
      // if Telegram later rejects the message; only the post-send `send_trailer`
      // event below proves that the approval keyboard actually landed.
      logEntry(sendLogAgent, topicId, {
        event: "send_trailer_prepared", token, kind: sp.kind, account: sp.account,
        label: sp.label || defaultLabel, draft_id: sp.draft_id, tool_name: sp.tool_name,
        has_body: !!(sp.body || sp.body_html || sp.instruction || sp.tool_name || sp.task),
        has_task: !!sp.task,
      });
    } catch (err) {
      console.error("[send] failed to save token:", err instanceof Error ? err.message : String(err));
    }
  }

  // Build the inline keyboard for the LAST chunk. Cleanup rows sit on top,
  // followed by food-log and SEND actions, each on their own row.
  const lastKeyboardRows: InlineKeyboardButton[][] = [];
  if (cleanupToken && cleanupPayload) {
    lastKeyboardRows.push([
      { text: `🧹 Clean up (${cleanupPayload.items.length})`, callback_data: `cleanup:${cleanupToken}` },
    ]);
  }
  for (const foodLog of foodLogTokens) {
    lastKeyboardRows.push([
      { text: foodLog.label, callback_data: `foodlog:${foodLog.token}` },
    ]);
  }
  for (const st of sendTokens) {
    lastKeyboardRows.push([
      { text: st.label, callback_data: `send:${st.token}:do` },
      { text: "✏️ Edit", callback_data: `send:${st.token}:edit` },
      { text: "✕ Cancel", callback_data: `send:${st.token}:cancel` },
    ]);
  }
  for (const link of obsidianExtract.links) {
    const base = link.file.split("/").pop()?.replace(/\.md$/i, "") || "note";
    const label = obsidianExtract.links.length > 1 ? `📖 ${base}` : "📖 Open in Obsidian";
    lastKeyboardRows.push([{ text: label, url: link.url }]);
  }

  let html = mdToTelegramHtml(cleanText);

  // Append a machine-derived confirmation footer (already HTML — built after
  // rendering so it isn't re-escaped) showing what the buttons will actually
  // do. This is the security boundary for #8/#9: the keyboard label is
  // model-supplied, but these lines come straight from the executed payload.
  const confirmLines: string[] = [];
  if (cleanupPayload && cleanupToken) {
    const preview = cleanupPayload.items.slice(0, 5)
      .map(it => `• ${(it.subject || it.id).slice(0, 60).replace(/[<>&]/g, "")}${it.account ? ` <i>[${it.account}]</i>` : ""}`)
      .join("\n");
    const more = cleanupPayload.items.length > 5 ? `\n…and ${cleanupPayload.items.length - 5} more` : "";
    confirmLines.push(`🧹 <b>Will delete ${cleanupPayload.items.length} email(s):</b>\n${preview}${more}`);
  }
  for (const line of sendTargetLines) confirmLines.push(line);
  if (confirmLines.length > 0) {
    html = `${html}\n\n${confirmLines.join("\n")}`;
  }

  const chunks = splitMessage(html);
  const sentIds: number[] = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const isLast = i === chunks.length - 1;
      const replyMarkup = isLast && lastKeyboardRows.length > 0
        ? { inline_keyboard: lastKeyboardRows }
        : undefined;
      const opts: SendMessageOptions = {
        message_thread_id: topicId,
        parse_mode: "HTML",
      };
      if (replyMarkup) opts.reply_markup = replyMarkup;
      try {
        const sent = await bot.sendMessage(GROUP_ID, chunk, opts);
        sentIds.push(sent.message_id);
      } catch (err) {
        // HTML parse error (e.g. a split landed mid-entity). Resend THIS chunk as
        // plaintext — not the whole message, which would re-deliver content from
        // chunks that already sent fine. Never retry an ambiguous network/429/5xx
        // failure: Telegram may have accepted it before the client timed out.
        if (!isTelegramHtmlParseError(err)) throw err;
        const fallbackOpts: SendMessageOptions = { message_thread_id: topicId };
        if (replyMarkup) fallbackOpts.reply_markup = replyMarkup;
        const sent = await bot.sendMessage(GROUP_ID, htmlToPlainText(chunk), fallbackOpts);
        sentIds.push(sent.message_id);
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    for (const st of sendTokens) {
      logEntry(sendLogAgent, topicId, {
        event: "send_trailer_delivery_error", token: st.token, kind: st.kind,
        error: reason.slice(0, 300),
      });
    }
    for (const foodLog of foodLogTokens) {
      logEntry(HEALTH_AGENT_ID, topicId, {
        event: "food_log_delivery_error",
        token: foodLog.token,
        error: reason.slice(0, 300),
      });
    }
    throw err;
  }
  const approvalMessageId = sentIds[sentIds.length - 1];
  if (approvalMessageId !== undefined) {
    for (const st of sendTokens) {
      logEntry(sendLogAgent, topicId, {
        event: "send_trailer", token: st.token, kind: st.kind,
        delivered: true, message_id: approvalMessageId,
      });
    }
    for (const foodLog of foodLogTokens) {
      logEntry(HEALTH_AGENT_ID, topicId, {
        event: "food_log_button",
        token: foodLog.token,
        entries: foodLog.entryCount,
        delivered: true,
        message_id: approvalMessageId,
      });
    }
  }
  // Save messageId on the token so the cleanup callback can edit-in-place
  if (cleanupToken && sentIds.length > 0) {
    try {
      updateCleanupToken(CLEANUP_DIR, cleanupToken, { messageId: sentIds[sentIds.length - 1]! });
    } catch { /* non-fatal */ }
  }
  return sentIds;
}

bot.on("message", async (msg: Message) => {
  if (shuttingDown) return;
  if (msg.from?.id !== ALLOWED_USER) return;
  if (msg.chat?.id !== GROUP_ID) return;

  const topicId = msg.message_thread_id;
  if (!topicId) return;
  const agent: RoutingEntry | undefined = AGENTS[topicId];
  if (!agent) return;

  if (isRateLimited(msg.from.id)) {
    await bot.sendMessage(msg.chat.id, "Rate limit reached. Please wait a moment.", {
      message_thread_id: topicId,
    });
    return;
  }

  const msgKey = `${msg.message_id}`;
  if (processedMessages.has(msgKey)) return;
  processedMessages.set(msgKey, Date.now());

  let text: string | undefined = msg.text || msg.caption;
  const imagePaths: string[] = [];
  const documentPaths: string[] = [];

  // --- Document handling (PDF, etc.) ---
  if (msg.document) {
    const p = await downloadTelegramDocument(msg.document.file_id, msg.document.file_name, msg.message_id);
    if (p) {
      documentPaths.push(p);
      if (!text) text = "What is this document about?";
      console.log(`[${agent.id}] document downloaded: ${p}`);
    }
  }

  // --- Photo handling ---
  if (msg.photo && msg.photo.length > 0) {
    const p = await downloadTelegramPhoto(msg.photo[msg.photo.length - 1]!.file_id, msg.message_id);
    if (p) {
      imagePaths.push(p);
      if (!text) text = "Describe this image";
      console.log(`[${agent.id}] photo downloaded: ${p}`);
    }
  }

  // --- Replied-to attachment ---
  // The user can REPLY to a message that carries a file (a doc letyclaw sent
  // earlier, or one the user forwarded) and say e.g. "fix page 1". The blocks
  // above only see the incoming message's own attachments, so without this the
  // file is invisible and the agent gets a bare instruction with no context.
  // Pull the replied-to file in too.
  const repliedAtt = pickRepliedAttachment(msg.reply_to_message, msg);
  if (repliedAtt) {
    const repliedId = msg.reply_to_message!.message_id;
    if (repliedAtt.kind === "document") {
      const p = await downloadTelegramDocument(repliedAtt.fileId, repliedAtt.fileName, repliedId);
      if (p) {
        documentPaths.push(p);
        if (!text) text = "About the attached document:";
        console.log(`[${agent.id}] replied-to document downloaded: ${p}`);
      }
    } else {
      const p = await downloadTelegramPhoto(repliedAtt.fileId, repliedId);
      if (p) {
        imagePaths.push(p);
        if (!text) text = "About the attached image:";
        console.log(`[${agent.id}] replied-to photo downloaded: ${p}`);
      }
    }
  }

  // --- Voice handling ---
  if (msg.voice || msg.audio) {
    try {
      const fileObj = msg.voice || msg.audio;
      const durationSec = typeof fileObj!.duration === "number" ? fileObj!.duration : undefined;
      const file = await bot.getFile(fileObj!.file_id);
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const tmpOgg = `/tmp/voice-${msg.message_id}.ogg`;
      const tmpWav = `/tmp/voice-${msg.message_id}.wav`;
      await runCmd("curl", ["-sL", url, "-o", tmpOgg], { timeout: 30000 });
      // ffmpeg decodes opus far faster than real-time, but a 20-min clip still
      // needs more than the old 15s budget — give it room.
      await runCmd("ffmpeg", ["-i", tmpOgg, "-ar", "16000", "-ac", "1", "-y", tmpWav], { timeout: 60000 });
      // Long clips block here for many minutes. Give an honest ETA up front
      // (~1.7x real-time on this CPU box) and flag the topic as "transcription
      // pending" so concurrent turns don't fabricate the transcript.
      if (durationSec && durationSec > VOICE_HEADSUP_SEC) {
        const etaMin = Math.ceil((durationSec * 1.7) / 60);
        if (topicId !== undefined) pendingVoiceTranscriptions.set(topicId, { etaAt: Date.now() + etaMin * 60_000 });
        console.log(
          `[${agent.id}] long voice transcription started: ` +
          `audio=${Math.round(durationSec)}s estimate=${etaMin}m (user-visible progress suppressed)`,
        );
      }
      try {
        text = await transcribeVoice(tmpWav, durationSec) ?? undefined;
      } finally {
        if (topicId !== undefined) pendingVoiceTranscriptions.delete(topicId);
        try { unlinkSync(tmpOgg); } catch { /* ignore */ }
        try { unlinkSync(tmpWav); } catch { /* ignore */ }
      }
      if (!text) {
        await bot.sendMessage(msg.chat.id, "Could not transcribe voice message.", {
          message_thread_id: topicId,
        });
        return;
      }
      console.log(`[${agent.id}] voice transcribed: ${text.slice(0, 80)}`);
    } catch (err) {
      console.error("Voice handling error:", err instanceof Error ? err.message : String(err));
      await bot.sendMessage(msg.chat.id, "Could not process voice message.", {
        message_thread_id: topicId,
      });
      return;
    }
  }

  if (!text) return;

  // --- /status: bot-level diagnostics, no Claude invocation ---
  if (text.trim().toLowerCase() === "/status") {
    const status = buildStatusReport();
    await sendToTopic(topicId, status);
    return;
  }

  // Prepend image read instructions so Claude sees the attached photos
  if (imagePaths.length > 0) {
    const imageInstructions = imagePaths.map(p => `[Attached image: read the file at ${p} to see it]`).join("\n");
    text = `${imageInstructions}\n\n${text}`;
  }

  // Prepend document read instructions so Claude sees the attached documents
  if (documentPaths.length > 0) {
    const docInstructions = documentPaths.map(p => `[Attached document: read the file at ${p} to see its contents]`).join("\n");
    text = `${docInstructions}\n\n${text}`;
  }

  // Serialize the full turn on topicId. Session selection MUST happen inside
  // the queue: two rapid messages otherwise both capture the same old session
  // before the first queued turn advances it, and the second silently forks.
  void runOnTopicLock(topicId, async () => {
    let resumeSessionId: string | undefined;
    const replyToId = msg.reply_to_message?.message_id;

    if (replyToId) {
      // Explicit reply: always try to resume that session (ignore TTL)
      resumeSessionId = lookupSessionByMessageId(SESSIONS_DIR, UNIFIED_AGENT, topicId, replyToId);
      if (resumeSessionId) {
        console.log(`[${agent.id}] topic:${topicId} resuming session via reply to msg:${replyToId}`);
      }
    }

    if (!resumeSessionId) {
      // No explicit reply (or reply target not found): continue current session if within TTL
      const session = loadSession(SESSIONS_DIR, UNIFIED_AGENT, topicId);
      if (session?.currentSessionId && !shouldRotateSession(session, SESSION_TTL)) {
        resumeSessionId = session.currentSessionId;
        console.log(`[${agent.id}] topic:${topicId} continuing current session`);
      } else if (session?.currentSessionId) {
        // Had a live session but it's past the idle TTL → starting fresh. Logged
        // so a dropped conversation thread is diagnosable (it isn't otherwise).
        const idleH = ((Date.now() - (session.lastActivityAt ?? session.createdAt ?? Date.now())) / 3_600_000).toFixed(1);
        console.log(`[${agent.id}] topic:${topicId} session rotated after ${idleH}h idle → fresh`);
      }
    }

    await processMessage(agent, topicId, text, msg, resumeSessionId);
  }).catch((err) => {
    console.error(`[${agent.id}] topic:${topicId} queued turn failed:`, err instanceof Error ? err.message : String(err));
  }).finally(() => {
    // Tidy /tmp image scratch once the run has read them. Documents are kept:
    // a SEND-approval trailer can reference a downloaded doc as an email
    // attachment (resolved by path at button-tap, AFTER this run), so deleting
    // them here would break the attach-and-send flow.
    for (const p of imagePaths) { try { unlinkSync(p); } catch { /* ignore */ } }
  });
});

async function processMessage(
  agent: RoutingEntry,
  topicId: number,
  text: string,
  msg: Message,
  resumeSessionId: string | undefined,
): Promise<void> {
  const startTime = Date.now();
  const mode = resumeSessionId ? "resume" : "fresh";
  const runId = randomUUID();
  const runRef = createTrackedRunRef(runId, resumeSessionId, "user");
  console.log(`[${agent.id}] topic:${topicId} [${mode}] run:${runId} <- ${text.slice(0, 80)}`);

  // A hard process crash can leave message IDs from the interrupted run in the
  // per-topic sidecar. This turn owns the topic lock, so anything present
  // before Claude starts is stale and must not be mapped to this new session.
  const stalePendingIds = drainPendingMessageIds(SESSIONS_DIR, topicId);
  if (stalePendingIds.length > 0) {
    console.warn(`[${agent.id}] topic:${topicId} discarded ${stalePendingIds.length} stale pending message id(s)`);
    logEntry(agent.id, topicId, { event: "stale_pending_message_ids_discarded", count: stalePendingIds.length });
  }

  const sendTyping = (): Promise<boolean> =>
    bot.sendChatAction(msg.chat.id, "typing", { message_thread_id: topicId }).catch((e: Error) => {
      console.error(`[typing] failed for topic:${topicId}:`, e.message);
      return false;
    });
  const typingInterval = setInterval(sendTyping, 4000);
  sendTyping();

  logEntry(agent.id, topicId, {
    event: "request",
    mode,
    msgId: msg.message_id,
    text: text.slice(0, 500),
    sessionId: resumeSessionId || null,
  }, undefined, runRef);

  try {
    // If a long voice note is still transcribing in this topic, tell the model
    // so it doesn't fabricate the transcript when asked. (The voice turn itself
    // clears the flag before it gets here, so its real transcript is unaffected.)
    const promptText = voiceTranscriptionNote(topicId) + text;
    const result = await runClaude(agent.id, topicId, promptText, {
      maxTurns: agent.maxTurns || 10,
      resumeSessionId,
      runId,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (!resumeSessionId) bindRecallRun(runRef, result.sessionId);
    else registerRecallSession(runRef, result.sessionId);

    if (result.fellBackToFresh) {
      console.warn(`[${agent.id}] topic:${topicId} ⚠ resume failed, fell back to fresh session (context lost)`);
      logEntry(agent.id, topicId, {
        event: "session_fallback",
        oldSessionId: resumeSessionId,
        newSessionId: result.sessionId,
      }, undefined, runRef);
    }

    logRawStreamEvents(agent.id, topicId, result, runRef);

    const responseStr = typeof result.text === "string" ? result.text : JSON.stringify(result.text);
    // Persist generated output before Telegram delivery. If delivery fails, the
    // response remains auditable and the following error event records the failure.
    logEntry(agent.id, topicId, {
      event: "response", elapsed, sessionId: result.sessionId, responseLen: responseStr.length,
      ...(LOG_RESPONSE_TEXT ? { text: responseStr.slice(0, RESPONSE_TEXT_MAX) } : {}),
    }, undefined, runRef);
    const sentIds = await sendToTopic(topicId, responseStr, result.sessionId);

    // Map message IDs to this session (single read/write): the user message,
    // the bot's response chunks, AND any messages the agent sent mid-run via
    // the message_send/buttons/poll MCP tools (drained from the sidecar — the
    // tool can't know the sessionId, so it parks the ids for us). Without the
    // drained ids, replying to a proactive/progress message would start fresh.
    const pendingIds = drainPendingMessageIds(SESSIONS_DIR, topicId);
    if (result.sessionId) {
      const isFresh = mode === "fresh" || result.fellBackToFresh;
      let session: SessionData | null = isFresh
        ? createSession(SESSIONS_DIR, UNIFIED_AGENT, topicId)
        : loadSession(SESSIONS_DIR, UNIFIED_AGENT, topicId);
      if (session) {
        session.currentSessionId = result.sessionId;
        // Refresh the idle clock: this is a real user turn, so the session
        // stays alive regardless of how long ago it was first created.
        session.lastActivityAt = Date.now();
        for (const id of [msg.message_id, ...sentIds, ...pendingIds]) {
          session.messageMap[String(id)] = result.sessionId;
        }
        saveSession(SESSIONS_DIR, UNIFIED_AGENT, topicId, session);
      }
    }

    console.log(`[${agent.id}] topic:${topicId} -> response (${elapsed}s)`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errMsg = err instanceof Error ? err.message : String(err);
    const discoveredSessionId = (err as { discoveredSessionId?: string } | null)?.discoveredSessionId;
    if (!resumeSessionId) bindRecallRun(runRef, discoveredSessionId);
    else registerRecallSession(runRef, discoveredSessionId);
    logClaudeFailureEvents(agent.id, topicId, err, runRef);
    logEntry(agent.id, topicId, {
      event: "error",
      elapsed,
      error: errMsg,
      ...(discoveredSessionId ? { sessionId: discoveredSessionId } : {}),
    }, undefined, runRef);
    console.error(`[${agent.id}] topic:${topicId} error (${elapsed}s):`, errMsg);
    // Claude CLI errors can be huge (stream-json dumps, embedded transcripts).
    // Telegram caps text at 4096 chars; keep a wide margin for the prefix.
    const noticeText = errMsg === "timeout" && discoveredSessionId
      ? "⚠️ The run kept hitting the per-run time limit and was stopped, but its progress is saved. Reply to this message with “continue” to pick up where it left off."
      : "I couldn't complete this request. The internal failure is logged; retry once, and use /status if it persists.";
    const notice = await bot.sendMessage(msg.chat.id, noticeText, {
      message_thread_id: topicId,
    });
    // The interrupted run is not lost: map this turn's messages (including any
    // progress messages the agent sent mid-run) to the session id observed in
    // the stream, so replying resumes the dead run instead of starting fresh.
    const pendingIds = drainPendingMessageIds(SESSIONS_DIR, topicId);
    if (discoveredSessionId) {
      const session: SessionData | null = mode === "fresh"
        ? createSession(SESSIONS_DIR, UNIFIED_AGENT, topicId)
        : loadSession(SESSIONS_DIR, UNIFIED_AGENT, topicId);
      if (session) {
        session.currentSessionId = discoveredSessionId;
        session.lastActivityAt = Date.now();
        for (const id of [msg.message_id, notice.message_id, ...pendingIds]) {
          session.messageMap[String(id)] = discoveredSessionId;
        }
        saveSession(SESSIONS_DIR, UNIFIED_AGENT, topicId, session);
      }
    }
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Stream → JSONL log writer (shared by user-message and cron paths) ---
// The nightly memory-save cron reads logs/{date}-<agent>-topic{N}.jsonl, so
// every Claude run that produces tool activity worth remembering MUST flow
// through here. Skipping this for cron sessions is what made cross-chat
// memory invisible (briefings found things, the consolidation never saw it).
function logRawStreamEvents(
  agentId: string,
  topicId: number,
  result: RunClaudeResult | undefined,
  runRef?: RecallRunRef,
): void {
  if (!result) return;
  // Preferred path: events collected live, each with its real arrival ts and
  // including the tool_result blocks that arrive in `user`-type stream messages.
  if (result.streamEvents && result.streamEvents.length) {
    for (const ev of result.streamEvents) {
      const { ts, ...rest } = ev;
      logEntry(agentId, topicId, rest, ts, runRef);
    }
    return;
  }
  // Fallback: post-hoc parse of the buffered stream (no per-event ts; only
  // assistant-block tool_use survives). Kept so logging never silently regresses
  // if live collection produced nothing.
  if (!result.rawStream) return;
  const fallbackTools = new Map<string, string>();
  for (const line of result.rawStream.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.type === "assistant" && obj.message) {
        const message = obj.message as { content?: Array<{
          type: string;
          id?: string;
          name?: string;
          input?: unknown;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        }> };
        for (const block of message.content ?? []) {
          if (block.type === "tool_use") {
            if (block.id && block.name) fallbackTools.set(block.id, block.name);
            logEntry(agentId, topicId, {
              event: "tool_call",
              tool: block.name,
              tool_use_id: block.id,
              input: redactToolInputForLog(block.name, block.input),
            }, undefined, runRef);
          }
          if (block.type === "tool_result") {
            const tool = block.tool_use_id ? fallbackTools.get(block.tool_use_id) : undefined;
            logEntry(agentId, topicId, {
              event: "tool_result",
              tool_use_id: block.tool_use_id,
              tool,
              isError: block.is_error === true,
              content: redactToolResultForLog(tool, String(block.content || "")),
            }, undefined, runRef);
          }
        }
      }
      if (obj.type === "result") {
        logEntry(agentId, topicId, {
          event: "result",
          sessionId: obj.session_id,
          cost: obj.total_cost_usd ?? obj.cost_usd,
          duration: obj.duration_ms,
          turns: obj.num_turns,
        }, undefined, runRef);
      }
    } catch { /* ignore */ }
  }
}

function logClaudeFailureEvents(agentId: string, topicId: number, error: unknown, runRef?: RecallRunRef): void {
  const events = error && typeof error === "object"
    ? (error as { streamEvents?: unknown }).streamEvents
    : undefined;
  if (!Array.isArray(events) || events.length === 0) return;
  logRawStreamEvents(agentId, topicId, { streamEvents: events } as RunClaudeResult, runRef);
}

// --- Cron: session-safe wrapper ---
// Returns sessionId so cron.ts can record (msg_id → sessionId) for the
// outgoing message, letting the user reply-to-resume into that cron session.
//
// Serialization is owned by each caller around its FULL transaction. Scheduled
// jobs receive runOnTopicLock in startCronJobs; the health trigger wraps
// inference + delivery + session mapping + briefing mark itself. Keeping this
// inner runner lock-free avoids a non-reentrant same-topic deadlock.
async function runClaudeForCron(agentId: string, topicId: number, prompt: string, opts: RunClaudeOptions = {}): Promise<{
  text: string;
  sessionId?: string;
  toolCount?: number;
  numTurns?: number;
  directMessageCount?: number;
}> {
  const { maxTurns = 10 } = opts;
  const runId = opts.runId?.trim() || randomUUID();
  const runRef = createTrackedRunRef(runId, opts.resumeSessionId, "cron");
  // Cron-owned templates are the only text we interpolate. Normal user messages
  // must remain byte-for-byte intact (e.g. a question about the literal `{today}`).
  const renderedPrompt = substituteDateTokens(prompt, new Date(), TIMEZONE);
  // Topic serialization means any sidecar IDs that predate this run belong to
  // an interrupted process. Drop them before inference so they cannot make a
  // later signal look like a duplicate direct delivery.
  const stalePendingIds = drainPendingMessageIds(SESSIONS_DIR, topicId);
  if (stalePendingIds.length > 0) {
    console.warn(`[cron] topic:${topicId} discarded ${stalePendingIds.length} stale pending message id(s)`);
    logEntry(agentId, topicId, { event: "stale_pending_message_ids_discarded", origin: "cron", count: stalePendingIds.length });
  }
  // Synthesize a "request" event so the nightly memory-save cron can find
  // this run when scanning the JSONL. msgId=0 marks it as cron-originated.
  logEntry(agentId, topicId, {
    event: "request",
    mode: "cron",
    msgId: 0,
    text: renderedPrompt.slice(0, 500),
    sessionId: opts.resumeSessionId ?? null,
  }, undefined, runRef);
  let result: RunClaudeResult;
  try {
    result = await runClaude(agentId, topicId, renderedPrompt, { ...opts, maxTurns, runId });
  } catch (err) {
    // A tool may have delivered an artifact before the Claude process failed.
    // Drain on every terminal path so those IDs never bleed into the next run;
    // preserve reply-to-session routing when the stream exposed a session ID.
    const pendingIds = drainPendingMessageIds(SESSIONS_DIR, topicId);
    const terminalError = (err instanceof Error ? err : new Error(String(err))) as RetryTaggedError;
    const discoveredSessionId = terminalError.discoveredSessionId;
    if (pendingIds.length > 0) {
      // A recorded Telegram message is stronger evidence than a runner's
      // optimistic retry tag. Never replay a run after a proven side effect.
      terminalError.safeToRetryClaudeAttempt = false;
    }
    if (discoveredSessionId && pendingIds.length > 0) {
      recordCronMessageIds(topicId, pendingIds, discoveredSessionId);
    }
    if (!opts.resumeSessionId) bindRecallRun(runRef, discoveredSessionId);
    else registerRecallSession(runRef, discoveredSessionId);
    logClaudeFailureEvents(agentId, topicId, terminalError, runRef);
    logEntry(agentId, topicId, {
      event: "error",
      origin: "cron",
      error: terminalError.message,
      ...(discoveredSessionId ? { sessionId: discoveredSessionId } : {}),
      directMessageCount: pendingIds.length,
    }, undefined, runRef);
    throw terminalError;
  }
  if (!opts.resumeSessionId) bindRecallRun(runRef, result.sessionId);
  else registerRecallSession(runRef, result.sessionId);
  logRawStreamEvents(agentId, topicId, result, runRef);
  const text = typeof result.text === "string" ? result.text : JSON.stringify(result.text);
  // Drain mid-run-sent message ids HERE (inside the caller-owned transaction,
  // always), not after delivery — a [SKIP] run would otherwise leak this run's
  // pending ids into the next run on the topic.
  const pendingIds = drainPendingMessageIds(SESSIONS_DIR, topicId);
  if (result.sessionId && pendingIds.length > 0) {
    recordCronMessageIds(topicId, pendingIds, result.sessionId);
  }
  logEntry(agentId, topicId, {
    event: "response", elapsed: "0", sessionId: result.sessionId, responseLen: text.length,
    toolCount: result.toolCount, numTurns: result.numTurns,
    ...(LOG_RESPONSE_TEXT ? { text: text.slice(0, RESPONSE_TEXT_MAX) } : {}),
  }, undefined, runRef);
  return {
    text,
    sessionId: result.sessionId,
    toolCount: result.toolCount,
    numTurns: result.numTurns,
    directMessageCount: pendingIds.length,
  };
}

// Append cron-sent message_ids to the topic's messageMap so that a reply to
// any of them resumes the cron session (and the agent has full context of
// what it sent). Does NOT touch currentSessionId or createdAt — the user's
// conversation flow is independent of one-off cron sessions.
function recordCronMessageIds(topicId: number, sentIds: number[], sessionId: string): void {
  if (!sessionId || sentIds.length === 0) return;
  const existing = loadSession(SESSIONS_DIR, UNIFIED_AGENT, topicId);
  const session: SessionData = existing ?? { currentSessionId: null, createdAt: Date.now(), messageMap: {} };
  for (const id of sentIds) session.messageMap[String(id)] = sessionId;
  saveSession(SESSIONS_DIR, UNIFIED_AGENT, topicId, session);
}

function formatVoiceCallOutcome(call: VapiCallRow): string {
  const headline = call.state === "ended"
    ? "📞 Call ended"
    : call.state === "failed"
      ? "❌ Call was not completed"
      : call.provider_call_id
        ? "⚠️ Final call result unavailable"
        : "⚠️ Call launch outcome is unknown";
  const lines = [headline, `ID: ${call.provider_call_id || call.local_id}`];
  if (call.parent_local_id) lines.push(`Callback for local call: ${call.parent_local_id}`);
  if (call.ended_reason) lines.push(`Ended reason: ${call.ended_reason}`);
  if (call.duration_seconds !== null) lines.push(`Duration: ${call.duration_seconds}s`);
  if (call.cost !== null) lines.push(`Cost: $${call.cost.toFixed(3)}`);
  if (call.state === "outcome_unknown") {
    lines.push(call.provider_call_id
      ? "Vapi accepted the call, but its final status/report could not be retrieved. Slow reconciliation will continue without redialing."
      : "Vapi may have accepted the launch, but no provider call ID was returned. It was not retried.");
  } else if (call.state === "failed" && call.error) {
    lines.push(`Error: ${call.error.slice(0, 500)}`);
  }
  if (call.summary) lines.push(`Summary: ${call.summary.slice(0, 900)}`);
  if (call.success_evaluation) lines.push(`Success evaluation: ${call.success_evaluation.slice(0, 300)}`);
  if (call.transcript) {
    lines.push(`Transcript:\n${call.transcript.slice(0, 2_200)}`);
  } else if (call.state === "ended") {
    lines.push("No transcript or verified answer was returned for this call.");
  }
  if (call.recording_url) lines.push(`Recording: ${call.recording_url}`);
  return lines.join("\n").slice(0, 4_000);
}

function telegramErrorDescription(errorValue: unknown): string {
  if (!errorValue || typeof errorValue !== "object") return String(errorValue);
  const errorRecord = errorValue as Record<string, unknown>;
  const response = errorRecord.response && typeof errorRecord.response === "object"
    ? errorRecord.response as Record<string, unknown>
    : undefined;
  const body = response?.body && typeof response.body === "object"
    ? response.body as Record<string, unknown>
    : undefined;
  return typeof body?.description === "string"
    ? body.description
    : errorValue instanceof Error ? errorValue.message : String(errorValue);
}

function telegramRetryAfterMs(errorValue: unknown): number | undefined {
  if (!errorValue || typeof errorValue !== "object") return undefined;
  const response = (errorValue as Record<string, unknown>).response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const body = (response as Record<string, unknown>).body;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const parameters = (body as Record<string, unknown>).parameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) return undefined;
  const seconds = (parameters as Record<string, unknown>).retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? Math.ceil(seconds * 1_000)
    : undefined;
}

function voiceNotificationError(errorValue: unknown): Error {
  const error = errorValue instanceof Error ? errorValue : new Error(String(errorValue));
  const retryAfterMs = telegramRetryAfterMs(errorValue);
  if (retryAfterMs) (error as Error & { retryAfterMs: number }).retryAfterMs = retryAfterMs;
  return error;
}

async function notifyVoiceCallOutcome(call: VapiCallRow, claimToken: string): Promise<void> {
  await runOnTopicLock(call.topic_id, async () => {
    const current = getVapiCall(call.local_id) || call;
    if (!isTerminalVapiState(current.state)) {
      throw new Error(`voice call ${call.local_id} is no longer terminal`);
    }
    const chatId = current.chat_id || GROUP_ID;
    const text = formatVoiceCallOutcome(current);
    if (current.status_message_id) {
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: current.status_message_id,
        });
        if (current.source_session_id) {
          recordCronMessageIds(current.topic_id, [current.status_message_id], current.source_session_id);
        }
        logEntry(current.agent_id, current.topic_id, {
          event: "voice_call_completed",
          local_call_id: current.local_id,
          call_id: current.provider_call_id,
          state: current.state,
          ended_reason: current.ended_reason,
          notified_by: "edit",
        });
        return;
      } catch (err) {
        const retryAfterMs = telegramRetryAfterMs(err);
        if (retryAfterMs) throw voiceNotificationError(err);
        const description = telegramErrorDescription(err).toLowerCase();
        if (description.includes("message is not modified")) {
          // Telegram proves the desired text is already present; a lost prior
          // edit response is success, not a reason to send a duplicate.
          if (current.source_session_id) {
            recordCronMessageIds(current.topic_id, [current.status_message_id], current.source_session_id);
          }
          logEntry(current.agent_id, current.topic_id, {
            event: "voice_call_completed",
            local_call_id: current.local_id,
            call_id: current.provider_call_id,
            state: current.state,
            ended_reason: current.ended_reason,
            notified_by: "edit_already_current",
          });
          return;
        }
        const definitivelyUneditable = description.includes("message to edit not found") ||
          description.includes("message can't be edited") ||
          description.includes("message_id_invalid");
        if (!definitivelyUneditable) throw err;
        console.error("[voice-monitor] status message is definitively uneditable; sending fallback:", description);
      }
    }
    let sent: Message;
    try {
      sent = await bot.sendMessage(chatId, text, { message_thread_id: current.topic_id });
    } catch (err) {
      throw voiceNotificationError(err);
    }
    if (!setVapiStatusMessageForClaim(current.local_id, sent.message_id, claimToken)) {
      // Stronger evidence invalidated this claim while Telegram was sending.
      // Remove the stale fallback; the fresh claim will edit/send the latest.
      await bot.deleteMessage(chatId, sent.message_id).catch(() => {});
      throw new Error(`voice notification claim ${claimToken} was superseded`);
    }
    if (current.source_session_id) recordCronMessageIds(current.topic_id, [sent.message_id], current.source_session_id);
    logEntry(current.agent_id, current.topic_id, {
      event: "voice_call_completed",
      local_call_id: current.local_id,
      call_id: current.provider_call_id,
      state: current.state,
      ended_reason: current.ended_reason,
      notified_by: "send",
    });
  });
}

function committedVoiceProvider(token: string): { callId: string; status?: string } | null {
  try {
    const value = JSON.parse(readFileSync(join(SEND_DIR, `${token}.committed`), "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const commit = (value as Record<string, unknown>).commit;
    if (!commit || typeof commit !== "object" || Array.isArray(commit)) return null;
    const callId = (commit as Record<string, unknown>).call_id;
    const status = (commit as Record<string, unknown>).provider_status;
    if (typeof callId !== "string" || !callId.trim()) return null;
    return {
      callId: callId.trim(),
      ...(typeof status === "string" && status.trim() ? { status: status.trim() } : {}),
    };
  } catch {
    return null;
  }
}

function recoverCommittedVoiceProviderBinding(
  localId: string,
  approvalToken: string,
  agentId: string,
  topicId: number,
): { callId: string; status?: string } | null {
  const provider = committedVoiceProvider(approvalToken);
  if (!provider) return null;
  try {
    bindVapiProviderCall(localId, provider.callId, provider.status);
    logEntry(agentId, topicId, {
      event: "voice_call_provider_binding_recovered",
      local_call_id: localId,
      call_id: provider.callId,
    });
    return provider;
  } catch (err) {
    console.error(
      `[voice-monitor] provider binding recovery failed for ${localId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function reconcileInterruptedVoiceLaunches(): void {
  try {
    for (const call of listStaleUnboundVapiCalls()) {
      const pending = existsSync(join(SEND_DIR, `${call.approval_token}.json`));
      const claimed = existsSync(join(SEND_DIR, `${call.approval_token}.claimed`));
      const committed = existsSync(join(SEND_DIR, `${call.approval_token}.committed`));
      const provider = committed ? recoverCommittedVoiceProviderBinding(
        call.local_id,
        call.approval_token,
        call.agent_id,
        call.topic_id,
      ) : null;
      if (provider) {
        continue;
      }
      // An already-reported ambiguous launch without a recoverable provider id
      // remains non-redialable; do not rewrite/log it every minute.
      if (call.state === "outcome_unknown") continue;
      const definitelyBeforeProvider = !committed && (pending || claimed);
      markVapiCallFailed(
        call.local_id,
        definitelyBeforeProvider
          ? "Bot stopped before the provider execution boundary; no call was placed."
          : "Bot stopped during an ambiguous provider launch; the call was not retried.",
        !definitelyBeforeProvider,
      );
      // Clear only retryable pending forms; a committed tombstone remains as the
      // permanent at-most-once boundary if provider execution may have started.
      deleteSendToken(SEND_DIR, call.approval_token);
      logEntry(call.agent_id, call.topic_id, {
        event: "voice_call_launch_reconciled",
        local_call_id: call.local_id,
        outcome: definitelyBeforeProvider ? "not_started" : "unknown",
      });
    }
  } catch (err) {
    console.error("[voice-monitor] interrupted-launch reconciliation failed:", err instanceof Error ? err.message : String(err));
  }
}

// --- Cron: startup + hot-reload ---
const CRON_CONFIG_PATH = join(
  process.env.LETYCLAW_PROJECT_ROOT || BOT_PROJECT_ROOT,
  "config", "cron.yaml"
);

let stopCron: (() => void) | null = null;
let cronConfigMtime = 0;

function reloadCronJobs(): void {
  let mtime: number;
  try {
    mtime = statSync(CRON_CONFIG_PATH).mtimeMs;
    if (mtime === cronConfigMtime) return;
  } catch { return; }

  // Build the replacement scheduler before stopping the current one. A
  // malformed/partially-written config must not take every existing job down,
  // and we only advance the mtime after a successful swap so it is retried.
  try {
    const freshConfig = loadConfig();
    const nextStop = startCronJobs(freshConfig, runClaudeForCron, sendToTopic, recordCronMessageIds, runOnTopicLock);
    const previousStop = stopCron;
    stopCron = nextStop;
    cronConfigMtime = mtime;
    if (previousStop) {
      previousStop();
      console.log("[cron] stopped previous jobs after successful reload");
    }
    console.log(`[cron] loaded ${freshConfig.cron.jobs.length} job(s)`);
  } catch (err) {
    console.error("[cron] reload rejected; keeping previous jobs:", err instanceof Error ? err.message : String(err));
  }
}

reloadCronJobs();
setInterval(reloadCronJobs, 60_000);

// --- Health briefing trigger watcher ---
// services/health-webhook.ts drops `<vault>/health/daily-data/.briefing-trigger-<date>`
// when an iOS Shortcut payload arrives and briefing_sent is still false.
// This watcher runs every 60s, fires the health-morning job immediately
// when a trigger appears, then deletes it. Concurrent cron fires are
// safe: the agent prompt re-reads briefing_sent and SKIPs if already
// sent. Removes the dependency on the iOS Shortcut firing inside the
// 9-12 cron window — briefing now lands ~60s after the tap, anytime.
const HEALTH_TRIGGER_DIR = join(VAULT_PATH, "health", "daily-data");
const HEALTH_TRIGGER_PREFIX = ".briefing-trigger-";
let triggerInFlight = false;

// Bound retries on a failing trigger. Previously a deterministic failure
// (Anthropic 529 streak, expired token) left the trigger in place and retried
// every 60s for up to 24h — ~1440 expensive Claude runs/day, silently. Cap the
// attempts per trigger date, record one terminal journal entry, then drop the
// trigger so it can't keep firing. In-memory is fine: a bot restart re-arming a
// trigger is the correct behavior (the failure cause may have been the restart).
const HEALTH_TRIGGER_MAX_ATTEMPTS = 3;
const healthTriggerAttempts = new Map<string, number>();

// Code-owned, deterministic idempotency marker for the health briefing. The
// once-per-day guarantee must NOT rest on the agent remembering to edit the
// JSON (it self-sends, can time out, or omit the edit). Setting briefing_sent
// here — after a confirmed delivery — makes the scheduled backstop and any
// retry SKIP. Best-effort: if the daily file isn't there yet, there's nothing
// to gate against and the agent's own edit / next sync covers it.
function markBriefingSent(date: string): void {
  const file = join(HEALTH_TRIGGER_DIR, `${date}.json`);
  try {
    if (!existsSync(file)) return;
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (data.briefing_sent === true) return;
    data.briefing_sent = true;
    writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[trigger] markBriefingSent(${date}) failed:`, err instanceof Error ? err.message : String(err));
  }
}

async function processHealthTriggers(): Promise<void> {
  if (shuttingDown || triggerInFlight) return;
  let entries: string[] = [];
  try { entries = readdirSync(HEALTH_TRIGGER_DIR); } catch { return; }
  const triggers = entries.filter(f => f.startsWith(HEALTH_TRIGGER_PREFIX));
  if (triggers.length === 0) return;

  triggerInFlight = true;
  try {
    for (const f of triggers) {
      const triggerPath = join(HEALTH_TRIGGER_DIR, f);
      const date = f.slice(HEALTH_TRIGGER_PREFIX.length);

      // Discard stale triggers (>24h) without firing
      try {
        const age = Date.now() - statSync(triggerPath).mtimeMs;
        if (age > 24 * 60 * 60 * 1000) {
          unlinkSync(triggerPath);
          healthTriggerAttempts.delete(date);
          console.log(`[trigger] discarded stale ${f} (age ${Math.round(age / 3_600_000)}h)`);
          continue;
        }
      } catch { /* race with deletion is fine */ }

      const cfg = loadConfig();
      const job = cfg.cron.jobs.find(j => j.id === "health-morning");
      if (!job || !job.topicId || job.delivery !== "signal" || job.enabled === false) {
        console.warn(`[trigger] health-morning is missing or not an enabled signal job — dropping ${f}`);
        try { unlinkSync(triggerPath); } catch { /* ignore */ }
        healthTriggerAttempts.delete(date);
        continue;
      }

      console.log(`[trigger] firing health-morning for ${date}`);
      try {
        // Hold the same topic transaction used by scheduled cron and user turns
        // across inference, delivery, session mapping, and the idempotency mark.
        // runClaudeForCron is deliberately lock-free to avoid re-entrant deadlock.
        await runOnTopicLock(job.topicId, async () => {
          // Off-schedule (webhook-triggered) run: tell health-sync to bypass the
          // morning-window check so a shortcut tap at ANY hour still produces
          // today's briefing ~60s later. We pass --date=<trigger date> so a
          // near-midnight tap is briefed for the date the WEBHOOK recorded, not
          // the date this (>=60s-later, possibly past-midnight) run computes from
          // the clock. health-sync's briefing_sent gate keeps it to one
          // briefing/day. If the command string ever changes and this replace
          // misses, we degrade to the unmodified prompt (current, window-gated
          // behavior) — safe, not silent breakage.
          const triggeredPrompt = job.prompt.trim().replace(
            "health-sync.js`",
            "health-sync.js --triggered --date=" + date + "`",
          );
          const result = await runClaudeForCron(job.agent, job.topicId!, triggeredPrompt, {
            maxTurns: job.maxTurns || 25,
            skills: job.skills,
            enabledToolsets: job.enabledToolsets,
            disabledToolsets: job.disabledToolsets,
            disabledTools: job.disabledTools,
          });
          const text = result.text;
          const noTools = (result.toolCount ?? 0) === 0;
          if (/^\[SKIP\](?:\s|$)/i.test(text.trim())) {
            console.log(`[trigger] health-morning skipped for ${date} (agent returned [SKIP])`);
          } else if (noTools || text.length < 20) {
            // Non-[SKIP] but the run made zero tool calls / returned almost
            // nothing → the subprocess aborted before running health-sync.js.
            // Do NOT deliver it as a briefing and do NOT markBriefingSent; throw
            // so the 60s retry re-fires (and the terminal failure is logged).
            throw tagClaudeAttemptError(
              new Error(`health briefing produced no tool calls (aborted run: "${text.slice(0, 60).replace(/\s+/g, " ")}")`),
              true,
            );
          } else if ((result.directMessageCount ?? 0) > 0) {
            // A dedicated artifact/interactive delivery is already the single
            // visible outcome. Never append the model's confirmation prose.
            markBriefingSent(date);
            console.log(`[trigger] health-morning direct delivery complete for ${date}; final confirmation suppressed`);
          } else {
            const sentIds = await sendToTopic(job.topicId!, text, result.sessionId);
            if (result.sessionId && sentIds.length > 0) {
              recordCronMessageIds(job.topicId!, sentIds, result.sessionId);
            }
            // Mark only after successful delivery, while still holding the topic
            // lock, so the next scheduled/triggered run observes committed state.
            markBriefingSent(date);
            console.log(`[trigger] health-morning delivered to topic:${job.topicId} for ${date}`);
          }
          try { unlinkSync(triggerPath); } catch { /* ignore */ }
          healthTriggerAttempts.delete(date); // success — reset counter
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!isExplicitlySafeClaudeRetry(err)) {
          // A timeout/crash after unknown or observed tool activity may already
          // have sent or written externally. Drop the trigger and log once;
          // replaying the whole briefing would duplicate those side effects.
          try { unlinkSync(triggerPath); } catch { /* ignore */ }
          healthTriggerAttempts.delete(date);
          console.error(`[trigger] health-morning not retried for ${date}: side effects are ambiguous`);
          console.error(`[trigger] health-morning user-visible failure suppressed for ${date}: ${msg}`);
          continue;
        }
        const attempts = (healthTriggerAttempts.get(date) || 0) + 1;
        healthTriggerAttempts.set(date, attempts);
        console.error(`[trigger] health-morning failed for ${date} (attempt ${attempts}/${HEALTH_TRIGGER_MAX_ATTEMPTS}):`, msg);
        if (attempts >= HEALTH_TRIGGER_MAX_ATTEMPTS) {
          // Give up: drop the trigger so it can't keep re-firing, and record
          // one terminal journal entry for diagnosis.
          try { unlinkSync(triggerPath); } catch { /* ignore */ }
          healthTriggerAttempts.delete(date);
          console.error(
            `[trigger] health-morning failed ${HEALTH_TRIGGER_MAX_ATTEMPTS}x for ${date}; ` +
            "user-visible give-up alert suppressed",
          );
        }
        // else: leave the trigger in place; next 60s tick retries.
      }
    }
  } finally {
    triggerInFlight = false;
  }
}

setInterval(() => { processHealthTriggers().catch(err => console.error("[trigger]", err)); }, 60_000);

// Resume every accepted call after restarts. Webhook events are drained first;
// provider polling is the fallback, and terminal Telegram delivery is claimed
// with an ownership token so retries normally edit one durable status target.
reconcileInterruptedVoiceLaunches();
voiceMonitor = startVoiceCallMonitor({
  notify: notifyVoiceCallOutcome,
  log: (message, err) => console.error(message, err instanceof Error ? err.message : err ?? ""),
});
const interruptedVoiceReconcileTimer = setInterval(reconcileInterruptedVoiceLaunches, 60_000);
interruptedVoiceReconcileTimer.unref?.();

// --- Graceful shutdown handler ---
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(
    `[shutdown] ${signal} received, waiting for ${activeProcesses.size} active process(es) ` +
    `${activeCallbackTasks.size} callback(s), and ${runOnTopicLock.pendingCount()} topic transaction(s)...`,
  );

  await bot.stopPolling({ cancel: true, reason: `${signal} shutdown` }).catch((err: Error) => {
    console.error("[shutdown] stopPolling failed:", err.message);
  });
  if (stopCron) stopCron();
  stopMcpHealth();
  clearInterval(interruptedVoiceReconcileTimer);

  await Promise.race([
    // Drain ALL in-flight topic work — user AND cron/trigger runs now share
    // this queue, so a mid-deploy waits through delivery + session commit too.
    // Drain the stopped monitor first because its last tick may enqueue a final
    // Telegram update; only then can the topic queue be known to be empty.
    (async () => {
      await Promise.all([...activeCallbackTasks]);
      await (voiceMonitor?.tick() ?? Promise.resolve());
      await (voiceMonitor?.tick() ?? Promise.resolve());
      voiceMonitor?.stop();
      await (voiceMonitor?.drain() ?? Promise.resolve());
      await runOnTopicLock.drain();
    })(),
    // 10-min shutdown cap (systemd TimeoutStopSec=630). CLAUDE_TIMEOUT is
    // 20 min so a mid-run deploy may cut Claude short — reaper cleans up.
    new Promise(r => setTimeout(r, 600_000)),
  ]);

  voiceMonitor?.stop();
  try { recallStore?.close(); } catch (err) {
    console.error("[recall] close failed:", err instanceof Error ? err.message : String(err));
  }
  console.log(`[shutdown] clean exit`);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// --- MCP health monitor ---
const stopMcpHealth = startMcpHealthMonitor(
  CLAUDE_PATH,
  // Match the env Claude CLI gets when bot spawns it (so health reflects runtime)
  {
    ...process.env,
    PATH: `/root/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    LETYCLAW_BOT_NAME: BOT_NAME,
    LETYCLAW_OWNER_NAME: OWNER_NAME,
    TZ: TIMEZONE,
  },
  (msg) => {
    console.warn(`[mcp-health] user-visible transition suppressed: ${msg.replace(/\s+/g, " ")}`);
  },
);

// --- Startup ---
console.log(`${BOT_NAME} bot started (Claude CLI mode)`);
console.log(`Model: ${MODEL} (effort: ${EFFORT})`);
console.log(`Claude: ${CLAUDE_PATH}`);
console.log(`Vault: ${VAULT_PATH}`);
console.log(`Agents: ${Object.entries(AGENTS).map(([t, a]) => `topic:${t}→${a.id}`).join(", ")}`);
console.log("MCP health: monitoring, transitions → journal only");
