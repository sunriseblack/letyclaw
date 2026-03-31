#!/usr/bin/env node
/**
 * Health Data Webhook — receives Apple Health data from iOS Shortcuts.
 * Minimal standalone server, no external dependencies.
 *
 * Env:
 *   HEALTH_WEBHOOK_PORT   — default 8788
 *   HEALTH_WEBHOOK_SECRET — Bearer token for auth
 *   VAULT_PATH            — default /opt/letyclaw/vault
 */
import { createServer } from "http";
import type { IncomingMessage, ServerResponse } from "http";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const PORT = parseInt(process.env.HEALTH_WEBHOOK_PORT || "8788", 10);
const SECRET = process.env.HEALTH_WEBHOOK_SECRET || "";
const VAULT = process.env.VAULT_PATH || "/opt/letyclaw/vault";
const DIR = join(VAULT, "health/daily-data");

if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });

interface HealthPayload {
  timezone?: string;
  [key: string]: unknown;
}

const server = createServer((req: IncomingMessage, res: ServerResponse): void => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"status":"ok"}');
    return;
  }

  // Apple Health webhook
  if (req.method === "POST" && req.url === "/health/apple") {
    // Auth check
    if (SECRET && req.headers.authorization !== `Bearer ${SECRET}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"Unauthorized"}');
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer): void => { body += chunk; });
    req.on("end", (): void => {
      let data: HealthPayload;
      try {
        data = JSON.parse(body) as HealthPayload;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end('{"error":"Invalid JSON"}');
        return;
      }

      // Save timezone
      if (data.timezone) {
        writeFileSync(join(DIR, "timezone.txt"), data.timezone);
      }

      // Use local date from timezone (not UTC) to match sync script
      let date: string;
      if (data.timezone) {
        try {
          date = new Intl.DateTimeFormat("en-CA", { timeZone: data.timezone }).format(new Date());
        } catch { date = new Date().toISOString().slice(0, 10); }
      } else {
        date = new Date().toISOString().slice(0, 10);
      }
      writeFileSync(join(DIR, `apple-health-${date}.json`), JSON.stringify(data, null, 2));
      console.log(`[health-webhook] saved ${date} (tz: ${data.timezone ?? "?"})`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", date }));
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end('{"error":"Not found"}');
});

server.listen(PORT, "0.0.0.0", (): void => {
  console.log(`[health-webhook] listening on port ${PORT}`);
});
