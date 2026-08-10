import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { spawnSync } from "child_process";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";

const read = (relative: string): string =>
  readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

function runProvision(sourceText: string, symlinkSource = false) {
  const root = mkdtempSync(join(tmpdir(), "letyclaw-service-env-"));
  const realSource = join(root, "source.env");
  const source = symlinkSource ? join(root, "source-link.env") : realSource;
  const output = join(root, "etc");
  mkdirSync(output);
  writeFileSync(realSource, sourceText, { mode: 0o640 });
  chmodSync(realSource, 0o640);
  if (symlinkSource) symlinkSync(realSource, source);
  const result = spawnSync("bash", [resolve("scripts/provision-service-envs.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      SOURCE_ENV: source,
      BOT_SOURCE_ENV: source,
      SERVICE_ENV_ROOT: output,
      SERVICE_ENV_UID: String(process.getuid!()),
      SERVICE_ENV_GID: String(process.getgid!()),
      SOURCE_ENV_UID: String(process.getuid!()),
    },
  });
  return { root, output, result };
}

describe("small service secret and filesystem isolation", () => {
  it("gives the health webhook only its dedicated environment and data path", () => {
    const unit = read("systemd/health-webhook.service");
    expect(unit).toContain("EnvironmentFile=/etc/letyclaw-health-webhook/env");
    expect(unit).toContain("User=letyclaw-webhook");
    expect(unit).toContain("Group=letyclaw");
    expect(unit).toContain("StateDirectoryMode=0770");
    expect(unit).toContain("UMask=0007");
    expect(unit).toContain("BindReadOnlyPaths=/root/letyclaw/dist");
    expect(unit).toContain("ExecStart=/usr/bin/node /root/letyclaw/dist/services/health-webhook.js");
    expect(unit).not.toContain("/root/.nvm");
    expect(unit).toContain("BindPaths=/root/vault/health/daily-data");
    expect(unit).toContain("Environment=HOME=/tmp");
    expect(unit).toContain("InaccessiblePaths=/home");
    expect(unit).not.toContain("EnvironmentFile=/root/letyclaw/.env");
    expect(unit).not.toMatch(/BindReadOnlyPaths=.*\/root\/letyclaw(?:\s|$)/m);
    const deploy = read("scripts/deploy-agents.sh");
    expect(deploy).toContain("useradd --system --no-create-home");
    expect(deploy).toContain('chmod -R g+rwX,o-rwx "$VAULT_PATH/health/daily-data"');
    expect(deploy).toContain("install -d -o letyclaw -g letyclaw -m 0770 /var/lib/letyclaw-vapi/events");
    expect(deploy).toContain("backup_and_install_nginx");
    expect(deploy).toContain("nginx -t");
    expect(deploy).toContain("systemctl reload nginx");
    expect(deploy).toContain("nginx ingress update rolled back");
    expect(read("services/health-webhook.ts")).toContain("atomicWriteSharedJson");
    expect(read("services/shared-json-file.ts")).toContain("const SHARED_FILE_MODE = 0o660");
    expect(read("services/shared-json-file.ts")).toContain("chmodSync(temporary, SHARED_FILE_MODE)");
    expect(read("services/voice-call-monitor.ts")).toContain("chmodSync(eventDir, 0o770)");
  });

  it("keeps the optional relay away from the shared application environment", () => {
    const unit = read("systemd/voice-relay.service");
    expect(unit).toContain("EnvironmentFile=/etc/letyclaw-voice-relay/env");
    expect(unit).toContain("Environment=HOME=/tmp");
    expect(unit).toContain("InaccessiblePaths=/home");
    expect(unit).not.toContain("EnvironmentFile=/root/letyclaw/.env");
    expect(unit).not.toMatch(/BindReadOnlyPaths=.*\/root\/letyclaw(?:\s|$)/m);
  });

  it("gives the connector monitor no Telegram alert credential", () => {
    const unit = read("systemd/claude-connector-check.service");
    const check = read("scripts/check-connector-health.ts");
    expect(unit).toContain("Environment=HOME=/tmp");
    expect(unit).toContain("InaccessiblePaths=/home");
    expect(unit).toContain("BindReadOnlyPaths=/root/letyclaw/dist");
    expect(unit).toContain("Environment=CONNECTOR_CLAUDE_PATH=/usr/bin/claude");
    expect(unit).toContain("ExecStart=/usr/bin/node /root/letyclaw/dist/scripts/check-connector-health.js");
    expect(unit).not.toContain("/root/.nvm");
    expect(unit).not.toContain("EnvironmentFile=/etc/letyclaw-bot/env");
    expect(unit).not.toContain("EnvironmentFile=/etc/letyclaw-connector-health/env");
    expect(unit).not.toMatch(/BindReadOnlyPaths=.*\/root\/letyclaw(?:\s|$)/m);
    // lib.ts is shared with this dependency-isolated probe, so optional skill
    // parsing packages must never resolve at module import time.
    const lib = read("lib.ts");
    expect(lib).not.toMatch(/^import\s+.*\s+from\s+["']js-yaml["'];?$/m);
    expect(lib).toContain('requireFromLib("js-yaml")');
    expect(check).toContain('"--output-format", "stream-json"');
    expect(check).toContain('"--allowedTools", CONNECTOR_HEALTH_TOOL');
    expect(check).toContain('connectorCredentialLockPath(CONNECTOR_HOME)');
    expect(check).not.toContain('"--tools", ""');
    expect(check).not.toContain('"--strict-mcp-config"');
  });

  it("refreshes the isolated connector credential on its own bounded timer", () => {
    const service = read("systemd/claude-connector-refresh.service");
    const mainService = read("systemd/claude-token-refresh.service");
    const timer = read("systemd/claude-connector-refresh.timer");
    const mainTimer = read("systemd/claude-token-refresh.timer");
    const refresh = read("scripts/refresh-claude-token.sh");
    const deploy = read("scripts/deploy-agents.sh");

    expect(service).toContain("CLAUDE_CREDENTIAL_HOME=/root/letyclaw/sessions/connector-home");
    expect(service).toContain("OnSuccess=claude-connector-check.service");
    expect(service).toContain("OnFailure=claude-connector-check.service");
    expect(mainService).not.toContain("claude-connector-check.service");
    for (const unit of [service, mainService]) {
      expect(unit).toContain("User=letyclaw");
      expect(unit).toContain("Group=letyclaw");
      expect(unit).toContain("WorkingDirectory=/tmp");
      expect(unit).toContain("UMask=0077");
      expect(unit).toContain("TimeoutStartSec=100");
      expect(unit).not.toContain("CLAUDE_REFRESH_LOCK=");
      expect(unit).toContain("Environment=HOME=/tmp");
      expect(unit).toContain("ProtectSystem=strict");
      expect(unit).toContain("ProtectHome=tmpfs");
      expect(unit).toContain("Environment=CLAUDE_PATH=/usr/bin/claude");
      expect(unit).toContain("Environment=CLAUDE_REFRESH_NODE=/usr/bin/node");
      expect(unit).toContain("BindReadOnlyPaths=-/root/letyclaw/scripts/refresh-claude-token.sh");
      expect(unit).toContain("PrivateTmp=true");
      expect(unit).toContain("PrivateDevices=true");
      expect(unit).toContain("NoNewPrivileges=true");
    }
    expect(service).not.toContain("EnvironmentFile=");
    expect(service).toContain("BindPaths=/root/letyclaw/sessions/connector-home/.claude");
    expect(service).toContain("InaccessiblePaths=-/home/letyclaw");
    expect(service).not.toContain("BindPaths=/home/letyclaw/.claude");
    expect(mainService).toContain("BindPaths=/home/letyclaw/.claude");
    expect(mainService).toContain("InaccessiblePaths=-/root/letyclaw/sessions/connector-home");
    expect(mainService).not.toContain("BindPaths=/root/letyclaw/sessions/connector-home/.claude");
    for (const unit of [timer, mainTimer]) {
      expect(unit).toContain("OnUnitActiveSec=1h");
      expect(unit).toContain("AccuracySec=5min");
      expect(unit).toContain("Persistent=true");
    }
    expect(refresh).toContain('CREDENTIAL_HOME="${CLAUDE_CREDENTIAL_HOME:-/home/letyclaw}"');
    expect(refresh).toContain("/home/letyclaw|/root/letyclaw/sessions/connector-home");
    expect(refresh).toContain('LOCK="$CREDENTIAL_HOME/.claude/.letyclaw-credential.lock"');
    expect(refresh).toContain('mktemp -d "$CREDENTIAL_HOME/.claude/.letyclaw-refresh.XXXXXX"');
    expect(refresh).toContain("-u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CONFIG_DIR");
    expect(refresh).toContain('/usr/bin/timeout --signal=TERM --kill-after=5s "${PROBE_TIMEOUT_SECONDS}s"');
    expect(refresh).toContain('--tools "" --strict-mcp-config --permission-mode dontAsk');
    expect(refresh).toContain('--no-session-persistence --disable-slash-commands --no-chrome');
    expect(refresh).toContain('text !== expected');
    expect(refresh).toContain('candidateExpiry > Date.now() + minFutureMs && tokenChanged');
    expect(refresh).not.toContain("sudo -u letyclaw env");
    expect(deploy).toContain("claude-connector-refresh.service claude-connector-refresh.timer");
    expect(deploy).toContain("REFRESH_TIMERS=(claude-token-refresh.timer)");
    expect(deploy).toContain("REFRESH_TIMERS+=(claude-auth-check.timer)");
    expect(deploy).toContain('if [ "$LETYCLAW_ENABLE_CONNECTORS" = "1" ]; then');
    expect(deploy).toContain("REFRESH_TIMERS+=(claude-connector-refresh.timer claude-connector-check.timer)");
    expect(deploy).toContain('for timer in "${REFRESH_TIMERS[@]}"');
    expect(spawnSync("bash", ["-n", resolve("scripts/refresh-claude-token.sh")]).status).toBe(0);
  });

  it("allowlists service variables without sourcing or logging values", () => {
    const provision = read("scripts/provision-service-envs.sh");
    expect(provision).toContain("HEALTH_WEBHOOK_SECRET HEALTH_WEBHOOK_PORT HEALTH_WEBHOOK_MAX_BODY_BYTES VAULT_PATH");
    expect(provision).toContain("VAPI_WEBHOOK_SECRET VAPI_ASSISTANT_ID VAPI_SERVER_URL VAPI_SERVER_CREDENTIAL_ID VAPI_INBOUND_TOPIC_ID");
    expect(provision).toContain("ANTHROPIC_API_KEY VOICE_DEFAULT_MODEL");
    expect(provision).not.toContain("TELEGRAM_BOT_TOKEN");
    expect(provision).not.toContain("TELEGRAM_GROUP_ID");
    expect(provision).not.toMatch(/(?:^|\s)(?:source|\.)\s+["']?\$SOURCE_ENV/m);
    expect(provision).not.toContain("cat \"$SOURCE_ENV\"");
  });

  it("functionally publishes only allowlisted keys with root-style modes", () => {
    const fixture = runProvision([
      "HEALTH_WEBHOOK_SECRET=health-value",
      "HEALTH_WEBHOOK_PORT=8788",
      "VAPI_WEBHOOK_SECRET=vapi-webhook-value",
      "VAPI_ASSISTANT_ID=assistant-id",
      "VAPI_SERVER_URL=https://example.test/voice/vapi",
      "VAPI_SERVER_CREDENTIAL_ID=credential-id",
      "VAPI_INBOUND_TOPIC_ID=77",
      "ANTHROPIC_API_KEY=anthropic-value",
      "TELEGRAM_GROUP_ID=-100123",
      "TELEGRAM_BOT_TOKEN=must-not-copy",
      "VAPI_API_KEY=must-not-copy-either",
      "",
    ].join("\n"));
    try {
      expect(fixture.result.status).toBe(0);
      const health = join(fixture.output, "letyclaw-health-webhook", "env");
      const voice = join(fixture.output, "letyclaw-voice-relay", "env");
      const connector = join(fixture.output, "letyclaw-connector-health", "env");
      expect(readFileSync(health, "utf8")).toBe(
        "HEALTH_WEBHOOK_SECRET=health-value\nHEALTH_WEBHOOK_PORT=8788\n" +
        "VAPI_WEBHOOK_SECRET=vapi-webhook-value\nVAPI_ASSISTANT_ID=assistant-id\n" +
        "VAPI_SERVER_URL=https://example.test/voice/vapi\nVAPI_SERVER_CREDENTIAL_ID=credential-id\n" +
        "VAPI_INBOUND_TOPIC_ID=77\n",
      );
      expect(readFileSync(voice, "utf8")).toBe("ANTHROPIC_API_KEY=anthropic-value\n");
      expect(existsSync(connector)).toBe(false);
      expect(lstatSync(health).mode & 0o777).toBe(0o600);
      expect(lstatSync(voice).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(fixture.output, "letyclaw-health-webhook")).mode & 0o777).toBe(0o700);
      expect(readFileSync(health, "utf8")).not.toContain("must-not-copy");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps disk-capacity monitoring journal-only and removes the legacy credential path", () => {
    const check = read("scripts/check-disk.sh");
    expect(check).toContain("logger -p daemon.warning -t disk-monitor");
    expect(check).not.toMatch(/api\.telegram\.org|BOT_TOKEN|CHAT_ID|\bcurl\b/);
    const deploy = read("scripts/deploy-agents.sh");
    expect(deploy).not.toContain("/root/check_disk_telegram.sh");
    expect(deploy).not.toMatch(/install[^\n]*scripts\/check-disk\.sh/);
    expect(deploy).toContain("rm -f /etc/letyclaw-connector-health/env");
  });

  it("keeps auth and connector monitor transitions journal-only", () => {
    for (const path of ["scripts/check-claude-auth.ts", "scripts/check-connector-health.ts"]) {
      const source = read(path);
      expect(source, path).not.toMatch(/api\.telegram\.org|sendTelegram|TELEGRAM_BOT_TOKEN|TELEGRAM_GROUP_ID/);
      expect(source, path).toContain("user_visible=false");
      expect(source, path).toContain('process.exitCode = 1');
    }
    expect(read("systemd/claude-auth-check.service")).toContain(
      "UnsetEnvironment=TELEGRAM_BOT_TOKEN TELEGRAM_GROUP_ID CLAUDE_AUTH_ALERT_TOPIC",
    );
    const bot = read("bot.ts");
    expect(bot).toContain('runtimeHealthLine("Claude provider auth", ".claude-auth-monitor.json")');
    expect(bot).toContain('runtimeHealthLine("Claude connectors", ".connector-health-monitor.json")');
  });

  it("keeps manual cron retries inside the normal signal-only scheduler", () => {
    const source = read("scripts/run-cron-once.mjs");
    expect(source).toContain("handlers.cron_run");
    expect(source).not.toMatch(/api\.telegram\.org|TELEGRAM_BOT_TOKEN|TELEGRAM_GROUP_ID|from ["']child_process["']|\bfetch\s*\(/);
  });

  it("deploys shared and routed instructions as separate trust scopes", () => {
    const deploy = read("scripts/deploy-agents.sh");
    const bot = read("bot.ts");
    const unit = read("systemd/letyclaw-bot.service");
    expect(deploy).toContain('DOMAIN_DST="$VAULT_PATH/.letyclaw/domains"');
    expect(deploy).toContain('cp "$f" "$DOMAIN_STAGE/$(basename "$f")"');
    expect(deploy).toContain('chown -R root:letyclaw "$VAULT_PATH/.claude" "$VAULT_PATH/.letyclaw"');
    expect(deploy).not.toMatch(/for f in "\$SRC"\/domains\/\*\.md;[\s\S]{0,120}\bcat "\$f"/);
    expect(bot).toContain("loadDomainContext(agentId");
    expect(bot).toContain('"--append-system-prompt"');
    expect(unit).toContain("Environment=CLAUDE_PATH=/usr/bin/claude");
    expect(unit).toContain("ExecStart=/usr/bin/node dist/bot.js");
    expect(unit).toContain("BindReadOnlyPaths=/root/letyclaw -/root/.local -/root/.config/rclone");
    expect(unit).toContain("BindReadOnlyPaths=/root/vault/CLAUDE.md /root/vault/TOOLS.md -/root/vault/.letyclaw -/root/vault/.claude");
  });

  it("keeps public deployment runtime boundaries explicit", () => {
    const deploy = read("scripts/deploy-agents.sh");
    expect(existsSync(new URL("../.github/workflows/deploy.yml", import.meta.url))).toBe(false);
    expect(deploy).toContain('LETYCLAW_DEFER_RUNTIME_RESTARTS:-0');
    expect(deploy).toContain('LETYCLAW_DEFER_BOT_RESTART:-0');
    expect(deploy).toContain('LETYCLAW_DEFER_MCP_SETUP:-0');
    expect(deploy).toContain('bash "$REPO_PATH/scripts/setup-mcp.sh" "$REPO_PATH"');
    expect(deploy).toContain('RUNTIME_UNITS=(letyclaw-bot)');
    expect(deploy).toContain('RUNTIME_UNITS+=(health-webhook)');
    const setupMcp = read("scripts/setup-mcp.sh");
    const archiveIndex = setupMcp.indexOf("Archived legacy browser profile outside the synced vault");
    const commitIndex = setupMcp.lastIndexOf("trap - EXIT INT TERM");
    expect(archiveIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(archiveIndex);
    expect(setupMcp).toContain('BROWSER_ROLLBACK_OK=1');
    expect(setupMcp).toContain('Previous browser/MCP runtime restored and verified');
    expect(setupMcp).toContain('LETYCLAW_STOP_RUNTIME_ON_MCP_ROLLBACK_FAILURE:-0');
    expect(setupMcp).toContain('systemctl stop letyclaw-bot health-webhook');
    expect(setupMcp).toContain('EMAIL_MCP_VERSION="0.2.3"');
    expect(setupMcp).toContain('LETYCLAW_ENABLE_EMAIL_MCP="${LETYCLAW_ENABLE_EMAIL_MCP:-0}"');
    expect(setupMcp).toContain('actual_uid=$(stat -c %u "$config_path"');
    expect(setupMcp).toContain('[ $((8#$mode & 8#077)) -eq 0 ]');
    expect(setupMcp).toContain("read_only[[:space:]]*=[[:space:]]*true");
    expect(setupMcp).toContain("MCP_EMAIL_READ_ONLY=true");
    expect(setupMcp).toContain('"$NPX_BIN" -y "@codefuturist/email-mcp@${EMAIL_MCP_VERSION}" stdio');
  });

  it("drains cron message sidecars on start, success, and failure", () => {
    const source = read("bot.ts");
    const start = source.indexOf("async function runClaudeForCron");
    const end = source.indexOf("function recordCronMessageIds", start);
    const runner = source.slice(start, end);
    expect(runner.match(/drainPendingMessageIds\(SESSIONS_DIR, topicId\)/g)).toHaveLength(3);
    expect(runner).toContain("directMessageCount: pendingIds.length");
    expect(runner).toContain("terminalError.safeToRetryClaudeAttempt = false");
  });

  it("gives detached sessions no direct Telegram delivery tools", () => {
    const source = read("tools/letyclaw-mcp/tools/sessions.ts");
    for (const tool of [
      "message_send", "message_typing", "message_buttons", "message_poll",
      "message_react", "message_edit", "message_document",
    ]) {
      expect(source).toContain(`mcp__letyclaw-tools__${tool}`);
    }
  });

  it("keeps voice approval free of queued progress messages and timing telemetry", () => {
    const source = read("bot.ts");
    expect(source).not.toContain("Call queued.");
    expect(source).not.toContain("Long voice note (~");
    expect(source).not.toMatch(/editButtons\(`✓ \$\{result\.summary\} \(\$\{\(ms/);
  });

  it.each([
    ["missing", "TELEGRAM_BOT_TOKEN=x\n"],
    ["empty", "HEALTH_WEBHOOK_SECRET=\n"],
    ["quoted empty", 'HEALTH_WEBHOOK_SECRET=""\n'],
    ["duplicate", "HEALTH_WEBHOOK_SECRET=a\nHEALTH_WEBHOOK_SECRET=b\n"],
  ])("rejects a %s required health secret", (_label, sourceText) => {
    const fixture = runProvision(sourceText);
    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).not.toContain("TELEGRAM_BOT_TOKEN=x");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked shared source environment", () => {
    const fixture = runProvision("HEALTH_WEBHOOK_SECRET=x\n", true);
    try {
      expect(fixture.result.status).not.toBe(0);
      expect(fixture.result.stderr).toContain("must not be a symlink");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("never logs malformed health payload content", () => {
    const source = read("services/health-webhook.ts");
    expect(source).not.toContain("body_preview");
    expect(source).not.toContain("body.slice(");
    expect(source).toContain("body_bytes=${bodyBytes}, invalid_json");
  });

  it("keeps Vapi lifecycle events separate and answers assistant requests gracefully", () => {
    const source = read("services/health-webhook.ts");
    expect(source).toContain('req.url === "/voice/vapi"');
    expect(source).toContain('req.headers.authorization !== `Bearer ${VAPI_SECRET}`');
    expect(source).toContain('if (eventType === "assistant-request")');
    expect(source).toContain('res.writeHead(200');
    expect(source).toContain('"error":"Sorry, this line cannot take the call right now."');
    expect(source.indexOf('if (eventType === "assistant-request")')).toBeLessThan(source.indexOf("saveVapiEvent(payload, body)"));
    expect(source).toContain("Buffer.concat(bodyChunks).toString(\"utf8\")");
    expect(source).not.toContain("body += chunk");
    expect(source).toContain("readVapiInboundContext(callerNumber)");
    expect(source).toContain("record(message.customer) || record(call?.customer) || record(payload.customer)");
    expect(source).toContain("letyclaw_parent_local_id: context.localId");
  });

  it("configures inbound Vapi routing without a stale assistant, squad, or workflow", () => {
    const source = read("scripts/configure-vapi-phone.ts");
    expect(source).toContain("assistantId: null");
    expect(source).toContain("squadId: null");
    expect(source).toContain("workflowId: null");
    expect(source).toContain("const verifyResponse = await fetch(endpoint");
    expect(source).toContain("phone-number readback does not match");
  });
});
