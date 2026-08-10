import { describe, it, expect } from "vitest";
import {
  _buildMimeForTest as buildMime,
  _resolveReplyContextForTest as resolveReplyContext,
  _validateReplyMarkersForTest as validateReplyMarkers,
  handlers as gmailHandlers,
  parseGmailAccount,
} from "../tools/letyclaw-mcp/tools/gmail.js";

describe("Gmail MIME construction", () => {
  it("builds a minimal plain-text message with required headers", () => {
    const m = buildMime({
      from_email: "sender@example.com",
      from_name: "Alex Smith",
      to: ["friend@example.com"],
      subject: "Hello",
      body: "Hi there.",
    });
    expect(m).toMatch(/^From: Alex Smith <sender@example\.com>\r\n/);
    expect(m).toContain("To: friend@example.com\r\n");
    expect(m).toContain("Subject: Hello\r\n");
    expect(m).toContain("MIME-Version: 1.0\r\n");
    expect(m).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(m).toMatch(/\r\n\r\nHi there\.$/);
  });

  it("RFC 2047-encodes non-ASCII subjects", () => {
    const m = buildMime({
      from_email: "a@b.com",
      to: ["c@d.com"],
      subject: "Привіт, ціна — 12€",
      body: "x",
    });
    expect(m).toMatch(/Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    // and the encoded subject decodes back
    const enc = /Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/.exec(m)![1];
    expect(Buffer.from(enc, "base64").toString("utf8")).toBe("Привіт, ціна — 12€");
  });

  it("wraps text+html in multipart/alternative", () => {
    const m = buildMime({
      from_email: "a@b.com",
      to: ["c@d.com"],
      subject: "x",
      body: "plain",
      body_html: "<p>html</p>",
    });
    expect(m).toMatch(/Content-Type: multipart\/alternative; boundary="=_letyclaw_alt_[0-9a-f]+"/);
    expect(m).toContain("plain");
    expect(m).toContain("<p>html</p>");
  });

  it("wraps attachments in multipart/mixed", () => {
    const m = buildMime({
      from_email: "a@b.com",
      to: ["c@d.com"],
      subject: "x",
      body: "see attached",
      attachments: [
        { filename: "report.pdf", content_base64: "JVBERi0xLjQK", mime_type: "application/pdf" },
      ],
    });
    expect(m).toMatch(/Content-Type: multipart\/mixed; boundary="=_letyclaw_mix_[0-9a-f]+"/);
    expect(m).toContain('Content-Disposition: attachment; filename="report.pdf"');
    expect(m).toContain("JVBERi0xLjQK");
  });

  it("includes In-Reply-To and References headers for threaded replies", () => {
    const m = buildMime({
      from_email: "a@b.com",
      to: ["c@d.com"],
      subject: "Re: x",
      body: "reply",
      reply_to_message_id: "<orig@gmail.com>",
      in_reply_to_refs: ["<first@gmail.com>", "<second@gmail.com>"],
    });
    expect(m).toContain("In-Reply-To: <orig@gmail.com>");
    expect(m).toContain("References: <first@gmail.com> <second@gmail.com> <orig@gmail.com>");
  });

  it("supports multiple To/Cc/Bcc recipients", () => {
    const m = buildMime({
      from_email: "a@b.com",
      to: ["x@y.com", "z@y.com"],
      cc: ["cc@y.com"],
      bcc: ["bcc@y.com"],
      subject: "x",
      body: "y",
    });
    expect(m).toContain("To: x@y.com, z@y.com");
    expect(m).toContain("Cc: cc@y.com");
    expect(m).toContain("Bcc: bcc@y.com");
  });
});

describe("Gmail account aliases", () => {
  it("accepts arbitrary safe aliases and applies the configured fallback", () => {
    expect(parseGmailAccount("work-mail")).toBe("work-mail");
    expect(parseGmailAccount(undefined, "default")).toBe("default");
  });

  it("rejects aliases that could escape the token directory", () => {
    expect(() => parseGmailAccount("../private")).toThrow(/invalid Gmail account alias/);
    expect(() => parseGmailAccount("account/name")).toThrow(/invalid Gmail account alias/);
  });

  it("shows the complete auth command when an alias has no token", async () => {
    const result = await gmailHandlers.gmail_list_drafts!({ account: "missing-test-account" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(
      "gmail-auth.mjs missing-test-account <email-address> [client_secret.json]",
    );
  });
});

describe("Gmail reply-thread resolution", () => {
  it("resolves an RFC Message-ID to the Gmail thread and existing References", async () => {
    const calls: string[] = [];
    const result = await resolveReplyContext("source@example.com", async (_method, path) => {
      calls.push(path);
      if (path.startsWith("/messages?q=")) {
        return { messages: [{ id: "gmail-message-1", threadId: "gmail-thread-1" }] };
      }
      return { payload: { headers: [
        { name: "Message-ID", value: "<source@example.com>" },
        { name: "References", value: "<first@example.com> <second@example.com>" },
      ] } };
    });
    expect(calls[0]).toContain(encodeURIComponent("rfc822msgid:<source@example.com>"));
    expect(result).toEqual({
      threadId: "gmail-thread-1",
      replyToMessageId: "<source@example.com>",
      references: ["<first@example.com>", "<second@example.com>"],
    });
  });

  it("fails closed when the reply target cannot be found", async () => {
    await expect(resolveReplyContext("<missing@example.com>", async () => ({ messages: [] })))
      .rejects.toThrow(/not found/);
  });

  it("rejects reply-like sends that omit the exact source Message-ID", () => {
    expect(() => validateReplyMarkers({ subject: "Re: Existing case" })).toThrow(/required for replies/);
    expect(() => validateReplyMarkers({ subject: "Existing case", thread_id: "thread-1" }))
      .toThrow(/required for replies/);
    expect(() => validateReplyMarkers({
      subject: "Re: Existing case",
      reply_to_message_id: "<source@example.com>",
    })).not.toThrow();
  });
});
