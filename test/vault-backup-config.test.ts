import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; sourceConfig: string; privateConfig: string; state: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "letyclaw-backup-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  const vault = join(root, "vault");
  const gnupg = join(root, "gnupg");
  const sourceConfig = join(root, "rclone-source.conf");
  const state = join(root, "state");
  const privateConfig = join(state, "rclone.conf");
  mkdirSync(bin);
  mkdirSync(vault);
  mkdirSync(gnupg);
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  writeFileSync(
    sourceConfig,
    "[gdrive]\ntype = drive\ntoken = old\n\n" +
      "[gdrive_org]\ntype = drive\nteam_drive = organization-drive-id\ntoken = organization\n",
    { mode: 0o640 },
  );
  chmodSync(sourceConfig, 0o640);

  const rclone = join(bin, "rclone");
  writeFileSync(rclone, `#!/usr/bin/env bash
if [ "$1" != listremotes ]; then exit 2; fi
config=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = --config ]; then shift; config="$1"; fi
  shift
done
[ -f "$config" ] || exit 3
grep -q '^\\[gdrive\\]$' "$config" && printf 'gdrive:\\n'
grep -q '^\\[gdrive_org\\]$' "$config" && printf 'gdrive_org:\\n'
exit 0
`);
  chmodSync(rclone, 0o755);
  const gpg = join(bin, "gpg");
  writeFileSync(gpg, "#!/usr/bin/env bash\nprintf 'pub:u:2048:1:ABC:0:0::::::\\nfpr:::::::::0123456789ABCDEF0123456789ABCDEF01234567:\\n'\n");
  chmodSync(gpg, 0o755);
  const flock = join(bin, "flock");
  writeFileSync(flock, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(flock, 0o755);

  return {
    root,
    sourceConfig,
    privateConfig,
    state,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      VAULT_PATH: vault,
      BACKUP_STATE_DIR: state,
      RCLONE_CONFIG: privateConfig,
      RCLONE_CONFIG_SOURCE: sourceConfig,
      BACKUP_EXPECTED_UID: String(process.getuid?.() ?? 0),
      BACKUP_EXPECTED_GID: String(process.getgid?.() ?? 0),
      BACKUP_RCLONE_SOURCE_GID: String(process.getgid?.() ?? 0),
      BACKUP_GPG_HOMEDIR: gnupg,
      BACKUP_RCLONE_DEST: "gdrive:letyclaw-backups/vault",
    },
  };
}

function validate(env: NodeJS.ProcessEnv) {
  return spawnSync("bash", [resolve("scripts/vault-backup.sh"), "--check-config"], {
    env,
    encoding: "utf8",
  });
}

describe("vault backup fail-closed configuration", () => {
  it("requires a public-key recipient by default", () => {
    const { env } = fixture();
    const result = validate(env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BACKUP_GPG_RECIPIENT is required");
  });

  it("accepts the personal gdrive folder with an installed recipient", () => {
    const { env, privateConfig } = fixture();
    const result = validate({ ...env, BACKUP_GPG_RECIPIENT: "0123456789ABCDEF" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("destination=gdrive:letyclaw-backups/vault encryption=gpg");
    expect(readFileSync(privateConfig, "utf8")).toContain("token = old");
  });

  it("refuses an organizational drive without an explicit privacy override", () => {
    const { env } = fixture();
    const result = validate({
      ...env,
      BACKUP_GPG_RECIPIENT: "0123456789ABCDEF",
      BACKUP_RCLONE_DEST: "gdrive_org:letyclaw-backups/vault",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("shared/team drive");
  });

  it("refuses plaintext unless it is doubly explicit", () => {
    const { env } = fixture();
    const result = validate({ ...env, BACKUP_ENCRYPTION: "none" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("BACKUP_ALLOW_PLAINTEXT=1");
  });

  it("reuses refreshed private config instead of rolling it back from canonical source", () => {
    const { env, privateConfig, sourceConfig } = fixture();
    const configured = { ...env, BACKUP_GPG_RECIPIENT: "0123456789ABCDEF" };
    expect(validate(configured).status).toBe(0);
    writeFileSync(privateConfig, "[gdrive]\ntype = drive\ntoken = refreshed\n", { mode: 0o600 });
    writeFileSync(sourceConfig, "[gdrive]\ntype = drive\ntoken = stale-source\n", { mode: 0o640 });
    expect(validate(configured).status).toBe(0);
    expect(readFileSync(privateConfig, "utf8")).toContain("token = refreshed");
    expect(readFileSync(privateConfig, "utf8")).not.toContain("stale-source");
  });

  it("rejects a symlinked private config instead of following it", () => {
    const { env, privateConfig, sourceConfig } = fixture();
    symlinkSync(sourceConfig, privateConfig);
    const result = validate({ ...env, BACKUP_GPG_RECIPIENT: "0123456789ABCDEF" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not be a symlink");
  });

  it("rejects world-readable canonical credentials before seeding", () => {
    const { env, sourceConfig, privateConfig } = fixture();
    chmodSync(sourceConfig, 0o644);
    const result = validate({ ...env, BACKUP_GPG_RECIPIENT: "0123456789ABCDEF" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be mode 640");
    expect(() => readFileSync(privateConfig)).toThrow();
  });

  it("rejects canonical credentials owned by an unapproved reader group", () => {
    const { env } = fixture();
    const currentGid = Number(process.getgid?.() ?? 0);
    const result = validate({
      ...env,
      BACKUP_GPG_RECIPIENT: "0123456789ABCDEF",
      BACKUP_RCLONE_SOURCE_GID: String(currentGid + 1),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("approved reader gid");
  });

  it("rejects an existing private config unless it is mode 0600", () => {
    const { env, privateConfig } = fixture();
    writeFileSync(privateConfig, "[gdrive]\ntype = drive\n", { mode: 0o644 });
    chmodSync(privateConfig, 0o644);
    const result = validate({ ...env, BACKUP_GPG_RECIPIENT: "0123456789ABCDEF" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("private rclone config must have mode 600");
  });

  it("rejects a symlinked StateDirectory", () => {
    const { root, env, state } = fixture();
    const realState = join(root, "real-state");
    rmSync(state, { recursive: true });
    mkdirSync(realState, { mode: 0o700 });
    symlinkSync(realState, state);
    const result = validate({ ...env, BACKUP_GPG_RECIPIENT: "0123456789ABCDEF" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("StateDirectory must not be a symlink");
  });

  it("rejects a private config that no longer contains the selected remote", () => {
    const { env, privateConfig } = fixture();
    writeFileSync(privateConfig, "[unrelated]\ntype = local\n", { mode: 0o600 });
    chmodSync(privateConfig, 0o600);
    const result = validate({ ...env, BACKUP_GPG_RECIPIENT: "0123456789ABCDEF" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not contain remote: gdrive");
  });
});

describe("vault backup systemd persistence boundary", () => {
  it("keeps the canonical config read-only and gives rclone a private writable StateDirectory", () => {
    const unit = readFileSync(resolve("systemd/vault-backup.service"), "utf8");
    expect(unit).toContain("StateDirectory=letyclaw-vault-backup");
    expect(unit).toContain("StateDirectoryMode=0700");
    expect(unit).toContain("RCLONE_CONFIG=/var/lib/letyclaw-vault-backup/rclone.conf");
    expect(unit).toContain("RCLONE_CONFIG_SOURCE=/root/.config/rclone/rclone.conf");
    expect(unit).toMatch(/^ReadOnlyPaths=.*\/root\/\.config\/rclone/m);
    expect(unit).not.toMatch(/^ReadOnlyPaths=.*\/var\/lib\/letyclaw-vault-backup/m);
  });
});
