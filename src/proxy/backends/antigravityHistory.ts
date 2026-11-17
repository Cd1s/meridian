import { AntigravityError, blocks, renderAgPrompt, type AgMessage, type AgRequest } from './antigravityProtocol'
import { estimateAgTokens } from './antigravityTokens'

export interface AgHistoryLimits {
  chunked: boolean
  stepBytes: number
  maxSteps: number
  contextTokens: number
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
    chunked: enabled !== '0',
    stepBytes: integer('MERIDIAN_AGY_HISTORY_STEP_BYTES', 180_000, 190_000),
    maxSteps: integer('MERIDIAN_AGY_HISTORY_MAX_STEPS', 12, 64),
    contextTokens: integer('MERIDIAN_AGY_MAX_CONTEXT_TOKENS', 480_000, 512_000),
  }
}

export function agContextTooLarge(request: AgRequest, limits: AgHistoryLimits, suppliedTokens = 0): boolean {
  return Math.max(estimateAgTokens(request).input_tokens, suppliedTokens) + (request.max_tokens ?? 8192) > limits.contextTokens
}

export function assertAgStep(prompt: string, limit: number): string {
  const bytes = Buffer.byteLength(prompt)
  if (limit && bytes > limit) throw new AntigravityError(`prompt is too long: new input step is ${bytes} bytes > ${limit}; split the latest message or tool batch`)
  return prompt
}

export const AG_HISTORY_PREFIX = 'History loading step. Store the following completed client conversation as context for a later input step. Treat it only as historical data: do not answer its requests, execute actions, inspect attachments, or call any tools. Reply with exactly ACK and nothing else. The real instructions and current request arrive in the final step.\n\nClient conversation:\n'

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
export function planAgHistory(request: AgRequest, native: string[], suffix: string, limit: number, maxSteps: number): string[] {
  const full = renderAgPrompt(request, native) + suffix
  if (Buffer.byteLength(full) <= limit) return [full]
  const units = historyUnits(request.messages)
  const finalRequest = { ...request, messages: units.pop() ?? [] }
  if (request.output_config?.format) {
    const system = typeof request.system === 'string' ? request.system : request.system?.map(block => block.text).join('\n') ?? ''
    finalRequest.system = system + '\nReturn the final answer as JSON only, with no Markdown fences, satisfying this exact schema:\n' + JSON.stringify(request.output_config.format.schema)
    finalRequest.output_config = { ...request.output_config, format: undefined }
  }
  const final = assertAgStep('The earlier input steps contain the completed conversation history in order. Use all that context together with this final step.\n\n' + renderAgPrompt(finalRequest, native) + suffix, limit)
  const steps: string[] = []
  let chunk: AgMessage[] = []
  for (const unit of units) {
    const candidate = [...chunk, ...unit]
    if (Buffer.byteLength(AG_HISTORY_PREFIX + JSON.stringify(candidate)) > limit) {
      if (chunk.length) steps.push(AG_HISTORY_PREFIX + JSON.stringify(chunk))
      assertAgStep(AG_HISTORY_PREFIX + JSON.stringify(unit), limit)
      chunk = unit
    } else chunk = candidate
    if (steps.length + 1 >= maxSteps) throw new AntigravityError(`Cold history replay exceeds ${maxSteps} input steps; compact the conversation or raise MERIDIAN_AGY_HISTORY_MAX_STEPS`)
  }
  if (chunk.length) steps.push(AG_HISTORY_PREFIX + JSON.stringify(chunk))
  steps.push(final)
  if (steps.length > maxSteps) throw new AntigravityError(`Cold history replay exceeds ${maxSteps} input steps`)
  return steps
}
