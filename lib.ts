import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import type { SessionData, ParsedClaudeResult, RateLimitConfig } from "./types.js";

// --- Rate limiting ---
export function isRateLimited(rateLimiter: Map<number, number[]>, userId: number, { maxRequests, windowMs }: RateLimitConfig): boolean {
  const now = Date.now();
  const timestamps = rateLimiter.get(userId) || [];
  const recent = timestamps.filter(t => now - t < windowMs);
  if (recent.length >= maxRequests) return true;
  recent.push(now);
  rateLimiter.set(userId, recent);
  return false;
}

// --- Session management ---
export function getSessionFile(sessionsDir: string, agentId: string, topicId: number | string): string {
  return join(sessionsDir, `${agentId}-topic-${topicId}.json`);
}

export function loadSession(sessionsDir: string, agentId: string, topicId: number | string): SessionData | null {
  const file = getSessionFile(sessionsDir, agentId, topicId);
  if (existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as SessionData;
      // Migrate old format: add messageMap if missing
      if (!data.messageMap) data.messageMap = {};
      return data;
    } catch { return null; }
  }
  return null;
}

export function saveSession(sessionsDir: string, agentId: string, topicId: number | string, data: SessionData): void {
  writeFileSync(getSessionFile(sessionsDir, agentId, topicId), JSON.stringify(data));
}

export function deleteSession(sessionsDir: string, agentId: string, topicId: number | string): void {
  const file = getSessionFile(sessionsDir, agentId, topicId);
  try { unlinkSync(file); } catch { /* ignore */ }
}

// --- Session TTL ---
export function shouldRotateSession(session: SessionData | null, ttlMs: number): boolean {
  if (!session) return false;
  if (!session.createdAt) return true;
  return Date.now() - session.createdAt > ttlMs;
}

// --- Session lookup by reply ---
export function lookupSessionByMessageId(sessionsDir: string, agentId: string, topicId: number | string, messageId: number | string): string | undefined {
  const session = loadSession(sessionsDir, agentId, topicId);
  if (!session?.messageMap) return undefined;
  return session.messageMap[String(messageId)];
}

// --- Map telegram message IDs to a session ---
export function mapMessageToSession(sessionsDir: string, agentId: string, topicId: number | string, messageIds: (number | string)[], sessionId: string): void {
  const session = loadSession(sessionsDir, agentId, topicId);
  if (!session) return;
  for (const id of messageIds) {
    session.messageMap[String(id)] = sessionId;
  }
  saveSession(sessionsDir, agentId, topicId, session);
}

// --- Create a fresh session record ---
export function createSession(sessionsDir: string, agentId: string, topicId: number | string): SessionData {
  const now = Date.now();
  const existing = loadSession(sessionsDir, agentId, topicId);
  // Preserve messageMap from previous session (for reply lookups within TTL)
  const messageMap = existing?.messageMap || {};
  const data: SessionData = { currentSessionId: null, createdAt: now, messageMap };
  saveSession(sessionsDir, agentId, topicId, data);
  return data;
}

// --- Update the current session ID after Claude responds ---
export function updateCurrentSession(sessionsDir: string, agentId: string, topicId: number | string, sessionId: string): void {
  const session = loadSession(sessionsDir, agentId, topicId);
  if (!session) return;
  session.currentSessionId = sessionId;
  saveSession(sessionsDir, agentId, topicId, session);
}

// --- Session pruning ---
export function pruneOldSessions(sessionsDir: string, maxAgeDays: number): number {
  const maxAge = maxAgeDays * 86400000;
  let pruned = 0;
  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as SessionData;
        if (Date.now() - (data.createdAt || 0) > maxAge) {
          unlinkSync(join(sessionsDir, f));
          pruned++;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return pruned;
}

// --- Bootstrap file system ---
const DEFAULT_BOOTSTRAP_FILES = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md', 'USER.md', 'MEMORY.md'];

export function buildBootstrapPrompt(vaultPath: string, agentId: string, userMessage: string, {
  bootstrapFiles = DEFAULT_BOOTSTRAP_FILES,
  maxFileSize = 8000,
}: { bootstrapFiles?: string[]; maxFileSize?: number } = {}): string {
  const workspace = join(vaultPath, agentId);
  const sections: string[] = [];
  for (const file of bootstrapFiles) {
    const filePath = join(workspace, file);
    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf8');
        if (content.length <= maxFileSize) {
          sections.push(`<${file}>\n${content}\n</${file}>`);
        }
      } catch { /* ignore */ }
    }
  }
  return sections.length > 0
    ? `${sections.join('\n\n')}\n\n---\nUser message: ${userMessage}`
    : userMessage;
}

// --- Unified topic prompt (super-agent mode) ---
export function buildTopicPrompt(domain: string, topicId: number | string, userMessage: string): string {
  return `[TOPIC: ${domain} | Topic ID: ${topicId}]\n\n${userMessage}`;
}

// --- Claude output parsing ---
export function isSessionExpiredError(stdout: string, stderr: string): boolean {
  const combined = (stdout + stderr).toLowerCase();
  return combined.includes("no conversation found") ||
         combined.includes("session_expired") ||
         combined.includes("session not found") ||
         combined.includes("could not resume");
}

export function parseClaudeResult(stdout: string): ParsedClaudeResult {
  const lines = stdout.trim().split("\n");
  let sessionId: string | undefined;
  let resultText: string | undefined;

  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (obj.type === "result") {
        sessionId = obj.session_id as string | undefined;
        resultText = obj.result as string | undefined;
        break;
      }
    } catch { /* ignore */ }
  }

  if (!resultText) {
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]!) as Record<string, unknown>;
        if (obj.type === "assistant" && obj.message) {
          const message = obj.message as { content?: Array<{ type: string; text?: string }> };
          const textBlocks = (message.content ?? [])
            .filter((b) => b.type === "text" && b.text)
            .map((b) => b.text!);
          if (textBlocks.length > 0) {
            resultText = textBlocks.join("\n");
            if (!sessionId) sessionId = obj.session_id as string | undefined;
            break;
          }
        }
      } catch { /* ignore */ }
    }
  }

  if (resultText) {
    return { sessionId, text: resultText };
  }

  try {
    const result = JSON.parse(stdout) as Record<string, unknown>;
    return { sessionId: result.session_id as string | undefined, text: (result.result as string) || "Agent finished without a text response. Try rephrasing your request." };
  } catch {
    return { sessionId, text: "Agent finished without a text response. Try rephrasing your request." };
  }
}

// --- Markdown conversion ---
export function mdToTelegramHtml(md: string): string {
  let result = md;
  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // Protect fenced code blocks
  result = result.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
    const i = codeBlocks.length;
    const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    codeBlocks.push(
      lang
        ? `<pre><code class="language-${lang}">${esc}</code></pre>`
        : `<pre>${esc}</pre>`
    );
    return `\x00CB${i}\x00`;
  });

  // Convert Markdown tables to <pre> blocks (Telegram has no table support)
  result = result.replace(
    /((?:^[ \t]*\|.+\|[ \t]*$\n?){2,})/gm,
    (tableBlock) => {
      const lines = tableBlock.replace(/\n$/, "").split("\n");
      // Drop separator rows (|---|---|)
      const dataLines = lines.filter((l) => !/^\s*\|[\s\-:|]+\|\s*$/.test(l));
      // Parse cells from each row
      const rows = dataLines.map((l) =>
        l.split("|").slice(1, -1).map((c) => c.trim())
      );
      if (rows.length === 0) return tableBlock;
      // Calculate column widths
      const colCount = Math.max(...rows.map((r) => r.length));
      const widths = Array.from({ length: colCount }, (_, ci) =>
        Math.max(...rows.map((r) => (r[ci] || "").length), 1)
      );
      // Render padded rows
      const rendered = rows
        .map((r) =>
          r.map((c, ci) => (c || "").padEnd(widths[ci]!)).join("  ")
        )
        .join("\n");
      const esc = rendered.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const i = codeBlocks.length;
      codeBlocks.push(`<pre>${esc}</pre>`);
      return `\x00CB${i}\x00`;
    }
  );

  // Protect inline code
  result = result.replace(/`([^`]+)`/g, (_, code: string) => {
    const i = inlineCodes.length;
    const esc = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    inlineCodes.push(`<code>${esc}</code>`);
    return `\x00IC${i}\x00`;
  });

  result = result.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "\n<b>$1</b>");
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");
  result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  result = result.replace(/^&gt;\s?(.+)$/gm, "<blockquote>$1</blockquote>");
  result = result.replace(/<\/blockquote>\n<blockquote>/g, "\n");
  // Convert unordered list markers (- or *) to bullet points
  result = result.replace(/^[ \t]*[-*][ \t]+/gm, "• ");
  result = result.replace(/\x00CB(\d+)\x00/g, (_, i: string) => codeBlocks[Number(i)]!);
  result = result.replace(/\x00IC(\d+)\x00/g, (_, i: string) => inlineCodes[Number(i)]!);

  return result.trim();
}

// --- Message splitting ---
export function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = -1;

    const paragraphBreak = remaining.lastIndexOf("\n\n", maxLen);
    if (paragraphBreak > maxLen * 0.3) {
      splitAt = paragraphBreak + 2;
    } else {
      const lineBreak = remaining.lastIndexOf("\n", maxLen);
      if (lineBreak > maxLen * 0.3) {
        splitAt = lineBreak + 1;
      } else {
        const spaceBreak = remaining.lastIndexOf(" ", maxLen);
        if (spaceBreak > maxLen * 0.3) {
          splitAt = spaceBreak + 1;
        } else {
          splitAt = maxLen;
        }
      }
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
