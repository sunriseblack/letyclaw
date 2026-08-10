import { describe, expect, it } from "vitest";
import {
  annotateSparseAppleHealthPayload,
  inspectAppleActivityPayload,
  resolveDailyActivity,
  shiftIsoDate,
} from "../services/health-activity.js";

const oura = (day = "2026-07-09", steps = 10_000, activeCalories = 800) => ({
  activity: [{ day, steps, active_calories: activeCalories }],
});

describe("health activity quality", () => {
  it("shifts calendar dates without depending on server timezone or DST", () => {
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftIsoDate("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftIsoDate("2026-10-26", -1)).toBe("2026-10-25");
  });

  it("marks the legacy Shortcut payload untrusted even when numbers are populated", () => {
    const inspection = inspectAppleActivityPayload({
      steps: "40000",
      active_energy: "2400.5",
      exercise: "180",
    }, "2026-07-09");

    expect(inspection.status).toBe("untrusted");
    expect(inspection.trusted_metrics).toEqual({
      steps: false,
      active_energy_kcal: false,
      exercise_minutes: false,
    });
    expect(inspection.issues).toEqual(expect.arrayContaining([
      "schema_version_missing_or_legacy",
      "activity_date_missing",
      "activity_source_missing",
    ]));
  });

  it("preserves a delivered sparse payload and labels it degraded instead of absent", () => {
    const payload = annotateSparseAppleHealthPayload({
      timezone: "UTC",
      schema_version: "2",
      activity_date: "2026-07-19",
      activity_source: "apple_watch",
      steps: "",
      active_energy_kcal: "",
      exercise_minutes: "",
      heart_rate_avg: "51.09375",
      sleep: "Awake",
      _ingest: { received_at: "2026-07-20T06:34:16.736Z" },
    }, "2026-07-19");

    expect(payload).toMatchObject({
      schema_version: "2",
      activity_date: "2026-07-19",
      activity_source: "apple_watch",
      heart_rate_avg: "51.09375",
      _warning: "Apple Health payload arrived with only 2 populated signal field(s); activity is missing",
    });
    expect(inspectAppleActivityPayload(payload, "2026-07-19")).toMatchObject({
      status: "missing",
      activity_date: "2026-07-19",
      activity_source: "apple_watch",
      issues: ["steps_missing", "active_energy_missing", "exercise_minutes_missing"],
    });
  });

  it("does not annotate a trusted completed-day Apple payload as sparse", () => {
    const payload = {
      schema_version: 2,
      activity_date: "2026-07-19",
      activity_source: "apple_watch",
      steps: 12_000,
      active_energy_kcal: 750,
      exercise_minutes: 45,
    };

    expect(annotateSparseAppleHealthPayload(payload, "2026-07-19")).toBe(payload);
  });

  it("uses completed-day Oura values instead of summing a duplicate legacy Apple payload", () => {
    const resolved = resolveDailyActivity({
      steps: "40000",
      active_energy: "2400",
      exercise: "180",
    }, oura(), "2026-07-09");

    expect(resolved).toMatchObject({
      period_date: "2026-07-09",
      period_semantics: "completed_calendar_day",
      quality: "fallback",
      steps: 10_000,
      active_energy_kcal: 800,
      exercise_minutes: null,
      provenance: {
        steps: "oura_api",
        active_energy_kcal: "oura_api",
        exercise_minutes: "missing",
      },
    });
    expect(resolved.comparisons).toEqual({});
    expect(resolved.warnings).not.toEqual(expect.arrayContaining([
      "steps_sources_diverge",
      "active_energy_sources_diverge",
    ]));
  });

  it("prefers a schema-v2 Apple Watch payload without adding Oura values", () => {
    const resolved = resolveDailyActivity({
      schema_version: 2,
      activity_date: "2026-07-09",
      activity_source: "apple_watch",
      steps: "12000",
      active_energy_kcal: "750.4",
      exercise_minutes: "45",
    }, oura(), "2026-07-09");

    expect(resolved).toMatchObject({
      quality: "ok",
      steps: 12_000,
      active_energy_kcal: 750,
      exercise_minutes: 45,
      provenance: {
        steps: "apple_watch",
        active_energy_kcal: "apple_watch",
        exercise_minutes: "apple_watch",
      },
      apple_health: { status: "trusted" },
      oura: { status: "trusted" },
    });
    expect(resolved.comparisons).toEqual({
      steps_apple_to_oura_ratio: 1.2,
      active_energy_apple_to_oura_ratio: 0.94,
    });
  });

  it("falls back per metric without blending source values", () => {
    const resolved = resolveDailyActivity({
      schema_version: 2,
      activity_date: "2026-07-09",
      activity_source: "apple_watch",
      steps: 9_500,
      active_energy_kcal: "",
      exercise_minutes: 30,
    }, oura(), "2026-07-09");

    expect(resolved).toMatchObject({
      quality: "fallback",
      steps: 9_500,
      active_energy_kcal: 800,
      exercise_minutes: 30,
      provenance: {
        steps: "apple_watch",
        active_energy_kcal: "oura_api",
        exercise_minutes: "apple_watch",
      },
    });
  });

  it("does not report incomplete Oura totals as full-day activity", () => {
    const resolved = resolveDailyActivity({}, {
      activity: [{
        day: "2026-07-09",
        steps: 2_057,
        active_calories: 152,
        non_wear_time: 62_040,
      }],
    }, "2026-07-09");

    expect(resolved).toMatchObject({
      quality: "missing",
      steps: null,
      active_energy_kcal: null,
      provenance: {
        steps: "missing",
        active_energy_kcal: "missing",
      },
      oura: {
        status: "low_coverage",
        wear_coverage: "insufficient",
        non_wear_minutes: 1_034,
      },
    });
    expect(resolved.warnings).toContain("oura_activity_insufficient_wear_coverage");
  });

  it("retains reduced-coverage Oura totals with an explicit warning", () => {
    const resolved = resolveDailyActivity({}, {
      activity: [{
        day: "2026-07-09",
        steps: 7_500,
        active_calories: 650,
        non_wear_time: 28_800,
      }],
    }, "2026-07-09");

    expect(resolved).toMatchObject({
      quality: "fallback",
      steps: 7_500,
      active_energy_kcal: 650,
      oura: {
        status: "trusted",
        wear_coverage: "reduced",
        non_wear_minutes: 480,
      },
    });
    expect(resolved.warnings).toContain("oura_activity_reduced_wear_coverage");
  });

  it("uses a trusted Apple Watch payload when Oura coverage is insufficient", () => {
    const resolved = resolveDailyActivity({
      schema_version: 2,
      activity_date: "2026-07-09",
      activity_source: "apple_watch",
      steps: 11_250,
      active_energy_kcal: 720,
      exercise_minutes: 42,
    }, {
      activity: [{
        day: "2026-07-09",
        steps: 2_057,
        active_calories: 152,
        non_wear_time: 62_040,
      }],
    }, "2026-07-09");

    expect(resolved).toMatchObject({
      quality: "ok",
      steps: 11_250,
      active_energy_kcal: 720,
      exercise_minutes: 42,
      provenance: {
        steps: "apple_watch",
        active_energy_kcal: "apple_watch",
        exercise_minutes: "apple_watch",
      },
      oura: { status: "low_coverage" },
    });
    expect(resolved.comparisons).toEqual({});
  });

  it("does not promote wrong-day or implausible Apple values", () => {
    const resolved = resolveDailyActivity({
      schema_version: 2,
      activity_date: "2026-07-10",
      activity_source: "apple_watch",
      steps: 900_000,
      active_energy_kcal: 50_000,
      exercise_minutes: 20,
    }, {}, "2026-07-09");

    expect(resolved.quality).toBe("missing");
    expect(resolved.steps).toBeNull();
    expect(resolved.active_energy_kcal).toBeNull();
    expect(resolved.warnings).toEqual(expect.arrayContaining([
      "activity_date_not_completed_previous_day",
      "steps_out_of_range",
      "active_energy_out_of_range",
    ]));
  });
});
