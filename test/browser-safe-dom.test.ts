import { describe, expect, it } from "vitest";
import {
  isSafeGatewayBrowserTool,
  safeGatewayUpstreamCall,
} from "../services/browser-safe-dom.js";

describe("audited browser DOM inspection", () => {
  it("exposes fixed page info without model-supplied JavaScript", () => {
    expect(isSafeGatewayBrowserTool("browser_page_info")).toBe(true);
    const call = safeGatewayUpstreamCall("browser_page_info", {});
    expect(call.name).toBe("browser_evaluate");
    expect(call.arguments.function).toContain("Intl.DateTimeFormat");
    expect(call.arguments.function).toContain("#redacted");
    expect(call.arguments.function).toContain("slice(0, limit)");
  });

  it("builds a bounded read-only query for text, links, and geometry", () => {
    const call = safeGatewayUpstreamCall("browser_dom_query", {
      selector: ".slot",
      limit: 10,
      fields: [
        { name: "time", source: "text", selector: ".time" },
        { name: "book", source: "attribute", selector: "a", attribute: "href" },
        { name: "rect", source: "rect" },
      ],
    });
    const fn = String(call.arguments.function);
    expect(fn).toContain("querySelectorAll");
    expect(fn).toContain("getBoundingClientRect");
    expect(fn).toContain("slice(0, 1000)");
    expect(fn).toContain("url.searchParams.set");
    expect(fn).not.toContain("fetch(");
  });

  it("rejects form values, oversized queries, and malformed fields", () => {
    expect(() => safeGatewayUpstreamCall("browser_dom_query", {
      selector: "input",
      fields: [{ name: "secret", source: "attribute", attribute: "value" }],
    })).toThrow(/forbidden attribute/);
    expect(() => safeGatewayUpstreamCall("browser_dom_query", {
      selector: "div",
      fields: [{ name: "payload", source: "attribute", attribute: "data-bootstrap" }],
    })).toThrow(/forbidden attribute/);
    expect(() => safeGatewayUpstreamCall("browser_dom_query", {
      selector: "x".repeat(513),
      fields: [{ name: "text", source: "text" }],
    })).toThrow(/512/);
    expect(() => safeGatewayUpstreamCall("browser_dom_query", {
      selector: "div",
      fields: [{ name: "__proto__", source: "text" }],
    })).toThrow(/invalid/);
  });

  it("can query the owner document of a frame target without exposing evaluate", () => {
    const call = safeGatewayUpstreamCall("browser_dom_query", {
      selector: ".calendar",
      target: "f1e3",
      element: "calendar frame",
      fields: [{ name: "text", source: "text" }],
    });
    expect(call.arguments.target).toBe("f1e3");
    expect(call.arguments.function).toContain("element.ownerDocument");
  });
});
