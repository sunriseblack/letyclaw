import { connectorClaudeEnv, looksLikeProviderFailure } from "../lib.js";

export const CONNECTOR_HEALTH_MARKER = "LETYCLAW_CALENDAR_CONNECTOR_OK";
export const CONNECTOR_HEALTH_TOOL = "mcp__claude_ai_Google_Calendar__list_calendars";

export interface ConnectorProbeOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputTruncated?: boolean;
  lockContended?: boolean;
}

export interface ConnectorProbeAssessment {
  status: "ok" | "broken" | "skipped";
  reason:
    | "ok"
    | "credential_busy"
    | "timeout"
    | "output_too_large"
    | "cli_error"
    | "malformed_json"
    | "provider_error"
    | "empty_result"
    | "missing_tool_call"
    | "tool_error"
    | "unexpected_result";
}

/**
 * Build an isolated environment for the connector credential probe.
 *
 * The production bot also has a long-lived setup token in its service
 * environment. Leaving that token visible here would make a dead connector
 * credential look healthy, so all API/setup-token overrides are removed and
 * HOME is pinned to the connector credential store.
 */
export function connectorProbeEnv(
  source: NodeJS.ProcessEnv,
  connectorHome: string,
): NodeJS.ProcessEnv {
  return connectorClaudeEnv(source, connectorHome);
}

/** Fail closed unless a real JSON-mode inference returned the probe marker. */
export function assessConnectorProbe(
  output: ConnectorProbeOutput,
  marker = CONNECTOR_HEALTH_MARKER,
  expectedTool = CONNECTOR_HEALTH_TOOL,
): ConnectorProbeAssessment {
  if (output.lockContended) return { status: "skipped", reason: "credential_busy" };
  if (output.timedOut) return { status: "broken", reason: "timeout" };
  if (output.outputTruncated) return { status: "broken", reason: "output_too_large" };
  if (output.exitCode !== 0) return { status: "broken", reason: "cli_error" };

  const records: Record<string, unknown>[] = [];
  for (const line of output.stdout.split("\n").map((value) => value.trim()).filter(Boolean)) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "broken", reason: "malformed_json" };
      }
      records.push(parsed as Record<string, unknown>);
    } catch {
      return { status: "broken", reason: "malformed_json" };
    }
  }
  if (records.length === 0) return { status: "broken", reason: "empty_result" };

  const targetToolIds = new Set<string>();
  let matchingToolResult = false;
  let matchingToolError = false;
  for (const record of records) {
    const message = record.message && typeof record.message === "object" && !Array.isArray(record.message)
      ? record.message as Record<string, unknown>
      : null;
    const topToolResult = record.tool_use_result && typeof record.tool_use_result === "object" &&
      !Array.isArray(record.tool_use_result)
      ? record.tool_use_result as Record<string, unknown>
      : null;
    const content = message && Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const block = item as Record<string, unknown>;
      if (block.type === "tool_use" && block.name === expectedTool && typeof block.id === "string") {
        targetToolIds.add(block.id);
      }
      if (block.type === "tool_result" && typeof block.tool_use_id === "string" &&
          targetToolIds.has(block.tool_use_id)) {
        const failed = block.is_error === true || block.isError === true || topToolResult?.isError === true ||
          looksLikeProviderFailure(String(block.content ?? topToolResult?.content ?? ""));
        matchingToolError ||= failed;
        matchingToolResult ||= !failed;
      }
    }
  }

  const final = [...records].reverse().find((record) => record.type === "result");
  const result = final && typeof final.result === "string" ? final.result.trim() : "";
  const combined = `${result}\n${output.stderr}`;
  if (final?.is_error === true || looksLikeProviderFailure(combined)) {
    return { status: "broken", reason: "provider_error" };
  }
  if (targetToolIds.size === 0) return { status: "broken", reason: "missing_tool_call" };
  if (matchingToolError || !matchingToolResult) return { status: "broken", reason: "tool_error" };
  if (!result) return { status: "broken", reason: "empty_result" };
  if (result !== marker) return { status: "broken", reason: "unexpected_result" };
  return { status: "ok", reason: "ok" };
}
