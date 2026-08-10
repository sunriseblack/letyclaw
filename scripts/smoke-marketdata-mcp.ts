#!/usr/bin/env node
/**
 * Protocol-level, read-only smoke for the pinned Alpha Vantage MCP server.
 *
 * It initializes stdio and lists the three progressive-discovery meta-tools.
 * It uses a non-secret dummy key and never calls a market-data tool or API.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { marketdataChildEnv } from "./marketdata-mcp-proxy.js";

const SMOKE_DUMMY_KEY = "letyclaw_marketdata_smoke_dummy";
const MAX_STDERR_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 8 * 1024;
const REQUIRED_META_TOOLS = ["TOOL_CALL", "TOOL_GET", "TOOL_LIST"] as const;

export interface MarketdataSmokeResult {
  serverName: string;
  serverVersion: string;
  toolNames: string[];
}

export interface MarketdataSmokeOptions {
  env?: NodeJS.ProcessEnv;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

function stringEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

export async function runMarketdataSmoke(options: MarketdataSmokeOptions = {}): Promise<MarketdataSmokeResult> {
  const proxyPath = fileURLToPath(new URL("./marketdata-mcp-proxy.js", import.meta.url));
  const sourceEnv = options.env || process.env;
  // Override any live credential before spawning the proxy. This smoke proves
  // package/protocol compatibility without reading or forwarding production
  // secrets and without making an Alpha Vantage request.
  const env = stringEnvironment(marketdataChildEnv(sourceEnv, SMOKE_DUMMY_KEY));
  const transport = new StdioClientTransport({
    command: options.command || process.execPath,
    args: options.args || [proxyPath],
    env,
    stderr: "pipe",
  });
  let stderrBytes = 0;
  let stderrExceeded = false;
  let stderrTail = Buffer.alloc(0);
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stderrBytes += buffer.length;
    if (stderrBytes > MAX_STDERR_BYTES) stderrExceeded = true;
    stderrTail = Buffer.concat([stderrTail, buffer]).subarray(-STDERR_TAIL_BYTES);
  });

  const client = new Client({ name: "letyclaw-marketdata-smoke", version: "1.0" }, { capabilities: {} });
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    await client.connect(transport, {
      signal: controller.signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    });
    const response = await client.listTools(undefined, {
      signal: controller.signal,
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs,
    });
    if (stderrExceeded) throw new Error("upstream exceeded the smoke stderr limit");

    const toolNames = response.tools.map((tool) => tool.name).sort();
    if (JSON.stringify(toolNames) !== JSON.stringify(REQUIRED_META_TOOLS)) {
      throw new Error(`upstream returned an unexpected meta-tool set (${toolNames.length})`);
    }
    const server = client.getServerVersion();
    if (!server?.name || !server.version) throw new Error("upstream omitted server identity");
    return { serverName: server.name, serverVersion: server.version, toolNames };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown protocol failure";
    const tail = stderrTail.toString("utf8")
      .split(SMOKE_DUMMY_KEY).join("[redacted]")
      .replace(/[^\t\n\r\x20-\x7E]/g, "?")
      .trim();
    throw new Error(tail ? `${message}; stderr tail: ${tail}` : message);
  } finally {
    clearTimeout(timeout);
    await client.close().catch(async () => { await transport.close().catch(() => undefined); });
  }
}

async function main(): Promise<void> {
  try {
    const result = await runMarketdataSmoke();
    console.log(`[marketdata-mcp] smoke ok tools=${result.toolNames.length} server=${result.serverName}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown smoke failure";
    console.error(`[marketdata-mcp] smoke failed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main();
}
