import { describe, it, expect } from "vitest";
import { ageDaysFromPath, decayFactor } from "../tools/letyclaw-mcp/tools/memory-db.js";

describe("ageDaysFromPath", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");

  it("parses the date from a dated memory filename", () => {
    // note date is midnight UTC; now is 2026-06-01T12:00Z → 2026-05-31 is 1.5d old.
    expect(ageDaysFromPath("health/memory/2026-05-31.md", now)).toBeCloseTo(1.5, 1);
    expect(ageDaysFromPath("p/2026-05-02.md", now)).toBeCloseTo(30.5, 1);
  });

  it("parses a slugged date filename", () => {
    expect(ageDaysFromPath("2026-05-02-standup.md", now)).toBeCloseTo(30.5, 1);
  });

  it("returns null for an undated/curated file (evergreen)", () => {
    expect(ageDaysFromPath("MEMORY.md", now)).toBeNull();
    expect(ageDaysFromPath("notes.md", now)).toBeNull();
  });

  it("never returns negative age for a future-dated file", () => {
    expect(ageDaysFromPath("2099-01-01.md", now)).toBe(0);
  });
});

describe("decayFactor (30-day half-life)", () => {
  it("is 1.0 for evergreen (null age) and for today", () => {
    expect(decayFactor(null)).toBe(1);
    expect(decayFactor(0)).toBe(1);
  });

  it("halves the weight at 30 days and quarters at 60", () => {
    expect(decayFactor(30)).toBeCloseTo(0.5, 2);
    expect(decayFactor(60)).toBeCloseTo(0.25, 2);
  });

  it("is monotonically decreasing with age", () => {
    expect(decayFactor(1)).toBeGreaterThan(decayFactor(10));
    expect(decayFactor(10)).toBeGreaterThan(decayFactor(100));
  });

  it("lets a recent note outrank an equally-relevant old one", () => {
    const relevance = 0.8;
    const recent = relevance * decayFactor(2);
    const old = relevance * decayFactor(90);
    expect(recent).toBeGreaterThan(old);
  });
});
