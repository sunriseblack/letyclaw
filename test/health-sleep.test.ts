import { describe, expect, it } from "vitest";
import { resolveDailySleep } from "../services/health-sleep.js";

describe("health sleep normalization", () => {
  it("uses the exact Oura sleep period for a current report day", () => {
    const sleep = resolveDailySleep({
      sleep: [{ day: "2026-07-12", score: 82 }],
      sleep_periods: [{
        day: "2026-07-12",
        type: "long_sleep",
        bedtime_start: "2026-07-11T23:40:00+02:00",
        bedtime_end: "2026-07-12T07:35:00+02:00",
      }],
    }, "2026-07-12");

    expect(sleep).toEqual({
      report_date: "2026-07-12",
      status: "current",
      day: "2026-07-12",
      age_days: 0,
      score: 82,
      bedtime_start: "2026-07-11T23:40:00+02:00",
      bedtime_end: "2026-07-12T07:35:00+02:00",
      period_source: "oura_sleep_period",
      warnings: [],
    });
  });

  it("marks an older sleep day stale instead of relabeling it as last night", () => {
    const sleep = resolveDailySleep({
      sleep: [{ day: "2026-07-10", score: 37 }, { day: "2026-07-11", score: 64 }],
      sleep_periods: [{
        day: "2026-07-11",
        type: "long_sleep",
        bedtime_start: "2026-07-11T01:23:28+02:00",
        bedtime_end: "2026-07-11T09:09:53+02:00",
      }],
    }, "2026-07-12");

    expect(sleep).toMatchObject({
      status: "stale",
      day: "2026-07-11",
      age_days: 1,
      bedtime_start: "2026-07-11T01:23:28+02:00",
      bedtime_end: "2026-07-11T09:09:53+02:00",
    });
    expect(sleep.warnings).toContain("oura_daily_sleep_stale");
  });

  it("reports missing data explicitly", () => {
    expect(resolveDailySleep({}, "2026-07-12")).toMatchObject({
      status: "missing",
      day: null,
      score: null,
      warnings: ["oura_daily_sleep_missing"],
    });
  });

  it("does not let a future record hide current data or coerce a null score", () => {
    const sleep = resolveDailySleep({
      sleep: [
        { day: "2026-07-13", score: 90 },
        { day: "2026-07-12", score: null },
      ],
    }, "2026-07-12");

    expect(sleep).toMatchObject({
      status: "current",
      day: "2026-07-12",
      score: null,
    });
    expect(sleep.warnings).toEqual(expect.arrayContaining([
      "oura_sleep_period_missing",
      "oura_sleep_score_missing_or_invalid",
    ]));
  });
});
