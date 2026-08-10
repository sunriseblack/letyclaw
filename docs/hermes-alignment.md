# Hermes alignment review

Reviewed on 2026-08-08 against Nous Research's upstream
[`hermes-agent`](https://github.com/NousResearch/hermes-agent) at commit
[`b9aa9289a8083f2e9d248ad6837b2938f5ee92d7`](https://github.com/NousResearch/hermes-agent/tree/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7)
(package version `0.20.0`). This pin matters: Hermes moves quickly, so claims in
this document are about that source snapshot rather than an unversioned README.

The goal was not to turn letyclaw into Hermes. The goal was to port the strongest
harness patterns that fit letyclaw's actual product: one user, Telegram topics,
Claude CLI subscription inference, strict outbound approval, private domain
boundaries, and signal-only autonomous delivery.

## Decision summary

| Hermes advantage | Decision in letyclaw | Why |
|---|---|---|
| Progressive skill disclosure | Adopted | Full workflows no longer consume every turn or get silently truncated. |
| Searchable durable session history | Adopted | SQLite FTS discovery plus anchored context is materially better than rescanning seven-day JSONL files. |
| Context economy and explicit lineage | Adopted in the layer letyclaw owns | Only the routed domain is appended; shared identity remains stable; each run/session is traceable. |
| Bounded, isolated delegation | Adopted for leaf workers | Children inherit the parent's deny policy, cannot nest, and have bounded concurrency, runtime, and output. |
| Usage/cache telemetry | Adopted | Claude CLI token and cache fields are now retained as operational metrics without retaining reasoning. |
| Durable todo state | Already equivalent | Letyclaw's open-loops ledger is persistent, injected compactly, deduplicated, and connected to TickTick. |
| Provider-neutral inference loop | Not adopted | Claude CLI and subscription auth are intentional letyclaw constraints, not accidental coupling. |
| Pluggable context compression | Not adopted | Claude CLI owns session history and compaction; a second competing transcript would create divergence. |
| Generic `execute_code` tool RPC | Deferred | Letyclaw first needs one central risk registry; a generic dispatcher could bypass send, billable, and browser-RCE gates. |
| Deferred ToolSearch | Benchmark later | It previously added several turns of latency. The current eager mode is an explicit latency-over-token trade-off. |
| Explicit in-flight interrupt | Deferred | Add only after one cancellation registry can cover user, cron, and leaf-worker runs without orphaning side effects. |
| Multi-platform gateway/Desktop UI | Not adopted | Telegram-only and single-user are deliberate scope and security boundaries. |
| Background learning notifications | Not adopted | They conflict with letyclaw's signal-only policy; memory maintenance remains silent. |

## What Hermes does better

### 1. Progressive disclosure

Hermes exposes skill metadata first and loads the complete `SKILL.md` only when
the task matches, with focused references available afterward. See the upstream
[skills guide](https://github.com/NousResearch/hermes-agent/blob/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7/website/docs/user-guide/features/skills.md).

Before this alignment, letyclaw injected configured skill bodies into every turn,
cut each file at 4,000 characters, and cut the combined block at 12,000. A
large, site-specific workflow therefore cost tokens on unrelated
requests while losing its second half when it was actually needed.

Letyclaw now:

- injects only skill name and trigger description;
- exposes `skills_list` and `skill_view` for complete, on-demand reads;
- restricts reads to skills enabled for the current run;
- rejects traversal and symlink escape;
- fails visibly on oversized files instead of silently truncating them;
- deploys and tests canonical `.claude/skills/<name>/SKILL.md` packages.

### 2. Searchable session evidence

Hermes stores sessions in SQLite/FTS5 and offers discovery, browsing, and
anchored scrolling over actual conversation records. See its
[`session_search` implementation](https://github.com/NousResearch/hermes-agent/blob/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7/tools/session_search_tool.py)
and [session guide](https://github.com/NousResearch/hermes-agent/blob/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7/website/docs/user-guide/sessions.md).

Letyclaw's former `session_search` opened every JSONL file and searched raw lines.
It had no conversation grouping, stable anchor, or bounded surrounding context.

Letyclaw's recall index is deliberately derived evidence, not a second memory
system:

- JSONL is appended first and remains the short-lived audit source;
- SQLite uses WAL, FTS5, stable event/run/conversation IDs, and idempotent
  backfill;
- search never accepts caller-supplied raw FTS syntax;
- `sessions_browse` groups runs by conversation;
- `session_context` returns chronological context around a search anchor;
- tool payloads/results are never copied into durable recall;
- common credentials in user-visible text are scrubbed;
- historical text is labeled as quoted data, not executable instruction;
- curated Markdown memory remains separate and authoritative.

### 3. Bounded delegation

Hermes delegates into isolated child contexts with a depth and concurrency cap
and blocks recursive/deceptive side-effect paths. See
[`delegate_tool.py`](https://github.com/NousResearch/hermes-agent/blob/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7/tools/delegate_tool.py).

Letyclaw's former detached session tools spawned an unbounded Claude process with a
duplicated static deny list, in-memory-only status, unbounded output buffers,
and no process-group cleanup. They could also select a path-like `agent_id` and
did not inherit a scoped cron/agent policy.

Letyclaw now treats these as bounded leaf workers:

- same-domain workspace only;
- depth one and at most three concurrent children across both asynchronous
  spawns and synchronous session continuations;
- parent deny policy inherited and strengthened for the leaf;
- Claude built-ins restricted to read/search/web tools under `dontAsk`; every
  unapproved MCP, connector, plugin, write, or shell call is denied;
- nested sessions, direct messaging, memory mutation, cron mutation/run,
  external task mutation, and paid calls blocked;
- domain and progressive-skill system context preserved;
- prompt, model, turns, runtime, stdout, and stderr bounded;
- process-group termination on timeout/yield/parent exit;
- atomic, capped status/result records under `sessions/.subagents`, including
  owner and detached child PID/PGID/start identities;
- stale records from an identity-checked dead owner terminate their verified
  orphan process group and are marked interrupted;
- active session inspection/resume is bound to the exact routed domain/topic
  while resolving the bot's physical `letyclaw-topic-*` namespace; bounded leaf
  continuation never replaces the bot's main session pointer.

### 4. Context and operational legibility

Hermes makes compaction lineage and runtime state explicit. Its architecture
and compression contracts are documented in the upstream
[architecture](https://github.com/NousResearch/hermes-agent/blob/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7/website/docs/developer-guide/architecture.md)
and [context compression guide](https://github.com/NousResearch/hermes-agent/blob/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7/website/docs/developer-guide/context-compression-and-caching.md).

Letyclaw cannot and should not replace Claude CLI's internal context manager. It
can make its own layer legible:

- root `CLAUDE.md` contains stable shared identity/safety/tool rules only;
- exactly one reviewed routed domain file is appended as trusted system
  context; the generated public catalog is deployed to a read-only vault
  mirror, while a complete advanced `agents/source` catalog remains the
  repository-authoritative option;
- vault instruction and skill mirrors are mounted read-only inside the bot
  service;
- missing domain instructions fail closed;
- stream events record the actual Claude model/version, tool inventory,
  duration, turns, cost, input/output tokens, and cache create/read tokens;
- no assistant reasoning or hidden chain-of-thought is retained.

Routed context keeps unrelated private domain instructions out of the active
system context and makes prompt size depend on the active topic rather than the
number of configured topics.

### 5. Durable writes

Hermes's broader lesson is that agent state needs explicit ownership and
durability boundaries. Letyclaw already had atomic session JSON; curated Markdown
memory did not. `memory_save` now serializes writers per daily file, writes via
a unique temporary file plus atomic rename, and keeps a last-known-good backup.
Search indexing runs after the committed write and remains best-effort.

## Deliberate non-ports

### Provider loop and compaction

Replacing Claude CLI with Hermes's provider-neutral loop would lose letyclaw's
subscription/auth/hosted-connector path and duplicate a mature session store.
Likewise, importing Hermes's context compressor would create two owners for the
same conversation. Letyclaw instead adds a derived recall index and leaves prompt
history/compaction to Claude CLI.

### Generic code-to-tool RPC

Hermes's [`execute_code`](https://github.com/NousResearch/hermes-agent/blob/b9aa9289a8083f2e9d248ad6837b2938f5ee92d7/tools/code_execution_tool.py)
is useful because it exposes a narrow typed RPC surface with call, time, and
output caps. Letyclaw must not copy the shape before centralizing tool risk metadata
inside the dispatcher. Its current browser evaluate/run-code tools are blocked
specifically because they can expose credentials and server state.

### Autonomous nudges

Hermes can learn and operate in the background. Letyclaw retains silent memory
maintenance but does not port proactive reminder messages. Autonomous delivery
remains classified as `signal`, `silent`, or disabled `nudge`, and service
health transitions stay journal-only.

## Invariants and verification

Any future Hermes-inspired change must preserve these letyclaw invariants:

1. Telegram gets one substantive outcome, not progress/service chatter.
2. Outbound messages, paid calls, and browser code execution stay behind their
   existing approval or hard-deny boundary.
3. A child receives the intersection of parent policy and leaf policy, never a
   broader tool surface.
4. Historical recall is explicit and quoted; it is never injected into every
   turn or treated as instructions.
5. Domain rules fail closed and do not leak into unrelated topics.
6. JSONL/SQLite/Markdown have distinct purposes and retention contracts.
7. Retry safety follows observed side effects, not optimistic model output.

The release gate is the full TypeScript build/test suite, shell/YAML validation,
exact deployed SHA, domain/skill file parity in the vault, active service checks,
and post-deploy journal inspection for errors or unsolicited outbound markers.
The bot and health webhook commit as one rollback unit. Browser/MCP deployment is
a subsequent self-contained transaction with its own snapshot, smoke test, and
rollback. A failed browser rollback must health-prove the prior gateway or stop
the bot/webhook, so neither transaction can leave a mixed healthy-looking runtime.
