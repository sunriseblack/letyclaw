import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { MCPToolModule } from "../tools/letyclaw-mcp/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

let tmpDir: string;
let vaultPath: string;
let sessionsDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-mcp-test-"));
  vaultPath = join(tmpDir, "vault");
  sessionsDir = join(tmpDir, "sessions");
  mkdirSync(vaultPath);
  mkdirSync(sessionsDir);

  // Set env vars for tools
  process.env.LETYCLAW_VAULT_PATH = vaultPath;
  process.env.LETYCLAW_SESSIONS_DIR = sessionsDir;
  process.env.LETYCLAW_AGENT_ID = "personal";
  process.env.LETYCLAW_TOPIC_ID = "2";
  process.env.LETYCLAW_CHAT_ID = "12345";
  process.env.LETYCLAW_PROJECT_ROOT = tmpDir;
  process.env.LETYCLAW_CRON_CONFIG = join(tmpDir, "cron.yaml");

  // Create agent workspace with memory
  const agentDir = join(vaultPath, "personal");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(agentDir, "memory"), { recursive: true });
  writeFileSync(join(agentDir, "AGENTS.md"), "# Personal Agent\nYou are a personal assistant.");

  writeFileSync(join(agentDir, "memory", "2026-03-25.md"), `# Memory — 2026-03-25

## 09:15

Had a meeting with the engineering team about Q2 planning.
Discussed migration to new payment gateway.
Team lead mentioned deadline is end of April.

## 14:30

Researched flight options to Lisbon for May vacation.
TAP Portugal and Ryanair have good prices.
`);

  writeFileSync(join(agentDir, "memory", "2026-03-26.md"), `# Memory — 2026-03-26

## 10:00

Standup notes: frontend team blocked on API schema changes.
Backend deployment scheduled for Thursday.

## 16:45

Booked dentist appointment for April 2nd at 10am.
Dr. Martinez clinic.
`);

  writeFileSync(join(agentDir, "memory", "2026-03-27.md"), `# Memory — 2026-03-27

## 08:30

Morning routine: meditation, journaling, coffee.
Weather is sunny, 22°C.

## 11:00

Payment gateway integration PR reviewed and approved.
Needs final QA before merge.
`);

  // Create a second agent workspace
  const workDir = join(vaultPath, "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(join(workDir, "memory"), { recursive: true });
  writeFileSync(join(workDir, "AGENTS.md"), "# Work Agent\nYou handle work tasks.");
  writeFileSync(join(workDir, "memory", "2026-03-27.md"), "# Work notes\n\n## 09:00\n\nSprint review prep.\n");

  // Create a session file
  writeFileSync(join(sessionsDir, "personal-topic-2.json"), JSON.stringify({
    currentSessionId: "sess-abc-123",
    createdAt: Date.now() - 3600000, // 1 hour ago
    messageMap: { "100": "sess-abc-123", "101": "sess-abc-123", "105": "sess-old-456" },
  }));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LETYCLAW_VAULT_PATH;
  delete process.env.LETYCLAW_SESSIONS_DIR;
  delete process.env.LETYCLAW_AGENT_ID;
  delete process.env.LETYCLAW_TOPIC_ID;
  delete process.env.LETYCLAW_CHAT_ID;
  delete process.env.LETYCLAW_PROJECT_ROOT;
  delete process.env.LETYCLAW_CRON_CONFIG;
});

// ══════════════════════════════════════════════════════════════════════
// MEMORY TOOLS
// ══════════════════════════════════════════════════════════════════════

describe("Memory tools", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    // Fresh import to pick up env changes
    const mod = await import("../tools/letyclaw-mcp/tools/memory.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  describe("memory_search", () => {
    it("finds relevant results by keyword", async () => {
      const result = await handlers.memory_search!({ query: "payment gateway" });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text) as Array<{ snippet: string }>;
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]!.snippet.toLowerCase()).toContain("payment gateway");
    });

    it("ranks results by relevance — specific terms score higher", async () => {
      const result = await handlers.memory_search!({ query: "dentist appointment Martinez" });
      const data = JSON.parse(result.content[0]!.text) as Array<{ file: string }>;
      expect(data.length).toBeGreaterThan(0);
      // The 2026-03-26 file should rank high (has dentist + Martinez)
      expect(data[0]!.file).toBe("2026-03-26.md");
    });

    it("returns empty for non-matching query", async () => {
      const result = await handlers.memory_search!({ query: "xyznonexistent" });
      expect(result.content[0]!.text).toContain("No matches");
    });

    it("searches a specific agent", async () => {
      const result = await handlers.memory_search!({ query: "sprint review", agent_id: "work" });
      const data = JSON.parse(result.content[0]!.text) as Array<{ snippet: string }>;
      expect(data.length).toBeGreaterThan(0);
      expect(data[0]!.snippet).toContain("Sprint review");
    });

    it("errors without agent_id when env is cleared", async () => {
      delete process.env.LETYCLAW_AGENT_ID;
      const result = await handlers.memory_search!({ query: "test" });
      expect(result.isError).toBe(true);
    });

    it("respects limit parameter", async () => {
      const result = await handlers.memory_search!({ query: "the", limit: 2 });
      if (!result.content[0]!.text.includes("No matches")) {
        const data = JSON.parse(result.content[0]!.text) as unknown[];
        expect(data.length).toBeLessThanOrEqual(2);
      }
    });
  });

  describe("memory_get", () => {
    it("gets memory by date", async () => {
      const result = await handlers.memory_get!({ date: "2026-03-25" });
      expect(result.content[0]!.text).toContain("engineering team");
    });

    it("gets memory by path", async () => {
      const result = await handlers.memory_get!({ path: "2026-03-26.md" });
      expect(result.content[0]!.text).toContain("dentist");
    });

    it("errors for missing file", async () => {
      const result = await handlers.memory_get!({ date: "2020-01-01" });
      expect(result.isError).toBe(true);
    });

    it("errors without date or path", async () => {
      const result = await handlers.memory_get!({});
      expect(result.isError).toBe(true);
    });
  });

  describe("memory_save", () => {
    it("creates new memory file for today", async () => {
      const result = await handlers.memory_save!({ content: "Test memory entry" });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain("Saved to");

      // Verify file was created
      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(vaultPath, "personal", "memory", `${today}.md`);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("Test memory entry");
    });

    it("appends to existing memory file", async () => {
      await handlers.memory_save!({ content: "First entry" });
      await handlers.memory_save!({ content: "Second entry" });

      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(vaultPath, "personal", "memory", `${today}.md`);
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("First entry");
      expect(content).toContain("Second entry");
    });

    it("adds timestamp header in HH:MM format", async () => {
      await handlers.memory_save!({ content: "Timestamped entry" });

      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(vaultPath, "personal", "memory", `${today}.md`);
      const content = readFileSync(filePath, "utf8");
      // Should contain ## HH:MM header
      expect(content).toMatch(/## \d{2}:\d{2}/);
      expect(content).toContain("Timestamped entry");
    });

    it("includes tags when provided", async () => {
      await handlers.memory_save!({ content: "Tagged memory", tags: ["work", "urgent"] });

      const today = new Date().toISOString().slice(0, 10);
      const filePath = join(vaultPath, "personal", "memory", `${today}.md`);
      const content = readFileSync(filePath, "utf8");
      expect(content).toContain("Tags: work, urgent");
    });
  });

  describe("memory_delete", () => {
    it("deletes memory by date", async () => {
      const filePath = join(vaultPath, "personal", "memory", "2026-03-25.md");
      expect(existsSync(filePath)).toBe(true);

      const result = await handlers.memory_delete!({ date: "2026-03-25" });
      expect(result.isError).toBeFalsy();
      expect(existsSync(filePath)).toBe(false);
    });

    it("errors for non-existent file", async () => {
      const result = await handlers.memory_delete!({ date: "1999-01-01" });
      expect(result.isError).toBe(true);
    });
  });

  describe("memory_list", () => {
    it("lists all memory files newest first", async () => {
      const result = await handlers.memory_list!({});
      const data = JSON.parse(result.content[0]!.text) as Array<{ file: string }>;
      expect(data.length).toBe(3);
      expect(data[0]!.file).toBe("2026-03-27.md");
      expect(data[2]!.file).toBe("2026-03-25.md");
    });

    it("includes file sizes and entry counts", async () => {
      const result = await handlers.memory_list!({});
      const data = JSON.parse(result.content[0]!.text) as Array<{ size: number; entries: number }>;
      expect(data[0]!.size).toBeGreaterThan(0);
      expect(data[0]!.entries).toBeGreaterThan(0);
    });

    it("respects limit", async () => {
      const result = await handlers.memory_list!({ limit: 1 });
      const data = JSON.parse(result.content[0]!.text) as unknown[];
      expect(data.length).toBe(1);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// SESSION TOOLS
// ══════════════════════════════════════════════════════════════════════

describe("Session tools", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    const mod = await import("../tools/letyclaw-mcp/tools/sessions.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  describe("sessions_list", () => {
    it("lists all sessions", async () => {
      const result = await handlers.sessions_list!({});
      const data = JSON.parse(result.content[0]!.text) as Array<{
        agent: string;
        topic: string;
        sessionId: string;
        messageCount: number;
      }>;
      expect(data.length).toBe(1);
      expect(data[0]!.agent).toBe("personal");
      expect(data[0]!.topic).toBe("2");
      expect(data[0]!.sessionId).toBe("sess-abc-123");
      expect(data[0]!.messageCount).toBe(3);
    });

    it("filters by agent_id", async () => {
      const result = await handlers.sessions_list!({ agent_id: "work" });
      const text = result.content[0]!.text;
      expect(text).toContain("No active sessions");
    });
  });

  describe("sessions_history", () => {
    it("returns session details", async () => {
      const result = await handlers.sessions_history!({ agent_id: "personal", topic_id: "2" });
      const data = JSON.parse(result.content[0]!.text) as {
        currentSessionId: string;
        messageCount: number;
        messageMap: Record<string, string>;
      };
      expect(data.currentSessionId).toBe("sess-abc-123");
      expect(data.messageCount).toBe(3);
      expect(data.messageMap).toHaveProperty("100", "sess-abc-123");
    });

    it("errors for non-existent session", async () => {
      const result = await handlers.sessions_history!({ agent_id: "personal", topic_id: "999" });
      expect(result.isError).toBe(true);
    });
  });

  describe("session_status", () => {
    it("returns detailed status", async () => {
      const result = await handlers.session_status!({ agent_id: "personal", topic_id: "2" });
      const data = JSON.parse(result.content[0]!.text) as {
        agent: string;
        currentSessionId: string;
        ageHours: number;
        isExpired: boolean;
        lastMessageId: number;
      };
      expect(data.agent).toBe("personal");
      expect(data.currentSessionId).toBe("sess-abc-123");
      expect(data.ageHours).toBeGreaterThan(0);
      expect(data.isExpired).toBe(false);
      expect(data.lastMessageId).toBe(105);
    });
  });

  describe("subagents", () => {
    it("returns empty when no sub-agents spawned", async () => {
      const result = await handlers.subagents!({});
      expect(result.content[0]!.text).toContain("No sub-agents");
    });
  });

  describe("sessions_send", () => {
    it("errors for missing agent workspace", async () => {
      const result = await handlers.sessions_send!({
        session_id: "sess-fake",
        message: "hello",
        agent_id: "nonexistent",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("not found");
    });
  });

  describe("sessions_spawn", () => {
    it("errors for missing agent workspace", async () => {
      const result = await handlers.sessions_spawn!({
        prompt: "test",
        agent_id: "nonexistent",
      });
      expect(result.isError).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// MESSAGING TOOLS (no real Telegram API calls)
// ══════════════════════════════════════════════════════════════════════

describe("Messaging tools", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    const mod = await import("../tools/letyclaw-mcp/tools/messaging.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  describe("message_send", () => {
    it("errors when TELEGRAM_CHAT_ID is not set", async () => {
      delete process.env.LETYCLAW_CHAT_ID;
      delete process.env.TELEGRAM_CHAT_ID;
      const result = await handlers.message_send!({ text: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("TELEGRAM_CHAT_ID");
    });
  });

  describe("message_poll", () => {
    it("validates minimum options", async () => {
      // Set a fake token so we get past the token check
      process.env.TELEGRAM_BOT_TOKEN = "fake-token";
      const result = await handlers.message_poll!({ question: "Test?", options: ["Only one"] });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("At least 2");
    });

    it("validates maximum options", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "fake-token";
      const options = Array.from({ length: 11 }, (_, i) => `Option ${i}`);
      const result = await handlers.message_poll!({ question: "Test?", options });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Maximum 10");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// CRON TOOLS
// ══════════════════════════════════════════════════════════════════════

describe("Cron tools", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    const mod = await import("../tools/letyclaw-mcp/tools/cron.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  describe("cron_create", () => {
    it("creates a new cron job", async () => {
      const result = await handlers.cron_create!({
        id: "daily-standup",
        schedule: "0 9 * * *",
        prompt: "Give me a morning briefing",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0]!.text) as { created: boolean; job: { id: string } };
      expect(data.created).toBe(true);
      expect(data.job.id).toBe("daily-standup");

      // Verify file was written
      const cronFile = join(tmpDir, "cron.yaml");
      expect(existsSync(cronFile)).toBe(true);
      const content = readFileSync(cronFile, "utf8");
      expect(content).toContain("daily-standup");
      expect(content).toContain("0 9 * * *");
    });

    it("rejects duplicate IDs", async () => {
      await handlers.cron_create!({ id: "job1", schedule: "0 9 * * *", prompt: "test" });
      const result = await handlers.cron_create!({ id: "job1", schedule: "0 10 * * *", prompt: "test2" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("already exists");
    });

    it("rejects invalid cron expressions", async () => {
      const result = await handlers.cron_create!({ id: "bad", schedule: "not a cron", prompt: "test" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Invalid cron");
    });

    it("persists optional fields (agent_id, topicId, maxTurns)", async () => {
      await handlers.cron_create!({
        id: "with-opts",
        schedule: "0 9 * * *",
        prompt: "test",
        agent_id: "health",
        topic_id: "6",
        max_turns: 15,
        enabled: false,
      });
      const list = await handlers.cron_list!({});
      const jobs = JSON.parse(list.content[0]!.text) as Array<{
        id: string;
        agent: string;
        topicId: string | number;
        maxTurns: number;
        enabled: boolean;
      }>;
      const job = jobs.find((j) => j.id === "with-opts");
      expect(job!.agent).toBe("health");
      expect(Number(job!.topicId)).toBe(6);
      expect(job!.maxTurns).toBe(15);
      expect(job!.enabled).toBe(false);
    });

    it("rejects invalid IDs", async () => {
      const result = await handlers.cron_create!({ id: "BAD ID!", schedule: "0 9 * * *", prompt: "test" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("lowercase");
    });
  });

  describe("cron_list", () => {
    it("returns empty when no jobs", async () => {
      const result = await handlers.cron_list!({});
      expect(result.content[0]!.text).toContain("No scheduled jobs");
    });

    it("lists created jobs", async () => {
      await handlers.cron_create!({ id: "job-a", schedule: "0 9 * * *", prompt: "morning" });
      await handlers.cron_create!({ id: "job-b", schedule: "0 18 * * *", prompt: "evening" });
      const result = await handlers.cron_list!({});
      const data = JSON.parse(result.content[0]!.text) as unknown[];
      expect(data.length).toBe(2);
    });

    it("filters by agent_id", async () => {
      await handlers.cron_create!({ id: "job-x", schedule: "0 9 * * *", prompt: "test", agent_id: "health" });
      await handlers.cron_create!({ id: "job-y", schedule: "0 9 * * *", prompt: "test" }); // defaults to personal
      const result = await handlers.cron_list!({ agent_id: "health" });
      const data = JSON.parse(result.content[0]!.text) as Array<{ agent: string }>;
      expect(data.length).toBe(1);
      expect(data[0]!.agent).toBe("health");
    });
  });

  describe("cron_delete", () => {
    it("deletes an existing job", async () => {
      await handlers.cron_create!({ id: "to-delete", schedule: "0 9 * * *", prompt: "bye" });
      const result = await handlers.cron_delete!({ id: "to-delete" });
      const data = JSON.parse(result.content[0]!.text) as { deleted: boolean };
      expect(data.deleted).toBe(true);

      // Verify it's gone
      const list = await handlers.cron_list!({});
      expect(list.content[0]!.text).toContain("No scheduled jobs");
    });

    it("errors for non-existent job", async () => {
      const result = await handlers.cron_delete!({ id: "no-such-job" });
      expect(result.isError).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// MEDIA TOOLS
// ══════════════════════════════════════════════════════════════════════

describe("Media tools", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    const mod = await import("../tools/letyclaw-mcp/tools/media.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  describe("image", () => {
    it("errors for non-existent file", async () => {
      const result = await handlers.image!({ input_path: "/nonexistent.png", operation: "info" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("not found");
    });
  });

  describe("image_generate", () => {
    it("errors when OPENAI_API_KEY is not set", async () => {
      delete process.env.OPENAI_API_KEY;
      const result = await handlers.image_generate!({ prompt: "a cat" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("OPENAI_API_KEY");
    });
  });

  describe("tts", () => {
    it("errors when OPENAI_API_KEY is not set", async () => {
      delete process.env.OPENAI_API_KEY;
      const result = await handlers.tts!({ text: "hello" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("OPENAI_API_KEY");
    });

    it("validates text length", async () => {
      process.env.OPENAI_API_KEY = "fake-key";
      const result = await handlers.tts!({ text: "x".repeat(5000) });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("too long");
    });

    it("errors on empty text", async () => {
      process.env.OPENAI_API_KEY = "fake-key";
      const result = await handlers.tts!({ text: "" });
      expect(result.isError).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// EXTRAS TOOLS
// ══════════════════════════════════════════════════════════════════════

describe("Extras tools", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    const mod = await import("../tools/letyclaw-mcp/tools/extras.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  describe("self_info", () => {
    it("returns current agent context", async () => {
      const result = await handlers.self_info!({});
      const data = JSON.parse(result.content[0]!.text) as {
        agent_id: string;
        topic_id: string;
        memory_files: string[];
        bootstrap_files: string[];
        all_agents: string[];
      };
      expect(data.agent_id).toBe("personal");
      expect(data.topic_id).toBe("2");
      expect(data.memory_files).toContain("2026-03-27.md");
      expect(data.bootstrap_files).toContain("AGENTS.md");
      expect(data.all_agents).toContain("personal");
      expect(data.all_agents).toContain("work");
    });

    it("includes session info", async () => {
      const result = await handlers.self_info!({});
      const data = JSON.parse(result.content[0]!.text) as {
        current_session: string;
        session_age_hours: number;
      };
      expect(data.current_session).toBe("sess-abc-123");
      expect(data.session_age_hours).toBeGreaterThan(0);
    });
  });

  describe("cross_agent_read", () => {
    it("reads another agent's file", async () => {
      const result = await handlers.cross_agent_read!({ agent_id: "work", path: "AGENTS.md" });
      expect(result.content[0]!.text).toContain("Work Agent");
    });

    it("lists another agent's directory", async () => {
      const result = await handlers.cross_agent_read!({ agent_id: "work", list_dir: "memory" });
      const data = JSON.parse(result.content[0]!.text) as { agent: string; files: string[] };
      expect(data.agent).toBe("work");
      expect(data.files).toContain("2026-03-27.md");
    });

    it("errors for non-existent agent", async () => {
      const result = await handlers.cross_agent_read!({ agent_id: "no-such-agent", path: "AGENTS.md" });
      expect(result.isError).toBe(true);
    });

    it("errors for non-existent file", async () => {
      const result = await handlers.cross_agent_read!({ agent_id: "personal", path: "nope.md" });
      expect(result.isError).toBe(true);
    });

    it("errors without path or list_dir", async () => {
      const result = await handlers.cross_agent_read!({ agent_id: "personal" });
      expect(result.isError).toBe(true);
    });

    it("blocks path traversal attempts", async () => {
      const result = await handlers.cross_agent_read!({
        agent_id: "personal",
        path: "../../../etc/passwd",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("canvas_create", () => {
    it("creates a kanban board HTML file", async () => {
      const result = await handlers.canvas_create!({
        title: "Test Board",
        content_type: "kanban",
        data: {
          columns: [
            { name: "To Do", items: ["Task A", "Task B"] },
            { name: "Done", items: ["Task C"] },
          ],
        },
      });
      const data = JSON.parse(result.content[0]!.text) as { created: boolean; path: string };
      expect(data.created).toBe(true);
      expect(existsSync(data.path)).toBe(true);

      const html = readFileSync(data.path, "utf8");
      expect(html).toContain("Test Board");
      expect(html).toContain("Task A");
      expect(html).toContain("CANVAS_DATA");
    });

    it("creates a chart HTML file", async () => {
      const result = await handlers.canvas_create!({
        title: "Sales Chart",
        content_type: "chart",
        data: { labels: ["Jan", "Feb", "Mar"], values: [10, 25, 18] },
      });
      const data = JSON.parse(result.content[0]!.text) as { created: boolean };
      expect(data.created).toBe(true);
    });

    it("creates a timeline HTML file", async () => {
      const result = await handlers.canvas_create!({
        title: "Project Timeline",
        content_type: "timeline",
        data: {
          events: [
            { date: "2026-01", title: "Kickoff" },
            { date: "2026-03", title: "Launch" },
          ],
        },
      });
      const data = JSON.parse(result.content[0]!.text) as { created: boolean };
      expect(data.created).toBe(true);
    });

    it("errors for unknown content_type", async () => {
      const result = await handlers.canvas_create!({ title: "X", content_type: "unknown" });
      expect(result.isError).toBe(true);
    });
  });

  describe("canvas_update", () => {
    it("errors for non-existent canvas", async () => {
      const result = await handlers.canvas_update!({ canvas_path: "/nonexistent.html" });
      expect(result.isError).toBe(true);
    });

    it("updates an existing canvas data", async () => {
      // First create a canvas
      const createResult = await handlers.canvas_create!({
        title: "Updatable",
        content_type: "freeform",
        data: { html: "<p>Original</p>" },
      });
      const { path } = JSON.parse(createResult.content[0]!.text) as { path: string };

      // Then update it
      const updateResult = await handlers.canvas_update!({
        canvas_path: path,
        updates: { html: "<p>Updated</p>" },
      });
      const data = JSON.parse(updateResult.content[0]!.text) as { updated: boolean };
      expect(data.updated).toBe(true);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// SERVER — tool count and definitions
// ══════════════════════════════════════════════════════════════════════

describe("MCP Server definitions", () => {
  it("all definitions have required fields", async () => {
    const modules = await Promise.all([
      import("../tools/letyclaw-mcp/tools/memory.js"),
      import("../tools/letyclaw-mcp/tools/sessions.js"),
      import("../tools/letyclaw-mcp/tools/messaging.js"),
      import("../tools/letyclaw-mcp/tools/cron.js"),
      import("../tools/letyclaw-mcp/tools/media.js"),
      import("../tools/letyclaw-mcp/tools/extras.js"),
    ]) as MCPToolModule[];

    for (const mod of modules) {
      for (const def of mod.definitions) {
        expect(def).toHaveProperty("name");
        expect(def).toHaveProperty("description");
        expect(def).toHaveProperty("inputSchema");
        expect(def.inputSchema.type).toBe("object");
        expect(typeof def.name).toBe("string");
        expect(def.name.length).toBeGreaterThan(0);
        expect(typeof def.description).toBe("string");
        expect(def.description.length).toBeGreaterThan(10);
      }
    }
  });

  it("all definitions have matching handlers", async () => {
    const modules = await Promise.all([
      import("../tools/letyclaw-mcp/tools/memory.js"),
      import("../tools/letyclaw-mcp/tools/sessions.js"),
      import("../tools/letyclaw-mcp/tools/messaging.js"),
      import("../tools/letyclaw-mcp/tools/cron.js"),
      import("../tools/letyclaw-mcp/tools/media.js"),
      import("../tools/letyclaw-mcp/tools/extras.js"),
    ]) as MCPToolModule[];

    for (const mod of modules) {
      for (const def of mod.definitions) {
        expect(mod.handlers).toHaveProperty(def.name);
        expect(typeof mod.handlers[def.name]).toBe("function");
      }
    }
  });

  it("no duplicate tool names", async () => {
    const modules = await Promise.all([
      import("../tools/letyclaw-mcp/tools/memory.js"),
      import("../tools/letyclaw-mcp/tools/sessions.js"),
      import("../tools/letyclaw-mcp/tools/messaging.js"),
      import("../tools/letyclaw-mcp/tools/cron.js"),
      import("../tools/letyclaw-mcp/tools/media.js"),
      import("../tools/letyclaw-mcp/tools/extras.js"),
    ]) as MCPToolModule[];

    const names = modules.flatMap((m) => m.definitions.map((d) => d.name));
    const uniqueNames = new Set(names);
    expect(names.length).toBe(uniqueNames.size);
  });
});
