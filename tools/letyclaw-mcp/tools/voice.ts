/**
 * Voice call tools — Initiate and monitor AI-powered phone calls via Vapi.
 *
 * Vapi handles STT (Deepgram), LLM (Claude), and TTS.
 * No self-hosted relay server needed.
 *
 * Requires:
 *   - VAPI_API_KEY
 *   - VAPI_PHONE_NUMBER_ID (provisioned Vapi phone number)
 *   - VAPI_ASSISTANT_ID (default assistant, can be overridden per call)
 */

import type { MCPToolDefinition, MCPHandler, MCPResponse } from "../types.js";
import { ok, error } from "./_util.js";

const VAPI_KEY = (): string => process.env.VAPI_API_KEY || "";
const VAPI_PHONE_ID = (): string => process.env.VAPI_PHONE_NUMBER_ID || "";
const VAPI_ASSISTANT_ID = (): string => process.env.VAPI_ASSISTANT_ID || "";
const VAPI_BASE = "https://api.vapi.ai";

// ── Tool definitions ──────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "voice_call",
    description:
      "Make an AI-powered phone call. Claude handles the conversation based on the task you provide. Returns a call_id to check status with voice_call_status. The call uses Vapi (Deepgram STT + Claude LLM + TTS).",
    inputSchema: {
      type: "object",
      properties: {
        phone_number: {
          type: "string",
          description: "Phone number in E.164 format (e.g. +14155551234, +380501234567)",
        },
        task: {
          type: "string",
          description:
            "What Claude should accomplish on the call. Be specific: the goal, key info to convey, questions to ask. This becomes the system prompt.",
        },
        caller_name: {
          type: "string",
          description: "Name on whose behalf Claude is calling (default: the owner)",
        },
        first_message: {
          type: "string",
          description: "Opening sentence when call connects (optional)",
        },
        language: {
          type: "string",
          description: "Language for STT (default: multi). Examples: en, es, uk, ru, fr, de",
        },
        max_duration_minutes: {
          type: "number",
          description: "Maximum call duration in minutes (default: 10, max: 30)",
        },
      },
      required: ["phone_number", "task"],
    },
  },
  {
    name: "voice_call_status",
    description:
      "Check the status of a voice call. Returns status, transcript, duration, cost, and recording URL. Use the call_id from voice_call.",
    inputSchema: {
      type: "object",
      properties: {
        call_id: {
          type: "string",
          description: "The call_id returned by voice_call",
        },
      },
      required: ["call_id"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

export const handlers: Record<string, MCPHandler> = {
  async voice_call(args: Record<string, unknown>): Promise<MCPResponse> {
    const phone_number = args.phone_number as string;
    const task = args.task as string;
    const caller_name = (args.caller_name as string | undefined) ?? "the owner";
    const first_message = args.first_message as string | undefined;
    const language = (args.language as string | undefined) ?? "multi";
    const max_duration_minutes = (args.max_duration_minutes as number | undefined) ?? 10;

    const apiKey = VAPI_KEY();
    if (!apiKey) return error("VAPI_API_KEY not set.");

    const phoneNumberId = VAPI_PHONE_ID();
    if (!phoneNumberId) return error("VAPI_PHONE_NUMBER_ID not set.");

    if (!phone_number) return error("phone_number is required (E.164 format)");
    if (!/^\+\d{7,15}$/.test(phone_number)) return error("phone_number must be E.164 format: + followed by 7-15 digits");
    if (!task) return error("task is required");

    const maxSec = Math.min(Math.max(1, max_duration_minutes), 30) * 60;

    const systemPrompt = `You are making a phone call on behalf of ${caller_name}.

Your task: ${task}

Rules:
- Speak naturally in short sentences suitable for voice conversation
- Do not use markdown, bullet points, or any text formatting
- Keep responses concise — phone conversations use short turns
- Listen carefully and respond to what the person says
- When your task is complete, say goodbye naturally
- If asked who you are, say you are calling on behalf of ${caller_name}`;

    const body: Record<string, unknown> = {
      phoneNumberId,
      customer: { number: phone_number },
      assistantOverrides: {
        model: {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          messages: [{ role: "system", content: systemPrompt }],
          temperature: 0,
          maxTokens: 250,
        },
        transcriber: {
          provider: "deepgram",
          model: "nova-3",
          language,
        },
        maxDurationSeconds: maxSec,
        ...(first_message ? { firstMessage: first_message } : {}),
      },
    };

    // Use default assistant as base
    const assistantId = VAPI_ASSISTANT_ID();
    if (assistantId) body.assistantId = assistantId;

    try {
      const res = await fetch(`${VAPI_BASE}/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json() as unknown;
      const respBody = data as Record<string, unknown>;

      if (!res.ok) {
        const msg = respBody.message || respBody.error || res.statusText;
        return error(`Vapi API error (${res.status}): ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      }

      return ok(JSON.stringify({
        call_id: respBody.id,
        status: respBody.status,
        phone_number,
        tip: "Use voice_call_status with this call_id to check progress and get the transcript.",
      }, null, 2));
    } catch (err) {
      return error(`voice_call failed: ${(err as Error).message}`);
    }
  },

  async voice_call_status(args: Record<string, unknown>): Promise<MCPResponse> {
    const call_id = args.call_id as string;
    if (!call_id) return error("call_id is required");

    const apiKey = VAPI_KEY();
    if (!apiKey) return error("VAPI_API_KEY not set.");

    try {
      const res = await fetch(`${VAPI_BASE}/call/${call_id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      const data = await res.json() as unknown;
      const respBody = data as Record<string, unknown>;

      if (!res.ok) {
        const msg = respBody.message || respBody.error || res.statusText;
        return error(`Vapi API error (${res.status}): ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      }

      const customer = respBody.customer as Record<string, unknown> | undefined;
      const artifact = respBody.artifact as Record<string, unknown> | undefined;
      const messages = artifact?.messages as Array<Record<string, unknown>> | undefined;

      const startedAt = respBody.startedAt as string | undefined;
      const endedAt = respBody.endedAt as string | undefined;

      const result: Record<string, unknown> = {
        call_id: respBody.id,
        status: respBody.status,
        phone_number: customer?.number,
        started_at: startedAt,
        ended_at: endedAt,
        ended_reason: respBody.endedReason,
        duration_seconds: startedAt && endedAt
          ? Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000)
          : undefined,
        cost: respBody.cost,
        transcript: artifact?.transcript,
        recording_url: artifact?.recordingUrl,
        messages: messages
          ?.filter((m) => m.role === "user" || m.role === "bot")
          .map((m) => ({ role: m.role, text: m.message || m.content })),
      };

      // Remove undefined fields
      for (const key of Object.keys(result)) {
        if (result[key] === undefined) delete result[key];
      }

      return ok(JSON.stringify(result, null, 2));
    } catch (err) {
      return error(`voice_call_status failed: ${(err as Error).message}`);
    }
  },
};
