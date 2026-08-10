#!/usr/bin/env npx tsx
/**
 * Generate shared and routed Letyclaw instructions from public YAML config.
 *
 * Source execution resolves templates from the repository root. Compiled
 * execution (`node dist/scripts/generate-claude-md.js`) resolves one level
 * higher, so both documented entry points produce the same artifacts.
 *
 * Usage:
 *   node dist/scripts/generate-claude-md.js \
 *     [--config config/letyclaw.yaml] \
 *     [--output agents/unified/CLAUDE.md] \
 *     [--domains-output agents/unified/domains]
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import YAML from "js-yaml";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export function resolveProjectRoot(moduleDir = MODULE_DIR): string {
  const sourceCandidate = resolve(moduleDir, "..");
  const compiledCandidate = resolve(moduleDir, "../..");
  for (const candidate of [sourceCandidate, compiledCandidate]) {
    if (existsSync(join(candidate, "package.json")) &&
        existsSync(join(candidate, "agents", "templates", "base.md.tmpl"))) {
      return candidate;
    }
  }
  throw new Error(`Could not resolve the Letyclaw project root from ${moduleDir}`);
}

const ROOT = resolveProjectRoot();
const DOMAIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/i;

export interface TopicConfig {
  id: string;
  name: string;
  thread_id?: number;
  max_turns?: number;
  description?: string;
  instructions?: string;
  standing_instructions?: string[];
  red_lines?: string[];
  email_accounts?: Array<{
    provider: string;
    address: string;
    mcp: string;
    account_id?: string;
  }>;
  slack_workspaces?: string[];
  privacy_zones?: Array<{ path: string; level: string }>;
}

interface IntegrationConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface UserConfig {
  bot?: {
    name?: string;
    owner?: string;
    timezone?: string;
    languages?: string[];
    default_language?: string;
  };
  topics?: TopicConfig[];
  integrations?: Record<string, IntegrationConfig>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length ? values : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function topicFromRaw(value: unknown): TopicConfig | undefined {
  const raw = record(value);
  const id = stringValue(raw.id);
  if (!id) return undefined;
  const emailAccounts = Array.isArray(raw.email_accounts)
    ? raw.email_accounts.flatMap((entry) => {
      const account = record(entry);
      const address = stringValue(account.address);
      if (!address) return [];
      return [{
        provider: stringValue(account.provider) || "email",
        address,
        mcp: stringValue(account.mcp) || "email",
        ...(stringValue(account.account_id) ? { account_id: stringValue(account.account_id) } : {}),
      }];
    })
    : undefined;
  const privacyZones = Array.isArray(raw.privacy_zones)
    ? raw.privacy_zones.flatMap((entry) => {
      const zone = record(entry);
      const path = stringValue(zone.path);
      const level = stringValue(zone.level);
      return path && level ? [{ path, level }] : [];
    })
    : undefined;
  return {
    id,
    name: stringValue(raw.name) || id,
    thread_id: numberValue(raw.thread_id),
    max_turns: numberValue(raw.max_turns),
    description: stringValue(raw.description),
    instructions: stringValue(raw.instructions),
    standing_instructions: stringList(raw.standing_instructions),
    red_lines: stringList(raw.red_lines),
    email_accounts: emailAccounts?.length ? emailAccounts : undefined,
    slack_workspaces: stringList(raw.slack_workspaces),
    privacy_zones: privacyZones?.length ? privacyZones : undefined,
  };
}

/** Map both the runtime schema and setup's optional topic metadata to templates. */
export function normalizeUserConfig(rawValue: unknown): UserConfig {
  const raw = record(rawValue);
  const bot = record(raw.bot);
  const agents = record(raw.agents);
  const channels = record(raw.channels);
  const telegram = record(channels.telegram);

  const explicitTopics = Array.isArray(raw.topics)
    ? raw.topics.map(topicFromRaw).filter((topic): topic is TopicConfig => !!topic)
    : [];
  const explicitById = new Map(explicitTopics.map((topic) => [topic.id, topic]));

  const routeByAgent = new Map<string, number>();
  if (Array.isArray(telegram.routing)) {
    for (const entry of telegram.routing) {
      const route = record(entry);
      const agent = stringValue(route.agent);
      const threadId = numberValue(route.threadId);
      if (agent && threadId !== undefined && !routeByAgent.has(agent)) {
        routeByAgent.set(agent, threadId);
      }
    }
  }

  const topics: TopicConfig[] = [];
  const seen = new Set<string>();
  const agentList = Array.isArray(agents.list) ? agents.list : [];
  for (const entry of agentList) {
    const agent = record(entry);
    const id = stringValue(agent.id);
    if (!id || seen.has(id)) continue;
    const explicit = explicitById.get(id);
    topics.push({
      ...explicit,
      id,
      name: explicit?.name || stringValue(agent.name) || id,
      thread_id: explicit?.thread_id ?? routeByAgent.get(id),
      max_turns: explicit?.max_turns ?? numberValue(agent.maxTurns),
      description: explicit?.description || stringValue(agent.description) || stringValue(agent.name) || id,
    });
    seen.add(id);
  }
  for (const topic of explicitTopics) {
    if (seen.has(topic.id)) continue;
    topics.push({ ...topic, thread_id: topic.thread_id ?? routeByAgent.get(topic.id) });
    seen.add(topic.id);
  }

  const integrationsRaw = record(raw.integrations);
  const integrations: Record<string, IntegrationConfig> = {};
  for (const [name, value] of Object.entries(integrationsRaw)) {
    const integration = record(value);
    integrations[name] = { ...integration, enabled: integration.enabled === true };
  }

  return {
    bot: {
      name: stringValue(bot.name) || "Letyclaw",
      owner: stringValue(bot.owner) || "Owner",
      timezone: stringValue(bot.timezone) || "UTC",
      languages: stringList(bot.languages) || ["en"],
      default_language: stringValue(bot.default_language) || "en",
    },
    topics,
    integrations,
  };
}

function validatedTopics(topics: readonly TopicConfig[]): TopicConfig[] {
  if (!topics.length) throw new Error("At least one configured agent/topic is required");
  const seen = new Set<string>();
  return topics.map((topic) => {
    const id = topic.id.trim();
    if (!DOMAIN_ID_RE.test(id)) {
      throw new Error(`Invalid agent/topic id '${topic.id}'`);
    }
    if (seen.has(id)) throw new Error(`Duplicate agent/topic id '${id}'`);
    seen.add(id);
    return { ...topic, id, name: topic.name.trim() || id };
  });
}

function loadTemplate(name: string): string {
  const path = join(ROOT, "agents", "templates", name);
  if (!existsSync(path)) throw new Error(`Required template not found: ${path}`);
  return readFileSync(path, "utf8");
}

function replaceTemplate(template: string, replacements: Record<string, string>): string {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) output = output.replaceAll(key, value);
  const unresolved = output.match(/\{\{[^}]+\}\}/g);
  if (unresolved) throw new Error(`Unresolved template placeholders: ${[...new Set(unresolved)].join(", ")}`);
  return output.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function generateTopicRouting(topics: readonly TopicConfig[]): string {
  return topics.map((topic) => {
    const thread = topic.thread_id === undefined ? "" : ` (topic ${topic.thread_id})`;
    return `- **${topic.id}**${thread} — ${topic.name}`;
  }).join("\n");
}

function generateBrowserSection(integrations: Record<string, IntegrationConfig>): string {
  return integrations.browser?.enabled ? loadTemplate("integrations/browser.md.tmpl").trim() : "";
}

function generateToolRestrictions(topic: TopicConfig): string {
  const parts: string[] = [];
  if (topic.email_accounts?.length) {
    const accounts = topic.email_accounts.map((account) =>
      `- **${account.address}** — use \`${account.mcp || "email"}\`${account.account_id ? ` with account \`${account.account_id}\`` : ""}`,
    );
    parts.push(`### Email access\n${accounts.join("\n")}`);
  }
  if (topic.slack_workspaces?.length) {
    parts.push(`### Slack access\nUse only the configured workspace(s): ${topic.slack_workspaces.map((item) => `\`${item}\``).join(", ")}.`);
  }
  if (topic.privacy_zones?.length) {
    parts.push(`### Privacy zones\n${topic.privacy_zones.map((zone) => `- \`${zone.path}\` — ${zone.level} sensitivity`).join("\n")}`);
  }
  return parts.join("\n\n");
}

export function generateDomainMd(topicValue: TopicConfig): string {
  const topic = validatedTopics([topicValue])[0]!;
  const instructions = topic.instructions || topic.description ||
    `Handle requests that belong to the ${topic.name} domain.`;
  const standing = topic.standing_instructions?.length
    ? `## Standing instructions\n${topic.standing_instructions.map((item) => `- ${item}`).join("\n")}`
    : "";
  const redLines = topic.red_lines?.length
    ? `## Additional red lines\n${topic.red_lines.map((item) => `- ${item}`).join("\n")}`
    : "";
  return replaceTemplate(loadTemplate("topic.md.tmpl"), {
    "{{topic_id}}": topic.id,
    "{{topic_name}}": topic.name,
    "{{topic_instructions}}": instructions,
    "{{topic_tool_restrictions}}": generateToolRestrictions(topic),
    "{{topic_standing_instructions}}": standing,
    "{{topic_red_lines}}": redLines,
  });
}

export function generateDomainInstructions(configValue: UserConfig): Record<string, string> {
  const topics = validatedTopics(configValue.topics || []);
  return Object.fromEntries(topics.map((topic) => [topic.id, generateDomainMd(topic)]));
}

/** Generate shared instructions only; private topic facts stay in routed files. */
export function generateClaudeMd(configValue: UserConfig): string {
  const config = normalizeUserConfig(configValue);
  const topics = validatedTopics(config.topics || []);
  const botName = config.bot?.name || "Letyclaw";
  const ownerName = config.bot?.owner || "Owner";
  const languages = config.bot?.languages || ["en"];
  const integrations = config.integrations || {};
  const ownerContext = languages.length > 1
    ? `Languages: ${languages.join(", ")}. Default to ${config.bot?.default_language || languages[0]}.`
    : "";

  const shared = replaceTemplate(loadTemplate("base.md.tmpl"), {
    "{{bot_name}}": botName,
    "{{owner_name}}": ownerName,
    "{{owner_context}}": ownerContext,
    "{{topic_routing}}": generateTopicRouting(topics),
    "{{browser_section}}": generateBrowserSection(integrations),
  }).trim();

  // Claude auto-loads CLAUDE.md, not the compatibility TOOLS.md copy. Embed
  // the reviewed runtime contract so a fresh public setup is self-contained.
  const toolsPath = join(ROOT, "agents", "shared", "TOOLS.md");
  if (!existsSync(toolsPath)) throw new Error(`Required tool contract not found: ${toolsPath}`);
  return `${shared}\n\n---\n\n${readFileSync(toolsPath, "utf8").trim()}\n`;
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${name} requires a path`);
  return value;
}

function pathArgument(name: string, fallback: string): string {
  const value = argumentValue(name);
  return value ? resolve(process.cwd(), value) : fallback;
}

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function main(): void {
  const configuredPath = argumentValue("--config");
  const configCandidates = configuredPath
    ? [resolve(process.cwd(), configuredPath)]
    : [join(ROOT, "config", "letyclaw.yaml"), join(ROOT, "config", "letyclaw.example.yaml")];
  const configPath = configCandidates.find((candidate) => existsSync(candidate));
  if (!configPath) throw new Error("No config file found. Create config/letyclaw.yaml or run the setup wizard.");

  const rawConfig = YAML.load(readFileSync(configPath, "utf8"));
  const userConfig = normalizeUserConfig(rawConfig);
  const sharedInstructions = generateClaudeMd(userConfig);
  const domainInstructions = generateDomainInstructions(userConfig);
  const outputPath = pathArgument("--output", join(ROOT, "agents", "unified", "CLAUDE.md"));
  const domainsPath = pathArgument("--domains-output", join(ROOT, "agents", "unified", "domains"));

  mkdirSync(dirname(outputPath), { recursive: true });
  mkdirSync(domainsPath, { recursive: true });
  writePrivateFile(outputPath, sharedInstructions);
  for (const [id, instructions] of Object.entries(domainInstructions)) {
    writePrivateFile(join(domainsPath, `${id}.md`), instructions);
  }
  console.log(`Generated shared instructions: ${outputPath}`);
  console.log(`Generated ${Object.keys(domainInstructions).length} routed domain file(s): ${domainsPath}`);
}

if (["generate-claude-md.ts", "generate-claude-md.js"].includes(basename(process.argv[1] || ""))) {
  try {
    main();
  } catch (error) {
    console.error(`Instruction generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
