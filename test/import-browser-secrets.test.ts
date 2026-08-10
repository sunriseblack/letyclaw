import { describe, expect, it } from "vitest";
import {
  extractBrowserAliases,
  extractBrowserSecretPolicy,
  mergeBrowserDotenv,
} from "../scripts/import-browser-secrets.js";

describe("legacy browser credential migration", () => {
  it("maps provider credentials to stable Playwright aliases without logging values", () => {
    const aliases = extractBrowserAliases({
      _note: "ignored",
      enjoy: { user: "user@example.com", pass: "very-secret" },
      cmvalencia: { username: "sample-user", password: "also-secret" },
      public: { url: "https://example.com" },
    });
    expect([...aliases.keys()].sort()).toEqual([
      "CMVALENCIA_PASSWORD",
      "CMVALENCIA_USERNAME",
      "ENJOY_PASSWORD",
      "ENJOY_USERNAME",
    ]);
  });

  it("binds imported aliases to their provider HTTPS origins", () => {
    expect(extractBrowserSecretPolicy({
      enjoy: {
        user: "u",
        pass: "p",
        login_url: "https://enjoy.example/login",
        calendar_url: "https://enjoy.example/calendar",
      },
    })).toEqual({
      ENJOY_USERNAME: ["https://enjoy.example"],
      ENJOY_PASSWORD: ["https://enjoy.example"],
    });
  });

  it("replaces only matching dotenv entries and preserves unrelated aliases", () => {
    const merged = mergeBrowserDotenv(
      "RENFE_PASSWORD=keep\nENJOY_PASSWORD=old\n# note\n",
      new Map([["ENJOY_PASSWORD", "new value"]]),
    );
    expect(merged).toContain("RENFE_PASSWORD=keep");
    expect(merged).toContain('ENJOY_PASSWORD="new value"');
    expect(merged).not.toContain("ENJOY_PASSWORD=old");
  });
});
