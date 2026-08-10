/**
 * Extra tools — Devices, Canvas, and Agent Context.
 *
 * - nodes_list / nodes_control: Device management (stub, needs hardware integration)
 * - canvas_create / canvas_update: Visual workspace (stub, needs frontend)
 * - self_info: Current agent context introspection
 * - cross_agent_read: Read another agent's memory or workspace files
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from "fs";
import { join } from "path";
import YAML from "js-yaml";
import type { MCPToolDefinition, MCPHandler, MCPResponse } from "../types.js";
import { ok, error, VAULT, AGENT, TOPIC, SESSIONS_DIR, safePath, safeAbsPath, obsidianLink } from "./_util.js";
import { getSessionFile } from "../../../lib.js";

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

  // ── Canvas (Obsidian JSON Canvas) ──────────────────────────────────
  {
    name: "canvas_create",
    description:
      "Create an Obsidian-native JSON Canvas (.canvas) with nodes and edges. Renders natively in Obsidian with interactive pan/zoom. Nodes can be text, links to vault files, or links to URLs.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Canvas title (used as filename)" },
        nodes: {
          type: "array",
          description: "Canvas nodes — each has {id, type, text?, file?, url?, x, y, width, height, color?}. Types: 'text', 'file', 'link'.",
          items: { type: "object", additionalProperties: true },
        },
        edges: {
          type: "array",
          description: "Edges connecting nodes — each has {id, fromNode, toNode, label?, color?}",
          items: { type: "object", additionalProperties: true },
        },
        output_path: { type: "string", description: "Save .canvas to this path (optional, defaults to agent workspace)" },
      },
      required: ["title"],
    },
  },
  {
    name: "canvas_update",
    description:
      "Update an existing Obsidian JSON Canvas (.canvas) file. Add or replace nodes and edges.",
    inputSchema: {
      type: "object",
      properties: {
        canvas_path: { type: "string", description: "Path to existing .canvas file" },
        add_nodes: {
          type: "array",
          description: "New nodes to add",
          items: { type: "object", additionalProperties: true },
        },
        add_edges: {
          type: "array",
          description: "New edges to add",
          items: { type: "object", additionalProperties: true },
        },
        remove_node_ids: {
          type: "array",
          description: "IDs of nodes to remove",
          items: { type: "string" },
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
      "Read files from another configured agent's workspace for cross-agent context. Read-only access.",
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

// ── JSON Canvas types (Obsidian spec) ───────────────────────────────

interface CanvasNode {
  id: string;
  type: "text" | "file" | "link";
  text?: string;
  file?: string;
  url?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide?: "top" | "right" | "bottom" | "left";
  toSide?: "top" | "right" | "bottom" | "left";
  label?: string;
  color?: string;
}

interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export const handlers: Record<string, MCPHandler> = {
  // ── Devices (stub) ────────────────────────────────────────────────

  async nodes_list(args: Record<string, unknown>): Promise<MCPResponse> {
    const type = args.type as string | undefined;
    const nodesConfig = join(
      process.env.LETYCLAW_PROJECT_ROOT || "/root/letyclaw",
      "config",
      "nodes.yaml",
    );
    if (!existsSync(nodesConfig)) {
      return ok(JSON.stringify({
        nodes: [],
        note: "No devices configured. Create config/nodes.yaml to register devices. Format:\n" +
          "nodes:\n  - id: living-room-light\n    type: light\n    protocol: mqtt\n    host: 192.168.1.100\n    commands: [on, off, dim]",
      }, null, 2));
    }

    try {
      const raw = readFileSync(nodesConfig, "utf8");
      const parsed = YAML.load(raw) as { nodes?: Record<string, string>[] } | null;
      const nodes = parsed?.nodes ?? [];
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

  // ── Canvas (Obsidian JSON Canvas) ──────────────────────────────────

  async canvas_create(args: Record<string, unknown>): Promise<MCPResponse> {
    const title = args.title as string;
    const nodes = (args.nodes as CanvasNode[] | undefined) ?? [];
    const edges = (args.edges as CanvasEdge[] | undefined) ?? [];
    const output_path = args.output_path as string | undefined;

    // Auto-assign IDs and layout if not provided
    let nextX = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (!n.id) n.id = `node-${i}`;
      if (n.x === undefined) { n.x = nextX; nextX += 300; }
      if (n.y === undefined) n.y = 0;
      if (!n.width) n.width = 250;
      if (!n.height) n.height = 120;
      if (!n.type) n.type = n.file ? "file" : n.url ? "link" : "text";
    }

    for (let i = 0; i < edges.length; i++) {
      if (!edges[i]!.id) edges[i]!.id = `edge-${i}`;
    }

    const canvas: CanvasData = { nodes, edges };
    const json = JSON.stringify(canvas, null, 2);

    const agentId = AGENT();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const savePath = output_path || join(VAULT(), agentId || "shared", `${slug}.canvas`);

    try {
      writeFileSync(savePath, json);
      const vaultRel = savePath.replace(VAULT() + "/", "");
      return ok(JSON.stringify({
        created: true,
        path: savePath,
        title,
        node_count: nodes.length,
        edge_count: edges.length,
        obsidian: obsidianLink(vaultRel),
      }, null, 2));
    } catch (err) {
      return error(`Failed to save canvas: ${(err as Error).message}`);
    }
  },

  async canvas_update(args: Record<string, unknown>): Promise<MCPResponse> {
    const canvas_path = args.canvas_path as string;
    const add_nodes = (args.add_nodes as CanvasNode[] | undefined) ?? [];
    const add_edges = (args.add_edges as CanvasEdge[] | undefined) ?? [];
    const remove_ids = (args.remove_node_ids as string[] | undefined) ?? [];

    if (!existsSync(canvas_path)) return error(`Canvas not found: ${canvas_path}`);

    let canvas: CanvasData;
    try {
      canvas = JSON.parse(readFileSync(canvas_path, "utf8")) as CanvasData;
    } catch {
      return error("Failed to parse canvas file — may not be valid JSON Canvas");
    }

    // Remove nodes and their connected edges
    if (remove_ids.length > 0) {
      const removeSet = new Set(remove_ids);
      canvas.nodes = canvas.nodes.filter((n) => !removeSet.has(n.id));
      canvas.edges = canvas.edges.filter((e) => !removeSet.has(e.fromNode) && !removeSet.has(e.toNode));
    }

    // Add new nodes and edges
    canvas.nodes.push(...add_nodes);
    canvas.edges.push(...add_edges);

    writeFileSync(canvas_path, JSON.stringify(canvas, null, 2));

    const vaultRel = canvas_path.replace(VAULT() + "/", "");
    return ok(JSON.stringify({
      updated: true,
      path: canvas_path,
      node_count: canvas.nodes.length,
      edge_count: canvas.edges.length,
      obsidian: obsidianLink(vaultRel),
    }, null, 2));
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
      const memFiles = readdirSync(join(workspace, "memory"))
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 10);
      info.memory_files = memFiles;
      info.obsidian_links = Object.fromEntries(
        memFiles.map((f) => [f, obsidianLink(`${agentId}/memory/${f}`)])
      );
    }

    // List bootstrap files
    if (workspace && existsSync(workspace)) {
      info.bootstrap_files = readdirSync(workspace)
        .filter((f) => f.endsWith(".md") && !f.startsWith("."))
        .sort();
    }

    // Check session
    if (agentId && topicId) {
      const sessionFile = getSessionFile(SESSIONS_DIR(), agentId, topicId);
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
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agent_id)) return error("Invalid agent_id — access denied");

    const vaultRoot = VAULT();
    const canonicalVault = realpathSync(vaultRoot);
    const agentWorkspace = safePath(vaultRoot, agent_id);
    if (!agentWorkspace) return error("Invalid agent workspace — access denied");
    if (!existsSync(agentWorkspace)) return error(`Agent workspace not found: ${agent_id}`);
    const canonicalWorkspace = realpathSync(agentWorkspace);
    if (!safeAbsPath(canonicalWorkspace, [canonicalVault])) return error("Agent workspace escapes vault — access denied");

    if (list_dir) {
      const dir = safePath(agentWorkspace, list_dir);
      if (!dir) return error("Path traversal detected — access denied");
      if (!existsSync(dir)) return error(`Directory not found: ${agent_id}/${list_dir}`);
      const canonicalDir = realpathSync(dir);
      if (!safeAbsPath(canonicalDir, [canonicalWorkspace])) return error("Path traversal detected — access denied");
      const files = readdirSync(canonicalDir).sort();
      return ok(JSON.stringify({ agent: agent_id, directory: list_dir, files }, null, 2));
    }

    if (!relPath) return error("Either 'path' or 'list_dir' is required");

    const filePath = safePath(agentWorkspace, relPath);
    if (!filePath) return error("Path traversal detected — access denied");
    if (!existsSync(filePath)) return error(`File not found: ${agent_id}/${relPath}`);
    const canonicalFile = realpathSync(filePath);
    if (!safeAbsPath(canonicalFile, [canonicalWorkspace])) return error("Path traversal detected — access denied");

    const content = readFileSync(canonicalFile, "utf8");
    if (content.length > 10000) {
      return ok(`(truncated to 10000 chars)\n\n${content.slice(0, 10000)}...`);
    }
    return ok(content);
  },
};
