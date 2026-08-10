#!/usr/bin/env bash
set -euo pipefail

CREDENTIAL_HOME="${CLAUDE_CREDENTIAL_HOME:-/home/letyclaw}"
case "$CREDENTIAL_HOME" in
  /home/letyclaw|/root/letyclaw/sessions/connector-home) ;;
  *)
    echo "ERROR: unsupported Claude credential home: $CREDENTIAL_HOME"
    exit 1
    ;;
esac

if [ "$(id -un)" != "letyclaw" ]; then
  echo "ERROR: Claude credential refresh must run as the letyclaw user"
  exit 1
fi

CREDS="$CREDENTIAL_HOME/.claude/.credentials.json"
CLAUDE="${CLAUDE_PATH:-/usr/bin/claude}"
BUFFER_HOURS="${CLAUDE_REFRESH_BUFFER_HOURS:-2}"
MIN_FUTURE_MINUTES="${CLAUDE_REFRESH_MIN_FUTURE_MINUTES:-30}"
PROBE_TIMEOUT_SECONDS="${CLAUDE_REFRESH_PROBE_TIMEOUT_SECONDS:-75}"
LOCK_WAIT_SECONDS="${CLAUDE_REFRESH_LOCK_WAIT_SECONDS:-5}"
NODE="${CLAUDE_REFRESH_NODE:-/usr/bin/node}"
LOCK="$CREDENTIAL_HOME/.claude/.letyclaw-credential.lock"
PROBE_MARKER="LETYCLAW_CLAUDE_REFRESH_AUTH_OK_7D8D72"

for numeric_value in "$BUFFER_HOURS" "$MIN_FUTURE_MINUTES" "$PROBE_TIMEOUT_SECONDS" "$LOCK_WAIT_SECONDS"; do
  case "$numeric_value" in
    ""|*[!0-9]*)
      echo "ERROR: refresh timing values must be non-negative integers"
      exit 1
      ;;
  esac
done
if [ "$MIN_FUTURE_MINUTES" -lt 1 ] || [ "$PROBE_TIMEOUT_SECONDS" -lt 1 ]; then
  echo "ERROR: refresh future-expiry margin and probe timeout must be positive"
  exit 1
fi

exec 9>"$LOCK"
if ! flock -w "$LOCK_WAIT_SECONDS" 9; then
  echo "ERROR: another Claude credential refresh is still running"
  exit 1
fi

if [ ! -f "$CREDS" ]; then
  echo "ERROR: Credentials file not found: $CREDS"
  exit 1
fi

read_expiry() {
  "$NODE" -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const n = Number(c?.claudeAiOauth?.expiresAt);
    if (!Number.isSafeInteger(n) || n <= 0) process.exit(2);
    console.log(n);
  ' "$1"
}

expires_at=$(read_expiry "$CREDS") || {
  echo "ERROR: credentials contain no valid expiresAt"
  exit 1
}
now=$("$NODE" -e 'process.stdout.write(String(Date.now()))')
buffer=$((BUFFER_HOURS * 3600 * 1000))
remaining=$(( (expires_at - now) / 3600000 ))

echo "Token expires at: $("$NODE" -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$expires_at")"
echo "Hours remaining: $remaining"

if [ "$now" -le $((expires_at - buffer)) ]; then
  echo "Token still valid — no refresh needed."
  exit 0
fi

echo "Credential-file token expires within ${BUFFER_HOURS}h — refreshing in an isolated HOME..."
echo "NOTE: this does not rotate the CLAUDE_CODE_OAUTH_TOKEN setup token used by letyclaw-bot."

# Never mutate the live file while proving a refresh. Force a private copy to
# refresh, require a healthy auth-only result, and atomically install it only
# after its token material and expiry have both been validated.
TEMP_HOME=$(mktemp -d "$CREDENTIAL_HOME/.claude/.letyclaw-refresh.XXXXXX")
INSTALL_TMP=""
cleanup() {
  status=$?
  trap - EXIT INT TERM
  [ -z "$INSTALL_TMP" ] || rm -f "$INSTALL_TMP"
  rm -rf "$TEMP_HOME"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

install -d -m 700 "$TEMP_HOME/.claude"
install -m 600 "$CREDS" "$TEMP_HOME/.claude/.credentials.json"
if [ -f "$CREDENTIAL_HOME/.claude.json" ]; then
  install -m 600 "$CREDENTIAL_HOME/.claude.json" "$TEMP_HOME/.claude.json"
fi

CANDIDATE="$TEMP_HOME/.claude/.credentials.json"
"$NODE" -e '
  const fs = require("fs");
  const file = process.argv[1];
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  c.claudeAiOauth.expiresAt = Date.now() - 60000;
  fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
' "$CANDIDATE"

probe_status=0
probe_output=$(env \
  -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR \
  HOME="$TEMP_HOME" /usr/bin/timeout --signal=TERM --kill-after=5s "${PROBE_TIMEOUT_SECONDS}s" \
  "$CLAUDE" -p "Reply with exactly: $PROBE_MARKER" \
  --output-format json --max-turns 1 \
  --tools "" --strict-mcp-config --permission-mode dontAsk \
  --no-session-persistence --disable-slash-commands --no-chrome \
  2>"$TEMP_HOME/probe.stderr") || probe_status=$?

new_expires=$(read_expiry "$CANDIDATE") || {
  echo "ERROR: refreshed credentials contain no valid expiresAt"
  exit 1
}
if ! "$NODE" -e '
  const fs = require("fs");
  const previous = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))?.claudeAiOauth;
  const candidate = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))?.claudeAiOauth;
  const minFutureMs = Number(process.argv[3]);
  const candidateExpiry = Number(candidate?.expiresAt);
  const previousExpiry = Number(previous?.expiresAt);
  const tokenChanged = candidate?.accessToken !== previous?.accessToken ||
    candidate?.refreshToken !== previous?.refreshToken;
  const valid = typeof candidate?.accessToken === "string" && candidate.accessToken.length > 20 &&
    typeof candidate?.refreshToken === "string" && candidate.refreshToken.length > 20 &&
    Number.isSafeInteger(candidateExpiry) && Number.isSafeInteger(previousExpiry) &&
    candidateExpiry > previousExpiry && candidateExpiry > Date.now() + minFutureMs && tokenChanged;
  process.exit(valid ? 0 : 1);
' "$CREDS" "$CANDIDATE" "$((MIN_FUTURE_MINUTES * 60 * 1000))"; then
  echo "ERROR: refreshed credentials were unchanged, expired, too short-lived, or malformed."
  echo "Run: sudo -u letyclaw HOME=$CREDENTIAL_HOME claude auth login"
  exit 1
fi

# Installing the validated rotation precedes probe-result acceptance on purpose.
# OAuth refresh tokens may rotate server-side before the inference call returns;
# retaining the old live file after a timeout/wrong marker could permanently
# discard the only usable refresh token. A failed probe still exits non-zero and
# the connector service's OnFailure hook records the resulting live health.
LIVE_DIR=$(dirname "$CREDS")
INSTALL_TMP=$(mktemp "$LIVE_DIR/.credentials.json.install.XXXXXX")
install -m 600 "$CANDIDATE" "$INSTALL_TMP"
mv -f "$INSTALL_TMP" "$CREDS"
INSTALL_TMP=""

echo "Token rotation atomically installed. New expiry: $("$NODE" -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$new_expires")"

if [ "$probe_status" -ne 0 ] || ! printf '%s' "$probe_output" | "$NODE" -e '
  const expected = process.argv[1];
  let s = "";
  process.stdin.on("data", d => s += d).on("end", () => {
    try {
      const j = JSON.parse(s);
      const text = String(j.result || "").trim();
      process.exit(j.is_error === true || text !== expected ? 1 : 0);
    } catch { process.exit(1); }
  });
' "$PROBE_MARKER"; then
  echo "ERROR: rotated credentials were preserved, but the auth-only probe failed validation."
  echo "Run: sudo -u letyclaw HOME=$CREDENTIAL_HOME claude auth login"
  exit 1
fi

echo "Token refresh auth-only probe passed."
