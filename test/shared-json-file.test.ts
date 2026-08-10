import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteSharedJson } from "../services/shared-json-file.js";

describe("atomicWriteSharedJson", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("publishes mode 0660 even under a restrictive process umask", () => {
    const root = mkdtempSync(join(tmpdir(), "letyclaw-shared-json-"));
    roots.push(root);
    const file = join(root, "daily.json");
    const priorUmask = process.umask(0o027);

    try {
      atomicWriteSharedJson(file, { status: "ok" });
    } finally {
      process.umask(priorUmask);
    }

    expect(statSync(file).mode & 0o777).toBe(0o660);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ status: "ok" });
  });
});
