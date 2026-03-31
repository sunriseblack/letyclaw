/**
 * Memory tools — hybrid BM25+semantic search + CRUD over agent memory files.
 *
 * Memory lives in: {VAULT_PATH}/{agentId}/memory/*.md
 * Search index:    {VAULT_PATH}/{agentId}/memory/search.sqlite
 *
 * At save time, Claude Haiku expands entries with semantic keywords.
 * At search time, FTS5 BM25 ranks across original text + expanded keywords.
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { ensureIndex, indexFile, removeFile, search } from "./memory-db.js";
import { ok, error, VAULT, AGENT, safePath } from "./_util.js";
import type { MCPToolDefinition, MCPResponse } from "../types.js";

function memoryDir(agentId: string): string {
  return join(VAULT(), agentId, "memory");
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
      const content = readFileSync(join(dir, file), "utf8");
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

  return docs
    .map((doc, i) => ({ ...doc, score: bm25Score(queryTokens, docTokensList[i]!, avgDl, df, docs.length) }))
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
];

// ── Handlers ─────────────────────────────────────────────────────────

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<MCPResponse>> = {
  async memory_search({ query, agent_id, limit = 10 }: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");
    if (!query) return error("query is required");

    try {
      await ensureIndex(agentId);
      const results = search(agentId, query as string, limit as number);

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
      const results = fallbackSearch(agentId, query as string, limit as number);
      if (results.length === 0) return ok(`No matches for '${query}' in ${agentId} memory`);
      return ok(JSON.stringify(results, null, 2));
    }
  },

  async memory_get({ date, path: relPath, agent_id }: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");

    const dir = memoryDir(agentId);
    const rel = (relPath as string) || (date ? ((date as string).endsWith(".md") ? (date as string) : `${date}.md`) : null);
    if (!rel) return error("Either 'date' or 'path' is required");

    const filePath = safePath(dir, rel);
    if (!filePath) return error("Path traversal detected — access denied");
    if (!existsSync(filePath)) return error(`File not found: ${basename(filePath)}`);
    return ok(readFileSync(filePath, "utf8"));
  },

  async memory_save({ content, agent_id, tags }: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");
    if (!content) return error("content is required");

    const dir = memoryDir(agentId);
    mkdirSync(dir, { recursive: true });

    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const time = now.toISOString().slice(11, 16);
    const filePath = join(dir, `${date}.md`);

    let entry = `\n## ${time}\n\n${content}`;
    const tagArray = tags as string[] | undefined;
    if (tagArray?.length) entry += `\n\nTags: ${tagArray.join(", ")}`;
    entry += "\n";

    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8");
      writeFileSync(filePath, existing + entry);
    } else {
      writeFileSync(filePath, `# Memory — ${date}\n${entry}`);
    }

    // Index the updated file for search
    try {
      await indexFile(agentId, filePath);
    } catch (err) {
      console.error("[memory] indexing failed (memory saved, search index may be stale):", (err as Error).message);
    }

    return ok(`Saved to ${date}.md at ${time}`);
  },

  async memory_delete({ date, path: relPath, agent_id }: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");

    const dir = memoryDir(agentId);
    const rel = (relPath as string) || (date ? ((date as string).endsWith(".md") ? (date as string) : `${date}.md`) : null);
    if (!rel) return error("Either 'date' or 'path' is required");

    const filePath = safePath(dir, rel);
    if (!filePath) return error("Path traversal detected — access denied");
    if (!existsSync(filePath)) return error(`File not found: ${basename(filePath)}`);
    unlinkSync(filePath);

    // Clean up search index
    try {
      removeFile(agentId, filePath);
    } catch (err) {
      console.error("[memory] index cleanup failed:", (err as Error).message);
    }

    return ok(`Deleted: ${basename(filePath)}`);
  },

  async memory_list({ agent_id, limit = 30 }: Record<string, unknown>): Promise<MCPResponse> {
    const agentId = (agent_id as string) || AGENT();
    if (!agentId) return error("No agent_id provided and LETYCLAW_AGENT_ID not set");

    const dir = memoryDir(agentId);
    if (!existsSync(dir)) return ok(`No memory directory for agent '${agentId}'`);

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit as number);

    const result = files.map((f) => {
      try {
        const content = readFileSync(join(dir, f), "utf8");
        return { file: f, size: content.length, entries: (content.match(/^## \d{2}:\d{2}/gm) || []).length };
      } catch {
        return { file: f, size: 0, entries: 0 };
      }
    });

    return ok(JSON.stringify(result, null, 2));
  },
};
