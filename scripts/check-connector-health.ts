#!/usr/bin/env node
/**
 * End-to-end health monitor for the isolated Claude.ai connector credential
 * and its Google Calendar MCP connection.
 *
 * `claude auth status` is deliberately not used: it can report loggedIn:true
 * for a present but revoked credential. This monitor removes the bot's setup
 * token/API-key overrides, sets HOME to the connector credential store, and
 * requires a real stream containing a successful read-only list_calendars tool
 * result plus a private final marker. State and systemd/journal preserve
 * edge/recovery evidence; operational health never posts into user topics.
 */
import { spawn } from "child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import {
  connectorCredentialLockPath,
  decideAuthAlert,
  type AuthMonitorState,
} from "../lib.js";
import {
  CONNECTOR_HEALTH_MARKER,
  CONNECTOR_HEALTH_TOOL,
  assessConnectorProbe,
  connectorProbeEnv,
  type ConnectorProbeOutput,
} from "./connector-health-core.js";

const PROJECT_ROOT = process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw";
const CONNECTOR_HOME = process.env.CONNECTOR_CLAUDE_HOME || join(PROJECT_ROOT, "sessions", "connector-home");
const CLAUDE_PATH = process.env.CONNECTOR_CLAUDE_PATH || process.env.CLAUDE_PATH || "/usr/bin/claude";
const STATE_FILE = join(PROJECT_ROOT, "logs", ".connector-health-monitor.json");
const PROBE_TIMEOUT_MS = 90_000;
const REMINDER_MS = 6 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024;

function loadState(): AuthMonitorState | null {
  try {
    const value = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<AuthMonitorState>;
    if ((value.status !== "ok" && value.status !== "broken") ||
        typeof value.since !== "number" ||
        (value.lastAlertAt !== null && typeof value.lastAlertAt !== "number")) return null;
    return value as AuthMonitorState;
  } catch {
    return null;
  }
}

function saveState(state: AuthMonitorState): void {
  mkdirSync(join(PROJECT_ROOT, "logs"), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed or never written */ }
  }
}

function probe(): Promise<ConnectorProbeOutput> {
  return new Promise((resolve) => {
    const claudeArgs = [
      "-p",
      `Use only the Google Calendar list_calendars tool. Do not read events or write anything. ` +
      `After that exact tool succeeds, reply with exactly: ${CONNECTOR_HEALTH_MARKER}`,
      "--output-format", "stream-json",
      "--verbose",
      "--model", "haiku",
      "--max-turns", "3",
      "--permission-mode", "dontAsk",
      "--allowedTools", CONNECTOR_HEALTH_TOOL,
      "--no-session-persistence",
      "--disable-slash-commands",
      "--no-chrome",
    ];
    const child = spawn("/usr/bin/flock", [
      "--exclusive",
      "--timeout", "5",
      "--conflict-exit-code", "75",
      "--no-fork",
      connectorCredentialLockPath(CONNECTOR_HOME),
      CLAUDE_PATH,
      ...claudeArgs,
    ], {
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: connectorProbeEnv(process.env, CONNECTOR_HOME),
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode,
        timedOut,
        outputTruncated,
        lockContended: exitCode === 75 && !stdout.trim() && !stderr.trim(),
      });
    };
    const killGroup = (): void => {
      if (child.pid == null) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const append = (current: string, chunk: Buffer): string => {
      if (outputTruncated) return current;
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
      if (chunk.byteLength <= remaining) {
        outputBytes += chunk.byteLength;
        return current + chunk.toString();
      }
      outputBytes += remaining;
      outputTruncated = true;
      killGroup();
      return current + chunk.subarray(0, remaining).toString();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("close", finish);
    child.on("error", (err) => {
      stderr = `${stderr}\n${err instanceof Error ? err.message : String(err)}`;
      finish(1);
    });
  });
}

async function main(): Promise<void> {
  const raw = await probe();
  const assessment = assessConnectorProbe(raw);
  if (assessment.status === "skipped") {
    console.log(`[connector-health] status=skipped reason=${assessment.reason} state_preserved=true`);
    return;
  }
  const now = Date.now();
  const previous = loadState();
  const decision = decideAuthAlert(previous, assessment.status, now, REMINDER_MS);
  const nextState = decision.nextState;

  if (decision.send) {
    const level = decision.kind === "recovered" ? "warn" : "error";
    console[level](
      `[connector-health] transition=${decision.kind} status=${assessment.status} ` +
      `reason=${assessment.reason} user_visible=false`,
    );
  }

  saveState(nextState);
  console.log(`[connector-health] status=${assessment.status} reason=${assessment.reason} kind=${decision.kind} transition_due=${decision.send} exit=${raw.exitCode} timedOut=${raw.timedOut}`);
  if (assessment.status === "broken") process.exitCode = 1;
}

main().catch((err) => {
  console.error("[connector-health] fatal:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
