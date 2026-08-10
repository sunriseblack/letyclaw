import { isAbsolute, relative, sep } from "path";

export const REQUIRED_BROWSER_TOOLS = [
  "browser_click",
  "browser_close",
  "browser_console_messages",
  "browser_dom_query",
  "browser_drag",
  "browser_drop",
  "browser_file_upload",
  "browser_fill_form",
  "browser_find",
  "browser_handle_dialog",
  "browser_hover",
  "browser_navigate",
  "browser_navigate_back",
  "browser_mouse_click_xy",
  "browser_mouse_down",
  "browser_mouse_drag_xy",
  "browser_mouse_move_xy",
  "browser_mouse_up",
  "browser_mouse_wheel",
  "browser_pdf_save",
  "browser_page_info",
  "browser_press_key",
  "browser_resize",
  "browser_select_option",
  "browser_snapshot",
  "browser_tabs",
  "browser_take_screenshot",
  "browser_type",
  "browser_wait_for",
] as const;

export const FORBIDDEN_BROWSER_TOOLS = [
  "browser_evaluate",
  "browser_network_request",
  "browser_network_requests",
  "browser_run_code",
  "browser_run_code_unsafe",
] as const;

export interface BrowserTab {
  index: number;
  current: boolean;
  url: string;
}

export interface BrowserSmokeState {
  marker: string | null;
  title: string;
  timezone: string;
  url: string;
  userAgent: string;
}

export function assertRequiredBrowserTools(toolNames: Iterable<string>): void {
  const available = new Set(toolNames);
  const missing = REQUIRED_BROWSER_TOOLS.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Playwright MCP is missing required browser tools: ${missing.join(", ")}`);
  }
  const exposedUnsafe = FORBIDDEN_BROWSER_TOOLS.filter((name) => available.has(name));
  if (exposedUnsafe.length > 0) {
    throw new Error(`Playwright gateway exposed forbidden browser tools: ${exposedUnsafe.join(", ")}`);
  }
}

export function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: "text"; text: string } => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string";
    })
    .map((item) => item.text)
    .join("\n");
}

export function assertToolSucceeded(toolName: string, result: unknown): string {
  const text = toolResultText(result);
  const isError = Boolean(result && typeof result === "object" &&
    (result as Record<string, unknown>).isError === true);
  if (isError || /^### Error\b/m.test(text)) {
    const detail = text.trim() || "tool returned an error without details";
    throw new Error(`${toolName} failed: ${detail}`);
  }
  return text;
}

export function extractJsonResult(text: string): unknown {
  const resultMarker = /^### Result\s*$/m;
  const marker = resultMarker.exec(text);
  if (!marker) throw new Error("Playwright tool response did not include a JSON result section");

  const remainder = text.slice(marker.index + marker[0].length).trimStart();
  const nextHeading = remainder.search(/^###\s/m);
  let payload = (nextHeading === -1 ? remainder : remainder.slice(0, nextHeading)).trim();
  if (payload.startsWith("```")) {
    payload = payload.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  }

  try {
    return JSON.parse(payload) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Playwright JSON result was malformed: ${reason}`);
  }
}

export function parseBrowserSmokeState(text: string): BrowserSmokeState {
  const value = extractJsonResult(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Playwright shared-state result was not an object");
  }
  const record = value as Record<string, unknown>;
  if ((record.marker !== undefined && record.marker !== null && typeof record.marker !== "string") ||
      typeof record.title !== "string" ||
      typeof record.timezone !== "string" ||
      typeof record.url !== "string" ||
      typeof record.userAgent !== "string") {
    throw new Error("Playwright shared-state result had an unexpected shape");
  }
  return {
    marker: typeof record.marker === "string" ? record.marker : null,
    title: record.title,
    timezone: record.timezone,
    url: record.url,
    userAgent: record.userAgent,
  };
}

export function parseBrowserTabs(text: string): BrowserTab[] {
  const tabs: BrowserTab[] = [];
  const linePattern = /^- (\d+):( \(current\))? .*\((https?:\/\/[^)]+|about:[^)]+)\)\s*$/gm;
  for (const match of text.matchAll(linePattern)) {
    tabs.push({
      index: Number(match[1]),
      current: Boolean(match[2]),
      url: match[3]!,
    });
  }
  return tabs;
}

export function assertScreenshotFilename(filename: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:png|jpe?g)$/.test(filename)) {
    throw new Error("Browser smoke screenshot must be a safe .png/.jpg filename without a path");
  }
}

export function artifactPathForTool(
  workspaceRoot: string,
  artifactDirectory: string,
  filename: string,
): string {
  if (!isAbsolute(workspaceRoot) || !isAbsolute(artifactDirectory)) {
    throw new Error("Browser workspace and artifact directory must be absolute paths");
  }
  assertScreenshotFilename(filename);
  const path = relative(workspaceRoot, `${artifactDirectory}/${filename}`);
  if (!path || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("Browser artifact directory must be inside the advertised workspace root");
  }
  return path.split(sep).join("/");
}
