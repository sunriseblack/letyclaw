#!/usr/bin/env npx tsx
/**
 * Template engine for generating unified CLAUDE.md from user config.
 *
 * Reads config/letyclaw.yaml and agents/templates/ to produce a single
 * CLAUDE.md file that gets deployed to the vault root.
 *
 * Usage:
 *   npx tsx scripts/generate-claude-md.ts [--output path/to/CLAUDE.md]
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Types ────────────────────────────────────────────────────────────

interface TopicConfig {
  id: string;
  name: string;
  thread_id: number;
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

interface UserConfig {
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

// ── Template loader ──────────────────────────────────────────────────

function loadTemplate(name: string): string {
  const path = join(ROOT, "agents", "templates", name);
  if (!existsSync(path)) {
    console.warn(`Template not found: ${path}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

// ── Section generators ───────────────────────────────────────────────

function generateTopicRouting(topics: TopicConfig[]): string {
  return topics
    .map((t) => `- **${t.id}** (topic ${t.thread_id}) — ${t.description || t.name}`)
    .join("\n");
}

function generateBrowserSection(integrations: Record<string, IntegrationConfig>): string {
  if (!integrations.browser?.enabled) return "";
  return loadTemplate("integrations/browser.md.tmpl");
}

function generateVoiceSection(integrations: Record<string, IntegrationConfig>): string {
  if (!integrations.voice?.enabled) return "";
  return loadTemplate("integrations/voice.md.tmpl");
}

function generateEmailSection(topic: TopicConfig): string {
  if (!topic.email_accounts?.length) return "";
  const lines = topic.email_accounts.map((acc) => {
    const mcp = acc.mcp || "email";
    return `- **${acc.address}** — Use \`${mcp}\` MCP${acc.account_id ? `, account \`${acc.account_id}\`` : ""}`;
  });
  return `### Email Access\n${lines.join("\n")}`;
}

function generateSlackSection(topic: TopicConfig): string {
  if (!topic.slack_workspaces?.length) return "";
  const ws = topic.slack_workspaces.map((w) => `"${w}"`).join(", ");
  return `### Slack Access\nUse ONLY workspace(s): ${ws}`;
}

function generateTopicSection(topic: TopicConfig): string {
  const parts: string[] = [];

  parts.push(`## Domain: ${topic.name}\n`);

  if (topic.instructions) {
    parts.push(`### Permanent Facts\n${topic.instructions}\n`);
  }

  // Tool restrictions (email, slack)
  const emailSection = generateEmailSection(topic);
  const slackSection = generateSlackSection(topic);
  if (emailSection || slackSection) {
    parts.push("### Tool Access");
    if (emailSection) parts.push(emailSection);
    if (slackSection) parts.push(slackSection);
    parts.push("");
  }

  if (topic.standing_instructions?.length) {
    parts.push("### Standing Instructions");
    for (const inst of topic.standing_instructions) {
      parts.push(`- ${inst}`);
    }
    parts.push("");
  }

  // Privacy zones
  if (topic.privacy_zones?.length) {
    parts.push("### Privacy Zones");
    for (const zone of topic.privacy_zones) {
      parts.push(`- \`${zone.path}\` — ${zone.level} sensitivity`);
    }
    parts.push("");
  }

  if (topic.red_lines?.length) {
    parts.push("### Red Lines");
    for (const line of topic.red_lines) {
      parts.push(`- ${line}`);
    }
    parts.push("");
  }

  parts.push("---\n");
  return parts.join("\n");
}

// ── Main generator ───────────────────────────────────────────────────

export function generateClaudeMd(config: UserConfig): string {
  const botName = config.bot?.name || "Letyclaw";
  const ownerName = config.bot?.owner || "Owner";
  const languages = config.bot?.languages || ["en"];
  const topics = config.topics || [];
  const integrations = config.integrations || {};

  const ownerContext = languages.length > 1
    ? `Languages: ${languages.join(", ")}. Default to ${config.bot?.default_language || languages[0]}.`
    : "";

  const topicRouting = generateTopicRouting(topics);
  const browserSection = generateBrowserSection(integrations);
  const voiceSection = generateVoiceSection(integrations);
  const topicSections = topics.map(generateTopicSection).join("\n");

  // Build from base template
  let output = loadTemplate("base.md.tmpl");

  // Replace placeholders
  const replacements: Record<string, string> = {
    "{{bot_name}}": botName,
    "{{owner_name}}": ownerName,
    "{{owner_context}}": ownerContext,
    "{{topic_routing}}": topicRouting,
    "{{browser_section}}": browserSection,
    "{{voice_section}}": voiceSection,
    "{{topic_sections}}": topicSections,
  };

  for (const [key, value] of Object.entries(replacements)) {
    output = output.replaceAll(key, value);
  }

  // Clean up empty lines from missing sections
  output = output.replace(/\n{3,}/g, "\n\n");

  return output.trim() + "\n";
}

// ── CLI entry point ──────────────────────────────────────────────────

function main(): void {
  // Load user config
  const configPaths = [
    join(ROOT, "config", "letyclaw.yaml"),
    join(ROOT, "config", "letyclaw.example.yaml"),
  ];

  let configPath: string | undefined;
  for (const p of configPaths) {
    if (existsSync(p)) {
      configPath = p;
      break;
    }
  }

  if (!configPath) {
    console.error("Error: No config file found. Create config/letyclaw.yaml or run the setup wizard.");
    process.exit(1);
  }

  const rawConfig = YAML.load(readFileSync(configPath, "utf8")) as Record<string, unknown>;

  // Map from the agent config format to the template engine format
  const userConfig: UserConfig = {
    bot: (rawConfig.bot as UserConfig["bot"]) || { name: "Letyclaw", owner: "Owner" },
    topics: (rawConfig.topics as TopicConfig[]) || [],
    integrations: (rawConfig.integrations as Record<string, IntegrationConfig>) || {},
  };

  const claudeMd = generateClaudeMd(userConfig);

  // Determine output path
  const outputIdx = process.argv.indexOf("--output");
  const outputPath = outputIdx >= 0 && process.argv[outputIdx + 1]
    ? process.argv[outputIdx + 1]!
    : join(ROOT, "agents", "unified", "CLAUDE.md");

  writeFileSync(outputPath, claudeMd);
  console.log(`Generated: ${outputPath} (${claudeMd.length} chars, ${userConfig.topics?.length || 0} topics)`);
}

// Run if called directly
if (process.argv[1]?.endsWith("generate-claude-md.ts") || process.argv[1]?.endsWith("generate-claude-md.js")) {
  main();
}
