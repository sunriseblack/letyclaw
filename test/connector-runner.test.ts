import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runConnectorClaude } from "../lib.js";

const tempDirs: string[] = [];

function fakeClaude(body: string): { dir: string; executable: string } {
  const dir = mkdtempSync(join(tmpdir(), "letyclaw-connector-runner-"));
  tempDirs.push(dir);
  const executable = join(dir, "fake-claude");
  writeFileSync(executable, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { dir, executable };
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("supervised connector runner", () => {
  it("correlates a successful provider tool result with its returned artifacts", async () => {
    const records = [
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "tool-1",
            name: "mcp__claude_ai_Google_Calendar__create_event",
            input: { calendar_id: "primary", title: "Tennis" },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "{\"event\":{\"id\":\"event-123\"}}",
          }],
        },
        tool_use_result: {
          structuredContent: { event: { id: "event-123", htmlLink: "https://calendar.test/event-123" } },
        },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "CONNECTOR_WRITE_OK: Event created | ARTIFACT: event-123",
      },
    ];
    const body = records.map((record) =>
      `printf '%s\\n' '${JSON.stringify(record)}'`).join("\n");
    const fixture = fakeClaude(body);
    const result = await runConnectorClaude("test", {
      claudePath: fixture.executable,
      connectorHome: fixture.dir,
      timeoutMs: 5000,
      flockPath: null,
    });

    expect(result).toMatchObject({
      ok: true,
      text: "CONNECTOR_WRITE_OK: Event created | ARTIFACT: event-123",
      sideEffectOutcome: "unknown",
      toolEvidence: [{
        toolUseId: "tool-1",
        toolName: "mcp__claude_ai_Google_Calendar__create_event",
        effect: "write",
        success: true,
        artifacts: expect.arrayContaining(["event-123", "https://calendar.test/event-123"]),
      }],
    });
  });

  it("propagates its hard timeout as a typed ambiguous failure", async () => {
    const fixture = fakeClaude("sleep 2");
    const result = await runConnectorClaude("test", {
      claudePath: fixture.executable,
      connectorHome: fixture.dir,
      timeoutMs: 25,
      flockPath: null,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "timeout",
      timedOut: true,
      retryable: false,
      sideEffectOutcome: "unknown",
      exitCode: null,
      signal: "SIGKILL",
    });
    expect(result.text).not.toContain("(no output)");
  });

  it("returns a typed spawn error when no executor process started", async () => {
    const fixture = fakeClaude("exit 0");
    const result = await runConnectorClaude("test", {
      claudePath: join(fixture.dir, "missing-claude"),
      connectorHome: fixture.dir,
      timeoutMs: 1000,
      flockPath: null,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "spawn_error",
      timedOut: false,
      retryable: true,
      sideEffectOutcome: "none",
    });
  });

  it("bounds runaway executor output and fails closed", async () => {
    const fixture = fakeClaude(`printf '%s' '${"x".repeat(512)}'`);
    const result = await runConnectorClaude("test", {
      claudePath: fixture.executable,
      connectorHome: fixture.dir,
      timeoutMs: 5000,
      maxOutputBytes: 64,
      flockPath: null,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "output_too_large",
      timedOut: false,
      retryable: false,
      sideEffectOutcome: "unknown",
    });
  });

  it("caps stdout and stderr as one combined output budget", async () => {
    const fixture = fakeClaude("printf '%040d' 0; printf '%040d' 0 >&2");
    const result = await runConnectorClaude("test", {
      claudePath: fixture.executable,
      connectorHome: fixture.dir,
      timeoutMs: 5000,
      maxOutputBytes: 64,
      flockPath: null,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "output_too_large",
      sideEffectOutcome: "unknown",
    });
  });

  it("reports cross-process credential lock contention as safe retryable busy", async () => {
    const fixture = fakeClaude("exit 0");
    const flock = fakeClaude("exit 75");
    const result = await runConnectorClaude("test", {
      claudePath: fixture.executable,
      connectorHome: fixture.dir,
      flockPath: flock.executable,
      // This assertion is about exit-75 lock semantics, not scheduling speed.
      // Leave headroom for process startup when the full suite is saturated.
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "busy",
      retryable: true,
      sideEffectOutcome: "none",
      exitCode: 75,
    });
  });
});
