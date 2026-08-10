import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function prepareHarness() {
  const root = mkdtempSync(join(tmpdir(), "letyclaw-refresh-test-"));
  roots.push(root);
  const credentialHome = join(root, "credential-home");
  const claudeDir = join(credentialHome, ".claude");
  const binDir = join(root, "bin");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(binDir);

  const source = readFileSync(resolve("scripts/refresh-claude-token.sh"), "utf8");
  const allowedHomeCheck = `case "$CREDENTIAL_HOME" in
  /home/letyclaw|/root/letyclaw/sessions/connector-home) ;;
  *)
    echo "ERROR: unsupported Claude credential home: $CREDENTIAL_HOME"
    exit 1
    ;;
esac`;
  const userCheck = `if [ "$(id -un)" != "letyclaw" ]; then
  echo "ERROR: Claude credential refresh must run as the letyclaw user"
  exit 1
fi`;
  const fakeTimeout = join(binDir, "timeout");
  const testScript = source
    .replace(allowedHomeCheck, ": # temporary test credential home")
    .replace(userCheck, ": # test process stands in for the letyclaw service user")
    .replace("/usr/bin/timeout", `"${fakeTimeout}"`);
  expect(testScript).not.toBe(source);
  const scriptPath = join(root, "refresh-claude-token.sh");
  writeFileSync(scriptPath, testScript, { mode: 0o755 });

  const flock = join(binDir, "flock");
  writeFileSync(flock, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  chmodSync(flock, 0o755);
  writeFileSync(fakeTimeout, `#!/bin/sh
shift
shift
shift
if [ "\${FAKE_MODE:-}" = "timeout-after-rotation" ]; then
  "$@"
  exit 124
fi
exec "$@"
`, { mode: 0o755 });
  chmodSync(fakeTimeout, 0o755);

  const fakeClaude = join(binDir, "claude");
  writeFileSync(fakeClaude, `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify(args));
const file = path.join(process.env.HOME, ".claude", ".credentials.json");
const value = JSON.parse(fs.readFileSync(file, "utf8"));
const oauth = value.claudeAiOauth;
if (process.env.FAKE_MODE !== "unchanged") {
  oauth.accessToken = "new-access-token-material-abcdefghijklmnopqrstuvwxyz";
  oauth.refreshToken = "new-refresh-token-material-abcdefghijklmnopqrstuvwxyz";
}
oauth.expiresAt = Date.now() + (process.env.FAKE_MODE === "short" ? 5 : 240) * 60 * 1000;
fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const marker = process.env.FAKE_MODE === "wrong-marker"
  ? "not-the-required-marker"
  : "LETYCLAW_CLAUDE_REFRESH_AUTH_OK_7D8D72";
process.stdout.write(JSON.stringify({ is_error: false, result: marker }));
`, { mode: 0o755 });
  chmodSync(fakeClaude, 0o755);

  const credentialsPath = join(claudeDir, ".credentials.json");
  const original = JSON.stringify({
    claudeAiOauth: {
      accessToken: "old-access-token-material-abcdefghijklmnopqrstuvwxyz",
      refreshToken: "old-refresh-token-material-abcdefghijklmnopqrstuvwxyz",
      expiresAt: Date.now() - 60_000,
    },
  });

  const run = (mode: string) => {
    writeFileSync(credentialsPath, original, { mode: 0o600 });
    const argsFile = join(root, `args-${mode}.json`);
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        CLAUDE_CREDENTIAL_HOME: credentialHome,
        CLAUDE_PATH: fakeClaude,
        CLAUDE_REFRESH_NODE: process.execPath,
        CLAUDE_REFRESH_MIN_FUTURE_MINUTES: "30",
        FAKE_ARGS_FILE: argsFile,
        FAKE_MODE: mode,
      },
    });
    return { result, argsFile, original, credentialsPath };
  };

  return { run };
}

describe("Claude credential refresh transaction", () => {
  it.each([
    ["unchanged", "unchanged"],
    ["short", "too short-lived"],
  ])("does not install an invalid %s candidate", (mode, expectedError) => {
    const { run } = prepareHarness();
    const { result, credentialsPath, original } = run(mode);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(expectedError);
    expect(readFileSync(credentialsPath, "utf8")).toBe(original);
  }, 30_000);

  it.each(["wrong-marker", "timeout-after-rotation"])(
    "preserves a validated rotated credential when the %s probe fails",
    (mode) => {
      const { run } = prepareHarness();
      const { result, credentialsPath, original } = run(mode);

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain("rotated credentials were preserved");
      expect(readFileSync(credentialsPath, "utf8")).not.toBe(original);
      const installed = JSON.parse(readFileSync(credentialsPath, "utf8"));
      expect(installed.claudeAiOauth.accessToken).toContain("new-access-token-material");
      expect(installed.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    },
    30_000,
  );

  it("installs only a changed, sufficiently future candidate after the exact auth-only marker", () => {
    const { run } = prepareHarness();
    const { result, credentialsPath, original, argsFile } = run("valid");

    expect(result.status).toBe(0);
    expect(readFileSync(credentialsPath, "utf8")).not.toBe(original);
    const installed = JSON.parse(readFileSync(credentialsPath, "utf8"));
    expect(installed.claudeAiOauth.accessToken).toContain("new-access-token-material");
    expect(installed.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 30 * 60 * 1000);

    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--no-chrome");
  }, 30_000);
});
