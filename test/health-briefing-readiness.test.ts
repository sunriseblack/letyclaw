import { describe, expect, it } from "vitest";
import {
  getHealthMorningWaitReasons,
  shouldWaitForHealthMorningData,
} from "../services/health-briefing-readiness.js";
import type { ResolvedDailyActivity } from "../services/health-activity.js";
import type { ResolvedDailySleep } from "../services/health-sleep.js";

function activity(overrides: Partial<ResolvedDailyActivity> = {}): ResolvedDailyActivity {
  return {
    period_date: "2026-07-21",
    period_semantics: "completed_calendar_day",
    quality: "ok",
    steps: 13731,
    active_energy_kcal: 1263,
    exercise_minutes: 81,
    provenance: {
      steps: "apple_watch",
      active_energy_kcal: "apple_watch",
      exercise_minutes: "apple_watch",
    },
    apple_health: {
      status: "trusted",
      activity_date: "2026-07-21",
      activity_source: "apple_watch",
      issues: [],
    },
    oura: {
      status: "low_coverage",
      wear_coverage: "insufficient",
      non_wear_minutes: 1223,
      issues: ["oura_activity_insufficient_wear_coverage"],
    },
    comparisons: {},
    warnings: ["oura_activity_insufficient_wear_coverage"],
    ...overrides,
  };
}

function sleep(overrides: Partial<ResolvedDailySleep> = {}): ResolvedDailySleep {
  return {
    report_date: "2026-07-22",
    status: "current",
    day: "2026-07-22",
    age_days: 0,
    score: 60,
    bedtime_start: "2026-07-22T01:20:00+02:00",
    bedtime_end: "2026-07-22T08:29:12+02:00",
    period_source: "oura_sleep_period",
    warnings: [],
    ...overrides,
  };
}

describe("health morning data readiness", () => {
  it("waits when Oura has only a stale score and unfinalized sleep fragment", () => {
    const reasons = getHealthMorningWaitReasons({
      activity: activity(),
      sleep: sleep({
        status: "stale",
        day: "2026-07-20",
        age_days: 2,
        score: 70,
        bedtime_start: "2026-07-20T00:14:59+02:00",
        bedtime_end: "2026-07-20T08:29:25+02:00",
      }),
      oura: { readiness: [] },
      reportDate: "2026-07-22",
    });

    expect(reasons).toEqual(["oura_sleep_pending", "oura_readiness_pending"]);
    expect(shouldWaitForHealthMorningData(reasons, 9, 12, false)).toBe(true);
  });

  it("proceeds once current sleep and readiness have finalized", () => {
    const reasons = getHealthMorningWaitReasons({
      activity: activity(),
      sleep: sleep(),
      oura: { readiness: [{ day: "2026-07-22", score: 64 }] },
      reportDate: "2026-07-22",
    });

    expect(reasons).toEqual([]);
    expect(shouldWaitForHealthMorningData(reasons, 10, 12, false)).toBe(false);
  });

  it("delivers the final fallback even when Oura never finalizes", () => {
    const reasons = ["oura_sleep_pending", "oura_readiness_pending"] as const;

    expect(shouldWaitForHealthMorningData([...reasons], 11, 12, false)).toBe(true);
    expect(shouldWaitForHealthMorningData([...reasons], 12, 12, false)).toBe(false);
    expect(shouldWaitForHealthMorningData([...reasons], 9, 12, true)).toBe(false);
  });

  it("retains the existing activity-lag retry without waiting forever on known low coverage", () => {
    const partial = activity({
      quality: "partial",
      oura: {
        status: "missing",
        wear_coverage: "unknown",
        non_wear_minutes: null,
        issues: ["oura_activity_missing"],
      },
    });
    const readiness = [{ day: "2026-07-22", score: 64 }];

    expect(getHealthMorningWaitReasons({
      activity: partial,
      sleep: sleep(),
      oura: { readiness },
      reportDate: "2026-07-22",
    })).toEqual(["completed_day_activity_pending"]);

    expect(getHealthMorningWaitReasons({
      activity: activity({ quality: "partial" }),
      sleep: sleep(),
      oura: { readiness },
      reportDate: "2026-07-22",
    })).toEqual([]);
  });
});
