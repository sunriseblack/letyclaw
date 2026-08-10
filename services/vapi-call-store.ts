/**
 * Durable Vapi call lifecycle state.
 *
 * The approval token is the local idempotency key. Provider call IDs are bound
 * after Vapi accepts a call (or later by webhook reconciliation when the POST
 * response was lost). SQLite/WAL gives the bot, MCP subprocesses, and webhook
 * event consumer a single crash-safe source of truth without overloading the
 * legacy Twilio ConversationRelay `calls` table.
 */
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { randomBytes } from "crypto";
import { mkdirSync } from "fs";
import { dirname, join } from "path";

const TERMINAL_STATES = new Set(["ended", "failed", "outcome_unknown"]);
const STATE_RANK: Record<string, number> = {
  starting: 0,
  scheduled: 1,
  queued: 2,
  ringing: 3,
  "in-progress": 4,
  forwarding: 5,
  "awaiting-report": 6,
  ended: 7,
  failed: 7,
  outcome_unknown: 7,
};

export interface VapiCallRow {
  local_id: string;
  provider_call_id: string | null;
  parent_local_id: string | null;
  direction: "outbound" | "inbound";
  approval_token: string;
  agent_id: string;
  topic_id: number;
  chat_id: string | null;
  approval_message_id: number | null;
  status_message_id: number | null;
  source_session_id: string | null;
  phone_number: string;
  task: string;
  caller_name: string;
  first_message: string | null;
  language: string;
  max_duration_seconds: number;
  state: string;
  provider_status: string | null;
  last_provider_event_at: number | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  terminal_observed_at: number | null;
  ended_reason: string | null;
  duration_seconds: number | null;
  cost: number | null;
  transcript: string;
  summary: string | null;
  success_evaluation: string | null;
  recording_url: string | null;
  error: string | null;
  next_poll_at: number | null;
  last_polled_at: number | null;
  notifying_at: number | null;
  notifying_token: string | null;
  notify_after: number | null;
  notified_at: number | null;
}

export interface CreateVapiCallParams {
  localId: string;
  providerCallId?: string;
  parentLocalId?: string;
  direction?: "outbound" | "inbound";
  approvalToken: string;
  agentId: string;
  topicId: number;
  chatId?: string | number;
  approvalMessageId?: number;
  sourceSessionId?: string;
  phoneNumber: string;
  task: string;
  callerName: string;
  firstMessage?: string;
  language: string;
  maxDurationSeconds: number;
  state?: string;
  providerStatus?: string;
  createdAt?: number;
}

export interface VapiCallSnapshot {
  providerCallId: string;
  providerStatus?: string;
  state?: string;
  startedAt?: number;
  endedAt?: number;
  endedReason?: string;
  durationSeconds?: number;
  cost?: number;
  transcript?: string;
  summary?: string;
  successEvaluation?: string;
  recordingUrl?: string;
  error?: string;
  observedAt?: number;
}

export interface VapiEventRecord {
  eventKey: string;
  providerCallId: string;
  localId?: string;
  type: string;
  providerTimestamp?: string;
  payloadJson: string;
}

let dbSingleton: DatabaseType | null = null;
let dbSingletonPath: string | null = null;

export function defaultVapiDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const sessions = env.LETYCLAW_SESSIONS_DIR || env.SESSIONS_DIR || "/root/letyclaw/sessions";
  return env.VAPI_CALL_DB_PATH || join(sessions, "vapi-calls.sqlite");
}

export function getVapiDb(dbPath = defaultVapiDbPath()): DatabaseType {
  if (dbSingleton && dbSingletonPath === dbPath) return dbSingleton;
  if (dbSingleton) {
    try { dbSingleton.close(); } catch { /* ignore */ }
  }
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS vapi_calls (
      local_id TEXT PRIMARY KEY,
      provider_call_id TEXT UNIQUE,
      parent_local_id TEXT,
      direction TEXT NOT NULL DEFAULT 'outbound',
      approval_token TEXT NOT NULL UNIQUE,
      agent_id TEXT NOT NULL,
      topic_id INTEGER NOT NULL,
      chat_id TEXT,
      approval_message_id INTEGER,
      status_message_id INTEGER,
      source_session_id TEXT,
      phone_number TEXT NOT NULL,
      task TEXT NOT NULL,
      caller_name TEXT NOT NULL,
      first_message TEXT,
      language TEXT NOT NULL,
      max_duration_seconds INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'starting',
      provider_status TEXT,
      last_provider_event_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      terminal_observed_at INTEGER,
      ended_reason TEXT,
      duration_seconds INTEGER,
      cost REAL,
      transcript TEXT NOT NULL DEFAULT '',
      summary TEXT,
      success_evaluation TEXT,
      recording_url TEXT,
      error TEXT,
      next_poll_at INTEGER,
      last_polled_at INTEGER,
      notifying_at INTEGER,
      notifying_token TEXT,
      notify_after INTEGER,
      notified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_vapi_calls_topic_created
      ON vapi_calls(topic_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vapi_calls_work
      ON vapi_calls(state, next_poll_at, notified_at);
    CREATE TABLE IF NOT EXISTS vapi_events (
      event_key TEXT PRIMARY KEY,
      provider_call_id TEXT NOT NULL,
      local_id TEXT,
      type TEXT NOT NULL,
      provider_timestamp TEXT,
      payload_json TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      processed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_vapi_events_unprocessed
      ON vapi_events(processed_at, received_at);
    CREATE TABLE IF NOT EXISTS vapi_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const ensureCallColumn = (name: string, ddl: string): void => {
    const hasColumn = (): boolean => (db.prepare("PRAGMA table_info(vapi_calls)").all() as Array<{ name: string }>)
      .some((column) => column.name === name);
    if (hasColumn()) return;
    try {
      db.exec(ddl);
    } catch (err) {
      // Two bot/MCP processes can open an older DB at once. If the other
      // process won the ALTER race, the now-present column proves success.
      if (!hasColumn()) throw err;
    }
  };
  ensureCallColumn("notifying_token", "ALTER TABLE vapi_calls ADD COLUMN notifying_token TEXT");
  ensureCallColumn("terminal_observed_at", "ALTER TABLE vapi_calls ADD COLUMN terminal_observed_at INTEGER");
  ensureCallColumn("last_provider_event_at", "ALTER TABLE vapi_calls ADD COLUMN last_provider_event_at INTEGER");
  ensureCallColumn("notify_after", "ALTER TABLE vapi_calls ADD COLUMN notify_after INTEGER");
  db.transaction(() => {
    const migrationKey = "provider-bound-failure-recovery-v1";
    const applied = db.prepare<[string], { value: string }>("SELECT value FROM vapi_meta WHERE key = ?")
      .get(migrationKey);
    if (applied?.value === "1") return;
    // An intermediate implementation permanently classified accepted calls as
    // failed when GET later returned 404/410. Reopen only those provider-bound
    // legacy rows for slow reconciliation; true pre-launch failures have no
    // provider id and remain immutable.
    db.prepare(`
      UPDATE vapi_calls
      SET state = 'outcome_unknown', ended_at = NULL, notified_at = NULL,
          notifying_at = NULL, notifying_token = NULL, notify_after = NULL,
          next_poll_at = ?, updated_at = ?
      WHERE state = 'failed' AND provider_call_id IS NOT NULL
    `).run(Date.now(), Date.now());
    db.prepare("INSERT OR REPLACE INTO vapi_meta (key, value) VALUES (?, '1')").run(migrationKey);
  }).immediate();
  dbSingleton = db;
  dbSingletonPath = dbPath;
  return db;
}

export function closeVapiDb(): void {
  if (dbSingleton) {
    try { dbSingleton.close(); } catch { /* ignore */ }
  }
  dbSingleton = null;
  dbSingletonPath = null;
}

export function isTerminalVapiState(state: string): boolean {
  return TERMINAL_STATES.has(state);
}

function normalizedState(providerStatus: string | undefined, explicit?: string): string {
  if (explicit) return explicit;
  if (!providerStatus) return "starting";
  if (providerStatus === "ended") return "ended";
  if (providerStatus === "not-found" || providerStatus === "deletion-failed") return "failed";
  return providerStatus;
}

export function createVapiCall(params: CreateVapiCallParams, db: DatabaseType = getVapiDb()): VapiCallRow {
  const now = params.createdAt ?? Date.now();
  const state = normalizedState(params.providerStatus, params.state);
  db.prepare(`
    INSERT INTO vapi_calls (
      local_id, provider_call_id, parent_local_id, direction, approval_token,
      agent_id, topic_id, chat_id, approval_message_id, source_session_id,
      phone_number, task, caller_name, first_message, language,
      max_duration_seconds, state, provider_status, created_at, updated_at,
      next_poll_at
    ) VALUES (
      @localId, @providerCallId, @parentLocalId, @direction, @approvalToken,
      @agentId, @topicId, @chatId, @approvalMessageId, @sourceSessionId,
      @phoneNumber, @task, @callerName, @firstMessage, @language,
      @maxDurationSeconds, @state, @providerStatus, @createdAt, @updatedAt,
      @nextPollAt
    )
    ON CONFLICT(local_id) DO NOTHING
  `).run({
    localId: params.localId,
    providerCallId: params.providerCallId ?? null,
    parentLocalId: params.parentLocalId ?? null,
    direction: params.direction ?? "outbound",
    approvalToken: params.approvalToken,
    agentId: params.agentId,
    topicId: params.topicId,
    chatId: params.chatId === undefined ? null : String(params.chatId),
    approvalMessageId: params.approvalMessageId ?? null,
    sourceSessionId: params.sourceSessionId ?? null,
    phoneNumber: params.phoneNumber,
    task: params.task,
    callerName: params.callerName,
    firstMessage: params.firstMessage ?? null,
    language: params.language,
    maxDurationSeconds: params.maxDurationSeconds,
    state,
    providerStatus: params.providerStatus ?? null,
    createdAt: now,
    updatedAt: now,
    nextPollAt: isTerminalVapiState(state) ? null : now,
  });
  const row = getVapiCall(params.localId, db);
  if (!row) throw new Error("failed to create durable Vapi call state");
  return row;
}

export function getVapiCall(identifier: string, db: DatabaseType = getVapiDb()): VapiCallRow | null {
  return db.prepare<[string, string], VapiCallRow>(
    "SELECT * FROM vapi_calls WHERE local_id = ? OR provider_call_id = ? LIMIT 1",
  ).get(identifier, identifier) ?? null;
}

export function getLatestVapiCallForTopic(
  topicId: number,
  agentId?: string,
  db: DatabaseType = getVapiDb(),
): VapiCallRow | null {
  if (agentId) {
    return db.prepare<[number, string], VapiCallRow>(
      "SELECT * FROM vapi_calls WHERE topic_id = ? AND agent_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(topicId, agentId) ?? null;
  }
  return db.prepare<[number], VapiCallRow>(
    "SELECT * FROM vapi_calls WHERE topic_id = ? ORDER BY created_at DESC LIMIT 1",
  ).get(topicId) ?? null;
}

export function bindVapiProviderCall(
  localId: string,
  providerCallId: string,
  providerStatus?: string,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): VapiCallRow {
  return db.transaction((): VapiCallRow => {
    const existing = getVapiCall(localId, db);
    if (!existing) throw new Error(`Vapi call state not found for ${localId}`);
    if (existing.provider_call_id && existing.provider_call_id !== providerCallId) {
      throw new Error(`Vapi call ${localId} is already bound to a different provider call`);
    }
    const candidateState = providerStatus ? normalizedState(providerStatus) : existing.state;
    const state = isTerminalVapiState(existing.state) ||
      (STATE_RANK[candidateState] ?? 0) < (STATE_RANK[existing.state] ?? 0)
      ? existing.state
      : candidateState;
    const acceptedProviderStatus = state === candidateState ? providerStatus : undefined;
    const result = db.prepare(`
      UPDATE vapi_calls
      SET provider_call_id = COALESCE(provider_call_id, ?),
          provider_status = COALESCE(?, provider_status),
          state = ?, updated_at = ?, next_poll_at = ?,
          terminal_observed_at = CASE WHEN ? = 1 THEN COALESCE(terminal_observed_at, ?) ELSE terminal_observed_at END
      WHERE local_id = ? AND (provider_call_id IS NULL OR provider_call_id = ?)
    `).run(
      providerCallId,
      acceptedProviderStatus ?? null,
      state,
      now,
      isTerminalVapiState(state) ? null : now,
      state === "ended" ? 1 : 0,
      now,
      localId,
      providerCallId,
    );
    if (result.changes !== 1) throw new Error(`Vapi call ${localId} provider binding changed concurrently`);
    return getVapiCall(localId, db)!;
  }).immediate();
}

export function applyVapiCallSnapshot(
  snapshot: VapiCallSnapshot,
  localId?: string,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): VapiCallRow | null {
  return db.transaction((): VapiCallRow | null => {
    const current = localId ? getVapiCall(localId, db) : getVapiCall(snapshot.providerCallId, db);
    if (!current) return null;
    if (current.provider_call_id && current.provider_call_id !== snapshot.providerCallId) {
      throw new Error("provider call id mismatch");
    }
    const candidate = normalizedState(snapshot.providerStatus, snapshot.state);
    const currentRank = STATE_RANK[current.state] ?? 0;
    const candidateRank = STATE_RANK[candidate] ?? currentRank;
    const staleProviderSnapshot = snapshot.observedAt !== undefined && current.last_provider_event_at !== null &&
      (snapshot.observedAt < current.last_provider_event_at ||
        (snapshot.observedAt === current.last_provider_event_at && candidateRank < currentRank));
    // `outcome_unknown` is a synthetic local state, not a provider resource
    // version. A GET that proves the exact call is still live at the same
    // provider updatedAt must be able to undo it; genuinely older events stay
    // stale and cannot regress the row.
    const sameVersionLiveRecovery = current.state === "outcome_unknown" &&
      snapshot.observedAt !== undefined && snapshot.observedAt === current.last_provider_event_at &&
      !isTerminalVapiState(candidate) && candidate !== "awaiting-report";
    const closesAwaitingReport = current.state === "awaiting-report" && candidate === "ended";
    const providerProvesEnded = snapshot.providerStatus === "ended" &&
      (candidate === "ended" || candidate === "awaiting-report");
    const acceptedTerminalRecovery = providerProvesEnded && (
      current.state === "outcome_unknown" || (current.state === "failed" && !!current.provider_call_id)
    );
    const unversionedAfterVersioned = snapshot.observedAt === undefined && current.last_provider_event_at !== null;
    const restrictArtifactOverwrite = staleProviderSnapshot || unversionedAfterVersioned;
    const addsMissingData =
      (!!snapshot.transcript && !current.transcript) ||
      (!!snapshot.summary && !current.summary) ||
      (!!snapshot.successEvaluation && !current.success_evaluation) ||
      (!!snapshot.recordingUrl && !current.recording_url) ||
      (!!snapshot.endedReason && !current.ended_reason) ||
      (snapshot.durationSeconds !== undefined && current.duration_seconds === null) ||
      (snapshot.cost !== undefined && current.cost === null) ||
      (snapshot.endedAt !== undefined && current.ended_at === null) ||
      (snapshot.startedAt !== undefined && current.started_at === null);
    if (staleProviderSnapshot && !addsMissingData && !closesAwaitingReport &&
        !acceptedTerminalRecovery && !sameVersionLiveRecovery) return current;

    // An older event may fill a field that was genuinely absent, but it may
    // never replace newer state/artifacts. This keeps a delayed end report
    // useful without allowing it to roll the transcript back.
    const effectiveStartedAt = restrictArtifactOverwrite && current.started_at !== null ? undefined : snapshot.startedAt;
    const effectiveEndedAt = restrictArtifactOverwrite && current.ended_at !== null ? undefined : snapshot.endedAt;
    const effectiveEndedReason = restrictArtifactOverwrite && current.ended_reason ? undefined : snapshot.endedReason;
    const effectiveDuration = restrictArtifactOverwrite && current.duration_seconds !== null ? undefined : snapshot.durationSeconds;
    const effectiveCost = restrictArtifactOverwrite && current.cost !== null ? undefined : snapshot.cost;
    const effectiveTranscript = restrictArtifactOverwrite && current.transcript ? undefined : snapshot.transcript;
    const effectiveSummary = restrictArtifactOverwrite && current.summary ? undefined : snapshot.summary;
    const effectiveSuccess = restrictArtifactOverwrite && current.success_evaluation ? undefined : snapshot.successEvaluation;
    const effectiveRecording = restrictArtifactOverwrite && current.recording_url ? undefined : snapshot.recordingUrl;

    // `outcome_unknown` means only that the POST response was ambiguous. A
    // later current provider snapshot is stronger evidence and may recover it;
    // proven ended/failed calls remain immutable.
    const recoveringFromUnknown = current.state === "outcome_unknown" &&
      (!staleProviderSnapshot || acceptedTerminalRecovery || sameVersionLiveRecovery);
    // Historical versions classified a GET 404 after an accepted launch as a
    // permanent failure. A newer authenticated terminal report is stronger
    // evidence and must be able to repair that accepted-call row. Unbound
    // pre-launch failures remain immutable.
    const recoveringAcceptedFailure = current.state === "failed" && !!current.provider_call_id &&
      acceptedTerminalRecovery;
    const terminalEnrichment = current.state === "ended" &&
      (current.notified_at !== null || current.notifying_token !== null) && (
      (!!effectiveTranscript && effectiveTranscript !== current.transcript) ||
      (!!effectiveSummary && effectiveSummary !== current.summary) ||
      (!!effectiveSuccess && effectiveSuccess !== current.success_evaluation) ||
      (!!effectiveRecording && effectiveRecording !== current.recording_url) ||
      (!!effectiveEndedReason && effectiveEndedReason !== current.ended_reason) ||
      (effectiveDuration !== undefined && effectiveDuration !== current.duration_seconds) ||
      (effectiveCost !== undefined && effectiveCost !== current.cost) ||
      (effectiveEndedAt !== undefined && effectiveEndedAt !== current.ended_at)
    );
    const recoveringTerminalState = recoveringFromUnknown || recoveringAcceptedFailure;
    const resetNotification = recoveringTerminalState || terminalEnrichment;
    const lockedTerminal = current.state === "ended" ||
      (current.state === "failed" && !recoveringAcceptedFailure);
    const nextState = (staleProviderSnapshot && !closesAwaitingReport && !recoveringTerminalState) || lockedTerminal ||
      (!recoveringFromUnknown && candidateRank < currentRank)
      ? current.state
      : candidate;
    const acceptedProviderStatus = (!staleProviderSnapshot || closesAwaitingReport || recoveringTerminalState) &&
      nextState === candidate
      ? snapshot.providerStatus
      : undefined;
    // `outcome_unknown` is user-visible/notification-terminal, but it remains
    // pollable at a deliberately slow cadence when a provider id is known.
    // A delayed older event that only fills an artifact must not accidentally
    // cancel that reconciliation schedule.
    const nextPollAt = nextState === "outcome_unknown" && (current.provider_call_id || snapshot.providerCallId)
      ? current.next_poll_at ?? now + 15 * 60_000
      : isTerminalVapiState(nextState) ? null : now + 10_000;
    const terminalCandidate = nextState === "awaiting-report" || isTerminalVapiState(nextState);
    const result = db.prepare(`
    UPDATE vapi_calls SET
      provider_call_id = COALESCE(provider_call_id, @providerCallId),
      provider_status = COALESCE(@providerStatus, provider_status),
      last_provider_event_at = CASE
        WHEN @observedAt IS NULL THEN last_provider_event_at
        ELSE MAX(COALESCE(last_provider_event_at, @observedAt), @observedAt)
      END,
      state = @state,
      updated_at = @updatedAt,
      started_at = COALESCE(@startedAt, started_at),
      ended_at = COALESCE(@endedAt, ended_at),
      terminal_observed_at = CASE
        WHEN @recoveringTerminalState = 1 AND @terminalCandidate = 1 THEN @updatedAt
        WHEN @recoveringTerminalState = 1 THEN NULL
        WHEN @terminalCandidate = 1 THEN COALESCE(terminal_observed_at, @updatedAt)
        ELSE terminal_observed_at
      END,
      ended_reason = COALESCE(@endedReason, ended_reason),
      duration_seconds = COALESCE(@durationSeconds, duration_seconds),
      cost = COALESCE(@cost, cost),
      transcript = CASE WHEN @transcript IS NULL OR @transcript = '' THEN transcript ELSE @transcript END,
      summary = COALESCE(@summary, summary),
      success_evaluation = COALESCE(@successEvaluation, success_evaluation),
      recording_url = COALESCE(@recordingUrl, recording_url),
      error = CASE
        WHEN @preserveError = 1 THEN error
        WHEN @error IS NULL THEN NULL
        ELSE @error
      END,
      last_polled_at = @updatedAt,
      next_poll_at = @nextPollAt,
      notifying_at = CASE WHEN @resetNotification = 1 THEN NULL ELSE notifying_at END,
      notifying_token = CASE WHEN @resetNotification = 1 THEN NULL ELSE notifying_token END,
      notified_at = CASE WHEN @resetNotification = 1 THEN NULL ELSE notified_at END
    WHERE local_id = @localId
      AND (provider_call_id IS NULL OR provider_call_id = @providerCallId)
  `).run({
    localId: current.local_id,
    providerCallId: snapshot.providerCallId,
    providerStatus: acceptedProviderStatus ?? null,
    observedAt: snapshot.observedAt ?? null,
    state: nextState,
    updatedAt: now,
    startedAt: effectiveStartedAt ?? null,
    endedAt: effectiveEndedAt ?? null,
    terminalCandidate: terminalCandidate ? 1 : 0,
    recoveringTerminalState: recoveringTerminalState ? 1 : 0,
    endedReason: effectiveEndedReason ?? null,
    durationSeconds: effectiveDuration ?? null,
    cost: effectiveCost ?? null,
    transcript: effectiveTranscript ?? null,
    summary: effectiveSummary ?? null,
    successEvaluation: effectiveSuccess ?? null,
    recordingUrl: effectiveRecording ?? null,
    error: snapshot.error ?? null,
    nextPollAt,
    preserveError: (staleProviderSnapshot && !recoveringTerminalState) || lockedTerminal ? 1 : 0,
    resetNotification: resetNotification ? 1 : 0,
  });
    if (result.changes !== 1) throw new Error("provider call binding changed concurrently");
    return getVapiCall(current.local_id, db);
  }).immediate();
}

export function markVapiCallFailed(
  localId: string,
  errorMessage: string,
  outcomeUnknown = false,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): VapiCallRow | null {
  const state = outcomeUnknown ? "outcome_unknown" : "failed";
  db.prepare(`
    UPDATE vapi_calls
    SET state = ?, error = ?,
        ended_at = CASE WHEN ? = 1 THEN ended_at ELSE COALESCE(ended_at, ?) END,
        terminal_observed_at = COALESCE(terminal_observed_at, ?),
        updated_at = ?,
        next_poll_at = CASE WHEN ? = 1 AND provider_call_id IS NOT NULL THEN ? ELSE NULL END
    WHERE local_id = ? AND state NOT IN ('ended','failed','outcome_unknown')
  `).run(
    state,
    errorMessage.slice(0, 1000),
    outcomeUnknown ? 1 : 0,
    now,
    now,
    now,
    outcomeUnknown ? 1 : 0,
    now + 15 * 60_000,
    localId,
  );
  return getVapiCall(localId, db);
}

export function deferVapiPoll(
  localId: string,
  errorMessage: string,
  delayMs = 30_000,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): void {
  db.prepare(`
    UPDATE vapi_calls
    SET error = ?, last_polled_at = ?, next_poll_at = ?, updated_at = ?
    WHERE local_id = ? AND state NOT IN ('ended','failed')
  `).run(errorMessage.slice(0, 1000), now, now + Math.max(1_000, delayMs), now, localId);
}

export function setVapiStatusMessage(
  localId: string,
  messageId: number,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): void {
  db.prepare("UPDATE vapi_calls SET status_message_id = ?, updated_at = ? WHERE local_id = ?")
    .run(messageId, now, localId);
}

export function setInitialVapiStatusMessage(
  localId: string,
  messageId: number,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): boolean {
  const result = db.prepare(`
    UPDATE vapi_calls SET status_message_id = ?, updated_at = ?
    WHERE local_id = ? AND status_message_id IS NULL
      AND notified_at IS NULL AND notifying_token IS NULL
  `).run(messageId, now, localId);
  return result.changes === 1;
}

export function setVapiStatusMessageForClaim(
  localId: string,
  messageId: number,
  claimToken: string,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): boolean {
  const result = db.prepare(`
    UPDATE vapi_calls SET status_message_id = ?, updated_at = ?
    WHERE local_id = ? AND notifying_token = ?
      AND state IN ('ended','failed','outcome_unknown')
  `).run(messageId, now, localId, claimToken);
  return result.changes === 1;
}

export function listVapiCallsNeedingWork(now = Date.now(), db: DatabaseType = getVapiDb()): VapiCallRow[] {
  return db.prepare<[number, number, number, number], VapiCallRow>(`
    SELECT * FROM vapi_calls
    WHERE (
      state NOT IN ('ended','failed')
      AND provider_call_id IS NOT NULL
      AND (next_poll_at IS NULL OR next_poll_at <= ?)
    ) OR (
      state IN ('ended','failed','outcome_unknown')
      AND notified_at IS NULL
      AND (notify_after IS NULL OR notify_after <= ?)
      AND (notifying_at IS NULL OR notifying_at < ?)
      AND (
        (state = 'failed' AND provider_call_id IS NULL)
        OR direction = 'inbound'
        OR status_message_id IS NOT NULL
        OR created_at <= ?
      )
    )
    ORDER BY created_at ASC
  `).all(now, now, now - 15 * 60_000, now - 30_000);
}

export function listStaleUnboundVapiCalls(
  now = Date.now(),
  maxAgeMs = 120_000,
  db: DatabaseType = getVapiDb(),
): VapiCallRow[] {
  return db.prepare<[number], VapiCallRow>(`
    SELECT * FROM vapi_calls
    WHERE provider_call_id IS NULL
      AND state NOT IN ('ended','failed')
      AND created_at <= ?
    ORDER BY created_at ASC
  `).all(now - Math.max(30_000, maxAgeMs));
}

export function claimVapiNotification(
  localId: string,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
  claimToken = randomBytes(16).toString("hex"),
): string | null {
  const result = db.prepare(`
    UPDATE vapi_calls SET notifying_at = ?, notifying_token = ?, notify_after = NULL, updated_at = ?
    WHERE local_id = ? AND state IN ('ended','failed','outcome_unknown')
      AND notified_at IS NULL
      AND (notify_after IS NULL OR notify_after <= ?)
      AND (notifying_at IS NULL OR notifying_at < ?)
  `).run(now, claimToken, now, localId, now, now - 15 * 60_000);
  return result.changes === 1 ? claimToken : null;
}

export function completeVapiNotification(
  localId: string,
  claimToken: string,
  success: boolean,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): boolean {
  if (success) {
    const result = db.prepare(`
      UPDATE vapi_calls
      SET notified_at = ?, notifying_at = NULL, notifying_token = NULL, notify_after = NULL, updated_at = ?
      WHERE local_id = ? AND notifying_token = ?
        AND state IN ('ended','failed','outcome_unknown')
    `).run(now, now, localId, claimToken);
    return result.changes === 1;
  } else {
    const result = db.prepare(`
      UPDATE vapi_calls SET notifying_at = NULL, notifying_token = NULL, notify_after = NULL, updated_at = ?
      WHERE local_id = ? AND notifying_token = ?
    `).run(now, localId, claimToken);
    return result.changes === 1;
  }
}

export function deferVapiNotification(
  localId: string,
  claimToken: string,
  delayMs: number,
  now = Date.now(),
  db: DatabaseType = getVapiDb(),
): boolean {
  const notifyAfter = now + Math.min(60 * 60_000, Math.max(1_000, delayMs));
  const result = db.prepare(`
    UPDATE vapi_calls
    SET notifying_at = NULL, notifying_token = NULL, notify_after = ?, updated_at = ?
    WHERE local_id = ? AND (notifying_token = ? OR notifying_token IS NULL)
      AND state IN ('ended','failed','outcome_unknown') AND notified_at IS NULL
  `).run(notifyAfter, now, localId, claimToken);
  return result.changes === 1;
}

export function recordVapiEvent(event: VapiEventRecord, db: DatabaseType = getVapiDb()): boolean {
  const result = db.prepare(`
    INSERT OR IGNORE INTO vapi_events (
      event_key, provider_call_id, local_id, type, provider_timestamp,
      payload_json, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventKey,
    event.providerCallId,
    event.localId ?? null,
    event.type,
    event.providerTimestamp ?? null,
    event.payloadJson,
    Date.now(),
  );
  return result.changes === 1;
}

export function markVapiEventProcessed(eventKey: string, db: DatabaseType = getVapiDb()): void {
  db.prepare("UPDATE vapi_events SET processed_at = ? WHERE event_key = ?").run(Date.now(), eventKey);
}
