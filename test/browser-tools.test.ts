import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { browserSecretNames } from "../tools/letyclaw-mcp/tools/browser.js";

describe("browser credential aliases", () => {
  it("returns only valid names and never secret values", () => {
    const dir = mkdtempSync(join(tmpdir(), "letyclaw-browser-secrets-"));
    const path = join(dir, "secret-names");
    try {
      writeFileSync(path, [
        "RENFE_USERNAME",
        "RENFE_PASSWORD",
        "invalid-name",
        "EMPTY",
        "RENFE_USERNAME",
        "",
      ].join("\n"));
      const names = browserSecretNames(path);
      expect(names).toEqual(["EMPTY", "RENFE_PASSWORD", "RENFE_USERNAME"]);
      expect(JSON.stringify(names)).not.toContain("invalid-name");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list when the protected file is absent", () => {
    expect(browserSecretNames(join(tmpdir(), "letyclaw-browser-secrets-missing.env"))).toEqual([]);
  });
});
