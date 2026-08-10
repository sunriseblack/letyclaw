#!/usr/bin/env node
/**
 * One-time, MANUAL backfill of open loops from recent memory + open TickTick
 * tasks. Idempotent (loop_open dedupes), but it spends tokens (one Claude turn
 * per domain) so it is NOT run on deploy — run it by hand and eyeball the result:
 *
 *   node scripts/backfill-loops.mjs health
 *
 * After the ledger is live, briefings open loops for new items organically, so
 * this is only needed to capture what is ALREADY open at cut-over.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "js-yaml";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOMAIN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const domain = process.argv[2]?.trim();
const VAULT = process.env.VAULT_PATH || process.env.LETYCLAW_VAULT_PATH || "/root/vault";
const CLAUDE = process.env.CLAUDE_PATH || "claude";
const CONFIG_PATH = resolve(
  process.env.LETYCLAW_CONFIG_FILE || join(PROJECT_ROOT, "config", "letyclaw.yaml"),
);

function fail(message) {
  console.error(`backfill configuration error: ${message}`);
  process.exit(2);
}

if (!domain) {
  fail("pass an explicit configured agent ID, for example: node scripts/backfill-loops.mjs health");
}
if (!DOMAIN_ID_RE.test(domain)) {
  fail(`invalid agent ID: ${domain}`);
}
if (!existsSync(CONFIG_PATH)) {
  fail(`config file not found: ${CONFIG_PATH}`);
}

let rawConfig;
try {
  rawConfig = YAML.load(readFileSync(CONFIG_PATH, "utf8"));
} catch (error) {
  fail(`could not read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
}
const configuredIds = Array.isArray(rawConfig?.agents?.list)
  ? rawConfig.agents.list
    .map((agent) => typeof agent?.id === "string" ? agent.id.trim() : "")
    .filter(Boolean)
  : [];
if (!configuredIds.includes(domain)) {
  fail(`agent "${domain}" is not configured in ${CONFIG_PATH}; configured agents: ${configuredIds.join(", ") || "none"}`);
}
if (!existsSync(VAULT)) {
  fail(`vault path not found: ${VAULT}`);
}

const prompt = [
  `Backfill OPEN LOOPS for the "${domain}" domain.`,
  `Read the last 7 days of ${domain}/memory/*.md and your open TickTick tasks.`,
  `For each genuinely OPEN item that still needs follow-through (deadline not`,
  `passed, not already resolved), call loop_open ONCE with: a short title, a`,
  `concrete next_action, due if known, priority 1-5, and source_ref whenever it`,
  `came from an email/notification/message (use that id) so it dedupes across`,
  `runs. If the item is ALREADY a TickTick task, pass mirror_ticktick:false (it`,
  `already exists). Do NOT open loops for things already handled. loop_open is`,
  `idempotent — re-running this is safe. Reply with a one-line count when done.`,
].join(" ");

const child = spawn(
  CLAUDE,
  ["-p", prompt, "--dangerously-skip-permissions", "--max-turns", "25", "--output-format", "text"],
  { cwd: VAULT, stdio: "inherit", env: { ...process.env, LETYCLAW_AGENT_ID: domain, LETYCLAW_TOPIC_ID: "" } },
);
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => { console.error("backfill spawn failed:", err.message); process.exit(1); });
