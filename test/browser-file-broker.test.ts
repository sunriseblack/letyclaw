import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, join, relative } from "path";
import { describe, expect, it } from "vitest";
import {
  brokerBrowserArguments,
  purgeStagedBrowserUploads,
  validateBrowserArtifactFilename,
} from "../services/browser-file-broker.js";

describe("browser file broker", () => {
  it("copies a regular shared upload into private staging and cleans it up", async () => {
    const root = mkdtempSync(join(tmpdir(), "letyclaw-browser-broker-"));
    const shared = join(root, "shared");
    const stage = join(root, "stage");
    mkdirSync(shared);
    mkdirSync(stage);
    writeFileSync(join(shared, "ticket.pdf"), "safe payload");
    try {
      const brokered = await brokerBrowserArguments("browser_file_upload", {
        paths: ["browser-uploads/ticket.pdf"],
      }, {
        sharedUploadDir: shared,
        privateStageDir: stage,
        exposedStageDir: "/root/vault/.browser-staged-uploads",
      });
      const exposedRoot = "/root/vault/.browser-staged-uploads";
      const exposed = (brokered.args.paths as string[])[0]!;
      const privatePath = join(stage, relative(exposedRoot, exposed));
      expect(exposed).toMatch(/^\/root\/vault\/\.browser-staged-uploads\/[0-9a-f-]+\/ticket\.pdf$/);
      expect(basename(exposed)).toBe("ticket.pdf");
      expect(readFileSync(privatePath, "utf8")).toBe("safe payload");
      brokered.cleanup();
      expect(existsSync(privatePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("retains a staged file long enough for a later form submit, then removes it", async () => {
    const root = mkdtempSync(join(tmpdir(), "letyclaw-browser-broker-"));
    const shared = join(root, "shared");
    const stage = join(root, "stage");
    mkdirSync(shared);
    mkdirSync(stage);
    writeFileSync(join(shared, "attachment.txt"), "deferred browser upload");
    try {
      const brokered = await brokerBrowserArguments("browser_file_upload", {
        paths: ["browser-uploads/attachment.txt"],
      }, {
        sharedUploadDir: shared,
        privateStageDir: stage,
        exposedStageDir: "/root/vault/.browser-staged-uploads",
      });
      const exposedRoot = "/root/vault/.browser-staged-uploads";
      const privatePath = join(stage, relative(exposedRoot, (brokered.args.paths as string[])[0]!));
      brokered.cleanup(25);
      expect(existsSync(privatePath)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(existsSync(privatePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds retained upload staging across calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "letyclaw-browser-broker-"));
    const shared = join(root, "shared");
    const stage = join(root, "stage");
    mkdirSync(shared);
    mkdirSync(stage);
    writeFileSync(join(shared, "next.txt"), "12345678");
    writeFileSync(join(stage, "retained.txt"), "12345678");
    try {
      await expect(brokerBrowserArguments("browser_file_upload", {
        paths: ["browser-uploads/next.txt"],
      }, {
        sharedUploadDir: shared,
        privateStageDir: stage,
        exposedStageDir: "/root/vault/.browser-staged-uploads",
        maxTotalBytes: 10,
      })).rejects.toThrow(/configured byte limit|at capacity/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("purges retained per-file directories after a gateway restart", () => {
    const root = mkdtempSync(join(tmpdir(), "letyclaw-browser-broker-"));
    const stage = join(root, "stage");
    const privateDirectory = join(stage, "550e8400-e29b-41d4-a716-446655440000");
    mkdirSync(stage);
    mkdirSync(privateDirectory);
    const retained = join(privateDirectory, "original-name.pdf");
    writeFileSync(retained, "old upload");
    utimesSync(retained, new Date(0), new Date(0));
    try {
      expect(purgeStagedBrowserUploads(stage, 0)).toBe(1);
      expect(existsSync(privateDirectory)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses symlink uploads and output paths outside the artifact exchange", async () => {
    const root = mkdtempSync(join(tmpdir(), "letyclaw-browser-broker-"));
    const shared = join(root, "shared");
    const stage = join(root, "stage");
    mkdirSync(shared);
    mkdirSync(stage);
    writeFileSync(join(root, "secret.env"), "do-not-read");
    symlinkSync(join(root, "secret.env"), join(shared, "attack.txt"));
    try {
      await expect(brokerBrowserArguments("browser_file_upload", {
        paths: ["browser-uploads/attack.txt"],
      }, {
        sharedUploadDir: shared,
        privateStageDir: stage,
        exposedStageDir: "/root/vault/.browser-staged-uploads",
      })).rejects.toThrow();
      expect(() => validateBrowserArtifactFilename("screenshot.png")).toThrow(/browser-artifacts/);
      expect(() => validateBrowserArtifactFilename("browser-artifacts/../secret.env")).toThrow();
      expect(() => validateBrowserArtifactFilename("browser-artifacts/screenshot.png")).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
