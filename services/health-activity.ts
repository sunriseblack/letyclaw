export type ActivityMetricSource = "apple_watch" | "oura_api" | "missing";
export type AppleActivityStatus = "trusted" | "untrusted" | "missing";
export type OuraActivityStatus = "trusted" | "low_coverage" | "missing" | "invalid";
export type OuraWearCoverage = "sufficient" | "reduced" | "insufficient" | "unknown";
export type ResolvedActivityQuality = "ok" | "fallback" | "partial" | "missing";

export interface AppleActivityInspection {
  status: AppleActivityStatus;
  expected_date: string;
  activity_date: string | null;
  activity_source: string | null;
  schema_version: number | null;
  metrics: {
    steps: number | null;
    active_energy_kcal: number | null;
    exercise_minutes: number | null;
  };
  trusted_metrics: {
    steps: boolean;
    active_energy_kcal: boolean;
    exercise_minutes: boolean;
  };
  issues: string[];
}

export interface OuraActivityInspection {
  status: OuraActivityStatus;
  expected_date: string;
  wear_coverage: OuraWearCoverage;
  non_wear_minutes: number | null;
  metrics: {
    steps: number | null;
    active_energy_kcal: number | null;
  };
  issues: string[];
}

export interface ResolvedDailyActivity {
  period_date: string;
  period_semantics: "completed_calendar_day";
  quality: ResolvedActivityQuality;
  steps: number | null;
  active_energy_kcal: number | null;
  exercise_minutes: number | null;
  provenance: {
    steps: ActivityMetricSource;
    active_energy_kcal: ActivityMetricSource;
    exercise_minutes: ActivityMetricSource;
  };
  apple_health: Pick<AppleActivityInspection, "status" | "activity_date" | "activity_source" | "issues">;
  oura: Pick<OuraActivityInspection, "status" | "wear_coverage" | "non_wear_minutes" | "issues">;
  comparisons: {
    steps_apple_to_oura_ratio?: number;
    active_energy_apple_to_oura_ratio?: number;
  };
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REDUCED_OURA_COVERAGE_SECONDS = 6 * 60 * 60;
const INSUFFICIENT_OURA_COVERAGE_SECONDS = 12 * 60 * 60;
const MIN_APPLE_SIGNAL_FIELDS = 3;
const APPLE_ENVELOPE_KEYS = new Set([
  "timezone",
  "date",
  "schema_version",
  "activity_date",
  "period_date",
  "activity_source",
  "captured_at",
  "_ingest",
  "_warning",
  "_error",
]);

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedMetric(
  value: unknown,
  minimum: number,
  maximum: number,
  issue: string,
  issues: string[],
): number | null {
  const parsed = number(value);
  if (parsed === null) return null;
  if (parsed < minimum || parsed > maximum) {
    issues.push(issue);
    return null;
  }
  return parsed;
}

function rounded(value: number | null, decimals = 0): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function shiftIsoDate(date: string, days: number): string {
  if (!ISO_DATE.test(date)) throw new Error(`Invalid ISO date: ${date}`);
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid ISO date: ${date}`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function inspectAppleActivityPayload(
  payload: Record<string, unknown>,
  expectedDate: string,
): AppleActivityInspection {
  const issues: string[] = [];
  const schemaVersionRaw = number(payload.schema_version);
  const schemaVersion = schemaVersionRaw === null ? null : Math.trunc(schemaVersionRaw);
  const activityDate = text(payload.activity_date) ?? text(payload.period_date);
  const activitySource = text(payload.activity_source);

  if (schemaVersion === null || schemaVersion < 2) issues.push("schema_version_missing_or_legacy");
  if (!activityDate) issues.push("activity_date_missing");
  else if (!ISO_DATE.test(activityDate)) issues.push("activity_date_invalid");
  else if (activityDate !== expectedDate) issues.push("activity_date_not_completed_previous_day");
  if (!activitySource) issues.push("activity_source_missing");
  else if (activitySource !== "apple_watch") issues.push("activity_source_not_apple_watch");

  const steps = boundedMetric(payload.steps, 0, 100_000, "steps_out_of_range", issues);
  const activeEnergy = boundedMetric(
    payload.active_energy_kcal ?? payload.active_energy,
    0,
    10_000,
    "active_energy_out_of_range",
    issues,
  );
  const exercise = boundedMetric(
    payload.exercise_minutes ?? payload.exercise,
    0,
    1_440,
    "exercise_minutes_out_of_range",
    issues,
  );

  if (steps === null) issues.push("steps_missing");
  if (activeEnergy === null) issues.push("active_energy_missing");
  if (exercise === null) issues.push("exercise_minutes_missing");

  const trustedEnvelope = schemaVersion !== null && schemaVersion >= 2 &&
    activityDate === expectedDate && activitySource === "apple_watch";
  const trustedMetrics = {
    steps: trustedEnvelope && steps !== null,
    active_energy_kcal: trustedEnvelope && activeEnergy !== null,
    exercise_minutes: trustedEnvelope && exercise !== null,
  };
  const hasAnyMetric = steps !== null || activeEnergy !== null || exercise !== null;
  const status: AppleActivityStatus = trustedMetrics.steps && trustedMetrics.active_energy_kcal
    ? "trusted"
    : hasAnyMetric ? "untrusted" : "missing";

  return {
    status,
    expected_date: expectedDate,
    activity_date: activityDate,
    activity_source: activitySource,
    schema_version: schemaVersion,
    metrics: {
      steps: rounded(steps),
      active_energy_kcal: rounded(activeEnergy),
      exercise_minutes: rounded(exercise),
    },
    trusted_metrics: trustedMetrics,
    issues: [...new Set(issues)],
  };
}

export function annotateSparseAppleHealthPayload(
  payload: Record<string, unknown>,
  expectedDate: string,
): Record<string, unknown> {
  const signalFieldCount = Object.entries(payload).filter(([key, value]) =>
    !APPLE_ENVELOPE_KEYS.has(key) && value !== "" && value !== null && value !== undefined,
  ).length;
  const activity = inspectAppleActivityPayload(payload, expectedDate);

  if (signalFieldCount >= MIN_APPLE_SIGNAL_FIELDS || activity.status === "trusted") {
    return payload;
  }

  return {
    ...payload,
    _warning: `Apple Health payload arrived with only ${signalFieldCount} populated signal field(s); activity is ${activity.status}`,
  };
}

export function inspectOuraActivity(
  oura: Record<string, unknown>,
  expectedDate: string,
): OuraActivityInspection {
  const activity = Array.isArray(oura.activity)
    ? oura.activity as Array<Record<string, unknown>>
    : [];
  const record = activity.find(candidate => candidate.day === expectedDate);
  if (!record) {
    return {
      status: "missing",
      expected_date: expectedDate,
      wear_coverage: "unknown",
      non_wear_minutes: null,
      metrics: { steps: null, active_energy_kcal: null },
      issues: ["oura_activity_day_missing"],
    };
  }

  const issues: string[] = [];
  const steps = boundedMetric(record.steps, 0, 100_000, "oura_steps_out_of_range", issues);
  const activeEnergy = boundedMetric(
    record.active_calories,
    0,
    10_000,
    "oura_active_energy_out_of_range",
    issues,
  );
  const nonWearSeconds = boundedMetric(
    record.non_wear_time,
    0,
    86_400,
    "oura_non_wear_time_out_of_range",
    issues,
  );
  if (steps === null) issues.push("oura_steps_missing");
  if (activeEnergy === null) issues.push("oura_active_energy_missing");

  let wearCoverage: OuraWearCoverage = "unknown";
  if (nonWearSeconds !== null) {
    if (nonWearSeconds >= INSUFFICIENT_OURA_COVERAGE_SECONDS) {
      wearCoverage = "insufficient";
      issues.push("oura_activity_insufficient_wear_coverage");
    } else if (nonWearSeconds >= REDUCED_OURA_COVERAGE_SECONDS) {
      wearCoverage = "reduced";
      issues.push("oura_activity_reduced_wear_coverage");
    } else {
      wearCoverage = "sufficient";
    }
  }

  const metricsValid = steps !== null && activeEnergy !== null;

  return {
    status: !metricsValid
      ? "invalid"
      : wearCoverage === "insufficient" ? "low_coverage" : "trusted",
    expected_date: expectedDate,
    wear_coverage: wearCoverage,
    non_wear_minutes: rounded(nonWearSeconds === null ? null : nonWearSeconds / 60, 1),
    metrics: {
      steps: rounded(steps),
      active_energy_kcal: rounded(activeEnergy),
    },
    issues: [...new Set(issues)],
  };
}

function ratio(numerator: number | null, denominator: number | null): number | undefined {
  if (numerator === null || denominator === null || denominator <= 0) return undefined;
  return Math.round((numerator / denominator) * 100) / 100;
}

export function resolveDailyActivity(
  applePayload: Record<string, unknown>,
  oura: Record<string, unknown>,
  expectedDate: string,
): ResolvedDailyActivity {
  const apple = inspectAppleActivityPayload(applePayload, expectedDate);
  const ouraActivity = inspectOuraActivity(oura, expectedDate);

  const steps = apple.trusted_metrics.steps
    ? apple.metrics.steps
    : ouraActivity.status === "trusted" ? ouraActivity.metrics.steps : null;
  const activeEnergy = apple.trusted_metrics.active_energy_kcal
    ? apple.metrics.active_energy_kcal
    : ouraActivity.status === "trusted" ? ouraActivity.metrics.active_energy_kcal : null;
  const exercise = apple.trusted_metrics.exercise_minutes ? apple.metrics.exercise_minutes : null;

  const provenance = {
    steps: apple.trusted_metrics.steps
      ? "apple_watch" as const
      : steps !== null ? "oura_api" as const : "missing" as const,
    active_energy_kcal: apple.trusted_metrics.active_energy_kcal
      ? "apple_watch" as const
      : activeEnergy !== null ? "oura_api" as const : "missing" as const,
    exercise_minutes: apple.trusted_metrics.exercise_minutes
      ? "apple_watch" as const
      : "missing" as const,
  };

  const comparisons: ResolvedDailyActivity["comparisons"] = {};
  // A legacy payload has no period metadata, so comparing its current/partial
  // value with a completed Oura day would manufacture a meaningless ratio.
  const comparablePeriod = apple.activity_date === expectedDate &&
    ouraActivity.status === "trusted" && ouraActivity.wear_coverage !== "reduced";
  const stepsRatio = comparablePeriod
    ? ratio(apple.metrics.steps, ouraActivity.metrics.steps)
    : undefined;
  const energyRatio = comparablePeriod
    ? ratio(apple.metrics.active_energy_kcal, ouraActivity.metrics.active_energy_kcal)
    : undefined;
  if (stepsRatio !== undefined) comparisons.steps_apple_to_oura_ratio = stepsRatio;
  if (energyRatio !== undefined) comparisons.active_energy_apple_to_oura_ratio = energyRatio;

  const warnings = [...apple.issues, ...ouraActivity.issues];
  if (stepsRatio !== undefined && (stepsRatio < 0.5 || stepsRatio > 2)) {
    warnings.push("steps_sources_diverge");
  }
  if (energyRatio !== undefined && (energyRatio < 0.5 || energyRatio > 2)) {
    warnings.push("active_energy_sources_diverge");
  }
  if (exercise === null) warnings.push("exercise_minutes_unavailable_from_trusted_source");

  let quality: ResolvedActivityQuality;
  if (steps === null && activeEnergy === null) quality = "missing";
  else if (steps === null || activeEnergy === null) quality = "partial";
  else if (provenance.steps === "apple_watch" && provenance.active_energy_kcal === "apple_watch") quality = "ok";
  else quality = "fallback";

  return {
    period_date: expectedDate,
    period_semantics: "completed_calendar_day",
    quality,
    steps,
    active_energy_kcal: activeEnergy,
    exercise_minutes: exercise,
    provenance,
    apple_health: {
      status: apple.status,
      activity_date: apple.activity_date,
      activity_source: apple.activity_source,
      issues: apple.issues,
    },
    oura: {
      status: ouraActivity.status,
      wear_coverage: ouraActivity.wear_coverage,
      non_wear_minutes: ouraActivity.non_wear_minutes,
      issues: ouraActivity.issues,
    },
    comparisons,
    warnings: [...new Set(warnings)],
  };
}
