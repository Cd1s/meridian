import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"

// One structured stdout line per inference request so journald can answer "which request returned 409/502"
// without Sub2API inference. Never log bodies, tool arguments, keys or account identifiers.
export interface AgRequestLogFields { requestId: string; status: number; durationMs: number; model: string; stream: boolean; continuation?: string; isToolResultContinuation: boolean; inputTokens: number; outputTokens: number; error?: string }
const scope = new AsyncLocalStorage<{ logged: boolean }>()
export const agRequestLogEnabled = () => process.env.MERIDIAN_AGY_REQUEST_LOG !== "0"
export const agAccountHash = (env?: Record<string, string>) => createHash("sha256").update(env?.HOME ?? "default").digest("hex").slice(0, 8)
export function agLogRequest(fields: AgRequestLogFields, accountHash: string): void {
  const state = scope.getStore()
  if (state) state.logged = true
  if (!agRequestLogEnabled()) return
  // Only the run's continuation tag marks a replay; "tool-result" is the normal live-process path.
  const recovered = fields.isToolResultContinuation && fields.continuation !== "tool-result"
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: "agy_request", requestId: fields.requestId, status: fields.status, durationMs: fields.durationMs, model: fields.model, stream: fields.stream, continuation: fields.continuation ?? "", isToolResultContinuation: fields.isToolResultContinuation, recovered, inputTokens: fields.inputTokens, outputTokens: fields.outputTokens, error: fields.error?.slice(0, 200), accountHash }))
}
/** Wrap one inference request; failures that never reached a run (400/409/503 before metrics) still get a line. */
export async function agLoggedRequest(request: Request, accountHash: string, handle: () => Promise<Response>): Promise<Response> {
  const state = { logged: false }, started = Date.now()
  const body = agRequestLogEnabled() ? request.clone() : undefined
  const early = async (status: number, error: string) => {
    if (state.logged || !body) return
    const parsed = await body.json().then((value: unknown) => Object(value) as { model?: unknown; stream?: unknown; messages?: unknown }, () => ({} as { model?: unknown; stream?: unknown; messages?: unknown }))
    const last = Array.isArray(parsed.messages) ? Object(parsed.messages.at(-1)) as { content?: unknown } : {}
    agLogRequest({ requestId: "", status, durationMs: Date.now() - started, model: typeof parsed.model === "string" ? parsed.model : "", stream: parsed.stream === true, isToolResultContinuation: Array.isArray(last.content) && last.content.some(block => Object(block).type === "tool_result"), inputTokens: 0, outputTokens: 0, error }, accountHash)
  }
  try {
    const response = await scope.run(state, handle)
    if (response.status >= 400) await early(response.status, await response.clone().json().then((value: unknown) => String(Object(Object(value).error).message ?? ""), () => ""))
    return response
  } catch (error) {
    await early(Number(Object(error).status) || 503, error instanceof Error ? error.message : String(error))
    throw error
  }
}
