import { createHash } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import {
  applyVapiCallSnapshot,
  claimVapiNotification,
  completeVapiNotification,
  createVapiCall,
  deferVapiPoll,
  deferVapiNotification,
  getVapiCall,
  isTerminalVapiState,
  listVapiCallsNeedingWork,
  markVapiCallFailed,
  markVapiEventProcessed,
  recordVapiEvent,
  type VapiCallRow,
} from "./vapi-call-store.js";
import {
  fetchVapiCallStatus,
  vapiSnapshotFromPayload,
  vapiCallHasFinalArtifact,
  VapiHttpError,
} from "../tools/letyclaw-mcp/tools/voice.js";

export interface SpoolEnvelope {
  eventKey?: string;
  receivedAt?: string;
  payload: Record<string, unknown>;
}

export interface VoiceCallMonitorOptions {
  eventDir?: string;
  intervalMs?: number;
  notify: (call: VapiCallRow, claimToken: string) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
  fetchCall?: typeof fetchVapiCallStatus;
}

export interface VoiceCallMonitor {
  tick(): Promise<void>;
  stop(): void;
  drain(): Promise<void>;
}

function retryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function providerTimestamp(value: unknown, fallback?: string): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return nonempty(value) || fallback;
}

function providerSnapshotIsTerminal(snapshot: { providerStatus?: string; state?: string }): boolean {
  return snapshot.providerStatus === "ended" || snapshot.providerStatus === "not-found" ||
    snapshot.providerStatus === "deletion-failed" || snapshot.state === "ended" || snapshot.state === "failed";
}

const FINAL_REPORT_GRACE_MS = 90_000;

function awaitingReportGraceRemaining(call: VapiCallRow, now = Date.now()): number | null {
  if (call.state !== "awaiting-report" || call.provider_status !== "ended") return null;
  const observedAt = call.terminal_observed_at ?? call.updated_at;
  return Math.max(0, observedAt + FINAL_REPORT_GRACE_MS - now);
}

function finalizeProvenEndedCall(call: VapiCallRow): void {
  applyVapiCallSnapshot({
    providerCallId: call.provider_call_id!,
    providerStatus: "ended",
    state: "ended",
  }, call.local_id);
}

function callPollingDeadlineExceeded(call: VapiCallRow, now = Date.now()): boolean {
  const origin = call.started_at ?? call.created_at;
  return now >= origin + call.max_duration_seconds * 1_000 + 5 * 60_000;
}

function defaultEventDir(): string {
  const sessions = process.env.LETYCLAW_SESSIONS_DIR || process.env.SESSIONS_DIR || "/root/letyclaw/sessions";
  return process.env.VAPI_EVENT_DIR || join(sessions, ".voice-events");
}

function eventMessage(payload: Record<string, unknown>): Record<string, unknown> {
  return record(payload.message) || payload;
}

function eventCall(message: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(message.call);
}

function callMetadata(call: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(record(call.assistantOverrides)?.metadata) || record(call.metadata);
}

function localIdFromCall(call: Record<string, unknown>): string | undefined {
  const metadataId = nonempty(callMetadata(call)?.letyclaw_local_call_id);
  if (metadataId) return metadataId;
  const name = nonempty(call.name);
  const prefix = "letyclaw-";
  return name?.startsWith(prefix) ? name.slice(prefix.length) : undefined;
}

function isInboundCall(call: Record<string, unknown>): boolean {
  const type = nonempty(call.type)?.toLowerCase() || "";
  return type.includes("inbound");
}

function inboundLocalId(providerCallId: string): string {
  return `inbound-${providerCallId}`.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 128);
}

function ensureCallForEvent(call: Record<string, unknown>, providerCallId: string): VapiCallRow | null {
  const explicitLocalId = localIdFromCall(call);
  const existing = getVapiCall(explicitLocalId || providerCallId);
  if (existing) return existing;
  if (!isInboundCall(call)) return null;

  const topicId = Number(process.env.VAPI_INBOUND_TOPIC_ID || process.env.LETYCLAW_TOPIC_ID || "0");
  if (!Number.isSafeInteger(topicId) || topicId <= 0) return null;
  const customer = record(call.customer);
  const localId = explicitLocalId || inboundLocalId(providerCallId);
  const providerStatus = nonempty(call.status);
  const parentLocalId = nonempty(callMetadata(call)?.letyclaw_parent_local_id);
  const parentCall = parentLocalId ? getVapiCall(parentLocalId) : null;
  return createVapiCall({
    localId,
    providerCallId,
    ...(parentCall ? { parentLocalId: parentCall.local_id } : {}),
    direction: "inbound",
    approvalToken: `inbound:${providerCallId}`,
    agentId: process.env.VAPI_INBOUND_AGENT_ID || process.env.LETYCLAW_AGENT_ID || "default",
    topicId,
    chatId: process.env.VAPI_INBOUND_CHAT_ID,
    phoneNumber: nonempty(customer?.number) || "unknown",
    task: parentCall
      ? `Handle a callback for the prior outbound task: ${parentCall.task}`
      : "Handle an inbound callback truthfully, collect the caller's purpose, and report the result.",
    callerName: parentCall?.caller_name || process.env.LETYCLAW_OWNER_NAME?.trim() || "the owner",
    language: parentCall?.language || "multi",
    maxDurationSeconds: 600,
    // A first-seen ended status still needs the same end-report grace as an
    // already-known call. The following snapshot closes it immediately when
    // this event is itself the richer end-of-call report.
    state: providerStatus === "ended" ? "awaiting-report" : providerStatus || "starting",
    providerStatus,
  });
}

function hashEnvelope(envelope: SpoolEnvelope): string {
  return envelope.eventKey || createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex");
}

function processEnvelope(envelope: SpoolEnvelope): void {
  const message = eventMessage(envelope.payload);
  const type = nonempty(message.type) || "unknown";
  const embeddedCall = eventCall(message);
  const providerCallId = nonempty(embeddedCall?.id) || nonempty(message.callId);
  if (!providerCallId) return;
  const call = embeddedCall || { id: providerCallId };
  const localId = localIdFromCall(call);
  const eventKey = hashEnvelope(envelope);
  recordVapiEvent({
    eventKey,
    providerCallId,
    ...(localId ? { localId } : {}),
    type,
    providerTimestamp: providerTimestamp(message.timestamp, envelope.receivedAt),
    payloadJson: JSON.stringify(envelope.payload),
  });
  try {
    const row = ensureCallForEvent(call, providerCallId);
    if (!row && isInboundCall(call)) {
      throw new Error("inbound Vapi event cannot be routed: VAPI_INBOUND_TOPIC_ID is missing or invalid");
    }
    if (row && (type === "status-update" || type === "end-of-call-report")) {
      const forcedStatus = type === "end-of-call-report" ? "ended" : nonempty(message.status);
      const snapshot = vapiSnapshotFromPayload(message, forcedStatus);
      // Merge ordering uses call.updatedAt, which vapiSnapshotFromPayload reads
      // from the embedded call. Do not mix that provider resource version with
      // event-delivery/message timestamps; doing so can make a later GET look
      // stale forever and strand an `awaiting-report` row.
      // Vapi may emit status=ended just before the richer end-of-call-report.
      // Keep the row pollable so we do not announce "no transcript" while the
      // final artifact is still in flight.
      if (type === "status-update" && forcedStatus === "ended") snapshot.state = "awaiting-report";
      applyVapiCallSnapshot(snapshot, row.local_id);
    }
    markVapiEventProcessed(eventKey);
  } catch (err) {
    // Keep the DB event unprocessed and the spool file retryable.
    throw err;
  }
}

function drainSpool(eventDir: string, log: VoiceCallMonitorOptions["log"]): void {
  mkdirSync(eventDir, { recursive: true, mode: 0o770 });
  try { chmodSync(eventDir, 0o770); } catch { /* shared dir may be owned by webhook UID */ }
  let recoveryIndex = 0;
  for (const filename of readdirSync(eventDir).filter((name) => name.endsWith(".json.processing")).sort()) {
    const processing = join(eventDir, filename);
    const original = processing.slice(0, -".processing".length);
    const recovered = existsSync(original)
      ? join(eventDir, `${Date.now()}-recovered-${recoveryIndex++}.json`)
      : original;
    try {
      renameSync(processing, recovered);
    } catch (err) {
      log?.(`[voice-monitor] could not recover ${filename}`, err);
    }
  }
  for (const filename of readdirSync(eventDir).filter((name) => name.endsWith(".json")).sort()) {
    const source = join(eventDir, filename);
    const processing = `${source}.processing`;
    try {
      renameSync(source, processing);
    } catch {
      continue;
    }
    try {
      const parsed = JSON.parse(readFileSync(processing, "utf8")) as unknown;
      const envelope = record(parsed) as unknown as SpoolEnvelope | undefined;
      if (!envelope || !record(envelope.payload)) throw new Error("invalid Vapi spool envelope");
      processEnvelope(envelope);
      unlinkSync(processing);
    } catch (err) {
      log?.(`[voice-monitor] event ${filename} failed`, err);
      try {
        if (!existsSync(source)) renameSync(processing, source);
      } catch { /* leave .processing for operator inspection */ }
    }
  }
}

export function startVoiceCallMonitor(options: VoiceCallMonitorOptions): VoiceCallMonitor {
  const eventDir = options.eventDir || defaultEventDir();
  const intervalMs = Math.max(1_000, options.intervalMs ?? 10_000);
  const fetchCall = options.fetchCall || fetchVapiCallStatus;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    drainSpool(eventDir, options.log);

    const activeCalls = listVapiCallsNeedingWork()
      .filter((call) => (!isTerminalVapiState(call.state) || call.state === "outcome_unknown") && !!call.provider_call_id)
      .slice(0, 30);
    for (let index = 0; index < activeCalls.length; index += 3) {
      await Promise.all(activeCalls.slice(index, index + 3).map(async (call) => {
        try {
          const { snapshot, raw } = await fetchCall(call.provider_call_id!);
          // A successful GET for the exact durable provider id resolves an
          // ambiguous POST response even while the call is still live. Merge
          // that stronger evidence so a queued/ringing call cannot emit a
          // false "outcome unknown" notification before its real result.
          if (snapshot.providerStatus === "ended" && !vapiCallHasFinalArtifact(snapshot, raw)) {
            const observedAt = call.state === "outcome_unknown" ? Date.now() : call.terminal_observed_at ?? Date.now();
            if (Date.now() - observedAt < FINAL_REPORT_GRACE_MS) snapshot.state = "awaiting-report";
          }
          const updated = applyVapiCallSnapshot(snapshot, call.local_id);
          if (updated && awaitingReportGraceRemaining(updated) === 0) {
            // A prior authenticated webhook already proved the call ended.
            // After the bounded report grace, missing GET artifacts must not
            // turn that proof into an indefinite wait or an unknown outcome.
            finalizeProvenEndedCall(updated);
          }
          if (!providerSnapshotIsTerminal(snapshot) && callPollingDeadlineExceeded(call)) {
            markVapiCallFailed(
              call.local_id,
              "Final call result unavailable after the polling deadline; slow reconciliation will continue.",
              true,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const reportGraceRemaining = awaitingReportGraceRemaining(call);
          if (reportGraceRemaining !== null) {
            if (reportGraceRemaining > 0) {
              deferVapiPoll(call.local_id, message, Math.min(10_000, reportGraceRemaining));
            } else {
              finalizeProvenEndedCall(call);
            }
            options.log?.(`[voice-monitor] final-report poll ${call.provider_call_id} failed`, err);
            return;
          }
          if (err instanceof VapiHttpError && (err.status === 404 || err.status === 410)) {
            if (call.state === "outcome_unknown") {
              deferVapiPoll(call.local_id, message, 15 * 60_000);
            } else {
              // A provider id proves launch acceptance, but a later GET 404/410
              // does not prove the phone call never happened. Surface an
              // unresolved final result and keep slow reconciliation/webhook
              // recovery alive instead of making a false permanent claim.
              markVapiCallFailed(call.local_id, message, true);
            }
          } else if (call.state === "outcome_unknown") {
            deferVapiPoll(call.local_id, message, 15 * 60_000);
          } else if (callPollingDeadlineExceeded(call)) {
            markVapiCallFailed(
              call.local_id,
              `Final call result unavailable after the polling deadline: ${message}`,
              true,
            );
          } else {
            deferVapiPoll(call.local_id, message);
          }
          options.log?.(`[voice-monitor] poll ${call.provider_call_id} failed`, err);
        }
      }));
    }

    for (const call of listVapiCallsNeedingWork()) {
      if (!isTerminalVapiState(call.state)) continue;
      const claimToken = claimVapiNotification(call.local_id);
      if (!claimToken) continue;
      try {
        const latest = getVapiCall(call.local_id);
        if (!latest) throw new Error("call disappeared before notification");
        if (!isTerminalVapiState(latest.state)) {
          completeVapiNotification(call.local_id, claimToken, false);
          continue;
        }
        await options.notify(latest, claimToken);
        completeVapiNotification(call.local_id, claimToken, true);
      } catch (err) {
        const delayMs = retryAfterMs(err);
        if (delayMs) deferVapiNotification(call.local_id, claimToken, delayMs);
        else completeVapiNotification(call.local_id, claimToken, false);
        options.log?.(`[voice-monitor] notify ${call.local_id} failed`, err);
      }
    }
  };

  const tick = (): Promise<void> => {
    if (stopped) return inFlight || Promise.resolve();
    if (!inFlight) {
      inFlight = run()
        .catch((err) => { options.log?.("[voice-monitor] tick failed", err); })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  void tick();

  return {
    tick,
    stop(): void { stopped = true; clearInterval(timer); },
    async drain(): Promise<void> { if (inFlight) await inFlight; },
  };
}
