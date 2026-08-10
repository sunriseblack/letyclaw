import { readFileSync } from "fs";
import { loadVoiceRelayConfig } from "../services/voice-relay-config.js";

describe("voice relay network configuration", () => {
  it("binds to loopback by default", () => {
    expect(loadVoiceRelayConfig({})).toEqual({ host: "127.0.0.1", port: 8787 });
  });

  it("rejects malformed and out-of-range ports", () => {
    expect(() => loadVoiceRelayConfig({ VOICE_RELAY_PORT: "8787x" })).toThrow("between 1 and 65535");
    expect(() => loadVoiceRelayConfig({ VOICE_RELAY_PORT: "0" })).toThrow("between 1 and 65535");
    expect(() => loadVoiceRelayConfig({ VOICE_RELAY_PORT: "65536" })).toThrow("between 1 and 65535");
  });

  it("requires an explicit acknowledgement before public binding", () => {
    expect(() => loadVoiceRelayConfig({ VOICE_RELAY_HOST: "0.0.0.0" })).toThrow("Refusing non-loopback");
    expect(loadVoiceRelayConfig({
      VOICE_RELAY_HOST: "0.0.0.0",
      VOICE_RELAY_ALLOW_PUBLIC: "true",
    })).toEqual({ host: "0.0.0.0", port: 8787 });
  });
});

describe("voice-relay systemd confinement", () => {
  const unit = readFileSync(new URL("../systemd/voice-relay.service", import.meta.url), "utf8");
  const deployScript = readFileSync(new URL("../scripts/deploy-agents.sh", import.meta.url), "utf8");

  it("runs as the unprivileged letyclaw account with no Linux capabilities", () => {
    expect(unit).toMatch(/^User=letyclaw$/m);
    expect(unit).toMatch(/^Group=letyclaw$/m);
    expect(unit).not.toMatch(/^User=root$/m);
    expect(unit).toMatch(/^NoNewPrivileges=true$/m);
    expect(unit).toMatch(/^CapabilityBoundingSet=$/m);
  });

  it("uses private state and a loopback-only listener", () => {
    expect(unit).toMatch(/^StateDirectory=letyclaw-voice$/m);
    expect(unit).toMatch(/^ExecStart=\/usr\/bin\/env VOICE_RELAY_HOST=127\.0\.0\.1 VOICE_DB_PATH=\/var\/lib\/letyclaw-voice\/voice-calls\.sqlite \/usr\/bin\/node /m);
    expect(unit).toMatch(/^BindReadOnlyPaths=\/root\/letyclaw\/dist \/root\/letyclaw\/node_modules /m);
    expect(unit).not.toContain("/root/.nvm");
    expect(unit).toMatch(/^ExecStartPre=\+\/usr\/bin\/env VOICE_LEGACY_DB_PATH=\/root\/letyclaw\/voice-calls\.sqlite VOICE_DB_PATH=\/var\/lib\/letyclaw-voice\/voice-calls\.sqlite \/usr\/bin\/node /m);
    expect(unit).toMatch(/^ExecStartPre=\+\/usr\/bin\/chown -R letyclaw:letyclaw \/var\/lib\/letyclaw-voice$/m);
  });

  it("is synchronized but disabled and listener-gated during normal deploys", () => {
    expect(deployScript).toContain("systemctl disable --now voice-relay.service");
    expect(deployScript).not.toContain("RUNTIME_UNITS+=(voice-relay)");
    expect(deployScript).not.toContain("systemctl restart voice-relay");
    expect(deployScript).not.toContain("http://127.0.0.1:8787/health");
  });
});
