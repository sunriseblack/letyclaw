import { describe, expect, it, vi } from "vitest";
import {
  buildDriveAccountConfig,
  parseDriveAccounts,
  resolveDriveRemote,
} from "../tools/letyclaw-mcp/tools/gdrive.js";

describe("Google Drive account aliases", () => {
  it("uses the legacy rclone remote only as a generic default fallback", () => {
    expect(parseDriveAccounts(undefined, "team_drive")).toEqual({ default: "team_drive" });
  });

  it("parses arbitrary safe alias-to-remote mappings", () => {
    expect(parseDriveAccounts('{"work":"company_drive","archive":"archive-2026"}')).toEqual({
      work: "company_drive",
      archive: "archive-2026",
    });
  });

  it("rejects unsafe aliases, remote targets, and malformed maps", () => {
    expect(() => parseDriveAccounts('{"../private":"drive"}')).toThrow(/unsafe Google Drive account alias/);
    expect(() => parseDriveAccounts('{"work":"drive:path"}')).toThrow(/unsafe rclone remote/);
    expect(() => parseDriveAccounts("[]")).toThrow(/JSON object/);
    expect(() => parseDriveAccounts("{}")).toThrow(/must not be empty/);
    expect(() => parseDriveAccounts("   ")).toThrow(/must not be empty/);
  });

  it("requires an explicit default when a configured map has no default alias", () => {
    expect(() => buildDriveAccountConfig({
      LETYCLAW_GDRIVE_ACCOUNTS: '{"work":"company_drive"}',
    })).toThrow(/default Google Drive account "default" is not configured/);
    expect(buildDriveAccountConfig({
      LETYCLAW_GDRIVE_ACCOUNTS: '{"work":"company_drive"}',
      LETYCLAW_GDRIVE_DEFAULT_ACCOUNT: "work",
    })).toEqual({ remotes: { work: "company_drive" }, defaultAccount: "work" });
  });

  it("fails closed instead of targeting gdrive when an explicit map is invalid", async () => {
    const previous = process.env.LETYCLAW_GDRIVE_ACCOUNTS;
    process.env.LETYCLAW_GDRIVE_ACCOUNTS = '{"../private":"unexpected"}';
    vi.resetModules();
    try {
      const { handlers } = await import("../tools/letyclaw-mcp/tools/gdrive.js");
      const result = await handlers.gdrive_list!({});
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/configuration is invalid.*unsafe Google Drive account alias/);
    } finally {
      if (previous === undefined) delete process.env.LETYCLAW_GDRIVE_ACCOUNTS;
      else process.env.LETYCLAW_GDRIVE_ACCOUNTS = previous;
      vi.resetModules();
    }
  });

  it("resolves only configured accounts and reports the safe aliases", () => {
    const remotes = { default: "gdrive", work: "company_drive" };
    expect(resolveDriveRemote(undefined, remotes, "default")).toEqual({ remote: "gdrive" });
    expect(resolveDriveRemote("work", remotes, "default")).toEqual({ remote: "company_drive" });
    expect(resolveDriveRemote("missing", remotes, "default")).toEqual({
      remote: "",
      err: 'unknown account "missing". Valid: default, work',
    });
  });
});
