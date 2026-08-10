#!/usr/bin/env node
/**
 * Health Data Sync — fetches from Oura, Withings, reads Apple Health webhook data.
 * Called hourly by Claude via Bash during the health cron job.
 *
 * Stdout:
 *   READY: {summary}  — data synced, target hour reached
 *   SKIP: {reason}    — not yet target hour
 *
 * Writes: {VAULT}/health/daily-data/YYYY-MM-DD.json
 *
 * Env:
 *   VAULT_PATH             — default /root/vault
 *   OURA_TOKEN             — Oura Personal Access Token
 *   WITHINGS_CLIENT_ID     — Withings OAuth2 client ID
 *   WITHINGS_CLIENT_SECRET — Withings OAuth2 client secret
 *   WITHINGS_TOKEN_FILE    — default /root/letyclaw/sessions/.withings-tokens.json
 *                            (must be in a bot-writable path; `/root/letyclaw` is
 *                            bind-mounted read-only in the systemd sandbox,
 *                            only sessions/ and logs/ are writable)
 *   HEALTH_TARGET_HOUR     — default 9 (briefing window start)
 *   HEALTH_NUDGE_HOUR      — default 13 (briefing window is [TARGET, NUDGE);
 *                            past this hour, a separate cron sends a nudge
 *                            instead of running the briefing)
 *
 * Flags:
 *   --force  skip the normal morning-window and briefing-idempotency checks
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from "fs";
import { join } from "path";
import {
  annotateSparseAppleHealthPayload,
  inspectAppleActivityPayload,
  resolveDailyActivity,
  shiftIsoDate,
  type ResolvedDailyActivity,
} from "../services/health-activity.js";
import {
  filterWithingsGroupsForLocalWindow,
  getWithingsQueryBounds,
} from "../services/health-withings.js";
import { resolveDailySleep, type ResolvedDailySleep } from "../services/health-sleep.js";
import {
  getHealthMorningWaitReasons,
  shouldWaitForHealthMorningData,
} from "../services/health-briefing-readiness.js";
import { atomicWriteSharedJson } from "../services/shared-json-file.js";

// Load .env file (Claude CLI doesn't inherit all parent env vars)
const ENV_FILE = join(process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw", ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    if (!process.env[key]) process.env[key] = trimmed.slice(eq + 1);
  }
}

const VAULT = process.env.VAULT_PATH || "/root/vault";
const DAILY_DIR = join(VAULT, "health/daily-data");
const TARGET_HOUR = parseInt(process.env.HEALTH_TARGET_HOUR || "9", 10);
const NUDGE_HOUR = parseInt(process.env.HEALTH_NUDGE_HOUR || "13", 10);
const FORCE = process.argv.includes("--force");
// Nudge-check: don't sync — report whether today still lacks any usable daily
// activity (and no briefing has gone out), so the 12:30 backstop cron can decide
// deterministically without making Apple Health a hard dependency.
const NUDGE_CHECK = process.argv.includes("--nudge-check");
// Explicit date override (YYYY-MM-DD), passed by the bot's trigger watcher so a
// near-midnight tap is briefed for the date the WEBHOOK recorded — not the date
// this (>=60s-later, possibly past-midnight) process happens to compute from the
// clock. Ignored unless well-formed.
const DATE_ARG: string | null = (() => {
  const a = process.argv.find(x => x.startsWith("--date="));
  const d = a?.slice("--date=".length);
  return d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
})();

if (!existsSync(DAILY_DIR)) mkdirSync(DAILY_DIR, { recursive: true });

// ── Types ──────────────────────────────────────────────────────────

interface WithingsTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user_id: string;
}

interface OuraResult {
  [key: string]: unknown;
  _error?: string;
}

interface WithingsResult {
  [key: string]: unknown;
  _error?: string;
}

interface AppleHealthResult {
  [key: string]: unknown;
  _error?: string;
  _warning?: string;
}

interface ConsolidatedData {
  date: string;
  timezone: string;
  synced_at: string;
  sources: Record<string, string>;
  oura: OuraResult;
  withings: WithingsResult;
  apple_health: AppleHealthResult;
  apple_health_received_at?: string;
  activity: ResolvedDailyActivity;
  sleep: ResolvedDailySleep;
  briefing_sent?: boolean;
}

function sourceStatus(data: { _error?: string; [key: string]: unknown }): string {
  if (data._error) return "missing";
  const hasEndpointError = Object.values(data).some(value =>
    value && typeof value === "object" && !Array.isArray(value) &&
    typeof (value as { _error?: unknown })._error === "string",
  );
  return hasEndpointError ? "degraded" : "ok";
}

// ── Timezone ────────────────────────────────────────────────────────

function getUserTimezone(): string {
  const f = join(DAILY_DIR, "timezone.txt");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  return process.env.TZ || "UTC";
}

function getLocalHour(tz: string): number {
  return parseInt(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()),
    10,
  );
}

function isWithinBriefingWindow(tz: string): boolean {
  const h = getLocalHour(tz);
  return h >= TARGET_HOUR && h < NUDGE_HOUR;
}

function getLocalDate(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
}

function getLocalTime(tz: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date());
}

// ── Oura Ring API v2 ────────────────────────────────────────────────

async function fetchOura(date: string): Promise<OuraResult> {
  const token = process.env.OURA_TOKEN;
  if (!token) return { _error: "OURA_TOKEN not set" };

  const base = "https://api.ouraring.com/v2/usercollection";
  const headers = { Authorization: `Bearer ${token}` };
  const yesterday = shiftIsoDate(date, -1);
  const params = `start_date=${yesterday}&end_date=${date}`;
  const sleepStart = shiftIsoDate(date, -3);
  const sleepParams = `start_date=${sleepStart}&end_date=${date}`;

  const endpoints: Record<string, string> = {
    sleep: `/daily_sleep?${sleepParams}`,
    sleep_periods: `/sleep?${sleepParams}&fields=day,type,bedtime_start,bedtime_end,total_sleep_duration,time_in_bed`,
    readiness: `/daily_readiness?${params}`,
    activity: `/daily_activity?${params}`,
    workout: `/workout?${params}`,
    stress: `/daily_stress?${params}`,
    heart_rate: `/heartrate?start_datetime=${yesterday}T20:00:00&end_datetime=${date}T23:59:59`,
    spo2: `/daily_spo2?${params}`,
  };

  const result: OuraResult = {};
  const fetches = Object.entries(endpoints).map(async ([key, path]) => {
    try {
      const res = await fetch(`${base}${path}`, { headers });
      if (!res.ok) { result[key] = { _error: `HTTP ${res.status}` }; return; }
      const json: unknown = await res.json();
      const parsed = json as Record<string, unknown>;
      result[key] = parsed.data ?? json;
    } catch (err) {
      result[key] = { _error: err instanceof Error ? err.message : String(err) };
    }
  });
  await Promise.all(fetches);
  return result;
}

// ── Withings API ────────────────────────────────────────────────────

interface WithingsTokensOnDisk extends WithingsTokens {
  // Set after a 601 throttle response — skip refresh attempts until this UNIX
  // timestamp. Prevents wasting RPM and surfacing misleading errors.
  refresh_blocked_until?: number;
  // Last refresh attempt timestamp, used as a local debounce
  last_refresh_attempt?: number;
  // Set when a real auth error happens (refresh_token revoked/expired) — agent
  // should stop trying and tell the owner to re-auth via scripts/withings-auth.ts.
  needs_reauth?: boolean;
  reauth_reason?: string;
}

async function refreshWithingsToken(tokens: WithingsTokens): Promise<WithingsTokens> {
  const res = await fetch("https://wbsapi.withings.net/v2/oauth2", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "requesttoken",
      grant_type: "refresh_token",
      client_id: process.env.WITHINGS_CLIENT_ID!,
      client_secret: process.env.WITHINGS_CLIENT_SECRET!,
      refresh_token: tokens.refresh_token,
    }),
  });
  const json: unknown = await res.json();
  const parsed = json as { status: number; body?: { access_token?: string; refresh_token?: string; expires_in?: number; userid?: string; wait_seconds?: number }; error?: string };

  if (parsed.status === 601) {
    // Withings throttle — set explicit cooldown so we don't keep hammering
    const wait = parsed.body?.wait_seconds || 60;
    const err = new Error(`THROTTLE_601 wait=${wait}s`);
    (err as Error & { wait_seconds?: number }).wait_seconds = wait;
    throw err;
  }
  if (parsed.status === 401 || parsed.status === 503 || parsed.error?.includes("invalid_grant")) {
    // Refresh token revoked/expired — needs re-auth, not retry
    const err = new Error(`AUTH_FAILED status=${parsed.status} ${parsed.error || ""}`);
    (err as Error & { needs_reauth?: boolean }).needs_reauth = true;
    throw err;
  }
  if (parsed.status !== 0 || !parsed.body?.access_token) {
    throw new Error(`Withings refresh failed: ${JSON.stringify(json)}`);
  }

  const b = parsed.body;
  return {
    access_token: b.access_token!,
    refresh_token: b.refresh_token!,
    expires_at: Math.floor(Date.now() / 1000) + (b.expires_in ?? 10800),
    user_id: b.userid!,
  };
}

/**
 * Atomic token write: write to <file>.tmp, fsync, rename over <file>, and
 * keep the PREVIOUS good version at <file>.bak. Prevents the token-loss
 * pattern where a partial/failed write leaves us with no usable tokens
 * after Withings has already rotated the refresh_token server-side.
 *
 * Load order elsewhere: read <file>; if missing or corrupt, try <file>.bak.
 */
function atomicWriteTokens(file: string, tokens: WithingsTokensOnDisk): void {
  const tmp = file + ".tmp";
  const bak = file + ".bak";
  const payload = JSON.stringify(tokens, null, 2);
  writeFileSync(tmp, payload);
  // Roll current to .bak BEFORE overwriting — if rename fails, we still have both.
  if (existsSync(file)) {
    try { copyFileSync(file, bak); } catch { /* non-fatal, keep going */ }
  }
  renameSync(tmp, file);
}

function loadTokensWithFallback(file: string): WithingsTokensOnDisk | null {
  const bak = file + ".bak";
  for (const path of [file, bak]) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as WithingsTokensOnDisk;
      if (parsed.access_token && parsed.refresh_token) {
        if (path === bak) console.warn(`[withings] primary token file unreadable, fell back to ${bak}`);
        return parsed;
      }
    } catch (err) {
      console.warn(`[withings] ${path} unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

// In-process cache so we never refresh twice in a single script invocation
// (the original "keep-alive" + fetchWithings pattern triggered Withings' 10s
// dedupe throttle, which masked the real error with status 601).
let withingsTokenCache: string | null | undefined;

async function getWithingsToken(): Promise<string | null> {
  if (withingsTokenCache !== undefined) return withingsTokenCache;

  const file = process.env.WITHINGS_TOKEN_FILE || "/root/letyclaw/sessions/.withings-tokens.json";
  const tokens = loadTokensWithFallback(file);
  if (!tokens) {
    withingsTokenCache = null;
    return null;
  }

  const now = Math.floor(Date.now() / 1000);

  // Hard stop — the owner needs to re-auth via withings-auth.ts
  if (tokens.needs_reauth) {
    throw new Error(`Withings needs re-auth: ${tokens.reauth_reason || "previous auth failure"} — run: node scripts/withings-auth.js`);
  }

  // Active throttle window — don't even try
  if (tokens.refresh_blocked_until && tokens.refresh_blocked_until > now) {
    if (tokens.expires_at > now + 60) {
      withingsTokenCache = tokens.access_token;
      return tokens.access_token;
    }
    throw new Error(`Withings throttled until ${new Date(tokens.refresh_blocked_until * 1000).toISOString()} and access token already expired`);
  }

  // Token still valid for >5min — use as-is
  if (tokens.expires_at > now + 300) {
    withingsTokenCache = tokens.access_token;
    return tokens.access_token;
  }

  // Local debounce — don't retry refresh more than once per 60s in the same machine
  if (tokens.last_refresh_attempt && now - tokens.last_refresh_attempt < 60) {
    if (tokens.expires_at > now) {
      withingsTokenCache = tokens.access_token;
      return tokens.access_token;
    }
    throw new Error("Withings refresh attempted <60s ago — not retrying yet");
  }

  // Persist attempt before calling, so concurrent processes back off. Atomic
  // write preserves the previous good copy at <file>.bak in case this
  // refresh cycle dies mid-write — crucial because Withings rotates the
  // refresh_token on every use, so a lost write locks us out entirely.
  atomicWriteTokens(file, { ...tokens, last_refresh_attempt: now });

  try {
    const fresh = await refreshWithingsToken(tokens);
    atomicWriteTokens(file, { ...fresh, last_refresh_attempt: now } as WithingsTokensOnDisk);
    // Keep the .bak (pre-refresh tokens) around as a safety net. Its
    // refresh_token is invalid post-rotation, but its access_token is
    // still valid for up to ~3h — enough to survive an accidental delete
    // of the primary file until the next scheduled refresh.
    withingsTokenCache = fresh.access_token;
    return fresh.access_token;
  } catch (err) {
    const e = err as Error & { wait_seconds?: number; needs_reauth?: boolean };
    const update: WithingsTokensOnDisk = { ...tokens, last_refresh_attempt: now };
    if (e.wait_seconds) update.refresh_blocked_until = now + e.wait_seconds;
    if (e.needs_reauth) { update.needs_reauth = true; update.reauth_reason = e.message; }
    atomicWriteTokens(file, update);
    throw err;
  }
}

// Withings measure type codes → human-readable keys
// Source: https://developer.withings.com/api-reference#tag/measure/operation/measure-getmeas
const WITHINGS_MEASURE_TYPES: Record<number, { key: string; label: string; unit: string }> = {
  1:   { key: "weight_kg",              label: "Weight",                    unit: "kg" },
  4:   { key: "height_m",              label: "Height",                    unit: "m" },
  5:   { key: "fat_free_mass_kg",      label: "Fat-Free Mass",             unit: "kg" },
  6:   { key: "fat_ratio_pct",         label: "Fat Ratio",                 unit: "%" },
  8:   { key: "fat_mass_kg",           label: "Fat Mass",                  unit: "kg" },
  9:   { key: "diastolic_bp_mmhg",     label: "Diastolic BP",              unit: "mmHg" },
  10:  { key: "systolic_bp_mmhg",      label: "Systolic BP",               unit: "mmHg" },
  11:  { key: "heart_rate_bpm",        label: "Heart Rate",                unit: "bpm" },
  12:  { key: "temperature_c",         label: "Temperature",               unit: "°C" },
  54:  { key: "spo2_pct",             label: "SpO2",                      unit: "%" },
  71:  { key: "body_temp_c",          label: "Body Temperature",          unit: "°C" },
  73:  { key: "skin_temp_c",          label: "Skin Temperature",          unit: "°C" },
  76:  { key: "muscle_mass_kg",        label: "Muscle Mass",               unit: "kg" },
  77:  { key: "hydration_kg",         label: "Hydration",                 unit: "kg" },
  88:  { key: "bone_mass_kg",         label: "Bone Mass",                 unit: "kg" },
  91:  { key: "pulse_wave_velocity",   label: "Pulse Wave Velocity",       unit: "m/s" },
  123: { key: "vo2_max",              label: "VO2 Max",                   unit: "ml/min/kg" },
  130: { key: "afib_result",          label: "Atrial Fibrillation",       unit: "" },
  135: { key: "qrs_interval",         label: "QRS Interval",              unit: "ms" },
  136: { key: "pr_interval",          label: "PR Interval",               unit: "ms" },
  137: { key: "qt_interval",          label: "QT Interval",               unit: "ms" },
  138: { key: "corrected_qt_interval", label: "Corrected QT Interval",    unit: "ms" },
  139: { key: "afib_ppg",             label: "Atrial Fibrillation (PPG)", unit: "" },
  155: { key: "vascular_age",          label: "Vascular Age",              unit: "years" },
  167: { key: "nerve_health_conductance", label: "Nerve Health Conductance (feet)", unit: "" },
  168: { key: "extracellular_water_kg", label: "Extracellular Water",      unit: "kg" },
  169: { key: "intracellular_water_kg", label: "Intracellular Water",      unit: "kg" },
  170: { key: "visceral_fat_index",    label: "Visceral Fat",              unit: "" },
  173: { key: "fat_free_mass_segments_kg", label: "Fat-Free Mass (segments)", unit: "kg" },
  174: { key: "fat_mass_segments_kg",  label: "Fat Mass (segments)",       unit: "kg" },
  175: { key: "muscle_mass_segments_kg", label: "Muscle Mass (segments)",  unit: "kg" },
  196: { key: "electrodermal_activity", label: "Electrodermal Activity (feet)", unit: "" },
  226: { key: "basal_metabolic_rate",  label: "Basal Metabolic Rate",      unit: "kcal/day" },
  227: { key: "metabolic_age",         label: "Metabolic Age",             unit: "years" },
  229: { key: "electrochemical_skin_conductance", label: "Electrochemical Skin Conductance", unit: "" },
};

interface WithingsMeasureGroup {
  grpid: number;
  date: number;
  measures: Array<{ type: number; value: number; unit: number }>;
  model?: string;
}

function parseWithingsMeasures(body: { measuregrps?: WithingsMeasureGroup[] }): Record<string, unknown> {
  const grps = body.measuregrps || [];
  if (grps.length === 0) return {};

  // Withings returns groups newest-first; iterating in that order and
  // overwriting on each match would leave the OLDEST value as the survivor.
  // Sort newest→oldest and take the first occurrence of each measure type so
  // the freshest value wins. measured_at is the timestamp of the group that
  // produced the weight reading (the field readers actually care about), so
  // "weighed today?" comparisons stay honest.
  const sorted = [...grps].sort((a, b) => b.date - a.date);
  const newest = sorted[0]!; // length>0 guarded above

  const parsed: Record<string, number> = {};
  const seenAt: Record<string, number> = {};
  for (const grp of sorted) {
    for (const m of grp.measures) {
      const def = WITHINGS_MEASURE_TYPES[m.type];
      const key = def ? def.key : `type_${m.type}`;
      if (key in parsed) continue;
      parsed[key] = Math.round(m.value * Math.pow(10, m.unit) * 1000) / 1000;
      seenAt[key] = grp.date;
    }
  }

  const anchorTs = seenAt.weight_kg ?? newest.date;
  return {
    measured_at: new Date(anchorTs * 1000).toISOString(),
    device: newest.model || "unknown",
    ...parsed,
  };
}

async function fetchWithings(date: string, timezone: string): Promise<WithingsResult> {
  if (!process.env.WITHINGS_CLIENT_ID) return { _error: "WITHINGS_CLIENT_ID not set" };
  let accessToken: string | null;
  try {
    accessToken = await getWithingsToken();
    if (!accessToken) return { _error: "No Withings tokens — run: node scripts/withings-auth.js" };
  } catch (err) {
    return { _error: `Token refresh failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const headers = { Authorization: `Bearer ${accessToken}` };
  // Keep enough history to report the latest known weight even when scale use
  // is intermittent. Query with guard days, then filter by the user's local
  // date so a post-midnight measurement is never assigned to the prior day.
  const { startTs, endTs } = getWithingsQueryBounds(date);

  try {
    const res = await fetch("https://wbsapi.withings.net/measure", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "getmeas",
        startdate: String(startTs),
        enddate: String(endTs),
        category: "1",
      }),
    });
    const json: unknown = await res.json();
    const parsed = json as { status: number; body: { measuregrps?: WithingsMeasureGroup[] } };
    if (parsed.status !== 0) return { _error: `Withings API status ${parsed.status}` };
    const groups = filterWithingsGroupsForLocalWindow(
      parsed.body.measuregrps || [],
      date,
      timezone,
    );
    return parseWithingsMeasures({ measuregrps: groups });
  } catch (err) {
    return { _error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Apple Health (from webhook file) ────────────────────────────────

function readAppleHealth(date: string): AppleHealthResult {
  const f = join(DAILY_DIR, `apple-health-${date}.json`);
  if (!existsSync(f)) return { _error: "No Apple Health data received today" };
  try {
    const data = JSON.parse(readFileSync(f, "utf8")) as AppleHealthResult;
    // Preserve sparse payloads so the daily record can distinguish transport
    // absence from a delivered payload whose HealthKit queries returned empty.
    return annotateSparseAppleHealthPayload(
      data as Record<string, unknown>,
      shiftIsoDate(date, -1),
    ) as AppleHealthResult;
  } catch {
    return { _error: "Stored Apple Health payload is not valid JSON" };
  }
}

function hasResolvedActivity(date: string): boolean {
  const file = join(DAILY_DIR, `${date}.json`);
  if (!existsSync(file)) return false;
  try {
    const daily = JSON.parse(readFileSync(file, "utf8")) as Partial<ConsolidatedData>;
    return daily.activity?.quality !== undefined && daily.activity.quality !== "missing";
  } catch {
    return false;
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const tz = getUserTimezone();
  const localDate = DATE_ARG || getLocalDate(tz);
  const localTime = getLocalTime(tz);
  const outputFile = join(DAILY_DIR, `${localDate}.json`);
  let existingDaily: ConsolidatedData | null = null;
  if (existsSync(outputFile)) {
    try { existingDaily = JSON.parse(readFileSync(outputFile, "utf8")) as ConsolidatedData; }
    catch { /* treat a malformed prior file as absent; the atomic rewrite repairs it */ }
  }

  // ── Nudge-check mode (12:30 backstop cron) ──────────────────────────
  // Pure check, no sync: if today's Apple Health payload still hasn't arrived
  // (with usable metrics) AND no briefing has gone out, print a NUDGE line the
  // cron relays to the owner.
  if (NUDGE_CHECK) {
    const alreadyBriefed = existingDaily?.briefing_sent === true;
    // Apple is an enrichment source, not a hard dependency. A completed-day
    // Oura fallback is enough to avoid asking the owner to repair the Shortcut.
    const hasData = hasResolvedActivity(localDate);
    if (alreadyBriefed || hasData) {
      console.log(`SKIP: ${alreadyBriefed ? "briefing already sent" : "usable health activity present"} for ${localDate}`);
      process.exit(1);
    }
    // Count the consecutive-no-data streak (today + prior days). A one-off miss
    // is normal; a multi-day drought means the Shortcut/webhook pipeline is
    // likely broken, which a gentle daily ping won't fix — escalate instead.
    let droughtDays = 1; // today, just confirmed missing
    for (let i = 1; i <= 6; i++) {
      const priorDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() - i * 86_400_000));
      if (!hasResolvedActivity(priorDate)) droughtDays++;
      else break;
    }
    if (droughtDays >= 3) {
      console.log(`NUDGE: ⚠️ No usable completed-day activity for ${droughtDays} days — open Oura to sync the ring, then run *Health Data Sync* if Apple Watch enrichment is still needed.`);
    } else {
      console.log("NUDGE: 📱 No completed-day activity is available yet — open Oura to sync; *Health Data Sync* is optional Apple Watch enrichment.");
    }
    process.exit(0);
  }

  // All normal runs, including webhook-triggered runs, stay in the morning
  // window. --force remains the explicit operator-only bypass.
  if (!FORCE && !isWithinBriefingWindow(tz)) {
    console.log(`SKIP: ${localTime} in ${tz} — outside briefing window (${TARGET_HOUR}:00–${NUDGE_HOUR}:00)`);
    process.exit(1);
  }

  // Already sent today?
  if (!FORCE && existingDaily?.briefing_sent) {
    console.log(`SKIP: briefing already sent for ${localDate}`);
    process.exit(1);
  }

  // Apple Health is optional enrichment. The activity resolver below uses a
  // trusted completed-day Apple Watch payload when available and otherwise
  // falls back per metric to Oura without blending the values.
  const appleHealth = readAppleHealth(localDate);

  const [oura, withings] = await Promise.all([fetchOura(localDate), fetchWithings(localDate, tz)]);
  const activityDate = shiftIsoDate(localDate, -1);
  const activity = resolveDailyActivity(
    appleHealth as Record<string, unknown>,
    oura as Record<string, unknown>,
    activityDate,
  );
  const sleep = resolveDailySleep(oura as Record<string, unknown>, localDate);
  const waitReasons = getHealthMorningWaitReasons({
    activity,
    sleep,
    oura: oura as Record<string, unknown>,
    reportDate: localDate,
  });
  const finalAttemptHour = NUDGE_HOUR - 1;
  if (shouldWaitForHealthMorningData(
    waitReasons,
    getLocalHour(tz),
    finalAttemptHour,
    FORCE,
  )) {
    console.log(
      `SKIP: morning data still settling (${waitReasons.join(", ")}) — ` +
      `waiting for the next sync tick; final attempt is ${finalAttemptHour}:00 ${tz}`,
    );
    process.exit(1);
  }

  const appleInspection = inspectAppleActivityPayload(
    appleHealth as Record<string, unknown>,
    activityDate,
  );
  const appleStatus = appleHealth._error
    ? "missing"
    : appleInspection.status === "trusted" ? "ok" : "degraded";

  // Strip the heavy per-minute / per-5min Oura arrays into a separate
  // -detailed.json — the morning briefing only needs daily aggregates and
  // these arrays were ~60KB of the 65KB file.
  const detailed: Record<string, unknown> = {};
  const leanOura = JSON.parse(JSON.stringify(oura)) as Record<string, unknown>;
  const HEAVY_KEYS = ["met", "class_5_min", "hrv_5min", "items"];
  if (Array.isArray(leanOura.activity)) {
    detailed.activity = (leanOura.activity as Array<Record<string, unknown>>).map(rec => {
      const stripped: Record<string, unknown> = {};
      for (const k of HEAVY_KEYS) if (k in rec) { stripped[k] = rec[k]; delete rec[k]; }
      return { day: rec.day, ...stripped };
    });
  }
  if (Array.isArray(leanOura.heart_rate)) {
    detailed.heart_rate = leanOura.heart_rate;
    leanOura.heart_rate = `[${(leanOura.heart_rate as unknown[]).length} samples in -detailed.json]`;
  }

  const consolidated: ConsolidatedData = {
    date: localDate,
    timezone: tz,
    synced_at: new Date().toISOString(),
    sources: {
      oura: sourceStatus(oura),
      withings: sourceStatus(withings),
      apple_health: appleStatus,
    },
    oura: leanOura,
    withings,
    apple_health: appleHealth,
    ...(typeof (appleHealth._ingest as { received_at?: unknown } | undefined)?.received_at === "string"
      ? { apple_health_received_at: (appleHealth._ingest as { received_at: string }).received_at }
      : {}),
    activity,
    sleep,
    ...(existingDaily?.briefing_sent ? { briefing_sent: true } : {}),
  };

  atomicWriteSharedJson(outputFile, consolidated);
  if (Object.keys(detailed).length > 0) {
    atomicWriteSharedJson(join(DAILY_DIR, `${localDate}-detailed.json`), detailed);
  }

  const src = Object.entries(consolidated.sources).map(([k, v]) => `${k}: ${v}`).join(", ");
  const activitySources = `${activity.provenance.steps}/${activity.provenance.active_energy_kcal}`;
  console.log(`READY: ${localDate} | ${src} | activity: ${activity.quality} (${activitySources}, period ${activity.period_date})`);
  console.log(`Data: health/daily-data/${localDate}.json (lean) + ${localDate}-detailed.json`);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
