/**
 * Memory tools — hybrid BM25+semantic search + CRUD over agent memory files.
 *
 * Memory lives in: {VAULT_PATH}/{agentId}/memory/*.md
 * Search index:    {VAULT_PATH}/{agentId}/memory/search.sqlite
 *
 * At save time, Claude Haiku expands entries with semantic keywords.
 * At search time, FTS5 BM25 ranks across original text + expanded keywords.
 */
import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join, basename, isAbsolute, relative } from "path";
import { randomBytes } from "crypto";
import { ensureIndex, indexFile, removeFile, search, ageDaysFromPath, decayFactor } from "./memory-db.js";
import { ok, error, VAULT, AGENT, safePath, obsidianLink } from "./_util.js";
import type { MCPToolDefinition, MCPResponse } from "../types.js";

// ── YAML frontmatter helpers ────────────────────────────────────────

interface MemoryFrontmatter {
  date: string;
  agent: string;
  topics: string[];
  entry_count: number;
  last_updated: string;
}

function parseFrontmatter(content: string): { frontmatter: MemoryFrontmatter | null; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };

  const raw = match[1]!;
  const body = match[2]!;
  const fm: Record<string, unknown> = {};

  for (const line of raw.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value!.startsWith("[")) {
      // Parse YAML array: [a, b, c]
      fm[key!] = value!.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (/^\d+$/.test(value!)) {
      fm[key!] = parseInt(value!, 10);
    } else {
      fm[key!] = value!.replace(/^["']|["']$/g, "");
    }
  }

  return { frontmatter: fm as unknown as MemoryFrontmatter, body };
}

function serializeFrontmatter(fm: MemoryFrontmatter): string {
  const topics = fm.topics.length > 0 ? `[${fm.topics.join(", ")}]` : "[]";
  return `---\ndate: ${fm.date}\nagent: ${fm.agent}\ntopics: ${topics}\nentry_count: ${fm.entry_count}\nlast_updated: "${fm.last_updated}"\n---\n`;
}

/** Extract [[wikilinks]] from text */
function extractWikilinks(text: string): string[] {
  const matches = text.match(/\[\[([^\]]+)\]\]/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(2, -2)))];
}

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

function memoryScope(value: unknown): { agentId: string; dir: string } {
  const agentId = typeof value === "string" && value.trim() ? value.trim() : AGENT().trim();
  if (!AGENT_ID_RE.test(agentId)) throw new Error("agent_id is missing or invalid");
  let vaultRoot: string;
  try { vaultRoot = realpathSync(VAULT()); } catch { throw new Error("Vault path is unavailable"); }
  const workspaceCandidate = join(vaultRoot, agentId);
  if (!existsSync(workspaceCandidate)) throw new Error(`Agent workspace not found: ${agentId}`);
  const workspace = realpathSync(workspaceCandidate);
  const workspaceRel = relative(vaultRoot, workspace);
  if (workspaceRel !== agentId || workspaceRel.startsWith("..") || isAbsolute(workspaceRel)) {
    throw new Error("Agent workspace escapes the vault");
  }
  const memoryCandidate = join(workspace, "memory");
  if (!existsSync(memoryCandidate)) return { agentId, dir: memoryCandidate };
  const dir = realpathSync(memoryCandidate);
  const memoryRel = relative(workspace, dir);
  if (memoryRel !== "memory" || memoryRel.startsWith("..") || isAbsolute(memoryRel)) {
    throw new Error("Agent memory directory escapes its workspace");
  }
  return { agentId, dir };
}

function memoryDir(agentId: string): string {
  return memoryScope(agentId).dir;
}

function existingMemoryFile(dir: string, relPath: string): string | null {
  const lexical = safePath(dir, relPath);
  if (!lexical || !existsSync(lexical)) return null;
  try {
    const canonicalDir = realpathSync(dir);
    const canonicalFile = realpathSync(lexical);
    const rel = relative(canonicalDir, canonicalFile);
    if (rel.startsWith("..") || isAbsolute(rel) || !statSync(canonicalFile).isFile()) return null;
    return canonicalFile;
  } catch {
    return null;
  }
}

interface FileLock { fd: number; path: string }

async function acquireMemoryLock(filePath: string, timeoutMs = 2_000): Promise<FileLock | null> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      return { fd: openSync(lockPath, "wx", 0o600), path: lockPath };
    } catch (err) {
      if (!err || typeof err !== "object" || (err as { code?: unknown }).code !== "EEXIST") return null;
      // A killed writer must not wedge memory forever.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch { /* another writer released it */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  return null;
}

function releaseMemoryLock(lock: FileLock): void {
  try { closeSync(lock.fd); } catch { /* ignore */ }
  try { unlinkSync(lock.path); } catch { /* ignore */ }
}

function atomicWriteMemory(filePath: string, content: string): void {
  const temp = `${filePath}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  writeFileSync(temp, content, { mode: 0o600 });
  try {
    if (existsSync(filePath)) {
      copyFileSync(filePath, `${filePath}.bak`);
      chmodSync(`${filePath}.bak`, 0o600);
    }
  } catch { /* best effort */ }
  try {
    renameSync(temp, filePath);
  } catch (err) {
    try { unlinkSync(temp); } catch { /* ignore */ }
    throw err;
  }
}

// ── Fallback: in-memory BM25 (when SQLite fails) ────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 1);
}

function bm25Score(
  queryTokens: string[],
  docTokens: string[],
  avgDl: number,
  df: Map<string, number>,
  N: number
): number {
  const k1 = 1.5, b = 0.75, dl = docTokens.length;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) || 0) + 1);
  let score = 0;
  for (const q of queryTokens) {
    const f = tf.get(q) || 0;
    if (f === 0) continue;
    const n = df.get(q) || 0;
    const idf = Math.log((N - n + 0.5) / (n + 0.5) + 1);
    score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * dl / avgDl)));
  }
  return score;
}

interface FallbackResult {
  file: string;
  score: number;
  snippet: string;
}

function fallbackSearch(agentId: string, query: string, limit: number): FallbackResult[] {
  const dir = memoryDir(agentId);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
  const docs: { file: string; text: string }[] = [];
  for (const file of files) {
    try {
      const safeFile = existingMemoryFile(dir, file);
      if (!safeFile) continue;
      const raw = readFileSync(safeFile, "utf8");
      const content = parseFrontmatter(raw).body;
      const entries = content.split(/\n(?=## \d{2}:\d{2})/).filter((e) => e.trim());
      if (entries.length > 1) {
        for (const entry of entries) docs.push({ file, text: entry.trim() });
      } else {
        docs.push({ file, text: content.trim() });
      }
    } catch { /* ignore */ }
  }
  if (docs.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  const df = new Map<string, number>();
  const docTokensList = docs.map((d) => tokenize(d.text));
  for (const tokens of docTokensList) {
    const unique = new Set(tokens);
    for (const t of unique) df.set(t, (df.get(t) || 0) + 1);
  }
  const avgDl = docTokensList.reduce((s, t) => s + t.length, 0) / docs.length;

  // Apply the same recency weighting as the SQLite path so the fallback ranks
  // consistently (newer notes outrank equally-relevant older ones; undated
  // files are evergreen). Filename carries the YYYY-MM-DD date.
  const now = Date.now();
  return docs
    .map((doc, i) => {
      const relevance = bm25Score(queryTokens, docTokensList[i]!, avgDl, df, docs.length);
      return { ...doc, score: relevance * decayFactor(ageDaysFromPath(doc.file, now)) };
    })
    .filter((d) => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((d) => ({
      file: d.file,
      score: Math.round(d.score * 100) / 100,
      snippet: d.text.slice(0, 300) + (d.text.length > 300 ? "…" : ""),
    }));
}

// ── Tool definitions ─────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  {
    name: "memory_search",
    description:
      "Search agent memory using hybrid BM25 + semantic keyword matching. Returns ranked results with context snippets. Finds related concepts even without exact keyword overlap.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (natural language or keywords)" },
        agent_id: { type: "string", description: "Agent ID to search (default: current agent)" },
        limit: { type: "number", description: "Max results to return (default: 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description:
      "Get a specific memory file by date (YYYY-MM-DD) or relative path. Returns the full content.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        path: { type: "string", description: "Relative path within memory/ directory (e.g. '2026-03-28.md')" },
        agent_id: { type: "string", description: "Agent ID (default: current agent)" },
      },
    },
  },
  {
    name: "memory_save",
    description:
      "Save a new memory entry. Appends to today's memory file with a timestamp header. Automatically indexes for semantic search.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content to save (markdown)" },
        agent_id: { type: "string", description: "Agent ID (default: current agent)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for the memory entry",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_delete",
    description:
      "Delete a memory file by date or path. Use with caution — this is irreversible.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format" },
        path: { type: "string", description: "Relative path within memory/ directory" },
        agent_id: { type: "string", description: "Agent ID (default: current agent)" },
      },
    },
  },
  {
    name: "memory_list",
    description:
      "List all memory files for an agent, sorted by date (newest first). Returns file names and sizes.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID (default: current agent)" },
        limit: { type: "number", description: "Max files to return (default: 30)" },
      },
    },
  },
  {
    name: "memory_related",
    description:
      "Find memory entries related to a given date or topic via shared [[wikilinks]]. Returns entries that share the most wikilinks with the target — a lightweight co-citation analysis across your memory.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Date in YYYY-MM-DD format to find related entries for" },
        topic: { type: "string", description: "A [[wikilink]] topic name to find entries mentioning it" },
        agent_id: { type: "string", description: "Agent ID (default: current agent)" },
        limit: { type: "number", description: "Max results to return (default: 10)" },
      },
    },
  },
];

// ── Handlers ─────────────────────────────────────────────────────────

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<MCPResponse>> = {
  async memory_search({ query, agent_id, limit = 10 }: Record<string, unknown>): Promise<MCPResponse> {
    let agentId: string;
    try { ({ agentId } = memoryScope(agent_id)); } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    if (typeof query !== "string" || !query.trim()) return error("query is required");
    const boundedLimit = typeof limit === "number" && Number.isFinite(limit)
      ? Math.min(100, Math.max(1, Math.floor(limit)))
      : 10;

    try {
      await ensureIndex(agentId);
      const results = search(agentId, query, boundedLimit);

      if (results.length === 0) return ok(`No matches for '${query}' in ${agentId} memory`);

      const formatted = results.map((r) => ({
        file: r.file,
        score: r.score,
        lines: `${r.startLine}-${r.endLine}`,
        snippet: r.text.slice(0, 300) + (r.text.length > 300 ? "…" : ""),
      }));

      return ok(JSON.stringify(formatted, null, 2));
    } catch (err) {
      console.error("[memory] SQLite search failed, falling back to in-memory BM25:", (err as Error).message);
      const results = fallbackSearch(agentId, query, boundedLimit);
      if (results.length === 0) return ok(`No matches for '${query}' in ${agentId} memory`);
      return ok(JSON.stringify(results, null, 2));
    }
  },

  async memory_get({ date, path: relPath, agent_id }: Record<string, unknown>): Promise<MCPResponse> {
    let agentId: string, dir: string;
    try { ({ agentId, dir } = memoryScope(agent_id)); } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    if (relPath !== undefined && typeof relPath !== "string") return error("path must be a string");
    if (date !== undefined && typeof date !== "string") return error("date must be a string");
    const rel = (relPath as string) || (date ? ((date as string).endsWith(".md") ? (date as string) : `${date}.md`) : null);
    if (!rel) return error("Either 'date' or 'path' is required");

    const filePath = existingMemoryFile(dir, rel);
    if (!filePath) return error("File not found or path escapes agent memory");
    const vaultRelPath = `${agentId}/memory/${basename(filePath)}`;
    const content = readFileSync(filePath, "utf8");
    return ok(`${content}\n\n---\nObsidian: ${obsidianLink(vaultRelPath)}`);
  },

  async memory_save({ content, agent_id, tags }: Record<string, unknown>): Promise<MCPResponse> {
    let agentId: string, dir: string;
    try { ({ agentId, dir } = memoryScope(agent_id)); } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    if (typeof content !== "string" || !content.trim()) return error("content is required");
    if (content.length > 100_000) return error("content exceeds 100000 characters");
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string"))) {
      return error("tags must be an array of strings");
    }
    mkdirSync(dir, { recursive: true });

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16);
    const filePath = join(dir, `${date}.md`);
    const lock = await acquireMemoryLock(filePath);
    if (!lock) return error("Memory file is busy; retry the save once");

    let entry = `\n## ${time}\n\n${content}`;
    const tagArray = (tags as string[] | undefined)?.slice(0, 50).map((tag) => tag.slice(0, 100));
    if (tagArray?.length) entry += `\n\nTags: ${tagArray.join(", ")}`;
    entry += "\n";

    // Extract topics from wikilinks in the new entry
    const newTopics = extractWikilinks(content);

    let committed: { content: string; mtimeMs: number } | null = null;
    try {
      let nextContent: string;
      if (existsSync(filePath)) {
        const existing = readFileSync(filePath, "utf8");
        const { frontmatter, body } = parseFrontmatter(existing);

        if (frontmatter) {
          // Update existing frontmatter
          const mergedTopics = [...new Set([...frontmatter.topics, ...newTopics])];
          const entryCount = (body.match(/^## \d{2}:\d{2}/gm) || []).length + 1;
          const updatedFm: MemoryFrontmatter = {
            ...frontmatter,
            topics: mergedTopics,
            entry_count: entryCount,
            last_updated: now.toISOString(),
          };
          nextContent = serializeFrontmatter(updatedFm) + body + entry;
        } else {
          // Legacy file without frontmatter — add it
          const allContent = existing + entry;
          const entryCount = (allContent.match(/^## \d{2}:\d{2}/gm) || []).length;
          const existingTopics = extractWikilinks(existing);
          const fm: MemoryFrontmatter = {
            date,
            agent: agentId,
            topics: [...new Set([...existingTopics, ...newTopics])],
            entry_count: entryCount,
            last_updated: now.toISOString(),
          };
          nextContent = serializeFrontmatter(fm) + allContent;
        }
      } else {
        // New file — create with frontmatter
        const fm: MemoryFrontmatter = {
          date,
          agent: agentId,
          topics: newTopics,
          entry_count: 1,
          last_updated: now.toISOString(),
        };
        nextContent = serializeFrontmatter(fm) + `# Memory — ${date}\n${entry}`;
      }
      atomicWriteMemory(filePath, nextContent);
      committed = { content: nextContent, mtimeMs: statSync(filePath).mtimeMs };
    } catch (err) {
      return error(`Memory save failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      releaseMemoryLock(lock);
    }

    // Index the updated file for search
    try {
      await indexFile(agentId, filePath, committed ?? undefined);
    } catch (err) {
      console.error("[memory] indexing failed (memory saved, search index may be stale):", (err as Error).message);
    }

    const vaultRelPath = `${agentId}/memory/${date}.md`;
    return ok(`Saved to ${date}.md at ${time}\nObsidian: ${obsidianLink(vaultRelPath)}`);
  },

  async memory_delete({ date, path: relPath, agent_id }: Record<string, unknown>): Promise<MCPResponse> {
    let agentId: string, dir: string;
    try { ({ agentId, dir } = memoryScope(agent_id)); } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    if (relPath !== undefined && typeof relPath !== "string") return error("path must be a string");
    if (date !== undefined && typeof date !== "string") return error("date must be a string");
    const rel = (relPath as string) || (date ? ((date as string).endsWith(".md") ? (date as string) : `${date}.md`) : null);
    if (!rel) return error("Either 'date' or 'path' is required");

    const filePath = existingMemoryFile(dir, rel);
    if (!filePath) return error("File not found or path escapes agent memory");
    const lock = await acquireMemoryLock(filePath);
    if (!lock) return error("Memory file is busy; retry the delete once");
    try {
      unlinkSync(filePath);
      try { unlinkSync(`${filePath}.bak`); } catch { /* no backup */ }
    } catch (err) {
      return error(`Memory delete failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      releaseMemoryLock(lock);
    }

    // Clean up search index
    try {
      removeFile(agentId, filePath);
    } catch (err) {
      console.error("[memory] index cleanup failed:", (err as Error).message);
    }

    return ok(`Deleted: ${basename(filePath)}`);
  },

  async memory_related({ date, topic, agent_id, limit = 10 }: Record<string, unknown>): Promise<MCPResponse> {
    let agentId: string, dir: string;
    try { ({ agentId, dir } = memoryScope(agent_id)); } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    if (!date && !topic) return error("Either 'date' or 'topic' is required");

    if (!existsSync(dir)) return ok(`No memory directory for agent '${agentId}'`);

    // Build wikilink index across all memory files
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse();
    const fileLinks = new Map<string, { links: string[]; snippets: Map<string, string> }>();

    for (const file of files) {
      try {
        const safeFile = existingMemoryFile(dir, file);
        if (!safeFile) continue;
        const raw = readFileSync(safeFile, "utf8");
        const { body } = parseFrontmatter(raw);
        const entries = body.split(/\n(?=## \d{2}:\d{2})/).filter((e) => e.trim());
        const allLinks: string[] = [];
        const snippets = new Map<string, string>();

        for (const entry of entries) {
          const links = extractWikilinks(entry);
          allLinks.push(...links);
          for (const link of links) {
            if (!snippets.has(link)) snippets.set(link, entry.slice(0, 200));
          }
        }

        fileLinks.set(file, { links: [...new Set(allLinks)], snippets });
      } catch { /* ignore */ }
    }

    let targetLinks: string[];

    if (topic) {
      // Find all entries mentioning this topic
      targetLinks = [topic as string];
    } else {
      // Get wikilinks from the target date file
      const targetFile = `${date}.md`;
      const target = fileLinks.get(targetFile);
      if (!target || target.links.length === 0) {
        return ok(`No wikilinks found in ${date}.md`);
      }
      targetLinks = target.links;
    }

    // Score other files by shared wikilinks
    const scored: { file: string; shared: string[]; score: number; snippet: string }[] = [];

    for (const [file, data] of fileLinks) {
      if (date && file === `${date}.md`) continue; // Skip the target itself
      const shared = data.links.filter((l) => targetLinks.includes(l));
      if (shared.length === 0) continue;
      const snippet = data.snippets.get(shared[0]!) || "";
      scored.push({ file, shared, score: shared.length, snippet: snippet.slice(0, 200) });
    }

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit as number);

    if (results.length === 0) {
      return ok(topic
        ? `No entries found mentioning [[${topic}]]`
        : `No related entries found for ${date}`);
    }

    return ok(JSON.stringify(results, null, 2));
  },

  async memory_list({ agent_id, limit = 30 }: Record<string, unknown>): Promise<MCPResponse> {
    let agentId: string, dir: string;
    try { ({ agentId, dir } = memoryScope(agent_id)); } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    if (!existsSync(dir)) return ok(`No memory directory for agent '${agentId}'`);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => existingMemoryFile(dir, f) !== null)
      .sort()
      .reverse()
      .slice(0, limit as number);

    const result = files.map((f) => {
      try {
        const safeFile = existingMemoryFile(dir, f);
        if (!safeFile) throw new Error("unsafe memory path");
        const content = readFileSync(safeFile, "utf8");
        return { file: f, size: content.length, entries: (content.match(/^## \d{2}:\d{2}/gm) || []).length };
      } catch {
        return { file: f, size: 0, entries: 0 };
      }
    });

    return ok(JSON.stringify(result, null, 2));
  },
};
