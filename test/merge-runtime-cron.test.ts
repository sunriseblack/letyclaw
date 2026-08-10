import { describe, expect, it } from "vitest";
import { mergeCronDocuments } from "../scripts/merge-runtime-cron.mjs";

describe("runtime cron three-way merge", () => {
  it("keeps repo changes, runtime-only jobs, and non-conflicting live edits", () => {
    const oldBaseline = { cron: { timezone: "UTC", jobs: [
      { id: "brief", schedule: "0 9 * * *", prompt: "old", enabled: true },
    ] } };
    const runtime = { cron: { timezone: "UTC", jobs: [
      { id: "brief", schedule: "0 9 * * *", prompt: "old", enabled: false },
      { id: "health-weight-daily-log", schedule: "0 21 * * *", prompt: "live" },
    ] } };
    const newBaseline = { cron: { timezone: "UTC", jobs: [
      { id: "brief", schedule: "0 9 * * *", prompt: "reviewed", enabled: true },
    ] } };

    const { merged, conflicts } = mergeCronDocuments(oldBaseline, runtime, newBaseline);
    expect(merged.cron.jobs).toEqual([
      { id: "brief", schedule: "0 9 * * *", prompt: "reviewed", enabled: false },
      { id: "health-weight-daily-log", schedule: "0 21 * * *", prompt: "live" },
    ]);
    expect(conflicts).toEqual([]);
  });

  it("lets the reviewed repo value win a same-field conflict", () => {
    const oldBaseline = { cron: { jobs: [{ id: "brief", prompt: "old" }] } };
    const runtime = { cron: { jobs: [{ id: "brief", prompt: "live edit" }] } };
    const newBaseline = { cron: { jobs: [{ id: "brief", prompt: "repo fix" }] } };
    const { merged, conflicts } = mergeCronDocuments(oldBaseline, runtime, newBaseline);
    expect(merged.cron.jobs[0]!.prompt).toBe("repo fix");
    expect(conflicts).toEqual(["brief.prompt"]);
  });

  it("lets stopped live state win conflicts during a reverse rollback merge", () => {
    const candidateBaseline = { cron: { jobs: [
      { id: "brief", prompt: "candidate", enabled: true },
      { id: "remove-me", prompt: "candidate" },
    ] } };
    const stoppedRuntime = { cron: { jobs: [
      { id: "brief", prompt: "live edit", enabled: true },
      { id: "runtime-only", prompt: "created while candidate ran", enabled: true },
    ] } };
    const previousBaseline = { cron: { jobs: [
      { id: "brief", prompt: "previous", enabled: true },
      { id: "remove-me", prompt: "previous" },
    ] } };

    const { merged, conflicts } = mergeCronDocuments(
      candidateBaseline,
      stoppedRuntime,
      previousBaseline,
      { conflictPolicy: "runtime" },
    );
    expect(merged.cron.jobs).toEqual([
      { id: "brief", prompt: "live edit", enabled: true },
      { id: "runtime-only", prompt: "created while candidate ran", enabled: true },
    ]);
    expect(conflicts).toEqual(["brief.prompt", "remove-me:delete"]);
  });

  it("does not reintroduce a runNow flag consumed by the candidate", () => {
    const installedCandidate = { cron: { jobs: [
      { id: "once", prompt: "run", enabled: false, runNow: true },
    ] } };
    const stoppedRuntime = { cron: { jobs: [
      { id: "once", prompt: "run", enabled: false },
    ] } };
    const originalRuntime = { cron: { jobs: [
      { id: "once", prompt: "run", enabled: false, runNow: true },
    ] } };

    const { merged } = mergeCronDocuments(
      installedCandidate,
      stoppedRuntime,
      originalRuntime,
      { conflictPolicy: "runtime" },
    );
    expect(merged.cron.jobs[0]).not.toHaveProperty("runNow");
  });

  it("preserves a predeploy live override that conflicted with candidate baseline", () => {
    const installedCandidate = { cron: { jobs: [
      { id: "brief", schedule: "0 10 * * *", enabled: true },
      { id: "paused", schedule: "0 8 * * *", enabled: false },
    ] } };
    const stoppedRuntime = structuredClone(installedCandidate);
    const originalRuntime = { cron: { jobs: [
      { id: "brief", schedule: "0 7 * * *", enabled: true },
      { id: "paused", schedule: "0 8 * * *", enabled: false },
    ] } };

    const { merged } = mergeCronDocuments(
      installedCandidate,
      stoppedRuntime,
      originalRuntime,
      { conflictPolicy: "runtime" },
    );
    expect(merged).toEqual(originalRuntime);
  });
});
