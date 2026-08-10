/**
 * Messaging tools — Rich Telegram messaging via Bot API.
 *
 * Provides inline keyboards, polls, reactions, typing indicators, message editing.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 */

import { readFileSync, statSync, existsSync, realpathSync } from "fs";
import { basename } from "path";
import { ok, error, TOPIC as TOPIC_ID, SESSIONS_DIR, stripCdataEnvelope, safeAbsPath, VAULT } from "./_util.js";
import { recordPendingMessageId } from "../../../lib.js";
import type { MCPToolDefinition, MCPResponse } from "../types.js";

const BOT_TOKEN = (): string => process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = (): string => process.env.LETYCLAW_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";

// Files the agent may send out: its own workspace (vault), scratch (/tmp), and
// the project root. Same allow-list the media tools use — keeps a compromised
// or confused agent from exfiltrating arbitrary host files (e.g. /etc/passwd).
const ALLOWED_FILE_DIRS = (): string[] => [VAULT(), "/tmp", process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw"];

// Record a mid-run sent message_id so bot.ts can map it to this run's Claude
// sessionId after the run settles (reply-to-resume continuity). Best-effort:
// no-op if we can't resolve a topic. See recordPendingMessageId in lib.ts.
function trackSentMessage(topicId: string, messageId: unknown): void {
  if (!topicId || messageId == null) return;
  recordPendingMessageId(SESSIONS_DIR(), topicId, messageId as number);
}

// ── Telegram API helper ───────────────────────────────────────────────

async function tgApi(method: string, body: Record<string, unknown>): Promise<unknown> {
  const token = BOT_TOKEN();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json() as { ok: boolean; description?: string; result: unknown };
  if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description}`);
  return data.result;
}

// Multipart variant for file uploads (sendDocument/sendPhoto/...). tgApi sends
// JSON, which can't carry a file body, so we POST a FormData with the binary
// as a Blob; undici/fetch sets the multipart boundary header automatically.
async function tgUpload(method: string, form: FormData): Promise<unknown> {
  const token = BOT_TOKEN();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");

  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
  });

  const data = await res.json() as { ok: boolean; description?: string; result: unknown };
  if (!data.ok) throw new Error(`Telegram API ${method}: ${data.description}`);
  return data.result;
}

// ── File-send kinds ──────────────────────────────────────────────────
// Maps each `kind` to its Telegram method, multipart field name, size cap, and
// how to dig the resulting file_id out of the response. Telegram caps bot
// uploads at 50 MB; photos are additionally capped at 10 MB.

const MB = 1024 * 1024;

interface KindSpec {
  method: string;
  field: string;
  maxBytes: number;
  extractFileId: (r: Record<string, unknown>) => string | undefined;
}

const KIND_SPEC: Record<string, KindSpec> = {
  document: {
    method: "sendDocument", field: "document", maxBytes: 50 * MB,
    extractFileId: (r) => (r.document as Record<string, unknown> | undefined)?.file_id as string | undefined,
  },
  photo: {
    method: "sendPhoto", field: "photo", maxBytes: 10 * MB,
    extractFileId: (r) => {
      const sizes = r.photo as Array<Record<string, unknown>> | undefined;
      return sizes?.[sizes.length - 1]?.file_id as string | undefined;
    },
  },
  audio: {
    method: "sendAudio", field: "audio", maxBytes: 50 * MB,
    extractFileId: (r) => (r.audio as Record<string, unknown> | undefined)?.file_id as string | undefined,
  },
  voice: {
    method: "sendVoice", field: "voice", maxBytes: 50 * MB,
    extractFileId: (r) => (r.voice as Record<string, unknown> | undefined)?.file_id as string | undefined,
  },
};

// Best-effort MIME from extension — Telegram mostly infers from the filename,
// but a correct type helps clients preview common formats. Default is the
// generic binary type so anything still sends.
function guessMime(name: string): string {
  const ext = name.toLowerCase().split(".").pop() || "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp3: "audio/mpeg", ogg: "audio/ogg", oga: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4",
  };
  return map[ext] || "application/octet-stream";
}

// ── Button types ─────────────────────────────────────────────────────

interface InlineButton {
  text: string;
  url?: string;
  callback_data?: string;
}

interface FlatButton {
  text: string;
  url?: string;
  callback_data?: string;
  row_break?: boolean;
}

// ── Tool definitions ──────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "message_send",
    description:
      "Send a rich text message to a Telegram topic. Supports HTML formatting. Can optionally include an inline keyboard (buttons).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text (HTML or plain text)" },
        topic_id: { type: "string", description: "Telegram topic/thread ID (default: current topic)" },
        parse_mode: {
          type: "string",
          enum: ["HTML", "MarkdownV2", ""],
          description: "Parse mode (default: HTML)",
        },
        buttons: {
          type: "array",
          description: "Rows of inline keyboard buttons. Each row is an array of {text, url} or {text, callback_data} objects.",
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                url: { type: "string" },
                callback_data: { type: "string" },
              },
              required: ["text"],
            },
          },
        },
      },
      required: ["text"],
    },
  },
  {
    name: "message_buttons",
    description:
      "Send an inline keyboard with buttons. Each button can be a URL link or a callback button. Organizes buttons into rows automatically.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text above the buttons" },
        buttons: {
          type: "array",
          description: "Flat list of buttons. Use 'row_break: true' to start a new row.",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "Button label" },
              url: { type: "string", description: "URL to open (for link buttons)" },
              callback_data: { type: "string", description: "Callback data (for interactive buttons)" },
              row_break: { type: "boolean", description: "If true, start a new row before this button" },
            },
            required: ["text"],
          },
        },
        topic_id: { type: "string", description: "Topic ID (default: current)" },
      },
      required: ["text", "buttons"],
    },
  },
  {
    name: "message_poll",
    description:
      "Create a Telegram poll in a topic. Supports regular polls and quizzes.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Poll question (max 300 chars)" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Poll options (2-10 items)",
        },
        is_anonymous: { type: "boolean", description: "Anonymous poll (default: false)" },
        type: {
          type: "string",
          enum: ["regular", "quiz"],
          description: "Poll type (default: regular)",
        },
        correct_option_id: { type: "number", description: "For quiz: 0-based index of correct answer" },
        topic_id: { type: "string", description: "Topic ID (default: current)" },
      },
      required: ["question", "options"],
    },
  },
  {
    name: "message_react",
    description:
      "React to a message with an emoji. Uses Telegram's reaction API.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "number", description: "Message ID to react to" },
        emoji: {
          type: "string",
          description: "Emoji to react with (e.g. '\ud83d\udc4d', '\u2764\ufe0f', '\ud83d\udd25', '\ud83d\udc4f', '\ud83e\udd14', '\ud83c\udf89', '\ud83d\ude02')",
        },
      },
      required: ["message_id", "emoji"],
    },
  },
  {
    name: "message_typing",
    description:
      "Send a typing indicator to a topic. Shows '... is typing' in the chat for ~5 seconds.",
    inputSchema: {
      type: "object",
      properties: {
        topic_id: { type: "string", description: "Topic ID (default: current)" },
        action: {
          type: "string",
          enum: ["typing", "upload_photo", "upload_document", "record_voice"],
          description: "Chat action type (default: typing)",
        },
      },
    },
  },
  {
    name: "message_edit",
    description:
      "Edit a previously sent message. Can update text and/or inline keyboard.",
    inputSchema: {
      type: "object",
      properties: {
        message_id: { type: "number", description: "Message ID to edit" },
        text: { type: "string", description: "New message text" },
        parse_mode: { type: "string", enum: ["HTML", "MarkdownV2", ""], description: "Parse mode" },
        buttons: {
          type: "array",
          description: "New inline keyboard (same format as message_send)",
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                url: { type: "string" },
                callback_data: { type: "string" },
              },
              required: ["text"],
            },
          },
        },
      },
      required: ["message_id", "text"],
    },
  },
  {
    name: "message_document",
    description:
      "Send a file from the server to the configured Telegram chat as a downloadable attachment — reports, PDFs, spreadsheets, .md/.csv/.docx, or any artifact generated on disk. Use this to actually DELIVER documents you create: the user cannot access a server path directly. Defaults to sending as a document; set kind to 'photo' for an inline image, or 'audio'/'voice' for sound. The file must already exist under the vault, /tmp, or the project root.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file on disk (must be under the vault, /tmp, or the project root)." },
        caption: { type: "string", description: "Optional caption shown with the file (HTML formatting supported)." },
        filename: { type: "string", description: "Optional display name for the file (defaults to the file's basename)." },
        kind: {
          type: "string",
          enum: ["document", "photo", "audio", "voice"],
          description: "How to send it (default: document). 'document' = downloadable file (≤50 MB), 'photo' = inline image (≤10 MB; larger images must be sent as a document), 'audio'/'voice' = sound clip (≤50 MB).",
        },
        topic_id: { type: "string", description: "Telegram topic/thread ID (default: current topic)." },
      },
      required: ["path"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<MCPResponse>> = {
  async message_send({ text, topic_id, parse_mode = "HTML", buttons }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    const topicId = (topic_id as string) || TOPIC_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: stripCdataEnvelope(text),
      parse_mode: (parse_mode as string) || undefined,
    };
    if (topicId) body.message_thread_id = Number(topicId);
    if (buttons) {
      body.reply_markup = { inline_keyboard: buttons };
    }

    try {
      const result = await tgApi("sendMessage", body) as Record<string, unknown>;
      trackSentMessage(topicId, result.message_id);
      return ok(JSON.stringify({ message_id: result.message_id, sent: true }));
    } catch (err) {
      // Retry without parse_mode on formatting error
      if (parse_mode && (err as Error).message.includes("parse")) {
        delete body.parse_mode;
        const result = await tgApi("sendMessage", body) as Record<string, unknown>;
        trackSentMessage(topicId, result.message_id);
        return ok(JSON.stringify({ message_id: result.message_id, sent: true, parse_fallback: true }));
      }
      return error((err as Error).message);
    }
  },

  async message_buttons({ text, buttons: flatButtons, topic_id }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    const topicId = (topic_id as string) || TOPIC_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");
    if (typeof text !== "string" || !text.trim()) return error("message_buttons: text is required");
    if (!Array.isArray(flatButtons) || flatButtons.length === 0) return error("message_buttons: buttons must be a non-empty flat array");
    if (flatButtons.some((btn) => !btn || typeof btn !== "object" || Array.isArray(btn) || typeof (btn as Record<string, unknown>).text !== "string" || !(btn as Record<string, unknown>).text)) {
      return error("message_buttons: each button must be an object with non-empty text");
    }

    // Convert flat button list into rows
    const rows: InlineButton[][] = [[]];
    for (const btn of flatButtons as FlatButton[]) {
      if (btn.row_break && rows[rows.length - 1]!.length > 0) rows.push([]);
      const button: InlineButton = { text: btn.text };
      if (btn.url) button.url = btn.url;
      else if (btn.callback_data) button.callback_data = btn.callback_data;
      else button.callback_data = btn.text; // fallback
      rows[rows.length - 1]!.push(button);
    }

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: stripCdataEnvelope(text),
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    };
    if (topicId) body.message_thread_id = Number(topicId);

    try {
      const result = await tgApi("sendMessage", body) as Record<string, unknown>;
      trackSentMessage(topicId, result.message_id);
      return ok(JSON.stringify({ message_id: result.message_id, sent: true, rows: rows.length }));
    } catch (err) {
      return error((err as Error).message);
    }
  },

  async message_poll({ question, options, is_anonymous = false, type = "regular", correct_option_id, topic_id }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    const topicId = (topic_id as string) || TOPIC_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");
    const optionsArray = options as string[];
    if (!optionsArray || optionsArray.length < 2) return error("At least 2 options required");
    if (optionsArray.length > 10) return error("Maximum 10 options");

    const body: Record<string, unknown> = {
      chat_id: chatId,
      question,
      options: optionsArray.map((o) => ({ text: o })),
      is_anonymous,
      type,
    };
    if (topicId) body.message_thread_id = Number(topicId);
    if (type === "quiz" && correct_option_id != null) {
      body.correct_option_id = correct_option_id;
    }

    try {
      const result = await tgApi("sendPoll", body) as Record<string, unknown>;
      const poll = result.poll as Record<string, unknown> | undefined;
      trackSentMessage(topicId, result.message_id);
      return ok(JSON.stringify({ message_id: result.message_id, poll_id: poll?.id }));
    } catch (err) {
      return error((err as Error).message);
    }
  },

  async message_react({ message_id, emoji }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");

    try {
      await tgApi("setMessageReaction", {
        chat_id: chatId,
        message_id,
        reaction: [{ type: "emoji", emoji }],
      });
      return ok(`Reacted with ${emoji} to message ${message_id}`);
    } catch (err) {
      return error((err as Error).message);
    }
  },

  async message_typing({ topic_id, action = "typing" }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    const topicId = (topic_id as string) || TOPIC_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");

    const body: Record<string, unknown> = { chat_id: chatId, action };
    if (topicId) body.message_thread_id = Number(topicId);

    try {
      await tgApi("sendChatAction", body);
      return ok(`Sent '${action}' indicator`);
    } catch (err) {
      return error((err as Error).message);
    }
  },

  async message_edit({ message_id, text, parse_mode = "HTML", buttons }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");

    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id,
      text: stripCdataEnvelope(text),
      parse_mode: (parse_mode as string) || undefined,
    };
    if (buttons) {
      body.reply_markup = { inline_keyboard: buttons };
    }

    try {
      await tgApi("editMessageText", body);
      return ok(`Edited message ${message_id}`);
    } catch (err) {
      return error((err as Error).message);
    }
  },

  async message_document({ path, caption, filename, kind = "document", topic_id }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    const topicId = (topic_id as string) || TOPIC_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");

    const filePath = path as string;
    if (!filePath || typeof filePath !== "string") return error("path is required (absolute path to the file to send)");

    const k = (kind as string) || "document";
    const spec = KIND_SPEC[k];
    if (!spec) return error(`Unknown kind '${k}'. Use one of: ${Object.keys(KIND_SPEC).join(", ")}.`);

    // Path safety BEFORE touching the filesystem — reject anything outside the
    // agent's allowed directories so a crafted path can't read host files.
    if (!safeAbsPath(filePath, ALLOWED_FILE_DIRS())) {
      return error(`path is outside allowed directories (${ALLOWED_FILE_DIRS().join(", ")})`);
    }
    if (!existsSync(filePath)) return error(`File not found: ${filePath}`);

    // Re-check the CANONICAL path: safeAbsPath above is lexical-only, so a
    // symlink sitting inside an allowed dir could otherwise point readFileSync at
    // an out-of-bounds file (e.g. /root/.ssh/*, the Gmail token store). Resolving
    // symlinks here also collapses the stat→read TOCTOU window, since we stat and
    // read the exact path we validated.
    let realPath: string;
    try {
      realPath = realpathSync(filePath);
    } catch (err) {
      return error(`Cannot resolve file path: ${(err as Error).message}`);
    }
    // Compare canonical-to-canonical: the allowed bases may themselves traverse a
    // symlink (e.g. macOS /tmp → /private/tmp), so realpath them too before the
    // containment check, otherwise a legitimate file would be falsely rejected.
    const canonicalAllowed = ALLOWED_FILE_DIRS().map((d) => {
      try { return realpathSync(d); } catch { return d; }
    });
    if (!safeAbsPath(realPath, canonicalAllowed)) {
      return error(`path resolves (via symlink) outside allowed directories (${ALLOWED_FILE_DIRS().join(", ")})`);
    }

    let sizeBytes: number;
    try {
      const st = statSync(realPath);
      if (!st.isFile()) return error(`Not a regular file: ${filePath}`);
      sizeBytes = st.size;
    } catch (err) {
      return error(`Cannot stat file: ${(err as Error).message}`);
    }
    if (sizeBytes === 0) return error("File is empty (0 bytes) — nothing to send");
    if (sizeBytes > spec.maxBytes) {
      const hint = k === "photo" ? ' Send it with kind: "document" instead.' : "";
      return error(`File too large for ${k}: ${(sizeBytes / MB).toFixed(1)} MB (max ${(spec.maxBytes / MB).toFixed(0)} MB).${hint}`);
    }

    const displayName = (filename as string) || basename(filePath);

    // Build the upload Blob once — it's reusable across the parse-mode retry.
    // Wrap in a fresh Uint8Array: Buffer's ArrayBufferLike type isn't a valid
    // BlobPart under strict lib typings, but a plain Uint8Array view is.
    let fileBlob: Blob;
    try {
      fileBlob = new Blob([new Uint8Array(readFileSync(realPath))], { type: guessMime(displayName) });
    } catch (err) {
      return error(`Cannot read file: ${(err as Error).message}`);
    }

    const cap = caption != null ? stripCdataEnvelope(caption) : undefined;

    // Rebuild the form per attempt: a FormData body is a consumed stream, so the
    // parse-mode-fallback retry needs a fresh one (the Blob itself is reusable).
    const buildForm = (withParseMode: boolean): FormData => {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (topicId) form.set("message_thread_id", String(Number(topicId)));
      if (cap) {
        form.set("caption", cap);
        if (withParseMode) form.set("parse_mode", "HTML");
      }
      form.set(spec.field, fileBlob, displayName);
      return form;
    };

    try {
      let result: Record<string, unknown>;
      let parseFallback = false;
      try {
        result = await tgUpload(spec.method, buildForm(true)) as Record<string, unknown>;
      } catch (err) {
        // A bad HTML caption shouldn't lose the file — resend without parse_mode.
        if (cap && (err as Error).message.includes("parse")) {
          result = await tgUpload(spec.method, buildForm(false)) as Record<string, unknown>;
          parseFallback = true;
        } else {
          throw err;
        }
      }

      trackSentMessage(topicId, result.message_id);
      const fileId = spec.extractFileId(result);
      return ok(JSON.stringify({
        message_id: result.message_id,
        sent: true,
        kind: k,
        filename: displayName,
        size_bytes: sizeBytes,
        ...(fileId ? { file_id: fileId } : {}),
        ...(parseFallback ? { parse_fallback: true } : {}),
      }));
    } catch (err) {
      return error((err as Error).message);
    }
  },
};
