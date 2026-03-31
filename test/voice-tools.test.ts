import type { MCPToolModule } from "../tools/letyclaw-mcp/types.js";

// ── Test fixtures ─────────────────────────────────────────────────────

beforeEach(() => {
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.VAPI_ASSISTANT_ID;
});

afterEach(() => {
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.VAPI_ASSISTANT_ID;
});

// ══════════════════════════════════════════════════════════════════════
// VOICE MCP TOOLS (Vapi)
// ══════════════════════════════════════════════════════════════════════

describe("Voice MCP tools (voice.js)", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    const mod = await import("../tools/letyclaw-mcp/tools/voice.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  describe("voice_call", () => {
    it("requires VAPI_API_KEY", async () => {
      const result = await handlers.voice_call!({
        phone_number: "+14155551234",
        task: "Ask about hours",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("VAPI_API_KEY");
    });

    it("requires VAPI_PHONE_NUMBER_ID", async () => {
      process.env.VAPI_API_KEY = "fake-key";

      const result = await handlers.voice_call!({
        phone_number: "+14155551234",
        task: "Ask about hours",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("VAPI_PHONE_NUMBER_ID");
    });

    it("rejects invalid phone number format", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";

      const result = await handlers.voice_call!({
        phone_number: "not-a-number",
        task: "Ask about hours",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("E.164");
    });

    it("rejects missing task", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";

      const result = await handlers.voice_call!({
        phone_number: "+14155551234",
        task: "",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("task is required");
    });

    it("accepts valid E.164 numbers with country codes", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";

      // These should pass validation and only fail at the Vapi API call
      for (const num of ["+14155551234", "+380501234567", "+34612345678"]) {
        const result = await handlers.voice_call!({ phone_number: num, task: "Test call" });
        // Should fail at fetch, not at validation
        expect(result.content[0]!.text).not.toContain("E.164");
      }
    });
  });

  describe("voice_call_status", () => {
    it("requires call_id", async () => {
      const result = await handlers.voice_call_status!({ call_id: "" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("call_id is required");
    });

    it("requires VAPI_API_KEY", async () => {
      const result = await handlers.voice_call_status!({ call_id: "call-123" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("VAPI_API_KEY");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ══════════════════════════════════════════════════════════════════════

describe("Voice tool definitions", () => {
  it("exports voice_call and voice_call_status with correct schemas", async () => {
    const { definitions } = await import("../tools/letyclaw-mcp/tools/voice.js") as MCPToolModule;
    expect(definitions).toHaveLength(2);

    const callTool = definitions.find((d) => d.name === "voice_call");
    expect(callTool).toBeTruthy();
    expect(callTool!.inputSchema.required).toContain("phone_number");
    expect(callTool!.inputSchema.required).toContain("task");

    const statusTool = definitions.find((d) => d.name === "voice_call_status");
    expect(statusTool).toBeTruthy();
    expect(statusTool!.inputSchema.required).toContain("call_id");
  });
});
