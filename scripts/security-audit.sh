#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

check() {
  local description="$1"
  local command="$2"
  if eval "$command" > /dev/null 2>&1; then
    echo "  PASS: $description"
    ((PASS++))
  else
    echo "  FAIL: $description"
    ((FAIL++))
  fi
}

echo "=== Letyclaw Security Audit ==="
echo ""

# Network
echo "--- Network ---"
check "UFW is active" "sudo ufw status | grep -q 'Status: active'"

# Filesystem
echo "--- Filesystem ---"
check "Vault permissions 700" "test \$(stat -c %a ~/vault 2>/dev/null || stat -f %Lp ~/vault) = '700'"

# Services
echo "--- Services ---"
check "Letyclaw bot service active" "systemctl is-active letyclaw-bot"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ "$FAIL" -eq 0 ]; then
  echo "All checks passed."
else
  echo "ACTION REQUIRED: Fix failed checks before go-live."
  exit 1
fi
