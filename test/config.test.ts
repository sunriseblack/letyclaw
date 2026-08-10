import type { LoadedConfig } from "../types.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  DISALLOWED_TOOLS,
  disallowedToolsFor,
  loadConfig,
  resolveBotIdentity,
} from "../config.js";

let config: LoadedConfig;
let previousModel: string | undefined;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
  previousModel = process.env.CLAUDE_MODEL;
  delete process.env.CLAUDE_MODEL;
  config = loadConfig({
    configPath: join(ROOT, "config/letyclaw.example.yaml"),
    cronConfigPath: join(ROOT, "config/cron.example.yaml"),
  });
});

afterAll(() => {
  if (previousModel === undefined) delete process.env.CLAUDE_MODEL;
  else process.env.CLAUDE_MODEL = previousModel;
});

describe("disallowedToolsFor", () => {
  it("disallows autonomous sends, paid calls, and unsafe browser execution", () => {
    expect(disallowedToolsFor(false)).toEqual(DISALLOWED_TOOLS);
    expect(DISALLOWED_TOOLS).toContain("mcp__letyclaw-tools__gmail_send");
    expect(DISALLOWED_TOOLS).toContain("mcp__letyclaw-tools__voice_call");
    expect(DISALLOWED_TOOLS).toContain("mcp__letyclaw-tools__message_send");
    expect(DISALLOWED_TOOLS).toContain("mcp__letyclaw-tools__message_typing");
    expect(DISALLOWED_TOOLS).toContain("mcp__playwright__browser_run_code_unsafe");
    expect(DISALLOWED_TOOLS).toContain("mcp__playwright__browser_evaluate");
  });

  it("allows approved Gmail sends but keeps paid voice calls gated", () => {
    const disallowed = disallowedToolsFor(true);
    expect(disallowed).not.toContain("mcp__letyclaw-tools__gmail_send");
    expect(disallowed).not.toContain("mcp__letyclaw-tools__gmail_send_draft");
    expect(disallowed).toContain("mcp__letyclaw-tools__voice_call");
    expect(disallowed).toContain("mcp__letyclaw-tools__message_send");
  });

  it("can restrict a run to named Letyclaw toolsets", () => {
    const disallowed = disallowedToolsFor({ enabledToolsets: ["memory", "sessions"] });
    expect(disallowed).not.toContain("mcp__letyclaw-tools__memory_search");
    expect(disallowed).not.toContain("mcp__letyclaw-tools__sessions_list");
    expect(disallowed).toContain("mcp__letyclaw-tools__cron_create");
    expect(disallowed).toContain("mcp__letyclaw-tools__connector_exec");
    expect(disallowed).toContain("mcp__letyclaw-tools__message_send");
  });

  it("can deny whole toolsets and individual internal or external tools", () => {
    const disallowed = disallowedToolsFor({
      disabledToolsets: ["cron"],
      disabledTools: ["message_send", "mcp__example__external_write"],
    });
    expect(disallowed).toContain("mcp__letyclaw-tools__cron_create");
    expect(disallowed).toContain("mcp__letyclaw-tools__cron_delete");
    expect(disallowed).toContain("mcp__letyclaw-tools__message_send");
    expect(disallowed).toContain("mcp__example__external_write");
    expect(disallowed).not.toContain("mcp__letyclaw-tools__memory_search");
  });

  it("keeps reversible Gmail draft creation available", () => {
    expect(DISALLOWED_TOOLS).not.toContain("mcp__letyclaw-tools__gmail_create_draft");
  });

  it("uses the MCP tool names accepted by the Claude CLI", () => {
    for (const tool of DISALLOWED_TOOLS) {
      expect(tool).toMatch(/^mcp__[a-z0-9-]+__[a-z0-9_]+$/);
    }
  });
});

describe("resolveBotIdentity", () => {
  it("uses generic public defaults and the cron timezone fallback", () => {
    expect(resolveBotIdentity(undefined, undefined)).toEqual({
      botName: "Letyclaw",
      ownerName: "Owner",
      timezone: "UTC",
    });
    expect(resolveBotIdentity({ name: " ", owner: "", timezone: " " }, "Europe/London")).toEqual({
      botName: "Letyclaw",
      ownerName: "Owner",
      timezone: "Europe/London",
    });
  });

  it("prefers trimmed bot metadata over fallbacks", () => {
    expect(resolveBotIdentity({
      name: "  My Assistant ",
      owner: " Example User ",
      timezone: " Europe/Paris ",
    }, "UTC")).toEqual({
      botName: "My Assistant",
      ownerName: "Example User",
      timezone: "Europe/Paris",
    });
  });
});

describe("loadConfig", () => {
  it("produces the current top-level structure", () => {
    for (const key of [
      "botName", "ownerName", "timezone", "agents", "routing", "session",
      "timeouts", "rateLimit", "telegram", "cron", "vaultPath", "model",
      "effort", "claudePath", "sessionsDir",
    ]) {
      expect(config).toHaveProperty(key);
    }
  });

  it("loads generic example identity and a stable public model default", () => {
    expect(config.botName).toBe("Letyclaw");
    expect(config.ownerName).toBe("Owner");
    expect(config.timezone).toBe("UTC");
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("maps generic topic IDs to agents", () => {
    expect(config.routing[2]!.id).toBe("personal");
    expect(config.routing[3]!.id).toBe("work");
    expect(config.routing[4]!.id).toBe("health");
    expect(config.routing[5]!.id).toBe("finance");
  });

  it("applies max-turn overrides and disables unconfigured optional toolsets", () => {
    expect(config.agents.personal!.maxTurns).toBe(50);
    expect(config.agents.work!.maxTurns).toBe(50);
    expect(config.agents.health!.maxTurns).toBe(10);
    expect(config.agents.finance!.maxTurns).toBe(10);
    expect(config.agents.personal!.skills).toBeUndefined();
    expect(config.agents.personal!.enabledToolsets).toBeUndefined();
    expect(config.agents.personal!.disabledToolsets).toEqual([
      "browser", "connectors", "gdrive", "gmail", "media", "ticktick", "voice",
    ]);
    expect(config.agents.work!.disabledToolsets).toEqual(config.agents.personal!.disabledToolsets);
  });

  it("loads session, continuation, and rate-limit budgets", () => {
    expect(config.session).toEqual({ ttlHours: 24, pruneAfterDays: 30 });
    expect(config.timeouts).toEqual({ claudeTotal: 1200000, claudeMaxContinuations: 2 });
    expect(config.rateLimit).toEqual({ maxRequests: 10, windowMs: 60000 });
  });

  it("retains disabled example jobs and normalizes their tool scopes", () => {
    expect(config.cron.timezone).toBe("UTC");
    expect(config.cron.jobs).toHaveLength(3);
    expect(config.cron.jobs.find((job) => job.id === "example-morning-briefing")).toMatchObject({
      delivery: "signal",
      enabled: false,
      runNow: false,
      expectsTools: true,
      enabledToolsets: ["memory", "sessions"],
      disabledToolsets: ["voice"],
      disabledTools: ["message_send", "message_typing"],
    });
    expect(config.cron.jobs.find((job) => job.id === "example-reminder")).toMatchObject({
      delivery: "nudge",
      enabled: false,
    });
  });

  it("loads exactly the four generic example agents", () => {
    expect(Object.keys(config.agents)).toEqual(["personal", "work", "health", "finance"]);
  });
});
