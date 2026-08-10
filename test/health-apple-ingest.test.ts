import { describe, expect, it } from "vitest";
import {
  appleIngestMessage,
  applePayloadFingerprint,
} from "../services/health-apple-ingest.js";

describe("Apple Health webhook ingestion", () => {
  it("fingerprints semantically identical payloads regardless of key order", () => {
    const first = applePayloadFingerprint({
      timezone: "UTC",
      steps: 12_345,
      workouts: [{ type: "Tennis", minutes: 60 }],
    });
    const second = applePayloadFingerprint({
      workouts: [{ minutes: 60, type: "Tennis" }],
      steps: 12_345,
      timezone: "UTC",
      _ingest: { received_at: "later" },
    });

    expect(second).toBe(first);
  });

  it("does not collapse a changed activity payload as a duplicate", () => {
    expect(applePayloadFingerprint({ steps: 12_345 }))
      .not.toBe(applePayloadFingerprint({ steps: 12_346 }));
  });

  it("makes degraded and duplicate outcomes explicit to the Shortcut", () => {
    expect(appleIngestMessage("untrusted", false)).toContain("rejected as untrusted");
    expect(appleIngestMessage("trusted", false)).toContain("accepted");
    expect(appleIngestMessage("untrusted", true)).toContain("Duplicate");
  });
});
