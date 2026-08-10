# Encrypted vault backup

A Letyclaw vault can contain private documents, health or financial records,
browser artifacts, and connector credentials. Live browser cookies stay
outside the synced vault in `/var/lib/letyclaw-browser/`. Never upload a raw
vault archive: encrypt it locally with a dedicated public key and keep the
matching recovery key off the server.

## Destination and exclusions

Set a dedicated rclone folder in `/etc/letyclaw-backup/env`:

```dotenv
BACKUP_RCLONE_DEST=gdrive:letyclaw-backups/vault
BACKUP_GPG_RECIPIENT=<full fingerprint of the recovery public key>
```

The remote name is deployment-defined. If its rclone section contains a
non-empty `team_drive`, the script fails closed unless
`BACKUP_ALLOW_SHARED_DRIVE=1` is set after an explicit privacy and retention
review.

By default the archive excludes runtime state that is rebuildable,
consistency-sensitive, or especially dangerous to replicate:

- legacy `browser-profiles/` directories;
- `.gdrive/` and per-domain `.gmail/` connector credentials;
- `node_modules/`;
- memory-search SQLite databases, WALs, and SHMs.

Set `BACKUP_INCLUDE_RUNTIME_STATE=1` only when its recovery value outweighs the
additional credential and live-file risks.

## One-time key setup

Generate a dedicated recovery key on a trusted workstation. Store and test the
private key in at least two protected off-host locations. Export only the
public key to the server:

```bash
gpg --armor --export <fingerprint> > letyclaw-backup-public-key.asc
scp letyclaw-backup-public-key.asc root@server:/root/

sudo install -d -o root -g root -m 0700 /etc/letyclaw-backup/gnupg
sudo gpg --homedir /etc/letyclaw-backup/gnupg \
  --import /root/letyclaw-backup-public-key.asc
sudo gpg --homedir /etc/letyclaw-backup/gnupg \
  --with-colons --fingerprint
sudo install -o root -g root -m 0600 /dev/null /etc/letyclaw-backup/env
sudoedit /etc/letyclaw-backup/env
```

Confirm the displayed fingerprint out of band before adding it to the env file.
Do not commit either key or a deployment fingerprint to this repository.

The canonical rclone config contains OAuth credentials. It must be root-owned,
mode `0640`, and readable only by the configured runtime group:

```bash
sudo chown root:letyclaw /root/.config/rclone/rclone.conf
sudo chmod 0640 /root/.config/rclone/rclone.conf
```

Validate without uploading:

```bash
sudo install -d -o root -g root -m 0700 /var/lib/letyclaw-vault-backup
sudo systemctl start vault-backup.service
sudo journalctl -u vault-backup.service -n 100 --no-pager
```

`ExecStartPre` runs `vault-backup.sh --check-config` before any upload. On first
validation, the script seeds a private mode-`0600` rclone config in systemd's
StateDirectory. Later runs preserve that writable copy so refreshed OAuth
tokens are not rolled back from the canonical source.

The script rejects symlinks, unexpected ownership/modes, hard-linked configs,
remote roots, path traversal, missing encryption keys, and unapproved shared
drives.

## First backup and restore drill

Leave the timer disabled until one backup and restore drill succeeds:

```bash
sudo systemctl start vault-backup.service
sudo journalctl -u vault-backup.service -n 100 --no-pager
# Download one object on a trusted workstation, decrypt it, list it, and extract
# it into a temporary directory before enabling automation.
sudo systemctl enable --now vault-backup.timer
```

Each run uploads an immutable timestamped archive and compares the remote
SHA-256 with the local encrypted object. Retention runs only after verification,
matches only Letyclaw vault archive names, and has a bounded delete count.
