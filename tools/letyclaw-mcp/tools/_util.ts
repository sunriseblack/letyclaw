/**
 * Shared utilities for letyclaw-mcp tool modules.
 */

import { join, resolve, sep } from "path";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
} from "fs";
import { randomBytes } from "crypto";
import type { MCPResponse } from "../types.js";

// ── MCP response helpers ─────────────────────────────────────────────

export function ok(text: string): MCPResponse {
  return { content: [{ type: "text", text }] };
}

export function error(text: string): MCPResponse {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// ── Environment accessors ────────────────────────────────────────────

export const VAULT = (): string => process.env.LETYCLAW_VAULT_PATH || process.env.VAULT_PATH || "/root/vault";
export const AGENT = (): string => process.env.LETYCLAW_AGENT_ID || "";
export const TOPIC = (): string => process.env.LETYCLAW_TOPIC_ID || "";
export const SESSIONS_DIR = (): string => process.env.LETYCLAW_SESSIONS_DIR || process.env.SESSIONS_DIR || "/root/letyclaw/sessions";

// ── Path safety ──────────────────────────────────────────────────────

/**
 * Resolve a relative path within a base directory, rejecting traversal.
 * Returns the resolved path or null if it escapes the base.
 */
export function safePath(base: string, relPath: string): string | null {
  const resolvedBase = resolve(base);
  const resolved = resolve(resolvedBase, relPath);
  return resolved === resolvedBase || resolved.startsWith(resolvedBase + sep) ? resolved : null;
}

/**
 * Validate an absolute path is under one of the allowed base directories.
 * Returns the resolved path or null if it escapes allowed directories.
 */
export function safeAbsPath(absPath: string, allowedBases: string[]): string | null {
  const resolved = resolve(absPath);
  return allowedBases.some((base) => {
    const rb = resolve(base);
    return resolved === rb || resolved.startsWith(rb + "/");
  }) ? resolved : null;
}

// ── Message sanitization ────────────────────────────────────────────

/**
 * Peel `<![CDATA[ ... ]]>` (and nested) wrappers off Telegram-bound text.
 * Why: agents occasionally regress and wrap message bodies in XML envelopes
 * despite explicit prompt rules. Telegram doesn't parse CDATA — the literal
 * characters render and the message looks broken. We sanitize at the MCP
 * boundary so a single prompt regression can't corrupt every message.
 */
export function stripCdataEnvelope(text: unknown): string {
  if (typeof text !== "string") return text as string;
  let t = text.trim();
  while (t.startsWith("<![CDATA[") && t.endsWith("]]>")) {
    t = t.slice(9, -3).trim();
  }
  return t;
}

// ── Obsidian deep links ─────────────────────────────────────────────

const OBSIDIAN_VAULT_NAME = process.env.OBSIDIAN_VAULT_NAME || "ObsidianVault";

/**
 * Generate an obsidian:// deep link that opens a file in the Obsidian app.
 * `filePath` should be relative to the vault root (e.g. "default/memory/2026-03-31.md").
 */
export function obsidianLink(filePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(OBSIDIAN_VAULT_NAME)}&file=${encodeURIComponent(filePath)}`;
}

// ── Billable-tool rate limiting (cross-run, file-backed) ─────────────
//
// The letyclaw-tools MCP server is spawned fresh per `claude` run, so an in-memory
// limiter only bounds within one run. The real risk — a looping/injected agent,
// or repeated cron triggers running up Vapi/OpenAI cost — spans runs. So
// persist a sliding window of call reservations per tool under SESSIONS_DIR and
// check it before each billable call. Lock contention or persistence failure
// fails closed: losing one legitimate attempt is safer than an uncapped redial.

const RATE_DIR = (): string => join(SESSIONS_DIR(), ".ratelimits");

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
  used?: number;
  max?: number;
  alreadyReserved?: boolean;
}

interface RateLimitEntry { at: number; id: string }

function rateLimitFile(tool: string): string {
  return join(RATE_DIR(), `${tool}.json`);
}

function readRateLimitEntries(file: string): RateLimitEntry[] | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return null;
    const entries: RateLimitEntry[] = [];
    for (const [index, entry] of parsed.entries()) {
      // Backwards-compatible with the original number[] format.
      if (typeof entry === "number" && Number.isFinite(entry)) {
        entries.push({ at: entry, id: `legacy-${index}-${entry}` });
        continue;
      }
      if (!entry || typeof entry !== "object") return null;
      const value = entry as Record<string, unknown>;
      if (typeof value.at !== "number" || !Number.isFinite(value.at) ||
          typeof value.id !== "string" || !value.id) return null;
      entries.push({ at: value.at, id: value.id });
    }
    return entries;
  } catch (err) {
    return err && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT" ? [] : null;
  }
}

function writeRateLimitEntries(file: string, entries: RateLimitEntry[]): boolean {
  try {
    mkdirSync(RATE_DIR(), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

function acquireRateLimitLock(file: string): { fd: number; path: string } | null {
  try { mkdirSync(RATE_DIR(), { recursive: true }); } catch { return null; }
  const lockPath = `${file}.lock`;
  const attempt = (): { fd: number; path: string } | null => {
    try {
      return { fd: openSync(lockPath, "wx", 0o600), path: lockPath };
    } catch {
      return null;
    }
  };
  const first = attempt();
  if (first) return first;
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > 30_000) unlinkSync(lockPath);
  } catch { /* another process released it */ }
  return attempt();
}

function releaseRateLimitLock(lock: { fd: number; path: string }): void {
  try { closeSync(lock.fd); } catch { /* ignore */ }
  try { unlinkSync(lock.path); } catch { /* ignore */ }
}

/**
 * Reserve a billable slot using a stable id. A definitive provider rejection
 * can release that exact reservation; network/5xx/ambiguous responses retain
 * it so retries cannot accidentally duplicate a call that may have started.
 */
export function reserveBillableRateLimit(
  tool: string,
  max: number,
  windowMs: number,
  reservationId: string,
  nowMs = Date.now(),
): RateLimitResult {
  const file = rateLimitFile(tool);
  const lock = acquireRateLimitLock(file);
  if (!lock) return { allowed: false, retryAfterSec: 1, used: max, max };
  try {
    const entries = readRateLimitEntries(file);
    if (!entries) return { allowed: false, retryAfterSec: 1, used: max, max };
    const recent = entries.filter((entry) => nowMs - entry.at < windowMs);
    if (recent.some((entry) => entry.id === reservationId)) {
      // This is not permission to repeat the billable provider request. The
      // caller uses this marker to return the already-known result (if any) or
      // an ambiguous outcome without redialing.
      return { allowed: true, alreadyReserved: true, used: recent.length, max };
    }
    if (recent.length >= max) {
      const oldest = Math.min(...recent.map((entry) => entry.at));
      const retryAfterSec = Math.max(1, Math.ceil((windowMs - (nowMs - oldest)) / 1000));
      return { allowed: false, retryAfterSec, used: recent.length, max };
    }
    recent.push({ at: nowMs, id: reservationId });
    if (!writeRateLimitEntries(file, recent)) {
      return { allowed: false, retryAfterSec: 1, used: max, max };
    }
    return { allowed: true, used: recent.length, max };
  } finally {
    releaseRateLimitLock(lock);
  }
}

export function releaseBillableRateLimit(tool: string, reservationId: string): void {
  const file = rateLimitFile(tool);
  const lock = acquireRateLimitLock(file);
  if (!lock) return; // conservative: keep the reservation on contention
  try {
    const entries = readRateLimitEntries(file);
    if (!entries) return;
    const remaining = entries.filter((entry) => entry.id !== reservationId);
    if (remaining.length !== entries.length) writeRateLimitEntries(file, remaining);
  } finally {
    releaseRateLimitLock(lock);
  }
}

// Allow at most `max` calls of `tool` per `windowMs`. Records the call (on
// allow) under a cross-process lock and commits via tmp+rename.
export function checkBillableRateLimit(tool: string, max: number, windowMs: number, nowMs = Date.now()): RateLimitResult {
  return reserveBillableRateLimit(
    tool,
    max,
    windowMs,
    `legacy-call-${nowMs}-${randomBytes(6).toString("hex")}`,
    nowMs,
  );
}

// Convenience: returns an MCP error response if over the limit, else null.
export function billableRateLimitError(tool: string, max: number, windowMs: number): MCPResponse | null {
  const r = checkBillableRateLimit(tool, max, windowMs);
  if (r.allowed) return null;
  return error(
    `Rate limit for ${tool}: ${r.max} call(s) per ${Math.round(windowMs / 60000)} min reached. ` +
    `Retry in ~${r.retryAfterSec}s. (Guards against runaway or looping cost — ask the user if this is intended.)`,
  );
}
