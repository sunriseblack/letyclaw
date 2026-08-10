import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { migrateVoiceDb } from "../scripts/migrate-voice-db.js";

describe("voice DB state-directory migration", () => {
  let root: string;
  let legacyPath: string;
  let targetPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "letyclaw-voice-migration-"));
    legacyPath = join(root, "legacy", "voice-calls.sqlite");
    targetPath = join(root, "state", "voice-calls.sqlite");
    mkdirSync(join(root, "legacy"), { recursive: true });
    const db = new Database(legacyPath);
    db.exec("CREATE TABLE calls (call_sid TEXT PRIMARY KEY, status TEXT); INSERT INTO calls VALUES ('CA123', 'completed')");
    db.close();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("atomically migrates a verified snapshot and retains backup evidence", async () => {
    const result = await migrateVoiceDb({
      legacyPath,
      targetPath,
      now: () => new Date("2026-07-09T22:00:00.000Z"),
    });

    expect(result.status).toBe("migrated");
    expect(result.callsRows).toBe(1);
    expect(existsSync(legacyPath)).toBe(true);
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(existsSync(result.evidencePath!)).toBe(true);

    const migrated = new Database(targetPath, { readonly: true });
    expect(migrated.prepare("SELECT call_sid, status FROM calls").get()).toEqual({
      call_sid: "CA123",
      status: "completed",
    });
    migrated.close();

    const evidence = JSON.parse(readFileSync(result.evidencePath!, "utf8")) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      version: 1,
      migrated_at: "2026-07-09T22:00:00.000Z",
      legacy_path: legacyPath,
      target_path: targetPath,
      calls_rows: 1,
    });
    expect(evidence.legacy_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.snapshot_sha256).toBe(evidence.target_sha256);
  });

  it("is idempotent and never overwrites the migrated target", async () => {
    await migrateVoiceDb({ legacyPath, targetPath });
    const target = new Database(targetPath);
    target.exec("INSERT INTO calls VALUES ('CA456', 'connected')");
    target.close();

    const second = await migrateVoiceDb({ legacyPath, targetPath });
    expect(second.status).toBe("already_migrated");
    expect(second.callsRows).toBe(2);
  });

  it("refuses to overwrite an unrelated target when evidence is missing", async () => {
    mkdirSync(join(root, "state"), { recursive: true });
    const target = new Database(targetPath);
    target.exec("CREATE TABLE calls (call_sid TEXT PRIMARY KEY, status TEXT); INSERT INTO calls VALUES ('OTHER', 'live')");
    target.close();

    await expect(migrateVoiceDb({ legacyPath, targetPath })).rejects.toThrow(
      "refusing to overwrite existing voice DB",
    );
    const untouched = new Database(targetPath, { readonly: true });
    expect(untouched.prepare("SELECT call_sid FROM calls").get()).toEqual({ call_sid: "OTHER" });
    untouched.close();
  });

  it("rejects corrupted migration evidence instead of trusting its presence", async () => {
    const first = await migrateVoiceDb({ legacyPath, targetPath });
    writeFileSync(first.evidencePath!, "{}\n");

    await expect(migrateVoiceDb({ legacyPath, targetPath })).rejects.toThrow(
      "migration evidence is invalid",
    );
  });
});
