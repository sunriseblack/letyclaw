import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "js-yaml";
import type { LoadedConfig } from "../types.js";
import { loadConfig } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CONFIG_EXAMPLE = join(ROOT, "config/letyclaw.example.yaml");
const CRON_EXAMPLE = join(ROOT, "config/cron.example.yaml");

interface ScopedConfig {
  skills?: string[];
  enabledToolsets?: string[];
  disabledToolsets?: string[];
  disabledTools?: string[];
}

interface RawYamlConfig {
  bot: { name: string; owner: string; timezone: string };
  agents: {
    defaults: {
      session: { ttlHours: number; pruneAfterDays: number };
      timeouts: { claudeTotal: number; claudeMaxContinuations: number };
    };
    list: Array<{ id: string; name: string } & ScopedConfig>;
  };
  channels: {
    telegram: {
      chatId: string | number;
      accounts: Array<{ allowFrom: Array<string | number> }>;
      routing: Array<{ agent: string; threadId: number }>;
    };
  };
}

interface RawCronJob extends ScopedConfig {
  id: string;
  name?: string;
  schedule: string;
  agent: string;
  topicId: number;
  delivery?: string;
  prompt: string;
  enabled?: boolean;
  runNow?: boolean;
  maxTurns?: number;
  expiresAt?: string;
  precheck?: string;
  expectsTools?: boolean;
}

interface RawCronConfig {
  cron: { timezone: string; jobs: RawCronJob[] };
}

const KNOWN_TOOLSETS = new Set([
  "memory", "sessions", "messaging", "cron", "media", "voice", "extras",
  "gdrive", "ticktick", "gmail", "loops", "connectors", "browser", "skills",
]);

let config: LoadedConfig;
let rawConfig: RawYamlConfig;
let rawCron: RawCronConfig;

beforeAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "test-token";
  config = loadConfig({ configPath: CONFIG_EXAMPLE, cronConfigPath: CRON_EXAMPLE });
  rawConfig = YAML.load(readFileSync(CONFIG_EXAMPLE, "utf8")) as RawYamlConfig;
  rawCron = YAML.load(readFileSync(CRON_EXAMPLE, "utf8")) as RawCronConfig;
});

function expectValidStringList(value: string[] | undefined, label: string): void {
  if (value === undefined) return;
  expect(Array.isArray(value), label).toBe(true);
  expect(new Set(value).size, `${label} has duplicates`).toBe(value.length);
  for (const item of value) {
    expect(item.trim().length, `${label} contains an empty value`).toBeGreaterThan(0);
    expect(item, `${label} contains surrounding whitespace`).toBe(item.trim());
  }
}

function expectValidScope(scope: ScopedConfig, label: string): void {
  expectValidStringList(scope.skills, `${label}.skills`);
  expectValidStringList(scope.enabledToolsets, `${label}.enabledToolsets`);
  expectValidStringList(scope.disabledToolsets, `${label}.disabledToolsets`);
  expectValidStringList(scope.disabledTools, `${label}.disabledTools`);
  for (const toolset of [...(scope.enabledToolsets ?? []), ...(scope.disabledToolsets ?? [])]) {
    expect(KNOWN_TOOLSETS.has(toolset), `${label} uses unknown toolset ${toolset}`).toBe(true);
  }
}

describe("generic YAML examples", () => {
  it("ships only generic identity and placeholder account values", () => {
    expect(rawConfig.bot).toEqual({ name: "Letyclaw", owner: "Owner", timezone: "UTC" });
    expect(rawConfig.channels.telegram.chatId).toBe("YOUR_GROUP_ID_HERE");
    expect(rawConfig.channels.telegram.accounts[0]!.allowFrom[0]).toBe("YOUR_USER_ID_HERE");
  });

  it("has valid agent routing without duplicate IDs or thread IDs", () => {
    const agentIds = rawConfig.agents.list.map((agent) => agent.id);
    const threadIds = rawConfig.channels.telegram.routing.map((route) => route.threadId);
    expect(new Set(agentIds).size).toBe(agentIds.length);
    expect(new Set(threadIds).size).toBe(threadIds.length);
    for (const route of rawConfig.channels.telegram.routing) {
      expect(agentIds, `unknown routing agent ${route.agent}`).toContain(route.agent);
    }
    for (const agent of rawConfig.agents.list) {
      expect(agent.name.trim(), `agent ${agent.id} has no name`).toBeTruthy();
      expectValidScope(agent, `agent ${agent.id}`);
    }
  });

  it("has positive session and continuation budgets", () => {
    expect(rawConfig.agents.defaults.session.ttlHours).toBeGreaterThan(0);
    expect(rawConfig.agents.defaults.session.pruneAfterDays).toBeGreaterThan(0);
    expect(rawConfig.agents.defaults.timeouts.claudeTotal).toBeGreaterThan(0);
    expect(rawConfig.agents.defaults.timeouts.claudeMaxContinuations).toBeGreaterThanOrEqual(1);
  });

  it("points every configured progressive skill at a canonical package", () => {
    for (const scope of [...rawConfig.agents.list, ...rawCron.cron.jobs]) {
      for (const skill of scope.skills ?? []) {
        const entry = join(ROOT, ".claude", "skills", skill, "SKILL.md");
        expect(existsSync(entry), `${skill} is installed`).toBe(true);
        expect(readFileSync(entry, "utf8"), `${skill} has frontmatter`).toMatch(/^---\n/);
      }
    }
  });
});

describe("generic cron schema", () => {
  it("uses unique generic IDs and references configured routes", () => {
    const ids = rawCron.cron.jobs.map((job) => job.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith("example-"))).toBe(true);

    const routes = new Map(rawConfig.channels.telegram.routing.map((route) => [route.threadId, route.agent]));
    for (const job of rawCron.cron.jobs) {
      expect(routes.get(job.topicId), `${job.id} route`).toBe(job.agent);
      expect(job.schedule.trim(), `${job.id} schedule`).toBeTruthy();
      expect(job.prompt.trim(), `${job.id} prompt`).toBeTruthy();
      expectValidScope(job, `cron ${job.id}`);
    }
  });

  it("classifies every job and keeps examples and nudges disabled", () => {
    for (const job of rawCron.cron.jobs) {
      expect(["signal", "silent", "nudge"], `${job.id} delivery`).toContain(job.delivery);
      expect(job.enabled, `${job.id} must be opt-in`).toBe(false);
      if (job.delivery === "nudge") {
        expect(job.enabled, `${job.id} nudge must stay disabled`).toBe(false);
      }
      if (job.runNow !== undefined) expect(typeof job.runNow).toBe("boolean");
      if (job.expectsTools !== undefined) expect(typeof job.expectsTools).toBe("boolean");
    }
  });

  it("keeps disabled jobs in LoadedConfig for status and explicit runNow handling", () => {
    expect(config.cron.jobs.map((job) => job.id)).toEqual(rawCron.cron.jobs.map((job) => job.id));
    expect(config.cron.jobs.every((job) => job.enabled === false)).toBe(true);
  });
});
