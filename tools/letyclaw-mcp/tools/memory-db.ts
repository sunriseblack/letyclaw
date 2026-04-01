/**
 * Memory database — SQLite FTS5 + Claude CLI keyword expansion.
 *
 * Each agent gets its own SQLite DB at {VAULT}/{agentId}/memory/search.sqlite.
 * Memory entries are chunked by ## HH:MM headers, expanded with semantic keywords
 * via Claude Haiku, and indexed in FTS5 for BM25 search.
 */
import Database from "better-sqlite3";
import { spawn } from "child_process";
import { createHash } from "crypto";
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from "fs";
import { join, basename } from "path";
import { VAULT } from "./_util.js";

// ── Row types ────────────────────────────────────────────────────────

interface FileRow {
  path: string;
  hash: string;
  updated_at: number;
}

interface ChunkRow {
  id: number;
  path: string;
  start_line: number;
  end_line: number;
  text: string;
  expanded: string;
  hash: string;
  updated_at: number;
  rank?: number;
}

export interface SearchResult {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

// ── Per-agent DB cache ───────────────────────────────────────────────

const dbCache = new Map<string, Database.Database>();

export function getDb(agentId: string): Database.Database {
  const dir = join(VAULT(), agentId, "memory");
  const dbPath = join(dir, "search.sqlite");

  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT,
      updated_at INTEGER,
      mtime_ms INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT,
      start_line INTEGER,
      end_line INTEGER,
      text TEXT,
      expanded TEXT,
      hash TEXT,
      updated_at INTEGER
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, expanded, content=chunks, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, text, expanded)
      VALUES (new.id, new.text, new.expanded);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, expanded)
      VALUES ('delete', old.id, old.text, old.expanded);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, text, expanded)
      VALUES ('delete', old.id, old.text, old.expanded);
      INSERT INTO chunks_fts(rowid, text, expanded)
      VALUES (new.id, new.text, new.expanded);
    END;
  `);

  // Migration: add mtime_ms column if missing (existing DBs)
  try {
    db.prepare("SELECT mtime_ms FROM files LIMIT 0").run();
  } catch {
    db.exec("ALTER TABLE files ADD COLUMN mtime_ms INTEGER DEFAULT 0");
  }

  dbCache.set(dbPath, db);
  return db;
}

// ── Keyword expansion via Claude CLI ─────────────────────────────────

function expandKeywords(text: string): Promise<string> {
  // Skip in test environments — don't spawn real claude processes
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return Promise.resolve("");
  }

  return new Promise((resolve) => {
    const entry = text.slice(0, 2000).replace(/\n/g, " ").replace(/\s+/g, " ").trim();
    const prompt = `Generate 15-20 diverse search keywords and synonyms for this memory entry. Include synonyms, related concepts, alternate phrasings, semantic variants. Return ONLY a comma-separated list of keywords, no explanation, no numbering. Entry: ${entry}`;

    const proc = spawn(
      "claude",
      ["-p", prompt, "--model", "claude-haiku-4-5", "--output-format", "text"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }
    );

    let stdout = "";
    proc.stdout!.on("data", (d: Buffer) => { stdout += d; });
    proc.on("error", (err) => {
      console.error("[memory-db] keyword expansion failed:", err.message);
      resolve("");
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[memory-db] keyword expansion exited with code ${code}`);
        resolve("");
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// ── Chunking ─────────────────────────────────────────────────────────

interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

function chunkFile(content: string): Chunk[] {
  const lines = content.split("\n");
  const chunks: Chunk[] = [];
  let current = { text: "", startLine: 1, endLine: 0 };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Split on ## HH:MM timestamp headers
    if (/^## \d{2}:\d{2}/.test(line) && current.text.trim()) {
      current.endLine = i; // 0-indexed end (exclusive)
      chunks.push({ ...current, text: current.text.trim() });
      current = { text: "", startLine: i + 1, endLine: 0 };
    }
    current.text += line + "\n";
  }

  // Last chunk
  if (current.text.trim()) {
    current.endLine = lines.length;
    chunks.push({ ...current, text: current.text.trim() });
  }

  return chunks;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── Indexing ─────────────────────────────────────────────────────────

export async function indexFile(agentId: string, filePath: string, preloadedContent?: string): Promise<void> {
  const db = getDb(agentId);
  const content = preloadedContent ?? readFileSync(filePath, "utf8");
  const fileHash = hashText(content);
  const relPath = basename(filePath);
  const mtimeMs = statSync(filePath).mtimeMs;

  // Skip if unchanged
  const existing = db.prepare<[string], FileRow>("SELECT hash FROM files WHERE path = ?").get(relPath);
  if (existing?.hash === fileHash) return;

  // Remove old chunks for this file
  db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);

  // Chunk and index
  const chunks = chunkFile(content);
  const insert = db.prepare(
    "INSERT INTO chunks (path, start_line, end_line, text, expanded, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  for (const chunk of chunks) {
    const chunkHash = hashText(chunk.text);

    // Check if we already have expansion for identical text in another file
    const cached = db.prepare<[string], ChunkRow>("SELECT expanded FROM chunks WHERE hash = ? AND expanded != '' LIMIT 1").get(chunkHash);
    const expanded = cached ? cached.expanded : await expandKeywords(chunk.text);

    insert.run(relPath, chunk.startLine, chunk.endLine, chunk.text, expanded, chunkHash, Date.now());
  }

  // Update file tracking
  db.prepare("INSERT OR REPLACE INTO files (path, hash, updated_at, mtime_ms) VALUES (?, ?, ?, ?)").run(relPath, fileHash, Date.now(), mtimeMs);
}

export function removeFile(agentId: string, filePath: string): void {
  const db = getDb(agentId);
  const relPath = basename(filePath);
  db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);
  db.prepare("DELETE FROM files WHERE path = ?").run(relPath);
}

// ── Delta-aware reindex ──────────────────────────────────────────────

export async function ensureIndex(agentId: string): Promise<void> {
  const dir = join(VAULT(), agentId, "memory");
  if (!existsSync(dir)) return;

  const db = getDb(agentId);
  const mdFiles = readdirSync(dir).filter((f) => f.endsWith(".md"));

  // Index new or changed files — use mtime as fast pre-check to avoid reading unchanged files
  for (const file of mdFiles) {
    const filePath = join(dir, file);
    const mtimeMs = statSync(filePath).mtimeMs;

    const existing = db.prepare<[string], FileRow & { mtime_ms?: number }>("SELECT hash, mtime_ms FROM files WHERE path = ?").get(file);
    if (existing && existing.mtime_ms === mtimeMs) continue;

    // mtime changed (or new file) — read content and re-index
    const content = readFileSync(filePath, "utf8");
    await indexFile(agentId, filePath, content);
  }

  // Remove entries for deleted files
  const indexedFiles = db.prepare<[], FileRow>("SELECT path FROM files").all().map((r) => r.path);
  for (const indexed of indexedFiles) {
    if (!mdFiles.includes(indexed)) {
      db.prepare("DELETE FROM chunks WHERE path = ?").run(indexed);
      db.prepare("DELETE FROM files WHERE path = ?").run(indexed);
    }
  }
}

// ── Search ───────────────────────────────────────────────────────────

function buildFtsQuery(query: string): string | null {
  // Tokenize and build an OR query for FTS5
  const tokens = query
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => `"${t}"`); // quote each token for exact matching

  if (tokens.length === 0) return null;
  return tokens.join(" OR ");
}

export function search(agentId: string, query: string, limit = 10): SearchResult[] {
  const db = getDb(agentId);

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  // FTS5 BM25 search — searches both text and expanded columns
  // bm25() returns negative scores where more negative = more relevant
  const results = db
    .prepare<[string, number], ChunkRow>(
      `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.expanded,
              bm25(chunks_fts, 1.0, 0.5) as rank
       FROM chunks_fts f
       JOIN chunks c ON c.id = f.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(ftsQuery, limit);

  return results.map((r) => ({
    file: r.path,
    startLine: r.start_line,
    endLine: r.end_line,
    text: r.text,
    score: Math.round((1 / (1 + Math.abs(r.rank ?? 0))) * 100) / 100,
  }));
}

// ── Cleanup ──────────────────────────────────────────────────────────

export function closeAll(): void {
  for (const [, db] of dbCache) {
    try { db.close(); } catch { /* ignore */ }
  }
  dbCache.clear();
}
