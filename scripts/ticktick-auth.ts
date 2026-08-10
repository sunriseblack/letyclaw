#!/usr/bin/env node
/**
 * TickTick OAuth2 setup — one-time authorization flow.
 *
 * Prerequisites:
 *   1. Register an app at https://developer.ticktick.com
 *      - Set redirect URL to: http://localhost:8888/callback
 *   2. Export the credentials in this shell:
 *        export TICKTICK_CLIENT_ID=xxx
 *        export TICKTICK_CLIENT_SECRET=yyy
 *   3. node dist/scripts/ticktick-auth.js
 *   4. Open the printed URL, authorize, done.
 *
 * Tokens are saved to TICKTICK_TOKEN_FILE (default
 * /root/letyclaw/sessions/.ticktick-tokens.json). After running this script
 * locally, scp the token file to the prod sessions/ directory — that
 * path is bot-writable inside the systemd sandbox.
 */

import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { writeFileSync } from "fs";

const CLIENT_ID = process.env.TICKTICK_CLIENT_ID;
const CLIENT_SECRET = process.env.TICKTICK_CLIENT_SECRET;
const TOKEN_FILE =
  process.env.TICKTICK_TOKEN_FILE ||
  "/root/letyclaw/sessions/.ticktick-tokens.json";
const REDIRECT_URI = "http://localhost:8888/callback";
const SCOPES = "tasks:read tasks:write";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Set TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET first.");
  process.exit(1);
}

const STATE = Math.random().toString(36).slice(2);
const authUrl =
  `https://ticktick.com/oauth/authorize?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&state=${STATE}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code`;

console.log("\n=== TickTick OAuth2 Setup ===\n");
console.log("Open this URL in your browser:\n");
console.log(authUrl);
console.log("\nWaiting for callback on http://localhost:8888 …\n");

interface TickTickTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = new URL(req.url!, "http://localhost:8888");
  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== STATE) {
    res.writeHead(400);
    res.end("Invalid state");
    return;
  }
  if (!code) {
    res.writeHead(400);
    res.end("Missing code");
    return;
  }

  try {
    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
    const tokenRes = await fetch("https://ticktick.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        scope: SCOPES,
        redirect_uri: REDIRECT_URI,
      }),
    });

    const text = await tokenRes.text();
    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
    }

    const parsed = JSON.parse(text) as TickTickTokenResponse;
    const tokens = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + parsed.expires_in,
      scope: parsed.scope,
    };

    writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
    console.log(`Tokens saved to ${TOKEN_FILE}`);
    console.log(`  Scope: ${tokens.scope}`);
    console.log(`  Expires: ${new Date(tokens.expires_at * 1000).toISOString()}`);
    if (!tokens.refresh_token) {
      console.warn("\nWARNING: TickTick did not return a refresh_token.");
      console.warn("You'll need to rerun this auth flow when the access token expires.");
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>TickTick authorized!</h1><p>You can close this tab.</p>");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Token exchange failed:", msg);
    res.writeHead(500);
    res.end(msg);
  }

  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 1000);
});

server.listen(8888);
