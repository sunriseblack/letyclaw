import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  applyVapiCallSnapshot,
  bindVapiProviderCall,
  claimVapiNotification,
  closeVapiDb,
  completeVapiNotification,
  createVapiCall,
  deferVapiNotification,
  getLatestVapiCallForTopic,
  getVapiCall,
  getVapiDb,
  isTerminalVapiState,
  listVapiCallsNeedingWork,
  listStaleUnboundVapiCalls,
  markVapiCallFailed,
  markVapiEventProcessed,
  recordVapiEvent,
  setVapiStatusMessage,
  setInitialVapiStatusMessage,
  setVapiStatusMessageForClaim,
} from "../services/vapi-call-store.js";
import type {
  CreateVapiCallParams,
  VapiEventRecord,
} from "../services/vapi-call-store.js";

function callParams(overrides: Partial<CreateVapiCallParams> = {}): CreateVapiCallParams {
  return {
    localId: "local-1",
    approvalToken: "approval-1",
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
    createdAt: 1_000,
    ...overrides,
  };
}

describe("durable Vapi call store", () => {
  let root: string;
  let db: DatabaseType;

  beforeEach(() => {
    closeVapiDb();
    root = mkdtempSync(join(tmpdir(), "letyclaw-vapi-store-"));
    db = getVapiDb(join(root, "state", "vapi-calls.sqlite"));
  });

  afterEach(() => {
    closeVapiDb();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a complete row and is idempotent for the same local id", () => {
    const created = createVapiCall(callParams(), db);

    expect(created).toMatchObject({
      local_id: "local-1",
      provider_call_id: null,
      direction: "outbound",
      approval_token: "approval-1",
      agent_id: "personal",
      topic_id: 2,
      chat_id: "-1001234567890",
      approval_message_id: 101,
      source_session_id: "session-1",
      phone_number: "+34600123456",
      task: "Confirm the reservation",
      caller_name: "Alex",
      first_message: "Hello, I am calling on behalf of Alex.",
      language: "es",
      max_duration_seconds: 300,
      state: "starting",
      created_at: 1_000,
      updated_at: 1_000,
      next_poll_at: 1_000,
    });

    const duplicate = createVapiCall(callParams({
      task: "This must not overwrite the approved task",
      phoneNumber: "+12025550143",
      createdAt: 2_000,
    }), db);

    expect(duplicate.task).toBe("Confirm the reservation");
    expect(duplicate.phone_number).toBe("+34600123456");
    expect(duplicate.created_at).toBe(1_000);
    expect(db.prepare("SELECT COUNT(*) AS count FROM vapi_calls").get()).toEqual({ count: 1 });
  });

  it("migrates legacy provider-bound failures back to recoverable unknown", () => {
    createVapiCall(callParams({
      providerCallId: "legacy-provider-failed",
      state: "failed",
      providerStatus: "not-found",
    }), db);
    db.prepare(`
      UPDATE vapi_calls SET ended_at = 2_000, notified_at = 2_100, next_poll_at = NULL
      WHERE local_id = 'local-1'
    `).run();
    db.prepare("DELETE FROM vapi_meta WHERE key = 'provider-bound-failure-recovery-v1'").run();
    closeVapiDb();
    db = getVapiDb(join(root, "state", "vapi-calls.sqlite"));

    expect(getVapiCall("local-1", db)).toMatchObject({
      state: "outcome_unknown",
      provider_call_id: "legacy-provider-failed",
      ended_at: null,
      notified_at: null,
      next_poll_at: expect.any(Number),
    });
  });

  it("binds a provider call id idempotently and rejects conflicting rebinding without mutation", () => {
    createVapiCall(callParams(), db);

    const bound = bindVapiProviderCall("local-1", "vapi-call-1", "queued", 2_000, db);
    expect(bound).toMatchObject({
      provider_call_id: "vapi-call-1",
      provider_status: "queued",
      state: "queued",
      updated_at: 2_000,
      next_poll_at: 2_000,
    });
    expect(getVapiCall("vapi-call-1", db)?.local_id).toBe("local-1");

    const rebound = bindVapiProviderCall("local-1", "vapi-call-1", "queued", 2_100, db);
    expect(rebound.provider_call_id).toBe("vapi-call-1");

    const beforeConflict = getVapiCall("local-1", db);
    expect(() => bindVapiProviderCall("local-1", "vapi-call-2", "ringing", 3_000, db))
      .toThrow("already bound to a different provider call");
    expect(getVapiCall("local-1", db)).toEqual(beforeConflict);
  });

  it("cannot merge a different provider's snapshot into an unbound local row", () => {
    createVapiCall(callParams({ providerCallId: "provider-owned" }), db);
    createVapiCall(callParams({
      localId: "local-unbound",
      approvalToken: "approval-unbound",
      createdAt: 2_000,
    }), db);
    const before = getVapiCall("local-unbound", db);
    expect(() => applyVapiCallSnapshot({
      providerCallId: "provider-owned",
      providerStatus: "ended",
      transcript: "must not cross calls",
    }, "local-unbound", 3_000, db)).toThrow();
    expect(getVapiCall("local-unbound", db)).toEqual(before);
  });

  it("advances lifecycle state monotonically and ignores an older provider status", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "queued" }), db);

    const ringing = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ringing",
    }, undefined, 2_000, db);
    expect(ringing?.state).toBe("ringing");

    const active = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "in-progress",
      startedAt: 2_100,
    }, undefined, 3_000, db);
    expect(active?.state).toBe("in-progress");
    expect(active?.started_at).toBe(2_100);

    const stale = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "queued",
    }, undefined, 4_000, db);
    expect(stale?.state).toBe("in-progress");
    expect(stale?.provider_status).toBe("in-progress");
    expect(stale?.next_poll_at).toBe(14_000);
  });

  it("does not regress awaiting-report to an out-of-order live status", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "in-progress" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      state: "awaiting-report",
      observedAt: 5_000,
    }, "local-1", 5_100, db);
    const staleLive = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "forwarding",
      observedAt: 5_200,
    }, "local-1", 5_300, db);
    expect(staleLive).toMatchObject({ state: "awaiting-report", provider_status: "ended" });
  });

  it("lets an ended snapshot close awaiting-report even when its call version is older", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "in-progress" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      state: "awaiting-report",
      observedAt: 10_000,
    }, "local-1", 10_100, db);
    const ended = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Final report from the provider.",
      observedAt: 9_000,
    }, "local-1", 10_200, db);
    expect(ended).toMatchObject({
      state: "ended",
      transcript: "Final report from the provider.",
      last_provider_event_at: 10_000,
    });
  });

  it("persists terminal call details, stops polling, and cannot regress", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "in-progress" }), db);

    const ended = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      endedAt: 8_000,
      endedReason: "assistant-ended-call",
      durationSeconds: 42,
      cost: 0.17,
      transcript: "Assistant: Hello\nCustomer: Confirmed",
      summary: "Reservation confirmed",
      successEvaluation: "true",
      recordingUrl: "https://example.test/recording",
    }, undefined, 8_100, db);

    expect(ended).toMatchObject({
      state: "ended",
      ended_at: 8_000,
      ended_reason: "assistant-ended-call",
      duration_seconds: 42,
      cost: 0.17,
      transcript: "Assistant: Hello\nCustomer: Confirmed",
      summary: "Reservation confirmed",
      success_evaluation: "true",
      recording_url: "https://example.test/recording",
      next_poll_at: null,
    });
    expect(isTerminalVapiState(ended!.state)).toBe(true);

    const late = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ringing",
    }, undefined, 9_000, db);
    expect(late?.state).toBe("ended");
    expect(late?.ended_reason).toBe("assistant-ended-call");
    expect(late?.next_poll_at).toBeNull();
  });

  it("keeps outcome_unknown terminal when a later failure marker arrives", () => {
    createVapiCall(callParams(), db);
    const unknown = markVapiCallFailed("local-1", "provider response was lost", true, 2_000, db);
    expect(unknown?.state).toBe("outcome_unknown");
    expect(isTerminalVapiState(unknown!.state)).toBe(true);

    const later = markVapiCallFailed("local-1", "late generic failure", false, 3_000, db);
    expect(later?.state).toBe("outcome_unknown");
    expect(later?.error).toBe("provider response was lost");
    expect(later?.ended_at).toBeNull();
  });

  it("recovers an ambiguous launch when a later provider snapshot proves the call", () => {
    createVapiCall(callParams(), db);
    markVapiCallFailed("local-1", "POST response was lost", true, 2_000, db);
    expect(listVapiCallsNeedingWork(2_001, db)).toEqual([]);

    // Simulate an already delivered unknown notice; stronger provider evidence
    // must reset delivery so the real outcome can replace it.
    expect(claimVapiNotification("local-1", 40_000, db, "claim-unknown")).toBe("claim-unknown");
    completeVapiNotification("local-1", "claim-unknown", true, 40_001, db);
    const recovered = applyVapiCallSnapshot({
      providerCallId: "vapi-recovered-1",
      providerStatus: "ended",
      endedReason: "assistant-ended-call",
      transcript: "The reservation is confirmed.",
    }, "local-1", 41_000, db);

    expect(recovered).toMatchObject({
      provider_call_id: "vapi-recovered-1",
      state: "ended",
      ended_reason: "assistant-ended-call",
      transcript: "The reservation is confirmed.",
      error: null,
      notified_at: null,
      notifying_at: null,
    });
  });

  it("accepts terminal proof even when a legacy event timestamp makes it look stale", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "in-progress" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "in-progress",
      observedAt: 20_000,
    }, "local-1", 20_100, db);
    markVapiCallFailed("local-1", "legacy final result unavailable", true, 21_000, db);

    const recovered = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Authenticated terminal result.",
      observedAt: 10_000,
    }, "local-1", 22_000, db);
    expect(recovered).toMatchObject({
      state: "ended",
      provider_status: "ended",
      transcript: "Authenticated terminal result.",
      error: null,
      last_provider_event_at: 20_000,
    });
  });

  it("recovers a stale terminal legacy row even when it adds no new artifact", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "in-progress" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "in-progress",
      transcript: "Transcript already stored by the legacy merge.",
      observedAt: 20_000,
    }, "local-1", 20_100, db);
    markVapiCallFailed("local-1", "legacy unresolved result", true, 21_000, db);

    const recovered = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Transcript already stored by the legacy merge.",
      observedAt: 10_000,
    }, "local-1", 22_000, db);
    expect(recovered).toMatchObject({
      state: "ended",
      error: null,
      transcript: "Transcript already stored by the legacy merge.",
    });
  });

  it("lets a newer terminal report repair a failed accepted call", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "in-progress" }), db);
    markVapiCallFailed("local-1", "legacy provider GET returned 404", false, 2_000, db);
    expect(claimVapiNotification("local-1", 3_000, db, "legacy-failure-claim")).toBe("legacy-failure-claim");
    completeVapiNotification("local-1", "legacy-failure-claim", true, 3_001, db);

    const recovered = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      endedReason: "customer-ended-call",
      transcript: "The callback was completed.",
      observedAt: 4_000,
    }, "local-1", 4_100, db);
    expect(recovered).toMatchObject({
      state: "ended",
      error: null,
      transcript: "The callback was completed.",
      notified_at: null,
    });
  });

  it("keeps an unbound pre-launch failure immutable", () => {
    createVapiCall(callParams(), db);
    markVapiCallFailed("local-1", "provider rejected before launch", false, 2_000, db);
    const unchanged = applyVapiCallSnapshot({
      providerCallId: "untrusted-late-id",
      providerStatus: "ended",
      transcript: "must not rewrite the pre-launch result",
      observedAt: 3_000,
    }, "local-1", 3_100, db);
    expect(unchanged).toMatchObject({ state: "failed", error: "provider rejected before launch" });
  });

  it("reopens notification once for a late terminal transcript enrichment", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);
    setVapiStatusMessage("local-1", 102, 1_500, db);
    expect(claimVapiNotification("local-1", 2_000, db, "claim-initial")).toBe("claim-initial");
    completeVapiNotification("local-1", "claim-initial", true, 2_001, db);

    const enriched = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Late final transcript",
    }, "local-1", 3_000, db);
    expect(enriched?.notified_at).toBeNull();
    expect(claimVapiNotification("local-1", 3_001, db, "claim-enriched")).toBe("claim-enriched");
    completeVapiNotification("local-1", "claim-enriched", true, 3_002, db);

    const duplicate = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Late final transcript",
    }, "local-1", 4_000, db);
    expect(duplicate?.notified_at).toBe(3_002);
  });

  it("rejects an older provider event before it can overwrite newer artifacts", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Newest transcript",
      summary: "Newest summary",
      observedAt: 5_000,
    }, "local-1", 5_100, db);
    const stale = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Older transcript",
      summary: "Older summary",
      observedAt: 4_000,
    }, "local-1", 5_200, db);
    expect(stale).toMatchObject({
      transcript: "Newest transcript",
      summary: "Newest summary",
      last_provider_event_at: 5_000,
    });
  });

  it("lets an older provider event fill only missing artifacts", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Newest transcript",
      observedAt: 5_000,
    }, "local-1", 5_100, db);
    const enriched = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Older transcript",
      summary: "Previously missing summary",
      observedAt: 4_000,
    }, "local-1", 5_200, db);
    expect(enriched).toMatchObject({
      transcript: "Newest transcript",
      summary: "Previously missing summary",
      last_provider_event_at: 5_000,
    });
  });

  it("does not let an unversioned event overwrite versioned artifacts", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Versioned transcript",
      observedAt: 5_000,
    }, "local-1", 5_100, db);
    const unversioned = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Unversioned conflicting transcript",
      summary: "Missing summary may still be filled",
    }, "local-1", 5_200, db);
    expect(unversioned).toMatchObject({
      transcript: "Versioned transcript",
      summary: "Missing summary may still be filled",
      last_provider_event_at: 5_000,
    });
  });

  it("preserves slow reconciliation when an older event enriches an ambiguous outcome", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1" }), db);
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "in-progress",
      observedAt: 5_000,
    }, "local-1", 5_100, db);
    const unknown = markVapiCallFailed("local-1", "final result unavailable", true, 6_000, db);
    expect(unknown?.next_poll_at).toBe(906_000);

    const enriched = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "in-progress",
      startedAt: 4_000,
      observedAt: 4_500,
    }, "local-1", 7_000, db);
    expect(enriched).toMatchObject({
      state: "outcome_unknown",
      started_at: 4_000,
      error: "final result unavailable",
      next_poll_at: 906_000,
      last_provider_event_at: 5_000,
    });
  });

  it("clears an ambiguous terminal timestamp when current evidence recovers a live call", () => {
    createVapiCall(callParams(), db);
    markVapiCallFailed("local-1", "ambiguous", true, 2_000, db);
    expect(getVapiCall("local-1", db)?.terminal_observed_at).toBe(2_000);

    const recovered = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "queued",
      observedAt: 3_000,
    }, "local-1", 3_100, db);
    expect(recovered).toMatchObject({ state: "queued", terminal_observed_at: null });
  });

  it("rejects completion from a stale notifier after ambiguous state recovers", () => {
    createVapiCall(callParams(), db);
    markVapiCallFailed("local-1", "ambiguous", true, 2_000, db);
    expect(claimVapiNotification("local-1", 40_000, db, "stale-claim")).toBe("stale-claim");
    applyVapiCallSnapshot({
      providerCallId: "vapi-recovered-queued",
      providerStatus: "queued",
    }, "local-1", 40_001, db);

    expect(setVapiStatusMessageForClaim("local-1", 999, "stale-claim", 40_002, db)).toBe(false);
    expect(completeVapiNotification("local-1", "stale-claim", true, 40_002, db)).toBe(false);
    expect(getVapiCall("local-1", db)).toMatchObject({
      state: "queued",
      notifying_token: null,
      notified_at: null,
    });
  });

  it("invalidates an in-flight notification when richer terminal data arrives", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);
    setVapiStatusMessage("local-1", 102, 1_500, db);
    expect(claimVapiNotification("local-1", 2_000, db, "stale-terminal-claim")).toBe("stale-terminal-claim");
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Richer transcript",
      durationSeconds: 22,
    }, "local-1", 2_001, db);

    expect(completeVapiNotification("local-1", "stale-terminal-claim", true, 2_002, db)).toBe(false);
    expect(claimVapiNotification("local-1", 2_003, db, "fresh-terminal-claim")).toBe("fresh-terminal-claim");
  });

  it("retains Telegram retry-after even if enrichment supersedes the original claim", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);
    expect(claimVapiNotification("local-1", 2_000, db, "rate-limited-claim")).toBe("rate-limited-claim");
    applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Richer transcript",
    }, "local-1", 2_001, db);
    expect(getVapiCall("local-1", db)?.notifying_token).toBeNull();

    expect(deferVapiNotification("local-1", "rate-limited-claim", 60_000, 2_002, db)).toBe(true);
    expect(getVapiCall("local-1", db)?.notify_after).toBe(62_002);
    expect(claimVapiNotification("local-1", 62_001, db, "too-early")).toBeNull();
    expect(claimVapiNotification("local-1", 62_002, db, "after-cooldown")).toBe("after-cooldown");
  });

  it("keeps transport cooldown when an unknown outcome recovers", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "in-progress" }), db);
    markVapiCallFailed("local-1", "ambiguous", true, 2_000, db);
    expect(claimVapiNotification("local-1", 40_000, db, "unknown-429")).toBe("unknown-429");
    expect(deferVapiNotification("local-1", "unknown-429", 60_000, 40_001, db)).toBe(true);

    const recovered = applyVapiCallSnapshot({
      providerCallId: "vapi-call-1",
      providerStatus: "ended",
      transcript: "Recovered final result.",
    }, "local-1", 40_002, db);
    expect(recovered).toMatchObject({ state: "ended", notify_after: 100_001 });
    expect(claimVapiNotification("local-1", 100_000, db, "too-soon")).toBeNull();
  });

  it("returns the latest call for a topic with optional agent filtering", () => {
    createVapiCall(callParams({ localId: "personal-old", approvalToken: "token-old", createdAt: 1_000 }), db);
    createVapiCall(callParams({ localId: "personal-new", approvalToken: "token-new", createdAt: 2_000 }), db);
    createVapiCall(callParams({
      localId: "health-newest",
      approvalToken: "token-health",
      agentId: "health",
      createdAt: 3_000,
    }), db);
    createVapiCall(callParams({
      localId: "other-topic",
      approvalToken: "token-other",
      topicId: 7,
      createdAt: 4_000,
    }), db);

    expect(getLatestVapiCallForTopic(2, undefined, db)?.local_id).toBe("health-newest");
    expect(getLatestVapiCallForTopic(2, "personal", db)?.local_id).toBe("personal-new");
    expect(getLatestVapiCallForTopic(2, "missing", db)).toBeNull();
    expect(getLatestVapiCallForTopic(7, undefined, db)?.local_id).toBe("other-topic");
  });

  it("finds only stale nonterminal launches that never received a provider id", () => {
    createVapiCall(callParams({ localId: "stale", approvalToken: "stale-token", createdAt: 1_000 }), db);
    createVapiCall(callParams({ localId: "fresh", approvalToken: "fresh-token", createdAt: 150_000 }), db);
    createVapiCall(callParams({
      localId: "bound", approvalToken: "bound-token", providerCallId: "provider-bound", createdAt: 1_000,
    }), db);
    expect(listStaleUnboundVapiCalls(200_000, 120_000, db).map((row) => row.local_id)).toEqual(["stale"]);
  });

  it("claims terminal notifications once and completes successful delivery", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);
    setVapiStatusMessage("local-1", 102, 1_500, db);

    expect(listVapiCallsNeedingWork(2_000, db).map((row) => row.local_id)).toEqual(["local-1"]);
    expect(claimVapiNotification("local-1", 2_000, db, "claim-a")).toBe("claim-a");
    expect(claimVapiNotification("local-1", 2_001, db, "claim-b")).toBeNull();
    expect(listVapiCallsNeedingWork(2_001, db)).toEqual([]);

    completeVapiNotification("local-1", "claim-a", true, 3_000, db);
    const completed = getVapiCall("local-1", db);
    expect(completed?.notifying_at).toBeNull();
    expect(completed?.notified_at).toBe(3_000);
    expect(claimVapiNotification("local-1", 4_000, db, "claim-c")).toBeNull();
    expect(listVapiCallsNeedingWork(4_000, db)).toEqual([]);
  });

  it("does not let a late initial queued message replace an installed final status message", () => {
    createVapiCall(callParams(), db);
    setVapiStatusMessage("local-1", 900, 2_000, db);
    expect(setInitialVapiStatusMessage("local-1", 901, 2_001, db)).toBe(false);
    expect(getVapiCall("local-1", db)?.status_message_id).toBe(900);
  });

  it("releases failed notification delivery and reclaims an abandoned claim after the lease", () => {
    createVapiCall(callParams({ providerCallId: "vapi-call-1", providerStatus: "ended" }), db);

    expect(claimVapiNotification("local-1", 10_000, db, "claim-a")).toBe("claim-a");
    completeVapiNotification("local-1", "claim-a", false, 11_000, db);
    expect(claimVapiNotification("local-1", 11_001, db, "claim-b")).toBe("claim-b");

    const afterLease = 11_001 + 15 * 60_000 + 1;
    expect(listVapiCallsNeedingWork(afterLease, db).map((row) => row.local_id)).toEqual(["local-1"]);
    expect(claimVapiNotification("local-1", afterLease, db, "claim-c")).toBe("claim-c");
  });

  it("deduplicates provider events by event key and marks the retained event processed", () => {
    const event: VapiEventRecord = {
      eventKey: "event-1",
      providerCallId: "vapi-call-1",
      localId: "local-1",
      type: "end-of-call-report",
      providerTimestamp: "2026-07-10T00:00:00.000Z",
      payloadJson: JSON.stringify({ message: { type: "end-of-call-report" } }),
    };

    expect(recordVapiEvent(event, db)).toBe(true);
    expect(recordVapiEvent({ ...event, payloadJson: "should-not-replace" }, db)).toBe(false);
    expect(recordVapiEvent({ ...event, eventKey: "event-2", type: "status-update" }, db)).toBe(true);

    expect(db.prepare("SELECT COUNT(*) AS count FROM vapi_events").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT payload_json FROM vapi_events WHERE event_key = ?").get("event-1"))
      .toEqual({ payload_json: event.payloadJson });

    markVapiEventProcessed("event-1", db);
    const processed = db.prepare("SELECT processed_at FROM vapi_events WHERE event_key = ?").get("event-1") as {
      processed_at: number | null;
    };
    expect(processed.processed_at).toEqual(expect.any(Number));
  });
});
