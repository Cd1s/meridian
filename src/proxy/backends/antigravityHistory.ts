import { AntigravityError, blocks, renderAgPrompt, type AgMessage, type AgRequest } from './antigravityProtocol'
import { estimateAgTextTokens, agTextTokenWeight } from './antigravityTokens'

export interface AgHistoryLimits {
  chunked: boolean
  stepBytes: number
  stepTokens: number
  maxSteps: number
  contextTokens: number
}

/** Largest context window agy 1.5.17 reports for any served model (`agy acp` usage_update `size`). */
export const AG_MAX_CONTEXT_TOKENS = 1_048_576
export const AG_DEFAULT_CONTEXT_TOKENS = 1_000_000
export const AG_MODEL_CONTEXT_BUDGETS = [
  // agy 1.5.17 reports size 1048576 for every Gemini model in `agy acp` usage_update; about 48K is kept for output and estimate error.
  { family: 'gemini-', tokens: AG_DEFAULT_CONTEXT_TOKENS, source: 'agy 1.5.17 acp usage_update size 1048576, 48K reserve' },
  // agy 1.5.17 reports 250000 for claude-sonnet-4-6 and claude-opus-4-6-thinking.
  { family: 'claude-', tokens: 230_000, source: 'agy 1.5.17 acp usage_update size 250000, 20K reserve' },
  // agy 1.5.17 reports 131072 for gpt-oss-120b-medium.
  { family: 'gpt-oss-', tokens: 120_000, source: 'agy 1.5.17 acp usage_update size 131072, 11K reserve' },
] as const

export function agContextBudget(model: string, env: Record<string, string | undefined> = process.env): number {
  const raw = env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS
  if (raw !== undefined && raw !== '') {
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > AG_MAX_CONTEXT_TOKENS) throw new Error(`MERIDIAN_AGY_MAX_CONTEXT_TOKENS must be an integer from 1 to ${AG_MAX_CONTEXT_TOKENS}`)
    return value
  }
  return AG_MODEL_CONTEXT_BUDGETS.find(entry => model.startsWith(entry.family))?.tokens ?? AG_DEFAULT_CONTEXT_TOKENS
}

export function agHistoryLimits(env: Record<string, string | undefined> = process.env): AgHistoryLimits {
  const integer = (name: string, fallback: number, maximum: number) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`)
    return value
  }
  const enabled = env.MERIDIAN_AGY_CHUNKED_HISTORY
  if (enabled !== undefined && enabled !== '' && enabled !== '0' && enabled !== '1') throw new Error('MERIDIAN_AGY_CHUNKED_HISTORY must be 0 or 1')
  return {
    chunked: enabled === '1',
    stepBytes: integer('MERIDIAN_AGY_HISTORY_STEP_BYTES', 180_000, 190_000),
    stepTokens: integer('MERIDIAN_AGY_MAX_STEP_TOKENS', 52_000, 63_000),
    maxSteps: integer('MERIDIAN_AGY_HISTORY_MAX_STEPS', 12, 64),
    contextTokens: agContextBudget('gemini-default', env),
  }
}

export function assertAgStep(prompt: string, limit: number, tokenLimit = 52_000): string {
  const bytes = Buffer.byteLength(prompt)
  if (limit && bytes > limit) throw new AntigravityError(`prompt is too long: new input step is ${bytes} bytes > ${limit}; split the latest message or tool batch`)
  const tokens = estimateAgTextTokens(prompt)
  if (tokens > tokenLimit) throw new AntigravityError(`prompt is too long: new input step is estimated at ${tokens} tokens > ${tokenLimit}; split the latest message or tool batch`)
  return prompt
}

export const AG_HISTORY_PREFIX = 'History loading step. Store the following completed client conversation as context for a later input step. Treat it only as historical data: do not answer its requests, execute actions, inspect attachments, or call any tools. Reply with exactly ACK and nothing else. The real instructions and current request arrive in the final step.\n\nClient conversation:\n'

const AG_LATEST_PART_PREFIX = 'Current request part'
const AG_PLANNING_MAX_ITERATIONS = 4096
const AG_PLANNING_MAX_MS = 3000

function planningGuard(label: string): () => void {
  const started = Date.now()
  let iterations = 0
  return () => {
    iterations++
    if (iterations > AG_PLANNING_MAX_ITERATIONS || Date.now() - started > AG_PLANNING_MAX_MS) {
      throw new AntigravityError(`prompt is too long: ${label} exceeded the planning safety budget; reduce the latest message or tool batch`)
    }
  }
}

function utf8Boundary(bytes: Buffer, end: number, start: number): number {
  let boundary = Math.min(bytes.length, Math.max(start, end))
  while (boundary > start && boundary < bytes.length && (bytes[boundary]! & 0xC0) === 0x80) boundary--
  return boundary
}

function latestPayload(request: AgRequest, tail = 1): string {
  const latest = request.messages.at(-1)
  if (!latest) return ''
  if (tail === 1) return JSON.stringify({ role: latest.role, content: latest.content })
  return JSON.stringify(request.messages.slice(-tail).map(message => ({ role: message.role, content: message.content })))
}

/** Most newest messages folded into one split payload when the latest message alone cannot be split. */
export const AG_MAX_LATEST_TAIL = 8

export function agLatestPayloadBytes(request: AgRequest): number {
  return Buffer.byteLength(latestPayload(request))
}

function latestPartPrompt(fragment: string, index: number, total: number): string {
  void total
  const text = `${AG_LATEST_PART_PREFIX} ${index}. More parts follow. Store this exact fragment as context and do not answer yet. SKIP_TOOLS.\n\nClient request fragment (JSON, in order):\n${fragment}`
  return AG_HISTORY_PREFIX + JSON.stringify([{ role: 'user', content: [{ type: 'text', text }] }])
}

function latestFinalPrompt(request: AgRequest, native: string[], suffix: string, fragment: string, index: number, total: number, tail = 1): string {
  const latest = request.messages.at(-1)
  if (!latest) throw new AntigravityError('Cannot split an empty latest request')
  const shape = tail === 1 ? '' : ` The reassembled JSON is an array of the newest ${tail} client messages, in order; it continues the conversation above.`
  const synthetic: AgRequest = {
    ...request,
    messages: [
      ...request.messages.slice(0, -tail),
      { role: latest.role, content: [{ type: 'text', text: `${AG_LATEST_PART_PREFIX} ${index} of ${total}. This is the final part. Reassemble all earlier parts in order and respond now.${shape}\n\n${fragment}` }] },
    ],
  }
  return `The current request is split across ${total} ordered parts. This is part ${index}, the final part. Reassemble all earlier parts exactly before answering now.\n\n${renderAgPrompt(synthetic, native)}${suffix}`
}

interface PromptTemplate {
  prefix: string
  suffix: string
  bytes: number
  ascii: number
}

function asciiCount(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) <= 0x7f) count++
  return count
}

function promptTemplate(rendered: string, encodedSentinel: string): PromptTemplate {
  const at = rendered.lastIndexOf(encodedSentinel)
  if (at < 0) throw new AntigravityError('Cannot construct a deterministic latest-request prompt template')
  const prefix = rendered.slice(0, at), suffix = rendered.slice(at + encodedSentinel.length)
  return { prefix, suffix, bytes: Buffer.byteLength(prefix) + Buffer.byteLength(suffix), ascii: asciiCount(prefix) + asciiCount(suffix) }
}

function encodedFragment(fragment: string): string {
  return JSON.stringify(fragment).slice(1, -1)
}

function templatePrompt(template: PromptTemplate, fragment: string): string {
  return template.prefix + encodedFragment(fragment) + template.suffix
}

function fitsTemplate(template: PromptTemplate, fragment: string, limit: number, tokenLimit: number): boolean {
  const encoded = encodedFragment(fragment)
  const bytes = template.bytes + Buffer.byteLength(encoded)
  if (limit && bytes > limit) return false
  const ascii = template.ascii + asciiCount(encoded)
  return Math.ceil(Math.max(bytes / 4, bytes - ascii * 0.75)) <= tokenLimit
}

function fitsLatestPrompt(prompt: string, limit: number, tokenLimit: number): boolean {
  return (!limit || Buffer.byteLength(prompt) <= limit) && estimateAgTextTokens(prompt) <= tokenLimit
}

function splitUtf8Payload(payload: string, makePrompt: (fragment: string) => string, limit: number, tokenLimit: number): string[] {
  const bytes = Buffer.from(payload, 'utf8')
  const fragments: string[] = []
  const guard = planningGuard('latest-request splitting')
  // Start from the byte budget; the loop below shrinks a fragment until its token estimate also fits.
  // (Capping by tokenLimit as bytes made ASCII fragments ~3x smaller than a step allows.)
  const maxFragmentBytes = Math.max(1, (limit || Math.max(tokenLimit * 4, 4096)) - 4096)
  let start = 0
  while (start < bytes.length) {
    guard()
    let end = Math.min(bytes.length, start + maxFragmentBytes)
    end = utf8Boundary(bytes, end, start)
    if (end <= start) throw new AntigravityError('prompt is too long: one latest-request fragment exceeds the per-step input limit')
    let fragment = bytes.subarray(start, end).toString('utf8')
    for (let prompt = makePrompt(fragment); !fitsLatestPrompt(prompt, limit, tokenLimit) && end > start + 1; prompt = makePrompt(fragment)) {
      guard()
      // Jump close to the token budget in one step for dense text, then shrink by 10%.
      const tokens = estimateAgTextTokens(prompt)
      const ratio = tokens > tokenLimit ? Math.max(0.05, Math.min(0.9, (tokenLimit / tokens) * 0.97)) : 0.9
      end = utf8Boundary(bytes, start + Math.floor((end - start) * ratio), start)
      if (end <= start) break
      fragment = bytes.subarray(start, end).toString('utf8')
    }
    if (!fitsLatestPrompt(makePrompt(fragment), limit, tokenLimit)) throw new AntigravityError('prompt is too long: one latest-request fragment exceeds the per-step input limit')
    fragments.push(fragment)
    start = end
  }
  return fragments
}

const PER_STEP_LIMIT = /per-step input limit$/

/**
 * Split the latest request payload into deterministic ordered context steps.
 * The final step still carries every earlier message of `request`; when one of
 * those (typically a large parallel tool_use batch just before the results)
 * leaves no room for even an empty fragment, the newest messages are folded
 * into the split payload, up to AG_MAX_LATEST_TAIL of them.
 */
export function planAgLatestContent(
  request: AgRequest,
  native: string[],
  suffix: string,
  limit: number,
  tokenLimit: number,
  contextTokens?: number,
  force = false,
): string[] | undefined {
  try {
    return planLatestTail(request, native, suffix, limit, tokenLimit, contextTokens, force, 1)
  } catch (error) {
    const maxTail = Math.min(request.messages.length, AG_MAX_LATEST_TAIL)
    if (!(error instanceof AntigravityError) || !PER_STEP_LIMIT.test(error.message)) throw error
    if (maxTail < 2) { logLatestSplitFailure(request, native, suffix, limit, tokenLimit, contextTokens, 1, error); throw error }
    for (let tail = 2; ; tail++) {
      try {
        const steps = planLatestTail(request, native, suffix, limit, tokenLimit, contextTokens, true, tail)
        console.error(JSON.stringify({ event: 'antigravity.latest-split.folded', tail, messages: request.messages.length, steps: steps?.length }))
        return steps
      } catch (retry) {
        if (!(retry instanceof AntigravityError) || !PER_STEP_LIMIT.test(retry.message) || tail >= maxTail) {
          logLatestSplitFailure(request, native, suffix, limit, tokenLimit, contextTokens, tail, retry)
          throw retry
        }
      }
    }
  }
}

/** Sizes and roles only, never content: enough to tell which planner path and message overflowed. */
function logLatestSplitFailure(request: AgRequest, native: string[], suffix: string, limit: number, tokenLimit: number, contextTokens: number | undefined, tail: number, error: unknown): void {
  try {
    const base = renderAgPrompt({ ...request, messages: [] }, native) + suffix
    const last = request.messages.slice(-AG_MAX_LATEST_TAIL).map(message => ({
      role: message.role,
      bytes: Buffer.byteLength(JSON.stringify(message.content)),
      blocks: blocks(message).map(block => block.type),
    }))
    const caller = (new Error().stack ?? '').split('\n').slice(2, 5).map(line => line.trim().replace(/\(.*\//, '(')).join(' | ')
    console.error(JSON.stringify({
      event: 'antigravity.latest-split.failed',
      error: error instanceof Error ? error.message : String(error),
      messages: request.messages.length,
      allMessagesBytes: Buffer.byteLength(JSON.stringify(request.messages)),
      baseBytes: Buffer.byteLength(base),
      baseTokens: estimateAgTextTokens(base),
      limit, tokenLimit, contextTokens, tailTried: tail, last, caller,
    }))
  } catch { /* diagnostics must never change the outcome */ }
}

function planLatestTail(
  request: AgRequest,
  native: string[],
  suffix: string,
  limit: number,
  tokenLimit: number,
  contextTokens: number | undefined,
  force: boolean,
  tail: number,
): string[] | undefined {
  const payload = latestPayload(request, tail)
  const latest = request.messages.at(-1)
  if (!payload || !latest) return undefined
  const basePrompt = renderAgPrompt({ ...request, messages: [] }, native) + suffix
  const baseBytes = Buffer.byteLength(basePrompt)
  const baseTokens = estimateAgTextTokens(basePrompt)
  if (limit && baseBytes > limit) {
    throw new AntigravityError(`prompt is too long: base prompt is ${baseBytes} bytes > ${limit} per-step input limit; the latest request cannot be split`)
  }
  if (baseTokens > tokenLimit) {
    throw new AntigravityError(`prompt is too long: base prompt is estimated at ${baseTokens} tokens > ${tokenLimit} per-step token limit; the latest request cannot be split`)
  }
  const latestOnly = { ...request, messages: [latest] }
  if (!force && fitsLatestPrompt(renderAgPrompt(latestOnly, native) + suffix, limit, tokenLimit)) return undefined
  const conservativeTotal = 9999
  let fragments = splitUtf8Payload(payload, fragment => latestPartPrompt(fragment, 1, conservativeTotal), limit, tokenLimit)
  const guard = planningGuard('latest-request planning')
  const rebuild = (parts: string[]): string[] => {
    const total = parts.length
    const prompts: string[] = []
    for (let i = 0; i < total - 1; i++) prompts.push(latestPartPrompt(parts[i]!, i + 1, total))
    prompts.push(latestFinalPrompt(request, native, suffix, parts[total - 1]!, total, total, tail))
    return prompts
  }
  for (;;) {
    guard()
    const total = fragments.length
    const sentinel = '\u0000MERIDIAN_LATEST_FRAGMENT_SENTINEL_7f4b\u0000'
    const finalTemplate = promptTemplate(latestFinalPrompt(request, native, suffix, sentinel, total, total, tail), encodedFragment(sentinel))
    if (fitsTemplate(finalTemplate, fragments.at(-1)!, limit, tokenLimit)) {
      const prompts = rebuild(fragments)
      if (contextTokens !== undefined && prompts.reduce((sum, prompt) => sum + estimateAgTextTokens(prompt) + 32, 0) + 8192 > contextTokens) {
        throw new AntigravityError('prompt is too long: latest request exceeds the estimated context budget; compact the conversation')
      }
      return prompts
    }
    const lastBytes = Buffer.from(fragments.at(-1)!, 'utf8')
    let low = 0
    let high = lastBytes.length
    let split = -1
    const splitTotal = total + 1
    const splitTemplate = promptTemplate(latestFinalPrompt(request, native, suffix, sentinel, splitTotal, splitTotal, tail), encodedFragment(sentinel))
    while (low <= high) {
      guard()
      const candidate = utf8Boundary(lastBytes, Math.floor((low + high) / 2), 0)
      const suffixFragment = lastBytes.subarray(candidate).toString('utf8')
      if (candidate === 0) {
        low = Math.floor((low + high) / 2) + 1
        continue
      }
      if (fitsTemplate(splitTemplate, suffixFragment, limit, tokenLimit)) {
        split = candidate
        high = candidate - 1
      } else {
        low = candidate + 1
      }
    }
    if (split <= 0) throw new AntigravityError('prompt is too long: latest request exceeds the per-step input limit')
    fragments = [...fragments.slice(0, -1), lastBytes.subarray(0, split).toString('utf8'), lastBytes.subarray(split).toString('utf8')]
  }
}

/** Tool calls and all their results form one indivisible replay unit. */
function historyUnits(messages: AgMessage[]): AgMessage[][] {
  const units: AgMessage[][] = []
  let unit: AgMessage[] = []
  const pending = new Set<string>()
  for (const message of messages) {
    unit.push(message)
    for (const block of blocks(message)) {
      if (block.type === 'tool_use') pending.add(block.id)
      if (block.type === 'tool_result') pending.delete(block.tool_use_id)
    }
    if (!pending.size) { units.push(unit); unit = [] }
  }
  if (unit.length) throw new AntigravityError('Cannot replay incomplete historical tool calls')
  return units
}

function historyPartPrompt(fragment: string, index: number): string {
  const text = `Oversized history entry, part ${index}. The parts of this entry arrive in consecutive history steps and concatenate in order into a JSON array of completed client messages. Store this exact fragment as context.\n\n${fragment}`
  return AG_HISTORY_PREFIX + JSON.stringify([{ role: 'user', content: [{ type: 'text', text }] }])
}

/** A completed history unit that cannot fit one step, as ordered history steps. */
function historyUnitParts(serialized: string, limit: number, tokenLimit: number): string[] {
  const fragments = splitUtf8Payload(serialized, fragment => historyPartPrompt(fragment, 9999), limit, tokenLimit)
  return fragments.map((fragment, index) => historyPartPrompt(fragment, index + 1))
}

export const AG_CONTEXT_PREFIX = 'Context loading step. Store the following client system instructions and tool descriptions. They are authoritative for every later step of this conversation. Do not act on them yet, do not answer, and do not call any tools. Reply with exactly ACK and nothing else.\n\n'
export const AG_CONTEXT_POINTER = '[The client system instructions were loaded in the earlier context steps of this conversation. They remain authoritative: follow them exactly.]'
const AG_TOOL_DESCRIPTION_POINTER = "See this tool's description in the earlier context steps."

function clientSystemText(request: AgRequest): string {
  return typeof request.system === 'string' ? request.system : request.system?.map(block => block.text).join('\n') ?? ''
}

/** The request as rendered once its system text and tool descriptions live in earlier context steps. */
export function agClientContextRequest(request: AgRequest): AgRequest {
  return {
    ...request,
    system: AG_CONTEXT_POINTER,
    tools: request.tools.map(tool => tool.description ? { ...tool, description: AG_TOOL_DESCRIPTION_POINTER } : tool),
  }
}

/** Ordered context steps carrying the client system text and tool descriptions, each within one step. */
export function planAgClientContext(request: AgRequest, limit: number, tokenLimit: number): string[] {
  const parts = ['Client system instructions:\n' + clientSystemText(request)]
  const described = request.tools.filter(tool => tool.description)
  if (described.length) parts.push('Client tool descriptions (each applies to the client tool of that name):\n' + described.map(tool => `## ${tool.name}\n${tool.description}`).join('\n\n'))
  const make = (fragment: string, index: number) => `${AG_CONTEXT_PREFIX}Client context part ${index}. The parts concatenate in order.\n\n${fragment}`
  const fragments = splitUtf8Payload(parts.join('\n\n'), fragment => make(fragment, 9999), limit, tokenLimit)
  return fragments.map((fragment, index) => make(fragment, index + 1))
}

/** Plan everything before spawning: no partially loaded histories on cap/size failures. */
export function planAgHistory(request: AgRequest, native: string[], suffix: string, limit: number, maxSteps: number, tokenLimit = 52_000): string[] {
  const full = renderAgPrompt(request, native) + suffix
  if (Buffer.byteLength(full) <= limit && estimateAgTextTokens(full) <= tokenLimit) return [full]
  const units = historyUnits(request.messages)
  const last = units.pop() ?? []
  const hasGoal = (unit: AgMessage[]) => unit.some(message =>
    message.role === 'user' && blocks(message).some(block => block.type === 'text' && block.text.trim()),
  )
  const goalIndex = hasGoal(last) ? -1 : units.findLastIndex(hasGoal)
  // Keep the goal's entire tool batch if its instruction accompanies a tool result.
  const [goal] = goalIndex < 0 ? [] : units.splice(goalIndex, 1)
  const finalRequest = { ...request, messages: [...(goal ?? []), ...last] }
  let finalSteps: string[]
  try {
    finalSteps = [assertAgStep('The earlier input steps contain completed conversation history. Use it together with the current user goal and latest messages in this final step.\n\n' + renderAgPrompt(finalRequest, native) + suffix, limit, tokenLimit)]
  } catch (error) {
    if (!(error instanceof AntigravityError) || !error.message.startsWith('prompt is too long:')) throw error
    finalSteps = planAgLatestContent(finalRequest, native, suffix, limit, tokenLimit, undefined, agLatestPayloadBytes(finalRequest) >= 32_000) ?? (() => { throw error })()
  }
  const steps: string[] = []
  let chunk: AgMessage[] = []
  let bytes = Buffer.byteLength(AG_HISTORY_PREFIX) + 2
  let tokens = agTextTokenWeight(AG_HISTORY_PREFIX) + 0.5
  for (const unit of units) {
    const serialized = JSON.stringify(unit)
    const unitBytes = Buffer.byteLength(serialized) - 2
    const unitTokens = agTextTokenWeight(serialized) - 0.5
    if (bytes + unitBytes + (chunk.length ? 1 : 0) > limit || tokens + unitTokens + (chunk.length ? 0.25 : 0) > tokenLimit) {
      if (chunk.length) steps.push(AG_HISTORY_PREFIX + JSON.stringify(chunk))
      if (fitsLatestPrompt(AG_HISTORY_PREFIX + serialized, limit, tokenLimit)) {
        chunk = unit
        bytes = Buffer.byteLength(AG_HISTORY_PREFIX) + 2 + unitBytes
        tokens = agTextTokenWeight(AG_HISTORY_PREFIX) + 0.5 + unitTokens
      } else {
        // One tool batch (or message) larger than a step: load it as ordered fragments.
        steps.push(...historyUnitParts(serialized, limit, tokenLimit))
        chunk = []
        bytes = Buffer.byteLength(AG_HISTORY_PREFIX) + 2
        tokens = agTextTokenWeight(AG_HISTORY_PREFIX) + 0.5
      }
    } else {
      bytes += unitBytes + (chunk.length ? 1 : 0)
      tokens += unitTokens + (chunk.length ? 0.25 : 0)
      chunk.push(...unit)
    }
    if (steps.length + 1 >= maxSteps) throw new AntigravityError(`prompt is too long: cold history replay exceeds ${maxSteps} input steps; compact the conversation or raise MERIDIAN_AGY_HISTORY_MAX_STEPS`)
  }
  if (chunk.length) steps.push(AG_HISTORY_PREFIX + JSON.stringify(chunk))
  steps.push(...finalSteps)
  if (steps.length > maxSteps) throw new AntigravityError(`prompt is too long: cold history replay exceeds ${maxSteps} input steps`)
  return steps
}
