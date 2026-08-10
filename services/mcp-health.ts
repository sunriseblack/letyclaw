/**
 * MCP health monitor — periodically runs `claude mcp list` and alerts on
 * connection state transitions (✓→✗ or ✗→✓). State is in-memory; first run
 * just records baseline without alerting.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { promisify } from "util";

const execFileP = promisify(execFile);

export type McpStatus = "ok" | "fail" | "auth";

export interface McpState {
  /** name → status, latest known */
  servers: Map<string, McpStatus>;
  /** name → consecutive-tick count where it was absent from `claude mcp list`.
   * Used to suppress transient "removed" alerts caused by HTTP timeouts on
   * cloud MCPs (Claude CLI sometimes omits rows it can't health-check). */
  missingCounts: Map<string, number>;
  /** name → true once we've alerted that this server is "removed" — ensures
   * we fire a recovery notice when it reappears. */
  alertedRemoved: Set<string>;
  /** ISO timestamp of last successful check */
  lastCheck: string | null;
}

const state: McpState = {
  servers: new Map(),
  missingCounts: new Map(),
  alertedRemoved: new Set(),
  lastCheck: null,
};

/** Number of consecutive missing ticks before firing a "removed" alert. */
const MISSING_THRESHOLD = 2;
const BROWSER_GATEWAY_READY_FILE = process.env.BROWSER_GATEWAY_READY_FILE || "/run/letyclaw-browser/ready";

export function getMcpState(): { servers: Record<string, McpStatus>; lastCheck: string | null } {
  return {
    servers: Object.fromEntries(state.servers),
    lastCheck: state.lastCheck,
  };
}

/**
 * Parse `claude mcp list` output. Lines look like:
 *   name: <command/url> - ✓ Connected
 *   name: <command/url> - ✗ Failed to connect
 *   name: <url> - ! Needs authentication
 */
/**
 * Servers we don't monitor for Telegram alerts. The `claude.ai *` hosted MCPs
 * (Slack, Notion, Figma, Gmail, Calendar, Drive) are Anthropic-managed and
 * flap constantly on their end — alerting on them is noise we can't act on.
 * Other transient-failure servers can be added here.
 */
function isIgnored(name: string): boolean {
  return name.startsWith("claude.ai ");
}

function parseMcpList(output: string): Map<string, McpStatus> {
  const result = new Map<string, McpStatus>();
  for (const line of output.split("\n")) {
    const m = line.match(/^([\w.-]+(?:\s[\w.-]+)*?):\s+.+?-\s+([✓✗!])\s/);
    if (!m) continue;
    const name = m[1]!.trim();
    if (isIgnored(name)) continue;
    const sym = m[2]!;
    result.set(name, sym === "✓" ? "ok" : sym === "!" ? "auth" : "fail");
  }
  return result;
}

/**
 * Run a single health check. Returns the list of transition messages
 * (e.g. "playwright: ✓ → ✗") for alerting. Empty array on first run.
 */
export async function checkMcpHealth(claudePath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  let output: string;
  try {
    const { stdout } = await execFileP(claudePath, ["mcp", "list"], { env, timeout: 30000 });
    output = stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[mcp-health] check failed:", msg);
    return [];
  }

  const fresh = parseMcpList(output);
  if (fresh.size === 0) {
    console.warn("[mcp-health] parsed 0 servers — output format may have changed");
    return [];
  }
  // The gateway writes this only after a functional browser_tabs probe and
  // removes it before exit. Its periodic heartbeat catches Chromium crashes
  // that protocol-only `claude mcp list` cannot see.
  fresh.set("playwright-browser", existsSync(BROWSER_GATEWAY_READY_FILE) ? "ok" : "fail");

  const transitions: string[] = [];
  const isFirstRun = state.servers.size === 0;
  const sym = (s: McpStatus): string => s === "ok" ? "✓" : s === "auth" ? "!" : "✗";

  for (const [name, status] of fresh) {
    const prev = state.servers.get(name);
    if (prev && prev !== status) {
      transitions.push(`${name}: ${sym(prev)} → ${sym(status)}`);
    }
    // Server is back — reset missing counter and fire recovery if we'd alerted
    if (state.missingCounts.has(name)) state.missingCounts.delete(name);
    if (state.alertedRemoved.has(name)) {
      state.alertedRemoved.delete(name);
      transitions.push(`${name}: reappeared → ${sym(status)}`);
    }
  }

  // Detect servers absent from this check. Require MISSING_THRESHOLD consecutive
  // misses before alerting — single-tick disappearance is almost always a
  // transient timeout in `claude mcp list`'s per-server health check, not a
  // real removal. Track the union of state + already-known-missing.
  const knownNames = new Set([...state.servers.keys(), ...state.missingCounts.keys()]);
  for (const name of knownNames) {
    if (fresh.has(name)) continue;
    const count = (state.missingCounts.get(name) || 0) + 1;
    state.missingCounts.set(name, count);
    if (count === MISSING_THRESHOLD && !state.alertedRemoved.has(name)) {
      transitions.push(`${name}: removed from registry (missed ${count} consecutive checks)`);
      state.alertedRemoved.add(name);
    }
  }

  state.servers = fresh;
  state.lastCheck = new Date().toISOString();

  return isFirstRun ? [] : transitions;
}

/**
 * Start periodic health checks. Calls `onAlert` with a single composed
 * message whenever transitions are detected.
 */
export function startMcpHealthMonitor(
  claudePath: string,
  env: NodeJS.ProcessEnv,
  onAlert: (msg: string) => void,
  intervalMs = 30 * 60 * 1000,
): () => void {
  const tick = async (): Promise<void> => {
    const transitions = await checkMcpHealth(claudePath, env);
    if (transitions.length > 0) {
      const failing = transitions.filter(t => t.includes("→ ✗") || t.includes("removed"));
      const recovered = transitions.filter(t => t.includes("→ ✓"));
      const lines = ["⚠ MCP server state changed:"];
      if (failing.length > 0) lines.push("", "Failing:", ...failing.map(t => `  ${t}`));
      if (recovered.length > 0) lines.push("", "Recovered:", ...recovered.map(t => `  ${t}`));
      onAlert(lines.join("\n"));
    }
  };

  tick().catch(err => console.error("[mcp-health] initial tick failed:", err));
  const handle = setInterval(() => { tick().catch(err => console.error("[mcp-health] tick failed:", err)); }, intervalMs);
  return () => clearInterval(handle);
}
