import { vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { SendPayload } from "../lib.js";
import {
  isRateLimited,
  getSessionFile,
  loadSession,
  saveSession,
  shouldRotateSession,
  lookupSessionByMessageId,
  createSession,
  pruneOldSessions,
  recordPendingMessageId,
  drainPendingMessageIds,
  buildTopicPrompt,
  loadDomainContext,
  loadSkillContext,
  readConfiguredSkill,
  isSessionExpiredError,
  parseClaudeResult,
  mdToTelegramHtml,
  splitMessage,
  htmlToPlainText,
  isTelegramHtmlParseError,
  extractCleanupTrailer,
  saveCleanupToken,
  loadCleanupToken,
  claimCleanupToken,
  unclaimCleanupToken,
  commitCleanupToken,
  updateCleanupToken,
  deleteCleanupToken,
  pruneStaleCleanupTokens,
  parseAdherenceCallback,
  saveSendToken,
  claimSendToken,
  commitSendToken,
  unclaimSendToken,
  deleteSendToken,
  parseApprovedExecutionReply,
  parseConnectorApprovedExecutionReply,
  pickRepliedAttachment,
  substituteDateTokens,
  dateInTimeZone,
  voiceTranscriptionTimeoutMs,
  replaceSendRow,
  classifyAuthProbe,
  decideAuthAlert,
  decideTokenExpiryWarning,
  looksLikeAuthFailure,
  looksLikeProviderFailure,
  connectorClaudeEnv,
  connectorReadHasProviderProof,
  connectorWriteHasProviderProof,
  parseConnectorClaudeOutput,
  createKeyedSerialQueue,
  canSafelyRetryClaudeAttempt,
  appendClaudeAttemptEvents,
  completeMissingToolResults,
  latestSessionIdFromEvents,
  collectClaudeStreamEvent,
  redactToolInputForLog,
  redactToolResultForLog,
  extractObsidianLinks,
  obsidianRedirectUrl,
} from "../lib.js";
import { readFileSync } from "fs";
import type { SessionData, RateLimitConfig } from "../types.js";
import type { AuthMonitorState } from "../lib.js";

// ──────────────────────────────────────────────
// pickRepliedAttachment
// ──────────────────────────────────────────────
describe("pickRepliedAttachment", () => {
  it("returns null when there is no replied-to message", () => {
    expect(pickRepliedAttachment(undefined, { document: { file_id: "x" } })).toBeNull();
  });

  it("returns null when the reply carries no attachment", () => {
    expect(pickRepliedAttachment({}, {})).toBeNull();
  });

  it("picks a document from the replied-to message", () => {
    const r = pickRepliedAttachment({ document: { file_id: "DOC1", file_name: "report.pdf" } }, {});
    expect(r).toEqual({ kind: "document", fileId: "DOC1", fileName: "report.pdf" });
  });

  it("skips the replied-to document when the incoming message already carries the same file", () => {
    const same = { file_id: "DOC1" };
    expect(pickRepliedAttachment({ document: same }, { document: same })).toBeNull();
  });

  it("still picks the replied-to document when the incoming message has a DIFFERENT document", () => {
    const r = pickRepliedAttachment({ document: { file_id: "DOC_OLD" } }, { document: { file_id: "DOC_NEW" } });
    expect(r).toEqual({ kind: "document", fileId: "DOC_OLD", fileName: undefined });
  });

  it("picks the largest photo size from the replied-to message", () => {
    const r = pickRepliedAttachment({ photo: [{ file_id: "SMALL" }, { file_id: "LARGE" }] }, {});
    expect(r).toEqual({ kind: "photo", fileId: "LARGE" });
  });

  it("does not pull a replied-to photo when the incoming message has its own photo", () => {
    expect(pickRepliedAttachment({ photo: [{ file_id: "R" }] }, { photo: [{ file_id: "C" }] })).toBeNull();
  });

  it("prefers a document over a photo when the reply has both", () => {
    const r = pickRepliedAttachment({ document: { file_id: "D" }, photo: [{ file_id: "P" }] }, {});
    expect(r).toEqual({ kind: "document", fileId: "D", fileName: undefined });
  });
});

// ──────────────────────────────────────────────
// parseClaudeResult
// ──────────────────────────────────────────────
describe("parseClaudeResult", () => {
  it("extracts result from stream-json with result line", () => {
    const input = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "thinking..." }] } }),
      JSON.stringify({ type: "result", session_id: "abc-123", result: "Hello there!" }),
    ].join("\n");
    const r = parseClaudeResult(input);
    expect(r.sessionId).toBe("abc-123");
    expect(r.text).toBe("Hello there!");
  });

  it("falls back to assistant text blocks when no result line", () => {
    const input = JSON.stringify({
      type: "assistant",
      session_id: "sid-1",
      message: { content: [{ type: "text", text: "Hi from assistant" }] },
    });
    const r = parseClaudeResult(input);
    expect(r.sessionId).toBe("sid-1");
    expect(r.text).toBe("Hi from assistant");
  });

  it("joins multiple text blocks in assistant message", () => {
    const input = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Part one" },
          { type: "tool_use", id: "t1" },
          { type: "text", text: "Part two" },
        ],
      },
    });
    const r = parseClaudeResult(input);
    expect(r.text).toBe("Part one\nPart two");
  });

  it("handles empty output", () => {
    const r = parseClaudeResult("");
    expect(r.text).toContain("Agent finished without a text response");
  });

  it("handles malformed JSON lines gracefully", () => {
    const input = [
      "not json at all",
      "{invalid json",
      JSON.stringify({ type: "result", session_id: "x", result: "Valid result" }),
    ].join("\n");
    const r = parseClaudeResult(input);
    expect(r.text).toBe("Valid result");
    expect(r.sessionId).toBe("x");
  });

  it("handles single JSON object (non-NDJSON)", () => {
    const input = JSON.stringify({ session_id: "s1", result: "done" });
    const r = parseClaudeResult(input);
    expect(r.sessionId).toBe("s1");
    expect(r.text).toBe("done");
  });

  it("returns fallback text when result field is empty", () => {
    const input = JSON.stringify({ session_id: "s1" });
    const r = parseClaudeResult(input);
    expect(r.text).toContain("Agent finished without a text response");
  });

  it("prefers result line over assistant text", () => {
    const input = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "assistant text" }] } }),
      JSON.stringify({ type: "result", session_id: "r1", result: "final result" }),
    ].join("\n");
    const r = parseClaudeResult(input);
    expect(r.text).toBe("final result");
  });

  it("preserves structured exit-0 provider errors", () => {
    const input = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "err-1",
      result: "An unrecognized provider-side failure",
    });
    expect(parseClaudeResult(input)).toEqual({
      sessionId: "err-1",
      text: "An unrecognized provider-side failure",
      isError: true,
      subtype: "success",
    });
  });

  it("preserves is_error for an empty-result multi-line stream", () => {
    const input = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "err-empty" }),
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "err-empty",
        result: "",
      }),
    ].join("\n");

    expect(parseClaudeResult(input)).toEqual({
      sessionId: "err-empty",
      text: "Claude reported an error without a result message.",
      isError: true,
      subtype: "error_during_execution",
    });
  });
});

describe("keyed turn serialization and retry safety", () => {
  it("serializes the same topic so queued work observes committed session state", async () => {
    const runSerially = createKeyedSerialQueue<number>();
    const seen: string[] = [];
    let sessionId = "session-0";
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = runSerially(6, async () => {
      seen.push(`first:${sessionId}`);
      await firstGate;
      sessionId = "session-1";
    });
    const second = runSerially(6, async () => {
      seen.push(`second:${sessionId}`);
    });

    await vi.waitFor(() => expect(seen).toEqual(["first:session-0"]));
    releaseFirst();
    await runSerially.drain();
    await Promise.all([first, second]);
    expect(seen).toEqual(["first:session-0", "second:session-1"]);
  });

  it("does not let a failed turn wedge later work on the same topic", async () => {
    const runSerially = createKeyedSerialQueue<number>();
    await expect(runSerially(2, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(runSerially(2, async () => "recovered")).resolves.toBe("recovered");
  });

  it("allows a whole-turn retry only when the failed attempt made no tool calls", () => {
    expect(canSafelyRetryClaudeAttempt([
      { ts: "2026-07-09T00:00:00Z", event: "result" },
    ])).toBe(true);
    expect(canSafelyRetryClaudeAttempt([
      { ts: "2026-07-09T00:00:00Z", event: "tool_call", tool: "message_send" },
    ])).toBe(false);
  });

  it("recovers the newest session id from stream events of a killed run", () => {
    // A timed-out run has an init event but no result event — the init id
    // must be enough to resume. A later attempt's id must win over earlier ones.
    expect(latestSessionIdFromEvents([
      { ts: "2026-07-16T07:22:50Z", event: "init", sessionId: "sess-original" },
      { ts: "2026-07-16T07:42:44Z", event: "tool_call", tool: "connector_exec" },
    ])).toBe("sess-original");
    expect(latestSessionIdFromEvents([
      { ts: "2026-07-16T07:22:50Z", event: "init", sessionId: "sess-original" },
      { ts: "2026-07-16T07:42:50Z", event: "init", sessionId: "sess-continuation-fork" },
      { ts: "2026-07-16T07:50:00Z", event: "tool_call", tool: "Read" },
    ])).toBe("sess-continuation-fork");
    expect(latestSessionIdFromEvents([
      { ts: "2026-07-16T07:22:50Z", event: "tool_call", tool: "Read" },
    ])).toBeUndefined();
    expect(latestSessionIdFromEvents([])).toBeUndefined();
  });

  it("retains prior-attempt events and tags each attempt", () => {
    const first = appendClaudeAttemptEvents([], [
      { ts: "2026-07-09T00:00:00Z", event: "result", turns: 1 },
    ], 1);
    const second = appendClaudeAttemptEvents(first.all, [
      { ts: "2026-07-09T00:00:01Z", event: "tool_call", tool: "memory_get" },
      { ts: "2026-07-09T00:00:02Z", event: "result", turns: 2 },
    ], 2);

    expect(second.all.map((event) => event.attempt)).toEqual([1, 2, 2]);
    expect(second.attemptEvents).toHaveLength(2);
    expect(first.all).toHaveLength(1);
  });

  it("records an explicit synthetic result when a tool call is interrupted", () => {
    const completed = completeMissingToolResults([
      { ts: "2026-07-09T00:00:00Z", event: "tool_call", tool: "browser_navigate", tool_use_id: "tool-1" },
    ], "timeout", "2026-07-09T00:01:00Z");
    expect(completed).toEqual([
      { ts: "2026-07-09T00:00:00Z", event: "tool_call", tool: "browser_navigate", tool_use_id: "tool-1" },
      {
        ts: "2026-07-09T00:01:00Z",
        event: "tool_result",
        tool_use_id: "tool-1",
        tool: "browser_navigate",
        isError: true,
        synthetic: true,
        content: "No tool result was observed before the Claude process ended (timeout).",
      },
    ]);
  });

  it("normalizes Claude CLI lifecycle, tool, and token/cache usage events", () => {
    const events: import("../types.js").StreamLogEvent[] = [];
    const ts = "2026-08-08T06:00:00.000Z";
    collectClaudeStreamEvent(JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "sess-1",
      model: "claude-opus-4-7",
      claude_code_version: "2.1.224",
      tools: ["Read", "mcp__playwright__browser_snapshot"],
      mcp_servers: [{ name: "letyclaw-tools", status: "connected" }],
    }), events, ts);
    collectClaudeStreamEvent(JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "text", text: "private assistant prose is not an audit event" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
      ] },
    }), events, ts);
    collectClaudeStreamEvent(JSON.stringify({
      type: "user",
      message: { content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "done", is_error: false },
      ] },
    }), events, ts);
    collectClaudeStreamEvent(JSON.stringify({
      type: "result",
      session_id: "sess-1",
      total_cost_usd: 0.42,
      duration_ms: 1200,
      duration_api_ms: 900,
      num_turns: 3,
      stop_reason: "end_turn",
      permission_denials: [{ tool: "Bash" }],
      usage: {
        input_tokens: 123,
        output_tokens: 45,
        cache_creation_input_tokens: 67,
        cache_read_input_tokens: 890,
      },
    }), events, ts);

    expect(events).toEqual([
      expect.objectContaining({
        event: "init",
        sessionId: "sess-1",
        model: "claude-opus-4-7",
        claudeVersion: "2.1.224",
        toolCount: 2,
        browserTools: ["mcp__playwright__browser_snapshot"],
      }),
      expect.objectContaining({ event: "tool_call", tool: "Read", tool_use_id: "tool-1" }),
      expect.objectContaining({ event: "tool_result", tool: "Read", content: "done" }),
      expect.objectContaining({
        event: "result",
        cost: 0.42,
        duration: 1200,
        apiDuration: 900,
        turns: 3,
        stopReason: "end_turn",
        permissionDenials: 1,
        usage: {
          inputTokens: 123,
          outputTokens: 45,
          cacheCreationInputTokens: 67,
          cacheReadInputTokens: 890,
        },
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("private assistant prose");
  });

  it("keeps compatibility with older cost_usd result streams", () => {
    const events: import("../types.js").StreamLogEvent[] = [];
    collectClaudeStreamEvent(JSON.stringify({ type: "result", cost_usd: 0.01 }), events);
    expect(events[0]?.cost).toBe(0.01);
  });

  it("redacts browser form text, secrets, code, and URL credentials from logs", () => {
    expect(redactToolInputForLog("mcp__playwright__browser_fill_form", {
      fields: [
        { name: "Email", type: "textbox", ref: "e1", value: "user@example.com" },
        { name: "Password", type: "textbox", ref: "e2", value: "correct-horse" },
      ],
    })).toEqual({
      fields: [
        { name: "Email", type: "textbox", ref: "e1", value: "<redacted>" },
        { name: "Password", type: "textbox", ref: "e2", value: "<redacted>" },
      ],
    });

    expect(redactToolInputForLog("mcp__playwright__browser_navigate", {
      url: "https://user:pass@example.com/login?token=abc#otp",
    })).toEqual({ url: "https://example.com/<path-redacted>?<redacted>#<redacted>" });
    expect(redactToolInputForLog("mcp__playwright__browser_run_code_unsafe", {
      code: "process.env",
    })).toEqual({ code: "<redacted>" });
    expect(redactToolInputForLog("mcp__playwright__browser_evaluate", {
      function: "() => document.cookie",
    })).toEqual({ function: "<redacted>" });
    expect(redactToolInputForLog("mcp__playwright__browser_handle_dialog", {
      accept: true,
      promptText: "123456",
    })).toEqual({ accept: true, promptText: "<redacted>" });
  });

  it("never persists raw browser tool results", () => {
    const page = "Email user@example.com, booking ABC123, token secret";
    expect(redactToolResultForLog("mcp__playwright__browser_snapshot", page))
      .toBe(`<browser result redacted; chars=${page.length}>`);
    expect(redactToolResultForLog("mcp__letyclaw-tools__memory_get", page)).toBe(page);
  });

  it("does not alter non-browser tool inputs", () => {
    const input = { text: "normal memory text", value: 42 };
    expect(redactToolInputForLog("mcp__letyclaw-tools__memory_save", input)).toBe(input);
  });
});

// ──────────────────────────────────────────────
// isSessionExpiredError
// ──────────────────────────────────────────────
describe("isSessionExpiredError", () => {
  it("detects 'no conversation found'", () => {
    expect(isSessionExpiredError("No conversation found for id", "")).toBe(true);
  });

  it("detects 'session_expired'", () => {
    expect(isSessionExpiredError("", "session_expired")).toBe(true);
  });

  it("detects 'session not found'", () => {
    expect(isSessionExpiredError("Session not found", "")).toBe(true);
  });

  it("detects 'could not resume'", () => {
    expect(isSessionExpiredError("Could not resume session", "")).toBe(true);
  });

  it("is case insensitive", () => {
    expect(isSessionExpiredError("", "SESSION_EXPIRED")).toBe(true);
    expect(isSessionExpiredError("NO CONVERSATION FOUND", "")).toBe(true);
  });

  it("returns false for normal output", () => {
    expect(isSessionExpiredError("Everything is fine", "No errors")).toBe(false);
  });

  it("checks combined stdout+stderr", () => {
    expect(isSessionExpiredError("session not found", "")).toBe(true);
    expect(isSessionExpiredError("", "session not found")).toBe(true);
  });
});

// ──────────────────────────────────────────────
// mdToTelegramHtml
// ──────────────────────────────────────────────
describe("mdToTelegramHtml", () => {
  it("converts headers to bold", () => {
    expect(mdToTelegramHtml("# Title")).toContain("<b>Title</b>");
    expect(mdToTelegramHtml("## Subtitle")).toContain("<b>Subtitle</b>");
    expect(mdToTelegramHtml("### H3")).toContain("<b>H3</b>");
  });

  it("converts **bold**", () => {
    expect(mdToTelegramHtml("**bold text**")).toContain("<b>bold text</b>");
  });

  it("converts __bold__", () => {
    expect(mdToTelegramHtml("__bold text__")).toContain("<b>bold text</b>");
  });

  it("converts *italic*", () => {
    expect(mdToTelegramHtml("*italic text*")).toContain("<i>italic text</i>");
  });

  it("converts _italic_ with word boundaries", () => {
    expect(mdToTelegramHtml("use _italic_ here")).toContain("<i>italic</i>");
  });

  it("converts ~~strikethrough~~", () => {
    expect(mdToTelegramHtml("~~deleted~~")).toContain("<s>deleted</s>");
  });

  it("strips outer <![CDATA[ ... ]]> wrappers", () => {
    const result = mdToTelegramHtml("<![CDATA[**bold**]]>");
    expect(result).not.toContain("CDATA");
    expect(result).toContain("<b>bold</b>");
  });

  it("strips nested CDATA wrappers", () => {
    const result = mdToTelegramHtml("<![CDATA[<![CDATA[plain]]>]]>");
    expect(result).not.toContain("CDATA");
    expect(result.trim()).toBe("plain");
  });

  it("converts [links](url)", () => {
    const result = mdToTelegramHtml("[Click](https://example.com)");
    expect(result).toContain('<a href="https://example.com">Click</a>');
  });

  it("converts fenced code blocks with language", () => {
    const result = mdToTelegramHtml("```js\nconst x = 1;\n```");
    expect(result).toContain('<pre><code class="language-js">');
    expect(result).toContain("const x = 1;");
  });

  it("converts fenced code blocks without language", () => {
    const result = mdToTelegramHtml("```\nhello\n```");
    expect(result).toContain("<pre>");
    expect(result).toContain("hello");
    expect(result).not.toContain("<code");
  });

  it("converts inline code", () => {
    const result = mdToTelegramHtml("use `npm install` here");
    expect(result).toContain("<code>npm install</code>");
  });

  it("converts blockquotes", () => {
    const result = mdToTelegramHtml("> quoted text");
    expect(result).toContain("<blockquote>quoted text</blockquote>");
  });

  it("merges consecutive blockquotes", () => {
    const result = mdToTelegramHtml("> line1\n> line2");
    expect(result).not.toContain("</blockquote>\n<blockquote>");
  });

  it("escapes HTML entities outside code blocks", () => {
    const result = mdToTelegramHtml("x < y && z > w");
    expect(result).toContain("&lt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&gt;");
  });

  it("preserves HTML entities inside code blocks", () => {
    const result = mdToTelegramHtml("```\na < b\n```");
    expect(result).toContain("&lt;");
  });

  it("preserves HTML entities inside inline code", () => {
    const result = mdToTelegramHtml("`a < b`");
    expect(result).toContain("<code>a &lt; b</code>");
  });

  it("handles empty string", () => {
    expect(mdToTelegramHtml("")).toBe("");
  });

  it("handles plain text without markdown", () => {
    expect(mdToTelegramHtml("Hello world")).toBe("Hello world");
  });

  it("converts Markdown tables to pre blocks", () => {
    const table = "| Name | Amount |\n|------|--------|\n| Rent | 800 |\n| Food | 200 |";
    const result = mdToTelegramHtml(table);
    expect(result).toContain("<pre>");
    expect(result).toContain("Rent");
    expect(result).toContain("Food");
    // Should NOT contain pipe characters as raw table formatting
    expect(result).not.toContain("|");
  });

  it("pivots a wide comparison table into vertical cards (no pre grid)", () => {
    const table =
      "| | PongBot Pace S Pro | Tenniix Pro |\n" +
      "|---|---|---|\n" +
      "| Price (direct) | $1,239 USD ([store](https://pongbot.com)) | $999 USD |\n" +
      "| Weight | ~17 kg, needs a car trunk to move | ~8 kg backpack-portable |";
    const result = mdToTelegramHtml(table);
    // No monospace grid and no raw pipes
    expect(result).not.toContain("<pre>");
    expect(result).not.toContain("|");
    // Row title becomes a bold heading
    expect(result).toContain("<b>Price (direct)</b>");
    // Cells are labeled with their column header, one per line
    expect(result).toContain("• PongBot Pace S Pro: $1,239");
    expect(result).toContain("• Tenniix Pro: $999");
    // Links inside cells survive as tappable anchors
    expect(result).toContain('<a href="https://pongbot.com">store</a>');
  });

  it("keeps narrow tables as a compact pre grid", () => {
    const table = "| Q | A |\n|---|---|\n| 1 | yes |\n| 2 | no |";
    const result = mdToTelegramHtml(table);
    expect(result).toContain("<pre>");
    expect(result).not.toContain("|");
  });

  it("converts unordered list markers to bullet points", () => {
    const result = mdToTelegramHtml("- First item\n- Second item");
    expect(result).toContain("• First item");
    expect(result).toContain("• Second item");
    expect(result).not.toContain("- First");
  });

  it("does not mangle formatting inside code blocks", () => {
    const result = mdToTelegramHtml("```\n**not bold** and _not italic_\n```");
    expect(result).not.toContain("<b>not bold</b>");
    expect(result).not.toContain("<i>not italic</i>");
    expect(result).toContain("<pre>");
  });
});

// ──────────────────────────────────────────────
// splitMessage
// ──────────────────────────────────────────────
describe("splitMessage", () => {
  it("returns single-element array for short text", () => {
    const result = splitMessage("hello", 4000);
    expect(result).toEqual(["hello"]);
  });

  it("splits at paragraph boundary", () => {
    const para1 = "A".repeat(2500);
    const para2 = "B".repeat(2500);
    const text = `${para1}\n\n${para2}`;
    const result = splitMessage(text, 4000);
    expect(result.length).toBe(2);
    expect(result[0]).toContain("A");
    expect(result[1]).toContain("B");
  });

  it("splits at line boundary when no paragraph break", () => {
    const line1 = "A".repeat(2500);
    const line2 = "B".repeat(2500);
    const text = `${line1}\n${line2}`;
    const result = splitMessage(text, 4000);
    expect(result.length).toBe(2);
  });

  it("splits at space when no line break", () => {
    const words = Array(500).fill("word").join(" ");
    const result = splitMessage(words, 100);
    expect(result.length).toBeGreaterThan(1);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i]!.endsWith(" ") || result[i + 1]!.startsWith("w")).toBe(true);
    }
  });

  it("forces hard split when no space found", () => {
    const text = "a".repeat(5000);
    const result = splitMessage(text, 4000);
    expect(result.length).toBe(2);
    expect(result[0]!.length).toBe(4000);
    expect(result[1]!.length).toBe(1000);
  });

  it("handles exact boundary", () => {
    const text = "x".repeat(4000);
    const result = splitMessage(text, 4000);
    expect(result).toEqual([text]);
  });

  it("handles text just over boundary", () => {
    const text = "x".repeat(4001);
    const result = splitMessage(text, 4000);
    expect(result.length).toBe(2);
  });

  it("preserves all content across chunks", () => {
    const text = "Hello world, this is a test. ".repeat(200);
    const chunks = splitMessage(text, 100);
    const reassembled = chunks.join("");
    expect(reassembled).toBe(text);
  });

  it("does not cut inside an HTML tag (backs up to before the '<')", () => {
    // Construct text where the natural hard-split at maxLen lands inside <a ...>.
    const head = "x".repeat(95);
    const text = `${head}<a href="https://example.com/very/long">link</a>`;
    const chunks = splitMessage(text, 100);
    // No chunk may contain an unclosed '<' tag (a '<' with no later '>').
    for (const c of chunks) {
      const lastOpen = c.lastIndexOf("<");
      if (lastOpen >= 0) {
        expect(c.indexOf(">", lastOpen)).toBeGreaterThan(lastOpen);
      }
    }
    // Invariant preserved: chunks still reassemble to the input.
    expect(chunks.join("")).toBe(text);
  });
});

// ──────────────────────────────────────────────
// htmlToPlainText (parse-error fallback)
// ──────────────────────────────────────────────
describe("htmlToPlainText", () => {
  it("strips tags and unescapes the 3 entities", () => {
    expect(htmlToPlainText("<b>bold</b> &amp; <a href=\"x\">link</a>"))
      .toBe("bold & link");
    expect(htmlToPlainText("1 &lt; 2 &gt; 0")).toBe("1 < 2 > 0");
  });

  it("leaves plain text unchanged", () => {
    expect(htmlToPlainText("just words")).toBe("just words");
  });
});

describe("isTelegramHtmlParseError", () => {
  it("accepts only explicit 400 entity parsing failures", () => {
    expect(isTelegramHtmlParseError({
      response: { statusCode: 400, body: { description: "Bad Request: can't parse entities" } },
    })).toBe(true);
    expect(isTelegramHtmlParseError({
      response: { statusCode: 429, body: { description: "Too Many Requests" } },
    })).toBe(false);
    expect(isTelegramHtmlParseError({
      response: { statusCode: 502, body: "Bad Gateway" },
    })).toBe(false);
    expect(isTelegramHtmlParseError(new Error("socket hang up"))).toBe(false);
  });
});

// ──────────────────────────────────────────────
// isRateLimited
// ──────────────────────────────────────────────
describe("isRateLimited", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns false when under limit", () => {
    const limiter = new Map<number, number[]>();
    expect(isRateLimited(limiter, 1, { maxRequests: 10, windowMs: 60000 })).toBe(false);
  });

  it("returns true when at limit", () => {
    const limiter = new Map<number, number[]>();
    const opts: RateLimitConfig = { maxRequests: 3, windowMs: 60000 };
    isRateLimited(limiter, 1, opts);
    isRateLimited(limiter, 1, opts);
    isRateLimited(limiter, 1, opts);
    expect(isRateLimited(limiter, 1, opts)).toBe(true);
  });

  it("resets after window expiry", () => {
    const limiter = new Map<number, number[]>();
    const opts: RateLimitConfig = { maxRequests: 2, windowMs: 60000 };
    isRateLimited(limiter, 1, opts);
    isRateLimited(limiter, 1, opts);
    expect(isRateLimited(limiter, 1, opts)).toBe(true);

    vi.advanceTimersByTime(60001);
    expect(isRateLimited(limiter, 1, opts)).toBe(false);
  });

  it("tracks separate users independently", () => {
    const limiter = new Map<number, number[]>();
    const opts: RateLimitConfig = { maxRequests: 1, windowMs: 60000 };
    isRateLimited(limiter, 1, opts);
    expect(isRateLimited(limiter, 1, opts)).toBe(true);
    expect(isRateLimited(limiter, 2, opts)).toBe(false);
  });
});

// ──────────────────────────────────────────────
// getSessionFile
// ──────────────────────────────────────────────
describe("getSessionFile", () => {
  it("computes correct path", () => {
    expect(getSessionFile("/tmp/sessions", "personal", 42)).toBe(
      "/tmp/sessions/personal-topic-42.json"
    );
  });
});

// ──────────────────────────────────────────────
// Session lifecycle: loadSession / saveSession / deleteSession
// ──────────────────────────────────────────────
describe("session lifecycle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saveSession creates file, loadSession reads it back", () => {
    const data: SessionData = { currentSessionId: "sess-123", createdAt: Date.now(), messageMap: {} };
    saveSession(tmpDir, "personal", 2, data);
    const session = loadSession(tmpDir, "personal", 2);
    expect(session).not.toBeNull();
    expect(session!.currentSessionId).toBe("sess-123");
    expect(session!.createdAt).toBeTypeOf("number");
  });

  it("loadSession returns null for missing file", () => {
    expect(loadSession(tmpDir, "nonexistent", 99)).toBeNull();
  });

  it("loadSession returns null for corrupted JSON", () => {
    const file = getSessionFile(tmpDir, "agent", 1);
    writeFileSync(file, "not json{{{");
    expect(loadSession(tmpDir, "agent", 1)).toBeNull();
  });

  it("loadSession migrates old format by adding messageMap", () => {
    const file = getSessionFile(tmpDir, "agent", 1);
    writeFileSync(file, JSON.stringify({ sessionId: "old-id", createdAt: 12345, updatedAt: 12345 }));
    const session = loadSession(tmpDir, "agent", 1);
    expect(session!.messageMap).toEqual({});
  });

  it("saveSession writes atomically and leaves no .tmp behind", () => {
    const data: SessionData = { currentSessionId: "s1", createdAt: Date.now(), messageMap: {} };
    saveSession(tmpDir, "agent", 1, data);
    const file = getSessionFile(tmpDir, "agent", 1);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  it("second saveSession snapshots the prior value to .bak", () => {
    saveSession(tmpDir, "agent", 1, { currentSessionId: "first", createdAt: 1, messageMap: {} });
    saveSession(tmpDir, "agent", 1, { currentSessionId: "second", createdAt: 2, messageMap: {} });
    const bak = `${getSessionFile(tmpDir, "agent", 1)}.bak`;
    expect(existsSync(bak)).toBe(true);
    expect(JSON.parse(readFileSync(bak, "utf8")).currentSessionId).toBe("first");
  });

  it("loadSession recovers from .bak when the primary file is corrupt", () => {
    // Establish a good .bak, then corrupt the primary (simulates a crash that
    // truncated the rename target mid-write).
    saveSession(tmpDir, "agent", 1, { currentSessionId: "good", createdAt: 1, messageMap: {} });
    saveSession(tmpDir, "agent", 1, { currentSessionId: "newer", createdAt: 2, messageMap: {} });
    const file = getSessionFile(tmpDir, "agent", 1);
    writeFileSync(file, "truncated{{{"); // corrupt primary
    const session = loadSession(tmpDir, "agent", 1);
    expect(session).not.toBeNull();
    // .bak holds the prior good value ("good"); recovery returns it rather than null.
    expect(session!.currentSessionId).toBe("good");
  });

  it("loadSession still returns null when both primary and .bak are corrupt/absent", () => {
    const file = getSessionFile(tmpDir, "agent", 1);
    writeFileSync(file, "not json{{{");
    expect(loadSession(tmpDir, "agent", 1)).toBeNull();
  });
});

// ──────────────────────────────────────────────
// Pending message-id sidecar (mid-run msg_id -> sessionId continuity)
// ──────────────────────────────────────────────
describe("pending message-id sidecar", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-pend-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("records ids per topic and drains them in order", () => {
    recordPendingMessageId(tmpDir, 2, 1001);
    recordPendingMessageId(tmpDir, 2, 1002);
    expect(drainPendingMessageIds(tmpDir, 2)).toEqual([1001, 1002]);
  });

  it("drain is destructive — a second drain returns empty", () => {
    recordPendingMessageId(tmpDir, 2, 1001);
    expect(drainPendingMessageIds(tmpDir, 2)).toEqual([1001]);
    expect(drainPendingMessageIds(tmpDir, 2)).toEqual([]); // no cross-run bleed
  });

  it("isolates ids by topic", () => {
    recordPendingMessageId(tmpDir, 2, 1001);
    recordPendingMessageId(tmpDir, 5, 2001);
    expect(drainPendingMessageIds(tmpDir, 2)).toEqual([1001]);
    expect(drainPendingMessageIds(tmpDir, 5)).toEqual([2001]);
  });

  it("drain of an untouched topic returns empty (no file)", () => {
    expect(drainPendingMessageIds(tmpDir, 99)).toEqual([]);
  });
});

// ──────────────────────────────────────────────
// Send-token atomic claim (double-send prevention)
// ──────────────────────────────────────────────
describe("send token claim", () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-send-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("claimSendToken returns the payload exactly once; a second claim returns null", () => {
    const token = saveSendToken(
      tmpDir,
      { kind: "slack", instruction: "post hi" },
      { topicId: 2, sourceSessionId: "session-before-delivery" },
    );
    const first = claimSendToken(tmpDir, token);
    const second = claimSendToken(tmpDir, token);
    expect(first).not.toBeNull();
    expect(first!.kind).toBe("slack");
    expect(first!.sourceSessionId).toBe("session-before-delivery");
    expect(second).toBeNull(); // the double-tap loses the race
  });

  it("unclaimSendToken makes a claimed token claimable again (retry path)", () => {
    const token = saveSendToken(tmpDir, { kind: "slack", instruction: "x" }, { topicId: 2 });
    expect(claimSendToken(tmpDir, token)).not.toBeNull();
    expect(claimSendToken(tmpDir, token)).toBeNull();
    unclaimSendToken(tmpDir, token);
    expect(claimSendToken(tmpDir, token)).not.toBeNull(); // retry succeeds
  });

  it("deleteSendToken removes both .json and .claimed forms", () => {
    const token = saveSendToken(tmpDir, { kind: "slack", instruction: "x" }, { topicId: 2 });
    claimSendToken(tmpDir, token); // -> .claimed
    deleteSendToken(tmpDir, token);
    expect(existsSync(join(tmpDir, `${token}.json`))).toBe(false);
    expect(existsSync(join(tmpDir, `${token}.claimed`))).toBe(false);
    expect(claimSendToken(tmpDir, token)).toBeNull();
  });

  it("a committed voice call cannot be resurrected after a UI failure", () => {
    const token = saveSendToken(tmpDir, {
      kind: "voice",
      phone_number: "+34612345678",
      task: "Confirm the reservation",
    }, { topicId: 2 });
    expect(claimSendToken(tmpDir, token)).not.toBeNull();

    expect(commitSendToken(tmpDir, token, {
      provider: "vapi",
      call_id: "call-paid-123",
      provider_status: "queued",
    })).toBe(true);

    // Simulate the old post-call failure recovery path attempting to unclaim
    // after Telegram rejected the button edit/confirmation message.
    unclaimSendToken(tmpDir, token);

    expect(claimSendToken(tmpDir, token)).toBeNull();
    expect(existsSync(join(tmpDir, `${token}.json`))).toBe(false);
    expect(existsSync(join(tmpDir, `${token}.claimed`))).toBe(false);
    const tombstone = JSON.parse(readFileSync(join(tmpDir, `${token}.committed`), "utf8")) as {
      commit: { call_id: string };
    };
    expect(tombstone.commit.call_id).toBe("call-paid-123");

    // A stale Cancel callback may still arrive if Telegram failed before it
    // could edit the keyboard. Generic pending-token cleanup must retain the
    // committed audit/dedupe tombstone.
    deleteSendToken(tmpDir, token);
    expect(existsSync(join(tmpDir, `${token}.committed`))).toBe(true);
  });

  it.each([
    ["gmail", { kind: "gmail", account: "default", to: ["test@example.com"], subject: "Hi", body: "Hello" }],
    ["connector", { kind: "connector", instruction: "Create the approved calendar event" }],
    ["slack", { kind: "slack", instruction: "Post the approved message" }],
    ["tool", { kind: "tool", tool_name: "ticktick_create_task", tool_args: { title: "Approved" } }],
    ["agent", { kind: "agent", instruction: "Carry out the approved action" }],
  ] satisfies Array<[string, SendPayload]>) (
    "a committed %s action cannot be resurrected after confirmation failure",
    (_name, payload) => {
      const token = saveSendToken(tmpDir, payload, { topicId: 2 });
      expect(claimSendToken(tmpDir, token)).not.toBeNull();
      expect(commitSendToken(tmpDir, token, {
        kind: payload.kind,
        outcome: "unknown",
        phase: "execution_started",
      })).toBe(true);
      expect(commitSendToken(tmpDir, token, {
        outcome: "success",
        phase: "execution_completed",
        summary: "Done",
      })).toBe(true);

      // This is what the retry branch does for a genuine pre-commit failure.
      // It must be harmless after executeSend already returned success.
      unclaimSendToken(tmpDir, token);

      expect(claimSendToken(tmpDir, token)).toBeNull();
      const tombstone = JSON.parse(readFileSync(join(tmpDir, `${token}.committed`), "utf8")) as {
        commit: { kind: string; outcome: string; phase: string; summary: string };
      };
      expect(tombstone.commit).toMatchObject({
        kind: payload.kind,
        outcome: "success",
        phase: "execution_completed",
        summary: "Done",
      });
    },
  );

  it.each(["gmail", "connector", "tool", "voice"])(
    "keeps an ambiguous %s executor error committed and non-retryable",
    (kind) => {
      const payload: SendPayload = kind === "voice"
        ? { kind: "voice", phone_number: "+34612345678", task: "Test" }
        : kind === "gmail"
          ? { kind: "gmail", account: "default", to: ["test@example.com"], subject: "Test", body: "Test" }
          : kind === "tool"
            ? { kind: "tool", tool_name: "ticktick_create_task", tool_args: { title: "Test" } }
            : { kind: "connector", instruction: "Create an event" };
      const token = saveSendToken(tmpDir, payload, { topicId: 2 });
      expect(claimSendToken(tmpDir, token)).not.toBeNull();
      expect(commitSendToken(tmpDir, token, {
        kind,
        outcome: "unknown",
        phase: "execution_started",
      })).toBe(true);

      // Simulate timeout/lost provider response followed by the legacy retry
      // recovery. Updating the tombstone records the ambiguity; unclaim is a
      // no-op and a second external attempt is impossible.
      expect(commitSendToken(tmpDir, token, {
        outcome: "unknown",
        phase: "execution_returned_error",
        error: "timeout",
      })).toBe(true);
      unclaimSendToken(tmpDir, token);

      expect(claimSendToken(tmpDir, token)).toBeNull();
      const tombstone = JSON.parse(readFileSync(join(tmpDir, `${token}.committed`), "utf8")) as {
        commit: { outcome: string; phase: string; error: string };
      };
      expect(tombstone.commit).toMatchObject({
        outcome: "unknown",
        phase: "execution_returned_error",
        error: "timeout",
      });
    },
  );

  it("repairs a split committed+claimed state without making it retryable", () => {
    const token = saveSendToken(tmpDir, { kind: "connector", instruction: "Approved action" });
    expect(claimSendToken(tmpDir, token)).not.toBeNull();
    expect(commitSendToken(tmpDir, token, { outcome: "unknown" })).toBe(true);
    writeFileSync(join(tmpDir, `${token}.claimed`), JSON.stringify({
      kind: "connector",
      instruction: "Approved action",
      createdAt: Date.now(),
    }));

    expect(commitSendToken(tmpDir, token, { phase: "execution_returned_error" })).toBe(true);
    expect(existsSync(join(tmpDir, `${token}.claimed`))).toBe(false);
    unclaimSendToken(tmpDir, token);
    expect(claimSendToken(tmpDir, token)).toBeNull();
  });

  it("does not authorize execution when the committed tombstone was not created", () => {
    const token = saveSendToken(tmpDir, { kind: "voice", phone_number: "+34612345678", task: "Test" });
    expect(claimSendToken(tmpDir, token)).not.toBeNull();
    // A directory at the destination forces rename(file, destination) to fail
    // while leaving the claimed token in place.
    mkdirSync(join(tmpDir, `${token}.committed`));

    expect(commitSendToken(tmpDir, token, { phase: "execution_started" })).toBe(false);
    expect(existsSync(join(tmpDir, `${token}.claimed`))).toBe(true);
  });
});

describe("approved execution reply contract", () => {
  it("accepts exactly one SEND_OK marker", () => {
    expect(parseApprovedExecutionReply("SEND_OK: Event created")).toEqual({
      status: "ok",
      summary: "Event created",
    });
  });

  it("recognizes an explicit SEND_FAIL marker", () => {
    expect(parseApprovedExecutionReply("SEND_FAIL: Permission denied")).toEqual({
      status: "fail",
      reason: "Permission denied",
    });
  });

  it("does not infer success from arbitrary non-empty prose or conflicting markers", () => {
    expect(parseApprovedExecutionReply("I think the action probably completed.")).toEqual({ status: "unknown" });
    expect(parseApprovedExecutionReply("SEND_OK:\nI think it completed.")).toEqual({ status: "unknown" });
    expect(parseApprovedExecutionReply("SEND_OK: done\nSEND_FAIL: timeout")).toEqual({ status: "unknown" });
  });
});

describe("approved connector execution reply contract", () => {
  it("requires a provider artifact for connector write success", () => {
    expect(parseConnectorApprovedExecutionReply(
      "SEND_OK: Event created | ARTIFACT: event-123",
    )).toEqual({
      status: "ok",
      summary: "Event created",
      artifact: "event-123",
    });
    expect(parseConnectorApprovedExecutionReply("SEND_OK: Event created"))
      .toEqual({ status: "unknown" });
    expect(parseConnectorApprovedExecutionReply("SEND_OK: Event created | ARTIFACT: <provider ID>"))
      .toEqual({ status: "unknown" });
    expect(parseConnectorApprovedExecutionReply(
      "Done\nSEND_OK: Event created | ARTIFACT: event-1",
    )).toEqual({ status: "unknown" });
  });

  it("rejects conflicting or empty connector completion markers", () => {
    expect(parseConnectorApprovedExecutionReply(
      "SEND_OK: Event created | ARTIFACT: event-1\nSEND_FAIL: timeout",
    )).toEqual({ status: "unknown" });
    expect(parseConnectorApprovedExecutionReply("SEND_OK: Event created | ARTIFACT:"))
      .toEqual({ status: "unknown" });
  });

  it("requires the final artifact to match a successful write tool result", () => {
    expect(connectorWriteHasProviderProof("event-123", [])).toBe(false);
    expect(connectorWriteHasProviderProof("event-123", [{
      toolUseId: "tool-1",
      toolName: "mcp__claude_ai_Google_Calendar__create_event",
      effect: "write",
      success: true,
      artifacts: ["event-123"],
    }])).toBe(true);
    expect(connectorWriteHasProviderProof("event-123", [{
      toolUseId: "tool-1",
      toolName: "mcp__claude_ai_Google_Calendar__create_event",
      effect: "write",
      success: false,
      artifacts: ["event-123"],
    }])).toBe(false);
  });

  it("rejects mixed failed or unknown connector traces", () => {
    const failedRead = {
      toolUseId: "tool-read",
      toolName: "mcp__claude_ai_Google_Calendar__search_events",
      effect: "read" as const,
      success: false,
      artifacts: [],
    };
    const successfulWrite = {
      toolUseId: "tool-write",
      toolName: "mcp__claude_ai_Google_Calendar__create_event",
      effect: "write" as const,
      success: true,
      artifacts: ["event-123"],
    };
    const unknownConnector = {
      toolUseId: "tool-unknown",
      toolName: "mcp__claude_ai_Figma__use_figma",
      effect: "unknown" as const,
      success: true,
      artifacts: [],
    };

    expect(connectorWriteHasProviderProof("event-123", [failedRead, successfulWrite])).toBe(false);
    expect(connectorWriteHasProviderProof("event-123", [successfulWrite, unknownConnector])).toBe(false);
    expect(connectorReadHasProviderProof([failedRead])).toBe(false);
    expect(connectorReadHasProviderProof([{
      ...failedRead,
      success: true,
    }, unknownConnector])).toBe(false);
  });
});

// ──────────────────────────────────────────────
// createSession
// ──────────────────────────────────────────────
describe("createSession", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a session with null currentSessionId", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const session = createSession(tmpDir, "agent", 1);
    expect(session.currentSessionId).toBeNull();
    expect(session.createdAt).toBe(Date.now());
    expect(session.lastActivityAt).toBe(Date.now());
    expect(session.messageMap).toEqual({});
  });

  it("preserves existing messageMap when creating new session", () => {
    const data: SessionData = { currentSessionId: "old", createdAt: 100, messageMap: { "42": "sess-old" } };
    saveSession(tmpDir, "agent", 1, data);
    const session = createSession(tmpDir, "agent", 1);
    expect(session.messageMap).toEqual({ "42": "sess-old" });
    expect(session.currentSessionId).toBeNull();
  });
});

// ──────────────────────────────────────────────
// shouldRotateSession (24h TTL)
// ──────────────────────────────────────────────
describe("shouldRotateSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ttl24h = 24 * 60 * 60 * 1000;

  it("returns false when no session (null)", () => {
    expect(shouldRotateSession(null, ttl24h)).toBe(false);
  });

  it("returns true when session has no createdAt and no lastActivityAt", () => {
    expect(shouldRotateSession({ currentSessionId: "x" } as SessionData, ttl24h)).toBe(true);
  });

  it("returns true when idle TTL exceeded", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const session: SessionData = { currentSessionId: "s1", createdAt: Date.now(), lastActivityAt: Date.now(), messageMap: {} };

    vi.setSystemTime(new Date("2026-03-22T10:00:01"));
    expect(shouldRotateSession(session, ttl24h)).toBe(true);
  });

  it("returns false when activity is within TTL", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const session: SessionData = { currentSessionId: "s1", createdAt: Date.now(), lastActivityAt: Date.now(), messageMap: {} };

    vi.setSystemTime(new Date("2026-03-21T20:00:00"));
    expect(shouldRotateSession(session, ttl24h)).toBe(false);
  });

  it("returns false at exactly TTL boundary", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const now = Date.now();
    const session: SessionData = { currentSessionId: "s1", createdAt: now, lastActivityAt: now, messageMap: {} };

    vi.setSystemTime(now + ttl24h);
    expect(shouldRotateSession(session, ttl24h)).toBe(false);
  });

  it("keeps an old session alive while it is still being used (the regression)", () => {
    // createdAt is 31h ago — under the old createdAt-anchored rule this would
    // rotate — but lastActivityAt is seconds old, so an active conversation
    // must NOT rotate.
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const created = Date.now() - 31 * 3_600_000;
    const session: SessionData = { currentSessionId: "s1", createdAt: created, lastActivityAt: Date.now() - 5_000, messageMap: {} };
    expect(shouldRotateSession(session, ttl24h)).toBe(false);
  });

  it("rotates when idle even if created recently", () => {
    // Mirror image: created recently, but last activity was >24h ago.
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const session: SessionData = { currentSessionId: "s1", createdAt: Date.now() - 1000, lastActivityAt: Date.now() - 25 * 3_600_000, messageMap: {} };
    expect(shouldRotateSession(session, ttl24h)).toBe(true);
  });

  it("falls back to createdAt for pre-migration sessions without lastActivityAt", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const fresh: SessionData = { currentSessionId: "s1", createdAt: Date.now() - 1000, messageMap: {} };
    expect(shouldRotateSession(fresh, ttl24h)).toBe(false);
    const stale: SessionData = { currentSessionId: "s1", createdAt: Date.now() - 25 * 3_600_000, messageMap: {} };
    expect(shouldRotateSession(stale, ttl24h)).toBe(true);
  });
});

// ──────────────────────────────────────────────
// lookupSessionByMessageId / mapMessageToSession
// ──────────────────────────────────────────────
describe("message-to-session mapping", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when no session file exists", () => {
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 42)).toBeUndefined();
  });

  it("returns undefined when messageId not in map", () => {
    const data: SessionData = { currentSessionId: "s1", createdAt: Date.now(), messageMap: {} };
    saveSession(tmpDir, "agent", 1, data);
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 42)).toBeUndefined();
  });

  it("maps and looks up message IDs correctly", () => {
    const data: SessionData = { currentSessionId: "s1", createdAt: Date.now(), messageMap: {} };
    for (const id of [100, 101, 102]) data.messageMap[String(id)] = "sess-abc";
    saveSession(tmpDir, "agent", 1, data);

    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 100)).toBe("sess-abc");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 101)).toBe("sess-abc");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 102)).toBe("sess-abc");
  });

  it("handles multiple sessions with different message IDs", () => {
    const data: SessionData = { currentSessionId: "s1", createdAt: Date.now(), messageMap: { "100": "sess-1", "200": "sess-2" } };
    saveSession(tmpDir, "agent", 1, data);

    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 100)).toBe("sess-1");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 200)).toBe("sess-2");
  });
});

// ──────────────────────────────────────────────
// pruneOldSessions
// ──────────────────────────────────────────────
describe("pruneOldSessions", () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes files older than maxAge", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00"));
    writeFileSync(
      join(tmpDir, "old-topic-1.json"),
      JSON.stringify({ currentSessionId: "old", createdAt: Date.now(), messageMap: {} })
    );

    vi.setSystemTime(new Date("2026-03-01T00:00:00"));
    const pruned = pruneOldSessions(tmpDir, 30);
    expect(pruned).toBe(1);
    expect(existsSync(join(tmpDir, "old-topic-1.json"))).toBe(false);
  });

  it("keeps files newer than maxAge", () => {
    vi.setSystemTime(new Date("2026-03-20T00:00:00"));
    writeFileSync(
      join(tmpDir, "recent-topic-1.json"),
      JSON.stringify({ currentSessionId: "new", createdAt: Date.now(), messageMap: {} })
    );

    vi.setSystemTime(new Date("2026-03-21T00:00:00"));
    const pruned = pruneOldSessions(tmpDir, 30);
    expect(pruned).toBe(0);
    expect(existsSync(join(tmpDir, "recent-topic-1.json"))).toBe(true);
  });

  it("keeps an old session whose last activity is recent", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00"));
    const file = join(tmpDir, "active-topic-1.json");
    writeFileSync(file, JSON.stringify({
      currentSessionId: "active",
      createdAt: Date.now(),
      lastActivityAt: new Date("2026-02-28T23:00:00Z").getTime(),
      messageMap: {},
    }));

    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    expect(pruneOldSessions(tmpDir, 30)).toBe(0);
    expect(existsSync(file)).toBe(true);
  });

  it("deletes the backup too so a pruned session cannot be resurrected", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const file = getSessionFile(tmpDir, "stale", 1);
    const data = { currentSessionId: "stale", createdAt: Date.now(), messageMap: {} };
    writeFileSync(file, JSON.stringify(data));
    writeFileSync(`${file}.bak`, JSON.stringify(data));

    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    expect(pruneOldSessions(tmpDir, 30)).toBe(1);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.bak`)).toBe(false);
    expect(loadSession(tmpDir, "stale", 1)).toBeNull();
  });

  it("deletes a stale orphan backup so loadSession cannot resurrect it", () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const file = getSessionFile(tmpDir, "orphan", 1);
    writeFileSync(`${file}.bak`, JSON.stringify({
      currentSessionId: "stale-orphan",
      createdAt: Date.now(),
      messageMap: {},
    }));
    expect(loadSession(tmpDir, "orphan", 1)?.currentSessionId).toBe("stale-orphan");

    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    expect(pruneOldSessions(tmpDir, 30)).toBe(1);
    expect(existsSync(`${file}.bak`)).toBe(false);
    expect(loadSession(tmpDir, "orphan", 1)).toBeNull();
  });

  it("handles empty directory", () => {
    expect(pruneOldSessions(tmpDir, 30)).toBe(0);
  });

  it("handles malformed session files", () => {
    writeFileSync(join(tmpDir, "bad-topic-1.json"), "not json");
    expect(() => pruneOldSessions(tmpDir, 30)).not.toThrow();
  });

  it("ignores non-json files", () => {
    writeFileSync(join(tmpDir, "notes.txt"), "hello");
    expect(pruneOldSessions(tmpDir, 30)).toBe(0);
  });

  it("ignores non-session json files (e.g. token stores, hidden files)", () => {
    // Regression: the prune used to glob *.json, JSON-parse, and treat any
    // file missing createdAt as "ancient" (Date.now() - 0 >> maxAge). This
    // deleted /root/letyclaw/sessions/.withings-tokens.json every 6 hours and
    // broke the health pipeline until the next manual re-auth.
    writeFileSync(
      join(tmpDir, ".withings-tokens.json"),
      JSON.stringify({ access_token: "a", refresh_token: "r", expires_at: 123, user_id: "u" })
    );
    writeFileSync(
      join(tmpDir, "some-config.json"),
      JSON.stringify({ foo: "bar" })
    );
    vi.setSystemTime(new Date("2026-01-01T00:00:00"));
    writeFileSync(
      join(tmpDir, "health-topic-6.json"),
      JSON.stringify({ currentSessionId: "old", createdAt: Date.now(), messageMap: {} })
    );
    vi.setSystemTime(new Date("2026-03-01T00:00:00"));

    const pruned = pruneOldSessions(tmpDir, 30);
    expect(pruned).toBe(1);
    expect(existsSync(join(tmpDir, "health-topic-6.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".withings-tokens.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "some-config.json"))).toBe(true);
  });
});

// ──────────────────────────────────────────────
// buildTopicPrompt (domain routing)
// ──────────────────────────────────────────────
describe("buildTopicPrompt", () => {
  it("includes domain and topic ID", () => {
    const result = buildTopicPrompt("personal", 2, "hello");
    expect(result).toContain("[TOPIC: personal | Topic ID: 2]");
    expect(result).toContain("hello");
  });

  it("preserves full user message", () => {
    const msg = "Check my health logs and compare with finance spending";
    const result = buildTopicPrompt("health", 6, msg);
    expect(result).toContain(msg);
    expect(result).toContain("[TOPIC: health | Topic ID: 6]");
  });

  it("prepends the standing safety preamble on every turn", () => {
    const result = buildTopicPrompt("personal", 2, "hello");
    // The safety rules must precede the topic header and the user message.
    expect(result.startsWith("[Standing rules")).toBe(true);
    expect(result.indexOf("[Standing rules")).toBeLessThan(result.indexOf("[TOPIC:"));
    expect(result).toContain("require a separate approval button");
    expect(result).toContain("gmail_send tools are disabled");
    expect(result).toContain("Calendar, Notion, or Drive workspace may run directly");
    expect(result).toContain("Delete only when an authenticated request explicitly identifies");
  });

  it("makes the current Telegram message language override source material", () => {
    const result = buildTopicPrompt(
      "personal",
      5,
      "inspect the files, look up the web possible options for payment for me",
      undefined,
      undefined,
      "Alex",
    );

    expect(result).toContain("Reply in the language Alex used to address you");
    expect(result).toContain("current Telegram message");
    expect(result).toContain("source material is Spanish");
    expect(result.indexOf("Reply in the language Alex used")).toBeLessThan(result.indexOf("[TOPIC:"));
  });

});

// ──────────────────────────────────────────────
// Routed domain context + progressive skills
// ──────────────────────────────────────────────
describe("routed domain context", () => {
  let root: string;
  let projectRoot: string;
  let vaultPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "letyclaw-context-test-"));
    projectRoot = join(root, "project");
    vaultPath = join(root, "vault");
    mkdirSync(join(projectRoot, "agents", "source", "domains"), { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads only the routed domain and excludes sibling domain instructions", () => {
    writeFileSync(join(projectRoot, "agents", "source", "domains", "health.md"), "HEALTH_ONLY_RULE");
    writeFileSync(join(projectRoot, "agents", "source", "domains", "finance.md"), "FINANCE_SECRET_RULE");
    writeFileSync(join(projectRoot, "agents", "source", "domains", "legal.md"), "LEGAL_SECRET_RULE");

    const context = loadDomainContext("health", { projectRoot, vaultPath });

    expect(context).toContain("[ACTIVE DOMAIN RULES: health");
    expect(context).toContain("HEALTH_ONLY_RULE");
    expect(context).not.toContain("FINANCE_SECRET_RULE");
    expect(context).not.toContain("LEGAL_SECRET_RULE");
  });

  it("prefers the reviewed repository domain over a mutable vault mirror", () => {
    writeFileSync(join(projectRoot, "agents", "source", "domains", "health.md"), "REPOSITORY_HEALTH_RULE");
    mkdirSync(join(vaultPath, ".letyclaw", "domains"), { recursive: true });
    writeFileSync(join(vaultPath, ".letyclaw", "domains", "health.md"), "DEPLOYED_VAULT_HEALTH_RULE");

    const context = loadDomainContext("health", { projectRoot, vaultPath });

    expect(context).toContain("REPOSITORY_HEALTH_RULE");
    expect(context).not.toContain("DEPLOYED_VAULT_HEALTH_RULE");
  });

  it("rejects routed domain files that escape trusted roots through symlinks", () => {
    const outside = join(root, "outside-domain.md");
    writeFileSync(outside, "OUTSIDE_DOMAIN_SECRET");
    mkdirSync(join(vaultPath, ".letyclaw", "domains"), { recursive: true });
    symlinkSync(outside, join(vaultPath, ".letyclaw", "domains", "health.md"));

    expect(() => loadDomainContext("health", { projectRoot, vaultPath }))
      .toThrow(/escape trusted roots/);
  });

  it("rejects a routed domain symlink to a sibling domain", () => {
    const domains = join(vaultPath, ".letyclaw", "domains");
    mkdirSync(domains, { recursive: true });
    writeFileSync(join(domains, "finance.md"), "FINANCE_PRIVATE_RULE");
    symlinkSync(join(domains, "finance.md"), join(domains, "health.md"));

    expect(() => loadDomainContext("health", { projectRoot, vaultPath }))
      .toThrow(/escape trusted roots/);
  });
});

describe("progressive skill context", () => {
  let root: string;
  let projectRoot: string;
  let vaultPath: string;
  let skillRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "letyclaw-skill-test-"));
    projectRoot = join(root, "project");
    vaultPath = join(root, "vault");
    skillRoot = join(projectRoot, ".claude", "skills", "long-workflow");
    mkdirSync(join(skillRoot, "references"), { recursive: true });
    mkdirSync(vaultPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders metadata only instead of a skill body or a silently truncated prefix", () => {
    const body = `BODY_START\n${"workflow-body-".repeat(450)}\nBODY_END`;
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      `---\ndescription: Use for the long workflow trigger.\n---\n${body}`,
    );

    const catalog = loadSkillContext(["long-workflow"], {
      projectRoot,
      vaultPath,
      maxPerSkillChars: 4000,
    });

    expect(catalog).toContain("[AVAILABLE SKILLS - trusted metadata only]");
    expect(catalog).toContain("long-workflow: Use for the long workflow trigger.");
    expect(catalog).toContain("call skill_view");
    expect(catalog).not.toContain("BODY_START");
    expect(catalog).not.toContain("BODY_END");
    expect(catalog.length).toBeLessThan(1000);
  });

  it("reads complete skill and reference files larger than the old 4k limit", () => {
    const skillContent = `---\ndescription: Long workflow.\n---\n${"skill-step\n".repeat(500)}SKILL_END`;
    const referenceContent = `${"reference-detail\n".repeat(350)}REFERENCE_END`;
    writeFileSync(join(skillRoot, "SKILL.md"), skillContent);
    writeFileSync(join(skillRoot, "references", "guide.md"), referenceContent);
    const options = { projectRoot, vaultPath };

    const skill = readConfiguredSkill("long-workflow", undefined, ["long-workflow"], options);
    const reference = readConfiguredSkill(
      "long-workflow",
      "references/guide.md",
      ["long-workflow"],
      options,
    );

    expect(skill.content.length).toBeGreaterThan(4000);
    expect(skill.content).toBe(skillContent);
    expect(skill.content.endsWith("SKILL_END")).toBe(true);
    expect(reference.content.length).toBeGreaterThan(4000);
    expect(reference.content).toBe(referenceContent);
    expect(reference.content.endsWith("REFERENCE_END")).toBe(true);
  });

  it("rejects skills that are not enabled for the run", () => {
    writeFileSync(join(skillRoot, "SKILL.md"), "# Long workflow");

    expect(() => readConfiguredSkill(
      "long-workflow",
      undefined,
      ["different-skill"],
      { projectRoot, vaultPath },
    )).toThrow(/not enabled for this run/);
  });

  it("rejects parent traversal and symlinks that escape the skill package", () => {
    writeFileSync(join(skillRoot, "SKILL.md"), "# Long workflow");
    const outside = join(root, "outside.md");
    writeFileSync(outside, "OUTSIDE_SECRET");
    symlinkSync(outside, join(skillRoot, "references", "escape.md"));
    const options = { projectRoot, vaultPath };

    expect(() => readConfiguredSkill(
      "long-workflow",
      "../outside.md",
      ["long-workflow"],
      options,
    )).toThrow(/relative to the skill package/);
    expect(() => readConfiguredSkill(
      "long-workflow",
      "references/escape.md",
      ["long-workflow"],
      options,
    )).toThrow(/escapes its package/);
  });

  it("rejects a skill package symlinked outside the project and vault roots", () => {
    const outsidePackage = join(root, "outside-skill");
    mkdirSync(outsidePackage);
    writeFileSync(join(outsidePackage, "SKILL.md"), "# Outside skill secret");
    symlinkSync(outsidePackage, join(projectRoot, ".claude", "skills", "escaped-package"));

    expect(() => readConfiguredSkill(
      "escaped-package",
      undefined,
      ["escaped-package"],
      { projectRoot, vaultPath },
    )).toThrow(/not installed/);
  });

  it("rejects a skill package symlinked to non-skill content inside the project", () => {
    const privatePackage = join(projectRoot, "private-domain");
    mkdirSync(privatePackage);
    writeFileSync(join(privatePackage, "SKILL.md"), "# Not a reviewed skill package");
    symlinkSync(privatePackage, join(projectRoot, ".claude", "skills", "internal-leak"));

    expect(() => readConfiguredSkill(
      "internal-leak",
      undefined,
      ["internal-leak"],
      { projectRoot, vaultPath },
    )).toThrow(/not installed/);
  });
});

// ──────────────────────────────────────────────
// Session orchestration (simulates bot.js logic)
// ──────────────────────────────────────────────
describe("session orchestration", () => {
  let tmpDir: string;
  const ttl24h = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-test-"));
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Simulates bot.js lines 299-318: determine resumeSessionId
  function determineSession(agentId: string, topicId: number, replyToId: number | undefined): string | undefined {
    let resumeSessionId: string | undefined;

    if (replyToId) {
      resumeSessionId = lookupSessionByMessageId(tmpDir, agentId, topicId, replyToId);
    }

    if (!resumeSessionId) {
      const session = loadSession(tmpDir, agentId, topicId);
      if (session?.currentSessionId && !shouldRotateSession(session, ttl24h)) {
        resumeSessionId = session.currentSessionId;
      }
    }

    return resumeSessionId;
  }

  // Mirrors bot.ts: save session after Claude response
  function saveAfterResponse(agentId: string, topicId: number, resultSessionId: string, mode: string, messageIds: number[]): void {
    if (!resultSessionId) return;
    const session = mode === "fresh"
      ? createSession(tmpDir, agentId, topicId)
      : loadSession(tmpDir, agentId, topicId);
    if (!session) return;
    session.currentSessionId = resultSessionId;
    session.lastActivityAt = Date.now();
    for (const id of messageIds) {
      session.messageMap[String(id)] = resultSessionId;
    }
    saveSession(tmpDir, agentId, topicId, session);
  }

  it("first message creates session and allows continuation", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    // Message 1: no session exists → fresh
    const resume1 = determineSession("agent", 1, undefined);
    expect(resume1).toBeUndefined();

    // Claude responds with session-1
    const mode1 = resume1 ? "resume" : "fresh";
    saveAfterResponse("agent", 1, "sess-1", mode1, [100, 101]);

    const session = loadSession(tmpDir, "agent", 1);
    expect(session!.currentSessionId).toBe("sess-1");
    expect(session!.messageMap["100"]).toBe("sess-1");
  });

  it("consecutive non-reply messages resume current session within TTL", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    // Message 1: fresh
    const resume1 = determineSession("agent", 1, undefined);
    saveAfterResponse("agent", 1, "sess-1", "fresh", [100, 101]);

    // Message 2: 1 hour later, no reply → should continue sess-1
    vi.setSystemTime(new Date("2026-03-21T11:00:00"));
    const resume2 = determineSession("agent", 1, undefined);
    expect(resume2).toBe("sess-1");

    // Message 3: 5 hours later, no reply → still within 24h
    vi.setSystemTime(new Date("2026-03-21T15:00:00"));
    const resume3 = determineSession("agent", 1, undefined);
    expect(resume3).toBe("sess-1");
  });

  it("non-reply message after TTL expiry starts fresh", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    // Message 1: fresh
    const _resume1 = determineSession("agent", 1, undefined);
    saveAfterResponse("agent", 1, "sess-1", "fresh", [100, 101]);

    // Message 2: 25 hours later → TTL expired
    vi.setSystemTime(new Date("2026-03-22T11:00:01"));
    const resume2 = determineSession("agent", 1, undefined);
    expect(resume2).toBeUndefined();
  });

  it("createdAt resets after expiry so new session is resumable", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    // Message 1: fresh
    saveAfterResponse("agent", 1, "sess-1", "fresh", [100]);

    // Message 2: 25h later → expired, fresh start
    vi.setSystemTime(new Date("2026-03-22T11:00:01"));
    const resume2 = determineSession("agent", 1, undefined);
    expect(resume2).toBeUndefined();
    saveAfterResponse("agent", 1, "sess-2", "fresh", [200]);

    // Verify createdAt was reset
    const session = loadSession(tmpDir, "agent", 1);
    expect(session!.currentSessionId).toBe("sess-2");
    expect(session!.createdAt).toBe(Date.now());

    // Message 3: 1 hour later → should resume sess-2
    vi.setSystemTime(new Date("2026-03-22T12:00:00"));
    const resume3 = determineSession("agent", 1, undefined);
    expect(resume3).toBe("sess-2");
  });

  it("non-reply message does NOT fork off an old-but-still-active session (incident regression)", () => {
    // Reproduces the 2026-06-19 health-topic split: a session created >24h ago
    // but continuously used. Under the old createdAt-anchored TTL, a non-reply
    // message would rotate to a throwaway session while reply messages kept
    // resuming the original — splitting the conversation. With idle-based TTL,
    // every turn refreshes lastActivityAt, so the non-reply message continues.
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    saveAfterResponse("agent", 1, "sess-1", "fresh", [100, 101]);

    // 31h later the user is actively chatting again. A reply turn lands first
    // (reply-resume ignores TTL) and refreshes the idle clock.
    vi.setSystemTime(new Date("2026-03-22T17:00:00"));
    const replyResume = determineSession("agent", 1, 101);
    expect(replyResume).toBe("sess-1");
    saveAfterResponse("agent", 1, "sess-1", "resume", [110, 111]);

    // Seconds later, a plain (non-reply) message — the activity photo in the
    // incident. It must continue sess-1, not fork.
    vi.setSystemTime(new Date("2026-03-22T17:00:30"));
    const plainResume = determineSession("agent", 1, undefined);
    expect(plainResume).toBe("sess-1");
  });

  it("reply to old message resumes that session regardless of TTL", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    // Message 1: fresh, mapped to sess-1
    saveAfterResponse("agent", 1, "sess-1", "fresh", [100, 101]);

    // 48 hours later: reply to message 101 → should resume sess-1 despite TTL
    vi.setSystemTime(new Date("2026-03-23T10:00:00"));
    const resume = determineSession("agent", 1, 101);
    expect(resume).toBe("sess-1");
  });

  it("reply to unknown message falls back to current session", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    // Message 1: fresh
    saveAfterResponse("agent", 1, "sess-1", "fresh", [100]);

    // Reply to message 999 (not in map) → fall back to current session
    vi.setSystemTime(new Date("2026-03-21T11:00:00"));
    const resume = determineSession("agent", 1, 999);
    expect(resume).toBe("sess-1");
  });

  it("messageMap survives session rotation", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));

    // Session 1
    saveAfterResponse("agent", 1, "sess-1", "fresh", [100, 101]);

    // Session 2 (after expiry)
    vi.setSystemTime(new Date("2026-03-22T11:00:00"));
    saveAfterResponse("agent", 1, "sess-2", "fresh", [200, 201]);

    // Old messages still resolve to sess-1
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 100)).toBe("sess-1");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 101)).toBe("sess-1");

    // New messages resolve to sess-2
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 200)).toBe("sess-2");
  });
});


// ──────────────────────────────────────────────
// classifyAuthProbe
// ──────────────────────────────────────────────
describe("classifyAuthProbe", () => {
  const M = "CLAUDE_AUTH_PING_OK";
  const base = { stdout: "", stderr: "", exitCode: 0, timedOut: false, marker: M };

  it("ok when stdout echoes the marker", () => {
    expect(classifyAuthProbe({ ...base, stdout: `${M}\n` })).toBe("ok");
  });

  it("ok on clean exit even without the verbatim marker", () => {
    expect(classifyAuthProbe({ ...base, stdout: "sure, ok!", exitCode: 0 })).toBe("ok");
  });

  it("broken on timeout regardless of output", () => {
    expect(classifyAuthProbe({ ...base, stdout: `${M}`, timedOut: true })).toBe("broken");
  });

  it("broken on the real incident output (401 with exit 0)", () => {
    // The CLI can exit 0 while emitting an API-error result — the case that
    // slipped through and caused the silent outage.
    expect(classifyAuthProbe({ ...base, exitCode: 0, stderr: 'Failed to authenticate. API Error: 401 {"type":"error"}' })).toBe("broken");
  });

  it("broken on assorted auth-failure phrasings", () => {
    for (const s of ['{"status":401}', "authentication_error", "OAuth token has expired", "invalid bearer token"]) {
      expect(classifyAuthProbe({ ...base, stderr: s })).toBe("broken");
    }
  });

  it("broken on non-zero exit with no marker", () => {
    expect(classifyAuthProbe({ ...base, exitCode: 1, stdout: "" })).toBe("broken");
  });
});

// ──────────────────────────────────────────────
// decideAuthAlert
// ──────────────────────────────────────────────
describe("decideAuthAlert", () => {
  const REM = 6 * 3_600_000;
  const ok = (since: number, lastAlertAt: number | null = null): AuthMonitorState => ({ status: "ok", since, lastAlertAt });
  const broken = (since: number, lastAlertAt: number | null): AuthMonitorState => ({ status: "broken", since, lastAlertAt });

  it("alerts on the ok→broken edge", () => {
    const r = decideAuthAlert(ok(1000), "broken", 2000, REM);
    expect(r.send).toBe(true);
    expect(r.kind).toBe("down");
    expect(r.nextState).toEqual({ status: "broken", since: 2000, lastAlertAt: 2000 });
  });

  it("treats a null prior state as healthy so first-seen broken alerts", () => {
    const r = decideAuthAlert(null, "broken", 5000, REM);
    expect(r.send).toBe(true);
    expect(r.kind).toBe("down");
  });

  it("stays silent while broken until the reminder window elapses", () => {
    const r = decideAuthAlert(broken(0, 1000), "broken", 1000 + REM - 1, REM);
    expect(r.send).toBe(false);
    expect(r.kind).toBe("none");
    // since is preserved; lastAlertAt unchanged
    expect(r.nextState).toEqual({ status: "broken", since: 0, lastAlertAt: 1000 });
  });

  it("re-nags once the reminder window elapses", () => {
    const now = 1000 + REM;
    const r = decideAuthAlert(broken(0, 1000), "broken", now, REM);
    expect(r.send).toBe(true);
    expect(r.kind).toBe("reminder");
    expect(r.nextState).toEqual({ status: "broken", since: 0, lastAlertAt: now });
  });

  it("announces recovery on broken→ok", () => {
    const r = decideAuthAlert(broken(0, 1000), "ok", 9000, REM);
    expect(r.send).toBe(true);
    expect(r.kind).toBe("recovered");
    expect(r.nextState).toEqual({ status: "ok", since: 9000, lastAlertAt: null });
  });

  it("stays silent on steady-state ok", () => {
    const r = decideAuthAlert(ok(0), "ok", 9000, REM);
    expect(r.send).toBe(false);
    expect(r.kind).toBe("none");
  });
});

// ──────────────────────────────────────────────
// looksLikeAuthFailure (transient-401 retry signal)
// ──────────────────────────────────────────────
describe("looksLikeAuthFailure", () => {
  it("matches the real CLI auth-failure result text", () => {
    expect(looksLikeAuthFailure('Failed to authenticate. API Error: 401 {"type":"error"}')).toBe(true);
    expect(looksLikeAuthFailure("authentication_error")).toBe(true);
    expect(looksLikeAuthFailure("OAuth token has expired")).toBe(true);
    expect(looksLikeAuthFailure("This organization does not have access to Claude")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(looksLikeAuthFailure("FAILED TO AUTHENTICATE")).toBe(true);
  });
  it("does not match ordinary answers", () => {
    expect(looksLikeAuthFailure("Here are 401 reasons to book the flight.")).toBe(false);
    expect(looksLikeAuthFailure("All set — sent.")).toBe(false);
  });
});

describe("provider and connector failure normalization", () => {
  it("recognizes quota messages that previously shipped as cron output", () => {
    expect(looksLikeProviderFailure("You're out of extra usage · resets 11pm (UTC)")).toBe(true);
    expect(looksLikeProviderFailure("You've hit your session limit · resets 4pm")).toBe(true);
    expect(looksLikeProviderFailure("Usage credit limit reached")).toBe(true);
    expect(looksLikeProviderFailure("Fast limit reached and temporarily disabled")).toBe(true);
    expect(looksLikeProviderFailure("A normal useful answer")).toBe(false);
  });

  it("treats connector JSON is_error as failure even when the CLI exits 0", () => {
    const result = parseConnectorClaudeOutput(
      JSON.stringify({ is_error: true, result: "Failed to authenticate. API Error: 401" }),
      "",
      0,
    );
    expect(result.ok).toBe(false);
    expect(result.text).toContain("401");
  });

  it("accepts a clean connector result", () => {
    expect(parseConnectorClaudeOutput(JSON.stringify({ is_error: false, result: "Done" }), "", 0))
      .toMatchObject({
        ok: true,
        text: "Done",
        timedOut: false,
        retryable: false,
        sideEffectOutcome: "unknown",
        exitCode: 0,
      });
  });

  it("fails closed on malformed connector JSON even with exit 0", () => {
    expect(parseConnectorClaudeOutput("not-json", "", 0)).toMatchObject({
      ok: false,
      reason: "malformed_json",
      retryable: false,
      sideEffectOutcome: "unknown",
    });
  });

  it("reports a hard timeout explicitly instead of '(no output)'", () => {
    const result = parseConnectorClaudeOutput("", "", null, {
      timedOut: true,
      signal: "SIGKILL",
      durationMs: 150_000,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "timeout",
      timedOut: true,
      retryable: false,
      sideEffectOutcome: "unknown",
      signal: "SIGKILL",
    });
    expect(result.text).toContain("timed out after 150s");
    expect(result.text).toContain("Do not retry automatically");
    expect(result.text).not.toContain("(no output)");
  });

  it("classifies exit-0 empty output as an ambiguous empty result", () => {
    const result = parseConnectorClaudeOutput("", "", 0);
    expect(result).toMatchObject({
      ok: false,
      reason: "empty_result",
      retryable: false,
      sideEffectOutcome: "unknown",
    });
    expect(result.text).not.toContain("(no output)");
  });

  it("detects provider failures in stderr even when result text looks successful", () => {
    const result = parseConnectorClaudeOutput(
      JSON.stringify({ is_error: false, result: "Done" }),
      "Usage credit limit reached",
      0,
    );
    expect(result).toMatchObject({ ok: false, reason: "provider_error" });
  });

  it("retains unclassified managed connector tools so they veto proof", () => {
    const stdout = [
      {
        type: "assistant",
        message: { content: [{
          type: "tool_use",
          id: "tool-unknown",
          name: "mcp__claude_ai_Figma__use_figma",
          input: {},
        }] },
      },
      {
        type: "user",
        message: { content: [{
          type: "tool_result",
          tool_use_id: "tool-unknown",
          content: "ok",
        }] },
      },
      { type: "result", is_error: false, result: "CONNECTOR_READ_OK: done" },
    ].map((record) => JSON.stringify(record)).join("\n");

    const parsed = parseConnectorClaudeOutput(stdout, "", 0);
    expect(parsed.toolEvidence).toEqual([expect.objectContaining({
      toolUseId: "tool-unknown",
      effect: "unknown",
      success: true,
    })]);
    expect(connectorReadHasProviderProof(parsed.toolEvidence)).toBe(false);
  });

  it("distinguishes an externally terminated connector process", () => {
    expect(parseConnectorClaudeOutput("", "", null, { signal: "SIGTERM" })).toMatchObject({
      ok: false,
      reason: "terminated",
      timedOut: false,
      sideEffectOutcome: "unknown",
    });
  });

  it("uses the same secret-free allowlisted environment for connector runtime", () => {
    const env = connectorClaudeEnv({
      HOME: "/wrong",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
      CLAUDE_CODE_OAUTH_TOKEN: "setup-token",
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
      CLAUDE_CONFIG_DIR: "/wrong-config",
      TELEGRAM_BOT_TOKEN: "telegram-secret",
    }, "/connector-home");
    expect(env).toEqual({
      HOME: "/connector-home",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      TZ: "UTC",
    });
  });
});

// ──────────────────────────────────────────────
// decideTokenExpiryWarning (eventual-expiry pre-warn)
// ──────────────────────────────────────────────
describe("decideTokenExpiryWarning", () => {
  const DAY = 86_400_000;
  const opts = { lifetimeMs: 365 * DAY, warnMs: 14 * DAY, reminderMs: 3 * DAY };
  const base = 1_000_000_000_000;

  it("records first-seen and does not warn on a brand-new token", () => {
    const r = decideTokenExpiryWarning(null, "abc123", base, opts);
    expect(r.warn).toBe(false);
    expect(r.fields).toEqual({ tokenHash: "abc123", tokenFirstSeen: base, tokenExpiryWarnedAt: null });
  });

  it("resets the clock when the token hash changes (rotation)", () => {
    const prev = { tokenHash: "old", tokenFirstSeen: base, tokenExpiryWarnedAt: base };
    const later = base + 200 * DAY;
    const r = decideTokenExpiryWarning(prev, "new", later, opts);
    expect(r.warn).toBe(false);
    expect(r.fields.tokenFirstSeen).toBe(later);
    expect(r.fields.tokenExpiryWarnedAt).toBeNull();
  });

  it("stays silent well before the warn window", () => {
    const prev = { tokenHash: "t", tokenFirstSeen: base, tokenExpiryWarnedAt: null };
    const r = decideTokenExpiryWarning(prev, "t", base + 300 * DAY, opts);
    expect(r.warn).toBe(false);
    expect(r.daysLeft).toBe(65);
  });

  it("warns inside the final window and records the warn time", () => {
    const prev = { tokenHash: "t", tokenFirstSeen: base, tokenExpiryWarnedAt: null };
    const now = base + 355 * DAY; // 10 days left, inside the 14d window
    const r = decideTokenExpiryWarning(prev, "t", now, opts);
    expect(r.warn).toBe(true);
    expect(r.daysLeft).toBe(10);
    expect(r.fields.tokenExpiryWarnedAt).toBe(now);
  });

  it("throttles re-warns to once per reminder window", () => {
    const warnedAt = base + 355 * DAY;
    const prev = { tokenHash: "t", tokenFirstSeen: base, tokenExpiryWarnedAt: warnedAt };
    const soon = decideTokenExpiryWarning(prev, "t", warnedAt + 2 * DAY, opts);
    expect(soon.warn).toBe(false); // < 3d since last warn
    const later = decideTokenExpiryWarning(prev, "t", warnedAt + 3 * DAY, opts);
    expect(later.warn).toBe(true);
  });

  it("warns nothing and preserves fields when the token isn't visible", () => {
    const prev = { tokenHash: "t", tokenFirstSeen: base, tokenExpiryWarnedAt: null };
    const r = decideTokenExpiryWarning(prev, null, base + 360 * DAY, opts);
    expect(r.warn).toBe(false);
    expect(r.fields.tokenHash).toBe("t");
    expect(r.fields.tokenFirstSeen).toBe(base);
  });
});

// ──────────────────────────────────────────────
// extractCleanupTrailer
// ──────────────────────────────────────────────
describe("extractCleanupTrailer", () => {
  it("returns text unchanged when no trailer", () => {
    const r = extractCleanupTrailer("hello world");
    expect(r.clean).toBe("hello world");
    expect(r.payload).toBeNull();
  });

  it("strips trailer and parses items", () => {
    const text = `briefing body\n\n<!--CLEANUP-START-->\n{"items":[{"account":"default","id":"abc123","subject":"Newsletter"}]}\n<!--CLEANUP-END-->`;
    const r = extractCleanupTrailer(text);
    expect(r.clean).toBe("briefing body");
    expect(r.payload?.items.length).toBe(1);
    expect(r.payload?.items[0]?.account).toBe("default");
    expect(r.payload?.items[0]?.id).toBe("abc123");
  });

  it("drops items missing required fields", () => {
    const text = `<!--CLEANUP-START-->{"items":[{"account":"default"},{"account":"default","id":"x"}]}<!--CLEANUP-END-->`;
    const r = extractCleanupTrailer(text);
    expect(r.payload?.items.length).toBe(1);
    expect(r.payload?.items[0]?.id).toBe("x");
  });

  it("returns null payload but still strips trailer when JSON is malformed", () => {
    const text = `body\n<!--CLEANUP-START-->not json<!--CLEANUP-END-->`;
    const r = extractCleanupTrailer(text);
    expect(r.clean).toBe("body");
    expect(r.payload).toBeNull();
  });

  it("returns null payload when items array is empty", () => {
    const text = `<!--CLEANUP-START-->{"items":[]}<!--CLEANUP-END-->`;
    const r = extractCleanupTrailer(text);
    expect(r.payload).toBeNull();
  });
});

// ──────────────────────────────────────────────
// Cleanup token store
// ──────────────────────────────────────────────
describe("cleanup token store", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "letyclaw-cleanup-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a payload", () => {
    const token = saveCleanupToken(dir, { items: [{ account: "default", id: "x" }] }, { topicId: 2 });
    const loaded = loadCleanupToken(dir, token);
    expect(loaded?.items[0]?.id).toBe("x");
    expect(loaded?.topicId).toBe(2);
    expect(loaded?.createdAt).toBeGreaterThan(0);
  });

  it("rejects malformed tokens", () => {
    expect(loadCleanupToken(dir, "../etc/passwd")).toBeNull();
    expect(loadCleanupToken(dir, "not-hex")).toBeNull();
  });

  it("update merges fields", () => {
    const token = saveCleanupToken(dir, { items: [{ account: "default", id: "x" }] });
    updateCleanupToken(dir, token, { messageId: 4242 });
    expect(loadCleanupToken(dir, token)?.messageId).toBe(4242);
  });

  it("atomically allows only one cleanup callback to claim a token", () => {
    const token = saveCleanupToken(dir, { items: [{ account: "default", id: "x" }] });
    expect(claimCleanupToken(dir, token)?.items[0]?.id).toBe("x");
    expect(claimCleanupToken(dir, token)).toBeNull();
    expect(loadCleanupToken(dir, token)).toBeNull();
  });

  it("rearms a proven pre-tool failure but tombstones an ambiguous execution", () => {
    const retryable = saveCleanupToken(dir, { items: [{ account: "default", id: "retry" }] });
    expect(claimCleanupToken(dir, retryable)).not.toBeNull();
    unclaimCleanupToken(dir, retryable);
    expect(loadCleanupToken(dir, retryable)?.items[0]?.id).toBe("retry");

    const ambiguous = saveCleanupToken(dir, { items: [{ account: "default", id: "unknown" }] });
    expect(claimCleanupToken(dir, ambiguous)).not.toBeNull();
    expect(commitCleanupToken(dir, ambiguous)).toBe(true);
    expect(loadCleanupToken(dir, ambiguous)).toBeNull();
    expect(claimCleanupToken(dir, ambiguous)).toBeNull();
  });

  it("delete removes the file", () => {
    const token = saveCleanupToken(dir, { items: [{ account: "default", id: "x" }] });
    deleteCleanupToken(dir, token);
    expect(loadCleanupToken(dir, token)).toBeNull();
  });

  it("prune drops tokens older than maxAge", async () => {
    const fresh = saveCleanupToken(dir, { items: [{ account: "default", id: "fresh" }] });
    const old = saveCleanupToken(dir, { items: [{ account: "default", id: "old" }] });
    // Backdate the old one
    const file = join(dir, `${old}.json`);
    const data = JSON.parse(require("fs").readFileSync(file, "utf8"));
    data.createdAt = Date.now() - 72 * 3_600_000;
    require("fs").writeFileSync(file, JSON.stringify(data));
    const removed = pruneStaleCleanupTokens(dir, 48);
    expect(removed).toBe(1);
    expect(loadCleanupToken(dir, fresh)).toBeTruthy();
    expect(loadCleanupToken(dir, old)).toBeNull();
  });
});

describe("parseAdherenceCallback", () => {
  it("accepts only bounded code-owned health callback values", () => {
    expect(parseAdherenceCallback("adherence:full:morning")).toEqual({
      level: "full",
      slot: "morning",
    });
    expect(parseAdherenceCallback("adherence:partial:after_lunch")).toEqual({
      level: "partial",
      slot: "after_lunch",
    });
  });

  it("rejects unknown levels and CSV/control-character injection", () => {
    expect(parseAdherenceCallback("adherence:yes:morning")).toBeNull();
    expect(parseAdherenceCallback("adherence:full:morning\n2026-01-01,none")).toBeNull();
    expect(parseAdherenceCallback("adherence:none:../finance")).toBeNull();
  });
});

// ──────────────────────────────────────────────
// substituteDateTokens / dateInTimeZone
// ──────────────────────────────────────────────
describe("substituteDateTokens", () => {
  // Use explicit zones so these tests do not depend on the host timezone.
  const at = (iso: string) => new Date(iso);

  it("renders date and year tokens to the configured calendar", () => {
    const out = substituteDateTokens("Today is {{the current date}}; log {today}-x; heading {date}; year {year}", at("2026-06-15T10:00:00Z"), "UTC");
    expect(out).toBe("Today is 2026-06-15; log 2026-06-15-x; heading 2026-06-15; year 2026");
  });

  it("is case/space tolerant on the {{ }} token", () => {
    expect(substituteDateTokens("{{ The Current Date }}", at("2026-06-15T10:00:00Z"), "UTC")).toBe("2026-06-15");
  });

  it("uses the configured local day instead of a UTC slice", () => {
    // 15:30 UTC on Jun 14 is already Jun 15 in Tokyo. A naive UTC slice would
    // incorrectly report Jun 14.
    expect(dateInTimeZone(at("2026-06-14T15:30:00Z"), "Asia/Tokyo")).toBe("2026-06-15");
    expect(substituteDateTokens("{today}", at("2026-06-14T15:30:00Z"), "Asia/Tokyo")).toBe("2026-06-15");
  });

  it("leaves token-free text untouched and tolerates empty input", () => {
    expect(substituteDateTokens("no tokens here", at("2026-06-15T10:00:00Z"))).toBe("no tokens here");
    expect(substituteDateTokens("")).toBe("");
  });
});

describe("voiceTranscriptionTimeoutMs", () => {
  it("uses a 60s floor for missing or tiny durations", () => {
    expect(voiceTranscriptionTimeoutMs(undefined)).toBe(60_000);
    expect(voiceTranscriptionTimeoutMs(1)).toBe(60_000);
  });

  it("scales with Telegram voice duration", () => {
    expect(voiceTranscriptionTimeoutMs(30)).toBe(150_000);
    expect(voiceTranscriptionTimeoutMs(60)).toBe(270_000);
  });

  it("caps long clips at 5 minutes", () => {
    expect(voiceTranscriptionTimeoutMs(300)).toBe(300_000);
  });
});

// ──────────────────────────────────────────────
// replaceSendRow (bundled SEND-button rows)
// ──────────────────────────────────────────────
describe("replaceSendRow", () => {
  const sendRow = (t: string) => [
    { text: "✉️ Send", callback_data: `send:${t}:do` },
    { text: "✏️ Edit", callback_data: `send:${t}:edit` },
    { text: "✕ Cancel", callback_data: `send:${t}:cancel` },
  ];
  const done = [{ text: "✓ Sent", callback_data: "send:noop" }];

  it("replaces only the tapped token's row, preserving the other bundled rows", () => {
    const kb = [sendRow("aaa"), sendRow("bbb"), sendRow("ccc")];
    const out = replaceSendRow(kb, "bbb", done);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(kb[0]); // untouched rows kept as-is
    expect(out[2]).toBe(kb[2]);
    expect(out[1]).toEqual(done); // only bbb's row resolved
  });

  it("preserves a non-send (cleanup) row", () => {
    const cleanup = [{ text: "🧹 Clean up (3)", callback_data: "cleanup:tok" }];
    const kb = [cleanup, sendRow("aaa")];
    const out = replaceSendRow(kb, "aaa", done);
    expect(out[0]).toBe(cleanup);
    expect(out[1]).toEqual(done);
  });

  it("falls back to a single-row keyboard when none exists", () => {
    expect(replaceSendRow(undefined, "aaa", done)).toEqual([done]);
    expect(replaceSendRow([], "aaa", done)).toEqual([done]);
  });

  it("leaves the keyboard unchanged when the token isn't present", () => {
    const kb = [sendRow("aaa")];
    const out = replaceSendRow(kb, "zzz", done);
    expect(out).toEqual(kb);
  });

  it("does not match a token that is a prefix of another (exact token row only)", () => {
    const kb = [sendRow("ab"), sendRow("abc")];
    const out = replaceSendRow(kb, "ab", done);
    expect(out[0]).toEqual(done);
    expect(out[1]).toBe(kb[1]); // "abc" row untouched
  });
});

// ──────────────────────────────────────────────
// extractObsidianLinks / obsidianRedirectUrl
// ──────────────────────────────────────────────
describe("obsidianRedirectUrl", () => {
  it("builds an https redirect with encoded vault and file", () => {
    const prev = process.env.OBSIDIAN_REDIRECT_BASE;
    process.env.OBSIDIAN_REDIRECT_BASE = "https://notes.example.test/o";
    const url = obsidianRedirectUrl("ExampleVault", "education/memory/2026-06-22.md");
    expect(url).toBe(
      "https://notes.example.test/o?vault=ExampleVault&file=education%2Fmemory%2F2026-06-22.md",
    );
    if (prev === undefined) delete process.env.OBSIDIAN_REDIRECT_BASE;
    else process.env.OBSIDIAN_REDIRECT_BASE = prev;
  });
});

describe("extractObsidianLinks", () => {
  const previousRedirectBase = process.env.OBSIDIAN_REDIRECT_BASE;

  beforeEach(() => {
    process.env.OBSIDIAN_REDIRECT_BASE = "https://notes.example.test/o";
  });

  afterEach(() => {
    if (previousRedirectBase === undefined) delete process.env.OBSIDIAN_REDIRECT_BASE;
    else process.env.OBSIDIAN_REDIRECT_BASE = previousRedirectBase;
  });

  it("extracts a markdown-wrapped link and strips it from the text", () => {
    const text = "Saved your note. [Open in Obsidian](obsidian://open?vault=ExampleVault&file=a/b.md)";
    const { clean, links } = extractObsidianLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0]!.vault).toBe("ExampleVault");
    expect(links[0]!.file).toBe("a/b.md");
    expect(links[0]!.url).toContain("file=a%2Fb.md");
    expect(clean).toBe("Saved your note.");
    expect(clean).not.toContain("obsidian://");
  });

  it("handles the memory_save '---\\nObsidian: <link>' trailer and trims the rule", () => {
    const text = "Note recorded.\n\n---\nObsidian: obsidian://open?vault=ExampleVault&file=health/x.md";
    const { clean, links } = extractObsidianLinks(text);
    expect(links).toHaveLength(1);
    expect(links[0]!.file).toBe("health/x.md");
    expect(clean).toBe("Note recorded.");
  });

  it("dedupes by vault+file and caps at max", () => {
    const link = "obsidian://open?vault=V&file=same.md";
    const text = `${link} and again ${link} and obsidian://open?vault=V&file=other.md`;
    const { links } = extractObsidianLinks(text, 1);
    expect(links).toHaveLength(1);
    expect(links[0]!.file).toBe("same.md");
  });

  it("returns the text unchanged when there is no obsidian link", () => {
    const text = "Just a normal reply with a [real link](https://example.com).";
    const { clean, links } = extractObsidianLinks(text);
    expect(links).toHaveLength(0);
    expect(clean).toBe(text);
  });

  it("falls back to the default vault when the link omits one", () => {
    const prev = process.env.OBSIDIAN_VAULT_NAME;
    delete process.env.OBSIDIAN_VAULT_NAME;
    const { links } = extractObsidianLinks("obsidian://open?file=notes/z.md");
    expect(links).toHaveLength(1);
    expect(links[0]!.vault).toBe("ObsidianVault");
    expect(links[0]!.file).toBe("notes/z.md");
    if (prev !== undefined) process.env.OBSIDIAN_VAULT_NAME = prev;
  });
});
