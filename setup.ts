/**
 * Letyclaw Telegram Setup Wizard
 *
 * Interactive first-run configuration via Telegram.
 * Walks the user through: bot name, owner, timezone, topics, integrations.
 * Generates main + cron YAML, shared instructions, and isolated domain files.
 *
 * Usage:
 *   npx tsx setup.ts              — Start the setup wizard
 *   node dist/setup.js            — After build
 */
import TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import YAML from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = basename(__dirname) === "dist" ? dirname(__dirname) : __dirname;

function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ── Types ────────────────────────────────────────────────────────────

export interface TopicSetup {
  id: string;
  name: string;
  threadId: number;
  description: string;
  maxTurns: number;
}

export interface SetupState {
  step: string;
  botName: string;
  ownerName: string;
  timezone: string;
  chatId: number;
  userId: number;
  topics: TopicSetup[];
  currentTopicName?: string;
  integrations: string[];
}

// ── Setup flow ───────────────────────────────────────────────────────

export async function runSetupWizard(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("Error: TELEGRAM_BOT_TOKEN environment variable is required.");
    console.error("Get a token from @BotFather on Telegram, then:");
    console.error("  TELEGRAM_BOT_TOKEN=your-token npx tsx setup.ts");
    process.exit(1);
  }

  const bot = new TelegramBot(token, { polling: true });
  const state: SetupState = {
    step: "welcome",
    botName: "Letyclaw",
    ownerName: "",
    timezone: "UTC",
    chatId: 0,
    userId: 0,
    topics: [],
    integrations: [],
  };

  console.log("Setup wizard started. Send a message to your bot on Telegram to begin.");

  bot.on("message", async (msg: Message) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim() || "";
    const userId = msg.from?.id || 0;

    // Track the user and chat
    if (!state.userId && userId) state.userId = userId;

    try {
      switch (state.step) {
        case "welcome": {
          state.chatId = chatId;
          state.userId = userId;
          await bot.sendMessage(chatId,
            "Welcome to Letyclaw setup! I'll help you configure your AI assistant.\n\n" +
            "First, what should I call you? (Your name)"
          );
          state.step = "owner_name";
          break;
        }

        case "owner_name": {
          if (!text) {
            await bot.sendMessage(chatId, "Please enter the name the assistant should use for you.");
            break;
          }
          state.ownerName = text;
          await bot.sendMessage(chatId,
            `Got it, ${text}! What would you like to name your bot? (default: Letyclaw)`
          );
          state.step = "bot_name";
          break;
        }

        case "bot_name": {
          state.botName = text.toLowerCase() === "default" || !text ? "Letyclaw" : text;
          await bot.sendMessage(chatId,
            `Bot name: ${state.botName}\n\n` +
            "What timezone are you in? (e.g., America/New_York, Europe/London, Asia/Tokyo)\n" +
            "Default: UTC"
          );
          state.step = "timezone";
          break;
        }

        case "timezone": {
          const timezone = text.toLowerCase() === "default" || !text ? "UTC" : text;
          if (!isValidTimezone(timezone)) {
            await bot.sendMessage(chatId,
              `"${timezone}" is not a valid IANA timezone. Try a value such as Europe/London or America/New_York.`
            );
            break;
          }
          state.timezone = timezone;
          await bot.sendMessage(chatId,
            `Timezone: ${state.timezone}\n\n` +
            "Now let's set up your topics. Each topic is a separate conversation thread in a Telegram group.\n\n" +
            "You need a Telegram group with 'Topics' enabled. Create one if you haven't already:\n" +
            "1. Create a new group\n" +
            "2. Go to Group Settings → Topics → Enable\n" +
            "3. Add this bot as an admin\n" +
            "4. Send any message in the group\n\n" +
            "Once your bot is added to the group, send a message in the group and I'll detect the IDs.\n\n" +
            "Or if you already know your group ID, send it now (e.g., -1001234567890)"
          );
          state.step = "detect_group";
          break;
        }

        case "detect_group": {
          if (chatId < 0) {
            // Message came from a group
            state.chatId = chatId;
            await bot.sendMessage(chatId,
              `Detected group ID: ${chatId}\n\n` +
              "Now let's create topics. What should the first topic be called?\n" +
              "(e.g., 'Personal', 'Work', 'Health')"
            );
            state.step = "topic_name";
          } else if (/^-100\d{6,}$/.test(text) && Number.isSafeInteger(Number(text))) {
            // User manually entered a group ID
            state.chatId = Number(text);
            await bot.sendMessage(chatId,
              `Group ID set to: ${state.chatId}\n\n` +
              "Now let's set up topics. What should the first topic be called?\n" +
              "(e.g., 'Personal', 'Work', 'Health')"
            );
            state.step = "topic_name";
          } else {
            await bot.sendMessage(chatId,
              "That doesn't look like a group ID. Either:\n" +
              "• Send a message in your group (where the bot is admin), or\n" +
              "• Enter the group ID manually (starts with -100...)"
            );
          }
          break;
        }

        case "topic_name": {
          if (text.toLowerCase() === "done") {
            if (state.topics.length === 0) {
              await bot.sendMessage(chatId, "You need at least one topic. What should it be called?");
              break;
            }
            await askIntegrations(bot, chatId, state);
            break;
          }

          if (!text) {
            await bot.sendMessage(chatId, "Please enter a topic name, or say 'done'.");
            break;
          }

          state.currentTopicName = text;
          await bot.sendMessage(chatId,
            `Topic: "${text}"\n\nBriefly describe what this assistant should help with:`
          );
          state.step = "topic_description";
          break;
        }

        case "topic_description": {
          const topicId = state.topics.length > 0
            ? Math.max(...state.topics.map((t) => t.threadId)) + 1
            : 2;

          // Try to create a forum topic in the group
          let actualThreadId = topicId;
          try {
            const created = await bot.createForumTopic(state.chatId, state.currentTopicName!) as unknown as { message_thread_id: number };
            actualThreadId = created.message_thread_id;
            await bot.sendMessage(state.chatId,
              `Topic "${state.currentTopicName}" created!`,
              { message_thread_id: actualThreadId }
            );
          } catch {
            // If we can't create topics (not admin, or DM setup), use manual IDs
            console.log(`Could not auto-create topic, using thread ID ${topicId}`);
          }

          const baseId = state.currentTopicName!.toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || `topic-${state.topics.length + 1}`;
          let id = baseId;
          for (let suffix = 2; state.topics.some((topic) => topic.id === id); suffix++) {
            id = `${baseId}-${suffix}`;
          }
          state.topics.push({
            id,
            name: state.currentTopicName!,
            threadId: actualThreadId,
            description: text,
            maxTurns: 50,
          });

          const sendTarget = state.chatId < 0 ? state.chatId : chatId;
          await bot.sendMessage(sendTarget,
            `Added topic "${state.currentTopicName}" (thread ${actualThreadId})\n\n` +
            `Topics so far: ${state.topics.map((t) => t.name).join(", ")}\n\n` +
            "Add another topic name, or say 'done' to continue."
          );
          state.step = "topic_name";
          break;
        }

        case "integrations": {
          const selected = text.split(/[,\s]+/).filter((s) => s.match(/^\d$/));
          const integrationMap: Record<string, string> = {
            "1": "browser", "2": "voice",
          };

          if (text.toLowerCase() === "skip" || text.toLowerCase() === "none") {
            state.integrations = [];
          } else {
            state.integrations = selected.map((n) => integrationMap[n] || "").filter(Boolean);
            if (!state.integrations.length) {
              await bot.sendMessage(chatId, "Reply with 1, 2, both numbers, or 'skip'.");
              break;
            }
          }

          await generateAndSave(bot, chatId, state);
          break;
        }

        default: {
          await bot.sendMessage(chatId, "Something went wrong. Restarting setup...");
          state.step = "welcome";
          break;
        }
      }
    } catch (err) {
      console.error("Setup error:", err instanceof Error ? err.message : String(err));
      await bot.sendMessage(chatId, `Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

async function askIntegrations(bot: TelegramBot, chatId: number, state: SetupState): Promise<void> {
  await bot.sendMessage(chatId,
    "Optional capabilities to expose. This updates tool visibility; it does not install services or credentials. " +
    "Reply with numbers (for example, '1 2') or 'skip':\n\n" +
    "1. Audited browser gateway (separate host setup required)\n" +
    "2. Voice calls (Vapi credentials required)\n\n" +
    "Email, Slack, flight search, market data, and other external MCPs are configured separately after setup."
  );
  state.step = "integrations";
}

// ── Config generation ────────────────────────────────────────────────

async function generateAndSave(bot: TelegramBot, chatId: number, state: SetupState): Promise<void> {
  const config = buildConfig(state);
  const configYaml = YAML.dump(config, { lineWidth: 120, noRefs: true });

  const configDir = join(PROJECT_ROOT, "config");
  mkdirSync(configDir, { recursive: true });

  const configPath = join(configDir, "letyclaw.yaml");
  writePrivateFile(configPath, configYaml);

  const cronPath = join(configDir, "cron.yaml");
  const wroteCron = !existsSync(cronPath);
  if (wroteCron) {
    writePrivateFile(cronPath, YAML.dump(buildCronConfig(state), { lineWidth: 120, noRefs: true }));
  }

  // Generate one shared file plus isolated per-domain files. Keep a local
  // generated copy and deploy the same artifacts to the active vault so the
  // runtime works immediately without exposing one topic's facts to another.
  const mod = await import("./scripts/generate-claude-md.js") as {
    generateClaudeMd: (cfg: Record<string, unknown>) => string;
    generateDomainInstructions: (cfg: Record<string, unknown>) => Record<string, string>;
  };
  const claudeMd = mod.generateClaudeMd(config as Record<string, unknown>);
  const domains = mod.generateDomainInstructions(config as Record<string, unknown>);
  const generatedDir = join(PROJECT_ROOT, "agents", "unified");
  const generatedDomainsDir = join(generatedDir, "domains");
  mkdirSync(generatedDomainsDir, { recursive: true });
  writePrivateFile(join(generatedDir, "CLAUDE.md"), claudeMd);
  for (const [id, instructions] of Object.entries(domains)) {
    writePrivateFile(join(generatedDomainsDir, `${id}.md`), instructions);
  }

  const vaultPath = resolve(process.env.VAULT_PATH?.trim() || join(PROJECT_ROOT, "vault"));
  const vaultDomainsDir = join(vaultPath, ".letyclaw", "domains");
  mkdirSync(vaultDomainsDir, { recursive: true });
  writePrivateFile(join(vaultPath, "CLAUDE.md"), claudeMd);
  for (const [id, instructions] of Object.entries(domains)) {
    writePrivateFile(join(vaultDomainsDir, `${id}.md`), instructions);
  }

  // Summary
  const topicList = state.topics.map((t) => `  • ${t.name} (topic ${t.threadId})`).join("\n");
  const intList = state.integrations.length > 0
    ? state.integrations.join(", ")
    : "none";

  await bot.sendMessage(chatId,
    `Setup complete!\n\n` +
    `Bot: ${state.botName}\n` +
    `Owner: ${state.ownerName}\n` +
    `Timezone: ${state.timezone}\n` +
    `Group: ${state.chatId}\n\n` +
    `Topics:\n${topicList}\n\n` +
    `Integrations: ${intList}\n\n` +
    `Config saved to: config/letyclaw.yaml\n` +
    `${wroteCron ? "Cron config saved to" : "Existing cron config kept at"}: config/cron.yaml\n` +
    `Instructions deployed to: ${vaultPath}\n\n` +
    `Next steps:\n` +
    `1. Review config/letyclaw.yaml and config/cron.yaml\n` +
    `2. Set environment variables in .env\n` +
    `3. Register the local MCP server (see README)\n` +
    `4. Run: npm start\n\n` +
    `Try sending a message in one of your topics!`
  );

  console.log(`\nSetup complete! Config saved to ${configPath}`);
  console.log(`Instructions deployed to ${vaultPath}`);
  console.log("Register the local MCP server, then run 'npm start' to launch your bot.");

  // Give time for the message to send, then exit
  setTimeout(() => process.exit(0), 2000);
}

export function buildConfig(state: SetupState): Record<string, unknown> {
  const topics = state.topics.map((t) => ({
    id: t.id,
    name: t.name,
    thread_id: t.threadId,
    max_turns: t.maxTurns,
    description: t.description,
    instructions: `${t.description}\nCustomize this section with permanent facts about the ${t.name} domain.`,
    standing_instructions: [
      "Write session memory after substantive conversations",
      "Be concise and direct",
    ],
  }));

  const integrations: Record<string, { enabled: boolean }> = {};
  for (const key of ["browser", "voice"]) {
    integrations[key] = { enabled: state.integrations.includes(key) };
  }
  const optionalToolsets = ["browser", "connectors", "gdrive", "gmail", "media", "ticktick", "voice"];
  const enabledOptionalToolsets = new Set(state.integrations);
  const disabledOptionalToolsets = optionalToolsets.filter((name) => !enabledOptionalToolsets.has(name));

  return {
    bot: {
      name: state.botName,
      owner: state.ownerName,
      timezone: state.timezone,
      languages: ["en"],
      default_language: "en",
    },
    agents: {
      defaults: {
        maxTurns: 10,
        session: { ttlHours: 24, pruneAfterDays: 30 },
        timeouts: { claudeTotal: 1200000, claudeMaxContinuations: 2 },
        rateLimit: { maxRequests: 10, windowMs: 60000 },
      },
      list: state.topics.map((t) => ({
        id: t.id,
        name: t.name,
        maxTurns: t.maxTurns,
        disabledToolsets: disabledOptionalToolsets,
      })),
    },
    channels: {
      telegram: {
        chatId: state.chatId,
        accounts: [{ id: "main", allowFrom: [state.userId] }],
        routing: state.topics.map((t) => ({
          agent: t.id,
          threadId: t.threadId,
        })),
      },
    },
    topics,
    integrations,
  };
}

export function buildCronConfig(state: Pick<SetupState, "timezone">): Record<string, unknown> {
  return {
    cron: {
      timezone: state.timezone,
      jobs: [],
    },
  };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

// ── CLI entry point ──────────────────────────────────────────────────

if (process.argv[1]?.endsWith("setup.ts") || process.argv[1]?.endsWith("setup.js")) {
  runSetupWizard().catch((err) => {
    console.error("Setup failed:", err);
    process.exit(1);
  });
}
