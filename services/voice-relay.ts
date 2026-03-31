#!/usr/bin/env node
/**
 * Voice Relay Server — bridges Twilio ConversationRelay <-> Claude API.
 *
 * Twilio handles STT (Deepgram) and TTS (Google/ElevenLabs).
 * This server receives transcribed text via WebSocket, sends it to
 * Claude API with streaming, and returns text tokens for Twilio to speak.
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY     — Claude API key (required)
 *   VOICE_RELAY_PORT      — Port to listen on (default: 8787)
 *   VOICE_DB_PATH         — SQLite database path
 *   VOICE_DEFAULT_MODEL   — Default Claude model (default: claude-haiku-4-5)
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages.js";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  getDb,
  getCall,
  updateCallStatus,
  appendTranscript,
} from "./voice-db.js";
import type { CallRow } from "./voice-db.js";

const PORT = parseInt(process.env.VOICE_RELAY_PORT || "8787", 10);
const DEFAULT_MODEL = process.env.VOICE_DEFAULT_MODEL || "claude-haiku-4-5";

// ── Anthropic client ────────────────────────────────────────────────

const anthropic = new Anthropic();  // reads ANTHROPIC_API_KEY from env

// ── Active call state (in-memory, per WebSocket connection) ─────────

interface CallState {
  systemPrompt: string;
  model: string;
  history: MessageParam[];
  abortController: AbortController | null;
}

const activeCalls = new Map<string, CallState>();

// ── Twilio ConversationRelay message types ──────────────────────────

interface SetupMessage {
  type: "setup";
  callSid: string;
}

interface PromptMessage {
  type: "prompt";
  voiceInput: string;
}

interface InterruptMessage {
  type: "interrupt";
}

interface DtmfMessage {
  type: "dtmf";
  digit: string;
}

type TwilioMessage = SetupMessage | PromptMessage | InterruptMessage | DtmfMessage | { type: string };

// ── Build system prompt ─────────────────────────────────────────────

function buildSystemPrompt(call: CallRow): string {
  const callerLine = call.caller_name
    ? `You are making a phone call on behalf of ${call.caller_name}.`
    : "You are making a phone call.";

  return `${callerLine}

Your task: ${call.task}

Rules for phone conversations:
- Speak naturally in short sentences suitable for voice conversation
- Do not use markdown, bullet points, numbered lists, or any text formatting
- Do not use asterisks, hashes, dashes for emphasis or structure
- Keep responses concise — phone conversations use short turns
- Listen carefully and respond to what the person says
- When your task is complete, say goodbye naturally and politely
- If asked who you are, say you are calling on behalf of ${call.caller_name || "the person who asked you to call"}
- If the conversation goes off-topic, politely redirect to your task
- If you cannot complete the task, explain why briefly and end the call politely
- Never agree to anything beyond the scope of your task`;
}

// ── Stream Claude response ──────────────────────────────────────────

async function streamClaude(callSid: string, ws: WebSocket, model: string): Promise<void> {
  const state = activeCalls.get(callSid);
  if (!state) return;

  const controller = new AbortController();
  state.abortController = controller;

  let fullResponse = "";

  try {
    const stream = anthropic.messages.stream({
      model: model || DEFAULT_MODEL,
      max_tokens: 300,  // short turns for voice
      system: state.systemPrompt,
      messages: state.history,
    }, { signal: controller.signal });

    for await (const event of stream) {
      // Check if aborted (interruption)
      if (controller.signal.aborted) break;

      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        const token = event.delta.text;
        fullResponse += token;

        // Stream each token to Twilio for immediate TTS
        ws.send(JSON.stringify({
          type: "text",
          token,
          last: false,
        }));
      }
    }

    // Signal end of response (unless interrupted)
    if (!controller.signal.aborted) {
      ws.send(JSON.stringify({
        type: "text",
        token: "",
        last: true,
      }));
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      // Expected on interruption — not an error
      console.log(`[voice-relay] ${callSid} — Claude stream interrupted`);
    } else {
      console.error(`[voice-relay] ${callSid} — Claude error:`, err instanceof Error ? err.message : String(err));
      // Try to say something graceful on error
      try {
        ws.send(JSON.stringify({
          type: "text",
          token: "I'm sorry, I'm having a technical issue. Could you repeat that?",
          last: true,
        }));
      } catch { /* ignore */ }
    }
  } finally {
    state.abortController = null;
  }

  // Record assistant response
  if (fullResponse) {
    state.history.push({ role: "assistant", content: fullResponse });
    appendTranscript(callSid, "assistant", fullResponse);
  }
}

// ── Fastify server ──────────────────────────────────────────────────

const app = Fastify({ logger: false });
await app.register(fastifyWebsocket);

// Health check
app.get("/health", async (): Promise<{ status: string; activeCalls: number }> => {
  return { status: "ok", activeCalls: activeCalls.size };
});

// WebSocket endpoint for Twilio ConversationRelay
app.register(async function (fastify) {
  fastify.get("/ws", { websocket: true }, (socket, _req) => {
    let callSid: string | null = null;
    let maxDurationTimer: ReturnType<typeof setTimeout> | null = null;

    console.log("[voice-relay] WebSocket connection opened");

    socket.on("message", async (raw: Buffer): Promise<void> => {
      let message: TwilioMessage;
      try {
        message = JSON.parse(raw.toString()) as TwilioMessage;
      } catch {
        console.error("[voice-relay] Invalid JSON:", raw.toString().slice(0, 100));
        return;
      }

      switch (message.type) {
        case "setup": {
          callSid = (message as SetupMessage).callSid;
          console.log(`[voice-relay] ${callSid} — setup`);

          // Load call record from SQLite
          const call = getCall(callSid);
          if (!call) {
            console.error(`[voice-relay] ${callSid} — no call record found in DB`);
            socket.close();
            return;
          }

          const systemPrompt = call.system_prompt || buildSystemPrompt(call);

          // Initialize conversation state
          activeCalls.set(callSid, {
            systemPrompt,
            model: call.model || DEFAULT_MODEL,
            history: [],
            abortController: null,
          });

          updateCallStatus(callSid, "connected");

          // Set max duration timer
          const maxSec = call.max_duration_seconds || 300;
          maxDurationTimer = setTimeout((): void => {
            console.log(`[voice-relay] ${callSid} — max duration reached (${maxSec}s)`);
            try {
              socket.send(JSON.stringify({
                type: "text",
                token: "I need to end this call now. Thank you for your time. Goodbye.",
                last: true,
              }));
              // Give TTS time to finish, then close
              setTimeout((): void => { socket.close(); }, 5000);
            } catch { /* ignore */ }
          }, maxSec * 1000);

          // Send first sentence if configured
          if (call.system_prompt && call.system_prompt.includes("first_sentence:")) {
            // first_sentence is handled by ConversationRelay config, not here
          }

          break;
        }

        case "prompt": {
          if (!callSid) return;
          const userText = (message as PromptMessage).voiceInput;
          if (!userText?.trim()) return;

          console.log(`[voice-relay] ${callSid} — user: ${userText.slice(0, 80)}`);

          const state = activeCalls.get(callSid);
          if (!state) return;

          // Add user message to history
          state.history.push({ role: "user", content: userText });
          appendTranscript(callSid, "user", userText);

          // Stream Claude's response
          await streamClaude(callSid, socket, state.model);
          break;
        }

        case "interrupt": {
          if (!callSid) return;
          console.log(`[voice-relay] ${callSid} — interrupted`);

          const state = activeCalls.get(callSid);
          if (state?.abortController) {
            state.abortController.abort();
          }
          break;
        }

        case "dtmf": {
          // Caller pressed a keypad button — log but ignore for now
          console.log(`[voice-relay] ${callSid} — DTMF: ${(message as DtmfMessage).digit}`);
          break;
        }

        default:
          console.log(`[voice-relay] ${callSid} — unknown message type: ${message.type}`);
      }
    });

    socket.on("close", (): void => {
      console.log(`[voice-relay] ${callSid ?? "unknown"} — WebSocket closed`);
      if (maxDurationTimer) clearTimeout(maxDurationTimer);

      if (callSid) {
        const state = activeCalls.get(callSid);
        if (state?.abortController) state.abortController.abort();
        activeCalls.delete(callSid);

        // Mark call as completed
        const call = getCall(callSid);
        if (call && call.status === "connected") {
          const durationSec = call.connected_at
            ? Math.round((Date.now() - call.connected_at) / 1000)
            : 0;
          updateCallStatus(callSid, "completed", { duration_seconds: durationSec });
        }
      }
    });

    socket.on("error", (err: Error): void => {
      console.error(`[voice-relay] ${callSid ?? "unknown"} — WebSocket error:`, err.message);
    });
  });
});

// ── Start ───────────────────────────────────────────────────────────

// Ensure DB is initialized
getDb();

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[voice-relay] listening on port ${PORT}`);
console.log(`[voice-relay] model: ${DEFAULT_MODEL}`);
