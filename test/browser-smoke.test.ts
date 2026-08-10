import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_BROWSER_TOOLS,
  assertRequiredBrowserTools,
  assertScreenshotFilename,
  assertToolSucceeded,
  artifactPathForTool,
  extractJsonResult,
  parseBrowserSmokeState,
  parseBrowserTabs,
} from "../scripts/browser-smoke-core.js";

describe("browser smoke response validation", () => {
  it("requires the full general-purpose Playwright tool surface", () => {
    expect(() => assertRequiredBrowserTools(REQUIRED_BROWSER_TOOLS)).not.toThrow();
    expect(() => assertRequiredBrowserTools(["browser_navigate", "browser_snapshot"]))
      .toThrow(/browser_fill_form/);
    expect(() => assertRequiredBrowserTools([...REQUIRED_BROWSER_TOOLS, "browser_run_code_unsafe"]))
      .toThrow(/forbidden/);
    expect(() => assertRequiredBrowserTools([...REQUIRED_BROWSER_TOOLS, "browser_evaluate"]))
      .toThrow(/forbidden/);
  });

  it("fails closed on MCP and Playwright-formatted tool errors", () => {
    expect(() => assertToolSucceeded("browser_navigate", {
      isError: true,
      content: [{ type: "text", text: "profile is locked" }],
    })).toThrow(/profile is locked/);
    expect(() => assertToolSucceeded("browser_navigate", {
      content: [{ type: "text", text: "### Error\nError: Browser is already in use" }],
    })).toThrow(/Browser is already in use/);
  });

  it("extracts only the structured Result section, not echoed Playwright code", () => {
    const response = [
      "### Result",
      '{"marker":"observed","title":"Example Domain","timezone":"UTC","url":"https://example.com/","userAgent":"Chrome/151"}',
      "### Ran Playwright code",
      "```js",
      "return { marker: 'requested-but-not-observed' };",
      "```",
    ].join("\n");
    expect(extractJsonResult(response)).toEqual({
      marker: "observed",
      title: "Example Domain",
      timezone: "UTC",
      url: "https://example.com/",
      userAgent: "Chrome/151",
    });
    expect(parseBrowserSmokeState(response).marker).toBe("observed");
    expect(parseBrowserSmokeState([
      "### Result",
      '{"title":"Example Domain","timezone":"UTC","url":"https://example.com/","userAgent":"Chrome/151"}',
    ].join("\n")).marker).toBeNull();
  });

  it("parses tab indexes, current state, and URLs", () => {
    const tabs = parseBrowserTabs([
      "### Result",
      "- 0: [Existing](about:blank)",
      "- 1: (current) [Example Domain](https://example.com/)",
    ].join("\n"));
    expect(tabs).toEqual([
      { index: 0, current: false, url: "about:blank" },
      { index: 1, current: true, url: "https://example.com/" },
    ]);
  });

  it("allows only a screenshot basename with an image extension", () => {
    expect(() => assertScreenshotFilename("letyclaw-browser-smoke.png")).not.toThrow();
    expect(() => assertScreenshotFilename("../cookies.png")).toThrow(/without a path/);
    expect(() => assertScreenshotFilename("artifact.txt")).toThrow(/png/);
  });

  it("uses the same workspace-relative artifact path as a real Claude client", () => {
    expect(artifactPathForTool(
      "/root/vault",
      "/root/vault/browser-artifacts",
      "letyclaw-browser-smoke.png",
    )).toBe("browser-artifacts/letyclaw-browser-smoke.png");
    expect(() => artifactPathForTool("/root/vault/personal", "/root/vault/browser-artifacts", "x.png"))
      .toThrow(/inside/);
  });
});

describe("Playwright MCP production invariants", () => {
  it("exposes the isolated safe gateway only on loopback", () => {
    const unit = readFileSync(resolve("systemd/playwright-mcp.service"), "utf8");
    expect(unit).toContain("User=letyclaw-browser");
    expect(unit).toContain("StateDirectory=letyclaw-browser");
    expect(unit).toContain("Environment=PLAYWRIGHT_PROFILE_DIR=/var/lib/letyclaw-browser/profile");
    expect(unit).toContain("Environment=PLAYWRIGHT_OUTPUT_DIR=/root/vault/browser-artifacts");
    expect(unit).toContain("Environment=TZ=UTC");
    expect(unit).toContain("/var/lib/letyclaw-browser-gateway/current/services/browser-gateway.js");
  });

  it("runs the real two-client smoke check during MCP deployment", () => {
    const setup = readFileSync(resolve("scripts/setup-mcp.sh"), "utf8");
    expect(setup).toContain('PLAYWRIGHT_MCP_URL="http://localhost:${PLAYWRIGHT_PORT}/mcp"');
    expect(setup).toContain('PLAYWRIGHT_MCP_ARTIFACT_DIR="$BROWSER_ARTIFACT_DIR"');
    expect(setup).toContain('PLAYWRIGHT_MCP_WORKSPACE_ROOT="$VAULT_PATH"');
    expect(setup).toContain('NODE_BIN=/usr/bin/node');
    expect(setup).toContain('"$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/browser-smoke.js"');
  });

  it("keeps installer, gateway, and deploy smoke on one pinned runtime", () => {
    const gateway = readFileSync(resolve("services/browser-gateway.ts"), "utf8");
    const setupBrowser = readFileSync(resolve("scripts/setup-browser.sh"), "utf8");
    const setupMcp = readFileSync(resolve("scripts/setup-mcp.sh"), "utf8");
    const botUnit = readFileSync(resolve("systemd/letyclaw-bot.service"), "utf8");

    expect(gateway).toContain("/var/lib/letyclaw-browser-runtime/mcp-0.0.78/mcp/node_modules/@playwright/mcp/cli.js");
    expect(setupBrowser).toContain('PLAYWRIGHT_MCP_VERSION="0.0.78"');
    expect(setupBrowser).not.toContain("PLAYWRIGHT_MCP_VERSION:-");
    expect(setupBrowser).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(setupBrowser).toContain('"@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}"');
    expect(setupMcp.indexOf("systemctl restart playwright-mcp"))
      .toBeLessThan(setupMcp.indexOf("dist/scripts/browser-smoke.js"));
    expect(botUnit).not.toContain("/root/vault/browser-profiles");
  });
});
