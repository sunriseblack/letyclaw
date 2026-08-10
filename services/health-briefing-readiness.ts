import type { ResolvedDailyActivity } from "./health-activity.js";
import type { ResolvedDailySleep } from "./health-sleep.js";

export type HealthMorningWaitReason =
  | "completed_day_activity_pending"
  | "oura_sleep_pending"
  | "oura_readiness_pending";

interface HealthMorningReadinessInput {
  activity: ResolvedDailyActivity;
  sleep: ResolvedDailySleep;
  oura: Record<string, unknown>;
  reportDate: string;
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>>
    : [];
}

function hasScoredReadinessForDate(value: unknown, reportDate: string): boolean {
  return records(value).some(item =>
    item.day === reportDate &&
    typeof item.score === "number" &&
    Number.isFinite(item.score),
  );
}

/**
 * Data gaps that are likely to be Oura/HealthKit publication lag during the
 * morning window. The final scheduled tick still delivers an explicitly
 * incomplete briefing if these never resolve.
 */
export function getHealthMorningWaitReasons({
  activity,
  sleep,
  oura,
  reportDate,
}: HealthMorningReadinessInput): HealthMorningWaitReason[] {
  const reasons: HealthMorningWaitReason[] = [];
  const retryableActivityGap = activity.oura.status !== "low_coverage" &&
    (activity.quality === "missing" || activity.quality === "partial");
  if (retryableActivityGap) reasons.push("completed_day_activity_pending");

  const currentSleepIsComplete = sleep.status === "current" &&
    sleep.score !== null &&
    sleep.bedtime_start !== null &&
    sleep.bedtime_end !== null;
  if (!currentSleepIsComplete) reasons.push("oura_sleep_pending");

  if (!hasScoredReadinessForDate(oura.readiness, reportDate)) {
    reasons.push("oura_readiness_pending");
  }

  return reasons;
}

export function shouldWaitForHealthMorningData(
  reasons: HealthMorningWaitReason[],
  localHour: number,
  finalAttemptHour: number,
  force: boolean,
): boolean {
  return !force && reasons.length > 0 && localHour < finalAttemptHour;
}
