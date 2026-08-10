/**
 * Open-loops MCP tools — the agent's durable, updatable "what's pending" state.
 *
 * loop_open / loop_update / loop_close / loop_list / loop_get over the per-domain
 * ledger (see loops-db.ts). The ledger is canonical: the agent opens a loop once
 * for a cross-turn pending item, advances it as it acts, and closes it when done
 * — so briefings report from it (and dedupe) instead of re-deriving "pending"
 * from raw signals every run.
 *
 * Cascades on close (auto-complete the mirrored TickTick task, mark the source
 * email read, delete the bound watch cron) are layered in by later phases.
 */
import { ok, error, AGENT } from "./_util.js";
import {
  openLoop, updateLoop, closeLoop, getLoop, listLoops, touchLoops,
  type LoopRow, type LoopStatus,
} from "./loops-db.js";
import { ttCreateTask, ttCompleteTask, ttGetTask } from "./ticktick.js";
import { handlers as cronHandlers } from "./cron.js";
import type { MCPToolDefinition, MCPHandler, MCPResponse } from "../types.js";

const STATUSES: LoopStatus[] = ["open", "in_progress", "awaiting_user", "blocked", "done", "dropped"];

// ── TickTick mirror helpers ──────────────────────────────────────────

function mapTickTickPriority(p: number): number {
  if (p >= 4) return 5; // high
  if (p === 3) return 3; // medium
  if (p >= 1) return 1; // low
  return 0; // none
}

// TickTick wants an ISO datetime; promote a date-only due to a noon time.
function fmtDueForTickTick(due: string | null | undefined): string | undefined {
  if (!due) return undefined;
  return /\d{2}:\d{2}/.test(due) ? due : `${due.slice(0, 10)}T12:00:00+0000`;
}

function splitTickTickId(ref: string): { projectId: string; taskId: string } | null {
  const i = ref.indexOf(":");
  if (i < 0) return null;
  return { projectId: ref.slice(0, i), taskId: ref.slice(i + 1) };
}

// Compact projection for tool output (full row is large; callers rarely need every column).
function project(r: LoopRow): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    next_action: r.next_action,
    due: r.due,
    priority: r.priority,
    source_ref: r.source_ref,
    artifact_path: r.artifact_path,
    ticktick_id: r.ticktick_id,
    watch_cron_id: r.watch_cron_id,
    shared: r.shared === 1,
    surfaced_count: r.surfaced_count,
    age_days: Math.floor((Date.now() - r.created_at) / 86_400_000),
  };
}

// ── Definitions ──────────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "loop_open",
    description:
      "Open (or update) a tracked OPEN LOOP — a cross-turn pending item you must not forget (an actionable unread email, a task the user committed to, a 'still need to X'). This is your canonical state; the OPEN LOOPS block injected each turn comes from here, and briefings report from it. Idempotent: opening the same item again (same dedupe_key, derived from source_ref or title) updates the existing loop instead of duplicating. Check the injected OPEN LOOPS block first — if it's already there, use loop_update.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short imperative title, e.g. 'Renew Ayuntamiento padrón'." },
        next_action: { type: "string", description: "The single concrete next step." },
        due: { type: "string", description: "Due date/time, ISO-8601 (e.g. 2026-06-05 or 2026-06-05T18:00:00+02:00)." },
        priority: { type: "number", description: "1 (low) … 5 (high). Default 3." },
        source_ref: { type: "string", description: "External anchor: email/gmail id, slack ts, telegram msg id. Used for stable dedup — pass it whenever the loop came from a message." },
        artifact_path: { type: "string", description: "Path to a generated artifact (PDF, etc.) once produced." },
        dedupe_key: { type: "string", description: "Optional explicit identity; auto-derived from source_ref or title if omitted." },
        shared: { type: "boolean", description: "true only for cross-domain PERSONAL items a briefing should carry. NEVER set for custody/health/finance." },
        watch_cron_id: { type: "string", description: "If you scheduled a watch cron for this loop, its id (deleted automatically when the loop closes)." },
        mirror_ticktick: { type: "boolean", description: "Mirror this loop as a TickTick task in the user's account (default true). Set false for ephemeral/internal loops." },
        ticktick_project_id: { type: "string", description: "Target TickTick project for the mirrored task (omit for Inbox)." },
      },
      required: ["title"],
    },
  },
  {
    name: "loop_update",
    description:
      "Update a tracked loop: advance its status (open → in_progress → awaiting_user → blocked), set the next_action, attach an artifact_path, change due/priority, or bind a watch_cron_id. Setting status to 'done' or 'dropped' closes it (prefer loop_close for that, which also runs the close cascades).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Loop id (loop-xxxx)." },
        status: { type: "string", enum: STATUSES, description: "New status." },
        next_action: { type: "string", description: "Updated next concrete step." },
        due: { type: "string", description: "Updated due (ISO-8601), or empty string to clear." },
        priority: { type: "number", description: "1..5." },
        artifact_path: { type: "string", description: "Path to a produced artifact." },
        source_ref: { type: "string", description: "External anchor." },
        watch_cron_id: { type: "string", description: "Bound watch cron id." },
      },
      required: ["id"],
    },
  },
  {
    name: "loop_close",
    description:
      "Close a loop when the underlying thing is genuinely resolved (you produced the artifact, sent the reply, the deadline passed). This is how you STOP an item from re-surfacing in briefings. Closing will (later phases) also complete the mirrored TickTick task, mark the source email read, and delete the bound watch cron.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Loop id." },
        resolution: { type: "string", description: "One-line note on how it resolved (shown in the briefing)." },
        status: { type: "string", enum: ["done", "dropped"], description: "done (resolved) or dropped (no longer relevant). Default done." },
        complete_ticktick: { type: "boolean", description: "Also complete the mirrored TickTick task (default true)." },
        mark_email_read: { type: "boolean", description: "Return the source_ref so you mark the source email read (default true)." },
      },
      required: ["id"],
    },
  },
  {
    name: "loop_list",
    description:
      "List tracked loops. This is the spine of the briefing: read open loops and report FROM them (don't re-derive 'pending' from raw email/tasks). Pass mark_surfaced:true when you actually report them so repeated-surfacing is tracked.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "'open' (default: the 4 active states), a specific state, a comma list, or 'all'." },
        domain: { type: "string", description: "Default current domain. Pass '+shared' to also include other domains' shared loops (cross-domain briefing only)." },
        limit: { type: "number", description: "Max rows (default 20)." },
        mark_surfaced: { type: "boolean", description: "If true, increment surfaced_count / last_surfaced_at on the returned loops (call when reporting them)." },
      },
    },
  },
  {
    name: "loop_get",
    description: "Get one loop's full state by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Loop id." } },
      required: ["id"],
    },
  },
  {
    name: "loop_sync_ticktick",
    description:
      "Reconcile the ledger with TickTick: close any loop whose mirrored task the user already completed, and retry mirrors that failed earlier (so a TickTick outage never permanently loses an item). Call this at the top of each briefing.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────

export const handlers: Record<string, MCPHandler> = {
  async loop_open(args: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = AGENT();
    if (!agentId) return error("No agent context (LETYCLAW_AGENT_ID unset)");
    const title = args.title as string | undefined;
    if (!title || !title.trim()) return error("title is required");

    const res = openLoop(agentId, {
      title: title.trim(),
      next_action: args.next_action as string | undefined,
      due: args.due as string | undefined,
      priority: args.priority as number | undefined,
      source_ref: args.source_ref as string | undefined,
      artifact_path: args.artifact_path as string | undefined,
      dedupe_key: args.dedupe_key as string | undefined,
      shared: args.shared as boolean | undefined,
      watch_cron_id: args.watch_cron_id as string | undefined,
    });

    // Mirror to TickTick so the loop shows in the user's account. Best-effort: the
    // ledger is canonical, so a TickTick failure NEVER drops the item — it's
    // flagged and retried by loop_sync_ticktick (fixes "TickTick task missing").
    let ticktickId: string | undefined;
    let mirrorFailed = false;
    if (!res.reused && args.mirror_ticktick !== false) {
      try {
        const task = await ttCreateTask({
          title: res.row.title,
          content: res.row.next_action ? `Next: ${res.row.next_action}` : undefined,
          projectId: (args.ticktick_project_id as string | undefined) || undefined,
          dueDate: fmtDueForTickTick(res.row.due),
          priority: mapTickTickPriority(res.row.priority),
        });
        ticktickId = `${task.projectId}:${task.id}`;
        updateLoop(agentId, res.id, { ticktick_id: ticktickId });
      } catch (err) {
        mirrorFailed = true;
        updateLoop(agentId, res.id, { mirror_flag: `ticktick_create_failed: ${(err as Error).message}`.slice(0, 180) });
      }
    }

    return ok(JSON.stringify({
      id: res.id,
      reused: res.reused,
      status: res.row.status,
      dedupe_key: res.row.dedupe_key,
      ...(ticktickId ? { ticktick_id: ticktickId } : {}),
      ...(mirrorFailed ? { ticktick_mirror_failed: true } : {}),
    }));
  },

  async loop_update(args: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = AGENT();
    if (!agentId) return error("No agent context (LETYCLAW_AGENT_ID unset)");
    const id = args.id as string | undefined;
    if (!id) return error("id is required");

    const row = updateLoop(agentId, id, {
      status: args.status as LoopStatus | undefined,
      next_action: args.next_action as string | undefined,
      due: args.due as string | undefined,
      priority: args.priority as number | undefined,
      artifact_path: args.artifact_path as string | undefined,
      source_ref: args.source_ref as string | undefined,
      watch_cron_id: args.watch_cron_id as string | undefined,
    });
    if (!row) return error(`No loop with id '${id}'`);
    return ok(JSON.stringify(project(row)));
  },

  async loop_close(args: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = AGENT();
    if (!agentId) return error("No agent context (LETYCLAW_AGENT_ID unset)");
    const id = args.id as string | undefined;
    if (!id) return error("id is required");
    const status = (args.status as "done" | "dropped" | undefined) === "dropped" ? "dropped" : "done";

    const row = closeLoop(agentId, id, status);
    if (!row) return error(`No loop with id '${id}'`);

    // Close cascade (best-effort, never fails the close):
    const cascades: string[] = [];
    // 1. Complete the mirrored TickTick task.
    if (row.ticktick_id && args.complete_ticktick !== false) {
      const parts = splitTickTickId(row.ticktick_id);
      if (parts) {
        try { await ttCompleteTask(parts.projectId, parts.taskId); cascades.push("TickTick task completed"); }
        catch (err) { cascades.push(`TickTick complete failed (${(err as Error).message.slice(0, 80)})`); }
      }
    }
    // 2. Delete the bound watch cron (the Honda-PCX fix — a watch dies with its loop).
    if (row.watch_cron_id) {
      try {
        const r = await cronHandlers.cron_delete!({ id: row.watch_cron_id });
        cascades.push(r.isError ? `watch cron not removed (${row.watch_cron_id})` : `watch cron ${row.watch_cron_id} removed`);
      } catch { cascades.push(`watch cron delete error (${row.watch_cron_id})`); }
    }
    // 3. Email mark-read lives in a SEPARATE MCP server (email-mcp), so it can't
    //    cascade in-process — surface the source so the agent marks it read.
    const markSource = args.mark_email_read !== false && row.source_ref ? row.source_ref : undefined;

    const resolution = (args.resolution as string | undefined) || "";
    return ok(JSON.stringify({
      id: row.id,
      status: row.status,
      summary: `✓ ${status}: ${row.title}${resolution ? ` — ${resolution}` : ""}${cascades.length ? ` [${cascades.join("; ")}]` : ""}`,
      ...(markSource ? { mark_source_read: markSource } : {}),
    }));
  },

  async loop_list(args: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = AGENT();
    if (!agentId) return error("No agent context (LETYCLAW_AGENT_ID unset)");
    const rows = listLoops(agentId, {
      status: args.status as string | undefined,
      domain: args.domain as string | undefined,
      limit: args.limit as number | undefined,
    });
    if (args.mark_surfaced === true && rows.length) {
      touchLoops(agentId, rows.map((r) => r.id));
    }
    return ok(JSON.stringify(rows.map(project)));
  },

  async loop_get(args: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = AGENT();
    if (!agentId) return error("No agent context (LETYCLAW_AGENT_ID unset)");
    const id = args.id as string | undefined;
    if (!id) return error("id is required");
    const row = getLoop(agentId, id);
    if (!row) return error(`No loop with id '${id}'`);
    return ok(JSON.stringify(row));
  },

  async loop_sync_ticktick(_args: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = AGENT();
    if (!agentId) return error("No agent context (LETYCLAW_AGENT_ID unset)");
    const active = listLoops(agentId, { status: "open", limit: 200 });
    const closedFromApp: string[] = [];
    const mirrorRetried: string[] = [];
    const errors: string[] = [];

    for (const loop of active) {
      if (loop.ticktick_id) {
        const parts = splitTickTickId(loop.ticktick_id);
        if (!parts) continue;
        try {
          const t = await ttGetTask(parts.projectId, parts.taskId);
          if (t.status === 2) { closeLoop(agentId, loop.id); closedFromApp.push(loop.id); }
        } catch (err) { errors.push(`${loop.id}: ${(err as Error).message.slice(0, 60)}`); }
      } else if (loop.mirror_flag && loop.mirror_flag.startsWith("ticktick_create_failed")) {
        try {
          const task = await ttCreateTask({
            title: loop.title,
            dueDate: fmtDueForTickTick(loop.due),
            priority: mapTickTickPriority(loop.priority),
          });
          updateLoop(agentId, loop.id, { ticktick_id: `${task.projectId}:${task.id}`, mirror_flag: null });
          mirrorRetried.push(loop.id);
        } catch (err) { errors.push(`retry ${loop.id}: ${(err as Error).message.slice(0, 60)}`); }
      }
    }
    return ok(JSON.stringify({ checked: active.length, closed_from_app: closedFromApp, mirror_retried: mirrorRetried, errors }));
  },
};
