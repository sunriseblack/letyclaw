#!/usr/bin/env node
/** Migrate the legacy tennis credential JSON into Playwright dotenv aliases. */
import {
  closeSync,
  chmodSync,
  chownSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash } from "crypto";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadBrowserSecretPolicy } from "../services/browser-secret-policy.js";

const VALID_ALIAS = /^[A-Z_][A-Z0-9_]*$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(value: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return null;
}

export function extractBrowserAliases(value: unknown): Map<string, string> {
  const root = record(value);
  if (!root) throw new Error("legacy browser credential JSON must be an object");
  const aliases = new Map<string, string>();
  for (const [provider, raw] of Object.entries(root)) {
    if (provider.startsWith("_")) continue;
    const entry = record(raw);
    if (!entry) continue;
    const prefix = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^\d/, "_$&");
    const username = firstString(entry, ["user", "username", "email", "login"]);
    const password = firstString(entry, ["pass", "password"]);
    if (username) aliases.set(`${prefix}_USERNAME`, username);
    if (password) aliases.set(`${prefix}_PASSWORD`, password);
  }
  if (aliases.size === 0) throw new Error("legacy browser credential JSON contained no recognized credentials");
  for (const name of aliases.keys()) {
    if (!VALID_ALIAS.test(name)) throw new Error(`generated invalid browser alias: ${name}`);
  }
  return aliases;
}

export function extractBrowserSecretPolicy(value: unknown): Record<string, string[]> {
  const root = record(value);
  if (!root) throw new Error("legacy browser credential JSON must be an object");
  const policy: Record<string, string[]> = {};
  for (const [provider, raw] of Object.entries(root)) {
    if (provider.startsWith("_")) continue;
    const entry = record(raw);
    if (!entry) continue;
    const prefix = provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^\d/, "_$&");
    const aliases: string[] = [];
    if (firstString(entry, ["user", "username", "email", "login"])) aliases.push(`${prefix}_USERNAME`);
    if (firstString(entry, ["pass", "password"])) aliases.push(`${prefix}_PASSWORD`);
    if (aliases.length === 0) continue;
    const origins = new Set<string>();
    for (const [key, candidate] of Object.entries(entry)) {
      if (!/(?:^|_)url$/i.test(key) || typeof candidate !== "string") continue;
      try {
        const url = new URL(candidate);
        if (url.protocol === "https:") origins.add(url.origin);
      } catch { /* non-URL metadata */ }
    }
    if (origins.size === 0) throw new Error(`credential provider has no allowed HTTPS origin: ${provider}`);
    for (const alias of aliases) policy[alias] = [...origins].sort();
  }
  return policy;
}

function dotenvValue(value: string): string {
  return JSON.stringify(value);
}

export function mergeBrowserDotenv(existing: string, aliases: ReadonlyMap<string, string>): string {
  const replaced = new Set(aliases.keys());
  const kept = existing.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !replaced.has(match[1]!);
  });
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const added = [...aliases].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${dotenvValue(value)}`);
  return [...kept, ...(kept.length ? [""] : []), ...added, ""].join("\n");
}

interface CliOptions {
  source: string;
  secrets: string;
  backup: string;
  receipt?: string;
  policy?: string;
  ownerUid?: number;
  ownerGid?: number;
}

function parseArgs(args: readonly string[]): CliOptions {
  const value = (flag: string): string => {
    const index = args.indexOf(flag);
    const found = index >= 0 ? args[index + 1] : undefined;
    if (!found) throw new Error(`missing ${flag}`);
    return found;
  };
  const number = (flag: string): number | undefined => {
    if (!args.includes(flag)) return undefined;
    const parsed = Number(value(flag));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${flag}`);
    return parsed;
  };
  return {
    source: value("--source"),
    secrets: value("--secrets"),
    backup: value("--backup"),
    receipt: args.includes("--receipt") ? value("--receipt") : undefined,
    policy: args.includes("--policy") ? value("--policy") : undefined,
    ownerUid: number("--owner-uid"),
    ownerGid: number("--owner-gid"),
  };
}

function secureReadRegular(path: string, label: string): { content: Buffer; stat: ReturnType<typeof fstatSync> } {
  const descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
    return { content: readFileSync(descriptor), stat };
  } finally {
    closeSync(descriptor);
  }
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function atomicPrivateWrite(path: string, content: string | Buffer, ownerUid?: number, ownerGid?: number): void {
  const temp = `${path}.tmp.${process.pid}`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    if (ownerUid !== undefined && ownerGid !== undefined) chownSync(temp, ownerUid, ownerGid);
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or absent */ }
  }
}

export function importBrowserSecrets(options: CliOptions): string[] {
  const source = secureReadRegular(options.source, "legacy credential source");

  let parsed: unknown;
  try { parsed = JSON.parse(source.content.toString("utf8")) as unknown; }
  catch { throw new Error("legacy credential source is not valid JSON"); }
  const aliases = extractBrowserAliases(parsed);
  const importedPolicy = extractBrowserSecretPolicy(parsed);

  const backupDir = dirname(options.backup);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupDirStat = lstatSync(backupDir);
  if (backupDirStat.isSymbolicLink() || !backupDirStat.isDirectory()) {
    throw new Error("browser credential backup directory is unsafe");
  }
  chmodSync(backupDir, 0o700);
  const backupTemp = `${options.backup}.tmp.${process.pid}`;
  try {
    writeFileSync(backupTemp, source.content, { flag: "wx", mode: 0o600 });
    chmodSync(backupTemp, 0o600);
    renameSync(backupTemp, options.backup);
  } finally {
    try { unlinkSync(backupTemp); } catch { /* renamed or absent */ }
  }

  const existing = existsSync(options.secrets)
    ? secureReadRegular(options.secrets, "browser secrets destination").content.toString("utf8")
    : "";
  const mergedSecrets = mergeBrowserDotenv(existing, aliases);
  let mergedPolicy: string | undefined;
  if (options.policy) {
    let existingPolicy: Record<string, unknown> = {};
    if (existsSync(options.policy)) {
      try {
        const parsedPolicy = JSON.parse(
          secureReadRegular(options.policy, "browser secret policy").content.toString("utf8"),
        ) as unknown;
        existingPolicy = record(parsedPolicy) ?? {};
      } catch { throw new Error("browser secret policy is invalid"); }
    }
    mergedPolicy = JSON.stringify({ ...existingPolicy, ...importedPolicy }, null, 2) + "\n";
  }

  // Commit policy first. If the later secret rename fails, extra policy entries
  // are harmless; the inverse ordering can strand a live gateway with an alias
  // that has no policy and prevent both the new and rollback service starting.
  if (options.policy && mergedPolicy !== undefined) {
    atomicPrivateWrite(options.policy, mergedPolicy, options.ownerUid, options.ownerGid);
  }
  atomicPrivateWrite(options.secrets, mergedSecrets, options.ownerUid, options.ownerGid);

  if (options.receipt) {
    atomicPrivateWrite(options.receipt, JSON.stringify({
      source: options.source,
      dev: source.stat.dev,
      ino: source.stat.ino,
      size: source.stat.size,
      sha256: sha256(source.content),
    }) + "\n");
  }
  return [...aliases.keys()].sort();
}

export function removeImportedBrowserSecretSource(sourcePath: string, receiptPath: string): void {
  const receiptFile = secureReadRegular(receiptPath, "browser import receipt");
  let receipt: { source?: unknown; dev?: unknown; ino?: unknown; size?: unknown; sha256?: unknown };
  try { receipt = JSON.parse(receiptFile.content.toString("utf8")) as typeof receipt; }
  catch { throw new Error("browser import receipt is invalid"); }
  const source = secureReadRegular(sourcePath, "legacy credential source");
  const matches = receipt.source === sourcePath &&
    receipt.dev === source.stat.dev && receipt.ino === source.stat.ino &&
    receipt.size === source.stat.size && receipt.sha256 === sha256(source.content);
  if (!matches) throw new Error("legacy credential source changed after protected import; refusing removal");
  const current = lstatSync(sourcePath);
  if (current.isSymbolicLink() || current.dev !== source.stat.dev || current.ino !== source.stat.ino) {
    throw new Error("legacy credential source was replaced after verification; refusing removal");
  }
  unlinkSync(sourcePath);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return !!entry && resolve(entry) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2);
    const value = (flag: string): string => {
      const index = args.indexOf(flag);
      const found = index >= 0 ? args[index + 1] : undefined;
      if (!found) throw new Error(`missing ${flag}`);
      return found;
    };
    if (args.includes("--validate-existing")) {
      const policy = loadBrowserSecretPolicy(value("--policy"), value("--secrets"));
      console.log(`Validated ${policy.size} browser alias origin policies`);
    } else if (args.includes("--remove-source-from-receipt")) {
      removeImportedBrowserSecretSource(value("--source"), value("--receipt"));
      console.log("Removed verified legacy browser credential source");
    } else {
      const aliases = importBrowserSecrets(parseArgs(args));
      console.log(`Imported ${aliases.length} browser credential aliases: ${aliases.join(", ")}`);
    }
  } catch (error) {
    console.error(`Browser credential migration failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
