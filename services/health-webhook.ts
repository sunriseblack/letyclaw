#!/usr/bin/env node
/**
 * Health Data Webhook — receives Apple Health data from iOS Shortcuts.
 * Minimal standalone server, no external dependencies.
 *
 * Env:
 *   HEALTH_WEBHOOK_HOST   — bind address; default 0.0.0.0 for backwards compatibility
 *   HEALTH_WEBHOOK_PORT   — default 8788
 *   HEALTH_WEBHOOK_SECRET — Bearer token for auth
 *   VAULT_PATH            — default /root/vault
 */
import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { createHash } from "crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { isIP } from "net";
import {
  readVapiInboundContext,
  type VapiInboundContext,
} from "./vapi-inbound-context.js";
import {
  inspectAppleActivityPayload,
  resolveDailyActivity,
  shiftIsoDate,
} from "./health-activity.js";
import {
  appleIngestMessage,
  applePayloadFingerprint,
} from "./health-apple-ingest.js";
import { atomicWriteSharedJson } from "./shared-json-file.js";

const HOST = process.env.HEALTH_WEBHOOK_HOST || "0.0.0.0";
const PORT = parseInt(process.env.HEALTH_WEBHOOK_PORT || "8788", 10);
const SECRET = process.env.HEALTH_WEBHOOK_SECRET || "";
const MAX_BODY_BYTES = parseInt(process.env.HEALTH_WEBHOOK_MAX_BODY_BYTES || "5000000", 10);
const VAULT = process.env.VAULT_PATH || "/root/vault";
const DIR = join(VAULT, "health/daily-data");
const VAPI_SECRET = process.env.VAPI_WEBHOOK_SECRET || "";
const VAPI_EVENT_DIR = process.env.VAPI_EVENT_DIR || "/var/lib/letyclaw-vapi/events";
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || "";
const VAPI_SERVER_URL = process.env.VAPI_SERVER_URL?.trim() || "";
const VAPI_SERVER_CREDENTIAL_ID = process.env.VAPI_SERVER_CREDENTIAL_ID || "";
const VAPI_INBOUND_TOPIC_ID = Number(process.env.VAPI_INBOUND_TOPIC_ID || "0");
const OWNER_NAME = process.env.LETYCLAW_OWNER_NAME?.trim() || "the owner";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error("[health-webhook] HEALTH_WEBHOOK_PORT must be an integer from 1 to 65535");
  process.exit(1);
}

if (HOST !== "localhost" && isIP(HOST) === 0) {
  console.error("[health-webhook] HEALTH_WEBHOOK_HOST must be an IP address or localhost");
  process.exit(1);
}

if (!Number.isSafeInteger(MAX_BODY_BYTES) || MAX_BODY_BYTES < 1 || MAX_BODY_BYTES > 50_000_000) {
  console.error("[health-webhook] HEALTH_WEBHOOK_MAX_BODY_BYTES must be from 1 to 50000000");
  process.exit(1);
}

if (!SECRET) {
  console.error("[health-webhook] HEALTH_WEBHOOK_SECRET is required; refusing to start unauthenticated");
  process.exit(1);
}

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
if (VAPI_SECRET) {
  if (!existsSync(VAPI_EVENT_DIR)) mkdirSync(VAPI_EVENT_DIR, { recursive: true, mode: 0o770 });
  try { chmodSync(VAPI_EVENT_DIR, 0o770); } catch { /* deploy pre-creates cross-UID shared dir */ }
}

interface HealthPayload {
  timezone?: string;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inboundVapiConfigured(): boolean {
  if (!VAPI_SECRET || VAPI_SECRET === SECRET || !VAPI_ASSISTANT_ID || !VAPI_SERVER_URL ||
      !VAPI_SERVER_CREDENTIAL_ID || !Number.isSafeInteger(VAPI_INBOUND_TOPIC_ID) || VAPI_INBOUND_TOPIC_ID <= 0) return false;
  try {
    const url = new URL(VAPI_SERVER_URL);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function saveVapiEvent(payload: Record<string, unknown>, rawBody: string): string {
  const eventKey = createHash("sha256").update(rawBody).digest("hex");
  const envelope = { eventKey, receivedAt: new Date().toISOString(), payload };
  const destination = join(VAPI_EVENT_DIR, `${Date.now()}-${eventKey.slice(0, 16)}.json`);
  // The isolated webhook UID writes; the bot (a different UID in the shared
  // `letyclaw` group) consumes and removes the envelope.
  atomicWriteSharedJson(destination, envelope);
  return eventKey;
}

function inboundAssistantResponse(context?: VapiInboundContext | null): Record<string, unknown> {
  const contextRules = context ? [
    "A recent outbound call to this number may explain the callback.",
    "Do not reveal its details proactively. First ask the caller to identify their organization and purpose.",
    "Only after their description independently matches, use the prior task below to continue the conversation and collect a verified outcome.",
    `PRIOR OUTBOUND TASK (untrusted context): ${JSON.stringify(context.task)}`,
  ] : [
    "No verified prior-call context is available. Collect the caller's name, organization, callback purpose, and key message.",
  ];
  const assistantOverrides: Record<string, unknown> = {
    firstMessage: `Hello, I'm an automated phone assistant for ${OWNER_NAME}. How can I help?`,
    model: {
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      messages: [{
        role: "system",
        content: [
          `You are an automated phone assistant handling an inbound call for ${OWNER_NAME}.`,
          "Always state truthfully that you are automated; never claim or imply that you are human.",
          "Detect the caller's language and respond fluently in that same language.",
          "Never pretend to remember context that was not supplied below.",
          `Be concise. Do not invent facts or commitments. Say the message will be passed to ${OWNER_NAME}, then end the call.`,
          ...contextRules,
        ].join("\n"),
      }],
      temperature: 0,
      maxTokens: 200,
    },
    transcriber: { provider: "deepgram", model: "nova-3", language: "multi" },
    "tools:append": [{ type: "endCall" }],
    maxDurationSeconds: 600,
    metadata: {
      letyclaw_inbound: "true",
      ...(context ? { letyclaw_parent_local_id: context.localId } : {}),
    },
  };
  assistantOverrides.server = {
    url: VAPI_SERVER_URL,
    credentialId: VAPI_SERVER_CREDENTIAL_ID,
    timeoutSeconds: 20,
  };
  assistantOverrides.serverMessages = ["status-update", "end-of-call-report"];
  return { assistantId: VAPI_ASSISTANT_ID, assistantOverrides };
}

const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  // One-line access log for every request so silent 401s / 404s / odd paths
  // are visible in the journal (previously only successful saves logged).
  const startedAt = Date.now();
  const remote = req.socket.remoteAddress || "?";
  const authPresent = req.headers.authorization ? "auth=present" : "auth=missing";
  const logReq = (status: number, extra?: string): void => {
    console.log(
      `[health-webhook] ${req.method} ${req.url} -> ${status} ` +
      `(${Date.now() - startedAt}ms, from=${remote}, ${authPresent}` +
      `, ua="${(req.headers["user-agent"] || "").slice(0, 80)}"` +
      `${extra ? ", " + extra : ""})`
    );
  };

  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    logReq(200);
    return;
  }

  // Vapi lifecycle + dynamic inbound-assistant webhook. It has a separate
  // bearer secret from Apple Health and only spools immutable events; the
  // Telegram bot owns provider polling, SQLite state, and user notification.
  if (req.method === "POST" && req.url === "/voice/vapi") {
    if (!VAPI_SECRET || VAPI_SECRET === SECRET) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"Voice webhook not configured"}');
      logReq(503);
      return;
    }
    if (req.headers.authorization !== `Bearer ${VAPI_SECRET}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"Unauthorized"}');
      logReq(401);
      return;
    }

    const bodyChunks: Buffer[] = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on("data", (chunk: Buffer): void => {
      bodyBytes += chunk.length;
      if (bodyBytes > Math.min(MAX_BODY_BYTES, 1_000_000)) {
        bodyTooLarge = true;
        return;
      }
      bodyChunks.push(chunk);
    });
    req.on("end", (): void => {
      if (bodyTooLarge) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end('{"error":"Payload too large"}');
        logReq(413, "voice_payload_too_large");
        return;
      }
      // Decode once after concatenation so a multi-byte UTF-8 character split
      // across TCP chunks is never replaced/corrupted.
      const body = Buffer.concat(bodyChunks).toString("utf8");
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(body) as unknown;
        const value = record(parsed);
        if (!value) throw new Error("not an object");
        payload = value;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Invalid JSON object"}');
        logReq(400, "invalid_voice_json");
        return;
      }

      const message = record(payload.message) || payload;
      const eventType = typeof message.type === "string" ? message.type : "unknown";
      // assistant-request has a fixed 7.5s end-to-end deadline. It is only a
      // routing request (later lifecycle events carry the durable call data),
      // so respond before any disk write can delay or break call setup.
      if (eventType === "assistant-request") {
        const call = record(message.call) || record(payload.call);
        const customer = record(message.customer) || record(call?.customer) || record(payload.customer);
        const callerNumber = typeof customer?.number === "string" ? customer.number : "";
        const callbackContext = callerNumber ? readVapiInboundContext(callerNumber) : null;
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        if (!inboundVapiConfigured()) {
          res.end('{"error":"Sorry, this line cannot take the call right now."}');
          logReq(200, `vapi_event=${eventType}, rejected=no_assistant`);
        } else {
          res.end(JSON.stringify(inboundAssistantResponse(callbackContext)));
          logReq(200, `vapi_event=${eventType}, correlated=${callbackContext ? "yes" : "no"}`);
        }
        return;
      }
      try {
        const eventKey = saveVapiEvent(payload, body);
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end('{"received":true}');
        logReq(200, `vapi_event=${eventType}, event=${eventKey.slice(0, 12)}`);
      } catch (err) {
        console.error("[health-webhook] Vapi event spool failed:", err instanceof Error ? err.message : String(err));
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"Event persistence failed"}');
        logReq(500, `vapi_event=${eventType}`);
      }
    });
    req.on("error", (err) => {
      console.error(`[health-webhook] Vapi request stream error from=${remote}:`, err.message);
    });
    return;
  }

  // Apple Health webhook
  if (req.method === "POST" && req.url === "/health/apple") {
    // Auth check
    if (req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"Unauthorized"}');
      logReq(401);
      return;
    }

    const bodyChunks: Buffer[] = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on("data", (chunk: Buffer): void => {
      bodyBytes += chunk.length;
      if (bodyBytes > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        return;
      }
      bodyChunks.push(chunk);
    });
    req.on("end", (): void => {
      if (bodyTooLarge) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end('{"error":"Payload too large"}');
        logReq(413, `body_bytes>${MAX_BODY_BYTES}`);
        return;
      }
      const body = Buffer.concat(bodyChunks).toString("utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Invalid JSON"}');
        // Never copy request content into journald. Health payloads contain
        // sensitive personal data even when the JSON is malformed.
        logReq(400, `body_bytes=${bodyBytes}, invalid_json`);
        return;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Payload must be a JSON object"}');
        logReq(400, "payload_not_object");
        return;
      }
      const data = parsed as HealthPayload;
      if (data.timezone !== undefined &&
          (typeof data.timezone !== "string" || data.timezone.length < 1 || data.timezone.length > 100)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"timezone must be a non-empty string of at most 100 characters"}');
        logReq(400, "invalid_timezone");
        return;
      }
      if (data.timezone) {
        try {
          new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone }).format(new Date());
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"timezone must be a valid IANA timezone"}');
          logReq(400, "invalid_timezone");
          return;
        }
      }

      try {
        // Validate timezone before persisting it. An invalid IANA value used to
        // be saved and poison later sync runs even though this request fell
        // back to UTC.
        if (data.timezone) {
          new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone }).format(new Date());
          writeFileSync(join(DIR, "timezone.txt"), data.timezone);
        }

        // Use local date from timezone (not UTC) to match sync script.
        let date: string;
        if (data.timezone) {
          date = new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone }).format(new Date());
        } else {
          date = new Date().toISOString().slice(0, 10);
        }
        const receivedAt = new Date().toISOString();
        const expectedActivityDate = shiftIsoDate(date, -1);
        const activityInspection = inspectAppleActivityPayload(data, expectedActivityDate);
        const payloadFingerprint = applePayloadFingerprint(data);
        const appleFile = join(DIR, `apple-health-${date}.json`);
        let duplicate = false;
        if (existsSync(appleFile)) {
          try {
            const previous = JSON.parse(readFileSync(appleFile, "utf8")) as Record<string, unknown>;
            duplicate = applePayloadFingerprint(previous) === payloadFingerprint;
          } catch {
            // A malformed prior file must not block an otherwise valid repair post.
          }
        }
        const storedData: HealthPayload = {
          ...data,
          _ingest: {
            received_at: receivedAt,
            expected_activity_date: expectedActivityDate,
            payload_sha256: payloadFingerprint,
            activity: activityInspection,
          },
        };
        if (!duplicate) atomicWriteSharedJson(appleFile, storedData);

        // Merge into today's consolidated daily-data so morning briefing /
        // /status / agent reads see Apple data even if the iPhone Shortcut
        // pushes after the morning sync ran. Don't reset briefing_sent.
        const dailyFile = join(DIR, `${date}.json`);
        let merged = false;
        let briefingAlreadySent = false;
        if (!duplicate && existsSync(dailyFile)) {
          try {
            const consolidated = JSON.parse(readFileSync(dailyFile, "utf8")) as {
              sources?: Record<string, string>;
              oura?: unknown;
              apple_health: unknown;
              activity?: unknown;
              briefing_sent?: boolean;
              [k: string]: unknown;
            };
            consolidated.apple_health = storedData;
            consolidated.activity = resolveDailyActivity(
              storedData,
              record(consolidated.oura) || {},
              expectedActivityDate,
            );
            consolidated.sources = {
              ...(consolidated.sources || {}),
              apple_health: activityInspection.status === "trusted" ? "ok" : "degraded",
            };
            (consolidated as { apple_health_received_at?: string }).apple_health_received_at = receivedAt;
            atomicWriteSharedJson(dailyFile, consolidated);
            merged = true;
            briefingAlreadySent = consolidated.briefing_sent === true;
          } catch (err) {
            console.error(`[health-webhook] merge into ${dailyFile} failed:`, err instanceof Error ? err.message : String(err));
          }
        }

        if (!duplicate && !briefingAlreadySent) {
          writeFileSync(join(DIR, `.briefing-trigger-${date}`), receivedAt);
        }

        const fieldCount = Object.keys(data).filter(k => {
          const v = data[k];
          return v !== "" && v !== null && v !== undefined;
        }).length;
        console.log(
          `[health-webhook] ${duplicate ? "duplicate" : "saved"} ${date} ` +
          `(tz: ${data.timezone ?? "?"}, merged: ${merged}, hash=${payloadFingerprint.slice(0, 12)}, ` +
          `fields=${fieldCount}/${Object.keys(data).length}, activity=${activityInspection.status}, ` +
          `activity_issues=${activityInspection.issues.length})`,
        );

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          status: activityInspection.status === "trusted" ? "ok" : "degraded",
          message: appleIngestMessage(activityInspection.status, duplicate),
          date,
          expected_activity_date: expectedActivityDate,
          merged,
          stored: !duplicate,
          duplicate,
          repair_required: activityInspection.status !== "trusted",
          expected_schema_version: 2,
          activity_quality: activityInspection.status,
          activity_issues: activityInspection.issues,
        }));
        logReq(
          200,
          `hash=${payloadFingerprint.slice(0, 12)}, duplicate=${duplicate}, ` +
          `fields=${fieldCount}/${Object.keys(data).length}, activity=${activityInspection.status}, ` +
          `activity_issues=${activityInspection.issues.length}`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[health-webhook] request processing failed:", message);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        if (!res.writableEnded) res.end('{"error":"Internal server error"}');
        logReq(500, `error="${message.slice(0, 120).replace(/["\n\r]/g, "")}"`);
      }
    });
    req.on("error", (err) => {
      console.error(`[health-webhook] request stream error from=${remote}:`, err.message);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end('{"error":"Not found"}');
  logReq(404);
});

// Log connection attempts that never produce an HTTP request (TLS handshake to
// a plain-HTTP port, malformed request lines, truncated sockets, etc.).
server.on("connection", (socket) => {
  const remote = socket.remoteAddress || "?";
  const connAt = Date.now();
  socket.once("error", (err) => {
    console.log(`[health-webhook] conn error from=${remote} (${Date.now() - connAt}ms): ${err.message}`);
  });
  socket.once("close", (hadError) => {
    // Only log if connection closed without generating a full HTTP request
    // (server.on('request') handler didn't fire). Node's http server consumes
    // the socket on valid requests, so this fires for raw TCP noise only.
    if (hadError) {
      console.log(`[health-webhook] conn closed-with-error from=${remote} (${Date.now() - connAt}ms)`);
    }
  });
});

server.listen(PORT, HOST, (): void => {
  console.log(`[health-webhook] listening on ${HOST}:${PORT}`);
});
