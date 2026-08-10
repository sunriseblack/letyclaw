#!/usr/bin/env node
/**
 * Safe persistent gateway for Playwright MCP.
 *
 * The upstream Playwright process is a private stdio child. Only this gateway
 * can reach it, so browser_run_code_unsafe is not reachable through a second
 * loopback port. One long-lived upstream client owns the browser context across
 * all short Claude HTTP sessions and heartbeat-checks the actual Chromium
 * process, not merely the MCP transport.
 */
import { randomUUID } from "crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "http";
import { createConnection } from "net";
import { chmodSync, lstatSync, unlinkSync, writeFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListRootsRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  authorizedBearer,
  BrowserSessionLease,
  browserToolResultError,
  buildPlaywrightArgs,
  ExclusiveBrowserQueue,
  isUnsafeBrowserTool,
  playwrightChildEnvironment,
  safeBrowserToolContracts,
} from "./browser-gateway-core.js";
import { brokerBrowserArguments, purgeStagedBrowserUploads } from "./browser-file-broker.js";
import {
  isSafeGatewayBrowserTool,
  SAFE_GATEWAY_BROWSER_TOOLS,
  safeGatewayUpstreamCall,
} from "./browser-safe-dom.js";
import {
  assertSecretAliasesAllowed,
  loadBrowserSecretPolicy,
  originFromEvaluateResult,
  secretTargetsInBrowserArguments,
  type BrowserSecretPolicy,
} from "./browser-secret-policy.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PLAYWRIGHT_GATEWAY_PORT || "3100");
const SOCKET = (process.env.PLAYWRIGHT_GATEWAY_SOCKET || "").trim();
const READY_FILE = process.env.PLAYWRIGHT_GATEWAY_READY_FILE || "/run/letyclaw-browser/ready";
const WORKSPACE_ROOT = process.env.PLAYWRIGHT_WORKSPACE_ROOT || "/root/vault";
const NODE = process.env.PLAYWRIGHT_NODE_PATH || process.execPath;
const CLI = process.env.PLAYWRIGHT_MCP_CLI ||
  "/var/lib/letyclaw-browser-runtime/mcp-0.0.78/mcp/node_modules/@playwright/mcp/cli.js";
const PROFILE = process.env.PLAYWRIGHT_PROFILE_DIR || "/var/lib/letyclaw-browser/profile";
const SECRETS = process.env.PLAYWRIGHT_SECRETS_FILE || "/var/lib/letyclaw-browser/secrets.env";
const SECRET_POLICY_FILE = process.env.PLAYWRIGHT_SECRET_POLICY_FILE || "/var/lib/letyclaw-browser/secret-policy.json";
const OUTPUT = process.env.PLAYWRIGHT_OUTPUT_DIR || "/root/vault/browser-artifacts";
const SHARED_UPLOAD_DIR = process.env.PLAYWRIGHT_SHARED_UPLOAD_DIR || "/root/vault/browser-uploads";
const PRIVATE_STAGE_DIR = process.env.PLAYWRIGHT_PRIVATE_STAGE_DIR || "/var/lib/letyclaw-browser/staged-uploads";
const EXPOSED_STAGE_DIR = process.env.PLAYWRIGHT_EXPOSED_STAGE_DIR || "/root/vault/.browser-staged-uploads";
const HEADLESS = process.env.PLAYWRIGHT_HEADLESS !== "0";
const HEARTBEAT_MS = Number(process.env.PLAYWRIGHT_HEARTBEAT_MS || "20000");
const REQUEST_TIMEOUT_MS = Number(process.env.PLAYWRIGHT_REQUEST_TIMEOUT_MS || "120000");
const LEASE_IDLE_MS = Number(process.env.PLAYWRIGHT_LEASE_IDLE_MS || "30000");
const SESSION_IDLE_MS = Number(process.env.PLAYWRIGHT_SESSION_IDLE_MS || "300000");
const STAGED_UPLOAD_RETENTION_MS = Number(process.env.PLAYWRIGHT_STAGED_UPLOAD_RETENTION_MS || "900000");
const MAX_SESSIONS = Number(process.env.PLAYWRIGHT_MAX_SESSIONS || "64");
const GATEWAY_TOKEN = process.env.PLAYWRIGHT_GATEWAY_TOKEN || "";
const REQUIRE_LOOPBACK_DENY = process.env.PLAYWRIGHT_REQUIRE_LOOPBACK_DENY === "1";
const MAX_BODY_BYTES = 1_000_000;

type UpstreamTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type DownstreamEntry = { transport: StreamableHTTPServerTransport; server: Server; lastSeen: number };

class HttpRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function validatedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpRequestError(413, "MCP request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new HttpRequestError(400, "MCP request body is not valid JSON"); }
}

function sessionId(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  return Array.isArray(value) ? value[0] : value;
}

function allowedHost(value: string | undefined): boolean {
  if (!value) return false;
  const hostname = value.toLowerCase().replace(/:\d+$/, "");
  return hostname === "localhost" || hostname === "127.0.0.1";
}

async function assertLoopbackDenied(): Promise<void> {
  await Promise.all(["127.0.0.1", "::1", "::ffff:127.0.0.1"].map((host) =>
    new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host, port: 9 });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve();
      };
      // systemd 249's cgroup-BPF IPAddressDeny drops these connects, so the
      // observed success signal is a bounded timeout. Without the deny, Linux
      // returns ECONNREFUSED immediately because port 9 has no listener.
      socket.setTimeout(2_000, () => finish());
      socket.once("connect", () => finish(new Error(`browser cgroup can reach forbidden loopback host ${host}`)));
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EACCES" || error.code === "EPERM" || error.code === "ETIMEDOUT") finish();
        else finish(new Error(`loopback cgroup deny is not enforced for ${host}: ${error.code || error.message}`));
      });
    }),
  ));
}

function createDownstreamServer(
  upstream: Client,
  tools: readonly UpstreamTool[],
  getSessionId: () => string | undefined,
  lease: BrowserSessionLease,
  queue: ExclusiveBrowserQueue,
  secretPolicy: BrowserSecretPolicy,
): Server {
  const server = new Server(
    { name: "letyclaw-playwright-gateway", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: "Safe persistent Playwright browser. Arbitrary code execution is unavailable; use browser_dom_query for audited read-only DOM extraction.",
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    if (isUnsafeBrowserTool(name) || !tools.some((tool) => tool.name === name)) {
      return {
        isError: true,
        content: [{ type: "text", text: `Browser tool is not available through the safe gateway: ${name}` }],
      };
    }
    const sid = getSessionId();
    if (!sid) {
      return { isError: true, content: [{ type: "text", text: "Browser session is not initialized" }] };
    }
    const leaseWaitMs = Math.min(LEASE_IDLE_MS + 5_000, REQUEST_TIMEOUT_MS - 1_000);
    if (!await lease.acquireWithin(sid, leaseWaitMs, extra.signal)) {
      return {
        isError: true,
        content: [{ type: "text", text: "Browser remains busy with another active task. Retry later; do not start a parallel booking flow." }],
      };
    }
    try {
      return await queue.run(async () => {
      let brokered: Awaited<ReturnType<typeof brokerBrowserArguments>> | undefined;
      try {
        brokered = await brokerBrowserArguments(name, request.params.arguments, {
          sharedUploadDir: SHARED_UPLOAD_DIR,
          privateStageDir: PRIVATE_STAGE_DIR,
          exposedStageDir: EXPOSED_STAGE_DIR,
        });
        const secretTargets = secretTargetsInBrowserArguments(name, brokered.args, secretPolicy);
        for (const secretTarget of secretTargets) {
          const originResult = await upstream.callTool(
            {
              name: "browser_evaluate",
              arguments: {
                function: "(element) => element.ownerDocument.location.origin",
                element: secretTarget.element,
                target: secretTarget.target,
              },
            },
            CallToolResultSchema,
            { signal: extra.signal, timeout: 15_000, maxTotalTimeout: 15_000 },
          );
          const originError = browserToolResultError(originResult);
          if (originError) throw new Error(`unable to verify browser secret origin: ${originError}`);
          assertSecretAliasesAllowed([secretTarget.alias], originFromEvaluateResult(originResult), secretPolicy);
        }
        const upstreamCall = isSafeGatewayBrowserTool(name)
          ? safeGatewayUpstreamCall(name, brokered.args)
          : { ...request.params, arguments: brokered.args };
        return await upstream.callTool(
          upstreamCall,
          CallToolResultSchema,
          {
            signal: extra.signal,
            timeout: REQUEST_TIMEOUT_MS,
            maxTotalTimeout: REQUEST_TIMEOUT_MS,
          },
        );
      } finally {
        const retainMs = name === "browser_file_upload" || name === "browser_drop"
          ? STAGED_UPLOAD_RETENTION_MS
          : 0;
        brokered?.cleanup(retainMs);
      }
      });
    } finally {
      lease.complete(sid);
    }
  });
  return server;
}

async function listen(server: ReturnType<typeof createHttpServer>): Promise<void> {
  if (SOCKET) {
    try {
      const existing = lstatSync(SOCKET);
      if (!existing.isSocket() || existing.isSymbolicLink()) {
        throw new Error(`refusing unsafe browser gateway socket path: ${SOCKET}`);
      }
      unlinkSync(SOCKET);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    if (SOCKET) server.listen(SOCKET, onListening);
    else server.listen(PORT, HOST, onListening);
  });
  if (SOCKET) chmodSync(SOCKET, 0o660);
}

async function closeHttp(server: ReturnType<typeof createHttpServer>): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  // Standalone MCP GET streams and keep-alive sockets otherwise keep close()
  // pending indefinitely after a browser crash, preventing systemd recovery.
  server.closeAllConnections();
  await closed;
}

async function main(): Promise<void> {
  validatedInteger("PLAYWRIGHT_GATEWAY_PORT", PORT, 1, 65535);
  validatedInteger("PLAYWRIGHT_HEARTBEAT_MS", HEARTBEAT_MS, 5_000, 300_000);
  validatedInteger("PLAYWRIGHT_REQUEST_TIMEOUT_MS", REQUEST_TIMEOUT_MS, 15_000, 300_000);
  validatedInteger("PLAYWRIGHT_LEASE_IDLE_MS", LEASE_IDLE_MS, 5_000, 300_000);
  validatedInteger("PLAYWRIGHT_SESSION_IDLE_MS", SESSION_IDLE_MS, 60_000, 3_600_000);
  validatedInteger("PLAYWRIGHT_STAGED_UPLOAD_RETENTION_MS", STAGED_UPLOAD_RETENTION_MS, 60_000, 3_600_000);
  validatedInteger("PLAYWRIGHT_MAX_SESSIONS", MAX_SESSIONS, 1, 256);
  if (GATEWAY_TOKEN.length < 32) throw new Error("PLAYWRIGHT_GATEWAY_TOKEN must contain at least 32 characters");
  if (REQUIRE_LOOPBACK_DENY) await assertLoopbackDenied();
  const secretPolicy = loadBrowserSecretPolicy(SECRET_POLICY_FILE, SECRETS);

  const args = buildPlaywrightArgs({
    cliPath: CLI,
    profileDir: PROFILE,
    secretsFile: SECRETS,
    outputDir: OUTPUT,
    headless: HEADLESS,
  });
  const upstreamTransport = new StdioClientTransport({
    command: NODE,
    args,
    env: playwrightChildEnvironment(),
    stderr: "inherit",
    cwd: WORKSPACE_ROOT,
  });
  const upstream = new Client(
    { name: "letyclaw-playwright-private-client", version: "1.0.0" },
    { capabilities: { roots: { listChanged: false } } },
  );
  upstream.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: `file://${WORKSPACE_ROOT}`, name: "letyclaw-browser-workspace" }],
  }));

  let stopping = false;
  let exitCode = 0;
  let heartbeat: NodeJS.Timeout | undefined;
  let maintenance: NodeJS.Timeout | undefined;
  let heartbeatRunning = false;
  const queue = new ExclusiveBrowserQueue();
  const lease = new BrowserSessionLease(LEASE_IDLE_MS);
  const sessions = new Map<string, DownstreamEntry>();

  const http = createHttpServer(async (req, res) => {
    try {
      const auth = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
      if (!allowedHost(req.headers.host)) {
        jsonError(res, 403, "Forbidden host");
        return;
      }
      if (!authorizedBearer(GATEWAY_TOKEN, auth)) {
        res.setHeader("www-authenticate", "Bearer");
        jsonError(res, 401, "Unauthorized");
        return;
      }
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (url.pathname !== "/mcp") {
        jsonError(res, 404, "Not found");
        return;
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        res.setHeader("allow", "GET, POST, DELETE");
        jsonError(res, 405, "Method not allowed");
        return;
      }

      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      const sid = sessionId(req);
      let entry = sid ? sessions.get(sid) : undefined;
      if (entry) entry.lastSeen = Date.now();
      if (!entry && !sid && req.method === "POST" && isInitializeRequest(body)) {
        if (sessions.size >= MAX_SESSIONS) {
          jsonError(res, 503, "Browser gateway has too many active sessions; retry shortly");
          return;
        }
        let transport!: StreamableHTTPServerTransport;
        const server = createDownstreamServer(
          upstream, safeTools, () => transport.sessionId, lease, queue, secretPolicy,
        );
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (initialized): void => {
            sessions.set(initialized, { transport, server, lastSeen: Date.now() });
          },
        });
        entry = { transport, server, lastSeen: Date.now() };
        transport.onclose = () => {
          const initialized = transport.sessionId;
          if (initialized) {
            lease.release(initialized);
            sessions.delete(initialized);
          }
        };
        await server.connect(transport);
      }
      if (!entry) {
        jsonError(res, sid ? 404 : 400, sid ? "Unknown MCP session" : "Initialize first");
        return;
      }
      await entry.transport.handleRequest(req, res, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = error instanceof HttpRequestError ? error.status : 500;
      if (status >= 500) console.error(`[browser-gateway] request error: ${message}`);
      jsonError(res, status, status >= 500 ? "Internal browser gateway error" : message);
    }
  });

  let safeTools: UpstreamTool[] = [];
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    if (heartbeat) clearInterval(heartbeat);
    if (maintenance) clearInterval(maintenance);
    try { unlinkSync(READY_FILE); } catch { /* absent */ }
    if (SOCKET) {
      try { unlinkSync(SOCKET); } catch { /* absent */ }
    }
    await closeHttp(http);
    await Promise.allSettled([...sessions.values()].map(async ({ server }) => server.close()));
    sessions.clear();
    await upstream.close().catch(() => undefined);
  };
  const fatal = (error: unknown): void => {
    if (stopping) return;
    exitCode = 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[browser-gateway] fatal: ${message}`);
    void shutdown().finally(() => { process.exitCode = exitCode; });
  };
  upstream.onerror = fatal;
  upstream.onclose = () => fatal(new Error("private Playwright MCP process closed unexpectedly"));

  const probeBrowser = async (): Promise<void> => {
    const result = await queue.run(async () => upstream.callTool(
      { name: "browser_tabs", arguments: { action: "list" } }, CallToolResultSchema,
      { timeout: 15_000, maxTotalTimeout: 15_000 },
    ));
    const error = browserToolResultError(result);
    if (error) throw new Error(`browser_tabs heartbeat failed: ${error}`);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    console.log(`[browser-gateway] stopping on ${signal}`);
    void shutdown().finally(() => { process.exitCode = exitCode; });
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));

  try {
    purgeStagedBrowserUploads(PRIVATE_STAGE_DIR, 0);
    await upstream.connect(upstreamTransport, { timeout: 60_000 });
    const listed = await upstream.listTools(undefined, { timeout: 30_000 });
    safeTools = [
      ...safeBrowserToolContracts(listed.tools),
      ...SAFE_GATEWAY_BROWSER_TOOLS,
    ] as UpstreamTool[];
    if (!listed.tools.some((tool) => tool.name === "browser_run_code_unsafe")) {
      throw new Error("pinned upstream changed: expected unsafe tool was not present for gateway filtering");
    }
    if (!safeTools.some((tool) => tool.name === "browser_tabs")) {
      throw new Error("private Playwright MCP did not expose browser_tabs");
    }
    if (safeTools.some((tool) => tool.name === "browser_evaluate")) {
      throw new Error("unsafe arbitrary browser evaluator escaped gateway filtering");
    }
    await probeBrowser();
    await listen(http);

    heartbeat = setInterval(() => {
      if (stopping || heartbeatRunning || lease.isHeld()) return;
      heartbeatRunning = true;
      void probeBrowser()
        .catch(fatal)
        .finally(() => { heartbeatRunning = false; });
    }, HEARTBEAT_MS);
    heartbeat.unref();

    maintenance = setInterval(() => {
      const cutoff = Date.now() - SESSION_IDLE_MS;
      for (const [sid, entry] of sessions) {
        if (entry.lastSeen >= cutoff) continue;
        lease.release(sid);
        sessions.delete(sid);
        void entry.server.close().catch(() => undefined);
      }
    }, Math.min(60_000, Math.floor(SESSION_IDLE_MS / 2)));
    maintenance.unref();

    writeFileSync(READY_FILE, `${new Date().toISOString()} tools=${safeTools.length}\n`, { mode: 0o640 });
    console.log(`[browser-gateway] ready ${SOCKET || `http://${HOST}:${PORT}/mcp`} tools=${safeTools.length} pid=${upstreamTransport.pid ?? "unknown"}`);
  } catch (error) {
    fatal(error);
  }
}

void main();
