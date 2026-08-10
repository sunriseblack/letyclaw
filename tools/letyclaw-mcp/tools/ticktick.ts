/**
 * TickTick task tracker — list/create/update/complete/delete tasks and
 * projects via the TickTick Open API. Uses the OAuth2 access/refresh
 * tokens stored at TICKTICK_TOKEN_FILE (one-time auth via
 * scripts/ticktick-auth.ts).
 *
 * Environment:
 *   TICKTICK_CLIENT_ID, TICKTICK_CLIENT_SECRET — registered app credentials
 *   TICKTICK_TOKEN_FILE                        — token JSON path
 *                                                (default /root/letyclaw/sessions/.ticktick-tokens.json)
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from "fs";
import { dirname, join } from "path";
import type { MCPToolDefinition, MCPHandler } from "../types.js";
import { ok, error } from "./_util.js";

const TOKEN_FILE =
  process.env.TICKTICK_TOKEN_FILE ||
  "/root/letyclaw/sessions/.ticktick-tokens.json";
const TOKEN_FILE_BAK = `${TOKEN_FILE}.bak`;
const CLIENT_ID = process.env.TICKTICK_CLIENT_ID || "";
const CLIENT_SECRET = process.env.TICKTICK_CLIENT_SECRET || "";

const API_BASE = "https://api.ticktick.com/open/v1";
const TOKEN_URL = "https://ticktick.com/oauth/token";

interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  scope: string;
}

// ── Token IO (atomic write + .bak fallback, mirrors Withings pattern) ─

function readTokens(): Tokens | null {
  for (const path of [TOKEN_FILE, TOKEN_FILE_BAK]) {
    if (!existsSync(path)) continue;
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Tokens;
    } catch { /* fall through to .bak */ }
  }
  return null;
}

function writeTokens(t: Tokens): void {
  if (existsSync(TOKEN_FILE)) {
    try { copyFileSync(TOKEN_FILE, TOKEN_FILE_BAK); } catch { /* best effort */ }
  }
  const tmp = join(dirname(TOKEN_FILE), `.ticktick-tokens.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(t, null, 2));
  renameSync(tmp, TOKEN_FILE);
}

// ── OAuth: refresh if near expiry ─────────────────────────────────────

async function refreshAccessToken(refresh: string): Promise<Tokens> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("TICKTICK_CLIENT_ID / TICKTICK_CLIENT_SECRET not set");
  }
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope: "tasks:read tasks:write",
    }),
  });
  if (!res.ok) {
    throw new Error(`TickTick token refresh failed (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope: string };
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token ?? refresh,
    expires_at: Math.floor(Date.now() / 1000) + j.expires_in,
    scope: j.scope,
  };
}

// Single-flight refresh: when several tool calls in one run hit an about-to-
// expire token at once, they would each refresh and rewrite the token file —
// and a refresh that rotates the refresh_token can invalidate the others
// (the 3x-create-failure signature behind "padrón TickTick task STILL missing").
// Memoize the in-flight refresh so N callers await ONE.
let refreshInFlight: Promise<Tokens> | null = null;

async function getAccessToken(): Promise<string> {
  const t = readTokens();
  if (!t) {
    throw new Error(
      `No TickTick tokens at ${TOKEN_FILE}. Run scripts/ticktick-auth.ts to authorize.`,
    );
  }
  // 60s safety margin
  if (t.expires_at > Math.floor(Date.now() / 1000) + 60) return t.access_token;
  if (!t.refresh_token) {
    throw new Error("TickTick access token expired and no refresh_token available — re-run scripts/ticktick-auth.ts");
  }
  if (!refreshInFlight) {
    const rt = t.refresh_token;
    refreshInFlight = refreshAccessToken(rt)
      .then((fresh) => { writeTokens(fresh); return fresh; })
      .finally(() => { refreshInFlight = null; });
  }
  return (await refreshInFlight).access_token;
}

// ── Generic API request (bounded retry on transient failures) ─────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `idempotent` defaults to true for GET/DELETE. For POST it defaults false so a
 * non-idempotent create isn't blindly retried after the server may have
 * committed it (only network-pre-response and 429 are retried). Pass
 * idempotent:true for effectively-idempotent POSTs (e.g. /complete).
 */
async function api<T>(method: string, path: string, body?: unknown, opts: { idempotent?: boolean } = {}): Promise<T> {
  const idempotent = opts.idempotent ?? (method === "GET" || method === "DELETE");
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (attempt > 0) await sleep(attempt === 1 ? 250 : 1000);
    let res: Response;
    try {
      const token = await getAccessToken();
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network-level failure (no response). Safe to retry idempotent ops; a
      // create that threw pre-response (attempt 0) never reached the server.
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (idempotent || attempt === 0) continue;
      throw lastErr;
    }
    if (res.ok) {
      if (res.status === 204) return {} as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    }
    const text = await res.text();
    lastErr = new Error(`TickTick ${method} ${path} → ${res.status}: ${text}`);
    if (res.status === 429 || (res.status >= 500 && idempotent)) continue; // transient
    throw lastErr; // 4xx (auth/bad-request) — not retryable
  }
  throw lastErr ?? new Error(`TickTick ${method} ${path} failed`);
}

// ── Programmatic helpers (used in-process by the loops ledger mirror) ─

export interface TickTickTaskRef { id: string; projectId: string; status?: number; title: string }

export async function ttCreateTask(input: {
  title: string; content?: string; projectId?: string; dueDate?: string; isAllDay?: boolean; priority?: number;
}): Promise<TickTickTaskRef> {
  const body: Record<string, unknown> = { title: input.title };
  for (const k of ["content", "projectId", "dueDate", "isAllDay", "priority"] as const) {
    if (input[k] !== undefined) body[k] = input[k];
  }
  return api<TickTickTaskRef>("POST", "/task", body);
}

export async function ttCompleteTask(projectId: string, taskId: string): Promise<void> {
  await api<unknown>(
    "POST",
    `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
    undefined,
    { idempotent: true },
  );
}

export async function ttGetTask(projectId: string, taskId: string): Promise<TickTickTaskRef> {
  return api<TickTickTaskRef>(
    "GET",
    `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
  );
}

// ── TickTick types (subset we actually use) ───────────────────────────

interface TTProject {
  id: string;
  name: string;
  color?: string;
  groupId?: string;
  kind?: string;
  closed?: boolean;
}

interface TTTask {
  id: string;
  projectId: string;
  title: string;
  content?: string;
  desc?: string;
  status?: number;       // 0 = active, 2 = completed
  priority?: number;     // 0 none, 1 low, 3 medium, 5 high
  dueDate?: string;
  startDate?: string;
  isAllDay?: boolean;
  tags?: string[];
  items?: Array<{ id?: string; title: string; status?: number }>;
}

interface TTProjectData {
  project: TTProject;
  tasks: TTTask[];
  columns?: Array<{ id: string; projectId: string; name: string; sortOrder?: number }>;
}

// ── Tool definitions ──────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "ticktick_list_projects",
    description:
      "List all TickTick projects (lists). Returns id, name, color, kind. Inbox is not included — use ticktick_create_task with no projectId for Inbox.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ticktick_get_project",
    description:
      "Get a TickTick project with its tasks and columns. Returns the full project state including all active tasks. Use ticktick_list_projects first to find the projectId.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project ID from ticktick_list_projects." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "ticktick_get_task",
    description: "Get a single TickTick task by projectId + taskId.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["projectId", "taskId"],
    },
  },
  {
    name: "ticktick_create_task",
    description:
      "Create a new TickTick task. Title is required; everything else is optional. If projectId is omitted, the task lands in the Inbox.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title (required)." },
        content: { type: "string", description: "Task description / notes." },
        projectId: { type: "string", description: "Target project ID. Omit for Inbox." },
        dueDate: { type: "string", description: "ISO 8601 datetime, e.g. 2026-04-30T17:00:00+0000." },
        startDate: { type: "string", description: "ISO 8601 datetime." },
        isAllDay: { type: "boolean" },
        priority: { type: "number", description: "0 (none), 1 (low), 3 (medium), 5 (high)." },
        tags: { type: "array", items: { type: "string" }, description: "List of tag names." },
        items: {
          type: "array",
          items: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
          description: "Subtask items.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "ticktick_update_task",
    description:
      "Update a TickTick task. The TickTick API is full-replace — pass every field you want kept. Fetch the current task first via ticktick_get_task if unsure.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        projectId: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        dueDate: { type: "string" },
        startDate: { type: "string" },
        isAllDay: { type: "boolean" },
        priority: { type: "number" },
        tags: { type: "array", items: { type: "string" } },
        items: {
          type: "array",
          items: { type: "object" },
        },
      },
      required: ["taskId", "projectId"],
    },
  },
  {
    name: "ticktick_complete_task",
    description: "Mark a TickTick task complete by projectId + taskId.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["projectId", "taskId"],
    },
  },
  {
    name: "ticktick_delete_task",
    description: "Delete a TickTick task by projectId + taskId.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["projectId", "taskId"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

function summarizeTask(t: TTTask): string {
  const parts: string[] = [`[${t.id}] ${t.title}`];
  if (t.priority && t.priority > 0) parts.push(`p${t.priority}`);
  if (t.dueDate) parts.push(`due ${t.dueDate}`);
  if (t.tags?.length) parts.push(`#${t.tags.join(",#")}`);
  if (t.status === 2) parts.push("(done)");
  return parts.join(" · ");
}

export const handlers: Record<string, MCPHandler> = {
  ticktick_list_projects: async () => {
    try {
      const projects = await api<TTProject[]>("GET", "/project");
      if (!projects.length) return ok("No projects.");
      const lines = projects.map(p => `[${p.id}] ${p.name}${p.kind ? ` (${p.kind})` : ""}${p.closed ? " — closed" : ""}`);
      return ok(`${projects.length} project(s):\n${lines.join("\n")}`);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },

  ticktick_get_project: async (args) => {
    const projectId = args.projectId as string;
    if (!projectId) return error("projectId is required.");
    try {
      const data = await api<TTProjectData>("GET", `/project/${encodeURIComponent(projectId)}/data`);
      const headerLines = [`Project: ${data.project.name} [${data.project.id}]`];
      if (data.columns?.length) {
        headerLines.push(`Columns: ${data.columns.map(c => c.name).join(", ")}`);
      }
      const taskLines = data.tasks.length
        ? data.tasks.map(summarizeTask)
        : ["(no tasks)"];
      return ok([...headerLines, "", ...taskLines].join("\n"));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },

  ticktick_get_task: async (args) => {
    const projectId = args.projectId as string;
    const taskId = args.taskId as string;
    if (!projectId || !taskId) return error("projectId and taskId are required.");
    try {
      const t = await api<TTTask>(
        "GET",
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
      );
      return ok(JSON.stringify(t, null, 2));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },

  ticktick_create_task: async (args) => {
    const title = args.title as string | undefined;
    if (!title || !title.trim()) return error("title is required.");
    const body: Record<string, unknown> = { title };
    for (const k of ["content", "projectId", "dueDate", "startDate", "isAllDay", "priority", "tags", "items"] as const) {
      if (args[k] !== undefined) body[k] = args[k];
    }
    try {
      const created = await api<TTTask>("POST", "/task", body);
      return ok(`Created task [${created.id}] ${created.title} in project ${created.projectId}`);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },

  ticktick_update_task: async (args) => {
    const taskId = args.taskId as string;
    const projectId = args.projectId as string;
    if (!taskId || !projectId) return error("taskId and projectId are required.");
    const body: Record<string, unknown> = { id: taskId, projectId };
    for (const k of ["title", "content", "dueDate", "startDate", "isAllDay", "priority", "tags", "items"] as const) {
      if (args[k] !== undefined) body[k] = args[k];
    }
    try {
      const updated = await api<TTTask>("POST", `/task/${encodeURIComponent(taskId)}`, body);
      return ok(`Updated task [${updated.id}] ${updated.title}`);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },

  ticktick_complete_task: async (args) => {
    const projectId = args.projectId as string;
    const taskId = args.taskId as string;
    if (!projectId || !taskId) return error("projectId and taskId are required.");
    try {
      await api<unknown>(
        "POST",
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`,
      );
      return ok(`Completed [${taskId}]`);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },

  ticktick_delete_task: async (args) => {
    const projectId = args.projectId as string;
    const taskId = args.taskId as string;
    if (!projectId || !taskId) return error("projectId and taskId are required.");
    try {
      await api<unknown>(
        "DELETE",
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`,
      );
      return ok(`Deleted [${taskId}]`);
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};
