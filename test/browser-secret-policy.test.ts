import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  assertSecretAliasesAllowed,
  loadBrowserSecretPolicy,
  originFromEvaluateResult,
  secretAliasesInArguments,
  secretTargetsInBrowserArguments,
} from "../services/browser-secret-policy.js";

describe("browser secret origin policy", () => {
  it("requires every dotenv alias to have an exact HTTPS origin", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-policy-"));
    const secrets = join(dir, "secrets.env");
    const policy = join(dir, "policy.json");
    try {
      writeFileSync(secrets, 'ENJOY_USERNAME="user"\nENJOY_PASSWORD="pass"\n');
      writeFileSync(policy, JSON.stringify({
        ENJOY_USERNAME: ["https://enjoy.example"],
        ENJOY_PASSWORD: ["https://enjoy.example"],
      }));
      const loaded = loadBrowserSecretPolicy(policy, secrets);
      expect(secretAliasesInArguments({ fields: [{ value: "ENJOY_PASSWORD" }] }, loaded))
        .toEqual(["ENJOY_PASSWORD"]);
      expect(secretTargetsInBrowserArguments("browser_fill_form", {
        fields: [{ name: "Password", target: "f1e7", type: "textbox", value: "ENJOY_PASSWORD" }],
      }, loaded)).toEqual([{ alias: "ENJOY_PASSWORD", target: "f1e7", element: "Password" }]);
      expect(() => secretTargetsInBrowserArguments("browser_evaluate", {
        function: "() => true", password: "ENJOY_PASSWORD",
      }, loaded)).toThrow(/only as values/);
      expect(() => secretTargetsInBrowserArguments("browser_type", {
        target: "#password", text: "ENJOY_PASSWORD",
      }, loaded)).toThrow(/fresh snapshot/);
      expect(() => assertSecretAliasesAllowed(["ENJOY_PASSWORD"], "https://enjoy.example", loaded))
        .not.toThrow();
      expect(() => assertSecretAliasesAllowed(["ENJOY_PASSWORD"], "https://evil.example", loaded))
        .toThrow(/not allowed/);
      expect(originFromEvaluateResult({
        content: [{ type: "text", text: '### Result\n"https://enjoy.example"' }],
      })).toBe("https://enjoy.example");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when a secret alias has no policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-policy-"));
    const secrets = join(dir, "secrets.env");
    const policy = join(dir, "policy.json");
    try {
      writeFileSync(secrets, "MISSING_PASSWORD=x\n");
      writeFileSync(policy, "{}\n");
      expect(() => loadBrowserSecretPolicy(policy, secrets)).toThrow(/no allowed-origin/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
