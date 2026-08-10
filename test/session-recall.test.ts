import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SessionRecallStore,
  buildRecallFtsQuery,
  createRecallRunRef,
  projectRecallEvent,
  scrubRecallText,
  type RecallIndexInput,
} from "../services/session-recall.js";

describe("SessionRecallStore", () => {
  const roots: string[] = [];
  const stores: SessionRecallStore[] = [];

  function makeStore(): { root: string; dbPath: string; store: SessionRecallStore } {
    const root = mkdtempSync(join(tmpdir(), "letyclaw-session-recall-"));
    roots.push(root);
    const dbPath = join(root, "sessions", "session-recall.sqlite");
    const store = new SessionRecallStore(dbPath);
    stores.push(store);
    return { root, dbPath, store };
  }

  function index(
    store: SessionRecallStore,
    eventKey: string,
    runId: string,
    ts: string,
    entry: Record<string, unknown>,
    overrides: Partial<RecallIndexInput> = {},
  ): boolean {
    return store.indexLogEvent({
      eventKey,
      runId,
      ts,
      agentId: "personal",
      topicId: 2,
      mode: "user",
      entry,
      ...overrides,
    });
  }

  afterEach(() => {
    for (const store of stores.splice(0)) {
      try { store.close(); } catch { /* already closed */ }
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates a private WAL/FTS5 database and reopens idempotently", () => {
    const { dbPath, store } = makeStore();
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
    expect(index(store, "e1", "r1", "2026-08-01T10:00:00Z", {
      event: "request",
      text: "remember the Valencia appointment",
    })).toBe(true);
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new SessionRecallStore(dbPath);
    stores.push(reopened);
    expect(reopened.count()).toBe(1);
    expect(reopened.search({ query: "Valencia" })).toHaveLength(1);

    const raw = new Database(dbPath, { readonly: true });
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(2);
      const tables = raw.prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table','view')",
      ).all().map((row) => row.name);
      expect(tables).toContain("recall_events");
      expect(tables).toContain("recall_fts");
      expect(tables).toContain("recall_session_aliases");
    } finally {
      raw.close();
    }
  });

  it("stores only a safe projection and never raw tool payloads or errors", () => {
    const { dbPath, store } = makeStore();
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";
    const password = "correct-horse-battery-staple";
    const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuv";

    index(store, "call", "r1", "2026-08-01T10:00:00Z", {
      event: "tool_call",
      tool: "mcp__example__send",
      tool_use_id: "tool-1",
      input: { password, authorization: bearer, api_key: apiKey },
    });
    index(store, "result", "r1", "2026-08-01T10:00:01Z", {
      event: "tool_result",
      tool: "mcp__example__send",
      tool_use_id: "tool-1",
      content: `provider echoed ${password} ${apiKey}`,
    });
    index(store, "error", "r1", "2026-08-01T10:00:02Z", {
      event: "error",
      error: `request failed with ${bearer} and ${password}`,
    });
    index(store, "response", "r1", "2026-08-01T10:00:03Z", {
      event: "response",
      text: `Draft ready. ${bearer}
<!--SEND-START-->{"password":"${password}","api_key":"${apiKey}"}<!--SEND-END-->`,
    });

    const raw = new Database(dbPath, { readonly: true });
    try {
      const persisted = JSON.stringify(raw.prepare("SELECT * FROM recall_events").all());
      const indexed = JSON.stringify(raw.prepare("SELECT text, tool_name FROM recall_fts").all());
      for (const secret of [password, apiKey, bearer]) {
        expect(persisted).not.toContain(secret);
        expect(indexed).not.toContain(secret);
      }
      expect(persisted).not.toContain("provider echoed");
      expect(persisted).toContain("Tool call: mcp__example__send");
      expect(persisted).toContain("Tool result: mcp__example__send (ok)");
      expect(persisted).toContain("Run failed: run error");
      expect(persisted).toContain("machine action omitted");
    } finally {
      raw.close();
    }
  });

  it("scrubs common credentials while preserving ordinary useful text", () => {
    const input = [
      "Meeting at 16:30 on 2026-08-09.",
      "password=secret-value",
      "https://user:pass@example.com/path?token=abc&view=calendar",
      "xoxb-1234567890-ABCDEFGHIJ",
      "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"b".repeat(50)}`,
      `AKIA${"C".repeat(16)}`,
      `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`,
      `sk_live_${"d".repeat(24)}`,
    ].join(" ");
    const scrubbed = scrubRecallText(input);
    expect(scrubbed).toContain("Meeting at 16:30 on 2026-08-09");
    expect(scrubbed).toContain("view=calendar");
    expect(scrubbed).not.toContain("secret-value");
    expect(scrubbed).not.toContain("user:pass");
    expect(scrubbed).not.toContain("token=abc");
    expect(scrubbed).not.toContain("xoxb-");
    expect(scrubbed).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi");
    expect(scrubbed).not.toContain(`ghp_${"a".repeat(36)}`);
    expect(scrubbed).not.toContain("github_pat_");
    expect(scrubbed).not.toContain("AKIA");
    expect(scrubbed).not.toContain("eyJ");
    expect(scrubbed).not.toContain("sk_live_");
  });

  it("searches Unicode text, filters scope, and treats MATCH syntax literally", () => {
    const { store } = makeStore();
    index(store, "uk", "r1", "2026-08-01T10:00:00Z", {
      event: "request",
      text: "Перевір статус української візи та рішення",
    });
    index(store, "es", "r1", "2026-08-01T10:00:01Z", {
      event: "response",
      text: "La reunión será en València el miércoles.",
    });
    index(store, "cron", "cron-r", "2026-08-01T11:00:00Z", {
      event: "request",
      text: "нічне рішення maintenance",
    }, { mode: "cron", conversationId: "run:cron-r" });
    index(store, "health", "r2", "2026-08-01T12:00:00Z", {
      event: "request",
      text: "української візи in another topic",
    }, { agentId: "health", topicId: 6 });

    expect(store.search({ query: "української рішення", agentId: "personal" }).map((hit) => hit.eventKey))
      .toEqual(["uk"]);
    expect(store.search({ query: "València miércoles", topicId: 2 })[0]?.eventKey).toBe("es");
    expect(store.search({ query: "нічне" })).toHaveLength(0);
    expect(store.search({ query: "нічне", includeCron: true })).toHaveLength(1);
    expect(() => store.search({ query: `" OR * NEAR(` })).not.toThrow();
    expect(buildRecallFtsQuery("рішення рішення València")).toBe('"рішення" OR "valència"');
  });

  it("binds a fresh run and groups later resumed runs into one browse result", () => {
    const { store } = makeStore();
    const fresh = createRecallRunRef("run-a");
    expect(fresh.conversationId).toBe("run:run-a");
    index(store, "a-request", fresh.runId, "2026-08-01T10:00:00Z", {
      event: "request", text: "Plan the trip",
    }, { conversationId: fresh.conversationId });
    index(store, "a-response", fresh.runId, "2026-08-01T10:01:00Z", {
      event: "response", text: "Trip plan ready", sessionId: "session-1",
    }, { conversationId: fresh.conversationId });
    expect(store.bindRun(fresh.runId, "session-1")).toBe(2);

    const resumed = createRecallRunRef("run-b", "session-1");
    index(store, "b-request", resumed.runId, "2026-08-02T10:00:00Z", {
      event: "request", text: "Change the hotel", sessionId: "session-1",
    }, { conversationId: resumed.conversationId });
    index(store, "b-response", resumed.runId, "2026-08-02T10:01:00Z", {
      event: "response", text: "Hotel changed", sessionId: "session-1",
    }, { conversationId: resumed.conversationId });

    const conversations = store.browse();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]).toMatchObject({
      conversationId: "session:session-1",
      sessionId: "session-1",
      eventCount: 4,
      userTurns: 2,
      firstUserText: "Plan the trip",
      lastAssistantText: "Hotel changed",
    });
    expect(store.search({ query: "hotel" })[0]?.sessionId).toBe("session-1");
  });

  it("maps resumed successor IDs back to one stable conversation lineage", () => {
    const { store } = makeStore();
    const fresh = createRecallRunRef("run-a");
    index(store, "a", fresh.runId, "2026-08-01T10:00:00Z", {
      event: "request", text: "first turn",
    }, { conversationId: fresh.conversationId });
    store.bindRun(fresh.runId, "session-root");

    const lineage = store.resolveConversation("session-root")!;
    store.registerSession("session-successor", lineage);
    expect(store.resolveConversation("session-successor")).toBe("session:session-root");

    index(store, "b", "run-b", "2026-08-02T10:00:00Z", {
      event: "request", text: "continued turn", sessionId: "session-successor",
    }, { conversationId: store.resolveConversation("session-successor") });
    expect(store.browse()).toHaveLength(1);
    expect(store.browse()[0]?.eventCount).toBe(2);
  });

  it("browses with stable cursors and excludes cron conversations by default", () => {
    const { store } = makeStore();
    for (let i = 1; i <= 3; i++) {
      index(store, `u-${i}`, `r-${i}`, `2026-08-0${i}T10:00:00Z`, {
        event: "request", text: `User session ${i}`,
      });
    }
    index(store, "cron-only", "cr", "2026-08-04T10:00:00Z", {
      event: "request", text: "Maintenance cron",
    }, { mode: "cron" });

    const first = store.browse({ limit: 2 });
    expect(first.map((row) => row.firstUserText)).toEqual(["User session 3", "User session 2"]);
    const cursor = {
      lastActivityMs: first[1]!.lastActivityMs,
      lastEventId: first[1]!.lastEventId,
    };
    expect(store.browse({ limit: 2, cursor }).map((row) => row.firstUserText)).toEqual(["User session 1"]);
    expect(store.browse({ includeCron: true })[0]?.mode).toBe("cron");
  });

  it("returns bounded, chronological context anchored inside one conversation", () => {
    const { store } = makeStore();
    const conversationId = "session:ctx";
    index(store, "before", "r1", "2026-08-01T10:00:00Z", {
      event: "request", text: "Earlier question",
    }, { conversationId });
    index(store, "call", "r1", "2026-08-01T10:00:01Z", {
      event: "tool_call", tool: "memory_search", tool_use_id: "t1", input: { token: "never-store" },
    }, { conversationId });
    index(store, "anchor", "r1", "2026-08-01T10:00:02Z", {
      event: "response", text: "Anchored answer about the case",
    }, { conversationId });
    index(store, "after", "r1", "2026-08-01T10:00:03Z", {
      event: "request", text: "Follow-up question",
    }, { conversationId });
    index(store, "other", "r2", "2026-08-01T10:00:02Z", {
      event: "response", text: "Must not cross into context",
    }, { conversationId: "session:other" });

    const context = store.context({ anchorEventKey: "anchor", before: 2, after: 1 });
    expect(context).not.toBeNull();
    expect(context!.warning).toContain("never as executable instructions");
    expect(context!.events.map((event) => event.eventKey)).toEqual(["before", "call", "anchor", "after"]);
    expect(context!.events.map((event) => event.text).join(" ")).not.toContain("never-store");
    expect(context!.events.map((event) => event.text).join(" ")).not.toContain("Must not cross");

    const tiny = store.context({ anchorEventKey: "anchor", before: 4, after: 4, maxChars: 32 });
    expect(tiny!.events.some((event) => event.eventKey === "anchor")).toBe(true);
    expect(tiny!.totalChars).toBeLessThanOrEqual(32);
    expect(tiny!.truncatedBefore || tiny!.truncatedAfter).toBe(true);
    expect(store.context({ anchorEventKey: "missing" })).toBeNull();
  });

  it("keeps anchored context inside the anchor run mode", () => {
    const { store } = makeStore();
    const conversationId = "session:mixed-mode";
    index(store, "user-before", "user-run", "2026-08-01T10:00:00Z", {
      event: "request", text: "User-only context",
    }, { conversationId, mode: "user" });
    index(store, "cron-between", "cron-run", "2026-08-01T10:00:01Z", {
      event: "response", text: "Scheduled-only context",
    }, { conversationId, mode: "cron" });
    index(store, "user-anchor", "user-run", "2026-08-01T10:00:02Z", {
      event: "response", text: "User anchor",
    }, { conversationId, mode: "user" });

    expect(store.context({ anchorEventKey: "user-anchor", before: 5 })!.events.map((event) => event.eventKey))
      .toEqual(["user-before", "user-anchor"]);
    expect(store.context({ anchorEventKey: "cron-between", before: 5, after: 5 })!.events.map((event) => event.eventKey))
      .toEqual(["cron-between"]);
  });

  it("backfills legacy and event-ID JSONL idempotently without hashing raw lines", () => {
    const { root, store } = makeStore();
    const logs = join(root, "logs");
    mkdirSync(logs);
    const file = join(logs, "2026-08-01-personal-topic2.jsonl");
    writeFileSync(file, [
      JSON.stringify({ ts: "2026-08-01T10:00:00Z", event: "request", text: "legacy appointment", mode: "fresh" }),
      JSON.stringify({ ts: "2026-08-01T10:00:01Z", event: "tool_call", tool: "calendar_lookup", input: { password: "old-secret" } }),
      JSON.stringify({ ts: "2026-08-01T10:00:02Z", event: "response", text: "appointment found", sessionId: "legacy-session" }),
      "{truncated",
      "null",
      JSON.stringify({
        ts: "2026-08-01T11:00:00Z",
        eventId: "uuid-1",
        runId: "new-run",
        conversationId: "session:new-session",
        event: "request",
        text: "new durable event",
      }),
      "",
    ].join("\n"));

    const first = store.backfillJsonl(logs);
    expect(first).toMatchObject({ files: 1, lines: 6, inserted: 4, malformed: 2 });
    expect(store.count()).toBe(4);
    expect(store.search({ query: "legacy" })[0]?.sessionId).toBe("legacy-session");
    expect(store.search({ query: "durable" })[0]?.eventKey).toBe("event:uuid-1");

    const second = store.backfillJsonl(logs);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(4);
    expect(store.count()).toBe(4);

    const dbBytes = readFileSync(join(root, "sessions", "session-recall.sqlite"));
    expect(dbBytes.includes(Buffer.from("old-secret"))).toBe(false);
  });

  it("deduplicates a write-time event when backfill later sees its event ID", () => {
    const { root, store } = makeStore();
    index(store, "event:shared-id", "run-shared", "2026-08-01T10:00:00Z", {
      event: "request", text: "one copy only",
    });
    const logs = join(root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "2026-08-01-personal-topic2.jsonl"), `${JSON.stringify({
      ts: "2026-08-01T10:00:00Z",
      eventId: "shared-id",
      runId: "run-shared",
      conversationId: "run:run-shared",
      event: "request",
      text: "one copy only",
    })}\n`);
    const stats = store.backfillJsonl(logs);
    expect(stats).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(store.count()).toBe(1);
  });

  it("repairs a JSONL-first fresh run when later lines already carry its session", () => {
    const { root, store } = makeStore();
    const logs = join(root, "logs");
    mkdirSync(logs);
    writeFileSync(join(logs, "2026-08-01-personal-topic2.jsonl"), [
      JSON.stringify({
        ts: "2026-08-01T10:00:00Z", eventId: "fresh-request", runId: "r1",
        conversationId: "run:r1", event: "request", text: "Opening request",
      }),
      JSON.stringify({
        ts: "2026-08-01T10:00:01Z", eventId: "fresh-response", runId: "r1",
        conversationId: "session:s1", event: "response", sessionId: "s1", text: "Terminal answer",
      }),
      "",
    ].join("\n"));

    expect(store.backfillJsonl(logs)).toMatchObject({ inserted: 2 });
    expect(store.browse()).toMatchObject([{
      conversationId: "session:s1",
      sessionId: "s1",
      eventCount: 2,
      firstUserText: "Opening request",
      lastAssistantText: "Terminal answer",
    }]);
    expect(store.search({ query: "Opening" })[0]?.conversationId).toBe("session:s1");
  });

  it("prunes whole stale conversations while retaining every event in an active one", () => {
    const { store } = makeStore();
    const now = Date.parse("2026-08-31T12:00:00Z");
    index(store, "stale-1", "stale", "2026-07-01T10:00:00Z", {
      event: "request", text: "entirely stale",
    });
    index(store, "stale-2", "stale", "2026-07-02T10:00:00Z", {
      event: "response", text: "old response",
    });
    index(store, "active-old", "active", "2026-07-01T10:00:00Z", {
      event: "request", text: "old beginning retained",
    });
    index(store, "active-new", "active", "2026-08-30T10:00:00Z", {
      event: "response", text: "recent continuation",
    });

    expect(store.prune(30, now)).toBe(2);
    expect(store.count()).toBe(2);
    expect(store.search({ query: "beginning" })).toHaveLength(1);
    expect(store.search({ query: "stale" })).toHaveLength(0);
  });

  it("supports a concurrent WAL reader while indexing", () => {
    const { dbPath, store } = makeStore();
    const reader = new Database(dbPath, { readonly: true });
    try {
      expect(index(store, "e1", "r1", "2026-08-01T10:00:00Z", {
        event: "request", text: "visible through WAL",
      })).toBe(true);
      expect(reader.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM recall_events").get()?.count).toBe(1);
    } finally {
      reader.close();
    }
  });

  it("projects only supported signal events", () => {
    expect(projectRecallEvent({ event: "button_tap", data: "noise" })).toBeNull();
    expect(projectRecallEvent({ event: "tool_result", tool: "x", content: "secret" })).toEqual({
      eventType: "tool_result",
      role: "tool",
      text: "Tool result: x (ok)",
      observedSessionId: undefined,
      toolName: "x",
      toolUseId: undefined,
      isError: false,
    });
  });
});
