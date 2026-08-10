import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import YAML from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import {
  generateClaudeMd,
  generateDomainInstructions,
  normalizeUserConfig,
  resolveProjectRoot,
} from "../scripts/generate-claude-md.js";
import { buildConfig, buildCronConfig, type SetupState } from "../setup.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("instruction generation", () => {
  it("keeps shared instructions self-contained and private domain facts routed", () => {
    const config = {
      bot: { name: "MyBot", owner: "Sam", languages: ["en"] },
      topics: [{
        id: "work",
        name: "Work",
        thread_id: 7,
        description: "Project planning",
        instructions: "Keep project decisions durable.",
      }],
      integrations: {},
    };

    const shared = generateClaudeMd(config);
    const domains = generateDomainInstructions(config);

    expect(shared).toContain("# MyBot — Sam's Personal AI");
    expect(shared).toContain("**work** (topic 7) — Work");
    expect(shared).not.toContain("Keep project decisions durable.");
    expect(shared.match(/^# Runtime & Tools$/gm)).toHaveLength(1);
    expect(shared).toContain("Outbound Approval Trailers");
    expect(domains.work).toContain("Keep project decisions durable.");
    expect(domains.work).toContain("trusted routed instruction layer");
    expect(shared + domains.work).not.toContain("{{");
  });

  it("derives routed domains from the current runtime agents/channels schema", () => {
    const normalized = normalizeUserConfig({
      bot: { name: "Letyclaw", owner: "Owner", timezone: "UTC" },
      agents: {
        list: [
          { id: "personal", name: "Personal", maxTurns: 20 },
          { id: "work", name: "Work", maxTurns: 30 },
        ],
      },
      channels: {
        telegram: {
          routing: [
            { agent: "personal", threadId: 2 },
            { agent: "work", threadId: 3 },
          ],
        },
      },
    });

    expect(normalized.topics).toEqual([
      expect.objectContaining({ id: "personal", name: "Personal", thread_id: 2, max_turns: 20 }),
      expect.objectContaining({ id: "work", name: "Work", thread_id: 3, max_turns: 30 }),
    ]);
    expect(Object.keys(generateDomainInstructions(normalized))).toEqual(["personal", "work"]);
  });

  it("renders only enabled safe integration guidance and no orphan sections", () => {
    const config = {
      topics: [{ id: "personal", name: "Personal", thread_id: 2 }],
      integrations: { browser: { enabled: true }, voice: { enabled: true } },
    };
    const shared = generateClaudeMd(config);
    const domain = generateDomainInstructions(config).personal;

    expect(shared).toContain("audited Playwright gateway");
    expect(shared).toContain("The `voice_call` tool is disabled");
    expect(shared).toContain('"kind": "voice"');
    expect(domain).not.toContain("## Standing instructions");
    expect(domain).not.toContain("## Additional red lines");
    expect(shared + domain).not.toContain("{{");
  });

  it("rejects missing, duplicate, and path-like domain ids", () => {
    expect(() => generateDomainInstructions({ topics: [] })).toThrow(/at least one/i);
    expect(() => generateDomainInstructions({ topics: [
      { id: "work", name: "Work" },
      { id: "work", name: "Duplicate" },
    ] })).toThrow(/duplicate/i);
    expect(() => generateDomainInstructions({ topics: [
      { id: "../outside", name: "Outside" },
    ] })).toThrow(/invalid/i);
  });

  it("resolves repository assets from both source and compiled module layouts", () => {
    const root = resolve(process.cwd());
    expect(resolveProjectRoot(join(root, "scripts"))).toBe(root);
    expect(resolveProjectRoot(join(root, "dist", "scripts"))).toBe(root);
  });
});

describe("setup output", () => {
  it("produces main and separate cron YAML accepted by the current loader", () => {
    const state: SetupState = {
      step: "integrations",
      botName: "Helper",
      ownerName: "Taylor",
      timezone: "America/New_York",
      chatId: -1001234567890,
      userId: 123456789,
      topics: [{
        id: "personal",
        name: "Personal",
        threadId: 2,
        description: "Personal planning",
        maxTurns: 50,
      }],
      integrations: ["browser"],
    };
    const config = buildConfig(state);
    const cron = buildCronConfig(state);
    expect(config).not.toHaveProperty("cron");
    expect(config).not.toHaveProperty("telegram");

    const directory = mkdtempSync(join(tmpdir(), "letyclaw-setup-test-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "letyclaw.yaml");
    const cronPath = join(directory, "cron.yaml");
    writeFileSync(configPath, YAML.dump(config));
    writeFileSync(cronPath, YAML.dump(cron));

    const loaded = loadConfig({ configPath, cronConfigPath: cronPath });
    expect(loaded.botName).toBe("Helper");
    expect(loaded.ownerName).toBe("Taylor");
    expect(loaded.timezone).toBe("America/New_York");
    expect(loaded.cron).toEqual({ timezone: "America/New_York", jobs: [] });
    expect(loaded.telegram.chatId).toBe(-1001234567890);
    expect(loaded.telegram.allowedUser).toBe(123456789);
    expect(loaded.routing[2]).toEqual(expect.objectContaining({ id: "personal", maxTurns: 50 }));
    expect(loaded.agents.personal?.disabledToolsets).toEqual([
      "connectors", "gdrive", "gmail", "media", "ticktick", "voice",
    ]);
  });
});

describe("project MCP defaults", () => {
  it("registers only the bundled local server at project scope", () => {
    const projectConfig = JSON.parse(readFileSync(join(process.cwd(), ".mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(Object.keys(projectConfig.mcpServers || {})).toEqual(["letyclaw-tools"]);
    expect(readFileSync(join(process.cwd(), ".mcp.json"), "utf8")).not.toMatch(
      /@playwright\/mcp@latest|email-mcp|fli-mcp|marketdata-mcp/,
    );
  });
});
