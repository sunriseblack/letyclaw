import { vi } from "vitest";
import cron from "node-cron";
import type { LoadedConfig } from "../types.js";
import { startCronJobs } from "../cron.js";

vi.mock("node-cron", () => ({
  default: { schedule: vi.fn() },
}));

const mockSchedule = cron.schedule as ReturnType<typeof vi.fn>;

describe("startCronJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers no jobs when jobs list is empty", () => {
    const config = {
      cron: { timezone: "Europe/Madrid", jobs: [] },
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
        timezone: "Europe/Madrid",
        jobs: [
          { name: "test_job", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello" },
        ],
      },
      agents: {
        personal: { id: "personal", name: "Personal", maxTurns: 50 },
      },
    } as unknown as LoadedConfig;
    startCronJobs(config, vi.fn(), vi.fn());
    expect(cron.schedule).toHaveBeenCalledTimes(1);
  });

  it("skips job with missing topicId", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = {
      cron: {
        timezone: "Europe/Madrid",
        jobs: [{ name: "no-topic", schedule: "0 8 * * *", agent: "personal", prompt: "hi" }],
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
        timezone: "Europe/Madrid",
        jobs: [{ name: "unknown", schedule: "0 8 * * *", agent: "ghost", topicId: 99, prompt: "hi" }],
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
        timezone: "Europe/Madrid",
        jobs: [
          { id: "job1", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello" },
          { id: "job2", schedule: "0 9 * * *", agent: "personal", topicId: 2, prompt: "World" },
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
    const runClaude = vi.fn().mockResolvedValue("[SKIP] No data available today");
    const sendToTopic = vi.fn();
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "Europe/Madrid",
        jobs: [{ id: "skiptest", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Check data" }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);
    await handler!();

    expect(runClaude).toHaveBeenCalled();
    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it("does not deliver very short responses (< 20 chars)", async () => {
    const runClaude = vi.fn().mockResolvedValue("OK");
    const sendToTopic = vi.fn();
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "Europe/Madrid",
        jobs: [{ id: "shorttest", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Check data" }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);
    await handler!();

    expect(sendToTopic).not.toHaveBeenCalled();
  });

  it("skips job when agent is busy (concurrent lock)", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    const runClaude = vi.fn().mockImplementation(() => new Promise<string>((r) => { resolveFirst = r; }));
    const sendToTopic = vi.fn();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "Europe/Madrid",
        jobs: [{ id: "locktest", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello" }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);

    // First call starts running (unresolved promise)
    const first = handler!();

    // Second call while first is still running — should be skipped
    await handler!();

    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("skipped"));

    // Clean up the pending promise
    resolveFirst!("done with long response text");
    await first;

    logSpy.mockRestore();
  });

  it("passes maxTurns as options object to runClaude", async () => {
    const runClaude = vi.fn().mockResolvedValue("test response");
    const sendToTopic = vi.fn();
    let handler: (() => Promise<void>) | undefined;

    mockSchedule.mockImplementation((_schedule: string, fn: () => Promise<void>) => {
      handler = fn;
      return { stop: vi.fn() };
    });

    const config = {
      cron: {
        timezone: "Europe/Madrid",
        jobs: [{ id: "test", schedule: "0 8 * * *", agent: "personal", topicId: 2, prompt: "Hello", maxTurns: 15 }],
      },
      agents: { personal: { id: "personal", name: "Personal", maxTurns: 50 } },
    } as unknown as LoadedConfig;
    startCronJobs(config, runClaude, sendToTopic);

    await handler!();
    expect(runClaude).toHaveBeenCalledWith("personal", 2, "Hello", { maxTurns: 15 });
  });
});
