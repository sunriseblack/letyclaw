#!/bin/bash
# Sync meeting transcriptions from a configured Google Drive folder.
# Required: GDRIVE_FOLDER_ID and LOCAL_DIR.

set -euo pipefail

: "${GDRIVE_FOLDER_ID:?Set GDRIVE_FOLDER_ID to the source Drive folder ID}"
: "${LOCAL_DIR:?Set LOCAL_DIR to the destination directory}"
RCLONE_REMOTE="${RCLONE_REMOTE:-gdrive}"
LOG="${SYNC_MEETINGS_LOG:-/var/log/letyclaw-sync-meetings.log}"

echo "[$(date -Is)] Starting sync" >> "$LOG"

rclone sync "${RCLONE_REMOTE}:" "$LOCAL_DIR" \
  --drive-root-folder-id "$GDRIVE_FOLDER_ID" \
  --drive-export-formats txt \
  --log-file "$LOG" \
  --log-level INFO \
  --timeout 60s \
  --retries 2

echo "[$(date -Is)] Sync complete" >> "$LOG"
