import { createHash } from "crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => key !== "_ingest")
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** Stable, non-reversible identity for duplicate Apple Health deliveries. */
export function applePayloadFingerprint(payload: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

export function appleIngestMessage(status: "trusted" | "untrusted" | "missing", duplicate: boolean): string {
  if (duplicate) return "Duplicate Apple Health payload ignored; previously stored data is unchanged.";
  if (status === "trusted") return "Apple Watch completed-day activity accepted.";
  return "Apple activity rejected as untrusted; repair Health Data Sync v2. Oura fallback remains active.";
}
