#!/usr/bin/env node
/**
 * Claude CLI auth health monitor — belt-and-suspenders for the 2026-06-20
 * outage where the subscription token expired/was-revoked and every agent run
 * 401'd silently until a missing scheduled run tipped the operator off.
 *
 * Run hourly by the claude-auth-check.timer systemd unit. Does a REAL minimal
 * `claude -p` inference call (the only reliable probe — `claude auth status`
 * reports loggedIn:true for a present-but-dead token), classifies the result,
 * and records the ok→broken edge, periodic broken state, and recovery in the
 * system journal. Operational health is intentionally log-only: user topics
 * must not fan out service alerts when the provider itself is unhealthy.
 *
 * Env (from EnvironmentFile=/etc/letyclaw-bot/env): CLAUDE_CODE_OAUTH_TOKEN,
 * CLAUDE_PATH. Optional: LETYCLAW_PROJECT_ROOT.
 */
import { spawn } from "child_process";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import {
  classifyAuthProbe,
  decideAuthAlert,
  decideTokenExpiryWarning,
  type AuthMonitorState,
} from "../lib.js";

const MARKER = "CLAUDE_AUTH_PING_OK";
const PROBE_TIMEOUT_MS = 90_000;
const REMINDER_MS = 6 * 60 * 60 * 1000; // repeat the journal transition at most every 6h while broken

// Token-expiry pre-warning knobs. The long-lived `setup-token` OAuth token isn't
// introspectable for an expiry date, so we assume a fixed lifetime from the time
// the monitor first saw it and warn in the final window. A rotation resets it.
const DAY_MS = 86_400_000;
const TOKEN_LIFETIME_MS = Number(process.env.CLAUDE_OAUTH_TOKEN_LIFETIME_DAYS || "365") * DAY_MS;
const TOKEN_WARN_MS = Number(process.env.CLAUDE_OAUTH_TOKEN_WARN_DAYS || "14") * DAY_MS;
const TOKEN_WARN_REMINDER_MS = 3 * DAY_MS; // repeat the journal warning at most every 3 days in-window

// Stable, non-reversible fingerprint of the token so we can detect a rotation
// without ever persisting the secret itself.
function hashToken(tok?: string): string | null {
  if (!tok) return null;
  return createHash("sha256").update(tok).digest("hex").slice(0, 12);
}

const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const PROJECT_ROOT = process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw";
const STATE_FILE = join(PROJECT_ROOT, "logs", ".claude-auth-monitor.json");

function loadState(): AuthMonitorState | null {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as AuthMonitorState;
  } catch {
    return null;
  }
}

function saveState(state: AuthMonitorState): void {
  try {
    mkdirSync(join(PROJECT_ROOT, "logs"), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (err) {
    console.error("[auth-check] could not persist state:", err instanceof Error ? err.message : String(err));
  }
}

// Minimal print-mode probe. cwd=/tmp so it does NOT load the project .mcp.json
// (no MCP servers to spin up → fast, isolated). Auth comes from the env token.
function probe(): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_PATH, ["-p", `reply with exactly: ${MARKER}`, "--max-turns", "1"], {
      cwd: "/tmp",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch { /* ignore */ } }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code, timedOut }); });
    child.on("error", (err) => { clearTimeout(timer); resolve({ stdout, stderr: stderr + String(err), exitCode: 1, timedOut }); });
  });
}

async function main(): Promise<void> {
  const r = await probe();
  const status = classifyAuthProbe({ ...r, marker: MARKER });
  const now = Date.now();
  const prev = loadState();
  const { send: logTransition, kind, nextState } = decideAuthAlert(prev, status, now, REMINDER_MS);

  // Layer token-age tracking onto the up/down state (decideAuthAlert rebuilds the
  // status fields fresh and would otherwise drop the token fields each tick).
  const expiry = decideTokenExpiryWarning(prev, hashToken(process.env.CLAUDE_CODE_OAUTH_TOKEN), now, {
    lifetimeMs: TOKEN_LIFETIME_MS,
    warnMs: TOKEN_WARN_MS,
    reminderMs: TOKEN_WARN_REMINDER_MS,
  });
  saveState({ ...nextState, ...expiry.fields });

  console.log(`[auth-check] status=${status} kind=${kind} transition_due=${logTransition} exit=${r.exitCode} timedOut=${r.timedOut} tokenDaysLeft=${expiry.daysLeft ?? "?"} warn=${expiry.warn}`);

  // Record an approaching expiry — but only while auth currently WORKS
  // (a broken token is already covered by the down alert below; no point also
  // saying "expires soon" about a token that's dead now).
  if (expiry.warn && status === "ok") {
    console.warn(`[auth-check] token_expiry_warning days_left=${expiry.daysLeft} user_visible=false`);
  }

  if (logTransition) {
    const level = kind === "recovered" ? "warn" : "error";
    console[level](`[auth-check] transition=${kind} status=${status} user_visible=false`);
  }
  if (status === "broken") process.exitCode = 1;
}

main().catch((err) => {
  console.error("[auth-check] fatal:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
