import TelegramBot from "node-telegram-bot-api";
import { spawn } from "child_process";
import type { ChildProcess, SpawnOptions } from "child_process";
import { mkdirSync, unlinkSync, appendFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";
import { loadConfig } from "./config.js";
import { startCronJobs } from "./cron.js";

// --- Setup wizard trigger ---
if (process.argv.includes("--setup")) {
  import("./setup.js").then(m => m.runSetupWizard());
} else if (!existsSync(join(process.cwd(), "config", "letyclaw.yaml")) && !existsSync(join(process.cwd(), "config", "letyclaw.example.yaml"))) {
  console.error("No config found. Run with --setup or create config/letyclaw.yaml");
  console.error("  npx tsx setup.ts         # Interactive setup wizard");
  console.error("  cp config/letyclaw.example.yaml config/letyclaw.yaml  # Manual setup");
  process.exit(1);
}
import type { LoadedConfig, RoutingEntry, SessionData, RunClaudeResult } from "./types.js";
import {
  isRateLimited as _isRateLimited,
  loadSession,
  saveSession,
  shouldRotateSession,
  lookupSessionByMessageId,
  createSession,
  pruneOldSessions as _pruneOldSessions,
  buildTopicPrompt,
  isSessionExpiredError,
  parseClaudeResult,
  mdToTelegramHtml,
  splitMessage,
} from "./lib.js";

// --- Load config ---
const config: LoadedConfig = loadConfig();
const {
  routing: AGENTS,
  telegram: { token: BOT_TOKEN, allowedUser: ALLOWED_USER, chatId: GROUP_ID },
  vaultPath: VAULT_PATH,
  whisperModel: WHISPER_MODEL,
  model: MODEL,
  claudePath: CLAUDE_PATH,
  sessionsDir: SESSIONS_DIR,
} = config;

const SESSION_TTL = config.session.ttlHours * 60 * 60 * 1000;
const CLAUDE_TIMEOUT = config.timeouts.claudeTotal;
const CLAUDE_NO_OUTPUT_TIMEOUT = config.timeouts.claudeNoOutput;

// --- Bind lib functions to config ---
const rateLimiter = new Map<number, number[]>();
const isRateLimited = (userId: number): boolean => _isRateLimited(rateLimiter, userId, config.rateLimit);

// Unified agent ID for session management (all topics share one namespace)
const UNIFIED_AGENT = "letyclaw";

// --- Session management ---
mkdirSync(SESSIONS_DIR, { recursive: true });

// --- Structured logging ---
const LOGS_DIR = join(process.cwd(), "logs");
const LOG_RETENTION_DAYS = 7;
mkdirSync(LOGS_DIR, { recursive: true });

function logFile(agentId: string, topicId: number): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `${date}-${agentId}-topic${topicId}.jsonl`);
}

function logEntry(agentId: string, topicId: number, entry: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
  try { appendFileSync(logFile(agentId, topicId), line); } catch { /* ignore */ }
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
setInterval(pruneOldLogs, 6 * 60 * 60 * 1000);

// --- Session pruning ---
function pruneOldSessions(): void {
  const pruned = _pruneOldSessions(SESSIONS_DIR, config.session.pruneAfterDays);
  if (pruned > 0) console.log(`[sessions] pruned ${pruned} old session(s)`);
}

pruneOldSessions();
setInterval(pruneOldSessions, 6 * 60 * 60 * 1000);

// --- Per-agent concurrency ---
const agentLocks = new Map<string, Promise<void>>();

// --- Run a command as a promise using spawn ---
function runCmd(cmd: string, args: string[], opts: { timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] } as SpawnOptions);
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += d; });
    child.stderr!.on("data", (d: Buffer) => { stderr += d; });
    child.on("close", (code: number | null) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
    child.on("error", reject);
    if (opts.timeout) setTimeout(() => { child.kill(); reject(new Error("timeout")); }, opts.timeout);
  });
}

// --- Voice transcription ---
async function transcribeVoice(filePath: string): Promise<string | null> {
  try {
    const stdout = await runCmd("whisper-cli", [
      "-m", WHISPER_MODEL, "-nt", "-l", "auto", "-f", filePath
    ], { timeout: 30000 });
    return stdout.trim();
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

function runClaudeProcess(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<ClaudeProcessResult> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(CLAUDE_PATH, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        LETYCLAW_VAULT_PATH: VAULT_PATH,
        LETYCLAW_SESSIONS_DIR: SESSIONS_DIR,
        LETYCLAW_CHAT_ID: String(GROUP_ID),
        LETYCLAW_PROJECT_ROOT: process.env.LETYCLAW_PROJECT_ROOT || process.cwd(),
        // Pass through API key for Claude CLI (fallback when not using subscription)
        ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
        ...extraEnv,
      },
    });

    child.stdin!.end();

    let stdout = "", stderr = "";
    let lastOutputTime = Date.now();
    let killed = false;

    child.stdout!.on("data", (d: Buffer) => { stdout += d; lastOutputTime = Date.now(); });
    child.stderr!.on("data", (d: Buffer) => { stderr += d; lastOutputTime = Date.now(); });

    const overallTimer = setTimeout(() => {
      killed = true;
      child.kill();
      reject(new Error("timeout"));
    }, CLAUDE_TIMEOUT);

    const watchdog = setInterval(() => {
      if (Date.now() - lastOutputTime > CLAUDE_NO_OUTPUT_TIMEOUT) {
        killed = true;
        child.kill();
        clearInterval(watchdog);
        clearTimeout(overallTimer);
        reject(new Error("watchdog: no output for 60s"));
      }
    }, 5000);

    child.on("close", (code: number | null) => {
      clearTimeout(overallTimer);
      clearInterval(watchdog);
      if (killed) return;
      resolve({ code, stdout, stderr });
    });

    child.on("error", (err: Error) => {
      clearTimeout(overallTimer);
      clearInterval(watchdog);
      reject(err);
    });
  });
}

/**
 * Run Claude CLI for a given agent.
 */
async function runClaude(
  agentId: string,
  topicId: number,
  userMessage: string,
  { maxTurns = 10, resumeSessionId }: { maxTurns?: number; resumeSessionId?: string } = {},
): Promise<RunClaudeResult> {
  const cwd = VAULT_PATH;
  const agentEnv = { LETYCLAW_AGENT_ID: agentId, LETYCLAW_TOPIC_ID: String(topicId || "") };

  const prompt = resumeSessionId ? userMessage : buildTopicPrompt(agentId, topicId, userMessage);

  const baseArgs = [
    "-p", prompt,
    "--model", MODEL,
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(maxTurns),
    "--dangerously-skip-permissions",
  ];

  const args = resumeSessionId ? [...baseArgs, "--resume", resumeSessionId] : [...baseArgs];

  let result: ClaudeProcessResult;
  let effectiveResumeSessionId = resumeSessionId;
  try {
    result = await runClaudeProcess(cwd, args, agentEnv);
  } catch (err) {
    if (effectiveResumeSessionId) {
      console.log(`[${agentId}] session failed (${err instanceof Error ? err.message : String(err)}), retrying fresh`);
      const freshPrompt = buildTopicPrompt(agentId, topicId, userMessage);
      const freshArgs = [
        "-p", freshPrompt,
        "--model", MODEL,
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", String(maxTurns),
        "--dangerously-skip-permissions",
      ];
      result = await runClaudeProcess(cwd, freshArgs, agentEnv);
      // Clear the resume so we don't try to save to the old session
      effectiveResumeSessionId = undefined;
    } else {
      throw err;
    }
  }

  if (effectiveResumeSessionId && (result.code !== 0 || isSessionExpiredError(result.stdout, result.stderr))) {
    console.log(`[${agentId}] session expired, retrying fresh`);
    const freshPrompt = buildTopicPrompt(agentId, topicId, userMessage);
    const freshArgs = [
      "-p", freshPrompt,
      "--model", MODEL,
      "--output-format", "stream-json",
      "--verbose",
      "--max-turns", String(maxTurns),
      "--dangerously-skip-permissions",
    ];
    result = await runClaudeProcess(cwd, freshArgs, agentEnv);
    effectiveResumeSessionId = undefined;
  }

  // Parse and return result + raw stream for logging
  const parseAndReturn = (stdout: string): RunClaudeResult => {
    const parsed = parseClaudeResult(stdout);
    return { text: parsed.text, sessionId: parsed.sessionId, resumed: !!effectiveResumeSessionId, rawStream: stdout };
  };

  if (result.code === 0) return parseAndReturn(result.stdout);

  if (result.stdout) {
    try { return parseAndReturn(result.stdout); } catch { /* ignore */ }
  }

  throw new Error(`Claude failed: ${(result.stderr || `exit ${result.code}`).slice(0, 200)}`);
}

// --- Telegram bot ---
const bot = new TelegramBot(BOT_TOKEN!, { polling: true });

const processedMessages = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - 300000;
  for (const [key, time] of processedMessages) {
    if (time < cutoff) processedMessages.delete(key);
  }
}, 60000);

// --- sendToTopic returns sent message IDs for session mapping ---
async function sendToTopic(topicId: number, markdownText: string): Promise<number[]> {
  const html = mdToTelegramHtml(markdownText);
  const chunks = splitMessage(html);
  const sentIds: number[] = [];
  for (const chunk of chunks) {
    try {
      const sent = await bot.sendMessage(GROUP_ID, chunk, {
        message_thread_id: topicId,
        parse_mode: "HTML",
      });
      sentIds.push(sent.message_id);
    } catch {
      const sent = await bot.sendMessage(GROUP_ID, markdownText, { message_thread_id: topicId });
      sentIds.push(sent.message_id);
    }
  }
  return sentIds;
}

bot.on("message", async (msg: TelegramBot.Message) => {
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

  let text: string | undefined = msg.text;

  if (msg.voice || msg.audio) {
    try {
      const fileObj = msg.voice || msg.audio;
      const file = await bot.getFile(fileObj!.file_id);
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const tmpOgg = `/tmp/voice-${msg.message_id}.ogg`;
      const tmpWav = `/tmp/voice-${msg.message_id}.wav`;
      await runCmd("curl", ["-sL", url, "-o", tmpOgg], { timeout: 15000 });
      await runCmd("ffmpeg", ["-i", tmpOgg, "-ar", "16000", "-ac", "1", "-y", tmpWav], { timeout: 15000 });
      text = await transcribeVoice(tmpWav) ?? undefined;
      try { unlinkSync(tmpOgg); } catch { /* ignore */ }
      try { unlinkSync(tmpWav); } catch { /* ignore */ }
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

  // --- Determine session: reply = resume specific, otherwise continue current ---
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
    }
  }

  const lockKey = `${agent.id}-${topicId}`;
  const prevLock = agentLocks.get(lockKey) || Promise.resolve();

  const currentLock = prevLock.then(() => processMessage(agent, topicId, text, msg, resumeSessionId));
  agentLocks.set(lockKey, currentLock.catch(() => { /* ignore */ }));
});

async function processMessage(
  agent: RoutingEntry,
  topicId: number,
  text: string,
  msg: TelegramBot.Message,
  resumeSessionId: string | undefined,
): Promise<void> {
  const startTime = Date.now();
  const mode = resumeSessionId ? "resume" : "fresh";
  console.log(`[${agent.id}] topic:${topicId} [${mode}] <- ${text.slice(0, 80)}`);

  const sendTyping = (): Promise<boolean> =>
    bot.sendChatAction(msg.chat.id, "typing", { message_thread_id: topicId }).catch((e: Error) => {
      console.error(`[typing] failed for topic:${topicId}:`, e.message);
      return false;
    });
  const typingInterval = setInterval(sendTyping, 4000);
  sendTyping();

  logEntry(agent.id, topicId, { event: "request", mode, msgId: msg.message_id, text: text.slice(0, 500), sessionId: resumeSessionId || null });

  try {
    const result = await runClaude(agent.id, topicId, text, {
      maxTurns: agent.maxTurns || 10,
      resumeSessionId,
    });
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Log tool calls and assistant messages from the stream
    if (result.rawStream) {
      for (const line of result.rawStream.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type === "assistant" && obj.message) {
            const message = obj.message as { content?: Array<{ type: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown }> };
            for (const block of message.content ?? []) {
              if (block.type === "tool_use") {
                logEntry(agent.id, topicId, { event: "tool_call", tool: block.name, input: block.input });
              }
              if (block.type === "tool_result") {
                logEntry(agent.id, topicId, { event: "tool_result", tool_use_id: block.tool_use_id, content: String(block.content || "").slice(0, 1000) });
              }
            }
          }
          if (obj.type === "result") {
            logEntry(agent.id, topicId, { event: "result", sessionId: obj.session_id, cost: obj.cost_usd, duration: obj.duration_ms, turns: obj.num_turns });
          }
        } catch { /* ignore */ }
      }
    }

    const responseStr = typeof result.text === "string" ? result.text : JSON.stringify(result.text);
    const sentIds = await sendToTopic(topicId, responseStr);

    // Map both user message and bot response message IDs to this session (single read/write)
    if (result.sessionId) {
      let session: SessionData | null = mode === "fresh"
        ? createSession(SESSIONS_DIR, UNIFIED_AGENT, topicId)
        : loadSession(SESSIONS_DIR, UNIFIED_AGENT, topicId);
      if (session) {
        session.currentSessionId = result.sessionId;
        for (const id of [msg.message_id, ...sentIds]) {
          session.messageMap[String(id)] = result.sessionId;
        }
        saveSession(SESSIONS_DIR, UNIFIED_AGENT, topicId, session);
      }
    }

    logEntry(agent.id, topicId, { event: "response", elapsed, sessionId: result.sessionId, responseLen: responseStr.length });
    console.log(`[${agent.id}] topic:${topicId} -> response (${elapsed}s)`);
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const errMsg = err instanceof Error ? err.message : String(err);
    logEntry(agent.id, topicId, { event: "error", elapsed, error: errMsg });
    console.error(`[${agent.id}] topic:${topicId} error (${elapsed}s):`, errMsg);
    await bot.sendMessage(msg.chat.id, `Agent error: ${errMsg}`, {
      message_thread_id: topicId,
    });
  } finally {
    clearInterval(typingInterval);
  }
}

// --- Cron: session-safe wrapper (never reads/writes user sessions) ---
async function runClaudeForCron(agentId: string, topicId: number, prompt: string, { maxTurns = 10 }: { maxTurns?: number } = {}): Promise<string> {
  const result = await runClaude(agentId, topicId, prompt, { maxTurns });
  return typeof result.text === "string" ? result.text : JSON.stringify(result.text);
}

// --- Cron: startup + hot-reload ---
const CRON_CONFIG_PATH = join(
  process.env.LETYCLAW_PROJECT_ROOT || new URL(".", import.meta.url).pathname,
  "config", "cron.yaml"
);

let stopCron: (() => void) | null = null;
let cronConfigMtime = 0;

function reloadCronJobs(): void {
  try {
    const mtime = statSync(CRON_CONFIG_PATH).mtimeMs;
    if (mtime === cronConfigMtime) return;
    cronConfigMtime = mtime;
  } catch { return; }

  if (stopCron) {
    stopCron();
    console.log("[cron] stopped previous jobs for reload");
  }

  const freshConfig = loadConfig();
  stopCron = startCronJobs(freshConfig, runClaudeForCron, sendToTopic);
  console.log(`[cron] loaded ${freshConfig.cron.jobs.length} job(s)`);
}

reloadCronJobs();
setInterval(reloadCronJobs, 60_000);

// --- Startup validation ---
if (!BOT_TOKEN) {
  console.error("Error: TELEGRAM_BOT_TOKEN is required. Set it in .env or environment.");
  process.exit(1);
}

// --- Startup ---
console.log("Letyclaw bot started (Claude CLI mode)");
console.log(`Model: ${MODEL}`);
console.log(`Claude: ${CLAUDE_PATH}`);
console.log(`Vault: ${VAULT_PATH}`);
console.log(`AI backend: ${process.env.ANTHROPIC_API_KEY ? "API key" : "Claude CLI subscription"}`);
console.log(`Agents: ${Object.entries(AGENTS).map(([t, a]) => `topic:${t}→${a.id}`).join(", ")}`);
