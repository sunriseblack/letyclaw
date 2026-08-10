import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import {
  authorizedBearer,
  BrowserSessionLease,
  browserToolResultError,
  buildPlaywrightArgs,
  ExclusiveBrowserQueue,
  isUnsafeBrowserTool,
  playwrightChildEnvironment,
  safeBrowserToolContracts,
  safeBrowserTools,
} from "../services/browser-gateway-core.js";

describe("safe persistent browser gateway", () => {
  it("passes Xvfb authentication without leaking unrelated service secrets", () => {
    expect(playwrightChildEnvironment({
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-run/auth",
      PLAYWRIGHT_GATEWAY_TOKEN: "must-not-reach-upstream",
    })).toEqual({
      DISPLAY: ":99",
      XAUTHORITY: "/tmp/xvfb-run/auth",
    });
  });

  it("filters the upstream RCE tools at the server boundary", () => {
    const tools = safeBrowserTools([
      { name: "browser_tabs" },
      { name: "browser_evaluate" },
      { name: "browser_run_code" },
      { name: "browser_run_code_unsafe" },
      { name: "browser_network_request" },
      { name: "browser_network_requests" },
      { name: "browser_navigate" },
    ]);
    expect(tools.map((tool) => tool.name)).toEqual(["browser_tabs", "browser_navigate"]);
    expect(isUnsafeBrowserTool("browser_run_code_unsafe")).toBe(true);
    expect(isUnsafeBrowserTool("browser_evaluate")).toBe(true);
  });

  it("advertises the gateway file contract instead of upstream absolute paths", () => {
    const [upload] = safeBrowserToolContracts([{
      name: "browser_file_upload",
      inputSchema: {
        type: "object",
        properties: { paths: { type: "array", items: { type: "string" } } },
      },
    }]);
    const properties = upload?.inputSchema?.properties as Record<string, Record<string, unknown>>;
    expect(properties.paths?.description).toContain("browser-uploads/<filename>");
    expect((properties.paths?.items as Record<string, unknown>).pattern).toContain("browser-uploads");
  });

  it("requires a constant-time bearer and leases one shared context to one session", async () => {
    const token = "a".repeat(64);
    expect(authorizedBearer(token, `Bearer ${token}`)).toBe(true);
    expect(authorizedBearer(token, `Bearer ${"b".repeat(64)}`)).toBe(false);
    const lease = new BrowserSessionLease(1000);
    expect(lease.acquire("session-a", 0)).toBe(true);
    expect(lease.acquire("session-b", 500)).toBe(false);
    expect(lease.acquire("session-b", 1000)).toBe(false); // in-flight A never expires
    lease.complete("session-a", 1000);
    expect(lease.acquire("session-b", 1999)).toBe(false);
    expect(lease.acquire("session-b", 2000)).toBe(true);
    const releasing = new BrowserSessionLease(1000);
    expect(releasing.acquire("session-a", 0)).toBe(true);
    releasing.release("session-a");
    expect(releasing.acquire("session-b", 500)).toBe(false);
    releasing.complete("session-a", 500);
    expect(releasing.acquire("session-b", 500)).toBe(true);

    const staleClient = new BrowserSessionLease(10);
    expect(staleClient.acquire("exited-cli")).toBe(true);
    staleClient.complete("exited-cli");
    expect(await staleClient.acquireWithin("next-cli", 250)).toBe(true);
    staleClient.complete("next-cli");

    const queue = new ExclusiveBrowserQueue();
    const order: number[] = [];
    let release!: () => void;
    const first = queue.run(async () => {
      order.push(1);
      await new Promise<void>((resolve) => { release = resolve; });
      order.push(2);
    });
    const second = queue.run(async () => { order.push(3); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([1]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("pins Chromium and explicitly enables its process sandbox", () => {
    const args = buildPlaywrightArgs({
      cliPath: "/cache/@playwright/mcp/cli.js",
      profileDir: "/state/profile",
      secretsFile: "/state/secrets.env",
      outputDir: "/vault/browser-artifacts",
    });
    expect(args).toContain("--browser");
    expect(args[args.indexOf("--browser") + 1]).toBe("chromium");
    expect(args).toContain("--sandbox");
    expect(args).toContain("--headless");
    expect(args).not.toContain("--no-sandbox");
    expect(args).not.toContain("--port");
    expect(args).not.toContain("--shared-browser-context");
    expect(args[args.indexOf("--output-max-size") + 1]).toBe("1073741824");
    expect(args[args.indexOf("--blocked-origins") + 1]).toContain("127.*");
    expect(buildPlaywrightArgs({
      cliPath: "/cli.js",
      profileDir: "/profile",
      secretsFile: "/secrets.env",
      outputDir: "/artifacts",
      headless: false,
    })).not.toContain("--headless");
  });

  it("treats both MCP and Playwright-formatted errors as heartbeat failures", () => {
    expect(browserToolResultError({ isError: true, content: [{ type: "text", text: "browser closed" }] }))
      .toContain("browser closed");
    expect(browserToolResultError({ content: [{ type: "text", text: "### Error\ncontext lost" }] }))
      .toContain("context lost");
    expect(browserToolResultError({ content: [{ type: "text", text: "### Result\n- 0: about:blank" }] }))
      .toBeNull();
  });

  it("ships an isolated systemd identity and private stdio child", () => {
    const unit = readFileSync(new URL("../systemd/playwright-mcp.service", import.meta.url), "utf8");
    const proxyUnit = readFileSync(new URL("../systemd/playwright-mcp-proxy.service", import.meta.url), "utf8");
    const proxySocket = readFileSync(new URL("../systemd/playwright-mcp-proxy.socket", import.meta.url), "utf8");
    expect(unit).toContain("User=letyclaw-browser");
    expect(unit).not.toContain("User=letyclaw\n");
    expect(unit).toContain("StateDirectory=letyclaw-browser");
    expect(unit).toContain("CacheDirectory=letyclaw-browser");
    expect(unit).toContain("/var/lib/letyclaw-browser-gateway/current/services/browser-gateway.js");
    expect(unit).toContain("ExecStart=/usr/bin/xvfb-run");
    expect(unit).toContain("ExecStartPost=/usr/bin/timeout 90");
    expect(unit).toContain("ExecStartPre=+/usr/bin/install -d -o letyclaw-browser -g letyclaw -m 2750 /run/letyclaw-browser");
    expect(unit).toContain("ExecStartPre=+/usr/bin/install -d -o letyclaw-browser -g letyclaw-browser-proxy -m 2750 /run/letyclaw-browser-socket");
    expect(unit).not.toContain("RuntimeDirectory=letyclaw-browser");
    expect(unit).toContain("Environment=PLAYWRIGHT_HEADLESS=0");
    expect(unit).toContain("Environment=PLAYWRIGHT_LEASE_IDLE_MS=30000");
    expect(unit).toContain("Environment=PLAYWRIGHT_STAGED_UPLOAD_RETENTION_MS=900000");
    expect(unit).toContain("BindReadOnlyPaths=/root/vault/browser-uploads");
    expect(unit).toContain("BindPaths=/root/vault/browser-artifacts");
    expect(unit).not.toContain("@playwright/mcp@0.0.78 --port");
    expect(unit).toContain("EnvironmentFile=/etc/letyclaw-browser/gateway.env");
    expect(unit).not.toContain("SupplementaryGroups=letyclaw");
    expect(unit).toContain("IPAddressDeny=169.254.0.0/16");
    expect(unit).toContain("IPAddressDeny=192.168.0.0/16");
    expect(unit).toContain("Environment=PLAYWRIGHT_GATEWAY_SOCKET=/run/letyclaw-browser-socket/gateway.sock");
    expect(unit).toContain("IPAddressDeny=localhost");
    expect(unit).toContain("IPAddressAllow=127.0.0.53/32");
    expect(unit).toContain("Environment=PLAYWRIGHT_REQUIRE_LOOPBACK_DENY=1");
    expect(proxyUnit).toContain("User=letyclaw-browser-proxy");
    expect(proxyUnit).toContain("/lib/systemd/systemd-socket-proxyd");
    expect(proxyUnit).toContain("PrivateNetwork=true");
    expect(proxyUnit).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(proxySocket).toContain("ListenStream=127.0.0.1:3100");
    expect(proxySocket).toContain("IPAddressDeny=any");
    expect(proxySocket).toContain("IPAddressAllow=127.0.0.1/32");
  });

  it("prepares packages before stopping service and retains rollback units", () => {
    const setup = readFileSync(new URL("../scripts/setup-mcp.sh", import.meta.url), "utf8");
    const browserSetup = readFileSync(new URL("../scripts/setup-browser.sh", import.meta.url), "utf8");
    expect(setup.indexOf("BROWSER_PREPARE_ONLY=1"))
      .toBeLessThan(setup.indexOf("systemctl stop playwright-mcp"));
    expect(setup).toContain("rollback_browser_deploy");
    expect(setup).toContain("GATEWAY_CONTENT_HASH");
    expect(setup).toContain("browser-safe-dom");
    expect(setup).toContain("playwright-mcp-proxy.service");
    expect(setup).toContain("playwright-mcp-proxy.socket");
    expect(setup).toContain("--transport http playwright");
    expect(setup.indexOf("--transport http playwright"))
      .toBeLessThan(setup.indexOf('--header "Authorization: Bearer ${PLAYWRIGHT_GATEWAY_TOKEN}"'));
    expect(setup).toContain("systemd-analyze verify");
    expect(setup).toContain("package-lock.json");
    expect(setup).toContain("npm ci");
    expect(setup).toContain("OLD_GATEWAY_TARGET");
    expect(setup).toContain('sudo -u letyclaw test -r "${BROWSER_ARTIFACT_DIR}/letyclaw-browser-smoke-example.png"');
    expect(browserSetup).toContain("source retained for rollback");
    expect(browserSetup).toContain("/var/lib/letyclaw-browser-runtime/mcp-");
    expect(browserSetup).toContain("chown -hR root:root");
    expect(browserSetup).toContain("runtime symlink escapes its immutable release");
    expect(browserSetup).toContain('chmod 2750 "$BROWSER_ARTIFACT_DIR"');
    expect(browserSetup).toContain('chmod 2750 "$BROWSER_UPLOAD_DIR"');
    expect(browserSetup).not.toContain('run_as_browser_user chmod 2750 "$BROWSER_ARTIFACT_DIR"');
    expect(browserSetup).not.toContain('sudo -u letyclaw chmod 2750 "$BROWSER_UPLOAD_DIR"');
    const deploy = readFileSync(new URL("../scripts/deploy-agents.sh", import.meta.url), "utf8");
    expect(deploy).not.toContain("for unit in letyclaw-bot health-webhook playwright-mcp");
    expect(browserSetup).toContain("chmod 2750");
  });
});
