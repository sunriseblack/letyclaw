import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractSendTrailers, describeSendTarget, resolveGmailAttachments } from "../lib.js";

describe("extractSendTrailers", () => {
  it("returns clean text and no payloads when no trailer present", () => {
    const r = extractSendTrailers("Just a normal message.");
    expect(r.clean).toBe("Just a normal message.");
    expect(r.payloads).toEqual([]);
  });

  it("strips one gmail trailer with draft_id", () => {
    const input = `Here's the draft.

<!--SEND-START-->
{"kind":"gmail","account":"default","draft_id":"r-abc","label":"Send to Alice"}
<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.clean).toBe("Here's the draft.");
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({
      kind: "gmail",
      account: "default",
      draft_id: "r-abc",
      label: "Send to Alice",
    });
  });

  it("strips one gmail trailer with inline message fields", () => {
    const input = `Draft below.
<!--SEND-START-->
{"kind":"gmail","account":"work","to":["a@b.com"],"subject":"x","body":"y"}
<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.clean).toBe("Draft below.");
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({
      kind: "gmail",
      account: "work",
      to: ["a@b.com"],
      subject: "x",
      body: "y",
    });
  });

  it("supports multiple trailers in one message", () => {
    const input = `Three drafts:

A
<!--SEND-START-->{"kind":"gmail","account":"default","to":["a@x.com"],"subject":"s1","body":"b1"}<!--SEND-END-->

B
<!--SEND-START-->{"kind":"slack","instruction":"post in #x"}<!--SEND-END-->

C
<!--SEND-START-->{"kind":"agent","instruction":"add a TickTick task: 'foo'"}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads.map((p) => p.kind)).toEqual(["gmail", "slack", "agent"]);
    expect(r.clean).toContain("Three drafts:");
    expect(r.clean).toContain("A");
    expect(r.clean).toContain("B");
    expect(r.clean).toContain("C");
    expect(r.clean).not.toContain("SEND-START");
    expect(r.clean).not.toContain("SEND-END");
  });

  it("surfaces a fallback note (not a silent drop) on irreparable JSON", () => {
    const input = "Hi\n<!--SEND-START-->{not json,<!--SEND-END-->";
    const r = extractSendTrailers(input);
    expect(r.payloads).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.clean).toContain("Hi");
    expect(r.clean).toContain("didn't render");
    expect(r.clean).not.toContain("SEND-START");
  });

  it("repairs raw newlines inside a string body and recovers the payload", () => {
    // Model wrote real line breaks in `body` instead of \n — strict JSON.parse
    // throws, but the control-char repair recovers it.
    const input =
      'Draft:\n<!--SEND-START-->\n{"kind":"gmail","account":"work","to":["a@b.com"],"subject":"x","body":"Buenos días,\n\nSolicito el cambio.\n\nGracias"}\n<!--SEND-END-->';
    const r = extractSendTrailers(input);
    expect(r.errors).toEqual([]);
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({
      kind: "gmail",
      account: "work",
      to: ["a@b.com"],
      subject: "x",
    });
    expect(r.payloads[0]!.body).toContain("Buenos días");
    expect(r.payloads[0]!.body).toContain("Solicito el cambio.");
    expect(r.clean).toBe("Draft:");
  });

  it("surfaces a fallback note when a parsed trailer fails validation", () => {
    // Valid JSON, but Gmail has neither a draft nor inline recipient/message.
    const input = `Here.\n<!--SEND-START-->{"kind":"gmail","account":"default"}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.clean).toContain("didn't render");
  });

  it("leaves clean text note-free when all trailers are valid", () => {
    const input = `Ok.\n<!--SEND-START-->{"kind":"gmail","account":"work","to":["a@b.com"],"subject":"x","body":"y"}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.errors).toEqual([]);
    expect(r.clean).toBe("Ok.");
    expect(r.clean).not.toContain("didn't render");
  });

  it("drops gmail trailer missing both draft_id and inline fields", () => {
    const input = `<!--SEND-START-->{"kind":"gmail","account":"default"}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads).toEqual([]);
  });

  it("accepts a gmail trailer without an account so runtime can use its configured default", () => {
    const input = `<!--SEND-START-->{"kind":"gmail","to":["a@b.com"],"subject":"x","body":"y"}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({ kind: "gmail", to: ["a@b.com"], subject: "x" });
    expect(r.payloads[0]!.account).toBeUndefined();
  });

  it("drops slack/agent trailer missing instruction", () => {
    const input1 = `<!--SEND-START-->{"kind":"slack"}<!--SEND-END-->`;
    const input2 = `<!--SEND-START-->{"kind":"agent","instruction":"   "}<!--SEND-END-->`;
    expect(extractSendTrailers(input1).payloads).toEqual([]);
    expect(extractSendTrailers(input2).payloads).toEqual([]);
  });

  it("rejects unknown kinds", () => {
    const input = `<!--SEND-START-->{"kind":"telegram","instruction":"x"}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads).toEqual([]);
  });

  it("accepts a connector trailer (calendar/slack/notion write) with an instruction", () => {
    const input = `<!--SEND-START-->{"kind":"connector","instruction":"Use Google Calendar: create an event ...","label":"📅 Add to calendar"}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({ kind: "connector", label: "📅 Add to calendar" });
    expect(r.payloads[0]!.instruction).toContain("Google Calendar");
  });

  it("drops a connector trailer with no instruction", () => {
    const input = `<!--SEND-START-->{"kind":"connector"}<!--SEND-END-->`;
    expect(extractSendTrailers(input).payloads).toEqual([]);
  });

  it("preserves cc/bcc/body_html/attachments and reply threading fields on gmail trailer", () => {
    const input = `<!--SEND-START-->{
      "kind":"gmail",
      "account":"work",
      "to":["a@b.com"],
      "cc":["c@b.com"],
      "bcc":["d@b.com"],
      "subject":"S",
      "body":"plain",
      "body_html":"<p>html</p>",
      "thread_id":"thr-1",
      "reply_to_message_id":"<source@example.com>",
      "in_reply_to_refs":["<first@example.com>"],
      "attachments":[{"filename":"x.pdf","content_base64":"AAA"}]
    }<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads[0]).toMatchObject({
      kind: "gmail",
      cc: ["c@b.com"],
      bcc: ["d@b.com"],
      body_html: "<p>html</p>",
      thread_id: "thr-1",
      reply_to_message_id: "<source@example.com>",
      in_reply_to_refs: ["<first@example.com>"],
      attachments: [{ filename: "x.pdf", content_base64: "AAA" }],
    });
  });

  it("preserves a path-based attachment and drops a malformed one", () => {
    const input = `<!--SEND-START-->{
      "kind":"gmail","account":"work","to":["a@b.com"],"subject":"S","body":"b",
      "attachments":[
        {"path":"/tmp/doc-1.pdf","filename":"nice.pdf"},
        {"filename":"no-content-or-path.pdf"},
        {"content_base64":"AAA"}
      ]
    }<!--SEND-END-->`;
    const atts = extractSendTrailers(input).payloads[0]!.attachments!;
    expect(atts).toHaveLength(2); // the {filename-only} entry is dropped
    expect(atts[0]).toEqual({ path: "/tmp/doc-1.pdf", filename: "nice.pdf" });
    expect(atts[1]).toEqual({ content_base64: "AAA" });
  });
});

describe("resolveGmailAttachments", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "letyclaw-att-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("reads a path-based attachment into inline base64 (filename from basename)", () => {
    const p = join(dir, "report.pdf");
    writeFileSync(p, "PDF BODY");
    const out = resolveGmailAttachments([{ path: p }], [dir])!;
    expect(out[0]!.filename).toBe("report.pdf");
    expect(Buffer.from(out[0]!.content_base64!, "base64").toString()).toBe("PDF BODY");
    expect(out[0]!.path).toBeUndefined();
  });

  it("passes inline content_base64 attachments through untouched", () => {
    const out = resolveGmailAttachments([{ filename: "x.pdf", content_base64: "AAA" }], [dir])!;
    expect(out[0]).toEqual({ filename: "x.pdf", content_base64: "AAA" });
  });

  it("throws when the referenced file is missing", () => {
    expect(() => resolveGmailAttachments([{ path: join(dir, "nope.pdf") }], [dir])).toThrow(/not found/);
  });

  it("throws when the path is outside the allowed dirs", () => {
    expect(() => resolveGmailAttachments([{ path: "/etc/hosts" }], [dir])).toThrow(/not allowed|not found/);
  });

  it("returns undefined/empty unchanged", () => {
    expect(resolveGmailAttachments(undefined, [dir])).toBeUndefined();
    expect(resolveGmailAttachments([], [dir])).toEqual([]);
  });
});

describe("describeSendTarget (button-target confirmation)", () => {
  it("surfaces gmail recipient, subject and account from the payload", () => {
    const line = describeSendTarget({
      kind: "gmail", account: "default",
      to: ["alice@example.com"], subject: "Re: lunch", body: "ok",
    });
    expect(line).toContain("alice@example.com");
    expect(line).toContain("Re: lunch");
    expect(line).toContain("[default]");
  });

  it("shows cc/bcc and attachment count when present", () => {
    const line = describeSendTarget({
      kind: "gmail", account: "work", to: ["a@x.com"], cc: ["c@x.com"], bcc: ["b@x.com"],
      subject: "s", body: "b", attachments: [{ filename: "x.pdf", content_base64: "AAA" }],
    });
    expect(line).toContain("cc c@x.com");
    expect(line).toContain("bcc b@x.com");
    expect(line).toContain("📎×1");
  });

  it("HTML-escapes recipient/subject so a crafted address can't inject markup", () => {
    const line = describeSendTarget({
      kind: "gmail", account: "default",
      to: ["<b>evil</b>@x.com"], subject: "<script>", body: "b",
    });
    expect(line).not.toContain("<b>evil");
    expect(line).not.toContain("<script>");
    expect(line).toContain("&lt;");
  });

  it("flags a gmail payload with no recipient and no draft", () => {
    const line = describeSendTarget({ kind: "gmail", account: "default", subject: "s" });
    expect(line).toContain("no recipient");
  });

  it("shows the resolved instruction for slack/agent kinds", () => {
    const slack = describeSendTarget({ kind: "slack", instruction: "post in #marketing: hi" });
    expect(slack).toContain("post in #marketing: hi");
    const agent = describeSendTarget({ kind: "agent", instruction: "create a TickTick task" });
    expect(agent).toContain("create a TickTick task");
  });

  it("truncates an overlong instruction", () => {
    const long = "x".repeat(500);
    const line = describeSendTarget({ kind: "agent", instruction: long });
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(260);
  });

  it("surfaces direct tool approval targets with escaped args", () => {
    const line = describeSendTarget({
      kind: "tool",
      tool_name: "cron_pause",
      tool_args: { id: "<daily>" },
    });
    expect(line).toContain("cron_pause");
    expect(line).toContain("&lt;daily&gt;");
    expect(line).not.toContain("<daily>");
  });
});

describe("tool SEND trailer (direct approval gate)", () => {
  it("extracts an allow-listed tool trailer", () => {
    const input = `Pause this?
<!--SEND-START-->
{"kind":"tool","tool_name":"cron_pause","tool_args":{"id":"watch-x"},"label":"Pause watch"}
<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.clean).toBe("Pause this?");
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({
      kind: "tool",
      tool_name: "cron_pause",
      tool_args: { id: "watch-x" },
      label: "Pause watch",
    });
  });

  it("drops a tool trailer whose tool is not allow-listed", () => {
    const input = `<!--SEND-START-->{"kind":"tool","tool_name":"gmail_send","tool_args":{"to":["x@y.com"]}}<!--SEND-END-->`;
    expect(extractSendTrailers(input).payloads).toEqual([]);
  });

  it("drops a tool trailer with non-object args", () => {
    const input = `<!--SEND-START-->{"kind":"tool","tool_name":"cron_pause","tool_args":["bad"]}<!--SEND-END-->`;
    expect(extractSendTrailers(input).payloads).toEqual([]);
  });
});

describe("voice SEND trailer (call approval gate)", () => {
  it("extracts a valid voice trailer", () => {
    const input = `Want me to call them?
<!--SEND-START-->
{"kind":"voice","phone_number":"+34600123456","task":"book a table for 2","label":"📞 Call"}
<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads).toHaveLength(1);
    expect(r.payloads[0]).toMatchObject({
      kind: "voice",
      phone_number: "+34600123456",
      task: "book a table for 2",
    });
    expect(r.clean).toBe("Want me to call them?");
  });

  it("drops a voice trailer with a non-E.164 number", () => {
    const input = `<!--SEND-START-->{"kind":"voice","phone_number":"600123456","task":"x"}<!--SEND-END-->`;
    expect(extractSendTrailers(input).payloads).toEqual([]);
  });

  it("drops a voice trailer missing the task", () => {
    const input = `<!--SEND-START-->{"kind":"voice","phone_number":"+34600123456"}<!--SEND-END-->`;
    expect(extractSendTrailers(input).payloads).toEqual([]);
  });

  it("describeSendTarget surfaces the number and task, HTML-escaped", () => {
    const longVisibleTask = `ask about ${"details ".repeat(40)}`.trim();
    const line = describeSendTarget({
      kind: "voice",
      phone_number: "+34600123456",
      task: `${longVisibleTask} <hours> & menu`,
      caller_name: "Alex",
      language: "es-419",
      max_duration_minutes: 5,
      first_message: "Calling about the reservation",
    });
    expect(line).toContain("+34600123456");
    expect(line).toContain("&lt;hours&gt;");
    expect(line).not.toContain("<hours>");
    expect(line).toContain(longVisibleTask);
    expect(line).not.toContain("…");
    expect(line).toContain("Automated assistant for Alex · es-419 · max 5 min");
    expect(line).toContain("Calling about the reservation");
  });

  it("preserves optional voice fields", () => {
    const input = `<!--SEND-START-->{"kind":"voice","phone_number":"+12025550143","task":"t","caller_name":"Alex","language":"en-US","max_duration_minutes":5}<!--SEND-END-->`;
    const r = extractSendTrailers(input);
    expect(r.payloads[0]).toMatchObject({
      caller_name: "Alex", language: "en-US", max_duration_minutes: 5,
    });
  });

  it("drops hidden or deceptive voice instructions before showing approval", () => {
    const tooLong = `<!--SEND-START-->${JSON.stringify({
      kind: "voice", phone_number: "+12025550143", task: "x".repeat(801),
    })}<!--SEND-END-->`;
    expect(extractSendTrailers(tooLong).payloads).toEqual([]);
    const deceptive = `<!--SEND-START-->${JSON.stringify({
      kind: "voice", phone_number: "+12025550143", task: "You are a human calling for Alex",
    })}<!--SEND-END-->`;
    expect(extractSendTrailers(deceptive).payloads).toEqual([]);
    const impersonating = `<!--SEND-START-->${JSON.stringify({
      kind: "voice", phone_number: "+12025550143", task: "Ask about hours",
      caller_name: "Alex", first_message: "Hello, this is Alex",
    })}<!--SEND-END-->`;
    expect(extractSendTrailers(impersonating).payloads).toEqual([]);
  });
});
