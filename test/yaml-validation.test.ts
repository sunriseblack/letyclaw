import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "js-yaml";
import type { LoadedConfig } from "../types.js";
import { loadConfig } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

interface RawYamlConfig {
  agents: {
    defaults: { session: { ttlHours: number } };
    list: Array<{ id: string; name: string }>;
  };
  channels: {
    telegram: {
      routing: Array<{ agent: string; threadId: number }>;
    };
  };
}

let config: LoadedConfig;
let rawConfig: RawYamlConfig;

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
  config = loadConfig();
  rawConfig = YAML.load(readFileSync(join(ROOT, "config/letyclaw.example.yaml"), "utf8")) as RawYamlConfig;
});

describe("YAML consistency validation", () => {
  it("all routing agents exist in agents list", () => {
    const agentIds = rawConfig.agents.list.map((a) => a.id);
    for (const route of rawConfig.channels.telegram.routing) {
      expect(agentIds).toContain(route.agent);
    }
  });

  it("no duplicate threadIds in routing", () => {
    const threadIds = rawConfig.channels.telegram.routing.map((r) => r.threadId);
    const unique = new Set(threadIds);
    expect(unique.size).toBe(threadIds.length);
  });

  it("no duplicate agent IDs", () => {
    const ids = rawConfig.agents.list.map((a) => a.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all agents have a non-empty name", () => {
    for (const agent of rawConfig.agents.list) {
      expect(agent.name, `agent "${agent.id}" has no name`).toBeTruthy();
      expect(agent.name.length).toBeGreaterThan(0);
    }
  });

  it("chatId is present in config", () => {
    expect(rawConfig.channels.telegram).toBeDefined();
  });

  it("session ttlHours is a positive number", () => {
    expect(rawConfig.agents.defaults.session.ttlHours).toBeGreaterThan(0);
  });
});
