export interface VoiceRelayConfig {
  host: string;
  port: number;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The relay defaults to loopback because exposing an unauthenticated WebSocket
 * directly to the internet would let arbitrary clients consume the voice API.
 * A reverse proxy can terminate TLS and forward /ws to this listener. Direct
 * public binding remains possible, but requires an explicit risk acknowledgement.
 */
export function loadVoiceRelayConfig(env: NodeJS.ProcessEnv = process.env): VoiceRelayConfig {
  const rawPort = env.VOICE_RELAY_PORT?.trim() || "8787";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("VOICE_RELAY_PORT must be an integer between 1 and 65535");
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("VOICE_RELAY_PORT must be an integer between 1 and 65535");
  }

  const host = env.VOICE_RELAY_HOST?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) && env.VOICE_RELAY_ALLOW_PUBLIC !== "true") {
    throw new Error(
      "Refusing non-loopback VOICE_RELAY_HOST without VOICE_RELAY_ALLOW_PUBLIC=true; use a TLS reverse proxy instead",
    );
  }

  return { host, port };
}
