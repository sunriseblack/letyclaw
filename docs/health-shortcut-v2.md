# Health Data Sync v2 contract

Apple Health ingestion is optional enrichment. Completed-day steps and active
energy may fall back to another configured source when a Shortcut delivery is
missing, partial, duplicated, or does not identify its measurement period and
source.

## Source policy

- A wearable source is preferred only for metrics from a schema-v2 payload
  whose `activity_date` is the previous completed calendar day in the supplied
  IANA timezone and whose `activity_source` identifies that wearable.
- A secondary source may provide steps and active energy only when its daily
  record has sufficient coverage.
- Values from multiple sources are never added together.
- Metrics without a trusted fallback are omitted instead of inferred.
- Raw values remain in `apple_health` for diagnostics. Briefings use the
  normalized top-level `activity` object.

## Request

```text
POST https://bot.example.com/health/apple
Authorization: Bearer <HEALTH_WEBHOOK_SECRET>
Content-Type: application/json
```

Recommended JSON body:

```json
{
  "schema_version": 2,
  "timezone": "Etc/UTC",
  "captured_at": "2026-01-02T08:30:00Z",
  "activity_date": "2026-01-01",
  "activity_source": "apple_watch",
  "steps": 10215,
  "active_energy_kcal": 620,
  "exercise_minutes": 46,
  "heart_rate_avg": 67.2,
  "resting_hr": 65,
  "hrv": 86.6,
  "glucose_avg": null,
  "glucose_unit": "mg/dL",
  "glucose_sample_count": 0,
  "workouts": []
}
```

Use the deployment's real public HTTPS origin and local IANA timezone. Never
put the bearer token in the URL.

The response includes `activity_quality`, machine-readable `activity_issues`,
and a user-facing `message`. A legacy or sparse payload can return `200`
because transport and raw diagnostic storage succeeded while top-level status
is `degraded`; degraded activity values do not override a trusted fallback.
Exact duplicates return `duplicate: true` and do not rewrite daily files or
briefing triggers.

The consolidated daily record keeps transport and metric quality separate:
`sources.apple_health: missing` means no readable payload arrived, while
`degraded` means a payload arrived but failed activity validation.

## HealthKit and Shortcut configuration

1. Decide which device is canonical for each metric. Disable other apps from
   writing duplicate Steps or Active Energy when necessary.
2. In Health, put the current wearable first under Data Sources & Access.
3. In the Shortcut, bind source filters using HealthKit's live picker. Recreate
   a filter after replacing or renaming a wearable; editing its visible label
   does not necessarily rebind the underlying source.
4. Bind every completed-day query to the dynamic “yesterday” value. Changing
   only the JSON `activity_date` leaves the Health query itself unchanged.
5. Use calendar-day bounds in the payload timezone, not a rolling 24-hour
   interval.
6. Run after the first device unlock so protected HealthKit data is available.
7. Validate one real phone delivery against Health's source-level values before
   trusting the automation.

## Operations

Backfill normalized activity into existing daily files:

```bash
node dist/scripts/backfill-health-activity.js          # dry run
node dist/scripts/backfill-health-activity.js --apply  # atomic writes
```

The bot and webhook run under different users but both replace consolidated
daily JSON. Shared atomic writes enforce mode `0660`; the process umask must
not remove group write access.
