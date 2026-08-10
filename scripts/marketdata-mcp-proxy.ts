#!/usr/bin/env node
/**
 * Secret-safe launcher for the pinned Alpha Vantage MCP server.
 *
 * The upstream server accepts its API key through the environment, but some
 * HTTP errors stringify the complete request URL. This proxy keeps the key out
 * of registered argv and redacts the exact credential from both MCP stdout and
 * stderr before either stream reaches Claude, session logs, or CI output.
 */
import { spawn } from "child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { Transform, type TransformCallback, type Readable, type Writable } from "stream";
import { finished } from "stream/promises";
import { StringDecoder } from "string_decoder";
import { fileURLToPath } from "url";

export const MARKETDATA_PACKAGE = "marketdata-mcp-server==0.3.1";
// 0.3.1 declares only `mcp>=1.12.3`, but its low-level Server decorators were
// removed in mcp 2.0. Keep the last verified 1.x SDK explicit so a fresh uvx
// resolution cannot turn a working registration into a startup crash.
export const MARKETDATA_MCP_SDK = "mcp==1.28.1";
const KEY_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;
const MAX_SECRET_FILE_BYTES = 1024 * 1024;

function validKey(value: string | undefined): string | null {
  return value && KEY_PATTERN.test(value) ? value : null;
}

function readProtectedFile(path: string, effectiveUid: number | undefined, allowGroupRead: boolean): string {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ELOOP") {
      throw new Error("market-data credential source is not a protected regular file");
    }
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error("market-data credential source is not a protected regular file");
    }
    if (effectiveUid !== undefined && stat.uid !== effectiveUid) {
      throw new Error("market-data credential source has an unexpected owner");
    }
    const forbiddenMode = allowGroupRead ? 0o027 : 0o077;
    if ((stat.mode & forbiddenMode) !== 0) {
      throw new Error("market-data credential source permissions are too broad");
    }
    if (stat.size > MAX_SECRET_FILE_BYTES) {
      throw new Error("market-data credential source is unexpectedly large");
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readSingleLineKey(path: string, effectiveUid: number | undefined): string {
  let raw = readProtectedFile(path, effectiveUid, false);
  if (raw.endsWith("\n")) raw = raw.slice(0, -1);
  if (raw.endsWith("\r")) raw = raw.slice(0, -1);
  if (/[\r\n\0]/.test(raw)) throw new Error("market-data credential file must contain one line");
  const key = validKey(raw);
  if (!key) throw new Error("market-data credential is unavailable or invalid");
  return key;
}

export function parseAlphaVantageKeyFromEnvFile(source: string): string | null {
  let candidate: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?ALPHA_VANTAGE_API_KEY\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[1]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    candidate = value;
  }
  return validKey(candidate);
}

function readRootProjectEnvKey(path: string, effectiveUid: number): string {
  const key = parseAlphaVantageKeyFromEnvFile(readProtectedFile(path, effectiveUid, true));
  if (!key) throw new Error("market-data credential is unavailable or invalid");
  return key;
}

function isMissingFile(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && err.code === "ENOENT";
}

export function resolveMarketdataApiKey(
  env: NodeJS.ProcessEnv = process.env,
  effectiveUid: number | undefined = typeof process.getuid === "function" ? process.getuid() : undefined,
): string {
  const inherited = validKey(env.ALPHA_VANTAGE_API_KEY);
  if (inherited) return inherited;
  if (env.ALPHA_VANTAGE_API_KEY) throw new Error("market-data credential is unavailable or invalid");

  const home = env.HOME?.trim();
  const explicitKeyFile = env.LETYCLAW_MARKETDATA_KEY_FILE?.trim();
  const keyFile = explicitKeyFile || (home ? join(home, ".config", "letyclaw", "marketdata-key") : "");
  if (keyFile) {
    try {
      return readSingleLineKey(keyFile, effectiveUid);
    } catch (err) {
      if (explicitKeyFile || !isMissingFile(err)) throw err;
    }
  }

  // Production root sessions historically load /root/letyclaw/.env. Parse only
  // the one required assignment without executing or exporting the file.
  if (effectiveUid === 0) {
    const projectRoot = env.LETYCLAW_PROJECT_ROOT?.trim() || "/root/letyclaw";
    return readRootProjectEnvKey(join(projectRoot, ".env"), effectiveUid);
  }

  throw new Error("market-data credential is unavailable or invalid");
}

/** A boundary-safe exact-secret redactor. The replacement preserves length. */
export class SecretRedactor extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private readonly replacement: string;
  private carry = "";

  constructor(private readonly secret: string) {
    super();
    this.replacement = "*".repeat(secret.length);
  }

  private mask(value: string): string {
    return value.split(this.secret).join(this.replacement);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const combined = this.carry + this.decoder.write(chunk);
    const masked = this.mask(combined);
    // Retain only a suffix that could actually become the start of the secret
    // on the next chunk. Holding a fixed N-1 byte tail would deadlock the
    // long-lived newline-delimited MCP stream after every response.
    let hold = 0;
    const maxPrefix = Math.min(this.secret.length - 1, masked.length);
    for (let length = maxPrefix; length > 0; length--) {
      if (masked.endsWith(this.secret.slice(0, length))) {
        hold = length;
        break;
      }
    }
    const emitLength = combined.length - hold;
    if (emitLength > 0) this.push(masked.slice(0, emitLength));
    this.carry = combined.slice(emitLength);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.push(this.mask(this.carry + this.decoder.end()));
    this.carry = "";
    callback();
  }
}

export interface MarketdataProxyOptions {
  env?: NodeJS.ProcessEnv;
  command?: string;
  input?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  forwardSignals?: boolean;
}

const MARKETDATA_CHILD_ENV_ALLOWLIST = [
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "UV_CACHE_DIR", "XDG_CACHE_HOME",
] as const;

export function marketdataChildEnv(source: NodeJS.ProcessEnv, apiKey: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ALPHA_VANTAGE_API_KEY: apiKey };
  for (const name of MARKETDATA_CHILD_ENV_ALLOWLIST) {
    if (source[name]) child[name] = source[name];
  }
  return child;
}

export function runMarketdataProxy(options: MarketdataProxyOptions = {}): Promise<number> {
  const env = options.env || process.env;
  const apiKey = resolveMarketdataApiKey(env);
  const ownsProcessGroup = process.platform !== "win32";
  const child = spawn(options.command || "uvx", [
    // The bot's working directory is model-writable. Ignore project uv config
    // and dotenv files so they cannot replace indexes, constraints, or env.
    "--no-config", "--no-env-file",
    "--from", MARKETDATA_PACKAGE,
    "--with", MARKETDATA_MCP_SDK,
    "marketdata-mcp",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
    // A smoke/client timeout must reap uvx and its Python server together.
    // Keeping a dedicated POSIX process group also makes normal proxy signal
    // forwarding cover transitive children instead of only the uv executable.
    detached: ownsProcessGroup,
    // The bot carries Telegram, Gmail, Vapi, and other unrelated credentials.
    // A third-party market-data server needs none of them.
    env: marketdataChildEnv(env, apiKey),
  });

  const input = options.input || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const stdoutRedactor = new SecretRedactor(apiKey);
  const stderrRedactor = new SecretRedactor(apiKey);
  input.pipe(child.stdin);
  child.stdout.pipe(stdoutRedactor).pipe(stdout, { end: false });
  child.stderr.pipe(stderrRedactor).pipe(stderr, { end: false });
  let stdinFailure: Error | null = null;
  const signalChild = (signal: NodeJS.Signals): void => {
    if (ownsProcessGroup && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch { /* group may already be gone */ }
    }
    try { child.kill(signal); } catch { /* child already gone */ }
  };
  child.stdin.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    stdinFailure = err;
    signalChild("SIGTERM");
  });

  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  if (options.forwardSignals !== false) {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      const handler = (): void => signalChild(signal);
      signalHandlers.set(signal, handler);
      process.once(signal, handler);
    }
  }
  const cleanup = (): void => {
    input.unpipe(child.stdin);
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  };

  return new Promise((resolvePromise, reject) => {
    child.once("error", (err) => {
      cleanup();
      reject(err);
    });
    child.once("close", async (code) => {
      cleanup();
      await Promise.allSettled([finished(stdoutRedactor), finished(stderrRedactor)]);
      if (stdinFailure) {
        reject(stdinFailure);
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runMarketdataProxy();
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown startup error";
    console.error(`[marketdata-mcp] unavailable: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
