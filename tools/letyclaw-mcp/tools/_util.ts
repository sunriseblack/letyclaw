/**
 * Shared utilities for letyclaw-mcp tool modules.
 */

import { join, resolve } from "path";
import { homedir } from "os";
import type { MCPResponse } from "../types.js";

// ── MCP response helpers ─────────────────────────────────────────────

export function ok(text: string): MCPResponse {
  return { content: [{ type: "text", text }] };
}

export function error(text: string): MCPResponse {
  return { content: [{ type: "text", text: `Error: ${text}` }], isError: true };
}

// ── Environment accessors ────────────────────────────────────────────

export const VAULT = (): string => process.env.LETYCLAW_VAULT_PATH || process.env.VAULT_PATH || join(homedir(), "vault");
export const AGENT = (): string => process.env.LETYCLAW_AGENT_ID || "";
export const TOPIC = (): string => process.env.LETYCLAW_TOPIC_ID || "";
export const SESSIONS_DIR = (): string => process.env.LETYCLAW_SESSIONS_DIR || process.env.SESSIONS_DIR || join(process.cwd(), "sessions");

// ── Path safety ──────────────────────────────────────────────────────

/**
 * Resolve a relative path within a base directory, rejecting traversal.
 * Returns the resolved path or null if it escapes the base.
 */
export function safePath(base: string, relPath: string): string | null {
  const resolved = resolve(join(base, relPath));
  return resolved.startsWith(base) ? resolved : null;
}
