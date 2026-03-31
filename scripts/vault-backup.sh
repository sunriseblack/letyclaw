#!/usr/bin/env bash
set -euo pipefail

# Daily vault backup
# Configure BACKUP_DEST to point to your backup destination (S3, rsync, local path, etc.)

VAULT_PATH="${VAULT_PATH:-$HOME/vault}"
BACKUP_DIR="/tmp/vault-backup"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_FILE="vault-${TIMESTAMP}.tar.gz"
BACKUP_DEST="${BACKUP_DEST:-$HOME/backups}"

mkdir -p "$BACKUP_DIR"
mkdir -p "$BACKUP_DEST"

echo "$(date): Starting vault backup..."
tar -czf "$BACKUP_DIR/$BACKUP_FILE" -C "$(dirname "$VAULT_PATH")" "$(basename "$VAULT_PATH")"

echo "$(date): Copying to $BACKUP_DEST..."
cp "$BACKUP_DIR/$BACKUP_FILE" "$BACKUP_DEST/"

rm -f "$BACKUP_DIR/$BACKUP_FILE"
echo "$(date): Backup complete — $BACKUP_FILE"

# Cleanup old backups (keep last 30 days)
find "$BACKUP_DEST" -name "vault-*.tar.gz" -mtime +30 -delete 2>/dev/null || true
