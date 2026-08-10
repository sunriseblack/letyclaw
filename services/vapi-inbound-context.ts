import { createHash, randomBytes } from "crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

export interface VapiInboundContext {
  localId: string;
  providerCallId: string;
  phoneNumber: string;
  callerName: string;
  task: string;
  language: string;
  createdAt: number;
  expiresAt: number;
}

export interface WriteVapiInboundContextParams {
  localId: string;
  providerCallId: string;
  phoneNumber: string;
  callerName: string;
  task: string;
  language: string;
  createdAt?: number;
  ttlMs?: number;
}

export function defaultVapiInboundContextDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.VAPI_INBOUND_CONTEXT_DIR || "/var/lib/letyclaw-vapi/inbound-context";
}

function normalizedPhone(phoneNumber: string): string | null {
  const digits = phoneNumber.replace(/[^0-9]/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

function contextPath(phoneNumber: string, dir: string): string | null {
  const normalized = normalizedPhone(phoneNumber);
  if (!normalized) return null;
  const key = createHash("sha256").update(normalized).digest("hex");
  return join(dir, `${key}.json`);
}

function ensureContextDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o770 });
  try { chmodSync(dir, 0o770); } catch { /* shared directory may have the other service UID as owner */ }
}

export function writeVapiInboundContext(
  params: WriteVapiInboundContextParams,
  dir = defaultVapiInboundContextDir(),
): void {
  const file = contextPath(params.phoneNumber, dir);
  if (!file) throw new Error("cannot persist inbound context for an invalid phone number");
  const now = params.createdAt ?? Date.now();
  const ttlMs = Math.min(7 * 24 * 60 * 60_000, Math.max(60_000, params.ttlMs ?? 48 * 60 * 60_000));
  const context: VapiInboundContext = {
    localId: params.localId,
    providerCallId: params.providerCallId,
    phoneNumber: params.phoneNumber,
    callerName: params.callerName,
    task: params.task,
    language: params.language,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  ensureContextDir(dir);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(context), { mode: 0o660 });
    chmodSync(temporary, 0o660);
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

export function readVapiInboundContext(
  phoneNumber: string,
  now = Date.now(),
  dir = defaultVapiInboundContextDir(),
): VapiInboundContext | null {
  const file = contextPath(phoneNumber, dir);
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.localId !== "string" || !value.localId ||
        typeof value.providerCallId !== "string" || !value.providerCallId ||
        typeof value.phoneNumber !== "string" || normalizedPhone(value.phoneNumber) !== normalizedPhone(phoneNumber) ||
        typeof value.callerName !== "string" || !value.callerName ||
        typeof value.task !== "string" || !value.task || value.task.length > 800 ||
        typeof value.language !== "string" || !value.language ||
        typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt) ||
        typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= now) {
      return null;
    }
    return value as unknown as VapiInboundContext;
  } catch {
    return null;
  }
}
