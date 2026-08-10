import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkBillableRateLimit,
  billableRateLimitError,
  reserveBillableRateLimit,
  releaseBillableRateLimit,
} from "../tools/letyclaw-mcp/tools/_util.js";

// checkBillableRateLimit persists under SESSIONS_DIR; point it at a tmp dir.
let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "letyclaw-rl-"));
  process.env.LETYCLAW_SESSIONS_DIR = tmp;
});
afterEach(() => {
  delete process.env.LETYCLAW_SESSIONS_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe("checkBillableRateLimit", () => {
  it("allows up to max calls then blocks", () => {
    const win = 60_000;
    expect(checkBillableRateLimit("voice_call", 3, win).allowed).toBe(true);
    expect(checkBillableRateLimit("voice_call", 3, win).allowed).toBe(true);
    expect(checkBillableRateLimit("voice_call", 3, win).allowed).toBe(true);
    const blocked = checkBillableRateLimit("voice_call", 3, win);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("isolates windows per tool", () => {
    expect(checkBillableRateLimit("tts", 1, 60_000).allowed).toBe(true);
    expect(checkBillableRateLimit("tts", 1, 60_000).allowed).toBe(false);
    // a different tool has its own budget
    expect(checkBillableRateLimit("image_generate", 1, 60_000).allowed).toBe(true);
  });

  it("expires old timestamps outside the window", () => {
    const now = 1_000_000_000_000;
    expect(checkBillableRateLimit("voice_call", 1, 10_000, now).allowed).toBe(true);
    expect(checkBillableRateLimit("voice_call", 1, 10_000, now + 1000).allowed).toBe(false);
    // 11s later the first stamp has aged out
    expect(checkBillableRateLimit("voice_call", 1, 10_000, now + 11_000).allowed).toBe(true);
  });

  it("billableRateLimitError returns null while allowed, an MCP error when blocked", () => {
    expect(billableRateLimitError("voice_call", 1, 60_000)).toBeNull();
    const err = billableRateLimitError("voice_call", 1, 60_000);
    expect(err).not.toBeNull();
    expect(err!.isError).toBe(true);
    expect(err!.content[0]!.text).toContain("Rate limit");
  });

  it("reuses a stable reservation and releases only that reservation", () => {
    expect(reserveBillableRateLimit("voice", 1, 60_000, "call-a").allowed).toBe(true);
    expect(reserveBillableRateLimit("voice", 1, 60_000, "call-a")).toMatchObject({
      allowed: true,
      alreadyReserved: true,
    });
    expect(reserveBillableRateLimit("voice", 1, 60_000, "call-b").allowed).toBe(false);
    releaseBillableRateLimit("voice", "call-a");
    expect(reserveBillableRateLimit("voice", 1, 60_000, "call-b").allowed).toBe(true);
  });

  it("fails closed when persisted billable state is corrupt", () => {
    const dir = join(tmp, ".ratelimits");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "voice.json"), "not-json");
    expect(reserveBillableRateLimit("voice", 1, 60_000, "call-a")).toMatchObject({
      allowed: false,
      used: 1,
      max: 1,
    });
  });
});
