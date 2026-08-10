import { timingSafeEqual } from "crypto";
import { setTimeout as delay } from "timers/promises";

const UNSAFE_BROWSER_TOOLS = new Set([
  // Network request URLs can contain fresh OAuth codes, signed URL parameters,
  // and session tokens that are not covered by dotenv substitution.
  "browser_network_request",
  "browser_network_requests",
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
]);

export interface BrowserToolLike {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface PlaywrightLaunchOptions {
  cliPath: string;
  profileDir: string;
  secretsFile: string;
  outputDir: string;
  headless?: boolean;
}

/** Pass only browser/runtime variables to the untrusted upstream subprocess. */
export function playwrightChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = new Set([
    "DISPLAY", "HOME", "LANG", "LC_ALL", "PATH", "PLAYWRIGHT_BROWSERS_PATH",
    "TZ", "XAUTHORITY", "npm_config_cache",
  ]);
  return Object.fromEntries(Object.entries(environment)
    .filter((entry): entry is [string, string] => allowed.has(entry[0]) && typeof entry[1] === "string"));
}

/** The upstream server deliberately exposes an RCE-equivalent core tool. */
export function isUnsafeBrowserTool(name: string): boolean {
  return UNSAFE_BROWSER_TOOLS.has(name);
}

/** Filter at the MCP server boundary, not merely in Claude CLI configuration. */
export function safeBrowserTools<T extends BrowserToolLike>(tools: readonly T[]): T[] {
  return tools.filter((tool) => !isUnsafeBrowserTool(tool.name));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Advertise the stricter file contract that the gateway actually enforces. */
export function safeBrowserToolContracts<T extends BrowserToolLike>(tools: readonly T[]): T[] {
  return safeBrowserTools(tools).map((tool) => {
    const schema = object(tool.inputSchema);
    const properties = object(schema?.properties);
    if (!schema || !properties) return tool;
    const nextProperties = { ...properties };
    if (object(nextProperties.filename)) {
      nextProperties.filename = {
        ...object(nextProperties.filename),
        pattern: "^browser-artifacts/[^/\\\\]+$",
        description: "One workspace-relative output path: browser-artifacts/<filename>. No absolute paths or subdirectories.",
      };
    }
    if ((tool.name === "browser_file_upload" || tool.name === "browser_drop") && object(nextProperties.paths)) {
      nextProperties.paths = {
        ...object(nextProperties.paths),
        description: "Files previously placed in the exchange, each as browser-uploads/<filename>. Symlinks and subdirectories are rejected.",
        items: {
          type: "string",
          pattern: "^browser-uploads/[^/\\\\]+$",
        },
      };
    }
    return { ...tool, inputSchema: { ...schema, properties: nextProperties } };
  }) as T[];
}

export function authorizedBearer(expectedToken: string, authorization: string | undefined): boolean {
  if (expectedToken.length < 32 || !authorization?.startsWith("Bearer ")) return false;
  const provided = authorization.slice("Bearer ".length);
  const expectedBytes = Buffer.from(expectedToken);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export class ExclusiveBrowserQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    try { return await work(); }
    finally { release(); }
  }
}

export class BrowserSessionLease {
  private owner: string | null = null;
  private touchedAt = 0;
  private inFlight = 0;
  private releasePending = false;

  constructor(private readonly idleMs: number) {}

  acquire(sessionId: string, now = Date.now()): boolean {
    this.expire(now);
    if (this.owner !== null && this.owner !== sessionId) return false;
    this.owner = sessionId;
    this.touchedAt = now;
    this.inFlight += 1;
    this.releasePending = false;
    return true;
  }

  /** Queue a sequential client until a stale, non-in-flight owner expires. */
  async acquireWithin(sessionId: string, waitMs: number, signal?: AbortSignal): Promise<boolean> {
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error("browser lease wait must be non-negative");
    const deadline = Date.now() + waitMs;
    while (!this.acquire(sessionId)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(100, remaining), undefined, { signal });
    }
    return true;
  }

  complete(sessionId: string, now = Date.now()): void {
    if (this.owner !== sessionId) return;
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.touchedAt = now;
    if (this.inFlight === 0 && this.releasePending) this.clear();
  }

  release(sessionId: string): void {
    if (this.owner === sessionId) {
      if (this.inFlight > 0) this.releasePending = true;
      else this.clear();
    }
  }

  isHeld(now = Date.now()): boolean {
    this.expire(now);
    return this.owner !== null;
  }

  private expire(now: number): void {
    if (this.owner !== null && this.inFlight === 0 && now - this.touchedAt >= this.idleMs) this.clear();
  }

  private clear(): void {
    this.owner = null;
    this.touchedAt = 0;
    this.inFlight = 0;
    this.releasePending = false;
  }
}

/**
 * Build the only supported upstream launch. The gateway owns this argv so an
 * untrusted MCP client cannot alter the browser/profile/security settings.
 */
export function buildPlaywrightArgs(options: PlaywrightLaunchOptions): string[] {
  return [
    options.cliPath,
    ...(options.headless === false ? [] : ["--headless"]),
    "--browser", "chromium",
    "--sandbox",
    "--user-data-dir", options.profileDir,
    "--secrets", options.secretsFile,
    "--caps", "vision,pdf",
    "--viewport-size", "1440x1000",
    "--timeout-action", "15000",
    "--timeout-navigation", "90000",
    "--console-level", "warning",
    // Defense in depth for loopback web requests. Kernel cgroup filters in the
    // unit separately deny private/link-local networks; upstream itself warns
    // this origin block is not a standalone security boundary.
    "--blocked-origins", "localhost;127.*;0.0.0.0;http://[::1];https://[::1]",
    "--output-dir", options.outputDir,
    "--output-max-size", "1073741824",
  ];
}

export function browserToolResultError(result: unknown): string | null {
  if (!result || typeof result !== "object") return "browser tool returned no result";
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text
      : "")
    .filter(Boolean)
    .join("\n");
  if (record.isError === true || /^### Error\b/m.test(text)) {
    return text.trim() || "browser tool returned an unspecified error";
  }
  return null;
}
