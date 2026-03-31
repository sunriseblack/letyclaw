import { vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  isRateLimited,
  getSessionFile,
  loadSession,
  saveSession,
  deleteSession,
  shouldRotateSession,
  lookupSessionByMessageId,
  mapMessageToSession,
  createSession,
  updateCurrentSession,
  pruneOldSessions,
  buildBootstrapPrompt,
  buildTopicPrompt,
  isSessionExpiredError,
  parseClaudeResult,
  mdToTelegramHtml,
  splitMessage,
} from "../lib.js";
import type { SessionData, RateLimitConfig } from "../types.js";

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

  it("deleteSession removes file", () => {
    const data: SessionData = { currentSessionId: "sess-1", createdAt: Date.now(), messageMap: {} };
    saveSession(tmpDir, "personal", 2, data);
    deleteSession(tmpDir, "personal", 2);
    expect(loadSession(tmpDir, "personal", 2)).toBeNull();
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
});

// ──────────────────────────────────────────────
// createSession / updateCurrentSession
// ──────────────────────────────────────────────
describe("createSession / updateCurrentSession", () => {
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
    expect(session.messageMap).toEqual({});
  });

  it("preserves existing messageMap when creating new session", () => {
    const data: SessionData = { currentSessionId: "old", createdAt: 100, messageMap: { "42": "sess-old" } };
    saveSession(tmpDir, "agent", 1, data);
    const session = createSession(tmpDir, "agent", 1);
    expect(session.messageMap).toEqual({ "42": "sess-old" });
    expect(session.currentSessionId).toBeNull();
  });

  it("updateCurrentSession sets the session ID", () => {
    createSession(tmpDir, "agent", 1);
    updateCurrentSession(tmpDir, "agent", 1, "new-sess-id");
    const session = loadSession(tmpDir, "agent", 1);
    expect(session!.currentSessionId).toBe("new-sess-id");
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

  it("returns true when session has no createdAt", () => {
    expect(shouldRotateSession({ currentSessionId: "x" } as SessionData, ttl24h)).toBe(true);
  });

  it("returns true when TTL exceeded", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const session: SessionData = { currentSessionId: "s1", createdAt: Date.now(), messageMap: {} };

    vi.setSystemTime(new Date("2026-03-22T10:00:01"));
    expect(shouldRotateSession(session, ttl24h)).toBe(true);
  });

  it("returns false when session is within TTL", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const session: SessionData = { currentSessionId: "s1", createdAt: Date.now(), messageMap: {} };

    vi.setSystemTime(new Date("2026-03-21T20:00:00"));
    expect(shouldRotateSession(session, ttl24h)).toBe(false);
  });

  it("returns false at exactly TTL boundary", () => {
    vi.setSystemTime(new Date("2026-03-21T10:00:00"));
    const created = Date.now();
    const session: SessionData = { currentSessionId: "s1", createdAt: created, messageMap: {} };

    vi.setSystemTime(created + ttl24h);
    expect(shouldRotateSession(session, ttl24h)).toBe(false);
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
    saveSession(tmpDir, "agent", 1, data);

    mapMessageToSession(tmpDir, "agent", 1, [100, 101, 102], "sess-abc");

    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 100)).toBe("sess-abc");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 101)).toBe("sess-abc");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 102)).toBe("sess-abc");
  });

  it("handles multiple sessions with different message IDs", () => {
    const data: SessionData = { currentSessionId: "s1", createdAt: Date.now(), messageMap: {} };
    saveSession(tmpDir, "agent", 1, data);

    mapMessageToSession(tmpDir, "agent", 1, [100], "sess-1");
    mapMessageToSession(tmpDir, "agent", 1, [200], "sess-2");

    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 100)).toBe("sess-1");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 200)).toBe("sess-2");
  });

  it("does nothing when session file does not exist", () => {
    // Should not throw
    mapMessageToSession(tmpDir, "agent", 1, [100], "sess-1");
    expect(lookupSessionByMessageId(tmpDir, "agent", 1, 100)).toBeUndefined();
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
});

// ──────────────────────────────────────────────
// buildBootstrapPrompt
// ──────────────────────────────────────────────
describe("buildBootstrapPrompt", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-test-"));
    mkdirSync(join(tmpDir, "testagent"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("wraps each file in XML tags", () => {
    writeFileSync(join(tmpDir, "testagent", "AGENTS.md"), "# Agent instructions");
    writeFileSync(join(tmpDir, "testagent", "IDENTITY.md"), "I am an agent");
    const result = buildBootstrapPrompt(tmpDir, "testagent", "hello", {
      bootstrapFiles: ["AGENTS.md", "IDENTITY.md"],
    });
    expect(result).toContain("<AGENTS.md>");
    expect(result).toContain("# Agent instructions");
    expect(result).toContain("</AGENTS.md>");
    expect(result).toContain("<IDENTITY.md>");
    expect(result).toContain("I am an agent");
    expect(result).toContain("</IDENTITY.md>");
  });

  it("skips missing files", () => {
    writeFileSync(join(tmpDir, "testagent", "AGENTS.md"), "content");
    const result = buildBootstrapPrompt(tmpDir, "testagent", "hello", {
      bootstrapFiles: ["AGENTS.md", "NONEXISTENT.md"],
    });
    expect(result).toContain("<AGENTS.md>");
    expect(result).not.toContain("NONEXISTENT.md");
  });

  it("skips oversized files", () => {
    writeFileSync(join(tmpDir, "testagent", "AGENTS.md"), "x".repeat(100));
    const result = buildBootstrapPrompt(tmpDir, "testagent", "hello", {
      bootstrapFiles: ["AGENTS.md"],
      maxFileSize: 50,
    });
    expect(result).not.toContain("<AGENTS.md>");
    expect(result).toBe("hello");
  });

  it("returns raw userMessage when no files found", () => {
    const result = buildBootstrapPrompt(tmpDir, "testagent", "hello", {
      bootstrapFiles: ["NOPE.md"],
    });
    expect(result).toBe("hello");
  });

  it("appends user message after separator", () => {
    writeFileSync(join(tmpDir, "testagent", "AGENTS.md"), "instructions");
    const result = buildBootstrapPrompt(tmpDir, "testagent", "do something");
    expect(result).toContain("---\nUser message: do something");
  });
});

// ──────────────────────────────────────────────
// buildTopicPrompt (unified super-agent mode)
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

  // Simulates bot.js lines 348-356: save after response
  function saveAfterResponse(agentId: string, topicId: number, resultSessionId: string, mode: string, messageIds: number[]): void {
    if (resultSessionId) {
      if (mode === "fresh") {
        createSession(tmpDir, agentId, topicId);
      }
      updateCurrentSession(tmpDir, agentId, topicId, resultSessionId);
      mapMessageToSession(tmpDir, agentId, topicId, messageIds, resultSessionId);
    }
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
