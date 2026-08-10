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
import { chmodSync, readFileSync, readdirSync, existsSync, mkdirSync, realpathSync, statSync } from "fs";
import { join, basename, isAbsolute, relative } from "path";
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
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

function resolvedMemoryDir(agentId: string): string {
  if (!AGENT_ID_RE.test(agentId)) throw new Error("agent_id is invalid");
  const vaultRoot = realpathSync(VAULT());
  const workspace = realpathSync(join(vaultRoot, agentId));
  const workspaceRel = relative(vaultRoot, workspace);
  if (workspaceRel !== agentId || workspaceRel.startsWith("..") || isAbsolute(workspaceRel)) {
    throw new Error("Agent workspace escapes the vault");
  }
  const candidate = join(workspace, "memory");
  mkdirSync(candidate, { recursive: true });
  const dir = realpathSync(candidate);
  if (relative(workspace, dir) !== "memory") throw new Error("Agent memory directory escapes its workspace");
  return dir;
}

function safeIndexedFile(dir: string, filename: string): string | null {
  try {
    const path = realpathSync(join(dir, filename));
    const rel = relative(dir, path);
    if (rel.startsWith("..") || isAbsolute(rel) || !statSync(path).isFile()) return null;
    return path;
  } catch {
    return null;
  }
}

export function getDb(agentId: string): Database.Database {
  const dir = resolvedMemoryDir(agentId);
  const dbPath = join(dir, "search.sqlite");

  const cached = dbCache.get(dbPath);
  if (cached) return cached;

  const db = new Database(dbPath);
  try { chmodSync(dbPath, 0o600); } catch { /* best effort */ }
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT,
      updated_at INTEGER
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

    -- Open-loops ledger: the agent's durable, updatable "what's pending" state.
    -- Lives alongside memory so it's per-domain (cross-domain isolation is free)
    -- and self-migrates on first open. See loops-db.ts for the access layer.
    CREATE TABLE IF NOT EXISTS loops (
      id            TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      domain        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','in_progress','awaiting_user','blocked','done','dropped')),
      next_action   TEXT,
      due           TEXT,
      priority      INTEGER NOT NULL DEFAULT 3,
      source_ref    TEXT,
      artifact_path TEXT,
      ticktick_id   TEXT,
      watch_cron_id TEXT,
      mirror_flag   TEXT,
      shared        INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      closed_at     INTEGER,
      surfaced_count   INTEGER NOT NULL DEFAULT 0,
      last_surfaced_at INTEGER,
      dedupe_key    TEXT NOT NULL
    );

    -- One OPEN loop per dedupe_key (re-opening allowed after done/dropped).
    CREATE UNIQUE INDEX IF NOT EXISTS loops_dedupe_open
      ON loops(dedupe_key) WHERE status NOT IN ('done','dropped');
    CREATE INDEX IF NOT EXISTS loops_status_due ON loops(status, due);
  `);

  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { if (existsSync(path)) chmodSync(path, 0o600); } catch { /* best effort */ }
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

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return match ? match[1]! : content;
}

function chunkFile(content: string): Chunk[] {
  const body = stripFrontmatter(content);
  const lines = body.split("\n");
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

export async function indexFile(
  agentId: string,
  filePath: string,
  preRead?: { content: string; hash?: string; mtimeMs?: number },
): Promise<void> {
  const dir = resolvedMemoryDir(agentId);
  const safeFile = safeIndexedFile(dir, basename(filePath));
  if (!safeFile) throw new Error("Memory index path escapes agent memory");
  const db = getDb(agentId);
  const content = preRead?.content ?? readFileSync(safeFile, "utf8");
  const fileHash = preRead?.hash ?? hashText(content);
  const sourceMtime = preRead?.mtimeMs ?? statSync(safeFile).mtimeMs;
  const relPath = basename(filePath);

  // Skip if unchanged
  const existing = db.prepare<[string], FileRow>("SELECT hash FROM files WHERE path = ?").get(relPath);
  if (existing?.hash === fileHash) return;

  // Expand outside the SQLite transaction: the provider call can take seconds.
  // Keep the replacement in memory so readers never observe partial chunks and
  // concurrent indexers cannot interleave DELETE/INSERT sequences.
  const chunks = chunkFile(content);
  const expandedChunks: Array<typeof chunks[number] & { expanded: string; chunkHash: string }> = [];
  for (const chunk of chunks) {
    const chunkHash = hashText(chunk.text);

    // Check if we already have expansion for identical text in another file
    const cached = db.prepare<[string], ChunkRow>("SELECT expanded FROM chunks WHERE hash = ? AND expanded != '' LIMIT 1").get(chunkHash);
    const expanded = cached ? cached.expanded : await expandKeywords(chunk.text);
    expandedChunks.push({ ...chunk, expanded, chunkHash });
  }

  // A newer save may have committed while keyword expansion was running. Never
  // let this older snapshot overwrite the newer search index. Its own save (or
  // the next ensureIndex call after a crash) will index the current contents.
  if (hashText(readFileSync(safeFile, "utf8")) !== fileHash) return;

  const replace = db.transaction(() => {
    db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);
    const insert = db.prepare(
      "INSERT INTO chunks (path, start_line, end_line, text, expanded, hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const indexedAt = Date.now();
    for (const chunk of expandedChunks) {
      insert.run(relPath, chunk.startLine, chunk.endLine, chunk.text, chunk.expanded, chunk.chunkHash, indexedAt);
    }
    // Store the mtime belonging to the indexed snapshot, never a newer file's
    // mtime. This keeps ensureIndex's fast path honest after races.
    db.prepare("INSERT OR REPLACE INTO files (path, hash, updated_at) VALUES (?, ?, ?)")
      .run(relPath, fileHash, sourceMtime);
  });
  replace();
}

export function removeFile(agentId: string, filePath: string): void {
  const db = getDb(agentId);
  const relPath = basename(filePath);
  db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);
  db.prepare("DELETE FROM files WHERE path = ?").run(relPath);
}

// ── Delta-aware reindex ──────────────────────────────────────────────

export async function ensureIndex(agentId: string): Promise<void> {
  const dir = resolvedMemoryDir(agentId);

  const db = getDb(agentId);
  const mdFiles = readdirSync(dir).filter((f) => f.endsWith(".md"));

  // Index new or changed files
  for (const file of mdFiles) {
    const filePath = safeIndexedFile(dir, file);
    if (!filePath) continue;

    // Hash even when mtime is unchanged. Atomic replacements and very fast
    // consecutive writes can share a filesystem timestamp; content identity is
    // the only safe basis for retaining the indexed snapshot.
    const mtime = statSync(filePath).mtimeMs;
    const existing = db.prepare<[string], FileRow>("SELECT hash, updated_at FROM files WHERE path = ?").get(file);
    const content = readFileSync(filePath, "utf8");
    const fileHash = hashText(content);
    if (existing?.hash === fileHash) {
      // Content unchanged despite mtime change — update stored mtime
      db.prepare("UPDATE files SET updated_at = ? WHERE path = ?").run(mtime, file);
      continue;
    }

    await indexFile(agentId, filePath, { content, hash: fileHash, mtimeMs: mtime });
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

// Recency weighting (ported from openclaw's temporal-decay): newer notes
// should outrank equally-relevant older ones. Multiply the relevance score by
// exp(-(ln2/halfLifeDays) * ageDays) so a note loses half its weight every
// HALF_LIFE_DAYS. Curated/undated files (no YYYY-MM-DD in the name, e.g. a
// MEMORY.md) are treated as evergreen and never decay.
const HALF_LIFE_DAYS = 30;
const DECAY_K = Math.LN2 / HALF_LIFE_DAYS;

// Parse the note date from a memory filename like `.../2026-05-31.md` (or a
// slugged `2026-05-31-foo.md`). Returns age in days, or null if undated.
export function ageDaysFromPath(path: string, nowMs: number): number | null {
  const m = basename(path).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const noteMs = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (!Number.isFinite(noteMs)) return null;
  return Math.max(0, (nowMs - noteMs) / 86_400_000);
}

export function decayFactor(ageDays: number | null): number {
  if (ageDays === null) return 1; // evergreen / undated
  return Math.exp(-DECAY_K * ageDays);
}

export function search(agentId: string, query: string, limit = 10): SearchResult[] {
  const db = getDb(agentId);

  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  // Oversample (decay reorders results, so the top-`limit` by BM25 alone isn't
  // the top-`limit` after weighting), then re-rank by recency-weighted score.
  const oversample = Math.min(limit * 8, 200);

  // FTS5 BM25 search — searches both text and expanded columns.
  // bm25() returns negative scores where more negative = more relevant.
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
    .all(ftsQuery, oversample);

  const now = Date.now();
  return results
    .map((r) => {
      const relevance = 1 / (1 + Math.abs(r.rank ?? 0));
      const weighted = relevance * decayFactor(ageDaysFromPath(r.path, now));
      return {
        file: r.path,
        startLine: r.start_line,
        endLine: r.end_line,
        text: r.text,
        score: Math.round(weighted * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── Cleanup ──────────────────────────────────────────────────────────

export function closeAll(): void {
  for (const [, db] of dbCache) {
    try { db.close(); } catch { /* ignore */ }
  }
  dbCache.clear();
}
