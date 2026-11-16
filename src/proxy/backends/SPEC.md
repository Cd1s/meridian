---
id: antigravity-backend
type: module-design
status: active
title: Antigravity backend
parent: architecture
references: [api-contract]
depends-on: [telemetry-ui]
---

## Responsibility

Serve Anthropic Messages, OpenAI Chat Completions and a documented OpenAI
Responses subset through Google's official, signed-in `agy` CLI (preview):
subprocess lifecycle, the loopback MCP tool bridge for client-owned tools,
warm-process reuse and history replay, attachments/media adaptation, bounded
saved-answer and tool-ID recovery, optional private SQLite state, read-only
account/quota probes, provider status, and explicit Pi/OpenCode client setup.

Selected by `backend: "antigravity"` (standalone) or `"combined"` (mounted at
`/antigravity/*` beside Claude, with independent admission, processes, quotas
and shutdown).

Code: `src/proxy/backends/antigravity*.ts`, `providerStatus.ts`, and
`src/proxy/antigravitySetup.ts`. (`backends/chatgpt*.ts` in the same directory
belong to [`chatgpt-backend`](../chatgpt/SPEC.md).)

## Boundary

- Chosen at the public server entrypoint **before** Claude authentication,
  sessions, plugins or background maintenance start; the client-facing
  `AgentAdapter` is not reused as a backend selector.
- **Never imports Claude `session/` or cache modules**; Claude session-cache
  ownership is untouched in combined mode. Account identities and quota
  percentages are never mixed with Claude's.
- Does not import Hono; it adapts standard `Request`/`Response`, and only
  `server.ts` binds the listener. It may use the pure OpenAI translators, `auth`,
  `buildRuntime`, `headerSettings` and shared `telemetry-ui` presentation.
- Generation runs only through the official CLI — no Google API key or model-SDK
  fallback, and private CLI transcripts are never read.
- Client tools execute with the **client's** permissions via
  `MERIDIAN_AGY_ALLOW_TOOL_BRIDGE`; native browser/subagent capabilities need a
  separate explicit operator grant.
- Client setup writes where the client itself reads: Pi's directory is resolved
  by the shared `piAgentDirectory()` (`PI_CODING_AGENT_DIR` with Pi's own `~`
  expansion), the same as `meridian setup --client pi`.
- Persistence (`statePath`) is opt-in and bounded; Antigravity plugins
  (`antigravityPlugins.ts`) are separate from Claude user plugins.
- Prompt budget trimming (`MERIDIAN_AGY_MAX_PROMPT_BYTES`) preserves the default
  400 `prompt is too long` rejection when middle omission is insufficient;
  `MERIDIAN_AGY_TRIM_OLDEST_TURNS=1` opts into dropping oldest whole turns at
  assistant boundaries before shrinking the newest round (retaining the newest
  assistant/result pair, a bounded first-user note, and the latest typed user
  instruction verbatim if crossed) for the execution prompt only, while keeping
  while keeping the raw full history authoritative for warm reuse and using a
  lazy, prefix-verified, bounded (512-entry, 30-minute TTL) in-memory LRU cut
  cache with no durable persistence; when whole-turn trimming runs, it aims
  below the hard limit (`AG_TRIM_TARGET_RATIO`, default 75%) so the cached cut
  only advances when subsequent growth crosses the hard limit again.

The full runtime, replay, recovery and persistence contract is in
[`architecture`](../../../ARCHITECTURE.md) → *Antigravity runtime and combined
provider service*; public routes and headers are in
[`api-contract`](../../../.agents/references/api-contract.md); feature status in
`docs/antigravity-support.md`.

## Turn deadlines

`turnTimeoutMs` bounds each model and preprocessing phase independently. Delivering
client tools pauses the phase clock; accepting a complete result batch starts a
new phase with the full allowance. This lets long client-tool loops continue when
each model phase is healthy, even if their combined model time exceeds one budget.
`pendingToolTimeoutMs` independently limits each client wait. `turnMaxDurationMs`
is an absolute per-turn cap including all phases and waits (default two hours),
also passed as the CLI print timeout. It is not reset on tool-result acceptance.
Successful completion clears both clocks; a warm user turn starts fresh clocks.
Timer replacement clears the prior handle first, and the phase deadline is
validated before the absolute cap so invalid phase settings name the right option.

## Completed-history recovery

This deliberately relaxes #1074's rule that a changed delivered history/batch
must keep the pending process and return 409. Production Claude Code stream loss
left complete client histories stuck behind that rule. A validated complete
history with known completed results is authoritative for the narrow joined
replay below; active or uncertain client actions retain their existing guards.

With native capabilities disabled, a complete validated tool history that changes
one idle pending owner's delivered prefix or batch retires and joins that owner
before cold replay. Model, session and execution controls must still match.
Mixed owners and active HTTP responses remain conflicts. Replay sends the supplied
results as history; it never invokes the old pending client calls.

Exact completed-result continuations interrupted by cancellation or retryable
failure (401, 408, 429, 499 or 5xx) can retry only after the failed process joins
and before another client tool was emitted. Other deterministic failures retain
the consumed-result conflict. Failure to record the recovery fingerprint logs an
error but cannot replace the original response status or Retry-After. Successful
result duplicate guards and response snapshots remain in force; native-capability work is never made replayable this way.

## Request normalization

Before strict schema validation (`antigravityProtocol.ts`), Anthropic requests
undergo bounded compatibility normalization:
- Mid-conversation and late `role: "system"` messages are rendered in-place as
  `[system]`-tagged `role: "user"` messages, preserving message order,
  top-level `system`, and `contractKey` (so late system steering can warm-reuse
  without replaying old turns). Inline placement preserves content order even
  when synthetic `[system]` blocks coalesce into the immediately following `user`
  message to keep `tool_use`/`tool_result` pairing intact.
- Historical `thinking` and `redacted_thinking` blocks are dropped; `assistant`
  messages left empty after thinking removal are dropped, and a final `user`
  message that is empty after normalization is rejected (400).
- Unknown content blocks (such as `tool_reference`, `server_tool_use`,
  `web_search_tool_result`) are rendered as descriptive text while malformed
  known blocks remain strictly rejected.
- Hosted server tools without `input_schema` (`web_search_*`, `web_fetch_*`,
  `code_execution_*`) with valid `name`/`description` are dropped along with
  `tool_choice` targeting only a dropped tool, exposed via the
  `x-meridian-dropped-tools` response header (comma-separated) and logged once
  per request; client-executed Anthropic tools (`bash_*`, `text_editor_*`,
  `computer_*`, `memory_*`) without `input_schema` and malformed tool
  definitions remain rejected (400).
- Numeric `temperature`, `top_p`, and `top_k` are accepted and ignored (not
  forwarded to `agy`).

## Known limitations

- **Platform verification.** Authenticated acceptance exists on macOS arm64
  (agy 1.2.7, Pi 0.72.1, OpenCode V1 1.18.31) and, for the core, Pi-client and
  account-settings gates, on Linux x64 (agy 1.5.5, Pi 1.5.2, 2026-11-12); the
  compatibility gate now pins agy 1.5.5, so the frozen macOS gates pinning the
  1.2.7 binary hash await a 1.5.5 re-run on that platform. Windows remains
  unverified.
- **Active-task reattachment** after a restart and **automatic reconciliation of
  uncertain tool outcomes** are unfinished; an unclean restart returns 409 with
  recovery guidance instead.
- **Background jobs are not restart-resumable.**
- **CLI-exposed controls only.** No exact output-token caps, numeric thinking
  budgets (opt-in approximate mapping to effort variants only), sampling
  controls (numeric `temperature`/`top_p`/`top_k` are accepted and ignored) or
  native media APIs; documents/speech/video go through local conversion.
  budgets (opt-in approximate mapping via `MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1`
  to the closest discovered Gemini effort variant, preferring `-high` over `-low`
  when `-medium` is absent; without numeric thinking, explicit
  `-low`/`-medium`/`-high` suffixes remain authoritative over
  `output_config.effort`, while unsuffixed explicit effort clamping/Gemini slug
  selection remains active and emits `x-meridian-effective-model` /
  `x-meridian-effective-effort` when rewritten), sampling controls or native
  media APIs; documents/speech/video go through local conversion.
- Some provider-specific plugins, hosted-tool/file contracts and client versions
  still need adapters and acceptance tests.
