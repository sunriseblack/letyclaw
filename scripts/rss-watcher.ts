#!/usr/bin/env node
/**
 * RSS Watcher — fetches Aeon, Quanta, The Point and emits new items.
 * Called by the education-rss-poll cron via Bash.
 *
 * Stdout:
 *   READY: <json array>   — new items to format and post
 *   SKIP: <reason>        — nothing new (or first-run seed)
 *
 * State: <LETYCLAW_PROJECT_ROOT>/sessions/.rss-seen.json (per-feed seen-IDs).
 *        Sandboxed paths: only sessions/ and logs/ are writable under systemd.
 *
 * Flags:
 *   --force        ignore the seen list (re-emit every current item)
 *   --reset        wipe the state file and seed silently with current items
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const LETYCLAW_ROOT = process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw";
const STATE_FILE = process.env.RSS_STATE_FILE || join(LETYCLAW_ROOT, "sessions", ".rss-seen.json");
const MAX_SEEN_PER_FEED = 200;
const MAX_ITEMS_PER_RUN = 8;
const FETCH_TIMEOUT_MS = 15000;

const FORCE = process.argv.includes("--force");
const RESET = process.argv.includes("--reset");

interface Feed {
  id: string;
  name: string;
  url: string;
}

const FEEDS: Feed[] = [
  { id: "aeon", name: "Aeon", url: "https://aeon.co/feed.rss" },
  { id: "quanta", name: "Quanta", url: "https://www.quantamagazine.org/feed/" },
  { id: "thepoint", name: "The Point", url: "https://thepointmag.com/feed/" },
];

interface FeedState {
  seen: string[];
  lastFetch?: string;
  lastError?: string;
}

interface State {
  feeds: Record<string, FeedState>;
}

interface Item {
  feedId: string;
  magazine: string;
  id: string;
  title: string;
  url: string;
  summary: string;
  published: string;
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { feeds: {} };
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    return { feeds: parsed.feeds ?? {} };
  } catch {
    return { feeds: {} };
  }
}

function saveState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchWithTimeout(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "letyclaw-rss-watcher/1.0 (+https://github.com/sunriseblack/letyclaw)",
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function pickTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m && m[1] !== undefined ? m[1] : null;
}

function pickAtomLink(block: string): string | null {
  // Atom: <link rel="alternate" href="..."/> or <link href="..."/>
  const all = [...block.matchAll(/<link\b([^>]*)\/?>(?:<\/link>)?/gi)];
  if (all.length === 0) return null;
  const alternate = all.find((m) => /rel\s*=\s*["']alternate["']/i.test(m[1] ?? ""));
  const chosen = alternate ?? all[0];
  if (!chosen) return null;
  const href = (chosen[1] ?? "").match(/href\s*=\s*["']([^"']+)["']/i);
  return href ? href[1] ?? null : null;
}

function parseFeed(feed: Feed, xml: string): Item[] {
  const isAtom = /<feed[\s>]/i.test(xml.slice(0, 500));
  const blockRe = isAtom
    ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/g
    : /<item\b[^>]*>([\s\S]*?)<\/item>/g;

  const items: Item[] = [];
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml))) {
    const block = m[1] ?? "";

    const rawTitle = pickTag(block, "title") ?? "";
    const title = stripTags(rawTitle);

    let url = "";
    if (isAtom) {
      url = pickAtomLink(block) ?? "";
    } else {
      url = stripTags(pickTag(block, "link") ?? "");
    }

    const guid = stripTags(pickTag(block, "guid") ?? pickTag(block, "id") ?? "");
    const id = guid || url;
    if (!id || !url || !title) continue;

    const rawSummary =
      pickTag(block, "description") ??
      pickTag(block, "summary") ??
      pickTag(block, "content:encoded") ??
      pickTag(block, "content") ??
      "";
    const summary = stripTags(rawSummary).slice(0, 500);

    const published =
      stripTags(pickTag(block, "pubDate") ?? "") ||
      stripTags(pickTag(block, "published") ?? "") ||
      stripTags(pickTag(block, "updated") ?? "") ||
      "";

    items.push({ feedId: feed.id, magazine: feed.name, id, title, url, summary, published });
  }
  return items;
}

async function processFeed(feed: Feed, state: State): Promise<{ items: Item[]; firstSeed: boolean }> {
  const fs = state.feeds[feed.id] ?? { seen: [] };
  const firstSeed = !state.feeds[feed.id] || fs.seen.length === 0;

  let xml: string;
  try {
    xml = await fetchWithTimeout(feed.url);
  } catch (err) {
    fs.lastError = err instanceof Error ? err.message : String(err);
    state.feeds[feed.id] = fs;
    return { items: [], firstSeed: false };
  }

  let parsed: Item[];
  try {
    parsed = parseFeed(feed, xml);
  } catch (err) {
    fs.lastError = `parse: ${err instanceof Error ? err.message : String(err)}`;
    state.feeds[feed.id] = fs;
    return { items: [], firstSeed: false };
  }

  fs.lastFetch = new Date().toISOString();
  delete fs.lastError;

  const seenSet = new Set(fs.seen);
  const fresh = FORCE ? parsed : parsed.filter((it) => !seenSet.has(it.id));

  // Update seen list (newest first, capped)
  const allIds = parsed.map((it) => it.id);
  const merged = [...allIds, ...fs.seen.filter((id) => !allIds.includes(id))];
  fs.seen = merged.slice(0, MAX_SEEN_PER_FEED);
  state.feeds[feed.id] = fs;

  if (firstSeed && !FORCE) {
    return { items: [], firstSeed: true };
  }
  return { items: fresh, firstSeed: false };
}

async function main(): Promise<void> {
  if (RESET) {
    saveState({ feeds: {} });
    process.stdout.write("SKIP: state reset\n");
    return;
  }

  const state = loadState();
  const results = await Promise.all(FEEDS.map((f) => processFeed(f, state)));

  const seeds: string[] = [];
  const allNew: Item[] = [];
  for (let i = 0; i < FEEDS.length; i++) {
    const feed = FEEDS[i]!;
    const r = results[i]!;
    if (r.firstSeed) seeds.push(feed.name);
    allNew.push(...r.items);
  }

  saveState(state);

  if (allNew.length === 0) {
    const seedNote = seeds.length > 0 ? ` (seeded: ${seeds.join(", ")})` : "";
    process.stdout.write(`SKIP: nothing new${seedNote}\n`);
    return;
  }

  // Newest first, cap to avoid avalanches
  allNew.sort((a, b) => {
    const ta = Date.parse(a.published) || 0;
    const tb = Date.parse(b.published) || 0;
    return tb - ta;
  });
  const out = allNew.slice(0, MAX_ITEMS_PER_RUN);

  process.stdout.write("READY: " + JSON.stringify(out) + "\n");
}

main().catch((err) => {
  process.stderr.write(`ERROR: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
