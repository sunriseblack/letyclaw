/**
 * Messaging tools — Rich Telegram messaging via Bot API.
 *
 * Provides inline keyboards, polls, reactions, typing indicators, message editing.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID env vars.
 */

import { ok, error, TOPIC as TOPIC_ID } from "./_util.js";
import type { MCPToolDefinition, MCPResponse } from "../types.js";

const BOT_TOKEN = (): string => process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID = (): string => process.env.LETYCLAW_CHAT_ID || process.env.TELEGRAM_CHAT_ID || "";

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
];

// ── Handlers ──────────────────────────────────────────────────────────

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<MCPResponse>> = {
  async message_send({ text, topic_id, parse_mode = "HTML", buttons }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    const topicId = (topic_id as string) || TOPIC_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");

    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: (parse_mode as string) || undefined,
    };
    if (topicId) body.message_thread_id = Number(topicId);
    if (buttons) {
      body.reply_markup = { inline_keyboard: buttons };
    }

    try {
      const result = await tgApi("sendMessage", body) as Record<string, unknown>;
      return ok(JSON.stringify({ message_id: result.message_id, sent: true }));
    } catch (err) {
      // Retry without parse_mode on formatting error
      if (parse_mode && (err as Error).message.includes("parse")) {
        delete body.parse_mode;
        const result = await tgApi("sendMessage", body) as Record<string, unknown>;
        return ok(JSON.stringify({ message_id: result.message_id, sent: true, parse_fallback: true }));
      }
      return error((err as Error).message);
    }
  },

  async message_buttons({ text, buttons: flatButtons, topic_id }: Record<string, unknown>): Promise<MCPResponse> {
    const chatId = CHAT_ID();
    const topicId = (topic_id as string) || TOPIC_ID();
    if (!chatId) return error("TELEGRAM_CHAT_ID not set");

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
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: rows },
    };
    if (topicId) body.message_thread_id = Number(topicId);

    try {
      const result = await tgApi("sendMessage", body) as Record<string, unknown>;
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
      text,
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
};
