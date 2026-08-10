/**
 * Gmail API tools — send / draft mail via the Gmail REST API over HTTPS.
 *
 * Why this exists: DigitalOcean blocks outbound SMTP (25/465/587) on droplets
 * by default, so the local `email` MCP server can do IMAP (inbox reads) but
 * cannot send. This module bypasses SMTP entirely by going through
 * gmail.googleapis.com on port 443, which is open.
 *
 * Refresh tokens are stored per account alias at
 * $LETYCLAW_SESSIONS_DIR/.gmail/<account>.json (created by
 * scripts/gmail-auth.mjs and then installed on the host).
 *
 * Token dir lives under LETYCLAW_SESSIONS_DIR (default /root/letyclaw/sessions) so it
 * inherits that path's read/write bind-mount in the letyclaw-bot systemd sandbox.
 *
 * Environment:
 *   LETYCLAW_GMAIL_TOKEN_DIR — override token directory
 *   LETYCLAW_SESSIONS_DIR    — fallback parent (default /root/letyclaw/sessions)
 *   LETYCLAW_GMAIL_DEFAULT_ACCOUNT — default safe account alias (default: "default")
 *
 * All handlers accept an optional safe `account` alias. Inbox reads / labels /
 * move / trash still go through the `email` MCP server over IMAP — this module
 * is sending only.
 */
import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import type { MCPToolDefinition, MCPHandler } from "../types.js";
import { ok, error, SESSIONS_DIR } from "./_util.js";

const TOKEN_DIR =
  process.env.LETYCLAW_GMAIL_TOKEN_DIR || join(SESSIONS_DIR(), ".gmail");
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SAFE_ACCOUNT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function configuredDefaultAccount(): string {
  const value = process.env.LETYCLAW_GMAIL_DEFAULT_ACCOUNT?.trim() || "default";
  if (SAFE_ACCOUNT_ALIAS.test(value)) return value;
  console.warn(
    `[gmail] ignoring unsafe LETYCLAW_GMAIL_DEFAULT_ACCOUNT value; using "default"`,
  );
  return "default";
}

const DEFAULT_ACCOUNT = configuredDefaultAccount();

type Account = string;

interface StoredTokens {
  account: Account;
  email: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  expiry?: number;
  scope?: string;
  obtained_at?: string;
}

// ── Token IO ─────────────────────────────────────────────────────────

const tokenCache = new Map<Account, StoredTokens>();

function tokenPath(account: Account): string {
  return join(TOKEN_DIR, `${account}.json`);
}

function loadTokens(account: Account): StoredTokens {
  if (tokenCache.has(account)) return tokenCache.get(account)!;
  const path = tokenPath(account);
  if (!existsSync(path)) {
    throw new Error(
      `no token file at ${path} for account '${account}'. ` +
      `Run on a trusted workstation: node scripts/gmail-auth.mjs ${account} <email-address> [client_secret.json]`,
    );
  }
  const t = JSON.parse(readFileSync(path, "utf8")) as StoredTokens;
  tokenCache.set(account, t);
  return t;
}

function saveTokens(account: Account, t: StoredTokens): void {
  const path = tokenPath(account);

  // Refuse to clobber the file's ownership. Tokens are normally owned by
  // the letyclaw user; if a root-uid diagnostic run refreshes the access token
  // and rewrites the file, the rename changes the owner to root and the
  // next letyclaw-uid bot start can no longer read the file (EACCES). Keep the
  // in-memory cache valid, just skip the on-disk write in that case.
  if (existsSync(path)) {
    try {
      const st = statSync(path);
      const myUid = typeof process.getuid === "function" ? process.getuid() : -1;
      if (myUid !== -1 && st.uid !== myUid) {
        tokenCache.set(account, t);
        console.warn(
          `[gmail] not persisting refreshed token for ${account}: file is owned by uid=${st.uid} but process is uid=${myUid}. ` +
          `In-memory cache updated; restart as the owning user for the new token to land on disk.`,
        );
        return;
      }
    } catch { /* fall through to write */ }
  }

  const tmp = join(dirname(path), `.${account}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(t, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  tokenCache.set(account, t);
}

// ── OAuth: refresh access token when expired ─────────────────────────

async function getAccessToken(account: Account): Promise<string> {
  const t = loadTokens(account);
  const now = Date.now();
  if (t.access_token && t.expiry && t.expiry - now > 60_000) {
    return t.access_token;
  }
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: t.client_id,
      client_secret: t.client_secret,
      refresh_token: t.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`token refresh failed for ${account} (${res.status}): ${await res.text()}`);
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  const updated: StoredTokens = {
    ...t,
    access_token: j.access_token,
    expiry: now + j.expires_in * 1000,
  };
  saveTokens(account, updated);
  return j.access_token;
}

// ── Gmail API call wrapper ───────────────────────────────────────────

async function gapi(
  account: Account,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = await getAccessToken(account);
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gmail API ${method} ${path} (${res.status}): ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

// ── MIME construction ────────────────────────────────────────────────

interface Attachment {
  filename: string;
  content_base64: string;
  mime_type?: string;
}

interface MessageInput {
  from_email: string;
  from_name?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  body_html?: string;
  attachments?: Attachment[];
  reply_to_message_id?: string; // RFC822 Message-ID we're replying to
  in_reply_to_refs?: string[]; // existing References chain
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function genBoundary(prefix: string): string {
  return `=_letyclaw_${prefix}_${randomBytes(12).toString("hex")}`;
}

function encodeHeader(text: string): string {
  // Encode any header value containing non-ASCII as RFC 2047 UTF-8 base64.
  return /[^\x20-\x7e]/.test(text)
    ? `=?UTF-8?B?${Buffer.from(text).toString("base64")}?=`
    : text;
}

function formatAddress(email: string, name?: string): string {
  return name ? `${encodeHeader(name)} <${email}>` : email;
}

export function _buildMimeForTest(m: MessageInput): string {
  return buildMime(m);
}

function buildMime(m: MessageInput): string {
  const lines: string[] = [];
  lines.push(`From: ${formatAddress(m.from_email, m.from_name)}`);
  lines.push(`To: ${m.to.join(", ")}`);
  if (m.cc?.length) lines.push(`Cc: ${m.cc.join(", ")}`);
  if (m.bcc?.length) lines.push(`Bcc: ${m.bcc.join(", ")}`);
  lines.push(`Subject: ${encodeHeader(m.subject)}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Date: ${new Date().toUTCString()}`);
  if (m.reply_to_message_id) {
    lines.push(`In-Reply-To: ${m.reply_to_message_id}`);
    const refs = [...(m.in_reply_to_refs ?? []), m.reply_to_message_id].join(" ");
    lines.push(`References: ${refs}`);
  }

  const hasAttachments = (m.attachments?.length ?? 0) > 0;
  const hasHtml = !!m.body_html;

  if (!hasAttachments && !hasHtml) {
    lines.push(`Content-Type: text/plain; charset="UTF-8"`);
    lines.push(`Content-Transfer-Encoding: 7bit`);
    lines.push("");
    lines.push(m.body);
    return lines.join("\r\n");
  }

  const altBoundary = genBoundary("alt");
  const mixedBoundary = genBoundary("mix");

  const body: string[] = [];
  const writeAlt = () => {
    body.push(`--${altBoundary}`);
    body.push(`Content-Type: text/plain; charset="UTF-8"`);
    body.push(`Content-Transfer-Encoding: 7bit`);
    body.push("");
    body.push(m.body);
    body.push("");
    body.push(`--${altBoundary}`);
    body.push(`Content-Type: text/html; charset="UTF-8"`);
    body.push(`Content-Transfer-Encoding: 7bit`);
    body.push("");
    body.push(m.body_html!);
    body.push("");
    body.push(`--${altBoundary}--`);
  };

  if (hasAttachments) {
    lines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);
    lines.push("");
    body.push(`--${mixedBoundary}`);
    if (hasHtml) {
      body.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
      body.push("");
      writeAlt();
    } else {
      body.push(`Content-Type: text/plain; charset="UTF-8"`);
      body.push(`Content-Transfer-Encoding: 7bit`);
      body.push("");
      body.push(m.body);
    }
    for (const a of m.attachments ?? []) {
      body.push("");
      body.push(`--${mixedBoundary}`);
      body.push(`Content-Type: ${a.mime_type || "application/octet-stream"}; name="${a.filename}"`);
      body.push(`Content-Disposition: attachment; filename="${a.filename}"`);
      body.push(`Content-Transfer-Encoding: base64`);
      body.push("");
      // Re-wrap to 76-char lines per RFC 2045
      const wrapped = a.content_base64.replace(/\s+/g, "").replace(/(.{76})/g, "$1\r\n");
      body.push(wrapped);
    }
    body.push("");
    body.push(`--${mixedBoundary}--`);
  } else {
    // hasHtml without attachments
    lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
    lines.push("");
    writeAlt();
  }

  return lines.join("\r\n") + "\r\n" + body.join("\r\n");
}

// ── Input parsing helpers ────────────────────────────────────────────

export function parseGmailAccount(account: unknown, fallback = DEFAULT_ACCOUNT): Account {
  const alias = (typeof account === "string" && account.trim()) || fallback;
  if (!SAFE_ACCOUNT_ALIAS.test(alias)) {
    throw new Error(
      `invalid Gmail account alias "${alias}"; use 1-64 letters, numbers, dots, underscores, or hyphens`,
    );
  }
  return alias;
}

function parseAccount(args: Record<string, unknown>): Account {
  return parseGmailAccount(args.account);
}

function asStringArray(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string") return v.split(/\s*,\s*/).filter(Boolean);
  return undefined;
}

function buildMessageInput(account: Account, args: Record<string, unknown>): MessageInput {
  const t = loadTokens(account);
  const to = asStringArray(args.to);
  if (!to?.length) throw new Error("'to' is required (string or string[])");
  const subject = typeof args.subject === "string" ? args.subject : "";
  const body = typeof args.body === "string" ? args.body : "";
  if (!subject) throw new Error("'subject' is required");
  if (!body && !args.body_html) throw new Error("'body' or 'body_html' is required");

  return {
    from_email: t.email,
    from_name: typeof args.from_name === "string"
      ? args.from_name
      : process.env.LETYCLAW_OWNER_NAME?.trim() || undefined,
    to,
    cc: asStringArray(args.cc),
    bcc: asStringArray(args.bcc),
    subject,
    body,
    body_html: typeof args.body_html === "string" ? args.body_html : undefined,
    attachments: Array.isArray(args.attachments)
      ? (args.attachments as Attachment[])
      : undefined,
    reply_to_message_id: typeof args.reply_to_message_id === "string" ? args.reply_to_message_id : undefined,
    in_reply_to_refs: asStringArray(args.in_reply_to_refs),
  };
}

type GmailApiCall = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) => Promise<unknown>;

function normalizeRfcMessageId(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed : `<${trimmed}>`;
}

function parseReferenceHeader(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) ?? [];
}

/** Resolve an RFC Message-ID into the Gmail thread and References chain.
 * Exported only to let the regression test exercise the provider boundary
 * without real credentials or network calls.
 */
export async function _resolveReplyContextForTest(
  replyToMessageId: string,
  api: GmailApiCall,
): Promise<{ threadId: string; replyToMessageId: string; references: string[] }> {
  const normalized = normalizeRfcMessageId(replyToMessageId);
  const q = encodeURIComponent(`rfc822msgid:${normalized}`);
  const search = (await api("GET", `/messages?q=${q}&maxResults=2`)) as {
    messages?: Array<{ id: string; threadId: string }>;
  };
  const matches = search.messages ?? [];
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? `reply target ${normalized} was not found in this Gmail account`
        : `reply target ${normalized} matched multiple Gmail messages`,
    );
  }
  const target = matches[0]!;
  const metadata = (await api(
    "GET",
    `/messages/${encodeURIComponent(target.id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
  )) as { payload?: { headers?: Array<{ name: string; value: string }> } };
  const headers = metadata.payload?.headers ?? [];
  const header = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const canonicalId = header("Message-ID");
  if (canonicalId && normalizeRfcMessageId(canonicalId) !== normalized) {
    throw new Error(`Gmail returned a different reply target for ${normalized}`);
  }
  return {
    threadId: target.threadId,
    replyToMessageId: canonicalId ? normalizeRfcMessageId(canonicalId) : normalized,
    references: parseReferenceHeader(header("References")),
  };
}

async function resolveReplyArgs(
  account: Account,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  _validateReplyMarkersForTest(args);
  if (typeof args.reply_to_message_id !== "string" || !args.reply_to_message_id.trim()) return args;
  const resolved = await _resolveReplyContextForTest(
    args.reply_to_message_id,
    (method, path, body) => gapi(account, method, path, body),
  );
  if (typeof args.thread_id === "string" && args.thread_id !== resolved.threadId) {
    throw new Error(
      `thread_id '${args.thread_id}' does not match reply target thread '${resolved.threadId}'`,
    );
  }
  const suppliedRefs = asStringArray(args.in_reply_to_refs) ?? [];
  return {
    ...args,
    thread_id: resolved.threadId,
    reply_to_message_id: resolved.replyToMessageId,
    in_reply_to_refs: [...new Set([...resolved.references, ...suppliedRefs])],
  };
}

/** Fail closed when a payload claims to be a reply but cannot be tied to the
 * exact source message. The subject is only a hint; it is never thread proof.
 */
export function _validateReplyMarkersForTest(args: Record<string, unknown>): void {
  const hasReplyTarget =
    typeof args.reply_to_message_id === "string" && args.reply_to_message_id.trim().length > 0;
  const hasThread = typeof args.thread_id === "string" && args.thread_id.trim().length > 0;
  const replySubject = typeof args.subject === "string" && /^\s*re\s*:/i.test(args.subject);
  if (!hasReplyTarget && (hasThread || replySubject)) {
    throw new Error(
      "reply_to_message_id is required for replies; refusing to risk sending a new Gmail thread",
    );
  }
}

// ── Tool schema constants ────────────────────────────────────────────

const ACCOUNT_PROP = {
  type: "string",
  description:
    `Safe Gmail token alias (the filename under .gmail without .json). Defaults to '${DEFAULT_ACCOUNT}'.`,
} as const;

const COMMON_MSG_PROPS = {
  to: {
    description: "Recipient email address(es). Single string or array of strings.",
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },
  cc: {
    description: "Cc recipients (optional).",
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },
  bcc: {
    description: "Bcc recipients (optional).",
    oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  },
  subject: { type: "string", description: "Message subject." },
  body: { type: "string", description: "Plain-text body." },
  body_html: { type: "string", description: "Optional HTML body (sent as multipart/alternative with the plain-text body)." },
  from_name: { type: "string", description: "Optional sender display name. Defaults to the configured owner name when present." },
  attachments: {
    type: "array",
    description: "File attachments. Each item: {filename, content_base64, mime_type?}.",
    items: {
      type: "object",
      properties: {
        filename: { type: "string" },
        content_base64: { type: "string" },
        mime_type: { type: "string" },
      },
      required: ["filename", "content_base64"],
    },
  },
  reply_to_message_id: {
    type: "string",
    description: "RFC822 Message-ID of the message being replied to (sets In-Reply-To header).",
  },
  in_reply_to_refs: {
    type: "array",
    items: { type: "string" },
    description: "Existing References chain (for threaded replies).",
  },
  thread_id: {
    type: "string",
    description:
      "Gmail THREAD id (NOT message id — different ids, both look like 16-char hex). " +
      "Get it from `mcp__claude_ai_Gmail__search_threads`: the OUTER `id` on the thread " +
      "object (e.g. \"19df92dcf0c14608\"), NOT the inner `id` on individual messages. " +
      "For replies, prefer reply_to_message_id: gmail_send resolves and validates the real thread. " +
      "An invalid or mismatched thread id fails closed and is never retried as a new email.",
  },
  account: ACCOUNT_PROP,
} as const;

// ── Tool definitions ─────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "gmail_send",
    description:
      "Send an email via the Gmail API (port 443 — works on DO droplet where SMTP is blocked). " +
      "Returns the new message ID and threadId. For a reply, pass reply_to_message_id from the " +
      "source email; the tool resolves and enforces Gmail thread continuity. Use this for ALL outbound mail — do NOT fall back " +
      "to `mcp__claude_ai_Gmail__create_draft` (that connector is read-only).",
    inputSchema: {
      type: "object",
      properties: COMMON_MSG_PROPS,
      required: ["to", "subject"],
    },
  },
  {
    name: "gmail_create_draft",
    description:
      "Create a Gmail draft (does not send). Returns the draft ID — pair with gmail_send_draft " +
      "after the user approves, or with gmail_update_draft to revise.",
    inputSchema: {
      type: "object",
      properties: COMMON_MSG_PROPS,
      required: ["to", "subject"],
    },
  },
  {
    name: "gmail_send_draft",
    description: "Send an existing Gmail draft by ID.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string", description: "The Gmail draft ID returned by gmail_create_draft." },
        account: ACCOUNT_PROP,
      },
      required: ["draft_id"],
    },
  },
  {
    name: "gmail_list_drafts",
    description: "List Gmail drafts for the given account. Optional Gmail search query (e.g. 'subject:invoice').",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query (same syntax as the Gmail UI search box)." },
        max_results: { type: "number", description: "Maximum drafts to return (default 20)." },
        account: ACCOUNT_PROP,
      },
    },
  },
  {
    name: "gmail_get_draft",
    description: "Fetch the full content of a Gmail draft by ID.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        account: ACCOUNT_PROP,
      },
      required: ["draft_id"],
    },
  },
  {
    name: "gmail_update_draft",
    description: "Replace the content of an existing Gmail draft. All message fields are required (full replacement).",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        ...COMMON_MSG_PROPS,
      },
      required: ["draft_id", "to", "subject"],
    },
  },
  {
    name: "gmail_delete_draft",
    description: "Permanently delete a Gmail draft by ID.",
    inputSchema: {
      type: "object",
      properties: {
        draft_id: { type: "string" },
        account: ACCOUNT_PROP,
      },
      required: ["draft_id"],
    },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────

const handle_gmail_send: MCPHandler = async (args) => {
  try {
    const account = parseAccount(args);
    const resolvedArgs = await resolveReplyArgs(account, args);
    const msg = buildMessageInput(account, resolvedArgs);
    const raw = b64url(Buffer.from(buildMime(msg)));
    const body: { raw: string; threadId?: string } = { raw };
    if (typeof resolvedArgs.thread_id === "string") body.threadId = resolvedArgs.thread_id;

    type SendResp = { id: string; threadId: string; labelIds?: string[] };
    const res = (await gapi(account, "POST", "/messages/send", body)) as SendResp;
    if (body.threadId && res.threadId !== body.threadId) {
      throw new Error(`Gmail sent into unexpected thread '${res.threadId}' (expected '${body.threadId}')`);
    }
    return ok(
      `✓ Sent from ${account} (${msg.from_email})\n` +
      `  to: ${msg.to.join(", ")}\n` +
      `  subject: ${msg.subject}\n` +
      `  messageId: ${res.id}\n` +
      `  threadId: ${res.threadId}`,
    );
  } catch (e) {
    return error((e as Error).message);
  }
};

const handle_gmail_create_draft: MCPHandler = async (args) => {
  try {
    const account = parseAccount(args);
    const resolvedArgs = await resolveReplyArgs(account, args);
    const msg = buildMessageInput(account, resolvedArgs);
    const raw = b64url(Buffer.from(buildMime(msg)));
    const body: { message: { raw: string; threadId?: string } } = { message: { raw } };
    if (typeof resolvedArgs.thread_id === "string") body.message.threadId = resolvedArgs.thread_id;
    const res = (await gapi(account, "POST", "/drafts", body)) as {
      id: string;
      message: { id: string; threadId: string };
    };
    return ok(
      `✓ Draft created in ${account} (${msg.from_email})\n` +
      `  draftId: ${res.id}\n` +
      `  messageId: ${res.message.id}\n` +
      `  to: ${msg.to.join(", ")}\n` +
      `  subject: ${msg.subject}\n\n` +
      `To send: gmail_send_draft({draft_id: "${res.id}", account: "${account}"})`,
    );
  } catch (e) {
    return error((e as Error).message);
  }
};

const handle_gmail_send_draft: MCPHandler = async (args) => {
  try {
    const account = parseAccount(args);
    const draftId = args.draft_id;
    if (typeof draftId !== "string" || !draftId) throw new Error("'draft_id' is required");
    const res = (await gapi(account, "POST", "/drafts/send", { id: draftId })) as {
      id: string;
      threadId: string;
    };
    return ok(`✓ Sent draft ${draftId}\n  messageId: ${res.id}\n  threadId: ${res.threadId}`);
  } catch (e) {
    return error((e as Error).message);
  }
};

const handle_gmail_list_drafts: MCPHandler = async (args) => {
  try {
    const account = parseAccount(args);
    const query = typeof args.query === "string" ? args.query : "";
    const max = typeof args.max_results === "number" ? args.max_results : 20;
    const params = new URLSearchParams({ maxResults: String(max) });
    if (query) params.set("q", query);
    const res = (await gapi(account, "GET", `/drafts?${params}`)) as {
      drafts?: Array<{ id: string; message: { id: string; threadId: string } }>;
      resultSizeEstimate?: number;
    };
    const drafts = res.drafts ?? [];
    if (!drafts.length) return ok(`No drafts in ${account}${query ? ` matching "${query}"` : ""}`);
    // For UI value, fetch metadata for each
    const metas = await Promise.all(
      drafts.slice(0, max).map(async (d) => {
        const m = (await gapi(
          account,
          "GET",
          `/drafts/${d.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=To&metadataHeaders=Date`,
        )) as { message: { payload?: { headers?: Array<{ name: string; value: string }> } } };
        const headers = m.message.payload?.headers ?? [];
        const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";
        return { id: d.id, subject: get("Subject"), to: get("To"), date: get("Date") };
      }),
    );
    const lines = metas.map((m) => `${m.id}  →  ${m.to}  ·  ${m.subject}  ·  ${m.date}`);
    return ok(`${account} drafts (${drafts.length}):\n${lines.join("\n")}`);
  } catch (e) {
    return error((e as Error).message);
  }
};

const handle_gmail_get_draft: MCPHandler = async (args) => {
  try {
    const account = parseAccount(args);
    const draftId = args.draft_id;
    if (typeof draftId !== "string" || !draftId) throw new Error("'draft_id' is required");
    const res = (await gapi(account, "GET", `/drafts/${draftId}?format=full`)) as {
      id: string;
      message: {
        id: string;
        threadId: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          parts?: Array<{ mimeType: string; body: { data?: string } }>;
          body?: { data?: string };
          mimeType?: string;
        };
      };
    };
    const headers = res.message.payload?.headers ?? [];
    const get = (n: string) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? "";

    function decodeBody(payload: typeof res.message.payload): string {
      if (!payload) return "";
      // prefer text/plain part
      const findText = (p: typeof payload): string | undefined => {
        if (p?.mimeType?.startsWith("text/") && p.body?.data) {
          return Buffer.from(p.body.data, "base64url").toString("utf8");
        }
        for (const sub of p?.parts ?? []) {
          const r = findText(sub as typeof payload);
          if (r) return r;
        }
        return undefined;
      };
      return findText(payload) ?? "";
    }

    return ok(
      `Draft ${draftId} (${account})\n` +
      `From:    ${get("From")}\n` +
      `To:      ${get("To")}\n` +
      `Subject: ${get("Subject")}\n` +
      `\n` +
      decodeBody(res.message.payload),
    );
  } catch (e) {
    return error((e as Error).message);
  }
};

const handle_gmail_update_draft: MCPHandler = async (args) => {
  try {
    const account = parseAccount(args);
    const draftId = args.draft_id;
    if (typeof draftId !== "string" || !draftId) throw new Error("'draft_id' is required");
    const resolvedArgs = await resolveReplyArgs(account, args);
    const msg = buildMessageInput(account, resolvedArgs);
    const raw = b64url(Buffer.from(buildMime(msg)));
    const body: { message: { raw: string; threadId?: string } } = { message: { raw } };
    if (typeof resolvedArgs.thread_id === "string") body.message.threadId = resolvedArgs.thread_id;
    const res = (await gapi(account, "PUT", `/drafts/${draftId}`, body)) as {
      id: string;
      message: { id: string; threadId: string };
    };
    return ok(`✓ Updated draft ${res.id} in ${account}\n  to: ${msg.to.join(", ")}\n  subject: ${msg.subject}`);
  } catch (e) {
    return error((e as Error).message);
  }
};

const handle_gmail_delete_draft: MCPHandler = async (args) => {
  try {
    const account = parseAccount(args);
    const draftId = args.draft_id;
    if (typeof draftId !== "string" || !draftId) throw new Error("'draft_id' is required");
    await gapi(account, "DELETE", `/drafts/${draftId}`);
    return ok(`✓ Deleted draft ${draftId} from ${account}`);
  } catch (e) {
    return error((e as Error).message);
  }
};

export const handlers: Record<string, MCPHandler> = {
  gmail_send: handle_gmail_send,
  gmail_create_draft: handle_gmail_create_draft,
  gmail_send_draft: handle_gmail_send_draft,
  gmail_list_drafts: handle_gmail_list_drafts,
  gmail_get_draft: handle_gmail_get_draft,
  gmail_update_draft: handle_gmail_update_draft,
  gmail_delete_draft: handle_gmail_delete_draft,
};
