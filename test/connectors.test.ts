import { describe, expect, it, vi } from "vitest";
import type { ConnectorRunResult } from "../lib.js";
import {
  createConnectorExecHandler,
  connectorCompletionHasProviderProof,
  parseConnectorCompletion,
} from "../tools/letyclaw-mcp/tools/connectors.js";

function result(overrides: Partial<ConnectorRunResult> = {}): ConnectorRunResult {
  return {
    ok: true,
    text: "CONNECTOR_READ_OK: Listed calendars",
    timedOut: false,
    retryable: false,
    sideEffectOutcome: "unknown",
    exitCode: 0,
    signal: null,
    durationMs: 25,
    toolEvidence: [{
      toolUseId: "tool-read-1",
      toolName: "mcp__claude_ai_Google_Calendar__list_calendars",
      effect: "read",
      success: true,
      artifacts: [],
    }],
    ...overrides,
  };
}

describe("connector_exec failure circuit", () => {
  it("blocks repeated calls in the same run after an ambiguous timeout", async () => {
    const runner = vi.fn(async () => result({
      ok: false,
      text: "Timed out; outcome unknown",
      reason: "timeout",
      timedOut: true,
      retryable: false,
      sideEffectOutcome: "unknown",
      exitCode: null,
      signal: "SIGKILL",
      durationMs: 150_000,
    }));
    const handler = createConnectorExecHandler(runner, () => "run-1", () => null);

    const first = await handler({ prompt: "Create a calendar event" });
    const second = await handler({ prompt: "Try creating the calendar event again" });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({
      isError: true,
      structuredContent: {
        status: "failed",
        reason: "timeout",
        retryable: false,
        sideEffectOutcome: "unknown",
        nextSafeAction: "verify_target_state",
      },
    });
    expect(second).toMatchObject({
      isError: true,
      structuredContent: {
        status: "blocked",
        reason: "prior_ambiguous_failure",
        nextSafeAction: "verify_target_state_in_fresh_run",
      },
    });
  });

  it("allows a fresh run to verify or retry after the prior run was blocked", async () => {
    let runKey = "run-1";
    const runner = vi.fn()
      .mockResolvedValueOnce(result({
        ok: false,
        text: "Timed out; outcome unknown",
        reason: "timeout",
        timedOut: true,
        retryable: false,
        sideEffectOutcome: "unknown",
        exitCode: null,
        signal: "SIGKILL",
      }))
      .mockResolvedValueOnce(result({ text: "CONNECTOR_READ_OK: Verified event exists" }));
    const handler = createConnectorExecHandler(runner, () => runKey, () => null);

    await handler({ prompt: "Create event" });
    runKey = "run-2";
    const fresh = await handler({ prompt: "Verify whether the event exists" });

    expect(runner).toHaveBeenCalledTimes(2);
    expect(fresh).toMatchObject({
      structuredContent: { status: "success", sideEffectOutcome: "none" },
    });
  });

  it("does not open the ambiguity circuit when the executor never started", async () => {
    const runner = vi.fn(async () => result({
      ok: false,
      text: "binary not found",
      reason: "spawn_error",
      retryable: true,
      sideEffectOutcome: "none",
      exitCode: null,
    }));
    const handler = createConnectorExecHandler(runner, () => "run-1", () => null);

    await handler({ prompt: "Read calendar" });
    await handler({ prompt: "Read calendar again" });

    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("fails fast without spawning while a fresh health probe is broken", async () => {
    const runner = vi.fn(async () => result());
    const handler = createConnectorExecHandler(
      runner,
      () => "run-1",
      () => ({ status: "broken", since: 1000, checkedAt: 2000 }),
    );

    const response = await handler({ prompt: "Read calendar" });

    expect(runner).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        status: "unavailable",
        reason: "connector_health_broken",
        retryable: false,
        sideEffectOutcome: "none",
        nextSafeAction: "repair_connector_auth",
      },
    });
  });

  it("rejects a parallel call instead of queueing a second external action", async () => {
    let release!: (value: ConnectorRunResult) => void;
    const firstResult = new Promise<ConnectorRunResult>((resolve) => { release = resolve; });
    const runner = vi.fn(() => firstResult);
    const handler = createConnectorExecHandler(runner, () => "run-1", () => null);

    const first = handler({ prompt: "Create event" });
    const second = await handler({ prompt: "Create the same event" });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({
      isError: true,
      structuredContent: {
        status: "busy",
        reason: "connector_in_flight",
        retryable: true,
        sideEffectOutcome: "none",
      },
    });
    release(result({
      text: "CONNECTOR_WRITE_OK: Event created | ARTIFACT: event-123",
      toolEvidence: [{
        toolUseId: "tool-write-1",
        toolName: "mcp__claude_ai_Google_Calendar__create_event",
        effect: "write",
        success: true,
        artifacts: ["event-123"],
      }],
    }));
    await expect(first).resolves.toMatchObject({
      structuredContent: {
        status: "success",
        sideEffectOutcome: "confirmed",
        artifact: "event-123",
      },
    });
  });

  it("does not promote arbitrary prose to confirmed connector success", async () => {
    const runner = vi.fn(async () => result({ text: "The event probably exists." }));
    const handler = createConnectorExecHandler(runner, () => "run-1", () => null);

    const response = await handler({ prompt: "Create event" });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        status: "failed",
        reason: "unconfirmed_result",
        sideEffectOutcome: "unknown",
      },
    });
  });

  it("does not accept a read marker when no connector read tool succeeded", async () => {
    const runner = vi.fn(async () => result({ toolEvidence: [] }));
    const handler = createConnectorExecHandler(runner, () => "run-1", () => null);

    const response = await handler({ prompt: "List calendars" });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        status: "failed",
        reason: "unconfirmed_result",
        sideEffectOutcome: "unknown",
      },
    });
  });
});

describe("connector completion contract", () => {
  it("requires an artifact to confirm a write", () => {
    expect(parseConnectorCompletion(
      "CONNECTOR_WRITE_OK: Event created | ARTIFACT: event-123",
    )).toEqual({ status: "write_ok", summary: "Event created", artifact: "event-123" });
    expect(parseConnectorCompletion("CONNECTOR_WRITE_OK: Event created"))
      .toEqual({ status: "unknown" });
    expect(parseConnectorCompletion("CONNECTOR_WRITE_OK: Event created | ARTIFACT: unknown"))
      .toEqual({ status: "unknown" });
    expect(parseConnectorCompletion(
      "Done\nCONNECTOR_WRITE_OK: Event created | ARTIFACT: event-123",
    )).toEqual({ status: "unknown" });
  });

  it("distinguishes read-only completion from a confirmed write", () => {
    expect(parseConnectorCompletion("CONNECTOR_READ_OK: Listed calendars"))
      .toEqual({ status: "read_ok", summary: "Listed calendars" });
    expect(parseConnectorCompletion("CONNECTOR_FAIL: permission denied"))
      .toEqual({ status: "fail", reason: "permission denied" });
  });

  it("requires a matching successful provider tool result", () => {
    const completion = parseConnectorCompletion(
      "CONNECTOR_WRITE_OK: Event created | ARTIFACT: event-123",
    );
    expect(connectorCompletionHasProviderProof(completion, [])).toBe(false);
    expect(connectorCompletionHasProviderProof(completion, [{
      toolUseId: "tool-1",
      toolName: "mcp__claude_ai_Google_Calendar__create_event",
      effect: "write",
      success: true,
      artifacts: ["different-event"],
    }])).toBe(false);
    expect(connectorCompletionHasProviderProof(completion, [{
      toolUseId: "tool-1",
      toolName: "mcp__claude_ai_Google_Calendar__create_event",
      effect: "write",
      success: true,
      artifacts: ["event-123"],
    }])).toBe(true);
  });
});
