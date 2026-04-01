/**
 * Voice call database — SQLite storage for call state and transcripts.
 *
 * Shared between the voice-relay WebSocket server (writes) and
 * MCP voice tools (reads + initial insert). Uses WAL mode for
 * safe concurrent access from separate processes.
 *
 * Requires: better-sqlite3 (already a project dependency)
 */
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DEFAULT_DB_PATH = "/opt/letyclaw/voice-calls.sqlite";

// ── Interfaces ─────────────────────────────────────────────────────

export interface CallRow {
  call_sid: string;
  phone_number: string;
  task: string;
  system_prompt: string | null;
  status: string;
  model: string;
  agent_id: string;
  topic_id: string;
  caller_name: string;
  voice: string;
  language: string;
  max_duration_seconds: number;
  initiated_at: number | null;
  connected_at: number | null;
  completed_at: number | null;
  duration_seconds: number | null;
  transcript: string;
  summary: string | null;
  error: string | null;
}

export interface CreateCallParams {
  callSid: string;
  phoneNumber: string;
  task: string;
  systemPrompt?: string;
  model?: string;
  agentId?: string;
  topicId?: string;
  callerName?: string;
  voice?: string;
  language?: string;
  maxDurationSeconds?: number;
}

export interface ListCallsFilter {
  agentId?: string;
  status?: string;
  limit?: number;
}

// ── DB singleton ────────────────────────────────────────────────────

let _db: DatabaseType | null = null;

export function getDb(dbPath?: string): DatabaseType {
  const p = dbPath || process.env.VOICE_DB_PATH || DEFAULT_DB_PATH;
  if (_db) return _db;

  mkdirSync(dirname(p), { recursive: true });

  const db = new Database(p);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS calls (
      call_sid TEXT PRIMARY KEY,
      phone_number TEXT NOT NULL,
      task TEXT NOT NULL,
      system_prompt TEXT,
      status TEXT DEFAULT 'initiated',
      model TEXT DEFAULT 'claude-haiku-4-5',
      agent_id TEXT,
      topic_id TEXT,
      caller_name TEXT,
      voice TEXT,
      language TEXT DEFAULT 'en-US',
      max_duration_seconds INTEGER DEFAULT 300,
      initiated_at INTEGER,
      connected_at INTEGER,
      completed_at INTEGER,
      duration_seconds INTEGER,
      transcript TEXT DEFAULT '',
      summary TEXT,
      error TEXT
    );
  `);

  _db = db;
  return db;
}

// ── CRUD helpers ────────────────────────────────────────────────────

export function createCall({ callSid, phoneNumber, task, systemPrompt, model, agentId, topicId, callerName, voice, language, maxDurationSeconds }: CreateCallParams): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO calls (call_sid, phone_number, task, system_prompt, model, agent_id, topic_id, caller_name, voice, language, max_duration_seconds, initiated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    callSid, phoneNumber, task, systemPrompt || "",
    model || "claude-haiku-4-5",
    agentId || "", topicId || "",
    callerName || "", voice || "", language || "en-US",
    maxDurationSeconds || 300,
    Date.now()
  );
}

export function updateCallStatus(callSid: string, status: string, extra: Record<string, string | number> = {}): void {
  const db = getDb();
  const sets: string[] = ["status = ?"];
  const vals: (string | number)[] = [status];

  if (status === "connected" && !extra.connected_at) {
    sets.push("connected_at = ?");
    vals.push(Date.now());
  }
  if (status === "completed" || status === "failed" || status === "no-answer") {
    sets.push("completed_at = ?");
    vals.push(Date.now());
  }

  const ALLOWED_COLUMNS = new Set(["duration_seconds", "connected_at", "completed_at", "error", "summary"]);
  for (const [key, val] of Object.entries(extra)) {
    if (!ALLOWED_COLUMNS.has(key)) continue;
    sets.push(`${key} = ?`);
    vals.push(val);
  }

  vals.push(callSid);
  db.prepare(`UPDATE calls SET ${sets.join(", ")} WHERE call_sid = ?`).run(...vals);
}

export function appendTranscript(callSid: string, speaker: string, text: string): void {
  const db = getDb();
  const line = `[${speaker}]: ${text}\n`;
  db.prepare("UPDATE calls SET transcript = transcript || ? WHERE call_sid = ?").run(line, callSid);
}

export function getCall(callSid: string): CallRow | null {
  const db = getDb();
  return db.prepare<[string], CallRow>("SELECT * FROM calls WHERE call_sid = ?").get(callSid) ?? null;
}

export function listCalls({ agentId, status, limit = 20 }: ListCallsFilter = {}): CallRow[] {
  const db = getDb();
  const where: string[] = [];
  const vals: (string | number)[] = [];

  if (agentId) { where.push("agent_id = ?"); vals.push(agentId); }
  if (status) { where.push("status = ?"); vals.push(status); }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  vals.push(limit);

  return db.prepare<(string | number)[], CallRow>(`SELECT * FROM calls ${clause} ORDER BY initiated_at DESC LIMIT ?`).all(...vals);
}

// ── Cleanup (for tests) ────────────────────────────────────────────

export function closeDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}
