import { readFileSync } from "fs";

const ALIAS = /^[A-Z_][A-Z0-9_]*$/;
const SNAPSHOT_TARGET = /^(?:f\d+)?e\d+$/;

export type BrowserSecretPolicy = ReadonlyMap<string, ReadonlySet<string>>;

export interface BrowserSecretTarget {
  alias: string;
  target: string;
  element: string;
}

export function loadBrowserSecretPolicy(path: string, secretsPath: string): BrowserSecretPolicy {
  const names = new Set<string>();
  for (const line of readFileSync(secretsPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (match) names.add(match[1]!);
  }

  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")) as unknown; }
  catch { throw new Error("browser secret policy is invalid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("browser secret policy must be an object");
  }
  const policy = new Map<string, ReadonlySet<string>>();
  for (const [alias, originsValue] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALIAS.test(alias) || !Array.isArray(originsValue) || originsValue.length === 0) {
      throw new Error(`browser secret policy has an invalid entry: ${alias}`);
    }
    const origins = new Set<string>();
    for (const originValue of originsValue) {
      if (typeof originValue !== "string") throw new Error(`browser secret policy origin is invalid: ${alias}`);
      const url = new URL(originValue);
      if (url.protocol !== "https:" || url.origin !== originValue) {
        throw new Error(`browser secret policy requires exact HTTPS origins: ${alias}`);
      }
      origins.add(originValue);
    }
    policy.set(alias, origins);
  }
  for (const name of names) {
    if (!policy.has(name)) throw new Error(`browser secret alias has no allowed-origin policy: ${name}`);
  }
  return policy;
}

export function secretAliasesInArguments(value: unknown, policy: BrowserSecretPolicy): string[] {
  const found = new Set<string>();
  const visit = (item: unknown, depth: number): void => {
    if (depth > 10) return;
    if (typeof item === "string") {
      if (policy.has(item)) found.add(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
    } else if (item && typeof item === "object") {
      for (const child of Object.values(item as Record<string, unknown>)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return [...found].sort();
}

/**
 * Return the exact element targets that will receive protected values. Origin
 * checks must run against these elements, not only the top-level page: modern
 * login pages commonly embed identity forms in cross-origin frames.
 */
export function secretTargetsInBrowserArguments(
  tool: string,
  value: unknown,
  policy: BrowserSecretPolicy,
): BrowserSecretTarget[] {
  const allAliases = secretAliasesInArguments(value, policy);
  if (allAliases.length === 0) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser secret aliases require structured fill/type arguments");
  }
  const args = value as Record<string, unknown>;
  const targets: BrowserSecretTarget[] = [];
  if (tool === "browser_type") {
    if (typeof args.text === "string" && policy.has(args.text) && typeof args.target === "string") {
      targets.push({
        alias: args.text,
        target: args.target,
        element: typeof args.element === "string" ? args.element : "protected browser field",
      });
    }
  } else if (tool === "browser_fill_form" && Array.isArray(args.fields)) {
    for (const rawField of args.fields) {
      if (!rawField || typeof rawField !== "object" || Array.isArray(rawField)) continue;
      const field = rawField as Record<string, unknown>;
      if (typeof field.value !== "string" || !policy.has(field.value) || typeof field.target !== "string") continue;
      targets.push({
        alias: field.value,
        target: field.target,
        element: typeof field.element === "string"
          ? field.element
          : typeof field.name === "string" ? field.name : "protected browser field",
      });
    }
  }
  const targetedAliases = new Set(targets.map((entry) => entry.alias));
  if (targets.length === 0 || allAliases.some((alias) => !targetedAliases.has(alias))) {
    throw new Error("browser secret aliases are accepted only as values for targeted fill/type fields");
  }
  if (targets.some((entry) => !SNAPSHOT_TARGET.test(entry.target))) {
    throw new Error("browser secret fields require exact fresh snapshot targets, not CSS selectors");
  }
  return targets;
}

export function assertSecretAliasesAllowed(
  aliases: readonly string[],
  origin: string,
  policy: BrowserSecretPolicy,
): void {
  for (const alias of aliases) {
    if (!policy.get(alias)?.has(origin)) {
      throw new Error(`browser secret alias ${alias} is not allowed on ${origin || "this page"}`);
    }
  }
}

export function originFromEvaluateResult(result: unknown): string {
  if (!result || typeof result !== "object") throw new Error("unable to verify browser origin");
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("unable to verify browser origin");
  const text = content
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? (part as { text: string }).text : "")
    .join("\n");
  const marker = text.match(/^### Result\s*\n([^\n]+)/m);
  if (!marker) throw new Error("unable to verify browser origin");
  let value: unknown;
  try { value = JSON.parse(marker[1]!); } catch { throw new Error("unable to verify browser origin"); }
  if (typeof value !== "string") throw new Error("unable to verify browser origin");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) throw new Error("browser secrets require an HTTPS page");
  return value;
}
