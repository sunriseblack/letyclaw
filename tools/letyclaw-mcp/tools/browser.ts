/**
 * Browser support tools that complement Playwright MCP without proxying browser
 * actions. Secret values stay inside Playwright; this module exposes names only.
 */
import { existsSync, readFileSync } from "fs";
import type { MCPHandler, MCPResponse, MCPToolDefinition } from "../types.js";
import { ok, error } from "./_util.js";

const DEFAULT_SECRET_NAMES_PATH = "/var/lib/letyclaw-browser-secret-names";
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function browserSecretNames(
  path = process.env.LETYCLAW_BROWSER_SECRET_NAMES_PATH || DEFAULT_SECRET_NAMES_PATH,
): string[] {
  if (!existsSync(path)) return [];
  const names = new Set<string>();
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (SECRET_NAME.test(line)) names.add(line);
  }
  return [...names].sort();
}

export const definitions: MCPToolDefinition[] = [
  {
    name: "browser_secret_names",
    description:
      "List browser credential aliases without revealing their values. When Playwright browser_fill_form needs a secret textbox value, pass one of these alias names as the field value; Playwright substitutes the protected value internally.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export const handlers: Record<string, MCPHandler> = {
  async browser_secret_names(): Promise<MCPResponse> {
    try {
      const names = browserSecretNames();
      return ok(JSON.stringify({
        names,
        count: names.length,
        usage: names.length
          ? "Pass an alias name as the value of a Playwright browser_fill_form textbox field. Never read or log the underlying secret file."
          : "No browser secrets are provisioned. Add them from an administrator shell and regenerate the names-only index.",
      }, null, 2));
    } catch (err) {
      return error(`Unable to list browser secret names: ${(err as Error).message}`);
    }
  },
};
