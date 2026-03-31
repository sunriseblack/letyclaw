// ── MCP response types ───────────────────────────────────────────────

export interface MCPTextContent {
  type: "text";
  text: string;
}

export interface MCPResponse {
  [key: string]: unknown;
  content: MCPTextContent[];
  isError?: true;
}

// ── MCP tool definition ──────────────────────────────────────────────

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export type MCPHandler = (args: Record<string, unknown>) => Promise<MCPResponse>;

export interface MCPToolModule {
  definitions: MCPToolDefinition[];
  handlers: Record<string, MCPHandler>;
}
