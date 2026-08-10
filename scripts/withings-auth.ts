#!/usr/bin/env node
/**
 * Withings OAuth2 Setup — one-time authorization flow.
 *
 * 1. Register app at https://developer.withings.com/dashboard/
 *    - Set callback URL to: http://localhost:8888/callback
 * 2. export WITHINGS_CLIENT_ID=xxx WITHINGS_CLIENT_SECRET=yyy
 * 3. node scripts/withings-auth.js
 * 4. Open the printed URL in your browser, authorize, done.
 *
 * Saves tokens to WITHINGS_TOKEN_FILE (default /root/letyclaw/sessions/.withings-tokens.json).
 * Must live in a bot-writable path: /root/letyclaw/ is bind-mounted read-only in
 * the systemd sandbox, only sessions/ and logs/ are writable.
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { writeFileSync } from "fs";

const CLIENT_ID = process.env.WITHINGS_CLIENT_ID;
const CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET;
const TOKEN_FILE = process.env.WITHINGS_TOKEN_FILE || "/root/letyclaw/sessions/.withings-tokens.json";
const REDIRECT_URI = "http://localhost:8888/callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET first.");
  process.exit(1);
}

const STATE = Math.random().toString(36).slice(2);
const authUrl =
  `https://account.withings.com/oauth2_user/authorize2?` +
  `response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=user.metrics&state=${STATE}`;

console.log("\n=== Withings OAuth2 Setup ===\n");
console.log("Open this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for callback on http://localhost:8888 …\n");

const server = createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url!, "http://localhost:8888");
  if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== STATE) {
    res.writeHead(400); res.end("Invalid state"); return;
  }

  try {
    const tokenRes = await fetch("https://wbsapi.withings.net/v2/oauth2", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        action: "requesttoken",
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code: code!,
        redirect_uri: REDIRECT_URI,
      }),
    });
    const json: unknown = await tokenRes.json();
    const parsed = json as { status: number; body: { access_token: string; refresh_token: string; expires_in: number; userid: string } };
    if (parsed.status !== 0) throw new Error(JSON.stringify(json));

    const b = parsed.body;
    const tokens = {
      access_token: b.access_token,
      refresh_token: b.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + b.expires_in,
      user_id: b.userid,
    };

    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log(`Tokens saved to ${TOKEN_FILE}`);
    console.log(`  User ID: ${tokens.user_id}`);
    console.log(`  Expires: ${new Date(tokens.expires_at * 1000).toISOString()}`);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Withings authorized!</h1><p>You can close this tab.</p>");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Token exchange failed:", msg);
    res.writeHead(500); res.end(msg);
  }

  setTimeout(() => { server.close(); process.exit(0); }, 1000);
});

server.listen(8888);
