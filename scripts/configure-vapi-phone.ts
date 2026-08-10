#!/usr/bin/env node
/** Configure the owned Vapi number for dynamic inbound callback routing. */
const apiKey = process.env.VAPI_API_KEY?.trim() || "";
const phoneNumberId = process.env.VAPI_PHONE_NUMBER_ID?.trim() || "";
const serverUrl = process.env.VAPI_SERVER_URL?.trim() || "";
const credentialId = process.env.VAPI_SERVER_CREDENTIAL_ID?.trim() || "";

for (const [name, value] of Object.entries({
  VAPI_API_KEY: apiKey,
  VAPI_PHONE_NUMBER_ID: phoneNumberId,
  VAPI_SERVER_URL: serverUrl,
  VAPI_SERVER_CREDENTIAL_ID: credentialId,
})) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
}
let parsedServerUrl: URL;
try {
  parsedServerUrl = new URL(serverUrl);
} catch {
  console.error("VAPI_SERVER_URL must be a valid HTTPS URL");
  process.exit(1);
}
if (parsedServerUrl.protocol !== "https:" || parsedServerUrl.username || parsedServerUrl.password || parsedServerUrl.hash) {
  console.error("VAPI_SERVER_URL must use HTTPS without embedded credentials or a fragment");
  process.exit(1);
}

const endpoint = `https://api.vapi.ai/phone-number/${encodeURIComponent(phoneNumberId)}`;
const response = await fetch(endpoint, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    assistantId: null,
    squadId: null,
    workflowId: null,
    server: { url: serverUrl, credentialId },
  }),
  signal: AbortSignal.timeout(20_000),
});
const body = await response.text();
if (!response.ok) {
  console.error(`Vapi phone-number update failed (${response.status}): ${body.slice(0, 500)}`);
  process.exit(1);
}
const verifyResponse = await fetch(endpoint, {
  headers: { Authorization: `Bearer ${apiKey}` },
  signal: AbortSignal.timeout(20_000),
});
const verifyBody = await verifyResponse.text();
if (!verifyResponse.ok) {
  console.error(`Vapi phone-number verification failed (${verifyResponse.status}): ${verifyBody.slice(0, 500)}`);
  process.exit(1);
}
let configured: Record<string, unknown>;
try {
  const parsed = JSON.parse(verifyBody) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  configured = parsed as Record<string, unknown>;
} catch {
  console.error("Vapi phone-number verification returned invalid JSON");
  process.exit(1);
}
const configuredServer = configured.server && typeof configured.server === "object" && !Array.isArray(configured.server)
  ? configured.server as Record<string, unknown>
  : undefined;
if (configured.id !== phoneNumberId || configured.assistantId != null || configured.squadId != null ||
    configured.workflowId != null || configuredServer?.url !== serverUrl ||
    configuredServer?.credentialId !== credentialId) {
  console.error("Vapi phone-number readback does not match the requested dynamic routing configuration");
  process.exit(1);
}
console.log(`Configured Vapi phone number ${phoneNumberId} for dynamic inbound routing.`);
