#!/usr/bin/env node
import Database from "better-sqlite3";
import { createHash } from "crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";

const DEFAULT_LEGACY_DB = "/root/letyclaw/voice-calls.sqlite";
const DEFAULT_TARGET_DB = "/var/lib/letyclaw-voice/voice-calls.sqlite";
const BACKUP_NAME = "voice-calls.pre-state-directory.sqlite";
const EVIDENCE_NAME = "migration-evidence.json";

export interface VoiceDbMigrationOptions {
  legacyPath?: string;
  targetPath?: string;
  now?: () => Date;
}

export interface VoiceDbMigrationResult {
  status: "no_legacy_db" | "migrated" | "already_migrated" | "recovered_evidence";
  legacyPath: string;
  targetPath: string;
  backupPath?: string;
  evidencePath?: string;
  callsRows?: number;
}

interface MigrationEvidence {
  version: 1;
  migrated_at: string;
  legacy_path: string;
  target_path: string;
  backup_path: string;
  legacy_size_bytes: number;
  legacy_sha256: string;
  snapshot_sha256: string;
  target_sha256: string;
  calls_rows: number;
}

function rejectSymlink(path: string): void {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error(`refusing symbolic link during voice DB migration: ${path}`);
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateSnapshot(path: string): number {
  rejectSymlink(path);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("integrity_check") as Array<Record<string, unknown>>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${path}`);
    }
    const callsTable = db.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'calls'",
    ).get() as { present?: number } | undefined;
    if (!callsTable?.present) return 0;
    const count = db.prepare("SELECT COUNT(*) AS count FROM calls").get() as { count: number | bigint };
    return Number(count.count);
  } finally {
    db.close();
  }
}

function writeEvidence(path: string, evidence: MigrationEvidence): void {
  rejectSymlink(path);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readAndValidateEvidence(
  evidencePath: string,
  legacyPath: string,
  targetPath: string,
  backupPath: string,
): MigrationEvidence {
  let evidence: MigrationEvidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as MigrationEvidence;
  } catch {
    throw new Error(`voice DB migration evidence is unreadable: ${evidencePath}`);
  }
  if (
    evidence.version !== 1
    || evidence.legacy_path !== legacyPath
    || evidence.target_path !== targetPath
    || evidence.backup_path !== backupPath
    || !/^[a-f0-9]{64}$/.test(evidence.snapshot_sha256)
  ) {
    throw new Error(`voice DB migration evidence is invalid: ${evidencePath}`);
  }
  const backupRows = validateSnapshot(backupPath);
  if (sha256(backupPath) !== evidence.snapshot_sha256 || backupRows !== evidence.calls_rows) {
    throw new Error("voice DB migration backup no longer matches its evidence");
  }
  return evidence;
}

/**
 * Move the legacy root-owned SQLite database into systemd's private
 * StateDirectory without mutating or deleting the source. SQLite's online
 * backup API produces a consistent standalone snapshot (including WAL state),
 * which is retained alongside hash/count evidence before the target is made
 * visible atomically.
 */
export async function migrateVoiceDb(
  options: VoiceDbMigrationOptions = {},
): Promise<VoiceDbMigrationResult> {
  const legacyPath = resolve(options.legacyPath || process.env.VOICE_LEGACY_DB_PATH || DEFAULT_LEGACY_DB);
  const targetPath = resolve(options.targetPath || process.env.VOICE_DB_PATH || DEFAULT_TARGET_DB);
  const stateDir = dirname(targetPath);
  const backupDir = join(stateDir, "migration-backups");
  const backupPath = join(backupDir, BACKUP_NAME);
  const evidencePath = join(stateDir, EVIDENCE_NAME);

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  rejectSymlink(stateDir);
  rejectSymlink(targetPath);
  rejectSymlink(evidencePath);

  if (existsSync(targetPath) && existsSync(evidencePath)) {
    const callsRows = validateSnapshot(targetPath);
    if (!existsSync(backupPath)) {
      throw new Error(`voice DB migration evidence exists but backup is missing: ${backupPath}`);
    }
    readAndValidateEvidence(evidencePath, legacyPath, targetPath, backupPath);
    return { status: "already_migrated", legacyPath, targetPath, backupPath, evidencePath, callsRows };
  }

  if (!existsSync(legacyPath)) {
    return { status: "no_legacy_db", legacyPath, targetPath };
  }
  rejectSymlink(legacyPath);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  rejectSymlink(backupDir);
  rejectSymlink(backupPath);

  const stageDir = mkdtempSync(join(stateDir, ".voice-db-migration-"));
  const stagedBackup = join(stageDir, BACKUP_NAME);
  const stagedTarget = join(stageDir, "voice-calls.sqlite");
  try {
    // Always snapshot the current legacy source while evidence is absent. If a
    // prior interrupted migration left a different backup, fail rather than
    // silently migrating stale history after the old relay wrote more calls.
    const source = new Database(legacyPath, { readonly: true, fileMustExist: true });
    try {
      await source.backup(stagedBackup);
    } finally {
      source.close();
    }
    validateSnapshot(stagedBackup);
    chmodSync(stagedBackup, 0o600);
    if (existsSync(backupPath)) {
      validateSnapshot(backupPath);
      if (sha256(backupPath) !== sha256(stagedBackup)) {
        throw new Error("existing voice DB migration backup differs from the current legacy database");
      }
    } else {
      renameSync(stagedBackup, backupPath);
    }

    const callsRows = validateSnapshot(backupPath);
    const snapshotHash = sha256(backupPath);

    if (existsSync(targetPath)) {
      validateSnapshot(targetPath);
      if (sha256(targetPath) !== snapshotHash) {
        throw new Error(
          `refusing to overwrite existing voice DB without migration evidence: ${targetPath}`,
        );
      }
      const legacyStat = statSync(legacyPath);
      writeEvidence(evidencePath, {
        version: 1,
        migrated_at: (options.now?.() || new Date()).toISOString(),
        legacy_path: legacyPath,
        target_path: targetPath,
        backup_path: backupPath,
        legacy_size_bytes: legacyStat.size,
        legacy_sha256: sha256(legacyPath),
        snapshot_sha256: snapshotHash,
        target_sha256: snapshotHash,
        calls_rows: callsRows,
      });
      return { status: "recovered_evidence", legacyPath, targetPath, backupPath, evidencePath, callsRows };
    }

    copyFileSync(backupPath, stagedTarget);
    chmodSync(stagedTarget, 0o600);
    const targetRows = validateSnapshot(stagedTarget);
    if (targetRows !== callsRows || sha256(stagedTarget) !== snapshotHash) {
      throw new Error("voice DB staged target does not match the verified backup snapshot");
    }
    renameSync(stagedTarget, targetPath);

    const legacyStat = statSync(legacyPath);
    writeEvidence(evidencePath, {
      version: 1,
      migrated_at: (options.now?.() || new Date()).toISOString(),
      legacy_path: legacyPath,
      target_path: targetPath,
      backup_path: backupPath,
      legacy_size_bytes: legacyStat.size,
      legacy_sha256: sha256(legacyPath),
      snapshot_sha256: snapshotHash,
      target_sha256: sha256(targetPath),
      calls_rows: callsRows,
    });
    return { status: "migrated", legacyPath, targetPath, backupPath, evidencePath, callsRows };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) {
  migrateVoiceDb()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error: unknown) => {
      console.error(`[voice-db-migration] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
