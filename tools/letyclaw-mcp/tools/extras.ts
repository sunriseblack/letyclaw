/**
 * Extra tools — Devices, Canvas, and Agent Context.
 *
 * - nodes_list / nodes_control: Device management (stub, needs hardware integration)
 * - canvas_create / canvas_update: Visual workspace (stub, needs frontend)
 * - self_info: Current agent context introspection
 * - cross_agent_read: Read another agent's memory or workspace files
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { MCPToolDefinition, MCPHandler, MCPResponse } from "../types.js";
import { ok, error, VAULT, AGENT, TOPIC, SESSIONS_DIR, safePath } from "./_util.js";

// ── Tool definitions ──────────────────────────────────────────────────

export const definitions: MCPToolDefinition[] = [
  // ── Devices ───────────────────────────────────────────────────────
  {
    name: "nodes_list",
    description:
      "List known devices/nodes. Returns registered IoT devices, cameras, or services. Configure devices in config/nodes.yaml.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          description: "Filter by device type (e.g. 'camera', 'sensor', 'light')",
        },
      },
    },
  },
  {
    name: "nodes_control",
    description:
      "Send a command to a device/node. Supports on/off, set values, trigger actions. Configure devices in config/nodes.yaml.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Device/node ID" },
        command: {
          type: "string",
          description: "Command to send (e.g. 'on', 'off', 'set', 'trigger')",
        },
        params: {
          type: "object",
          description: "Command parameters (varies by device)",
          additionalProperties: true,
        },
      },
      required: ["node_id", "command"],
    },
  },

  // ── Canvas ────────────────────────────────────────────────────────
  {
    name: "canvas_create",
    description:
      "Create a visual canvas/workspace. Generates an HTML canvas page with diagrams, charts, or interactive content. Opens in browser or saves to file.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Canvas title" },
        content_type: {
          type: "string",
          enum: ["diagram", "chart", "kanban", "timeline", "freeform"],
          description: "Type of visual content",
        },
        data: {
          type: "object",
          description: "Content data (structure depends on content_type)",
          additionalProperties: true,
        },
        output_path: { type: "string", description: "Save HTML to this path (optional)" },
      },
      required: ["title", "content_type"],
    },
  },
  {
    name: "canvas_update",
    description:
      "Update an existing canvas with new data or content. Requires the canvas file path.",
    inputSchema: {
      type: "object",
      properties: {
        canvas_path: { type: "string", description: "Path to existing canvas HTML file" },
        updates: {
          type: "object",
          description: "Updates to apply (varies by canvas type)",
          additionalProperties: true,
        },
      },
      required: ["canvas_path"],
    },
  },

  // ── Agent Context ─────────────────────────────────────────────────
  {
    name: "self_info",
    description:
      "Get the current agent's context — agent ID, topic ID, workspace path, available memory files, session info. Useful for orientation at the start of a conversation.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "cross_agent_read",
    description:
      "Read files from another agent's workspace. Use this for cross-agent context (e.g. personal agent reading work agent's recent memory). Read-only access.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Target agent ID to read from" },
        path: {
          type: "string",
          description: "Relative path within the agent's workspace (e.g. 'memory/2026-03-28.md', 'AGENTS.md')",
        },
        list_dir: {
          type: "string",
          description: "List files in this relative directory instead of reading a file (e.g. 'memory')",
        },
      },
      required: ["agent_id"],
    },
  },
];

// ── Handlers ──────────────────────────────────────────────────────────

type CanvasGenerator = (title: string, data: Record<string, unknown>) => string;

export const handlers: Record<string, MCPHandler> = {
  // ── Devices (stub) ────────────────────────────────────────────────

  async nodes_list(args: Record<string, unknown>): Promise<MCPResponse> {
    const type = args.type as string | undefined;
    const nodesConfig = join(process.env.LETYCLAW_PROJECT_ROOT || process.cwd(), "config", "nodes.yaml");
    if (!existsSync(nodesConfig)) {
      return ok(JSON.stringify({
        nodes: [],
        note: "No devices configured. Create config/nodes.yaml to register devices. Format:\n" +
          "nodes:\n  - id: living-room-light\n    type: light\n    protocol: mqtt\n    host: 192.168.1.100\n    commands: [on, off, dim]",
      }, null, 2));
    }

    try {
      const raw = readFileSync(nodesConfig, "utf8");
      // Simple parse
      const nodes: Record<string, string>[] = [];
      let current: Record<string, string> | null = null;
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- id:")) {
          if (current) nodes.push(current);
          current = { id: trimmed.replace("- id:", "").trim() };
        } else if (current && trimmed.includes(":")) {
          const [k, ...v] = trimmed.split(":");
          current[k!.trim()] = v.join(":").trim();
        }
      }
      if (current) nodes.push(current);

      const filtered = type ? nodes.filter((n) => n.type === type) : nodes;
      return ok(JSON.stringify(filtered, null, 2));
    } catch (err) {
      return error(`Failed to read nodes config: ${(err as Error).message}`);
    }
  },

  async nodes_control(args: Record<string, unknown>): Promise<MCPResponse> {
    const node_id = args.node_id as string;
    const command = args.command as string;
    const params = args.params as Record<string, unknown> | undefined;
    // This is a framework — actual device control requires protocol-specific implementation
    return ok(JSON.stringify({
      status: "not_implemented",
      node_id,
      command,
      params,
      note: "Device control requires protocol-specific drivers (MQTT, HTTP, Zigbee, etc.). " +
        "Configure devices in config/nodes.yaml and implement drivers in tools/letyclaw-mcp/drivers/.",
    }, null, 2));
  },

  // ── Canvas ────────────────────────────────────────────────────────

  async canvas_create(args: Record<string, unknown>): Promise<MCPResponse> {
    const title = args.title as string;
    const content_type = args.content_type as string;
    const data = (args.data as Record<string, unknown> | undefined) ?? {};
    const output_path = args.output_path as string | undefined;

    const templates: Record<string, CanvasGenerator> = {
      diagram: generateDiagramHtml,
      chart: generateChartHtml,
      kanban: generateKanbanHtml,
      timeline: generateTimelineHtml,
      freeform: generateFreeformHtml,
    };

    const generator = templates[content_type];
    if (!generator) return error(`Unknown content_type: ${content_type}`);

    const html = generator(title, data);
    const agentId = AGENT();
    const savePath = output_path || join(VAULT(), agentId || "shared", `canvas-${Date.now()}.html`);

    try {
      writeFileSync(savePath, html);
      return ok(JSON.stringify({
        created: true,
        path: savePath,
        type: content_type,
        title,
        size: html.length,
      }, null, 2));
    } catch (err) {
      return error(`Failed to save canvas: ${(err as Error).message}`);
    }
  },

  async canvas_update(args: Record<string, unknown>): Promise<MCPResponse> {
    const canvas_path = args.canvas_path as string;
    const updates = args.updates as Record<string, unknown> | undefined;
    if (!existsSync(canvas_path)) return error(`Canvas not found: ${canvas_path}`);

    // Read existing canvas and inject updated data
    let html = readFileSync(canvas_path, "utf8");
    const dataMarker = "/* CANVAS_DATA */";
    const markerIdx = html.indexOf(dataMarker);

    if (markerIdx === -1) {
      return error("Canvas file does not contain a CANVAS_DATA marker — may not be a letyclaw canvas");
    }

    // Replace the data section
    const endMarker = html.indexOf("/* END_CANVAS_DATA */", markerIdx);
    if (endMarker === -1) return error("Malformed canvas — missing END_CANVAS_DATA marker");

    const newData = `${dataMarker}\nconst canvasData = ${JSON.stringify(updates, null, 2)};\n/* END_CANVAS_DATA */`;
    html = html.slice(0, markerIdx) + newData + html.slice(endMarker + "/* END_CANVAS_DATA */".length);

    writeFileSync(canvas_path, html);

    return ok(JSON.stringify({ updated: true, path: canvas_path }));
  },

  // ── Agent Context ─────────────────────────────────────────────────

  async self_info(): Promise<MCPResponse> {
    const agentId = AGENT();
    const topicId = TOPIC();
    const workspace = agentId ? join(VAULT(), agentId) : null;

    const info: Record<string, unknown> = {
      agent_id: agentId || "(not set)",
      topic_id: topicId || "(not set)",
      workspace: workspace || "(not set)",
      vault_path: VAULT(),
      sessions_dir: SESSIONS_DIR(),
    };

    // List memory files if workspace exists
    if (workspace && existsSync(join(workspace, "memory"))) {
      info.memory_files = readdirSync(join(workspace, "memory"))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 10);
    }

    // List bootstrap files
    if (workspace && existsSync(workspace)) {
      info.bootstrap_files = readdirSync(workspace)
        .filter((f) => f.endsWith(".md") && !f.startsWith("."))
        .sort();
    }

    // Check session
    if (agentId && topicId) {
      const sessionFile = join(SESSIONS_DIR(), `${agentId}-topic-${topicId}.json`);
      if (existsSync(sessionFile)) {
        try {
          const sessionData = JSON.parse(readFileSync(sessionFile, "utf8")) as Record<string, unknown>;
          info.current_session = sessionData.currentSessionId;
          info.session_age_hours = Math.round((Date.now() - ((sessionData.createdAt as number) || 0)) / 3600000 * 10) / 10;
        } catch { /* ignore */ }
      }
    }

    // List all agents
    if (existsSync(VAULT())) {
      info.all_agents = readdirSync(VAULT(), { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(VAULT(), d.name, "AGENTS.md")))
        .map((d) => d.name);
    }

    return ok(JSON.stringify(info, null, 2));
  },

  async cross_agent_read(args: Record<string, unknown>): Promise<MCPResponse> {
    const agent_id = args.agent_id as string;
    const relPath = args.path as string | undefined;
    const list_dir = args.list_dir as string | undefined;

    if (!agent_id) return error("agent_id is required");

    const agentWorkspace = join(VAULT(), agent_id);
    if (!existsSync(agentWorkspace)) return error(`Agent workspace not found: ${agent_id}`);

    if (list_dir) {
      const dir = join(agentWorkspace, list_dir);
      if (!existsSync(dir)) return error(`Directory not found: ${agent_id}/${list_dir}`);
      const files = readdirSync(dir).sort();
      return ok(JSON.stringify({ agent: agent_id, directory: list_dir, files }, null, 2));
    }

    if (!relPath) return error("Either 'path' or 'list_dir' is required");

    const filePath = safePath(agentWorkspace, relPath);
    if (!filePath) return error("Path traversal detected — access denied");
    if (!existsSync(filePath)) return error(`File not found: ${agent_id}/${relPath}`);

    const content = readFileSync(filePath, "utf8");
    if (content.length > 10000) {
      return ok(`(truncated to 10000 chars)\n\n${content.slice(0, 10000)}...`);
    }
    return ok(content);
  },
};

// ── Canvas HTML generators ──────────────────────────────────────────

function canvasWrapper(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; color: #f8fafc; }
  .card { background: #1e293b; border-radius: 0.75rem; padding: 1rem; margin: 0.5rem; border: 1px solid #334155; }
</style>
</head>
<body>
<h1>${title}</h1>
<script>
/* CANVAS_DATA */
const canvasData = {};
/* END_CANVAS_DATA */
</script>
${body}
</body>
</html>`;
}

function generateDiagramHtml(title: string, data: Record<string, unknown>): string {
  const nodes = (data.nodes || []) as Array<Record<string, unknown> | string>;
  const edges = (data.edges || []) as Array<Record<string, unknown> | [string, string]>;
  return canvasWrapper(title, `
<div style="display: flex; flex-wrap: wrap; gap: 1rem; justify-content: center; padding: 2rem;">
  ${nodes.map((n) => {
    const obj = typeof n === "string" ? null : n;
    const id = obj ? (obj.id as string) ?? n : n;
    const label = obj ? (obj.label as string) ?? n : n;
    return `<div class="card" id="node-${id}">${label}</div>`;
  }).join("\n  ")}
</div>
<pre style="color: #94a3b8; padding: 1rem;">Connections: ${edges.map((e) => {
    if (Array.isArray(e)) return `${e[0]} \u2192 ${e[1]}`;
    return `${e.from as string} \u2192 ${e.to as string}`;
  }).join(", ")}</pre>`);
}

function generateChartHtml(title: string, data: Record<string, unknown>): string {
  const labels = (data.labels || []) as string[];
  const values = (data.values || []) as number[];
  const max = Math.max(...values, 1);
  return canvasWrapper(title, `
<div style="display: flex; align-items: flex-end; gap: 0.5rem; height: 300px; padding: 2rem;">
  ${values.map((v, i) => `
  <div style="display: flex; flex-direction: column; align-items: center; flex: 1;">
    <span style="font-size: 0.75rem; color: #94a3b8;">${v}</span>
    <div style="width: 100%; background: #3b82f6; border-radius: 4px 4px 0 0; height: ${(v / max) * 250}px;"></div>
    <span style="font-size: 0.75rem; color: #94a3b8; margin-top: 0.5rem;">${labels[i] || ""}</span>
  </div>`).join("")}
</div>`);
}

function generateKanbanHtml(title: string, data: Record<string, unknown>): string {
  const columns = (data.columns || [
    { name: "To Do", items: [] },
    { name: "In Progress", items: [] },
    { name: "Done", items: [] },
  ]) as Array<{ name: string; items?: Array<string | Record<string, unknown>> }>;
  return canvasWrapper(title, `
<div style="display: flex; gap: 1rem; overflow-x: auto; padding: 1rem;">
  ${columns.map((col) => `
  <div style="min-width: 250px; flex: 1;">
    <h3 style="color: #94a3b8; font-size: 0.875rem; text-transform: uppercase; margin-bottom: 0.75rem;">${col.name} (${(col.items || []).length})</h3>
    ${(col.items || []).map((item) => `<div class="card">${typeof item === "string" ? item : (item as Record<string, unknown>).title || (item as Record<string, unknown>).text || JSON.stringify(item)}</div>`).join("\n")}
  </div>`).join("\n")}
</div>`);
}

function generateTimelineHtml(title: string, data: Record<string, unknown>): string {
  const events = (data.events || []) as Array<Record<string, unknown>>;
  return canvasWrapper(title, `
<div style="padding: 2rem;">
  ${events.map((e) => `
  <div style="display: flex; gap: 1rem; margin-bottom: 1.5rem;">
    <div style="width: 100px; text-align: right; color: #94a3b8; font-size: 0.875rem; flex-shrink: 0;">${(e.date as string) || (e.time as string) || ""}</div>
    <div style="width: 2px; background: #3b82f6; position: relative;">
      <div style="width: 10px; height: 10px; background: #3b82f6; border-radius: 50%; position: absolute; left: -4px; top: 4px;"></div>
    </div>
    <div class="card" style="flex: 1;">${(e.title as string) || (e.text as string) || String(e)}</div>
  </div>`).join("\n")}
</div>`);
}

function generateFreeformHtml(title: string, data: Record<string, unknown>): string {
  const content = (data.html as string) || (data.content as string) || "<p>Empty canvas</p>";
  return canvasWrapper(title, `<div style="padding: 2rem;">${content}</div>`);
}
