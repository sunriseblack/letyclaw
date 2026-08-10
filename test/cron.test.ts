import { vi } from "vitest";
import cron from "node-cron";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { LoadedConfig } from "../types.js";
import { startCronJobs } from "../cron.js";

vi.mock("node-cron", () => ({
  default: { schedule: vi.fn(), validate: vi.fn(() => true) },
}));

const mockSchedule = cron.schedule as ReturnType<typeof vi.fn>;

describe("startCronJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers no jobs when jobs list is empty", () => {
    const config = {
      cron: { timezone: "UTC", jobs: [] },
      agents: {},
    } as unknown as LoadedConfig;
    const stop = startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(typeof stop).toBe("function");
  });

  it("registers jobs when provided", () => {
    mockSchedule.mockReturnValue({ stop: vi.fn() });
    const config = {
      cron: {
        timezone: "UTC",
        jobs: [
          { name: "test_job", delivery: "signal", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello" },
        ],
      },
      agents: {
        personal: { id: "personal", name: "Personal", maxTurns: 50 },
      },
    } as unknown as LoadedConfig;
    startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).toHaveBeenCalledTimes(1);
  });

  it("fails closed for an unclassified runtime job", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = {
      cron: { timezone: "UTC", jobs: [
        { id: "runtime-only", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "send a prompt" },
      ] },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;

    startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no valid delivery policy"));
    warnSpy.mockRestore();
  });

  it("never registers a nudge even if its enabled flag or runNow is true", () => {
    const config = {
      cron: { timezone: "UTC", jobs: [
        { id: "reminder", delivery: "nudge", enabled: true, runNow: true, schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "nag" },
      ] },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;

    startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it("skips an invalid schedule instead of crashing the whole scheduler", () => {
    const validate = cron.validate as ReturnType<typeof vi.fn>;
    validate.mockReturnValueOnce(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = {
      cron: { timezone: "UTC", jobs: [
        { id: "bad", delivery: "signal", schedule: "foo bar baz qux quux", agent: "personal", topicId: 2, prompt: "Hello" },
      ] },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;

    expect(() => startCronJobs(config, vi.fn(), vi.fn())).not.toThrow();
    expect(cron.schedule).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/invalid schedule/i));
    warnSpy.mockRestore();
  });

  it("does not register disabled jobs unless runNow is set", () => {
    const config = {
      cron: {
        timezone: "UTC",
        jobs: [
          { id: "paused", delivery: "signal", enabled: false, schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello" },
        ],
      },
      agents: {
        personal: { id: "personal", name: "Personal", maxTurns: 50 },
      },
    } as unknown as LoadedConfig;
    startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).not.toHaveBeenCalled();
  });

  it("skips job with missing topicId", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{ name: "no-topic", delivery: "signal", schedule: "0 8 * * *", agent: "personal", prompt: "hi" }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("skips job with unknown agent", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{ name: "unknown", delivery: "signal", schedule: "0 8 * * *", agent: "ghost", topicId: 99, prompt: "hi" }],
      },
      agents: {},
    } as unknown as LoadedConfig;
    startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("returns a stop function that stops all tasks", () => {
    const mockTask = { stop: vi.fn() };
    mockSchedule.mockReturnValue(mockTask);
    const config = {
      cron: {
        timezone: "UTC",
        jobs: [
          { id: "job1", delivery: "signal", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello" },
          { id: "job2", delivery: "signal", schedule: "0 9 * * *", agent: "personal", topicId: 2, prompt: "World" },
        ],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    const stop = startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).toHaveBeenCalledTimes(2);

    stop();
    expect(mockTask.stop).toHaveBeenCalledTimes(2);
  });

  it("does not deliver [SKIP] responses", async () => {
    const runClaude = vi.fn().mockResolvedValue({ text: "[SKIP] No data available today", sessionId: "s1" });
    const sendToTopic = vi.fn();
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{ id: "skiptest", delivery: "signal", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Check data" }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);
    await handler!();

    expect(runClaude).toHaveBeenCalled();
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it("delivers a short signal instead of using a length heuristic", async () => {
    const runClaude = vi.fn().mockResolvedValue({ text: "OK", sessionId: "s1" });
    const sendToTopic = vi.fn().mockResolvedValue([]);
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{ id: "shorttest", delivery: "signal", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Check data" }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);
    await handler!();

    expect(sendToTopic).toHaveBeenCalledWith(2, "OK", "s1");
  });

  it("coalesces a repeated fire while the same job is still running", async () => {
    let resolveFirst: ((value: { text: string; sessionId?: string }) => void) | undefined;
    const runClaude = vi.fn().mockImplementation(() => new Promise<{ text: string; sessionId?: string }>((r) => { resolveFirst = r; }));
    const sendToTopic = vi.fn().mockResolvedValue([1]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{ id: "locktest", delivery: "signal", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello" }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);

    // First call starts running (unresolved promise)
    const first = handler!();
    await vi.waitFor(() => expect(runClaude).toHaveBeenCalledTimes(1));

    // Second call while first is still running — coalesced, not backlogged.
    await handler!();

    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("coalesced"));

    // Clean up the pending promise
    resolveFirst!({ text: "done with long response text", sessionId: "s1" });
    await first;

    logSpy.mockRestore();
  });

  it("queues a distinct job when the same agent is busy, then runs it", async () => {
    let resolveFirst: ((value: { text: string; sessionId?: string }) => void) | undefined;
    const runClaude = vi.fn()
      .mockImplementationOnce(() => new Promise<{ text: string; sessionId?: string }>((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ text: "second job completed with useful content", sessionId: "s2" });
    const sendToTopic = vi.fn().mockResolvedValue([1]);
    const handlers: Array<() => Promise<void>> = [];

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handlers.push(fn);
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "UTC",
        jobs: [
          { id: "weekly-chart", delivery: "signal", schedule: "0 7 * * 6", agent: "health", topicId: 6, prompt: "chart" },
          { id: "weekly-review", delivery: "signal", schedule: "0 8 * * 6", agent: "health", topicId: 6, prompt: "review" },
        ],
      },
      agents: { health: { id: "health", name: "Health", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);

    const first = handlers[0]!();
    await vi.waitFor(() => expect(runClaude).toHaveBeenCalledTimes(1));
    const second = handlers[1]!();
    await Promise.resolve();
    expect(runClaude).toHaveBeenCalledTimes(1);

    resolveFirst!({ text: "first job completed with useful content", sessionId: "s1" });
    await Promise.all([first, second]);

    expect(runClaude).toHaveBeenCalledTimes(2);
    expect(runClaude.mock.calls[1]![2]).toBe("review");
    expect(sendToTopic).toHaveBeenCalledTimes(2);
  });

  it("passes maxTurns as options object to runClaude", async () => {
    const runClaude = vi.fn().mockResolvedValue({ text: "test response", sessionId: "s1" });
    const sendToTopic = vi.fn().mockResolvedValue([]);
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{ id: "test", delivery: "signal", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello", maxTurns: 15 }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);

    await handler!();
    expect(runClaude).toHaveBeenCalledWith("personal", 2, "Hello", { maxTurns: 15 });
  });

  it("passes cron skill and tool-scope options to runClaude", async () => {
    const runClaude = vi.fn().mockResolvedValue({ text: "test response with enough content", sessionId: "s1" });
    const sendToTopic = vi.fn().mockResolvedValue([1]);
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{
          id: "scoped",
          delivery: "signal",
          schedule: "0 8 * * *",
          agent: "personal",
          topicId: 2,
          prompt: "Hello",
          skills: ["email-triage"],
          enabledToolsets: ["memory", "gmail"],
          disabledTools: ["gmail_send"],
        }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);

    await handler!();
    expect(runClaude).toHaveBeenCalledWith("personal", 2, "Hello", {
      maxTurns: 50,
      skills: ["email-triage"],
      enabledToolsets: ["memory", "gmail"],
      disabledTools: ["gmail_send"],
    });
  });

  it("runs silent maintenance without messaging tools or final delivery", async () => {
    const runClaude = vi.fn().mockResolvedValue({ text: "Memory saved successfully.", sessionId: "s1", toolCount: 1 });
    const sendToTopic = vi.fn();
    let handler: (() => Promise<void>) | undefined;
    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });
    const config = {
      cron: { timezone: "UTC", jobs: [{
        id: "maintenance",
        delivery: "silent",
        schedule: "0 8 * * *",
        agent: "personal",
        topicId: 2,
        prompt: "save memory",
      }] },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;

    startCronJobs(config, runClaude, sendToTopic);
    await handler!();

    expect(runClaude).toHaveBeenCalledWith("personal", 2, "save memory", {
      maxTurns: 50,
      disabledToolsets: ["messaging"],
    });
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it("suppresses duplicate confirmation after a dedicated direct delivery", async () => {
    const runClaude = vi.fn().mockResolvedValue({
      text: "Prompt sent to topic 6.",
      sessionId: "s1",
      toolCount: 1,
      directMessageCount: 1,
    });
    const sendToTopic = vi.fn();
    let handler: (() => Promise<void>) | undefined;
    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });
    const config = {
      cron: { timezone: "UTC", jobs: [{
        id: "artifact",
        delivery: "signal",
        schedule: "0 8 * * *",
        agent: "health",
        topicId: 6,
        prompt: "send one artifact",
      }] },
      agents: { health: { id: "health", name: "Health", maxTurns: 50 } },
    } as unknown as LoadedConfig;

    startCronJobs(config, runClaude, sendToTopic);
    await handler!();
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it("runs a paused runNow job once and clears runNow in cron.yaml", async () => {
    const dir = mkdtempSync(join(tmpdir(), "letyclaw-cron-test-"));
    const file = join(dir, "cron.yaml");
    process.env.LETYCLAW_CRON_CONFIG = file;
    writeFileSync(file, [
      "cron:",
      "  timezone: UTC",
      "  jobs:",
      "    - id: run-now",
      "      delivery: signal",
      "      schedule: \"0 8 * * *\"",
      "      agent: personal",
      "      topicId: 2",
      "      prompt: Hello",
      "      enabled: false",
      "      runNow: true",
      "",
    ].join("\n"));

    const runClaude = vi.fn().mockResolvedValue({ text: "run now response with enough content", sessionId: "s1" });
    const sendToTopic = vi.fn().mockResolvedValue([1]);
    const config = {
      cron: {
        timezone: "UTC",
        jobs: [{
          id: "run-now",
          delivery: "signal",
          schedule: "0 8 * * *",
          agent: "personal",
          topicId: 2,
          prompt: "Hello",
          enabled: false,
          runNow: true,
        }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;

    try {
      startCronJobs(config, runClaude, sendToTopic);
      expect(cron.schedule).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(runClaude).toHaveBeenCalledTimes(1));
      expect(readFileSync(file, "utf8")).not.toContain("runNow");
    } finally {
      delete process.env.LETYCLAW_CRON_CONFIG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("expectsTools (no-op briefing detection)", () => {
    const baseJob = { id: "briefing-morning", delivery: "signal", schedule: "0 9 * * *", agent: "personal", topicId: 2, prompt: "brief" };
    const agents = { personal: { id: "personal", name: "Personal", maxTurns: 10 } };
    const mkConfig = (jobExtra: Record<string, unknown>) => ({
      cron: { timezone: "UTC", jobs: [{ ...baseJob, ...jobExtra }] },
      agents,
    } as unknown as LoadedConfig);

    it("treats a zero-tool non-[SKIP] run as a quiet failure, then delivers a successful retry", async () => {
      vi.useFakeTimers();
      // A real (long) reply but zero tools → aborted run that should NOT ship.
      const runClaude = vi.fn()
        .mockResolvedValueOnce({ text: "Limit reached. Resets at 4pm.", sessionId: "s1", toolCount: 0 })
        .mockResolvedValueOnce({ text: "Real briefing with content.", sessionId: "s2", toolCount: 12 });
      const sendToTopic = vi.fn().mockResolvedValue([1]);
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_s: string, fn: () => Promise<void>) => { handler = fn; return { stop: vi.fn() }; });

      startCronJobs(mkConfig({ expectsTools: true }), runClaude, sendToTopic);
      await handler!();

      // First run: neither the aborted output nor service chatter is delivered.
      expect(sendToTopic).not.toHaveBeenCalled();

      // Retry produces real tool activity → delivered.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
      expect(runClaude).toHaveBeenCalledTimes(2);
      expect(sendToTopic).toHaveBeenCalledTimes(1);
      expect(sendToTopic.mock.calls[0]![1]).toMatch(/Real briefing/);
      vi.useRealTimers();
    });

    it("never delivers an organization-access error, even without expectsTools", async () => {
      vi.useFakeTimers();
      const runClaude = vi.fn()
        .mockResolvedValueOnce({ text: "This organization does not have access to Claude", sessionId: "s1", toolCount: 0 })
        .mockResolvedValueOnce({ text: "Real cron result after access recovered.", sessionId: "s2", toolCount: 0 });
      const sendToTopic = vi.fn().mockResolvedValue([1]);
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_s: string, fn: () => Promise<void>) => { handler = fn; return { stop: vi.fn() }; });

      startCronJobs(mkConfig({}), runClaude, sendToTopic);
      await handler!();

      expect(sendToTopic).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
      expect(sendToTopic).toHaveBeenCalledTimes(1);
      expect(sendToTopic.mock.calls[0]![1]).toMatch(/Real cron result/);
      vi.useRealTimers();
    });

    it("delivers normally when tools were used", async () => {
      const runClaude = vi.fn().mockResolvedValue({ text: "Briefing with real content here.", sessionId: "s1", toolCount: 8 });
      const sendToTopic = vi.fn().mockResolvedValue([1]);
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_s: string, fn: () => Promise<void>) => { handler = fn; return { stop: vi.fn() }; });

      startCronJobs(mkConfig({ expectsTools: true }), runClaude, sendToTopic);
      await handler!();

      expect(sendToTopic).toHaveBeenCalledTimes(1);
      expect(sendToTopic.mock.calls[0]![1]).toMatch(/Briefing with real content/);
    });

    it("still honors [SKIP] under expectsTools (no false failure)", async () => {
      const runClaude = vi.fn().mockResolvedValue({ text: "[SKIP] nothing due", sessionId: "s1", toolCount: 0 });
      const sendToTopic = vi.fn();
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_s: string, fn: () => Promise<void>) => { handler = fn; return { stop: vi.fn() }; });

      startCronJobs(mkConfig({ expectsTools: true }), runClaude, sendToTopic);
      await handler!();

      expect(sendToTopic).not.toHaveBeenCalled();
    });

    it("does NOT fail a zero-tool run when expectsTools is unset (default unchanged)", async () => {
      const runClaude = vi.fn().mockResolvedValue({ text: "A short reply with no tools at all.", sessionId: "s1", toolCount: 0 });
      const sendToTopic = vi.fn().mockResolvedValue([1]);
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_s: string, fn: () => Promise<void>) => { handler = fn; return { stop: vi.fn() }; });

      startCronJobs(mkConfig({}), runClaude, sendToTopic);
      await handler!();

      expect(sendToTopic).toHaveBeenCalledTimes(1);
      expect(sendToTopic.mock.calls[0]![1]).toMatch(/short reply with no tools/);
    });
  });

  describe("expiresAt handling", () => {
    it("skips and stops a job whose expiresAt is in the past", async () => {
      const runClaude = vi.fn();
      const sendToTopic = vi.fn();
      const stopMock = vi.fn();

      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
        handler = fn;
        return { stop: stopMock };
      });

      const pastIso = new Date(Date.now() - 60_000).toISOString();
      const config = {
        cron: {
          timezone: "UTC",
          jobs: [{
            id: "watch-stale-20260101",
            delivery: "signal",
            schedule: "*/15 * * * *",
            agent: "personal",
            topicId: 5,
            prompt: "stale watch",
            expiresAt: pastIso,
          }],
        },
        agents: { personal: { id: "personal", name: "Personal", maxTurns: 10 } },
      } as unknown as LoadedConfig;

      startCronJobs(config, runClaude, sendToTopic);
      await handler!();
      expect(runClaude).not.toHaveBeenCalled();
      expect(stopMock).toHaveBeenCalled();
    });

    it("does not replay an ambiguously crashed run that may already have side effects", async () => {
      vi.useFakeTimers();
      const runClaude = vi.fn().mockRejectedValueOnce(new Error("Claude failed: timeout after 1200000ms"));
      const sendToTopic = vi.fn().mockResolvedValue([1]);

      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
        handler = fn;
        return { stop: vi.fn() };
      });

      const config = {
        cron: {
          timezone: "UTC",
          jobs: [{
            id: "briefing-morning",
            delivery: "signal",
            schedule: "0 9 * * *",
            agent: "personal",
            topicId: 2,
            prompt: "morning brief",
            maxTurns: 35,
          }],
        },
        agents: { personal: { id: "personal", name: "Personal", maxTurns: 10 } },
      } as unknown as LoadedConfig;

      startCronJobs(config, runClaude, sendToTopic);
      await handler!();

      // First call: Claude failed, but operational errors stay in the journal.
      expect(runClaude).toHaveBeenCalledTimes(1);
      expect(sendToTopic).not.toHaveBeenCalled();

      // Fast-forward past the 5-minute retry timer
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);

      // A subprocess timeout cannot prove that zero external tool calls ran.
      expect(runClaude).toHaveBeenCalledTimes(1);
      expect(sendToTopic).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("retries a rejected run only when the runner explicitly proves zero side effects", async () => {
      vi.useFakeTimers();
      const safeFailure = Object.assign(new Error("provider unavailable before execution"), {
        safeToRetryClaudeAttempt: true,
      });
      const runClaude = vi.fn()
        .mockRejectedValueOnce(safeFailure)
        .mockResolvedValueOnce({ text: "Recovered briefing with complete content.", toolCount: 2 });
      const sendToTopic = vi.fn().mockResolvedValue([1]);
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
        handler = fn;
        return { stop: vi.fn() };
      });
      const config = {
        cron: { timezone: "UTC", jobs: [
          { id: "safe-retry", delivery: "signal", schedule: "0 9 * * *", agent: "personal", topicId: 2, prompt: "x" },
        ] },
        agents: { personal: { id: "personal", name: "Personal", maxTurns: 10 } },
      } as unknown as LoadedConfig;

      startCronJobs(config, runClaude, sendToTopic);
      await handler!();
      expect(sendToTopic).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
      expect(runClaude).toHaveBeenCalledTimes(2);
      expect(sendToTopic).toHaveBeenCalledTimes(1);
      expect(sendToTopic.mock.calls[0]![1]).toMatch(/Recovered briefing/);
      vi.useRealTimers();
    });

    it("cancels a delayed retry when the scheduler is stopped/reloaded", async () => {
      vi.useFakeTimers();
      const runClaude = vi.fn().mockResolvedValue({
        text: "This organization does not have access to Claude",
        sessionId: "s1",
        toolCount: 0,
      });
      const sendToTopic = vi.fn().mockResolvedValue([1]);
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
        handler = fn;
        return { stop: vi.fn() };
      });

      const config = {
        cron: {
          timezone: "UTC",
          jobs: [{ id: "reload-safe", delivery: "signal", schedule: "0 9 * * *", agent: "personal", topicId: 2, prompt: "x" }],
        },
        agents: { personal: { id: "personal", name: "Personal", maxTurns: 10 } },
      } as unknown as LoadedConfig;

      const stop = startCronJobs(config, runClaude, sendToTopic);
      await handler!();
      expect(runClaude).toHaveBeenCalledTimes(1);
      stop();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
      expect(runClaude).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("gives up quietly after one retry and does not retry a third time", async () => {
      vi.useFakeTimers();
      const runClaude = vi.fn()
        .mockResolvedValueOnce({ text: "This organization does not have access to Claude", toolCount: 0 })
        .mockResolvedValueOnce({ text: "This organization does not have access to Claude", toolCount: 0 });
      const sendToTopic = vi.fn().mockResolvedValue([1]);

      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
        handler = fn;
        return { stop: vi.fn() };
      });

      const config = {
        cron: {
          timezone: "UTC",
          jobs: [{ id: "briefing-morning", delivery: "signal", schedule: "0 9 * * *", agent: "personal", topicId: 2, prompt: "x" }],
        },
        agents: { personal: { id: "personal", name: "Personal", maxTurns: 10 } },
      } as unknown as LoadedConfig;

      startCronJobs(config, runClaude, sendToTopic);
      await handler!();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);

      // Exactly two runClaude calls (initial + 1 retry — no second retry)
      expect(runClaude).toHaveBeenCalledTimes(2);
      // No retry/give-up service message is posted.
      expect(sendToTopic).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("does not rerun Claude after an ambiguous Telegram delivery failure", async () => {
      vi.useFakeTimers();
      const runClaude = vi.fn().mockResolvedValue({
        text: "A complete cron result with externally gathered data.",
        sessionId: "s1",
        toolCount: 4,
      });
      const sendToTopic = vi.fn().mockRejectedValue(new Error("socket hang up during send"));
      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
        handler = fn;
        return { stop: vi.fn() };
      });
      const config = {
        cron: { timezone: "UTC", jobs: [
          { id: "delivery-risk", delivery: "signal", schedule: "0 9 * * *", agent: "personal", topicId: 2, prompt: "x" },
        ] },
        agents: { personal: { id: "personal", name: "Personal", maxTurns: 10 } },
      } as unknown as LoadedConfig;

      startCronJobs(config, runClaude, sendToTopic);
      await handler!();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
      expect(runClaude).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("still runs a job whose expiresAt is in the future", async () => {
      const runClaude = vi.fn().mockResolvedValue({ text: "x".repeat(100) });
      const sendToTopic = vi.fn().mockResolvedValue([1]);
      const stopMock = vi.fn();

      let handler: (() => Promise<void>) | null = null;
      mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
        handler = fn;
        return { stop: stopMock };
      });

      const futureIso = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      const config = {
        cron: {
          timezone: "UTC",
          jobs: [{
            id: "watch-live-20260601",
            delivery: "signal",
            schedule: "*/15 * * * *",
            agent: "personal",
            topicId: 5,
            prompt: "live watch",
            expiresAt: futureIso,
          }],
        },
        agents: { personal: { id: "personal", name: "Personal", maxTurns: 10 } },
      } as unknown as LoadedConfig;

      startCronJobs(config, runClaude, sendToTopic);
      await handler!();
      expect(runClaude).toHaveBeenCalledTimes(1);
      expect(stopMock).not.toHaveBeenCalled();
    });
  });
});
