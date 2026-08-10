#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { resolveDailyActivity, shiftIsoDate } from "../services/health-activity.js";

const VAULT = process.env.VAULT_PATH || "/root/vault";
const DAILY_DIR = join(VAULT, "health/daily-data");
const APPLY = process.argv.includes("--apply");
const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;

interface DailyFile {
  sources?: unknown;
  oura?: unknown;
  apple_health?: unknown;
  activity?: unknown;
  [key: string]: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function atomicWrite(file: string, value: unknown): void {
  const temporary = `${file}.${process.pid}.tmp`;
  const mode = statSync(file).mode & 0o777;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode });
  renameSync(temporary, file);
}

if (!existsSync(DAILY_DIR)) {
  console.error(`Daily health directory does not exist: ${DAILY_DIR}`);
  process.exit(1);
}

const counts: Record<string, number> = {};
let changed = 0;
let scanned = 0;

for (const name of readdirSync(DAILY_DIR).filter(name => DATE_FILE.test(name)).sort()) {
  const date = name.slice(0, 10);
  const file = join(DAILY_DIR, name);
  const daily = JSON.parse(readFileSync(file, "utf8")) as DailyFile;
  const appleFile = join(DAILY_DIR, `apple-health-${date}.json`);
  const apple = existsSync(appleFile)
    ? record(JSON.parse(readFileSync(appleFile, "utf8")) as unknown)
    : record(daily.apple_health);
  const activity = resolveDailyActivity(apple, record(daily.oura), shiftIsoDate(date, -1));
  const sources = {
    ...record(daily.sources),
    apple_health: activity.apple_health.status === "trusted"
      ? "ok"
      : activity.apple_health.status === "missing" ? "missing" : "degraded",
  };
  const before = JSON.stringify({ activity: daily.activity ?? null, sources: daily.sources ?? null });
  const after = JSON.stringify({ activity, sources });

  scanned++;
  counts[activity.quality] = (counts[activity.quality] || 0) + 1;
  if (before === after) continue;
  changed++;
  if (APPLY) {
    daily.activity = activity;
    daily.sources = sources;
    atomicWrite(file, daily);
  }
}

console.log(JSON.stringify({ mode: APPLY ? "apply" : "dry-run", scanned, changed, quality: counts }));
