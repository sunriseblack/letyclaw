import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readVapiInboundContext,
  writeVapiInboundContext,
} from "../services/vapi-inbound-context.js";

describe("Vapi inbound callback context", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "letyclaw-vapi-context-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("correlates equivalent phone formats without exposing the number in the filename", () => {
    writeVapiInboundContext({
      localId: "local-outbound-1",
      providerCallId: "provider-outbound-1",
      phoneNumber: "+1 (202) 555-0123",
      callerName: "Alex",
      task: "Ask JetBlue about the delayed bag.",
      language: "en-US",
      createdAt: 1_000,
      ttlMs: 60_000,
    }, root);

    const context = readVapiInboundContext("+12025550123", 30_000, root);
    expect(context).toMatchObject({
      localId: "local-outbound-1",
      providerCallId: "provider-outbound-1",
      task: "Ask JetBlue about the delayed bag.",
      expiresAt: 61_000,
    });
    const files = readdirSync(root).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("12025550123");
    expect(statSync(join(root, files[0]!)).mode & 0o777).toBe(0o660);
    expect(readFileSync(join(root, files[0]!), "utf8")).toContain("local-outbound-1");
  });

  it("ignores expired, invalid, and mismatched contexts", () => {
    writeVapiInboundContext({
      localId: "local-outbound-2",
      providerCallId: "provider-outbound-2",
      phoneNumber: "+34612345678",
      callerName: "Alex",
      task: "Confirm the reservation.",
      language: "es",
      createdAt: 1_000,
      ttlMs: 60_000,
    }, root);
    expect(readVapiInboundContext("+34612345678", 61_001, root)).toBeNull();
    expect(readVapiInboundContext("invalid", 2_000, root)).toBeNull();
    expect(readVapiInboundContext("+34600000000", 2_000, root)).toBeNull();
  });
});
