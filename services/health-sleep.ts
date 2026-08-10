export type ResolvedSleepStatus = "current" | "stale" | "missing" | "invalid";

export interface ResolvedDailySleep {
  report_date: string;
  status: ResolvedSleepStatus;
  day: string | null;
  age_days: number | null;
  score: number | null;
  bedtime_start: string | null;
  bedtime_end: string | null;
  period_source: "oura_sleep_period" | "missing";
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function score(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? Math.round(parsed) : null;
}

function dayDistance(earlier: string, later: string): number {
  const start = new Date(`${earlier}T12:00:00.000Z`).getTime();
  const end = new Date(`${later}T12:00:00.000Z`).getTime();
  return Math.round((end - start) / 86_400_000);
}

export function resolveDailySleep(
  oura: Record<string, unknown>,
  reportDate: string,
): ResolvedDailySleep {
  if (!ISO_DATE.test(reportDate)) throw new Error(`Invalid ISO date: ${reportDate}`);

  const allDaily = records(oura.sleep)
    .filter(item => ISO_DATE.test(text(item.day) || ""))
    .sort((a, b) => String(b.day).localeCompare(String(a.day)));
  const daily = allDaily.find(item => String(item.day) <= reportDate) ?? allDaily[0];
  if (!daily) {
    return {
      report_date: reportDate,
      status: "missing",
      day: null,
      age_days: null,
      score: null,
      bedtime_start: null,
      bedtime_end: null,
      period_source: "missing",
      warnings: ["oura_daily_sleep_missing"],
    };
  }

  const day = text(daily.day)!;
  const ageDays = dayDistance(day, reportDate);
  const warnings: string[] = [];
  let status: ResolvedSleepStatus;
  if (ageDays < 0) {
    status = "invalid";
    warnings.push("oura_daily_sleep_day_in_future");
  } else if (ageDays === 0) {
    status = "current";
  } else {
    status = "stale";
    warnings.push("oura_daily_sleep_stale");
  }

  const periods = records(oura.sleep_periods)
    .filter(item => item.day === day)
    .sort((a, b) => {
      const aLong = a.type === "long_sleep" ? 1 : 0;
      const bLong = b.type === "long_sleep" ? 1 : 0;
      if (aLong !== bLong) return bLong - aLong;
      return String(b.bedtime_end || "").localeCompare(String(a.bedtime_end || ""));
    });
  const period = periods[0];
  const bedtimeStart = text(period?.bedtime_start);
  const bedtimeEnd = text(period?.bedtime_end);
  if (!bedtimeStart || !bedtimeEnd) warnings.push("oura_sleep_period_missing");

  const dailyScore = score(daily.score);
  if (dailyScore === null) warnings.push("oura_sleep_score_missing_or_invalid");

  return {
    report_date: reportDate,
    status,
    day,
    age_days: ageDays,
    score: dailyScore,
    bedtime_start: bedtimeStart,
    bedtime_end: bedtimeEnd,
    period_source: bedtimeStart && bedtimeEnd ? "oura_sleep_period" : "missing",
    warnings: [...new Set(warnings)],
  };
}
