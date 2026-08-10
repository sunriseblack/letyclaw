/**
 * Google Drive tools — list, search, and read files via rclone.
 *
 * Account aliases map to rclone remote names through environment configuration.
 * All handlers accept an optional `account` arg; rclone handles OAuth tokens,
 * export formats, and retries.
 *
 * Environment:
 *   RCLONE_CONFIG — path to rclone.conf (optional, defaults to ~/.config/rclone/rclone.conf)
 *   LETYCLAW_GDRIVE_ACCOUNTS — JSON object mapping safe aliases to rclone remotes
 *   LETYCLAW_GDRIVE_DEFAULT_ACCOUNT — default alias (default: "default")
 *   RCLONE_GDRIVE_REMOTE — fallback remote when no account map is configured
 */
import { execFile } from "child_process";
import { promisify } from "util";
import type { MCPToolDefinition, MCPHandler } from "../types.js";
import { ok, error } from "./_util.js";

const exec = promisify(execFile);

const SAFE_ACCOUNT_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Parse and validate account aliases before they reach an rclone target. */
export function parseDriveAccounts(raw: string | undefined, fallbackRemote = "gdrive"): Record<string, string> {
  if (raw === undefined) {
    if (!SAFE_ACCOUNT_PART.test(fallbackRemote)) {
      throw new Error("RCLONE_GDRIVE_REMOTE must be a safe rclone remote name");
    }
    return { default: fallbackRemote };
  }
  if (!raw.trim()) throw new Error("LETYCLAW_GDRIVE_ACCOUNTS must not be empty");

  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("LETYCLAW_GDRIVE_ACCOUNTS must be a JSON object");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) throw new Error("LETYCLAW_GDRIVE_ACCOUNTS must not be empty");

  const remotes: Record<string, string> = {};
  for (const [alias, remote] of entries) {
    if (!SAFE_ACCOUNT_PART.test(alias)) {
      throw new Error(`unsafe Google Drive account alias "${alias}"`);
    }
    if (typeof remote !== "string" || !SAFE_ACCOUNT_PART.test(remote)) {
      throw new Error(`unsafe rclone remote for Google Drive account "${alias}"`);
    }
    remotes[alias] = remote;
  }
  return remotes;
}

export interface DriveAccountConfig {
  remotes: Record<string, string>;
  defaultAccount: string;
}

/** Build a complete, fail-closed Drive account configuration from env values. */
export function buildDriveAccountConfig(env: NodeJS.ProcessEnv = process.env): DriveAccountConfig {
  const configuredFallback = env.RCLONE_GDRIVE_REMOTE?.trim() || "gdrive";
  const remotes = parseDriveAccounts(env.LETYCLAW_GDRIVE_ACCOUNTS, configuredFallback);
  const requested = env.LETYCLAW_GDRIVE_DEFAULT_ACCOUNT?.trim() || "default";
  if (!SAFE_ACCOUNT_PART.test(requested)) {
    throw new Error("LETYCLAW_GDRIVE_DEFAULT_ACCOUNT must be a safe account alias");
  }
  if (!Object.prototype.hasOwnProperty.call(remotes, requested)) {
    throw new Error(
      `default Google Drive account "${requested}" is not configured; set LETYCLAW_GDRIVE_DEFAULT_ACCOUNT`,
    );
  }
  return { remotes, defaultAccount: requested };
}

let driveConfig: DriveAccountConfig | null = null;
let driveConfigError: string | null = null;
try {
  driveConfig = buildDriveAccountConfig();
} catch (err) {
  driveConfigError = (err as Error).message;
  console.error(`[gdrive] disabled by invalid account configuration: ${driveConfigError}`);
}

const REMOTES = driveConfig?.remotes ?? {};
const DEFAULT_ACCOUNT = driveConfig?.defaultAccount ?? "default";
const RCLONE_CONFIG = process.env.RCLONE_CONFIG || "";

export function resolveDriveRemote(
  account: unknown,
  remotes: Record<string, string> = REMOTES,
  defaultAccount = DEFAULT_ACCOUNT,
): { remote: string; err?: string } {
  const key = (typeof account === "string" && account.trim()) || defaultAccount;
  const remote = remotes[key];
  if (!remote) {
    return { remote: "", err: `unknown account "${key}". Valid: ${Object.keys(remotes).join(", ")}` };
  }
  return { remote };
}

function resolveConfiguredDriveRemote(account: unknown): { remote: string; err?: string } {
  if (driveConfigError) {
    return {
      remote: "",
      err: `Google Drive account configuration is invalid: ${driveConfigError}`,
    };
  }
  return resolveDriveRemote(account);
}

function rcloneArgs(args: string[]): string[] {
  const base = RCLONE_CONFIG ? ["--config", RCLONE_CONFIG] : [];
  return [...base, ...args];
}

// When a folder_id is given, scope rclone to that folder as its root. This is
// what makes a shared/"shared with me" folder (e.g. pasted from a Drive
// /folders/<id> URL) browseable — those don't sit under the account's My Drive
// root, so a plain path-based listing can't reach them.
function rootFolderArgs(folderId: unknown): string[] {
  return typeof folderId === "string" && folderId
    ? ["--drive-root-folder-id", folderId]
    : [];
}

async function rclone(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await exec("rclone", rcloneArgs(args), {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

// ── Tool definitions ──────────────────────────────────────────────────

const CONFIGURED_ALIASES = Object.keys(REMOTES);
const ACCOUNT_PROP = {
  type: "string",
  ...(CONFIGURED_ALIASES.length ? { enum: CONFIGURED_ALIASES } : {}),
  description: `Configured Google Drive account alias. Defaults to '${DEFAULT_ACCOUNT}'.`,
} as const;

const FOLDER_ID_PROP = {
  type: "string",
  description: "Optional Google Drive folder ID — the token after '/folders/' in a Drive URL. Use this to browse a specific shared folder by ID instead of the account's My Drive root; `path` is then relative to that folder. Required for folders that are shared-with-me rather than owned, since those aren't reachable by path.",
} as const;

export const definitions: MCPToolDefinition[] = [
  {
    name: "gdrive_list",
    description:
      `List files and folders in Google Drive using a configured account alias (available: ${CONFIGURED_ALIASES.join(", ") || "none"}). Returns name, size, modification time, type (file/dir), and the Drive file ID (pass it to gdrive_read_by_id). Use path to browse subdirectories, or folder_id to browse a shared folder by its Drive ID.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Folder path to list (e.g. 'Documents/Reports'). Empty or '/' for root (or for the root of folder_id, if given).",
        },
        max_depth: {
          type: "number",
          description: "Recursion depth. 1 = immediate children only (default), 2+ = deeper.",
        },
        folder_id: FOLDER_ID_PROP,
        account: ACCOUNT_PROP,
      },
    },
  },
  {
    name: "gdrive_search",
    description:
      `Search for files in Google Drive by name pattern using a configured account alias (available: ${CONFIGURED_ALIASES.join(", ") || "none"}). Searches recursively across the entire drive. Returns matching file paths, sizes, and modification times.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Filename pattern to search for (case-insensitive). Supports glob patterns like '*.docx', '*budget*', 'Q1*report*'.",
        },
        path: {
          type: "string",
          description: "Folder to search within (optional, default: entire drive, or the root of folder_id if given).",
        },
        folder_id: FOLDER_ID_PROP,
        account: ACCOUNT_PROP,
      },
      required: ["query"],
    },
  },
  {
    name: "gdrive_read",
    description:
      `Read the contents of a file from Google Drive using a configured account alias (available: ${CONFIGURED_ALIASES.join(", ") || "none"}). Google Docs/Sheets/Slides are exported as plain text. Binary files return an error — use gdrive_list to check file types first.`,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Full path to the file (e.g. 'Documents/Reports/Q1.docx').",
        },
        max_bytes: {
          type: "number",
          description: "Maximum bytes to read (default: 500000 / ~500KB). Truncates large files.",
        },
        account: ACCOUNT_PROP,
      },
      required: ["path"],
    },
  },
  {
    name: "gdrive_read_by_id",
    description:
      `Read a Google Doc/Sheet/Slide by its Drive file ID (the long string in the doc URL after /d/). Useful when you have a docs.google.com URL but don't know the file's name or path. Configured account aliases: ${CONFIGURED_ALIASES.join(", ") || "none"}.`,
    inputSchema: {
      type: "object",
      properties: {
        file_id: {
          type: "string",
          description: "The Drive file ID — the long token in the URL, e.g. '188aNgAj4mQvOHe0HrFfNNX98VPL-dI4szC0kisTOjLY'.",
        },
        max_bytes: {
          type: "number",
          description: "Maximum bytes to read (default: 500000 / ~500KB). Truncates large files.",
        },
        account: ACCOUNT_PROP,
      },
      required: ["file_id"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

interface DriveEntry {
  Path: string;
  Name: string;
  Size: number;
  MimeType: string;
  ModTime: string;
  IsDir: boolean;
  ID?: string;
}

const handlers: Record<string, MCPHandler> = {
  async gdrive_list(args) {
    const { remote, err } = resolveConfiguredDriveRemote(args.account);
    if (err) return error(err);
    const path = (args.path as string) || "";
    const maxDepth = (args.max_depth as number) || 1;
    const remotePath = `${remote}:${path}`;

    try {
      const out = await rclone([
        "lsjson", remotePath,
        "--no-mimetype",
        "--max-depth", String(maxDepth),
        ...rootFolderArgs(args.folder_id),
      ]);
      const entries: DriveEntry[] = JSON.parse(out);

      if (entries.length === 0) {
        return ok("(empty folder)");
      }

      const lines = entries.map((e) => {
        const type = e.IsDir ? "📁" : "📄";
        const size = e.IsDir ? "" : ` (${formatSize(e.Size)})`;
        const mod = e.ModTime ? ` — ${e.ModTime.slice(0, 10)}` : "";
        const id = e.ID ? ` [id:${e.ID}]` : "";
        return `${type} ${e.Path}${size}${mod}${id}`;
      });

      return ok(`${entries.length} items in ${path || "/"}\n\n${lines.join("\n")}`);
    } catch (err) {
      return error(`gdrive_list failed: ${(err as Error).message}`);
    }
  },

  async gdrive_search(args) {
    const { remote, err } = resolveConfiguredDriveRemote(args.account);
    if (err) return error(err);
    const query = args.query as string;
    const path = (args.path as string) || "";
    const remotePath = `${remote}:${path}`;

    if (!query) return error("query is required");

    try {
      const out = await rclone([
        "lsjson", remotePath,
        "--recursive",
        "--no-mimetype",
        "--include", query,
        "--max-depth", "10",
        "--files-only",
        ...rootFolderArgs(args.folder_id),
      ], 60_000);
      const entries: DriveEntry[] = JSON.parse(out);

      if (entries.length === 0) {
        return ok(`No files matching "${query}" in ${path || "entire drive"}`);
      }

      const lines = entries.slice(0, 100).map((e) => {
        const size = ` (${formatSize(e.Size)})`;
        const id = e.ID ? ` [id:${e.ID}]` : "";
        return `📄 ${e.Path}${size}${id}`;
      });

      const truncated = entries.length > 100 ? `\n\n(showing 100 of ${entries.length} results)` : "";
      return ok(`${entries.length} results for "${query}"\n\n${lines.join("\n")}${truncated}`);
    } catch (err) {
      return error(`gdrive_search failed: ${(err as Error).message}`);
    }
  },

  async gdrive_read(args) {
    const { remote, err } = resolveConfiguredDriveRemote(args.account);
    if (err) return error(err);
    const path = args.path as string;
    const maxBytes = (args.max_bytes as number) || 500_000;

    if (!path) return error("path is required");

    const remotePath = `${remote}:${path}`;

    try {
      // --drive-export-formats: Google Docs→txt, Sheets→csv, Slides→txt
      const out = await rclone([
        "cat", remotePath,
        "--head", String(maxBytes),
        "--drive-export-formats", "txt,csv",
      ], 60_000);

      // Detect binary content (non-text bytes in first 512 chars)
      const sample = out.slice(0, 512);
      if (/[\x00-\x08\x0E-\x1F]/.test(sample)) {
        return error(
          `File "${path}" appears to be binary (docx/xlsx/pdf/etc). ` +
          `Only Google Docs/Sheets and plain text files can be read directly. ` +
          `For .docx/.xlsx, try downloading and converting, or ask the user to export it as a Google Doc.`
        );
      }

      if (!out.trim()) {
        return ok("(empty file)");
      }

      const truncated = out.length >= maxBytes ? "\n\n⚠️ File truncated — increase max_bytes to read more." : "";
      return ok(out + truncated);
    } catch (err) {
      return error(`gdrive_read failed: ${(err as Error).message}`);
    }
  },

  async gdrive_read_by_id(args) {
    const { remote, err } = resolveConfiguredDriveRemote(args.account);
    if (err) return error(err);
    const fileId = args.file_id as string;
    const maxBytes = (args.max_bytes as number) || 500_000;

    if (!fileId) return error("file_id is required");

    // `rclone backend copyid` exports the file to a temp dir, then we cat it.
    // Works for files in shared drives that aren't browseable from My Drive root.
    const tmpDir = `/tmp/letyclaw-gdrive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await rclone([
        "backend", "copyid", `${remote}:`,
        fileId, `${tmpDir}/`,
        "--drive-export-formats", "txt,csv",
        "--low-level-retries", "10",
      ], 90_000);

      const ls = await exec("ls", ["-1", tmpDir]);
      const file = ls.stdout.trim().split("\n")[0];
      if (!file) return error(`gdrive_read_by_id: nothing exported for ${fileId}`);

      const { stdout: content } = await exec("head", ["-c", String(maxBytes), `${tmpDir}/${file}`], {
        maxBuffer: 10 * 1024 * 1024,
      });

      const sample = content.slice(0, 512);
      if (/[\x00-\x08\x0E-\x1F]/.test(sample)) {
        return error(
          `File ${fileId} ("${file}") appears to be binary. Only Google Docs/Sheets/Slides export to text.`
        );
      }

      if (!content.trim()) return ok(`(empty file: ${file})`);
      const truncated = content.length >= maxBytes ? "\n\n⚠️ File truncated — increase max_bytes to read more." : "";
      return ok(`# ${file}\n\n${content}${truncated}`);
    } catch (err) {
      return error(`gdrive_read_by_id failed: ${(err as Error).message}`);
    } finally {
      // Best-effort cleanup; ignore errors.
      try { await exec("rm", ["-rf", tmpDir]); } catch {}
    }
  },
};

export { handlers };

// ── Helpers ───────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
