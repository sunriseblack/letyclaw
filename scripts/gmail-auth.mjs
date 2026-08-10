#!/usr/bin/env node
/**
 * One-time OAuth grant helper for letyclaw's Gmail integration.
 *
 * Usage:
 *   node scripts/gmail-auth.mjs <account-alias> <email-address> [client_secret.json]
 *
 *   account-alias     safe local name, for example: default | work
 *   email-address     Google account to authorize and use as the login hint
 *   client_secret.json defaults to ~/Downloads/client_secret.json (the file
 *                     Google Cloud Console gives you for a Desktop OAuth client)
 *
 * What it does:
 *   1. Spins up a tiny local server on http://127.0.0.1:53782/callback
 *   2. Opens the Google sign-in URL in your default browser
 *   3. You sign in as the chosen account and grant access to gmail.send +
 *      gmail.compose + gmail.modify
 *   4. Google redirects back to the local server with an auth code
 *   5. Script exchanges the code for a refresh + access token
 *   6. Writes ~/.config/letyclaw-gmail/<account>.json with mode 0600
 *
 * Copy the resulting JSON file into `$LETYCLAW_SESSIONS_DIR/.gmail/` on the
 * bot host and keep it mode 0600.
 *
 * No npm deps needed — uses only Node built-ins.
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { URL } from "node:url";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.modify",
];
const REDIRECT_PORT = 53782;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
const [, , accountArg, emailArg, clientSecretArg] = process.argv;

if (!accountArg || !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(accountArg) ||
    !emailArg || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailArg)) {
  console.error("Usage: node scripts/gmail-auth.mjs <account-alias> <email-address> [client_secret.json]");
  console.error("Example: node scripts/gmail-auth.mjs default you@example.com");
  process.exit(1);
}
const account = accountArg.toLowerCase();
const accountEmailHint = emailArg;

const clientSecretPath = resolve(
  clientSecretArg || join(homedir(), "Downloads", "client_secret.json"),
);

let raw;
try {
  raw = JSON.parse(readFileSync(clientSecretPath, "utf8"));
} catch (e) {
  console.error(`Could not read client_secret at ${clientSecretPath}: ${e.message}`);
  console.error(`Download it from Google Cloud Console → APIs & Services → Credentials → Desktop OAuth client.`);
  process.exit(1);
}

const creds = raw.installed || raw.web;
if (!creds || !creds.client_id || !creds.client_secret) {
  console.error("client_secret.json is missing 'installed' or 'web' section with client_id/client_secret");
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", creds.client_id);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

authUrl.searchParams.set("login_hint", accountEmailHint);

console.log("─".repeat(72));
console.log(`Account:        ${account} (${accountEmailHint})`);
console.log(`Client ID:      ${creds.client_id}`);
console.log(`Scopes:         gmail.send, gmail.compose, gmail.modify`);
console.log(`Redirect URI:   ${REDIRECT_URI}`);
console.log("─".repeat(72));
console.log("");
console.log("Open this URL in your browser and sign in AS THE ACCOUNT ABOVE:");
console.log("");
console.log(authUrl.toString());
console.log("");
console.log("Tip: if your default browser is signed into multiple Google accounts,");
console.log(`     pick the one matching '${accountEmailHint}' on the chooser screen.`);
console.log("");

function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}
openInBrowser(authUrl.toString());

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) {
    res.writeHead(400, { "content-type": "text/html" }).end(
      `<h1>OAuth error: ${err}</h1><p>Close this tab and re-run the script.</p>`,
    );
    console.error(`OAuth returned error: ${err}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) {
      throw new Error(`token exchange failed: ${JSON.stringify(tokens)}`);
    }
    if (!tokens.refresh_token) {
      throw new Error(
        "no refresh_token returned. Revoke prior consent at https://myaccount.google.com/permissions and re-run.",
      );
    }

    const out = {
      account,
      email: accountEmailHint,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: tokens.refresh_token,
      access_token: tokens.access_token,
      expiry: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      scope: tokens.scope,
      obtained_at: new Date().toISOString(),
    };

    const outDir = join(homedir(), ".config", "letyclaw-gmail");
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const outPath = join(outDir, `${account}.json`);
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    chmodSync(outPath, 0o600);

    res.writeHead(200, { "content-type": "text/html" }).end(
      `<h1>letyclaw: ${account} authorized ✓</h1><p>Saved to ${outPath}. You can close this tab.</p>`,
    );
    console.log("");
    console.log(`✓ Saved ${outPath}`);
    console.log(`  scope: ${tokens.scope}`);
    console.log("");
    console.log("Next:");
    console.log("  - Copy this file to $LETYCLAW_SESSIONS_DIR/.gmail/ on the bot host");
    console.log("  - Keep the token directory mode 0700 and token files mode 0600");
    server.close();
    process.exit(0);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/html" }).end(
      `<h1>Error</h1><pre>${e.message}</pre>`,
    );
    console.error(e);
    server.close();
    process.exit(1);
  }
});

server.listen(REDIRECT_PORT, "127.0.0.1", () => {
  console.log(`Listening on ${REDIRECT_URI} — waiting for browser callback…`);
});
