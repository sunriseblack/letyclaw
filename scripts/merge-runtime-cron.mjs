#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "js-yaml";

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function jobsOf(doc, label) {
  const jobs = doc?.cron?.jobs;
  if (!Array.isArray(jobs)) throw new Error(`${label} has no cron.jobs array`);
  for (const job of jobs) {
    if (!job || typeof job !== "object" || typeof job.id !== "string" || !job.id) {
      throw new Error(`${label} contains a job without a string id`);
    }
  }
  return jobs;
}

/** Three-way merge: repo changes form the new baseline, non-conflicting live
 * edits survive, and runtime-only jobs are appended. On a same-field conflict
 * the reviewed repo value wins and the conflict is reported. */
export function mergeCronDocuments(oldBaseline, runtime, newBaseline, options = {}) {
  const runtimeWinsConflicts = options.conflictPolicy === "runtime";
  const oldJobs = jobsOf(oldBaseline, "old baseline");
  const runtimeJobs = jobsOf(runtime, "runtime config");
  const newJobs = jobsOf(newBaseline, "new baseline");
  const oldMap = new Map(oldJobs.map(j => [j.id, j]));
  const runtimeMap = new Map(runtimeJobs.map(j => [j.id, j]));
  const newMap = new Map(newJobs.map(j => [j.id, structuredClone(j)]));
  const removed = new Set();
  const preserved = [];
  const conflicts = [];

  for (const [id, oldJob] of oldMap) {
    const liveJob = runtimeMap.get(id);
    const repoJob = newMap.get(id);

    if (!liveJob) {
      // A live deletion survives only when the repo did not also change it.
      if (repoJob && equal(repoJob, oldJob)) {
        removed.add(id);
        preserved.push(`${id}:deleted`);
      } else if (repoJob) {
        conflicts.push(`${id}:delete`);
        if (runtimeWinsConflicts) {
          removed.add(id);
          preserved.push(`${id}:deleted-live-conflict`);
        }
      }
      continue;
    }
    if (!repoJob) {
      // Repo deletion wins for an untouched live copy. Preserve a job that was
      // independently edited live so an autonomous/user-created change is not
      // silently erased.
      if (!equal(liveJob, oldJob)) {
        newMap.set(id, structuredClone(liveJob));
        preserved.push(`${id}:modified-live-job`);
      }
      continue;
    }

    const keys = new Set([...Object.keys(oldJob), ...Object.keys(liveJob), ...Object.keys(repoJob)]);
    for (const key of keys) {
      if (key === "id") continue;
      const oldHas = has(oldJob, key);
      const liveHas = has(liveJob, key);
      const repoHas = has(repoJob, key);
      const oldValue = oldJob[key];
      const liveValue = liveJob[key];
      const repoValue = repoJob[key];
      const liveChanged = liveHas !== oldHas || !equal(liveValue, oldValue);
      const repoChanged = repoHas !== oldHas || !equal(repoValue, oldValue);
      if (!liveChanged) continue;
      if (repoChanged && (liveHas !== repoHas || !equal(liveValue, repoValue))) {
        conflicts.push(`${id}.${key}`);
        if (!runtimeWinsConflicts) continue;
      }
      if (liveHas) repoJob[key] = structuredClone(liveValue);
      else delete repoJob[key];
      preserved.push(`${id}.${key}`);
    }
  }

  // Jobs absent from the old baseline are live-only and must survive.
  for (const liveJob of runtimeJobs) {
    if (!oldMap.has(liveJob.id) && !newMap.has(liveJob.id)) {
      newMap.set(liveJob.id, structuredClone(liveJob));
      preserved.push(`${liveJob.id}:runtime-only`);
    }
  }

  const ordered = [];
  for (const job of newJobs) {
    if (!removed.has(job.id)) ordered.push(newMap.get(job.id));
  }
  for (const [id, job] of newMap) {
    if (!newJobs.some(candidate => candidate.id === id) && !removed.has(id)) ordered.push(job);
  }
  const merged = structuredClone(newBaseline);
  merged.cron.jobs = ordered;
  return { merged, preserved, conflicts };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const runtimeWinsConflicts = args[0] === "--runtime-wins";
  if (runtimeWinsConflicts) args.shift();
  const [oldPath, runtimePath, newPath, outputPath] = args;
  if (!oldPath || !runtimePath || !newPath || !outputPath) {
    console.error("usage: merge-runtime-cron.mjs OLD_BASELINE RUNTIME NEW_BASELINE OUTPUT");
    process.exit(2);
  }
  const load = path => YAML.load(readFileSync(path, "utf8"));
  const result = mergeCronDocuments(
    load(oldPath),
    load(runtimePath),
    load(newPath),
    { conflictPolicy: runtimeWinsConflicts ? "runtime" : "repo" },
  );
  const tmp = `${dirname(outputPath)}/.${process.pid}.cron-merge.tmp`;
  writeFileSync(tmp, YAML.dump(result.merged, { lineWidth: -1, noRefs: true }), { mode: 0o660 });
  renameSync(tmp, outputPath);
  console.log(`[cron-merge] preserved ${result.preserved.length}: ${result.preserved.join(", ") || "none"}`);
  if (result.conflicts.length) {
    const winner = runtimeWinsConflicts ? "runtime" : "repo";
    console.log(`[cron-merge] ${winner} won ${result.conflicts.length} conflict(s): ${result.conflicts.join(", ")}`);
  }
}
