import type { Database as DatabaseType } from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  applyVapiCallSnapshot,
  closeVapiDb,
  createVapiCall,
  getVapiCall,
  getVapiDb,
  markVapiCallFailed,
  setVapiStatusMessage,
} from "../services/vapi-call-store.js";
import type { CreateVapiCallParams, VapiCallRow } from "../services/vapi-call-store.js";
import { startVoiceCallMonitor } from "../services/voice-call-monitor.js";
import { VapiHttpError } from "../tools/letyclaw-mcp/tools/voice.js";
import type {
  VoiceCallMonitor,
  VoiceCallMonitorOptions,
} from "../services/voice-call-monitor.js";

function callParams(overrides: Partial<CreateVapiCallParams> = {}): CreateVapiCallParams {
  return {
    localId: "local-call-1",
    providerCallId: "provider-call-1",
    approvalToken: "approval-call-1",
    agentId: "personal",
    topicId: 2,
    chatId: -1001234567890,
    approvalMessageId: 101,
    sourceSessionId: "session-1",
    phoneNumber: "+34600123456",
    task: "Confirm the reservation",
    callerName: "Alex",
    firstMessage: "Hello, I am calling on behalf of Alex.",
    language: "es",
    maxDurationSeconds: 300,
    providerStatus: "queued",
    createdAt: Date.now() - 31_000,
    ...overrides,
  };
}

describe("voice call monitor", () => {
  let root: string;
  let dbPath: string;
  let eventDir: string;
  let db: DatabaseType;
  let previousDbPath: string | undefined;
  let previousEventDir: string | undefined;
  let previousInboundTopic: string | undefined;
  let monitors: VoiceCallMonitor[];

  beforeEach(() => {
    closeVapiDb();
    root = mkdtempSync(join(tmpdir(), "letyclaw-voice-monitor-"));
    dbPath = join(root, "state", "vapi-calls.sqlite");
    eventDir = join(root, "events");
    mkdirSync(eventDir, { recursive: true });
    previousDbPath = process.env.VAPI_CALL_DB_PATH;
    previousEventDir = process.env.VAPI_EVENT_DIR;
    previousInboundTopic = process.env.VAPI_INBOUND_TOPIC_ID;
    process.env.VAPI_CALL_DB_PATH = dbPath;
    process.env.VAPI_EVENT_DIR = eventDir;
    db = getVapiDb();
    monitors = [];
  });

  afterEach(async () => {
    for (const monitor of monitors) monitor.stop();
    await Promise.all(monitors.map((monitor) => monitor.drain()));
    closeVapiDb();
    if (previousDbPath === undefined) delete process.env.VAPI_CALL_DB_PATH;
    else process.env.VAPI_CALL_DB_PATH = previousDbPath;
    if (previousEventDir === undefined) delete process.env.VAPI_EVENT_DIR;
    else process.env.VAPI_EVENT_DIR = previousEventDir;
    if (previousInboundTopic === undefined) delete process.env.VAPI_INBOUND_TOPIC_ID;
    else process.env.VAPI_INBOUND_TOPIC_ID = previousInboundTopic;
    rmSync(root, { recursive: true, force: true });
  });

  function start(options: Pick<VoiceCallMonitorOptions, "fetchCall" | "notify" | "log">): VoiceCallMonitor {
    const monitor = startVoiceCallMonitor({
      eventDir,
      intervalMs: 60_000,
      ...options,
    });
    monitors.push(monitor);
    return monitor;
  }

  it("ingests a terminal webhook before polling and sends the completed result", async () => {
    createVapiCall(callParams({ providerStatus: "in-progress" }), db);
    // Simulate a process crash after the atomic .json -> .processing rename.
    writeFileSync(join(eventDir, "001-ended.json.processing"), JSON.stringify({
      eventKey: "event-ended-1",
      receivedAt: "2026-07-10T10:00:43.000Z",
      payload: {
        message: {
          type: "end-of-call-report",
          timestamp: 1_752_141_643_000,
          startedAt: "2026-07-10T10:00:01.000Z",
          endedAt: "2026-07-10T10:00:43.000Z",
          endedReason: "assistant-ended-call",
          cost: 0.17,
          call: {
            id: "provider-call-1",
            status: "ended",
            name: "letyclaw-local-call-1",
            assistantOverrides: {
              metadata: { letyclaw_local_call_id: "local-call-1" },
            },
          },
          artifact: {
            transcript: "Assistant: Hola\nCustomer: Confirmado",
            recording: { mono: { combinedUrl: "https://example.test/recording.wav" } },
          },
          analysis: {
            summary: "Reservation confirmed",
            successEvaluation: true,
          },
        },
      },
    }));
    const fetchCall = vi.fn(async () => {
      throw new Error("polling should not run after a terminal webhook");
    });
    const notified: VapiCallRow[] = [];
    const notify = vi.fn(async (call: VapiCallRow) => { notified.push(call); });

    const monitor = start({ fetchCall, notify });
    await monitor.drain();

    expect(fetchCall).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notified[0]).toMatchObject({
      local_id: "local-call-1",
      state: "ended",
      provider_status: "ended",
      ended_reason: "assistant-ended-call",
      duration_seconds: 42,
      cost: 0.17,
      transcript: "Assistant: Hola\nCustomer: Confirmado",
      summary: "Reservation confirmed",
      success_evaluation: "true",
      recording_url: "https://example.test/recording.wav",
    });
    expect(readdirSync(eventDir)).toEqual([]);
    expect(db.prepare(
      "SELECT type, processed_at FROM vapi_events WHERE event_key = ?",
    ).get("event-ended-1")).toMatchObject({
      type: "end-of-call-report",
      processed_at: expect.any(Number),
    });
  });

  it("falls back to provider polling and notifies when the poll is terminal", async () => {
    createVapiCall(callParams(), db);
    const fetchCall = vi.fn(async (callId: string) => ({
      snapshot: {
        providerCallId: callId,
        providerStatus: "ended",
        state: "ended",
        endedAt: Date.now(),
        endedReason: "customer-ended-call",
        durationSeconds: 18,
        transcript: "Customer confirmed the booking.",
      },
      raw: { id: callId, status: "ended" },
    }));
    const notify = vi.fn(async (_call: VapiCallRow) => {});

    const monitor = start({ fetchCall, notify });
    await monitor.drain();

    expect(fetchCall).toHaveBeenCalledOnce();
    expect(fetchCall).toHaveBeenCalledWith("provider-call-1");
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({
      state: "ended",
      ended_reason: "customer-ended-call",
      duration_seconds: 18,
      transcript: "Customer confirmed the booking.",
    });
    expect(getVapiCall("local-call-1", db)?.last_polled_at).toEqual(expect.any(Number));
  });

  it("waits for the end report after status=ended so the transcript is not lost", async () => {
    createVapiCall(callParams({ providerStatus: "in-progress" }), db);
    writeFileSync(join(eventDir, "001-status-ended.json"), JSON.stringify({
      eventKey: "event-status-ended",
      payload: { message: {
        type: "status-update",
        status: "ended",
        call: { id: "provider-call-1", name: "letyclaw-local-call-1" },
      } },
    }));
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new Error("poll is not due yet"); }),
      notify,
    });
    await monitor.drain();
    expect(notify).not.toHaveBeenCalled();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      provider_status: "ended",
      state: "awaiting-report",
    });

    writeFileSync(join(eventDir, "002-report.json"), JSON.stringify({
      eventKey: "event-final-report",
      payload: { message: {
        type: "end-of-call-report",
        endedReason: "assistant-ended-call",
        call: { id: "provider-call-1", name: "letyclaw-local-call-1" },
        artifact: { transcript: "Final transcript arrived." },
        analysis: {},
      } },
    }));
    await monitor.tick();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({
      state: "ended",
      transcript: "Final transcript arrived.",
    });
  });

  it("keeps polling an ended call during the bounded final-artifact grace", async () => {
    createVapiCall(callParams(), db);
    const fetchCall = vi.fn()
      .mockResolvedValueOnce({
        snapshot: { providerCallId: "provider-call-1", providerStatus: "ended", state: "ended" },
        raw: { id: "provider-call-1", status: "ended" },
      })
      .mockResolvedValueOnce({
        snapshot: {
          providerCallId: "provider-call-1",
          providerStatus: "ended",
          state: "ended",
          transcript: "Artifact arrived on the next poll.",
        },
        raw: { id: "provider-call-1", status: "ended", artifact: { transcript: "Artifact arrived on the next poll." } },
      });
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({ fetchCall, notify });
    await monitor.drain();
    expect(getVapiCall("local-call-1", db)?.state).toBe("awaiting-report");
    expect(notify).not.toHaveBeenCalled();

    db.prepare("UPDATE vapi_calls SET next_poll_at = ? WHERE local_id = ?")
      .run(Date.now() - 1, "local-call-1");
    await monitor.tick();
    expect(fetchCall).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0].transcript).toBe("Artifact arrived on the next poll.");
  });

  it("does not downgrade a webhook-proven ended call when report polling fails", async () => {
    createVapiCall(callParams({ providerStatus: "in-progress" }), db);
    const now = Date.now();
    db.prepare(`
      UPDATE vapi_calls
      SET state = 'awaiting-report', provider_status = 'ended', terminal_observed_at = ?, next_poll_at = ?
      WHERE local_id = ?
    `).run(now, now - 1, "local-call-1");
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new VapiHttpError("report not visible yet", 404, true); }),
      notify,
    });
    await monitor.drain();
    expect(notify).not.toHaveBeenCalled();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      state: "awaiting-report",
      provider_status: "ended",
      next_poll_at: expect.any(Number),
    });

    db.prepare("UPDATE vapi_calls SET terminal_observed_at = ?, next_poll_at = ? WHERE local_id = ?")
      .run(Date.now() - 90_001, Date.now() - 1, "local-call-1");
    await monitor.tick();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({ state: "ended", provider_status: "ended" });
  });

  it("delivers a terminal notification exactly once across repeated ticks", async () => {
    createVapiCall(callParams({ providerStatus: "ended" }), db);
    const fetchCall = vi.fn(async () => {
      throw new Error("terminal calls must not be polled");
    });
    const notify = vi.fn(async (_call: VapiCallRow) => {});

    const monitor = start({ fetchCall, notify });
    await monitor.drain();
    await Promise.all([monitor.tick(), monitor.tick(), monitor.tick()]);
    await monitor.tick();

    expect(fetchCall).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      notifying_at: null,
      notified_at: expect.any(Number),
    });
  });

  it("does not race a fresh outbound completion ahead of its Telegram status message", async () => {
    createVapiCall(callParams({ providerStatus: "ended", createdAt: Date.now() }), db);
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new Error("terminal calls must not be polled"); }),
      notify,
    });
    await monitor.drain();
    expect(notify).not.toHaveBeenCalled();

    setVapiStatusMessage("local-call-1", 999, Date.now(), db);
    await monitor.tick();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("resumes an unnotified terminal call after the SQLite store is reopened", async () => {
    createVapiCall(callParams({ providerStatus: "ended" }), db);
    expect(getVapiCall("local-call-1", db)?.notified_at).toBeNull();

    closeVapiDb();
    db = getVapiDb(dbPath);
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      state: "ended",
      notified_at: null,
    });

    const fetchCall = vi.fn(async () => {
      throw new Error("terminal calls must not be polled after restart");
    });
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({ fetchCall, notify });
    await monitor.drain();

    expect(fetchCall).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledOnce();
    expect(getVapiCall("local-call-1", db)?.notified_at).toEqual(expect.any(Number));
  });

  it("retries a failed notification and records success only after delivery", async () => {
    createVapiCall(callParams({ providerStatus: "ended" }), db);
    const fetchCall = vi.fn(async () => {
      throw new Error("terminal calls must not be polled");
    });
    const notify = vi.fn()
      .mockRejectedValueOnce(new Error("Telegram temporarily unavailable"))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();

    const monitor = start({ fetchCall, notify, log });
    await monitor.drain();

    expect(notify).toHaveBeenCalledOnce();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      notifying_at: null,
      notified_at: null,
    });
    expect(log).toHaveBeenCalledWith(
      "[voice-monitor] notify local-call-1 failed",
      expect.any(Error),
    );

    await monitor.tick();
    await monitor.tick();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      notifying_at: null,
      notified_at: expect.any(Number),
    });
  });

  it("honors a notification retry-after without hammering Telegram", async () => {
    createVapiCall(callParams({ providerStatus: "ended" }), db);
    const retryError = Object.assign(new Error("Telegram 429"), { retryAfterMs: 60_000 });
    const notify = vi.fn()
      .mockRejectedValueOnce(retryError)
      .mockResolvedValueOnce(undefined);
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new Error("terminal calls must not be polled"); }),
      notify,
    });
    await monitor.drain();
    const deferred = getVapiCall("local-call-1", db);
    expect(deferred).toMatchObject({
      notified_at: null,
      notifying_token: null,
      notify_after: expect.any(Number),
    });

    await monitor.tick();
    expect(notify).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE vapi_calls SET notify_after = ? WHERE local_id = ?")
      .run(Date.now() - 1, "local-call-1");
    await monitor.tick();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(getVapiCall("local-call-1", db)?.notified_at).toEqual(expect.any(Number));
  });

  it("surfaces provider 404 after launch as recoverable unknown, not a false call failure", async () => {
    createVapiCall(callParams(), db);
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new VapiHttpError("call not found", 404, true); }),
      notify,
    });
    await monitor.drain();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({
      state: "outcome_unknown",
      error: "call not found",
      next_poll_at: expect.any(Number),
    });
  });

  it("recovers an ambiguous launch to live state before notifying when the provider id resolves", async () => {
    createVapiCall(callParams(), db);
    const providerVersion = Date.now() - 2_000;
    applyVapiCallSnapshot({
      providerCallId: "provider-call-1",
      providerStatus: "ringing",
      state: "ringing",
      observedAt: providerVersion,
    }, "local-call-1", Date.now() - 1_500, db);
    markVapiCallFailed(
      "local-call-1",
      "Provider acceptance response was ambiguous",
      true,
      Date.now() - 31_000,
      db,
    );
    db.prepare("UPDATE vapi_calls SET next_poll_at = ? WHERE local_id = ?")
      .run(Date.now() - 1, "local-call-1");
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => ({
        snapshot: {
          providerCallId: "provider-call-1",
          providerStatus: "ringing",
          state: "ringing",
          // Vapi may keep call.updatedAt unchanged while the resource remains
          // in the same live status. That still proves the exact call exists.
          observedAt: providerVersion,
        },
        raw: { id: "provider-call-1", status: "ringing" },
      })),
      notify,
    });
    await monitor.drain();

    expect(notify).not.toHaveBeenCalled();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      state: "ringing",
      provider_status: "ringing",
      notified_at: null,
      terminal_observed_at: null,
    });
  });

  it("surfaces an unavailable final result after the call deadline and schedules slow reconciliation", async () => {
    createVapiCall(callParams({
      createdAt: Date.now() - 10 * 60_000,
      maxDurationSeconds: 60,
    }), db);
    const fetchCall = vi.fn()
      .mockRejectedValueOnce(new Error("provider temporarily unavailable"))
      .mockResolvedValueOnce({
        snapshot: {
          providerCallId: "provider-call-1",
          providerStatus: "ended",
          state: "ended",
          transcript: "Recovered final result.",
        },
        raw: { id: "provider-call-1", status: "ended", artifact: { transcript: "Recovered final result." } },
      });
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({ fetchCall, notify });
    await monitor.drain();

    expect(notify).toHaveBeenCalledOnce();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      state: "outcome_unknown",
      provider_call_id: "provider-call-1",
      ended_at: null,
      notified_at: expect.any(Number),
      next_poll_at: expect.any(Number),
    });
    await monitor.tick();
    expect(fetchCall).toHaveBeenCalledOnce();

    db.prepare("UPDATE vapi_calls SET next_poll_at = ? WHERE local_id = ?")
      .run(Date.now() - 1, "local-call-1");
    await monitor.tick();
    expect(fetchCall).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      state: "ended",
      transcript: "Recovered final result.",
    });
  });

  it("starts a fresh report grace when an ambiguous outcome first recovers as ended", async () => {
    createVapiCall(callParams({ createdAt: Date.now() - 30 * 60_000 }), db);
    markVapiCallFailed(
      "local-call-1",
      "Final result was unavailable",
      true,
      Date.now() - 15 * 60_000,
      db,
    );
    db.prepare("UPDATE vapi_calls SET next_poll_at = ? WHERE local_id = ?")
      .run(Date.now() - 1, "local-call-1");
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => ({
        snapshot: { providerCallId: "provider-call-1", providerStatus: "ended", state: "ended" },
        raw: { id: "provider-call-1", status: "ended", artifact: { messages: [] } },
      })),
      notify,
    });
    const before = Date.now();
    await monitor.drain();

    expect(notify).not.toHaveBeenCalled();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      state: "awaiting-report",
      terminal_observed_at: expect.any(Number),
      notified_at: null,
    });
    expect(getVapiCall("local-call-1", db)!.terminal_observed_at!).toBeGreaterThanOrEqual(before);
  });

  it("recovers a legacy stale unknown into one stable final-report grace", async () => {
    createVapiCall(callParams({ providerStatus: "in-progress" }), db);
    const futureProviderVersion = Date.now() + 60_000;
    applyVapiCallSnapshot({
      providerCallId: "provider-call-1",
      providerStatus: "in-progress",
      observedAt: futureProviderVersion,
    }, "local-call-1", Date.now(), db);
    markVapiCallFailed("local-call-1", "legacy unresolved result", true, Date.now(), db);
    db.prepare("UPDATE vapi_calls SET next_poll_at = ? WHERE local_id = ?")
      .run(Date.now() - 1, "local-call-1");
    const fetchCall = vi.fn(async () => ({
      snapshot: {
        providerCallId: "provider-call-1",
        providerStatus: "ended",
        state: "ended",
        observedAt: futureProviderVersion - 30_000,
      },
      raw: { id: "provider-call-1", status: "ended", artifact: { messages: [] } },
    }));
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({ fetchCall, notify });
    await monitor.drain();
    expect(getVapiCall("local-call-1", db)).toMatchObject({
      state: "awaiting-report",
      provider_status: "ended",
      terminal_observed_at: expect.any(Number),
    });
    expect(notify).not.toHaveBeenCalled();

    db.prepare("UPDATE vapi_calls SET terminal_observed_at = ?, next_poll_at = ? WHERE local_id = ?")
      .run(Date.now() - 90_001, Date.now() - 1, "local-call-1");
    await monitor.tick();
    expect(getVapiCall("local-call-1", db)?.state).toBe("ended");
    expect(notify).toHaveBeenCalledOnce();
  });

  it("retains an inbound event when its Telegram routing is not configured", async () => {
    delete process.env.VAPI_INBOUND_TOPIC_ID;
    writeFileSync(join(eventDir, "001-inbound.json"), JSON.stringify({
      eventKey: "event-inbound-unrouted",
      payload: { message: {
        type: "status-update",
        status: "in-progress",
        call: { id: "inbound-provider-1", type: "inboundPhoneCall" },
      } },
    }));
    const log = vi.fn();
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new Error("nothing to poll"); }),
      notify: vi.fn(async () => {}),
      log,
    });
    await monitor.drain();
    expect(readdirSync(eventDir)).toEqual(["001-inbound.json"]);
    expect(log).toHaveBeenCalledWith(
      "[voice-monitor] event 001-inbound.json failed",
      expect.any(Error),
    );
  });

  it("creates, routes, and reports a configured inbound callback", async () => {
    process.env.VAPI_INBOUND_TOPIC_ID = "77";
    writeFileSync(join(eventDir, "001-inbound-ended.json"), JSON.stringify({
      eventKey: "event-inbound-ended",
      receivedAt: "2026-07-10T10:00:43.000Z",
      payload: { message: {
        type: "end-of-call-report",
        timestamp: "2026-07-10T10:00:43.000Z",
        endedReason: "customer-ended-call",
        call: {
          id: "inbound-provider-2",
          type: "inboundPhoneCall",
          status: "ended",
          customer: { number: "+12025550123" },
        },
        artifact: { transcript: "JetBlue called back about the delayed bag." },
        analysis: { summary: "Callback message collected." },
      } },
    }));
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new Error("terminal inbound call must not be polled"); }),
      notify,
    });
    await monitor.drain();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify.mock.calls[0]![0]).toMatchObject({
      provider_call_id: "inbound-provider-2",
      direction: "inbound",
      topic_id: 77,
      phone_number: "+12025550123",
      state: "ended",
      transcript: "JetBlue called back about the delayed bag.",
      summary: "Callback message collected.",
    });
    expect(readdirSync(eventDir)).toEqual([]);
  });

  it("gives a first-seen inbound ended status time to receive its final report", async () => {
    process.env.VAPI_INBOUND_TOPIC_ID = "77";
    writeFileSync(join(eventDir, "001-inbound-status-ended.json"), JSON.stringify({
      eventKey: "event-inbound-status-ended",
      payload: { message: {
        type: "status-update",
        status: "ended",
        call: {
          id: "inbound-provider-ended-status",
          type: "inboundPhoneCall",
          status: "ended",
          customer: { number: "+12025550124" },
        },
      } },
    }));
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new Error("poll is not due until the next monitor tick"); }),
      notify,
    });
    await monitor.drain();

    expect(notify).not.toHaveBeenCalled();
    expect(getVapiCall("inbound-inbound-provider-ended-status", db)).toMatchObject({
      direction: "inbound",
      state: "awaiting-report",
      provider_status: "ended",
    });
  });

  it("links a correlated inbound callback to its outbound task", async () => {
    process.env.VAPI_INBOUND_TOPIC_ID = "77";
    createVapiCall(callParams({
      localId: "parent-outbound-call",
      providerCallId: "parent-provider-call",
      approvalToken: "parent-approval",
      task: "Ask JetBlue to trace the delayed bag.",
      callerName: "Alex",
      language: "en-US",
    }), db);
    writeFileSync(join(eventDir, "001-correlated-inbound.json"), JSON.stringify({
      eventKey: "event-correlated-inbound",
      payload: { message: {
        type: "end-of-call-report",
        call: {
          id: "inbound-correlated-provider",
          type: "inboundPhoneCall",
          status: "ended",
          customer: { number: "+18005382583" },
          assistantOverrides: { metadata: { letyclaw_parent_local_id: "parent-outbound-call" } },
        },
        artifact: { transcript: "The airline called back with the bag status." },
      } },
    }));
    const notify = vi.fn(async (_call: VapiCallRow) => {});
    const monitor = start({
      fetchCall: vi.fn(async () => { throw new Error("terminal callback must not be polled"); }),
      notify,
    });
    await monitor.drain();

    expect(notify.mock.calls[0]![0]).toMatchObject({
      parent_local_id: "parent-outbound-call",
      caller_name: "Alex",
      language: "en-US",
      task: "Handle a callback for the prior outbound task: Ask JetBlue to trace the delayed bag.",
    });
  });
});
