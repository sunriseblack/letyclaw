import { shiftIsoDate } from "./health-activity.js";

export const WITHINGS_MEASURE_LOOKBACK_DAYS = 90;

export interface WithingsDatedGroup {
  date: number;
}

export function getWithingsQueryBounds(date: string): { startTs: number; endTs: number } {
  // Query one guard day on each side, then filter by the configured local dates below.
  // This avoids including a next-day measurement around UTC/DST boundaries.
  const start = shiftIsoDate(date, -(WITHINGS_MEASURE_LOOKBACK_DAYS + 1));
  const end = shiftIsoDate(date, 1);
  return {
    startTs: Math.floor(new Date(`${start}T00:00:00.000Z`).getTime() / 1000),
    endTs: Math.floor(new Date(`${end}T23:59:59.000Z`).getTime() / 1000),
  };
}

export function filterWithingsGroupsForLocalWindow<T extends WithingsDatedGroup>(
  groups: T[],
  date: string,
  timezone: string,
): T[] {
  const firstLocalDate = shiftIsoDate(date, -WITHINGS_MEASURE_LOOKBACK_DAYS);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return groups.filter(group => {
    if (!Number.isFinite(group.date)) return false;
    const localDate = formatter.format(new Date(group.date * 1000));
    return localDate >= firstLocalDate && localDate <= date;
  });
}
