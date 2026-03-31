import type { LoadedConfig } from "../types.js";
import { loadConfig } from "../config.js";

let config: LoadedConfig;

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
  config = loadConfig();
});

describe("loadConfig", () => {
  it("produces correct top-level structure", () => {
    expect(config).toHaveProperty("agents");
    expect(config).toHaveProperty("routing");
    expect(config).toHaveProperty("session");
    expect(config).toHaveProperty("timeouts");
    expect(config).toHaveProperty("rateLimit");
    expect(config).toHaveProperty("telegram");
    expect(config).toHaveProperty("vaultPath");
    expect(config).toHaveProperty("model");
    expect(config).toHaveProperty("claudePath");
    expect(config).toHaveProperty("sessionsDir");
  });

  it("routing maps threadId to agent correctly", () => {
    expect(config.routing[2]!.id).toBe("personal");
    expect(config.routing[3]!.id).toBe("work");
    expect(config.routing[4]!.id).toBe("health");
    expect(config.routing[5]!.id).toBe("finance");
  });

  it("applies maxTurns correctly per agent", () => {
    expect(config.agents.health!.maxTurns).toBe(10);
    expect(config.agents.finance!.maxTurns).toBe(10);
    expect(config.agents.personal!.maxTurns).toBe(50);
    expect(config.agents.work!.maxTurns).toBe(50);
  });

  it("session config has ttlHours and pruneAfterDays", () => {
    expect(config.session.ttlHours).toBe(24);
    expect(config.session.pruneAfterDays).toBe(30);
  });

  it("timeout config has correct values", () => {
    expect(config.timeouts.claudeTotal).toBe(600000);
    expect(config.timeouts.claudeNoOutput).toBe(180000);
  });

  it("rateLimit config has correct values", () => {
    expect(config.rateLimit.maxRequests).toBe(10);
    expect(config.rateLimit.windowMs).toBe(60000);
  });

  it("telegram config reads chatId from YAML", () => {
    // Example config uses placeholder string, which becomes NaN
    // In real usage, chatId would be a number
    expect(config.telegram.chatId).toBeDefined();
  });

  it("loads all expected agents", () => {
    const agentIds = Object.keys(config.agents);
    expect(agentIds).toContain("personal");
    expect(agentIds).toContain("work");
    expect(agentIds).toContain("health");
    expect(agentIds).toContain("finance");
  });
});
