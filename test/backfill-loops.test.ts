import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const script = resolve("scripts/backfill-loops.mjs");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "letyclaw-backfill-"));
  temporaryDirectories.push(root);
  const vault = join(root, "vault");
  const config = join(root, "letyclaw.yaml");
  const capture = join(root, "capture.json");
  const claude = join(root, "fake-claude.mjs");
  mkdirSync(vault);
  writeFileSync(config, "agents:\n  list:\n    - id: work\n      name: Work\n", "utf8");
  writeFileSync(claude, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.CAPTURE_PATH, JSON.stringify({ args: process.argv.slice(2), agent: process.env.LETYCLAW_AGENT_ID, cwd: process.cwd() }));\n`, "utf8");
  chmodSync(claude, 0o755);
  return { vault, config, capture, claude };
}

describe("open-loop backfill routing", () => {
  it("requires an explicit agent instead of assuming a private default", () => {
    const { vault, config, claude } = fixture();
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, VAULT_PATH: vault, LETYCLAW_CONFIG_FILE: config, CLAUDE_PATH: claude },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("pass an explicit configured agent ID");
  });

  it("fails closed for an agent absent from the selected config", () => {
    const { vault, config, claude } = fixture();
    const result = spawnSync(process.execPath, [script, "personal"], {
      encoding: "utf8",
      env: { ...process.env, VAULT_PATH: vault, LETYCLAW_CONFIG_FILE: config, CLAUDE_PATH: claude },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('agent "personal" is not configured');
  });

  it("runs only for the explicitly configured agent", () => {
    const { vault, config, capture, claude } = fixture();
    const result = spawnSync(process.execPath, [script, "work"], {
      encoding: "utf8",
      env: {
        ...process.env,
        VAULT_PATH: vault,
        LETYCLAW_CONFIG_FILE: config,
        CLAUDE_PATH: claude,
        CAPTURE_PATH: capture,
      },
    });

    expect(result.status).toBe(0);
    const invocation = JSON.parse(readFileSync(capture, "utf8")) as {
      args: string[];
      agent: string;
      cwd: string;
    };
    expect(invocation.agent).toBe("work");
    expect(invocation.cwd).toBe(realpathSync(vault));
    expect(invocation.args).toContain("--dangerously-skip-permissions");
  });
});
