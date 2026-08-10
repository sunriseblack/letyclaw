import { describe, expect, it } from "vitest";
import {
  filterWithingsGroupsForLocalWindow,
  getWithingsQueryBounds,
  WITHINGS_MEASURE_LOOKBACK_DAYS,
} from "../services/health-withings.js";

describe("Withings measurement window", () => {
  it("queries a guarded 90-day history", () => {
    expect(WITHINGS_MEASURE_LOOKBACK_DAYS).toBe(90);
    const bounds = getWithingsQueryBounds("2026-07-11");

    expect(new Date(bounds.startTs * 1000).toISOString()).toBe("2026-04-11T00:00:00.000Z");
    expect(new Date(bounds.endTs * 1000).toISOString()).toBe("2026-07-12T23:59:59.000Z");
  });

  it("filters by the configured local date across the UTC day boundary", () => {
    const timestamp = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    const groups = [
      { id: "old", date: timestamp("2026-04-11T14:59:59Z") },
      { id: "first", date: timestamp("2026-04-11T15:00:00Z") },
      { id: "last", date: timestamp("2026-07-11T14:59:59Z") },
      { id: "next-day", date: timestamp("2026-07-11T15:00:00Z") },
    ];

    expect(filterWithingsGroupsForLocalWindow(
      groups,
      "2026-07-11",
      "Asia/Tokyo",
    ).map(group => group.id)).toEqual(["first", "last"]);
  });
});
