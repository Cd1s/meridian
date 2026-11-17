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
  fallback. The authorized current-turn final-text recovery below is the only
  exception to the default prohibition on reading private CLI transcripts.
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
  the raw full history authoritative for warm reuse and using a
  lazy, prefix-verified, bounded (512-entry, 30-minute TTL) in-memory LRU cut
  cache with no durable persistence; when whole-turn trimming runs, it aims
  below the hard limit (`AG_TRIM_TARGET_RATIO`, default 75%) so the cached cut
  only advances when subsequent growth crosses the hard limit again.

The full runtime, replay, recovery and persistence contract is in
[`architecture`](../../../ARCHITECTURE.md) → *Antigravity runtime and combined
provider service*; public routes and headers are in
[`api-contract`](../../../.agents/references/api-contract.md); feature status in
`docs/antigravity-support.md`.

## Outbound wording and tool names

Generated instructions, omission notices and attachment notes use neutral
wording. The agy-facing MCP server is `client`, its batch tool is
`workspace_parallel` (prefixed to avoid a caller tool-name collision), and result
envelopes use `client_result` and `client_followup`. The MCP initialization name
and hook policy reasons follow the same convention. These names are updated
together in the producer and consumer; public HTTP headers and internal
configuration keys keep their existing names. Caller messages and tool content
remain lossless, including caller-supplied product names. Login state and
workspace filesystem layout are independent operational decisions and are not
relocated by this change. Only native-session snapshot keys include the tool
protocol generation, so a completed native conversation saved with the old MCP
names is not resumed under the renamed catalog. Execution contracts, saved
responses and their retry identities keep the original namespace. Historical
user content is replayed into a fresh process rather than rewriting stored
conversation data.

## Client tool allowance

The native conversation's client-tool count and MCP request replay ledger are
bounded by `MERIDIAN_AGY_MAX_TOOL_CALLS` (default 256, integer 1–65536, captured at
runtime construction). An operator may raise this limit for long agent tasks;
invalid explicit settings fail startup. This is a Meridian bridge limit, separate
from agy's model-generator invocation limit. Single and parallel calls use the
same allowance; a batch exceeding it is rejected before any call is dispatched.
Duplicate MCP requests replay their original result without spending another
call. The independent 32-outstanding-tool bound and 16-call batch bound remain.

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

- **Platform verification.** Authenticated acceptance exists only on macOS
  arm64 (agy 1.2.7, Pi 0.72.1, OpenCode V1 1.18.31); Linux and Windows remain
  unverified.
- **Active-task reattachment** after a restart and **automatic reconciliation of
  uncertain tool outcomes** are unfinished; an unclean restart returns 409 with
  recovery guidance instead.
- **Background jobs are not restart-resumable.**
- **CLI-exposed controls only.** No exact output-token caps, numeric thinking
  budgets (opt-in approximate mapping via `MERIDIAN_AGY_ADAPT_THINKING_BUDGETS=1`
  to the closest discovered Gemini effort variant, preferring `-high` over `-low`
  when `-medium` is absent; without numeric thinking, explicit model-level suffixes
  win over effort, and adaptation headers are emitted only when rewritten),
  sampling controls (numeric `temperature`/`top_p`/`top_k` are accepted and ignored),
  or native media APIs; documents/speech/video go through local conversion.
- Some provider-specific plugins, hosted-tool/file contracts and client versions
  still need adapters and acceptance tests.


### Combined normalization and history trimming

Tagged `[system]\n` conversation blocks are steering, not a replacement for the latest actual typed user request when locating protected prompt content. Whole-turn cuts retain that user request and its direct media, then any subsequent tagged steering crossed by the cut in conversation order. Tagged steering still in the retained tail is protected from middle text elision at the direct text-block level; adjacent historical tool results and arguments remain eligible for ordinary elision. If protected instructions and steering alone cannot fit, the request still fails the prompt limit. The tag is a text convention, not an authority or security boundary; matching client-supplied text receives the same retention treatment. This applies to both freshly selected and cached cuts, without changing full-history identity or the top-level execution contract.

## Long conversation input steps (fork)

`antigravityHistory.ts` separates agy's 64K-token user-step limit from its
512000-token conversation window. Warm user turns send only the appended user
messages; pending tools return only new results/steering through the existing
MCP envelope. The raw client history remains authoritative for identity checks.
`MERIDIAN_AGY_MAX_PROMPT_BYTES` (190000 by default) bounds the new warm step,
including combined result batches; oversize new content returns an explicit 400.

Cold history is loaded sequentially when `MERIDIAN_AGY_CHUNKED_HISTORY=1`
(experimental opt-in; default `0` uses one trimmed prompt). The whole plan is
validated before spawning. Each historical step requests only ACK; execution of
all client/native tools and attachment reads is denied until the final step.
The MCP catalog stays stable because CLI clients may cache it. ACK text never
reaches the HTTP client. Priming usage is counted in exchange telemetry, while
the HTTP response reports only the final model phase so internal repeated
context inputs cannot falsely exhaust the coding client's context meter. Only the final step
contains the real system/tool instructions and latest user message or complete
assistant/result batch. Historical steps preserve order and complete tool pairs;
an indivisible message/pair exceeding the step budget is rejected with 400
rather than silently omitted. `MERIDIAN_AGY_HISTORY_STEP_BYTES` defaults to
180000 (1–190000, additionally bounded by the prompt byte limit).
`MERIDIAN_AGY_MAX_STEP_TOKENS` defaults to 52000 (1–63000), leaving margin
below the measured 64000-token input-step ceiling. Both budgets apply to warm
user deltas, prepared MCP result batches, restored deltas, cold ACK/final steps,
and context-cap trimming. The planner packs against both exact additive scores
before spawning, and every emitted step is checked. An indivisible dense input
that fits bytes but exceeds tokens returns explicit 400.
`MERIDIAN_AGY_HISTORY_MAX_STEPS` defaults to 12 (1–64), including the final step;
exceeding it fails before any model call. Failures, cancellation and deadlines
abort the entire replay; final-only runs close stdin only after the final step.

`MERIDIAN_AGY_MAX_CONTEXT_TOKENS` defaults to 480000 (1–512000). The existing
conservative text estimate plus image allowance reserves requested output (8192 if unset),
with a live supplied-input/output ledger and provider-reported input usage as
additional lower bounds. This is an estimate, not an exact tokenizer or a
measurement of hidden CLI context. Crossing it retires the warm process and
uses existing middle trimming (whole-turn dropping still requires
`MERIDIAN_AGY_TRIM_OLDEST_TURNS=1`) in a fresh process. A compacted run checks
only its actual supplied ledger plus the new attachment-aware delta for future
warm turns; retaining the authoritative raw history does not force every turn
to replay. Over-cap retirement discards native snapshots. Preprocessing
and total planned step overhead are checked too. An unexpectedly larger actual
context reported during loading fails closed before sending further steps.
Native snapshots are bypassed on this compaction path.
`MERIDIAN_AGY_CHUNKED_HISTORY` controls only cold sequential loading. Warm delta,
MCP result and total-context token/byte guards remain active with either value.
Default cold loading uses existing middle omission and configured oldest-turn
trimming until the one prompt fits both 190000 bytes and 52000 estimated tokens;
the latest request and complete tool pairs are retained. Earlier facts may be lost.
A compacted cold process then continues warm from only new input. The cold
step-count cap is independent: indivisible-unit waste can cause a count failure
below the context-token cap; it still returns 400 rather than silently trimming.

For chunked structured output, the CLI-wide schema flag is omitted so ACKs are
not forced through the final schema/finish tool. The final prompt requests JSON
matching the exact schema; the bridge buffers the final response segment (discarding pre-tool narration),
accepts one surrounding JSON code fence, parses and validates it with the
same Ajv validator before emitting the response on clean exit. Single-step
structured output retains the native schema path. agy remains pinned to 1.2.7;
neutral protocol names, client tool limits, normalization and shim fallback
remain compatible. Real provider retention and replay latency are AU canary
gates, not established by fixture tests.

### Dense-script safety correction

Text estimates take the maximum of UTF-8 bytes/4 and ASCII bytes/4 plus all
non-ASCII UTF-8 bytes. This uses a byte-fallback upper bound for CJK, kana,
hangul, emoji and other non-ASCII scripts, counting each such code point as at
least one token (usually more). ASCII-heavy requests never fall below the old
estimate. The count endpoint, planning, compaction, actual-input ledger and
context preflight use the same estimator. It deliberately compacts dense text
earlier than an exact tokenizer might require; hidden CLI context remains
unmeasured. AU's 1833452-byte dense case previously estimated 458796 tokens and
passed preflight before native token errors; it now exceeds the 480000-token
safety cap and enters explicit existing trimming before any loading call.

An intermediate history step is delivered when the official CLI emits its
terminal `result` with `status: SUCCESS`, no error and no denied actions. Visible
ACK text is advisory: missing/empty/whitespace text, reasoning-only output or a
localized acknowledgement does not invalidate normal completion. AU's dense
16×8000-Han cold replay saved ACK natively but exposed no recognized visible
ACK, so delivery must not depend on that text channel. The backend never reads
private native transcripts to confirm a chunk. Failed/denied steps, premature
exit, cancellation and deadlines still abort the replay. Only the final
answering phase requires response content; an empty final completion returns
502 instead of HTTP 200 with zero usage. Normal stop-sequence and tool
completion behavior is retained.

### Final-text delivery and authorized native recovery

Final response collection accepts ordinary `agent_response` deltas and complete
`planner_response.response` / `modified_response` snapshots in step or successful
result events. Snapshots extend or deduplicate published prefixes. A non-prefix snapshot
after publication is advisory and ignored, with a shape-only log: planner
snapshots can describe separate steps within one phase, whereas the published
delta text remains authoritative. Recognized final-text updates buffered after the
terminal result can complete the same turn. Thinking fields are never returned.

This fork's operator explicitly authorized read-only recovery when a normally
completed final answering phase exposes no visible text. `antigravityNativeRecord.ts`
opens only that conversation UUID under the existing child HOME, using SQLite
URI `mode=ro`, query-only mode and a short consistent transaction explicitly
rolled back before close (including WAL visibility). It never scans sessions,
imports history, writes database content or accesses credentials. SQLite may create empty
WAL coordination sidecars while opening a live database read-only. Recovery validates
bounded agy 1.2.7 protobuf fields against SQL status/type/metadata, trajectory,
input prompt, send timestamp, execution ID and pre-input/pre-tool-result step
watermarks. An older answer or pre-tool narration cannot satisfy a new phase.
Only the latest completed final planner response without tool calls is eligible;
reasoning and generation debug metadata are not decoded. Unsupported records
fail closed. Executor/gen debug metadata and planner stop-reason fields are not
used: clean completion is gated by the official CLI terminal SUCCESS with no
error or denied actions, and native status/error checks supplement that gate. Intermediate ACK delivery still uses normal terminal completion,
without reading native records.

Recovery waits at most 525 ms across bounded retries, joins shutdown, and honors
cancellation and failure. Recovered JSON goes through the original parse/schema
validation. Both stream and native empty means final HTTP 502. Shape-only logs
`antigravity.final_text_recovered` / `antigravity.final_text_empty` include source,
request/run/conversation identity, byte counts and bounded event field names,
never answer text, prompt, tool arguments, reasoning or credentials.
`antigravity.final_text_snapshot_ignored` records the same bounded event shapes
when a per-step snapshot cannot extend published text.

AU 6a35fe29 established a correctly saved final answer at input10/response11 on
dense warm turn25 after trimming, while the bridge returned empty-final502.
Its raw CLI event stream was not captured, so the historical missing field/order
is not established. Tests project the independently verified 1.2.7 format,
exercise alternative/late channels and a 40-turn compacted dense conversation;
actual provider delivery remains the next full AU canary gate.

### Completed-step text cursor (cross-turn isolation)

AU d187265 recovered dense warm turn10 from native input18/response19 correctly,
but turn11 returned the hash of previous response19 + newline + current21 +
newline. Its native input20/final21 were correct. The original stdout was not
captured, so the producer's exact event order/content is unproven. Retained shape
logs do establish `step_update.conversation_id`, `step_index`, and a user_input
marker. The old collector ignored these fields and admitted any agent-response
text into whichever HTTP consumer was active. Synthetic deferred old deltas and
snapshots reproduce the cross-turn leak on unchanged d187265.

`AgTextCursor` captures the native record watermark at input submission and keeps
a monotonic in-memory completed-step cursor. Recovery immediately commits its
selected response step and advances the native anchor's consumed response bound;
normal completion and history ACK completion commit observed steps too. A stale
DB observation cannot rewind that cursor. Each warm/cold input starts a new scope;
indexed/native conversations require their new user_input marker before text is
accepted. Only later indexed steps in the same conversation can supply visible
text. Delayed earlier steps are discarded before queueing, including before and
after the next marker and after final completion. Tool delivery advances past the pre-tool record/observed boundary and drops
text already queued behind the delivered tool batch. Further text while waiting
for client results cannot belong to the next phase and is discarded. MCP result
acceptance advances that boundary again without requiring a new user input. Warm reuse and the client tool contract remain intact.

After a native/indexed boundary exists, text without step ownership (including
unindexed terminal response snapshots) cannot satisfy the final answer. A normal
terminal still completes the phase, then the existing strictly current native
record recovery supplies text if necessary; native-empty remains502. Legacy
streams lacking indices and any native boundary retain ordinary text support.
No prior answer is removed by text-prefix guessing. The new
`antigravity.text_step_ignored` log is bounded to the first rejected text frame
per phase, with step/cursor/identity and shape metadata only, never text.
The cursor is Meridian memory, never a native database content mutation.

Tests assert exact unique answers for recovered→normal, two consecutive recoveries,
recovered→tool-use→tool-result, SSE, unindexed delayed text, stale result snapshots
and genuinely empty next turns. These fixtures cover plausible deferred-output
orders; full fresh AU dense multi-turn canary (at least30 turns;42 recommended)
and exact native/client hashes remain required to establish actual provider repair.

### Cold replay subscriber failures and continuously drained updates

AU8f113fe7 passed warm1MB and42dense warm turns, but16×8000Han cold history
failed with official subscriber lag in both original and full-replay attempts.
Both saved8inputs natively while stdout lagged; queue peak2lines and processing
max0.34ms showed no measured parent stall. Fresh full replay did not repair it.
The stable policy is warm long context enabled, cold chunking default0, existing
single-prompt trimming with `MERIDIAN_AGY_TRIM_OLDEST_TURNS=1` recommended.

`antigravityStream.ts` retains its bounded16MiB/8192line async FIFO, IO yields,
backpressured writes, EOF/cancel joins and queued final-tail flush. Precomputed
cold frames and async markers avoid heavy work in the stdout callback. A known
cold CID requires a bounded final native-watermark read before final submission;
text cursor/current native recovery and genuine-empty502 behavior stay active.

Only experimental chunking1 can encounter a priming subscriber failure. Its
exact terminal ERROR, safe joined audit, no emitted answer/tools or native actions,
and no browser/subagent grants may trigger ONE fresh-CID trimmed fallback.
The failed owner is joined and its snapshot discarded. Original request attachments
and policy are rematerialized. `compactContext=true` guarantees a single trimmed
input, never another chunked full replay. Earlier needles need not survive;
latest message/tool pairing and answer checks remain required. Both attempts share
the original absolute deadline and total input-step cap. Only one remaining step
is required; a second full plan need not fit. No second fallback, final-answering
failure replay, action replay or cancellation/shutdown bypass is allowed.

`antigravity.cold_replay_trim_fallback` records identity and remaining budget;
telemetry continuation is `cold-trim`. Admission stays reserved across join/create.
Both attempts' priming usage remains visible, while final HTTP usage/text reflects
only answering. Physical failed-process counters stay distinct from HTTP errors.
Drain logs remain metadata-only (queue/loop/input-flush/stdout gaps/cursor).
Mocked safe trimming and exact outputs do not prove actual provider acceptance.
Fresh AU warm400KB/800KB/1MB,30+dense warm, dense/plain cold trimmed200, normal
regressions and latency are mandatory before conditional rollout. Old head facts
are required on warm growth; their loss during cold trimming is expected.
