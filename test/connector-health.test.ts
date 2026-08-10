import { describe, expect, it } from "vitest";
import {
  CONNECTOR_HEALTH_MARKER,
  CONNECTOR_HEALTH_TOOL,
  assessConnectorProbe,
  connectorProbeEnv,
  type ConnectorProbeOutput,
} from "../scripts/connector-health-core.js";

function streamProbe({
  result = CONNECTOR_HEALTH_MARKER,
  includeTool = true,
  toolError = false,
  finalError = false,
}: {
  result?: string;
  includeTool?: boolean;
  toolError?: boolean;
  finalError?: boolean;
} = {}): ConnectorProbeOutput {
  const records: unknown[] = [];
  if (includeTool) {
    records.push({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "tool-1", name: CONNECTOR_HEALTH_TOOL, input: {} }] },
    });
    records.push({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "tool-1",
          content: toolError ? "authentication failed" : "{\"calendars\":[]}",
          is_error: toolError,
        }],
      },
      tool_use_result: toolError ? { isError: true } : { structuredContent: { calendars: [] } },
    });
  }
  records.push({ type: "result", subtype: "success", is_error: finalError, result });
  return {
    stdout: records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };
}

describe("connector health probe", () => {
  it("removes every setup-token/API-key override and pins connector HOME", () => {
    const env = connectorProbeEnv({
      PATH: "/bin",
      HOME: "/home/letyclaw",
      CLAUDE_CODE_OAUTH_TOKEN: "setup-token",
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      CLAUDE_CONFIG_DIR: "/wrong",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
      VAPI_API_KEY: "vapi-secret",
    }, "/connector");
    expect(env).toEqual({ PATH: "/bin", HOME: "/connector", LANG: "C.UTF-8" });
  });

  it("requires a matching successful Calendar tool result and exact final marker", () => {
    expect(assessConnectorProbe(streamProbe())).toEqual({ status: "ok", reason: "ok" });
    expect(assessConnectorProbe(streamProbe({ result: "hello" })))
      .toEqual({ status: "broken", reason: "unexpected_result" });
    expect(assessConnectorProbe(streamProbe({ includeTool: false })))
      .toEqual({ status: "broken", reason: "missing_tool_call" });
    expect(assessConnectorProbe(streamProbe({ toolError: true })))
      .toEqual({ status: "broken", reason: "tool_error" });
  });

  it("rejects provider errors and malformed stream output", () => {
    expect(assessConnectorProbe(streamProbe({
      result: "Failed to authenticate. API Error: 401",
      finalError: true,
    }))).toEqual({ status: "broken", reason: "provider_error" });
    expect(assessConnectorProbe({ ...streamProbe(), stdout: "not-json" }))
      .toEqual({ status: "broken", reason: "malformed_json" });
  });

  it("fails closed on timeout, non-zero exit, oversized output, and empty results", () => {
    expect(assessConnectorProbe({ ...streamProbe(), timedOut: true }).reason).toBe("timeout");
    expect(assessConnectorProbe({ ...streamProbe(), exitCode: 1 }).reason).toBe("cli_error");
    expect(assessConnectorProbe({ ...streamProbe(), outputTruncated: true }).reason).toBe("output_too_large");
    expect(assessConnectorProbe({ ...streamProbe(), stdout: "" }).reason).toBe("empty_result");
  });

  it("preserves prior health when the shared credential lock is busy", () => {
    expect(assessConnectorProbe({ ...streamProbe(), lockContended: true }))
      .toEqual({ status: "skipped", reason: "credential_busy" });
  });
});
