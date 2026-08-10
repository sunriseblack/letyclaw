import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { vi } from "vitest";

// ticktick.ts captures TICKTICK_CLIENT_ID/SECRET and TICKTICK_TOKEN_FILE at
// module load, so they must be set BEFORE the module is first imported (the
// import is dynamic, inside beforeEach, which runs after this top-level code).
process.env.TICKTICK_CLIENT_ID = "cid";
process.env.TICKTICK_CLIENT_SECRET = "sec";
const TOKEN_PATH = join(tmpdir(), "letyclaw-tt-token-test.json");
process.env.TICKTICK_TOKEN_FILE = TOKEN_PATH;

let tt: typeof import("../tools/letyclaw-mcp/tools/ticktick.js");

beforeEach(async () => {
  tt = await import("../tools/letyclaw-mcp/tools/ticktick.js");
});

afterEach(() => {
  for (const p of [TOKEN_PATH, `${TOKEN_PATH}.bak`]) rmSync(p, { force: true });
});

function writeToken(expiresInSec: number, refresh = "refresh-abc"): void {
  writeFileSync(TOKEN_PATH, JSON.stringify({
    access_token: "acc-1",
    refresh_token: refresh,
    expires_at: Math.floor(Date.now() / 1000) + expiresInSec,
    scope: "tasks",
  }));
}

function resp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

describe("ticktick api() bounded retry", () => {
  it("retries a transient 503 then succeeds (GET)", async () => {
    writeToken(3600);
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      n++;
      return n === 1 ? resp(503, { error: "busy" }) : resp(200, { id: "t1", projectId: "p1", title: "x", status: 0 });
    }) as unknown as typeof fetch);

    const t = await tt.ttGetTask("p1", "t1");
    expect(t.id).toBe("t1");
    expect(n).toBe(2);
  });

  it("gives up (throws) after repeated 503s", async () => {
    writeToken(3600);
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => resp(503, { error: "busy" })) as unknown as typeof fetch);
    await expect(tt.ttGetTask("p1", "t1")).rejects.toThrow(/503/);
  });

  it("does NOT retry a 4xx (auth/bad request)", async () => {
    writeToken(3600);
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => { n++; return resp(400, { error: "bad" }); }) as unknown as typeof fetch);
    await expect(tt.ttGetTask("p1", "t1")).rejects.toThrow(/400/);
    expect(n).toBe(1);
  });
});

describe("ticktick single-flight token refresh", () => {
  it("refreshes the expired token only once under concurrent calls", async () => {
    writeToken(-10); // already expired → forces a refresh
    let tokenRefreshes = 0;
    let taskGets = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string) => {
      if (String(url).includes("oauth/token")) {
        tokenRefreshes++;
        return resp(200, { access_token: "acc-2", refresh_token: "refresh-2", expires_in: 3600, scope: "tasks" });
      }
      taskGets++;
      return resp(200, { id: "t1", projectId: "p1", title: "x", status: 0 });
    }) as unknown as typeof fetch);

    await Promise.all([tt.ttGetTask("p1", "t1"), tt.ttGetTask("p1", "t1")]);
    expect(tokenRefreshes).toBe(1); // not 2 — concurrent callers share one refresh
    expect(taskGets).toBe(2);
  });
});
