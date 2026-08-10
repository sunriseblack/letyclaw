/** Progressive skill disclosure for the current agent run. */
import type { MCPToolDefinition, MCPResponse } from "../types.js";
import { error, ok, AGENT, VAULT } from "./_util.js";
import { readConfiguredSkill, resolveSkillDescriptor } from "../../../lib.js";

function enabledSkillNames(): string[] {
  const raw = process.env.LETYCLAW_SKILLS?.trim();
  if (!raw) return [];
  let values: unknown = raw.split(",");
  if (raw.startsWith("[")) {
    try { values = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean))];
}

export const definitions: MCPToolDefinition[] = [
  {
    name: "skills_list",
    description:
      "List the reusable skills enabled for this run. Returns names, trigger descriptions, and installation status without loading full instructions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "skill_view",
    description:
      "Load the complete SKILL.md for an enabled skill, or one referenced file inside that skill package. Call before using a matching skill; content is never silently truncated.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Enabled skill name from skills_list or the prompt catalog" },
        path: {
          type: "string",
          description: "Optional package-relative file, e.g. references/checklist.md. Defaults to SKILL.md.",
        },
      },
      required: ["name"],
    },
  },
];

export const handlers: Record<string, (args: Record<string, unknown>) => Promise<MCPResponse>> = {
  async skills_list(): Promise<MCPResponse> {
    const names = enabledSkillNames();
    const skills = names.map((name) => {
      const descriptor = resolveSkillDescriptor(name, { vaultPath: VAULT(), agentId: AGENT() });
      return {
        name,
        description: descriptor?.description || "Configured skill is not installed",
        available: !!descriptor,
      };
    });
    return ok(JSON.stringify({ skills }, null, 2));
  },

  async skill_view({ name, path }: Record<string, unknown>): Promise<MCPResponse> {
    if (typeof name !== "string" || !name.trim()) return error("name is required");
    if (path !== undefined && typeof path !== "string") return error("path must be a string");
    try {
      const result = readConfiguredSkill(
        name.trim(),
        typeof path === "string" ? path : undefined,
        enabledSkillNames(),
        { vaultPath: VAULT(), agentId: AGENT() },
      );
      return ok(JSON.stringify(result, null, 2));
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};
