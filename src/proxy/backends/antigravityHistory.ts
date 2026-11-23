import { AntigravityError, blocks, renderAgPrompt, type AgMessage, type AgRequest } from './antigravityProtocol'
import { estimateAgTextTokens, agTextTokenWeight } from './antigravityTokens'

export interface AgHistoryLimits {
  chunked: boolean
  stepBytes: number
  stepTokens: number
  maxSteps: number
  contextTokens: number
}

export const AG_DEFAULT_CONTEXT_TOKENS = 480_000
export const AG_MODEL_CONTEXT_BUDGETS = [
  // Gemini's 512K window is the verified source for the existing 480K safety budget.
  { family: 'gemini-', tokens: AG_DEFAULT_CONTEXT_TOKENS, source: 'verified 512K window, 32K safety reserve' },
  // Conservative assumptions until agy models metadata or vendor documentation confirms these windows.
  { family: 'claude-', tokens: 200_000, source: 'conservative assumption; confirm with agy model metadata or vendor documentation' },
  { family: 'gpt-oss-', tokens: 128_000, source: 'conservative assumption; confirm with agy model metadata or vendor documentation' },
] as const

export function agContextBudget(model: string, env: Record<string, string | undefined> = process.env): number {
  const raw = env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS
  if (raw !== undefined && raw !== '') {
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1 || value > 512_000) throw new Error('MERIDIAN_AGY_MAX_CONTEXT_TOKENS must be an integer from 1 to 512000')
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

function utf8Boundary(bytes: Buffer, end: number, start: number): number {
  let boundary = Math.min(bytes.length, Math.max(start, end))
  while (boundary > start && boundary < bytes.length && (bytes[boundary]! & 0xC0) === 0x80) boundary--
  return boundary
}

function latestPayload(request: AgRequest): string {
  const latest = request.messages.at(-1)
  if (!latest) return ''
  return JSON.stringify({ role: latest.role, content: latest.content })
}

function latestPartPrompt(fragment: string, index: number, total: number): string {
  const text = `${AG_LATEST_PART_PREFIX} ${index} of ${total}. More parts follow. Store this exact fragment as context and do not answer yet. SKIP_TOOLS.\n\nClient request fragment (JSON, in order):\n${fragment}`
  return AG_HISTORY_PREFIX + JSON.stringify([{ role: 'user', content: [{ type: 'text', text }] }])
}

function latestFinalPrompt(request: AgRequest, native: string[], suffix: string, fragment: string, index: number, total: number): string {
  const latest = request.messages.at(-1)
  if (!latest) throw new AntigravityError('Cannot split an empty latest request')
  const synthetic: AgRequest = {
    ...request,
    messages: [
      ...request.messages.slice(0, -1),
      { role: latest.role, content: [{ type: 'text', text: `${AG_LATEST_PART_PREFIX} ${index} of ${total}. This is the final part. Reassemble all earlier parts in order and respond now.\n\n${fragment}` }] },
    ],
  }
  return `The current request is split across ${total} ordered parts. This is part ${index}, the final part. Reassemble all earlier parts exactly before answering now.\n\n${renderAgPrompt(synthetic, native)}${suffix}`
}

function fitsLatestPrompt(prompt: string, limit: number, tokenLimit: number): boolean {
  return (!limit || Buffer.byteLength(prompt) <= limit) && estimateAgTextTokens(prompt) <= tokenLimit
}

function splitUtf8Payload(payload: string, makePrompt: (fragment: string) => string, limit: number, tokenLimit: number): string[] {
  const bytes = Buffer.from(payload, 'utf8')
  const fragments: string[] = []
  const maxFragmentBytes = Math.max(1, Math.min(limit || Number.MAX_SAFE_INTEGER, tokenLimit) - 4096)
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + maxFragmentBytes)
    end = utf8Boundary(bytes, end, start)
    if (end <= start) throw new AntigravityError('prompt is too long: one latest-request fragment exceeds the per-step input limit')
    let fragment = bytes.subarray(start, end).toString('utf8')
    while (!fitsLatestPrompt(makePrompt(fragment), limit, tokenLimit) && end > start + 1) {
      end = utf8Boundary(bytes, start + Math.floor((end - start) * 0.9), start)
      if (end <= start) break
      fragment = bytes.subarray(start, end).toString('utf8')
    }
    if (!fitsLatestPrompt(makePrompt(fragment), limit, tokenLimit)) throw new AntigravityError('prompt is too long: one latest-request fragment exceeds the per-step input limit')
    fragments.push(fragment)
    start = end
  }
  return fragments
}

/** Split only the latest request payload into deterministic ordered context steps. */
export function planAgLatestContent(
  request: AgRequest,
  native: string[],
  suffix: string,
  limit: number,
  tokenLimit: number,
  contextTokens?: number,
): string[] | undefined {
  const payload = latestPayload(request)
  const latest = request.messages.at(-1)
  if (!payload || !latest) return undefined
  const latestOnly = { ...request, messages: [latest] }
  if (fitsLatestPrompt(renderAgPrompt(latestOnly, native) + suffix, limit, tokenLimit)) return undefined
  const conservativeTotal = 9999
  let fragments = splitUtf8Payload(payload, fragment => latestPartPrompt(fragment, 1, conservativeTotal), limit, tokenLimit)
  const rebuild = (parts: string[]): string[] => {
    const total = parts.length
    const prompts: string[] = []
    for (let i = 0; i < total - 1; i++) prompts.push(latestPartPrompt(parts[i]!, i + 1, total))
    prompts.push(latestFinalPrompt(request, native, suffix, parts[total - 1]!, total, total))
    return prompts
  }
  for (;;) {
    const prompts = rebuild(fragments)
    const final = prompts.at(-1)!
    if (fitsLatestPrompt(final, limit, tokenLimit)) {
      if (contextTokens !== undefined && prompts.reduce((sum, prompt) => sum + estimateAgTextTokens(prompt) + 32, 0) + 8192 > contextTokens) {
        throw new AntigravityError('prompt is too long: latest request exceeds the estimated context budget; compact the conversation')
      }
      return prompts
    }
    const lastBytes = Buffer.from(fragments.at(-1)!, 'utf8')
    let low = 0
    let high = lastBytes.length
    let split = -1
    while (low <= high) {
      const candidate = utf8Boundary(lastBytes, Math.floor((low + high) / 2), 0)
      const suffixFragment = lastBytes.subarray(candidate).toString('utf8')
      const candidateParts = [...fragments.slice(0, -1), lastBytes.subarray(0, candidate).toString('utf8'), suffixFragment]
      if (candidate === 0) {
        low = Math.floor((low + high) / 2) + 1
        continue
      }
      if (fitsLatestPrompt(latestFinalPrompt(request, native, suffix, suffixFragment, candidateParts.length, candidateParts.length), limit, tokenLimit)) {
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
    finalSteps = planAgLatestContent(finalRequest, native, suffix, limit, tokenLimit) ?? (() => { throw error })()
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
      assertAgStep(AG_HISTORY_PREFIX + serialized, limit, tokenLimit)
      chunk = unit
      bytes = Buffer.byteLength(AG_HISTORY_PREFIX) + 2 + unitBytes
      tokens = agTextTokenWeight(AG_HISTORY_PREFIX) + 0.5 + unitTokens
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
