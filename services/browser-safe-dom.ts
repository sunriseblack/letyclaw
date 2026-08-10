/** Audited, read-only page inspection exposed instead of arbitrary evaluate. */

export interface SafeGatewayTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface DomField {
  name: string;
  source: "text" | "attribute" | "rect";
  selector?: string;
  closest?: string;
  attribute?: string;
}

interface DomQuery {
  selector: string;
  limit: number;
  fields: DomField[];
  target?: string;
  element?: string;
}

const SAFE_ATTRIBUTE = /^(?:href|src|alt|title|class|id|role|aria-[a-z0-9_-]+)$/i;
const SAFE_FIELD_NAME = /^(?!__proto__$|constructor$|prototype$)[A-Za-z][A-Za-z0-9_]{0,39}$/;

const fieldSchema = {
  type: "object",
  properties: {
    name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_]{0,39}$" },
    source: { type: "string", enum: ["text", "attribute", "rect"] },
    selector: { type: "string", description: "Optional descendant CSS selector." },
    closest: { type: "string", description: "Optional ancestor CSS selector; cannot be combined with selector." },
        attribute: { type: "string", description: "Required only for source=attribute. Form values and page data-* payloads are forbidden; sensitive URL parameters are redacted." },
  },
  required: ["name", "source"],
  additionalProperties: false,
};

export const SAFE_GATEWAY_BROWSER_TOOLS: readonly SafeGatewayTool[] = [
  {
    name: "browser_page_info",
    description: "Return the current page URL, title, timezone, and browser user agent using an audited read-only evaluator.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_dom_query",
    description: "Read text, safe attributes, and geometry from matching DOM elements without executing model-supplied JavaScript. Use this for grids, calendars, and seat maps.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector evaluated in the current document (or the document containing target)." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
        fields: { type: "array", minItems: 1, maxItems: 8, items: fieldSchema },
        target: { type: "string", description: "Optional exact snapshot target inside a frame whose document should be queried." },
        element: { type: "string", description: "Human-readable description for the optional target." },
      },
      required: ["selector", "fields"],
      additionalProperties: false,
    },
  },
] as const;

export function isSafeGatewayBrowserTool(name: string): boolean {
  return SAFE_GATEWAY_BROWSER_TOOLS.some((tool) => tool.name === name);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function cssSelector(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0")) {
    throw new Error(`${label} must be a CSS selector from 1 to 512 characters`);
  }
  return value;
}

function parseDomQuery(value: unknown): DomQuery {
  const args = object(value, "browser_dom_query arguments");
  const selector = cssSelector(args.selector, "browser_dom_query selector");
  const limit = args.limit === undefined ? 100 : Number(args.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("browser_dom_query limit must be an integer from 1 to 100");
  }
  if (!Array.isArray(args.fields) || args.fields.length < 1 || args.fields.length > 8) {
    throw new Error("browser_dom_query fields must contain 1 to 8 entries");
  }
  const names = new Set<string>();
  const fields = args.fields.map((raw, index): DomField => {
    const field = object(raw, `browser_dom_query field ${index + 1}`);
    if (typeof field.name !== "string" || !SAFE_FIELD_NAME.test(field.name) || names.has(field.name)) {
      throw new Error(`browser_dom_query field ${index + 1} has an invalid or duplicate name`);
    }
    names.add(field.name);
    if (field.source !== "text" && field.source !== "attribute" && field.source !== "rect") {
      throw new Error(`browser_dom_query field ${field.name} has an invalid source`);
    }
    const descendant = field.selector === undefined ? undefined : cssSelector(field.selector, `field ${field.name} selector`);
    const closest = field.closest === undefined ? undefined : cssSelector(field.closest, `field ${field.name} closest`);
    if (descendant && closest) throw new Error(`browser_dom_query field ${field.name} cannot use selector and closest together`);
    const attribute = field.attribute;
    if (field.source === "attribute") {
      if (typeof attribute !== "string" || !SAFE_ATTRIBUTE.test(attribute)) {
        throw new Error(`browser_dom_query field ${field.name} requested a forbidden attribute`);
      }
    } else if (attribute !== undefined) {
      throw new Error(`browser_dom_query field ${field.name} uses attribute with a non-attribute source`);
    }
    return {
      name: field.name,
      source: field.source,
      ...(descendant ? { selector: descendant } : {}),
      ...(closest ? { closest } : {}),
      ...(typeof attribute === "string" ? { attribute } : {}),
    };
  });
  const target = args.target === undefined ? undefined : String(args.target);
  if (target !== undefined && (target.length < 1 || target.length > 512 || target.includes("\0"))) {
    throw new Error("browser_dom_query target is invalid");
  }
  const element = args.element === undefined ? undefined : String(args.element).slice(0, 160);
  return { selector, limit, fields, ...(target ? { target, element: element || "DOM query context" } : {}) };
}

const PAGE_INFO_FUNCTION = `() => {
  const bounded = (value, limit) => String(value || "").slice(0, limit);
  const url = new URL(location.href);
  if (url.username) url.username = "redacted";
  if (url.password) url.password = "redacted";
  for (const key of [...url.searchParams.keys()]) {
    if (/(?:token|auth|session|csrf|secret|key|signature|jwt|code)/i.test(key)) url.searchParams.set(key, "redacted");
  }
  if (/(?:access_token|id_token|auth|session|csrf|secret|jwt|code)=/i.test(url.hash)) url.hash = "#redacted";
  return {
    title: bounded(document.title, 1000),
    timezone: bounded(Intl.DateTimeFormat().resolvedOptions().timeZone, 100),
    url: bounded(url.href, 2000),
    userAgent: bounded(navigator.userAgent, 500),
  };
}`;

/** Build only fixed, gateway-owned evaluator code. No model-supplied JavaScript crosses this boundary. */
export function safeGatewayUpstreamCall(
  tool: string,
  rawArguments: unknown,
): { name: "browser_evaluate"; arguments: Record<string, unknown> } {
  if (tool === "browser_page_info") {
    const args = rawArguments === undefined ? {} : object(rawArguments, "browser_page_info arguments");
    if (Object.keys(args).length > 0) throw new Error("browser_page_info accepts no arguments");
    return { name: "browser_evaluate", arguments: { function: PAGE_INFO_FUNCTION } };
  }
  if (tool !== "browser_dom_query") throw new Error(`unknown safe gateway browser tool: ${tool}`);
  const query = parseDomQuery(rawArguments);
  const encoded = JSON.stringify({ selector: query.selector, limit: query.limit, fields: query.fields });
  const fn = `${query.target ? "(element)" : "()"} => {
  const spec = ${encoded};
  const root = ${query.target ? "element.ownerDocument" : "document"};
  const cleanText = value => String(value || "").replace(/\\s+/g, " ").trim().slice(0, 1000);
  const cleanAttribute = (name, value) => {
    if (value == null) return null;
    let clean = String(value);
    if (name === "href" || name === "src") {
      try {
        const url = new URL(clean, location.href);
        if (url.username) url.username = "redacted";
        if (url.password) url.password = "redacted";
        for (const key of [...url.searchParams.keys()]) {
          if (/(?:token|auth|session|csrf|secret|key|signature|jwt|code)/i.test(key)) url.searchParams.set(key, "redacted");
        }
        if (/(?:access_token|id_token|auth|session|csrf|secret|jwt|code)=/i.test(url.hash)) url.hash = "#redacted";
        clean = url.href;
      } catch { /* retain a bounded relative/non-URL attribute */ }
    }
    return clean.slice(0, 1000);
  };
  return [...root.querySelectorAll(spec.selector)].slice(0, spec.limit).map(base => {
    const row = {};
    for (const field of spec.fields) {
      const node = field.selector ? base.querySelector(field.selector) : field.closest ? base.closest(field.closest) : base;
      if (!node) { row[field.name] = null; continue; }
      if (field.source === "text") row[field.name] = cleanText(node.textContent);
      else if (field.source === "attribute") row[field.name] = cleanAttribute(field.attribute, node.getAttribute(field.attribute));
      else {
        const rect = node.getBoundingClientRect();
        row[field.name] = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height), top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) };
      }
    }
    return row;
  });
}`;
  return {
    name: "browser_evaluate",
    arguments: {
      function: fn,
      ...(query.target ? { target: query.target, element: query.element } : {}),
    },
  };
}
