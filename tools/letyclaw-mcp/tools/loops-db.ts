/**
 * Open-loops ledger — access layer.
 *
 * The agent's durable, updatable "what's pending" state, stored in the per-agent
 * SQLite DB (alongside memory, so it's per-domain and self-migrating; the table
 * is created in memory-db.ts getDb). This module holds pure CRUD + the per-turn
 * render so it can be imported by BOTH the MCP tools (loops.ts) and bot.ts (the
 * per-turn injection) without pulling in the MCP SDK.
 *
 * Why this exists: briefings used to re-derive "pending" from raw signals
 * (unread email / overdue tasks) every run with no dedup and no link between an
 * action and loop closure — so a handled item (e.g. the padrón notification, for
 * which the renewal PDF was generated) kept reappearing for days. The ledger is
 * the canonical source of truth: open once, update as you act, close when done.
 */
import { randomBytes } from "crypto";
import { readdirSync, existsSync } from "fs";
import { join, basename } from "path";
import { getDb } from "./memory-db.js";
import { VAULT } from "./_util.js";

// ── Types ────────────────────────────────────────────────────────────

export type LoopStatus = "open" | "in_progress" | "awaiting_user" | "blocked" | "done" | "dropped";

export const ACTIVE_STATES: LoopStatus[] = ["open", "in_progress", "awaiting_user", "blocked"];

export interface LoopRow {
  id: string;
  title: string;
  domain: string;
  status: LoopStatus;
  next_action: string | null;
  due: string | null;
  priority: number;
  source_ref: string | null;
  artifact_path: string | null;
  ticktick_id: string | null;
  watch_cron_id: string | null;
  mirror_flag: string | null;
  shared: number;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  surfaced_count: number;
  last_surfaced_at: number | null;
  dedupe_key: string;
}

export interface OpenLoopInput {
  title: string;
  next_action?: string;
  due?: string;
  priority?: number;
  source_ref?: string;
  artifact_path?: string;
  dedupe_key?: string;
  shared?: boolean;
  ticktick_id?: string;
  watch_cron_id?: string;
}

export interface UpdateLoopInput {
  status?: LoopStatus;
  next_action?: string | null;
  due?: string | null;
  priority?: number;
  artifact_path?: string | null;
  source_ref?: string | null;
  watch_cron_id?: string | null;
  ticktick_id?: string | null;
  mirror_flag?: string | null;
  shared?: boolean;
}

// ── Identity / dedupe helpers ────────────────────────────────────────

function genLoopId(): string {
  return "loop-" + randomBytes(4).toString("hex");
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "untitled";
}

/**
 * Derive a stable identity for a loop so the SAME underlying thing (an unread
 * email, a committed task) maps to one loop across runs even if the model
 * rephrases the title. Prefer the external source_ref; fall back to a title slug.
 */
export function deriveDedupeKey(domain: string, sourceRef: string | undefined, title: string): string {
  const tail = sourceRef && sourceRef.trim() ? sourceRef.trim().toLowerCase() : slug(title);
  return `${domain.toLowerCase()}:${tail}`.replace(/\s+/g, " ").slice(0, 200);
}

// ── Status resolution ────────────────────────────────────────────────

const ALL_STATES: LoopStatus[] = [...ACTIVE_STATES, "done", "dropped"];

function resolveStatuses(status?: string): LoopStatus[] {
  if (!status || status === "open" || status === "active") return ACTIVE_STATES;
  if (status === "all") return ALL_STATES;
  const parts = status.split(",").map((s) => s.trim()).filter((s) => (ALL_STATES as string[]).includes(s)) as LoopStatus[];
  return parts.length ? parts : ACTIVE_STATES;
}

const ORDER_SQL = "priority DESC, (due IS NULL) ASC, due ASC, updated_at DESC";

// ── CRUD ─────────────────────────────────────────────────────────────

export function openLoop(agentId: string, input: OpenLoopInput): { id: string; reused: boolean; row: LoopRow } {
  const db = getDb(agentId);
  const now = Date.now();
  const id = genLoopId();
  const dedupe = (input.dedupe_key && input.dedupe_key.trim()
    ? input.dedupe_key.trim().toLowerCase()
    : deriveDedupeKey(agentId, input.source_ref, input.title)).slice(0, 200);

  const ret = db.prepare(`
    INSERT INTO loops
      (id, title, domain, status, next_action, due, priority, source_ref, artifact_path,
       ticktick_id, watch_cron_id, shared, created_at, updated_at, surfaced_count, dedupe_key)
    VALUES
      (@id, @title, @domain, 'open', @next_action, @due, @priority, @source_ref, @artifact_path,
       @ticktick_id, @watch_cron_id, @shared, @now, @now, 0, @dedupe)
    ON CONFLICT(dedupe_key) WHERE status NOT IN ('done','dropped')
    DO UPDATE SET
      title         = excluded.title,
      next_action   = excluded.next_action,
      due           = excluded.due,
      priority      = excluded.priority,
      artifact_path = COALESCE(excluded.artifact_path, loops.artifact_path),
      ticktick_id   = COALESCE(loops.ticktick_id, excluded.ticktick_id),
      watch_cron_id = COALESCE(loops.watch_cron_id, excluded.watch_cron_id),
      updated_at    = excluded.updated_at
    RETURNING id
  `).get({
    id,
    title: input.title,
    domain: agentId,
    next_action: input.next_action ?? null,
    due: input.due ?? null,
    priority: input.priority ?? 3,
    source_ref: input.source_ref ?? null,
    artifact_path: input.artifact_path ?? null,
    ticktick_id: input.ticktick_id ?? null,
    watch_cron_id: input.watch_cron_id ?? null,
    shared: input.shared ? 1 : 0,
    now,
    dedupe,
  }) as { id: string };

  const effectiveId = ret.id;
  const reused = effectiveId !== id;
  return { id: effectiveId, reused, row: getLoop(agentId, effectiveId)! };
}

export function updateLoop(agentId: string, id: string, input: UpdateLoopInput): LoopRow | null {
  const db = getDb(agentId);
  const now = Date.now();
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown): void => { sets.push(`${col} = ?`); vals.push(v); };

  if (input.status !== undefined) push("status", input.status);
  if (input.next_action !== undefined) push("next_action", input.next_action);
  if (input.due !== undefined) push("due", input.due);
  if (input.priority !== undefined) push("priority", input.priority);
  if (input.artifact_path !== undefined) push("artifact_path", input.artifact_path);
  if (input.source_ref !== undefined) push("source_ref", input.source_ref);
  if (input.watch_cron_id !== undefined) push("watch_cron_id", input.watch_cron_id);
  if (input.ticktick_id !== undefined) push("ticktick_id", input.ticktick_id);
  if (input.mirror_flag !== undefined) push("mirror_flag", input.mirror_flag);
  if (input.shared !== undefined) push("shared", input.shared ? 1 : 0);
  push("updated_at", now);
  if (input.status === "done" || input.status === "dropped") push("closed_at", now);

  const info = db.prepare(`UPDATE loops SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
  if (info.changes === 0) return null;
  return getLoop(agentId, id);
}

export function closeLoop(agentId: string, id: string, status: "done" | "dropped" = "done"): LoopRow | null {
  const db = getDb(agentId);
  const now = Date.now();
  const info = db.prepare("UPDATE loops SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(status, now, now, id);
  if (info.changes === 0) return null;
  return getLoop(agentId, id);
}

export function getLoop(agentId: string, id: string): LoopRow | null {
  const row = getDb(agentId).prepare("SELECT * FROM loops WHERE id = ?").get(id) as LoopRow | undefined;
  return row ?? null;
}

export interface ListOpts {
  status?: string;
  domain?: string; // current agentId (default), or '+shared' to add other domains' shared loops
  limit?: number;
}

export function listLoops(agentId: string, opts: ListOpts = {}): LoopRow[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const statuses = resolveStatuses(opts.status);
  const placeholders = statuses.map(() => "?").join(",");

  let rows = getDb(agentId)
    .prepare(`SELECT * FROM loops WHERE status IN (${placeholders}) ORDER BY ${ORDER_SQL} LIMIT ?`)
    .all(...statuses, limit) as LoopRow[];

  if (opts.domain === "+shared") {
    rows = rows.concat(sharedFromOtherDomains(agentId, statuses));
    rows = dedupeById(rows).sort(compareLoops).slice(0, limit);
  }
  return rows;
}

export function countActiveLoops(agentId: string): number {
  const placeholders = ACTIVE_STATES.map(() => "?").join(",");
  const r = getDb(agentId).prepare(`SELECT COUNT(*) AS c FROM loops WHERE status IN (${placeholders})`).get(...ACTIVE_STATES) as { c: number };
  return r.c;
}

export function touchLoops(agentId: string, ids: string[]): number {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const info = getDb(agentId)
    .prepare(`UPDATE loops SET surfaced_count = surfaced_count + 1, last_surfaced_at = ? WHERE id IN (${placeholders})`)
    .run(Date.now(), ...ids);
  return info.changes;
}

// ── Cross-domain (shared) read ───────────────────────────────────────
// Other domains' loops are visible ONLY when explicitly marked shared=1 AND
// queried via domain:'+shared' (used by the cross-domain briefing). Custody /
// health / finance loops default shared=0 and AGENTS.md forbids setting it, so
// they never leak into another domain's view.

function sharedFromOtherDomains(currentAgentId: string, statuses: LoopStatus[]): LoopRow[] {
  let dirs: string[];
  try {
    dirs = readdirSync(VAULT(), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(",");
  const out: LoopRow[] = [];
  for (const dir of dirs) {
    if (dir === currentAgentId || dir.startsWith(".")) continue;
    if (!existsSync(join(VAULT(), dir, "memory", "search.sqlite"))) continue;
    try {
      const rows = getDb(dir)
        .prepare(`SELECT * FROM loops WHERE shared = 1 AND status IN (${placeholders}) ORDER BY ${ORDER_SQL}`)
        .all(...statuses) as LoopRow[];
      out.push(...rows);
    } catch { /* skip a domain whose DB can't be read */ }
  }
  return out;
}

function dedupeById(rows: LoopRow[]): LoopRow[] {
  const seen = new Set<string>();
  const out: LoopRow[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

function compareLoops(a: LoopRow, b: LoopRow): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const an = a.due == null, bn = b.due == null;
  if (an !== bn) return an ? 1 : -1;
  if (a.due && b.due && a.due !== b.due) return a.due < b.due ? -1 : 1;
  return b.updated_at - a.updated_at;
}

// ── Per-turn render (core/working memory) ────────────────────────────

/**
 * Render a compact OPEN LOOPS block for injection into every turn for `agentId`.
 * Current domain only (no cross-domain) to guarantee no leakage. Empty string
 * when there are no open loops (zero token cost on idle domains).
 */
export function renderLoopsBlock(agentId: string, max = 5): string {
  let rows: LoopRow[];
  let total: number;
  try {
    rows = listLoops(agentId, { status: "open", domain: agentId, limit: max });
    total = countActiveLoops(agentId);
  } catch {
    return "";
  }
  if (!rows.length) return "";

  const lines = rows.map((r) => {
    const bits = [`[${r.id}] ${r.title}`];
    if (r.status !== "open") bits.push(r.status);
    if (r.next_action) bits.push(`next: ${r.next_action}`);
    if (r.due) bits.push(`due ${r.due.slice(0, 10)}`);
    bits.push(`p${r.priority}`);
    let line = `• ${bits.join(" — ")}`;
    if (r.artifact_path) line += ` (artifact: ${basename(r.artifact_path)})`;
    return line.length > 200 ? line.slice(0, 197) + "…" : line;
  });

  const moreCount = total - rows.length;
  const more = moreCount > 0 ? `\n…+${moreCount} more (loop_list for all)` : "";
  return (
    "[OPEN LOOPS — your tracked, canonical state for this domain. Do NOT re-derive " +
    '"what\'s pending" from raw email/tasks; read & update these via loop_list / ' +
    "loop_update / loop_close as you act.]\n" +
    lines.join("\n") +
    more
  );
}
