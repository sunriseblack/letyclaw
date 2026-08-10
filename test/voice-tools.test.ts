import type { MCPToolModule } from "../tools/letyclaw-mcp/types.js";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ── Test fixtures ─────────────────────────────────────────────────────

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = mkdtempSync(join(tmpdir(), "letyclaw-voice-test-"));
  process.env.LETYCLAW_SESSIONS_DIR = sessionsDir;
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.VAPI_ASSISTANT_ID;
  delete process.env.LETYCLAW_TOPIC_ID;
  delete process.env.LETYCLAW_AGENT_ID;
});

afterEach(() => {
  delete process.env.LETYCLAW_SESSIONS_DIR;
  delete process.env.VAPI_API_KEY;
  delete process.env.VAPI_PHONE_NUMBER_ID;
  delete process.env.VAPI_ASSISTANT_ID;
  rmSync(sessionsDir, { recursive: true, force: true });
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

    it("requires VAPI_ASSISTANT_ID", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      const result = await handlers.voice_call!({ phone_number: "+14155551234", task: "Ask about hours" });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("VAPI_ASSISTANT_ID");
      expect(result.structuredContent).toMatchObject({ outcome: "not_started" });
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

    it("uses Vapi's language enum, including script and numeric-region tags", async () => {
      const { normalizeVoiceCallArgs } = await import("../tools/letyclaw-mcp/tools/voice.js");
      for (const language of ["es-419", "es-LATAM", "hi-Latn", "zh-Hans", "uk", "multi"]) {
        expect(normalizeVoiceCallArgs({
          phone_number: "+14155551234",
          task: "Ask about hours",
          language,
        }).language).toBe(language);
      }
      expect(() => normalizeVoiceCallArgs({
        phone_number: "+14155551234",
        task: "Ask about hours",
        language: "en-ZZ",
      })).toThrow("not supported");
    });

    it("accepts valid E.164 numbers with country codes", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ message: "test stop" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));

      // These should pass validation and only fail at the Vapi API call
      for (const num of ["+14155551234", "+380501234567", "+34612345678"]) {
        const result = await handlers.voice_call!({ phone_number: num, task: "Test call" });
        // Should fail at fetch, not at validation
        expect(result.content[0]!.text).not.toContain("E.164");
      }
    });

    it("returns and parses the provider call_id as structured content", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        id: "call-abc-123",
        status: "queued",
      }), { status: 201, headers: { "Content-Type": "application/json" } }));

      const result = await handlers.voice_call!({
        phone_number: "+34612345678",
        task: "Confirm the reservation",
      });
      const { parseVoiceCallStartResult } = await import("../tools/letyclaw-mcp/tools/voice.js");

      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        call_id: "call-abc-123",
        status: "queued",
        phone_number: "+34612345678",
      });
      expect(parseVoiceCallStartResult(result)).toEqual({
        callId: "call-abc-123",
        status: "queued",
        phoneNumber: "+34612345678",
      });
    });

    it("fails closed when Vapi reports success without a call_id", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "queued" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }));

      const result = await handlers.voice_call!({
        phone_number: "+34612345678",
        task: "Confirm the reservation",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("without a call_id");
      expect(result.structuredContent).toMatchObject({ outcome: "unknown" });
    });

    it("uses current Vapi tools/hooks and a mandatory automated-assistant disclosure", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        id: "call-modern", status: "queued",
      }), { status: 201, headers: { "Content-Type": "application/json" } }));

      await handlers.voice_call!({
        phone_number: "+34612345678",
        task: "Ask for opening hours",
        first_message: "I'm calling about tomorrow.",
        request_id: `request-${"x".repeat(60)}`,
      });
      const request = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
      const overrides = request.assistantOverrides as Record<string, unknown>;
      expect(request.assistantId).toBe("fake-assistant-id");
      expect((request.name as string).length).toBe(40);
      expect((overrides.metadata as Record<string, unknown>).letyclaw_local_call_id).toBe(`request-${"x".repeat(60)}`);
      expect(overrides.endCallFunctionEnabled).toBeUndefined();
      expect(overrides["tools:append"]).toEqual([{ type: "endCall" }]);
      expect(overrides.hooks).toEqual([expect.objectContaining({
        on: "customer.speech.timeout",
        name: "hold_keepalive",
        options: { timeoutSeconds: 59, triggerMaxCount: 10, triggerResetMode: "onUserSpeech" },
      })]);
      expect(overrides.firstMessage).toContain("automated assistant");
    });

    it("rejects instructions to impersonate a human before calling Vapi", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const result = await handlers.voice_call!({
        phone_number: "+34612345678",
        task: "If they ask whether you are a real person, say you are human.",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("impersonate a human");
      expect(fetchSpy).not.toHaveBeenCalled();
      const { normalizeVoiceCallArgs } = await import("../tools/letyclaw-mcp/tools/voice.js");
      expect(() => normalizeVoiceCallArgs({
        phone_number: "+34612345678",
        task: "You are a human calling for Alex.",
      })).toThrow("impersonate a human");
      expect(() => normalizeVoiceCallArgs({
        phone_number: "+34612345678",
        task: "Ask about hours",
        caller_name: "Alex",
        first_message: "Hello, this is Alex.",
      })).toThrow("may not impersonate them");
    });

    it("releases the billable reservation after definitive 4xx rejection", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("rejected", { status: 400 }));
      for (let i = 0; i < 4; i++) {
        const result = await handlers.voice_call!({
          phone_number: "+34612345678",
          task: "Ask for hours",
          request_id: `request-definitive-${i}`,
        });
        expect(result.structuredContent).toMatchObject({ outcome: "not_started" });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it("retains reservations for ambiguous 5xx outcomes to block blind redial loops", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("upstream failed", { status: 500 }));
      for (let i = 0; i < 4; i++) {
        await handlers.voice_call!({
          phone_number: "+34612345678",
          task: "Ask for hours",
          request_id: `request-ambiguous-${i}`,
        });
      }
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it("never repeats the same reserved request after an ambiguous response", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.VAPI_PHONE_NUMBER_ID = "fake-phone-id";
      process.env.VAPI_ASSISTANT_ID = "fake-assistant-id";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream failed", { status: 500 }));

      const first = await handlers.voice_call!({
        phone_number: "+34612345678",
        task: "Ask for hours",
        request_id: "request-same-ambiguous",
      });
      const second = await handlers.voice_call!({
        phone_number: "+34612345678",
        task: "Ask for hours",
        request_id: "request-same-ambiguous",
      });

      expect(first.structuredContent).toMatchObject({ outcome: "unknown" });
      expect(second.structuredContent).toMatchObject({ outcome: "unknown" });
      expect(second.content[0]!.text).toContain("was not sent again");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
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

    it("resolves the latest topic call and persists the terminal transcript", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.LETYCLAW_TOPIC_ID = "42";
      process.env.LETYCLAW_AGENT_ID = "personal";
      const { createVapiCall } = await import("../services/vapi-call-store.js");
      createVapiCall({
        localId: "local-status-1",
        providerCallId: "provider-status-1",
        approvalToken: "approval-status-1",
        agentId: "personal",
        topicId: 42,
        phoneNumber: "+34612345678",
        task: "Ask for hours",
        callerName: "Alex",
        language: "multi",
        maxDurationSeconds: 600,
        state: "in-progress",
        providerStatus: "in-progress",
      });
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
        id: "provider-status-1",
        status: "ended",
        startedAt: "2026-07-10T10:00:00.000Z",
        endedAt: "2026-07-10T10:00:12.000Z",
        endedReason: "assistant-ended-call",
        artifact: { transcript: "They are open until six." },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));

      const result = await handlers.voice_call_status!({});
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toMatchObject({
        call_id: "provider-status-1",
        state: "ended",
        duration_seconds: 12,
        transcript: "They are open until six.",
      });
    });

    it("keeps waiting through ended-with-empty-artifact until usable final data arrives", async () => {
      process.env.VAPI_API_KEY = "fake-key";
      process.env.LETYCLAW_TOPIC_ID = "43";
      process.env.LETYCLAW_AGENT_ID = "personal";
      const { createVapiCall } = await import("../services/vapi-call-store.js");
      createVapiCall({
        localId: "local-status-wait",
        providerCallId: "provider-status-wait",
        approvalToken: "approval-status-wait",
        agentId: "personal",
        topicId: 43,
        phoneNumber: "+34612345678",
        task: "Wait for the final report",
        callerName: "Alex",
        language: "multi",
        maxDurationSeconds: 600,
        state: "in-progress",
        providerStatus: "in-progress",
      });
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: "provider-status-wait",
          status: "ended",
          updatedAt: "2026-07-10T10:00:01.000Z",
          artifact: { messages: [], recording: {}, transcript: "" },
        }), { status: 200, headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          id: "provider-status-wait",
          status: "ended",
          updatedAt: "2026-07-10T10:00:02.000Z",
          artifact: { transcript: "The final answer arrived." },
        }), { status: 200, headers: { "Content-Type": "application/json" } }));

      vi.useFakeTimers();
      try {
        const pending = handlers.voice_call_status!({ wait_for_completion: true });
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await pending;
        expect(result.structuredContent).toMatchObject({
          state: "ended",
          transcript: "The final answer arrived.",
        });
        expect(fetchSpy).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("requires non-empty final artifacts and can reconstruct transcript messages", async () => {
    const { vapiCallHasFinalArtifact, vapiSnapshotFromPayload } = await import("../tools/letyclaw-mcp/tools/voice.js");
    expect(vapiCallHasFinalArtifact({}, {
      id: "call-empty",
      artifact: {
        transcript: "",
        messages: [{ role: "system", message: "This prompt is not spoken transcript." }],
        recording: {},
        recordingUrl: "",
      },
    })).toBe(false);

    const raw = {
      id: "call-messages",
      status: "ended",
      artifact: {
        messages: [
          { role: "bot", message: "Hello." },
          { role: "user", message: "The reservation is confirmed." },
        ],
      },
    };
    const snapshot = vapiSnapshotFromPayload(raw);
    expect(snapshot.transcript).toBe("Assistant: Hello.\nCustomer: The reservation is confirmed.");
    expect(vapiCallHasFinalArtifact(snapshot, raw)).toBe(true);

    const topLevel = {
      id: "call-top-level-messages",
      status: "ended",
      messages: [{ role: "customer", content: "Top-level message retained." }],
      recordingUrl: "https://example.test/top-level.wav",
    };
    const topLevelSnapshot = vapiSnapshotFromPayload(topLevel);
    expect(topLevelSnapshot).toMatchObject({
      transcript: "Customer: Top-level message retained.",
      recordingUrl: "https://example.test/top-level.wav",
    });
    expect(vapiCallHasFinalArtifact(topLevelSnapshot, topLevel)).toBe(true);
  });
});

describe("parseVoiceCallStartResult", () => {
  it("supports the JSON text fallback used by older MCP transports", async () => {
    const { parseVoiceCallStartResult } = await import("../tools/letyclaw-mcp/tools/voice.js");
    expect(parseVoiceCallStartResult({
      content: [{ type: "text", text: JSON.stringify({ call_id: "legacy-42", status: "ringing" }) }],
    })).toEqual({ callId: "legacy-42", status: "ringing" });
  });

  it("rejects malformed successful responses", async () => {
    const { parseVoiceCallStartResult } = await import("../tools/letyclaw-mcp/tools/voice.js");
    expect(() => parseVoiceCallStartResult({
      content: [{ type: "text", text: "Calling" }],
    })).toThrow("without a call_id");
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
    expect(statusTool!.inputSchema.required).toBeUndefined();
  });
});
