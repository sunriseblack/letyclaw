import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { PassThrough, Readable } from "stream";
import {
  MARKETDATA_MCP_SDK,
  parseAlphaVantageKeyFromEnvFile,
  resolveMarketdataApiKey,
  runMarketdataProxy,
  SecretRedactor,
} from "../scripts/marketdata-mcp-proxy.js";
import { runMarketdataSmoke } from "../scripts/smoke-marketdata-mcp.js";

const fixtures: string[] = [];
const SMOKE_TEST_TIMEOUT_MS = 5_000;

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function collect(stream: Readable): { text: () => string } {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  return { text: () => Buffer.concat(chunks).toString("utf8") };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test process state");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

describe("marketdata MCP proxy", () => {
  it("passes the key only through child env and redacts both output streams", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "letyclaw-marketdata-proxy-"));
    fixtures.push(fixture);
    const fakeUvx = join(fixture, "uvx");
    const argsFile = join(fixture, "args");
    const secret = "alpha_test_key_1234";
    writeFileSync(fakeUvx, [
      "#!/bin/bash",
      "set -eu",
      "capture_dir=$(dirname \"$0\")",
      "printf '%s\\n' \"$@\" > \"$capture_dir/args\"",
      "printf '%s' \"${TELEGRAM_BOT_TOKEN:-absent}\" > \"$capture_dir/telegram-env\"",
      "printf 'result https://example.test/?apikey=%s\\n' \"$ALPHA_VANTAGE_API_KEY\"",
      "printf 'failure https://example.test/?apikey=%s\\n' \"$ALPHA_VANTAGE_API_KEY\" >&2",
    ].join("\n"));
    chmodSync(fakeUvx, 0o755);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = collect(stdout);
    const err = collect(stderr);

    const code = await runMarketdataProxy({
      command: fakeUvx,
      input: Readable.from([]),
      stdout,
      stderr,
      forwardSignals: false,
      env: {
        PATH: process.env.PATH || "",
        HOME: fixture,
        ALPHA_VANTAGE_API_KEY: secret,
        TELEGRAM_BOT_TOKEN: "must_not_reach_marketdata",
      },
    });

    expect(code).toBe(0);
    expect(readFileSync(argsFile, "utf8")).toBe(
      `--no-config\n--no-env-file\n--from\nmarketdata-mcp-server==0.3.1\n--with\n${MARKETDATA_MCP_SDK}\nmarketdata-mcp\n`,
    );
    expect(readFileSync(argsFile, "utf8")).not.toContain(secret);
    expect(readFileSync(join(fixture, "telegram-env"), "utf8")).toBe("absent");
    expect(out.text()).toContain(`apikey=${"*".repeat(secret.length)}`);
    expect(err.text()).toContain(`apikey=${"*".repeat(secret.length)}`);
    expect(`${out.text()}${err.text()}`).not.toContain(secret);
  });

  it("redacts a secret split across stream chunks", async () => {
    const secret = "split_secret_123";
    const redactor = new SecretRedactor(secret);
    const output = collect(redactor);
    redactor.write(`before ${secret.slice(0, 5)}`);
    redactor.write(`${secret.slice(5)} after`);
    redactor.end();
    await new Promise<void>((resolvePromise) => redactor.once("end", resolvePromise));
    expect(output.text()).toBe(`before ${"*".repeat(secret.length)} after`);
  });

  it("flushes a complete MCP response immediately on a long-lived stream", () => {
    const secret = "alpha_test_key_1234";
    const redactor = new SecretRedactor(secret);
    const output = collect(redactor);
    const response = '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n';
    redactor.write(response);
    expect(output.text()).toBe(response);
    redactor.destroy();
  });

  it("handles an early upstream exit while MCP input is still arriving", async () => {
    const input = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const result = runMarketdataProxy({
      command: "/usr/bin/false",
      input,
      stdout,
      stderr,
      forwardSignals: false,
      env: {
        PATH: process.env.PATH || "",
        HOME: tmpdir(),
        ALPHA_VANTAGE_API_KEY: "early_exit_key_1234",
      },
    });
    input.write(Buffer.alloc(64 * 1024, "x"));
    expect(await result).toBe(1);
    expect(input.listenerCount("error")).toBe(0);
  });

  it.skipIf(process.platform === "win32")("signals the whole uvx process group", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "letyclaw-marketdata-process-group-"));
    fixtures.push(fixture);
    const fakeUvx = join(fixture, "uvx");
    writeFileSync(fakeUvx, [
      "#!/bin/bash",
      "set -u",
      "capture_dir=$(dirname \"$0\")",
      "sleep 60 &",
      "child=$!",
      "printf '%s' \"$$\" > \"$capture_dir/parent-pid\"",
      "printf '%s' \"$child\" > \"$capture_dir/child-pid\"",
      "wait \"$child\"",
    ].join("\n"));
    chmodSync(fakeUvx, 0o755);
    const priorHandlers = new Set(process.listeners("SIGTERM"));
    const result = runMarketdataProxy({
      command: fakeUvx,
      input: Readable.from([]),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      env: {
        PATH: process.env.PATH || "",
        HOME: fixture,
        ALPHA_VANTAGE_API_KEY: "process_group_key_1234",
      },
    });
    await waitUntil(() => existsSync(join(fixture, "child-pid")));
    const signalHandler = process.listeners("SIGTERM").find((handler) => !priorHandlers.has(handler));
    expect(signalHandler).toBeTypeOf("function");
    (signalHandler as () => void)();
    expect(await result).not.toBe(0);

    const childPid = Number(readFileSync(join(fixture, "child-pid"), "utf8"));
    await waitUntil(() => {
      try {
        process.kill(childPid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it("proves a real initialize and tools/list handshake without calling a data tool", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "letyclaw-marketdata-smoke-"));
    fixtures.push(fixture);
    const fakeMcp = join(fixture, "fake-mcp");
    writeFileSync(fakeMcp, [
      "#!/bin/bash",
      "set -eu",
      "capture_dir=$(dirname \"$0\")",
      "printf '%s' \"${ALPHA_VANTAGE_API_KEY:-absent}\" > \"$capture_dir/key\"",
      "while IFS= read -r line; do",
      "  printf '%s\\n' \"$line\" >> \"$capture_dir/input\"",
      "  if [[ \"$line\" == *'\"method\":\"initialize\"'* ]]; then",
      "    id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([0-9][0-9]*\\).*/\\1/p')",
      "    printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"protocolVersion\":\"2024-11-05\",\"serverInfo\":{\"name\":\"fake\",\"version\":\"1\"},\"capabilities\":{}}}\\n' \"$id\"",
      "  elif [[ \"$line\" == *'\"method\":\"tools/list\"'* ]]; then",
      "    id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([0-9][0-9]*\\).*/\\1/p')",
      "    printf '{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":{\"tools\":[{\"name\":\"TOOL_LIST\",\"description\":\"list\",\"inputSchema\":{\"type\":\"object\"}},{\"name\":\"TOOL_GET\",\"description\":\"get\",\"inputSchema\":{\"type\":\"object\"}},{\"name\":\"TOOL_CALL\",\"description\":\"call\",\"inputSchema\":{\"type\":\"object\"}}]}}\\n' \"$id\"",
      "  fi",
      "done",
    ].join("\n"));
    chmodSync(fakeMcp, 0o755);

    const result = await runMarketdataSmoke({
      command: fakeMcp,
      args: [],
      timeoutMs: SMOKE_TEST_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH || "",
        HOME: fixture,
        ALPHA_VANTAGE_API_KEY: "smoke_key_1234",
      },
    });

    expect(result).toEqual({
      serverName: "fake",
      serverVersion: "1",
      toolNames: ["TOOL_CALL", "TOOL_GET", "TOOL_LIST"],
    });
    const input = readFileSync(join(fixture, "input"), "utf8");
    expect(input).toContain('"method":"initialize"');
    expect(input).toContain('"method":"tools/list"');
    expect(input).not.toContain('"method":"tools/call"');
    expect(readFileSync(join(fixture, "key"), "utf8")).toBe("letyclaw_marketdata_smoke_dummy");
  });

  it("keeps a bounded actionable stderr tail while redacting the smoke credential", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "letyclaw-marketdata-smoke-fail-"));
    fixtures.push(fixture);
    const fakeMcp = join(fixture, "fake-mcp");
    writeFileSync(fakeMcp, [
      "#!/bin/bash",
      "printf 'handler registration failed for %s\\n' \"$ALPHA_VANTAGE_API_KEY\" >&2",
      "exit 1",
    ].join("\n"));
    chmodSync(fakeMcp, 0o755);

    const error = await runMarketdataSmoke({
      command: fakeMcp,
      args: [],
      timeoutMs: SMOKE_TEST_TIMEOUT_MS,
      env: { PATH: process.env.PATH || "", HOME: fixture },
    }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/handler registration failed for \[redacted\]/);
    expect((error as Error).message).not.toContain("letyclaw_marketdata_smoke_dummy");
  });

  it("loads only protected key files and rejects broad modes or symlinks", () => {
    const fixture = mkdtempSync(join(tmpdir(), "letyclaw-marketdata-key-"));
    fixtures.push(fixture);
    const configDir = join(fixture, ".config", "letyclaw");
    const keyFile = join(configDir, "marketdata-key");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    writeFileSync(keyFile, "secure_key_1234\n", { mode: 0o600 });
    expect(resolveMarketdataApiKey({ HOME: fixture })).toBe("secure_key_1234");

    chmodSync(keyFile, 0o644);
    expect(() => resolveMarketdataApiKey({ HOME: fixture })).toThrow(/permissions/);
    chmodSync(keyFile, 0o600);
    const link = join(fixture, "linked-key");
    symlinkSync(keyFile, link);
    expect(() => resolveMarketdataApiKey({ HOME: fixture, LETYCLAW_MARKETDATA_KEY_FILE: link }))
      .toThrow(/regular file/);
  });

  it("parses only the last valid Alpha assignment without executing env syntax", () => {
    expect(parseAlphaVantageKeyFromEnvFile([
      "OTHER_SECRET=$(do-not-run)",
      "ALPHA_VANTAGE_API_KEY=old_key_1234",
      "export ALPHA_VANTAGE_API_KEY='new_key_5678'",
    ].join("\n"))).toBe("new_key_5678");
    expect(parseAlphaVantageKeyFromEnvFile("ALPHA_VANTAGE_API_KEY=$(unsafe)")).toBeNull();
  });

  it("keeps registration and setup free of secret interpolation or env sourcing", () => {
    const setup = readFileSync(resolve("scripts/setup-mcp.sh"), "utf8");
    expect(setup).toContain('NODE_BIN=/usr/bin/node');
    expect(setup).toContain('"$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/marketdata-mcp-proxy.js"');
    expect(setup).toContain('/usr/bin/node "${PROJECT_ROOT}/dist/scripts/smoke-marketdata-mcp.js"');
    expect(setup.match(/dist\/scripts\/smoke-marketdata-mcp\.js/g)).toHaveLength(1);
    expect(setup).toContain("sudo -u letyclaw env -i");
    expect(setup).not.toContain('"$NODE_BIN" "${PROJECT_ROOT}/dist/scripts/smoke-marketdata-mcp.js"');
    expect(setup.indexOf("dist/scripts/smoke-marketdata-mcp.js"))
      .toBeLessThan(setup.indexOf("systemctl disable --now playwright-anchor"));
    expect(setup).not.toContain('source "${PROJECT_ROOT}/.env"');
    expect(setup).not.toMatch(/marketdata-mcp\s+"?\$\{ALPHA_VANTAGE_API_KEY\}"?/);
  });
});
