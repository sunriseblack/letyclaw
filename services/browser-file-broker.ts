/** Safe broker between letyclaw-writable exchange files and the private browser. */
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "fs";
import { randomUUID } from "crypto";
import { join } from "path";
import { createReadStream, createWriteStream } from "fs";
import { Transform } from "stream";
import { pipeline } from "stream/promises";

const ARTIFACT_PREFIX = "browser-artifacts/";
const UPLOAD_PREFIX = "browser-uploads/";
const PATH_UPLOAD_TOOLS = new Set(["browser_file_upload", "browser_drop"]);

export interface BrowserFileBrokerOptions {
  sharedUploadDir: string;
  privateStageDir: string;
  exposedStageDir: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxStagedFiles?: number;
}

export interface BrokeredBrowserArguments {
  args: Record<string, unknown>;
  cleanup(delayMs?: number): void;
}

function stagedUsage(directory: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
      continue;
    }
    if (stat.isFile()) {
      bytes += stat.size;
      files += 1;
      continue;
    }
    if (!stat.isDirectory()) throw new Error("browser private upload staging contains an unsafe entry");
    for (const child of readdirSync(path)) {
      const childPath = join(path, child);
      const childStat = lstatSync(childPath);
      if (childStat.isSymbolicLink()) {
        unlinkSync(childPath);
        continue;
      }
      if (!childStat.isFile()) throw new Error("browser private upload staging is nested or unsafe");
      bytes += childStat.size;
      files += 1;
    }
  }
  return { bytes, files };
}

function singleLeaf(path: string, prefix: string, label: string): string {
  if (!path.startsWith(prefix)) {
    throw new Error(`${label} must use ${prefix}<filename>`);
  }
  const leaf = path.slice(prefix.length);
  if (!leaf || leaf === "." || leaf === ".." || leaf.includes("/") || leaf.includes("\\") || leaf.includes("\0")) {
    throw new Error(`${label} must contain one safe filename and no subdirectories`);
  }
  if (Buffer.byteLength(leaf) > 240) throw new Error(`${label} filename is too long`);
  return leaf;
}

export function validateBrowserArtifactFilename(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string") throw new Error("browser artifact filename must be a string");
  singleLeaf(value, ARTIFACT_PREFIX, "browser artifact filename");
}

/**
 * Open shared uploads with O_NOFOLLOW, copy bytes to a private browser-owned
 * spool, and give Playwright only the private path. This closes both symlink
 * and time-of-check/time-of-use attacks against the browser profile/secrets.
 */
export async function brokerBrowserArguments(
  tool: string,
  rawArgs: unknown,
  options: BrowserFileBrokerOptions,
): Promise<BrokeredBrowserArguments> {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
    ? { ...(rawArgs as Record<string, unknown>) }
    : {};
  validateBrowserArtifactFilename(args.filename);

  const staged: Array<{ path: string; directory: string }> = [];
  let cleanupScheduled = false;
  const erase = (): void => {
    for (const entry of staged) {
      try { unlinkSync(entry.path); } catch { /* already removed */ }
      try { rmdirSync(entry.directory); } catch { /* already removed or nonempty */ }
    }
  };
  const cleanup = (delayMs = 0): void => {
    if (cleanupScheduled) return;
    cleanupScheduled = true;
    if (delayMs <= 0) {
      erase();
      return;
    }
    const timer = setTimeout(erase, delayMs);
    timer.unref();
  };

  if (!PATH_UPLOAD_TOOLS.has(tool) || args.paths === undefined) return { args, cleanup };
  if (!Array.isArray(args.paths) || !args.paths.every((path) => typeof path === "string")) {
    throw new Error(`${tool} paths must be an array of browser-uploads/<filename> strings`);
  }

  const maxFileBytes = options.maxFileBytes ?? 200 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 500 * 1024 * 1024;
  const maxStagedFiles = options.maxStagedFiles ?? 100;
  if (args.paths.length > 10) throw new Error("browser upload is limited to 10 files per call");
  const existing = stagedUsage(options.privateStageDir);
  if (existing.files + args.paths.length > maxStagedFiles || existing.bytes > maxTotalBytes) {
    throw new Error("browser private upload staging is at capacity; retry after retained files expire");
  }
  let total = existing.bytes;
  try {
    const privatePaths: string[] = [];
    for (const requested of args.paths) {
      const leaf = singleLeaf(requested, UPLOAD_PREFIX, "browser upload path");
      const source = join(options.sharedUploadDir, leaf);
      const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
      const descriptor = openSync(source, flags);
      let handedToStream = false;
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile()) throw new Error(`browser upload is not a regular file: ${leaf}`);
        if (stat.size > maxFileBytes) throw new Error(`browser upload exceeds ${maxFileBytes} bytes: ${leaf}`);
        const privateName = randomUUID();
        const privateDirectory = join(options.privateStageDir, privateName);
        const privatePath = join(privateDirectory, leaf);
        mkdirSync(privateDirectory, { mode: 0o700 });
        let fileBytes = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            fileBytes += chunk.length;
            total += chunk.length;
            if (fileBytes > maxFileBytes || total > maxTotalBytes) {
              callback(new Error("browser upload exceeded the configured byte limit while being staged"));
            } else {
              callback(null, chunk);
            }
          },
        });
        handedToStream = true;
        try {
          await pipeline(
            createReadStream(source, { fd: descriptor, autoClose: true }),
            counter,
            createWriteStream(privatePath, { flags: "wx", mode: 0o600 }),
          );
        } catch (error) {
          try { unlinkSync(privatePath); } catch { /* absent */ }
          try { rmdirSync(privateDirectory); } catch { /* absent or nonempty */ }
          throw error;
        }
        staged.push({ path: privatePath, directory: privateDirectory });
        privatePaths.push(join(options.exposedStageDir, privateName, leaf));
      } finally {
        if (!handedToStream) closeSync(descriptor);
      }
    }
    args.paths = privatePaths;
    return { args, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function purgeStagedBrowserUploads(directory: string, olderThanMs = 60 * 60 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.mtimeMs < cutoff)) {
      unlinkSync(path);
      removed += 1;
      continue;
    }
    if (!stat.isDirectory()) throw new Error("browser private upload staging contains an unsafe entry");
    const children = readdirSync(path).map((child) => {
      const childPath = join(path, child);
      return { childPath, stat: lstatSync(childPath) };
    });
    if (children.some((child) => !child.stat.isFile() && !child.stat.isSymbolicLink())) {
      throw new Error("browser private upload staging is nested or unsafe");
    }
    if (children.every((child) => child.stat.isSymbolicLink() || child.stat.mtimeMs < cutoff)) {
      for (const child of children) {
        unlinkSync(child.childPath);
        removed += 1;
      }
      rmdirSync(path);
    }
  }
  return removed;
}
