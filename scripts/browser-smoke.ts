#!/usr/bin/env node
/**
 * End-to-end Playwright MCP smoke check.
 *
 * Unlike the deploy-time MCP initialize probe, this opens a real page and then
 * reconnects as a second HTTP client. The second connection must see the first
 * client's live tab and page, proving that the persistent HTTP service is using
 * a shared browser context rather than trying to relaunch a locked
 * user-data directory for every Claude CLI invocation.
 */
import { existsSync, lstatSync, unlinkSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { pathToFileURL } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  assertRequiredBrowserTools,
  assertScreenshotFilename,
  assertToolSucceeded,
  artifactPathForTool,
  extractJsonResult,
  parseBrowserSmokeState,
  parseBrowserTabs,
} from "./browser-smoke-core.js";

const ENDPOINT = process.env.PLAYWRIGHT_MCP_URL || "http://localhost:3100/mcp";
const ARTIFACT_DIR = process.env.PLAYWRIGHT_MCP_ARTIFACT_DIR || "/root/vault/browser-artifacts";
const WORKSPACE_ROOT = process.env.PLAYWRIGHT_MCP_WORKSPACE_ROOT || dirname(ARTIFACT_DIR);
const TARGET_URL = process.env.PLAYWRIGHT_MCP_SMOKE_URL || "https://example.com";
const SCREENSHOT = process.env.PLAYWRIGHT_MCP_SMOKE_SCREENSHOT || "letyclaw-browser-smoke-example.png";
const PDF = process.env.PLAYWRIGHT_MCP_SMOKE_PDF || "letyclaw-browser-smoke-example.pdf";
const EXPECTED_TIMEZONE = process.env.PLAYWRIGHT_MCP_TIMEZONE || process.env.TZ || "UTC";
const EXPECT_HEADFUL = process.env.PLAYWRIGHT_MCP_EXPECT_HEADFUL === "1";
const TIMEOUT_MS = Number(process.env.PLAYWRIGHT_MCP_SMOKE_TIMEOUT_MS || "30000");
const GATEWAY_TOKEN = process.env.PLAYWRIGHT_GATEWAY_TOKEN || "";

type ToolArguments = Record<string, unknown>;

interface ConnectedClient {
  client: Client;
  transport: StreamableHTTPClientTransport;
}

function validatedEndpoint(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PLAYWRIGHT_MCP_URL must use http or https, got ${url.protocol}`);
  }
  return url;
}

function validatedTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 120_000) {
    throw new Error("PLAYWRIGHT_MCP_SMOKE_TIMEOUT_MS must be an integer from 1000 to 120000");
  }
  return value;
}

function validateArtifactDirectory(directory: string): void {
  if (!isAbsolute(directory)) {
    throw new Error("PLAYWRIGHT_MCP_ARTIFACT_DIR must be an absolute path");
  }
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`browser artifact directory is not a regular directory: ${directory}`);
  }
}

function verifyArtifact(directory: string, filename: string): string {
  validateArtifactDirectory(directory);
  const artifact = join(directory, filename);
  const artifactStat = lstatSync(artifact);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink() || artifactStat.size === 0) {
    throw new Error(`browser screenshot artifact is missing or empty: ${artifact}`);
  }
  return artifact;
}

function assertPdfFilename(filename: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.pdf$/.test(filename)) {
    throw new Error("Browser smoke PDF must be a safe .pdf filename without a path");
  }
}

async function connectClient(
  endpoint: URL,
  label: string,
  timeoutMs: number,
  workspaceRoot: string,
): Promise<ConnectedClient> {
  const client = new Client(
    { name: `letyclaw-browser-smoke-${label}`, version: "1.0.0" },
    { capabilities: { roots: { listChanged: false } } },
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(workspaceRoot).href, name: "browser-workspace" }],
  }));
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${GATEWAY_TOKEN}` } },
  });
  await client.connect(transport, { timeout: timeoutMs });
  return { client, transport };
}

async function disconnectClient(connection: ConnectedClient): Promise<void> {
  try {
    // Client.close() only aborts local requests. DELETE the server-side MCP
    // session explicitly so this smoke reproduces a real Claude turn ending.
    await connection.transport.terminateSession();
  } finally {
    await connection.client.close();
  }
}

async function callTool(
  client: Client,
  name: string,
  args: ToolArguments,
  timeoutMs: number,
): Promise<string> {
  const result = await client.callTool(
    { name, arguments: args },
    CallToolResultSchema,
    { timeout: timeoutMs, maxTotalTimeout: timeoutMs },
  );
  return assertToolSucceeded(name, result);
}

async function main(): Promise<void> {
  const endpoint = validatedEndpoint(ENDPOINT);
  const timeoutMs = validatedTimeout(TIMEOUT_MS);
  if (GATEWAY_TOKEN.length < 32) throw new Error("PLAYWRIGHT_GATEWAY_TOKEN is required for browser smoke");
  assertScreenshotFilename(SCREENSHOT);
  assertPdfFilename(PDF);
  validateArtifactDirectory(ARTIFACT_DIR);
  if (!isAbsolute(WORKSPACE_ROOT)) throw new Error("PLAYWRIGHT_MCP_WORKSPACE_ROOT must be absolute");
  const screenshotToolPath = artifactPathForTool(WORKSPACE_ROOT, ARTIFACT_DIR, SCREENSHOT);
  const artifactPrefix = screenshotToolPath.slice(0, -SCREENSHOT.length);
  const pdfToolPath = `${artifactPrefix}${PDF}`;
  const screenshotAbsolutePath = join(ARTIFACT_DIR, SCREENSHOT);
  const pdfAbsolutePath = join(ARTIFACT_DIR, PDF);
  if (existsSync(screenshotAbsolutePath)) unlinkSync(screenshotAbsolutePath);
  if (existsSync(pdfAbsolutePath)) unlinkSync(pdfAbsolutePath);
  const targetOrigin = new URL(TARGET_URL).origin;

  let smokeTabIndex: number | null = null;
  let expectedTitle = "";
  const firstConnection = await connectClient(endpoint, "first", timeoutMs, WORKSPACE_ROOT);
  const first = firstConnection.client;
  try {
    const { tools } = await first.listTools(undefined, { timeout: timeoutMs });
    assertRequiredBrowserTools(tools.map((tool) => tool.name));

    await callTool(first, "browser_tabs", { action: "new" }, timeoutMs);
    await callTool(first, "browser_navigate", { url: TARGET_URL }, timeoutMs);
    const initializedText = await callTool(first, "browser_page_info", {}, timeoutMs);
    const initialized = parseBrowserSmokeState(initializedText);
    if (new URL(initialized.url).origin !== targetOrigin) {
      throw new Error(`initial browser state did not match ${TARGET_URL}`);
    }
    expectedTitle = initialized.title;

    const domText = await callTool(first, "browser_dom_query", {
      selector: "h1",
      limit: 1,
      fields: [{ name: "text", source: "text" }],
    }, timeoutMs);
    const domRows = extractJsonResult(domText);
    if (!Array.isArray(domRows) || typeof (domRows[0] as { text?: unknown } | undefined)?.text !== "string") {
      throw new Error("browser_dom_query did not return the example heading");
    }

    const screenshotText = await callTool(first, "browser_take_screenshot", {
      filename: screenshotToolPath,
      fullPage: true,
      scale: "css",
      type: "png",
    }, timeoutMs);
    if (!screenshotText.includes(screenshotToolPath)) {
      throw new Error(`browser_take_screenshot did not report the named artifact ${screenshotToolPath}`);
    }
    verifyArtifact(ARTIFACT_DIR, SCREENSHOT);

    await callTool(first, "browser_mouse_move_xy", { x: 100, y: 100 }, timeoutMs);
    const pdfText = await callTool(first, "browser_pdf_save", { filename: pdfToolPath }, timeoutMs);
    if (!pdfText.includes(pdfToolPath)) {
      throw new Error(`browser_pdf_save did not report the named artifact ${pdfToolPath}`);
    }
    verifyArtifact(ARTIFACT_DIR, PDF);

    const tabsText = await callTool(first, "browser_tabs", { action: "list" }, timeoutMs);
    const current = parseBrowserTabs(tabsText).find((tab) => tab.current);
    if (!current || new URL(current.url).origin !== targetOrigin) {
      throw new Error("smoke tab was not the active tab after navigation");
    }
    smokeTabIndex = current.index;
  } finally {
    await disconnectClient(firstConnection);
  }

  // This is intentionally a new MCP session. The gateway must retain its one
  // private upstream browser/context after the first HTTP client disconnects.
  const secondConnection = await connectClient(endpoint, "second", timeoutMs, WORKSPACE_ROOT);
  const second = secondConnection.client;
  try {
    const tabsText = await callTool(second, "browser_tabs", { action: "list" }, timeoutMs);
    const tabs = parseBrowserTabs(tabsText);
    const sharedTab = tabs.find((tab) => tab.index === smokeTabIndex);
    if (!sharedTab || new URL(sharedTab.url).origin !== targetOrigin) {
      throw new Error("second MCP client could not see the first client's live browser tab");
    }
    if (!sharedTab.current) {
      await callTool(second, "browser_tabs", { action: "select", index: sharedTab.index }, timeoutMs);
    }

    const observedText = await callTool(second, "browser_page_info", {}, timeoutMs);
    const observed = parseBrowserSmokeState(observedText);
    if (new URL(observed.url).origin !== targetOrigin || observed.title !== expectedTitle) {
      throw new Error(`unexpected page after reconnect: ${observed.title} (${observed.url})`);
    }
    if (observed.timezone !== EXPECTED_TIMEZONE) {
      throw new Error(`unexpected browser timezone: ${observed.timezone} (expected ${EXPECTED_TIMEZONE})`);
    }
    if (EXPECT_HEADFUL && /HeadlessChrome/i.test(observed.userAgent)) {
      throw new Error(`browser still exposes a headless user agent: ${observed.userAgent}`);
    }

    // Close only the tab created by this smoke run; preserve any user tabs.
    await callTool(second, "browser_tabs", { action: "close", index: sharedTab.index }, timeoutMs);
    console.log(JSON.stringify({
      status: "ok",
      endpoint: endpoint.toString(),
      target: observed.url,
      title: observed.title,
      screenshot: join(ARTIFACT_DIR, SCREENSHOT),
      pdf: join(ARTIFACT_DIR, PDF),
      coordinates: true,
      timezone: observed.timezone,
      sharedContext: true,
      headfulUserAgent: !/HeadlessChrome/i.test(observed.userAgent),
    }));
  } finally {
    await disconnectClient(secondConnection);
  }
}

main().catch((error) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[browser-smoke] FAIL: ${detail}`);
  process.exit(1);
});
