import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  openLoop, updateLoop, closeLoop, getLoop, listLoops, touchLoops,
  countActiveLoops, deriveDedupeKey, renderLoopsBlock,
} from "../tools/letyclaw-mcp/tools/loops-db.js";
import { closeAll } from "../tools/letyclaw-mcp/tools/memory-db.js";
import type { MCPToolModule } from "../tools/letyclaw-mcp/types.js";

let tmpDir: string;
let vaultPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "letyclaw-loops-test-"));
  vaultPath = join(tmpDir, "vault");
  for (const agentId of ["personal", "health"]) {
    mkdirSync(join(vaultPath, agentId), { recursive: true });
  }
  process.env.LETYCLAW_VAULT_PATH = vaultPath;
  process.env.LETYCLAW_AGENT_ID = "personal";
});

afterEach(() => {
  closeAll(); // release cached SQLite connections before removing the tmp vault
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.LETYCLAW_VAULT_PATH;
  delete process.env.LETYCLAW_AGENT_ID;
  delete process.env.LETYCLAW_CRON_CONFIG;
});

describe("loops-db", () => {
  it("self-migrates the loops table on first use", () => {
    const { id, reused } = openLoop("personal", { title: "First loop" });
    expect(id).toMatch(/^loop-[0-9a-f]{8}$/);
    expect(reused).toBe(false);
    expect(getLoop("personal", id)?.title).toBe("First loop");
  });

  it("dedupes a second open of the same item instead of creating a duplicate", () => {
    const a = openLoop("personal", { title: "Renew padrón", source_ref: "email-26883" });
    const b = openLoop("personal", { title: "Padrón renewal (rephrased)", source_ref: "email-26883", next_action: "file it" });
    expect(b.reused).toBe(true);
    expect(b.id).toBe(a.id);
    expect(listLoops("personal", { status: "open" })).toHaveLength(1);
    // the reopen refreshed the actionable fields
    expect(getLoop("personal", a.id)?.next_action).toBe("file it");
  });

  it("derives a stable dedupe_key from source_ref over title", () => {
    expect(deriveDedupeKey("personal", "email-99", "Anything")).toBe("personal:email-99");
    expect(deriveDedupeKey("personal", undefined, "Renew the Padrón!")).toBe("personal:renew-the-padr-n");
  });

  it("allows reopening a NEW loop after the old one is closed (partial unique index)", () => {
    const a = openLoop("personal", { title: "Recurring thing", source_ref: "x" });
    closeLoop("personal", a.id);
    const b = openLoop("personal", { title: "Recurring thing again", source_ref: "x" });
    expect(b.reused).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(listLoops("personal", { status: "open" })).toHaveLength(1); // only the new active one
    expect(listLoops("personal", { status: "all" })).toHaveLength(2); // closed + active
  });

  it("orders by priority desc then due asc (nulls last)", () => {
    openLoop("personal", { title: "low no-due", priority: 1 });
    openLoop("personal", { title: "high later", priority: 5, due: "2026-07-01" });
    openLoop("personal", { title: "high sooner", priority: 5, due: "2026-06-05" });
    const titles = listLoops("personal", { status: "open" }).map((r) => r.title);
    expect(titles).toEqual(["high sooner", "high later", "low no-due"]);
  });

  it("filters by status; closed loops drop out of the default 'open' list", () => {
    const a = openLoop("personal", { title: "to close" });
    openLoop("personal", { title: "stays open" });
    closeLoop("personal", a.id);
    expect(listLoops("personal", { status: "open" }).map((r) => r.title)).toEqual(["stays open"]);
    expect(listLoops("personal", { status: "all" })).toHaveLength(2);
    expect(countActiveLoops("personal")).toBe(1);
  });

  it("updateLoop advances status and sets closed_at on done", () => {
    const a = openLoop("personal", { title: "advance me" });
    expect(updateLoop("personal", a.id, { status: "in_progress", next_action: "step 2" })?.status).toBe("in_progress");
    const done = updateLoop("personal", a.id, { status: "done" });
    expect(done?.status).toBe("done");
    expect(done?.closed_at).toBeGreaterThan(0);
  });

  it("touchLoops increments surfaced_count and sets last_surfaced_at", () => {
    const a = openLoop("personal", { title: "surface me" });
    expect(getLoop("personal", a.id)?.surfaced_count).toBe(0);
    touchLoops("personal", [a.id]);
    touchLoops("personal", [a.id]);
    const row = getLoop("personal", a.id)!;
    expect(row.surfaced_count).toBe(2);
    expect(row.last_surfaced_at).toBeGreaterThan(0);
  });
});

describe("renderLoopsBlock", () => {
  it("returns empty string when there are no open loops", () => {
    expect(renderLoopsBlock("personal")).toBe("");
  });

  it("renders open loops, caps at 5, and shows a '+K more' tail", () => {
    for (let i = 0; i < 7; i++) openLoop("personal", { title: `Loop ${i}`, priority: i });
    const block = renderLoopsBlock("personal");
    const bullets = block.split("\n").filter((l) => l.startsWith("• "));
    expect(bullets).toHaveLength(5);
    expect(block).toContain("OPEN LOOPS");
    expect(block).toContain("+2 more");
    // highest priority first
    expect(bullets[0]).toContain("Loop 6");
  });

  it("never leaks another domain's loops into the per-turn block", () => {
    openLoop("health", { title: "Health-only loop", shared: 1 }); // even shared
    openLoop("personal", { title: "Personal loop" });
    const block = renderLoopsBlock("personal");
    expect(block).toContain("Personal loop");
    expect(block).not.toContain("Health-only loop");
  });
});

describe("cross-domain shared loops", () => {
  it("'+shared' surfaces other domains' shared loops but not their private ones", () => {
    openLoop("health", { title: "Shared health item", shared: 1 });
    openLoop("health", { title: "Private health item", shared: 0 });
    openLoop("personal", { title: "Own personal item" });

    const own = listLoops("personal", { status: "open" }).map((r) => r.title);
    expect(own).toEqual(["Own personal item"]);

    const shared = listLoops("personal", { status: "open", domain: "+shared" }).map((r) => r.title).sort();
    expect(shared).toContain("Own personal item");
    expect(shared).toContain("Shared health item");
    expect(shared).not.toContain("Private health item");
  });
});

describe("loop MCP tools", () => {
  let handlers: MCPToolModule["handlers"];

  beforeEach(async () => {
    const mod = await import("../tools/letyclaw-mcp/tools/loops.js") as MCPToolModule;
    handlers = mod.handlers;
  });

  it("loop_open errors without agent context", async () => {
    delete process.env.LETYCLAW_AGENT_ID;
    const r = await handlers.loop_open!({ title: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("agent context");
  });

  it("loop_open requires a title", async () => {
    const r = await handlers.loop_open!({});
    expect(r.isError).toBe(true);
  });

  it("loop_open then loop_list (mark_surfaced) reports and tracks surfacing", async () => {
    const opened = JSON.parse((await handlers.loop_open!({ title: "Briefing item", source_ref: "m1", mirror_ticktick: false })).content[0]!.text) as { id: string };
    const listed = JSON.parse((await handlers.loop_list!({ mark_surfaced: true })).content[0]!.text) as Array<{ id: string; surfaced_count: number }>;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(opened.id);
    expect(getLoop("personal", opened.id)?.surfaced_count).toBe(1);
  });

  it("loop_close stops a loop from appearing in the open list", async () => {
    const opened = JSON.parse((await handlers.loop_open!({ title: "Close me", mirror_ticktick: false })).content[0]!.text) as { id: string };
    const closed = JSON.parse((await handlers.loop_close!({ id: opened.id, resolution: "done it" })).content[0]!.text) as { status: string; summary: string };
    expect(closed.status).toBe("done");
    expect(closed.summary).toContain("done it");
    const listed = JSON.parse((await handlers.loop_list!({})).content[0]!.text) as unknown[];
    expect(listed).toHaveLength(0);
  });

  it("loop_close errors for an unknown id", async () => {
    const r = await handlers.loop_close!({ id: "loop-deadbeef" });
    expect(r.isError).toBe(true);
  });

  it("loop_close deletes the bound watch cron (Honda-PCX fix)", async () => {
    process.env.LETYCLAW_CRON_CONFIG = join(tmpDir, "cron.yaml");
    const cron = await import("../tools/letyclaw-mcp/tools/cron.js") as MCPToolModule;
    await cron.handlers.cron_create!({
      id: "watch-x",
      schedule: "*/20 * * * *",
      prompt: "poll the inbox",
      topic_id: "5",
      delivery: "signal",
      expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });

    const opened = JSON.parse(
      (await handlers.loop_open!({ title: "watched thing", mirror_ticktick: false, watch_cron_id: "watch-x" })).content[0]!.text,
    ) as { id: string };
    await handlers.loop_close!({ id: opened.id, resolution: "resolved" });

    const list = await cron.handlers.cron_list!({});
    expect(list.content[0]!.text).not.toContain("watch-x");
  });
});
