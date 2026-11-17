import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { agContextTooLarge, agHistoryLimits, planAgHistory } from '../proxy/backends/antigravityHistory'
import { blocks, parseAgRequest, renderAgPrompt, type AgMessage } from '../proxy/backends/antigravityProtocol'
import { estimateAgTokens } from '../proxy/backends/antigravityTokens'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'

const executable = fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url))
const tool = { name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }
const cleanup: Array<() => Promise<void>> = []
const originalEnv = { ...process.env }
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_AGY_') || key.startsWith('AGY_FIXTURE_')) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})
function conversation(): AgMessage[] {
  const messages: AgMessage[] = [{ role: 'user', content: 'NEEDLE_HEAD_742' }]
  for (let at = 0; at < 24; at++) messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `old_${at}`, name: 'lookup', input: { key: `${at}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `old_${at}`, content: `${at}:` + '中'.repeat(10_000) }] },
  )
  messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'SKIP_TOOLS LONGCTX_NEEDLES NEEDLE_TAIL_963' })
  return messages
}
const request = (messages: AgMessage[]) => parseAgRequest({ model: 'fixture-model', max_tokens: 100, messages, tools: [tool] })
const decode = (prompt: string): AgMessage[] => JSON.parse(prompt.split('Client conversation:\n').at(-1)!)

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agy-longctx-test-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'steps.jsonl')
  process.env.AGY_FIXTURE_PROMPTS = log
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10_000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
  cleanup.unshift(server.closeBackend)
  const send = async (body: unknown) => server.app.fetch(new Request('http://local/v1/messages', { method: 'POST', body: JSON.stringify(body) }))
  const prompts = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string)
  return { runtime, send, prompts }
}

describe.skipIf(process.platform === 'win32')('Antigravity long context', () => {
  it('plans 700KB+ history losslessly, in order, with paired tools and final request last', () => {
    const body = request(conversation())
    expect(Buffer.byteLength(renderAgPrompt(body))).toBeGreaterThan(700_000)
    const steps = planAgHistory(body, [], '', 180_000, 12)
    expect(steps.length).toBeGreaterThan(4)
    expect(steps.every(step => Buffer.byteLength(step) <= 180_000)).toBe(true)
    expect(steps.flatMap(decode)).toEqual(body.messages)
    for (const step of steps) {
      const pending = new Set<string>()
      for (const message of decode(step)) for (const block of blocks(message)) {
        if (block.type === 'tool_use') pending.add(block.id)
        if (block.type === 'tool_result') expect(pending.delete(block.tool_use_id)).toBe(true)
      }
      expect(pending.size).toBe(0)
    }
    expect(steps.at(-1)).toContain('LONGCTX_NEEDLES')
    expect(steps.slice(0, -1).every(step => !step.includes('LONGCTX_NEEDLES'))).toBe(true)
  })

  it('fails before sending when the chunk cap or an indivisible unit is exceeded', () => {
    expect(() => planAgHistory(request(conversation()), [], '', 180_000, 3)).toThrow('input steps')
    const body = request([{ role: 'user', content: 'x'.repeat(200_000) }])
    expect(() => planAgHistory(body, [], '', 180_000, 12)).toThrow('new input step')
    const pair = request([{ role: 'user', content: 'read' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'big', name: 'lookup', input: { key: 'big' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'big', content: 'x'.repeat(200_000) }] }, { role: 'user', content: 'next' }])
    expect(() => planAgHistory(pair, [], '', 180_000, 12)).toThrow('new input step')
  })

  it('replays sequentially, hides acknowledgements and tools, and retains both needles', async () => {
    const { send, prompts } = await fixture()
    const body = request(conversation())
    const response = await send(body)
    expect(response.status).toBe(200)
    const result = await response.json() as { content: Array<{ type: string; text: string }>; usage: { output_tokens: number } }
    expect(result.content).toEqual([{ type: 'text', text: 'NEEDLE_HEAD_742 NEEDLE_TAIL_963' }])
    const steps = await prompts()
    expect(steps.flatMap(decode).map(message => ({ ...message, content: blocks(message) }))).toEqual(body.messages.map(message => ({ ...message, content: blocks(message) })))
    expect(result.usage.output_tokens).toBeGreaterThan(10)
  })

  it('replays structured output without imposing the schema on ACKs', async () => {
    const { send, prompts } = await fixture()
    const body = { ...request(conversation()), output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } } } }
    const response = await send(body)
    expect(response.status).toBe(200)
    const result = await response.json() as { content: Array<{ text: string }> }
    expect(JSON.parse(result.content[0]!.text)).toEqual({ answer: 'NEEDLE_HEAD_742 NEEDLE_TAIL_963' })
    expect((await prompts()).length).toBeGreaterThan(4)
  })

  it('keeps stdin open through priming when conversation reuse is disabled', async () => {
    const { send, runtime } = await fixture({ reuseConversations: false })
    const response = await send(request(conversation()))
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain('NEEDLE_HEAD_742 NEEDLE_TAIL_963')
    expect(runtime.completed).toBe(1)
  })

  it('honors the configured byte and chunk limits before starting a model process', async () => {
    process.env.MERIDIAN_AGY_HISTORY_MAX_STEPS = '2'
    const { send, runtime } = await fixture()
    const response = await send(request(conversation()))
    expect(response.status).toBe(400)
    expect(runtime.runs.size).toBe(0)
    expect(runtime.completed).toBe(0)
    expect(agHistoryLimits({ MERIDIAN_AGY_HISTORY_STEP_BYTES: '150000' }).stepBytes).toBe(150000)
  })

  it('grows a warm history past 400KB and 800KB sending only each new turn', async () => {
    const { runtime, send, prompts } = await fixture()
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS NEEDLE_HEAD_742' }]
    for (let at = 0; at < 10; at++) {
      if (at) messages.push({ role: 'user', content: 'SKIP_TOOLS LONGCTX_NEEDLES NEEDLE_TAIL_963 ' + 'x'.repeat(100_000) })
      const response = await send(request(messages))
      expect(response.status).toBe(200)
      const result = await response.json() as { content: AgMessage['content'] }
      messages.push({ role: 'assistant', content: result.content })
    }
    expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(800_000)
    expect(runtime.reused).toBe(9)
    const steps = await prompts()
    expect(steps.length).toBe(10)
    expect(steps.every(step => Buffer.byteLength(step) <= 190_000 && decode(step).length === 1)).toBe(true)
    expect(steps.at(-1)).not.toContain('NEEDLE_HEAD_742')
  })

  it('continues pending tools using only the new results despite a large history', async () => {
    const { runtime, send, prompts } = await fixture()
    const messages = conversation().slice(0, -1)
    messages.push({ role: 'user', content: 'Run lookup now' })
    const first = await send(request(messages))
    expect(first.status).toBe(200)
    const result = await first.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    expect(result.content[0]!.type).toBe('tool_use')
    const count = (await prompts()).length
    messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: result.content[0]!.id, content: 'NEW_RESULT_ONLY' }] })
    const second = await send(request(messages))
    expect(second.status).toBe(200)
    expect(JSON.stringify(await second.json())).toContain('NEW_RESULT_ONLY')
    expect((await prompts()).length).toBe(count)
    expect(runtime.runs.size).toBe(1)
  })

  it('retires warm context at the token cap and uses existing trimming', async () => {
    process.env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS = '8000'
    process.env.MERIDIAN_AGY_HISTORY_STEP_BYTES = '18000'
    const { runtime, send, prompts } = await fixture()
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS first task' }]
    for (let at = 0; at < 7; at++) {
      if (at) messages.push({ role: 'user', content: 'SKIP_TOOLS next ' + 'x'.repeat(6000) })
      const response = await send(request(messages))
      expect(response.status).toBe(200)
      const result = await response.json() as { content: AgMessage['content'] }
      messages.push({ role: 'assistant', content: result.content })
    }
    expect(runtime.reused).toBeLessThan(6)
    expect((await prompts()).some(prompt => prompt.includes('omitted'))).toBe(true)
  })

  it('rejects oversized warm delta and tool result instead of silently truncating', async () => {
    const { send } = await fixture()
    const body = request([{ role: 'user', content: 'SKIP_TOOLS first' }])
    const first = await send(body)
    const result = await first.json() as { content: AgMessage['content'] }
    const second = await send({ ...body, messages: [...body.messages, { role: 'assistant', content: result.content }, { role: 'user', content: 'x'.repeat(200_000) }] })
    expect(second.status).toBe(400)
    const toolBody = request([{ role: 'user', content: 'lookup' }])
    const toolResponse = await send(toolBody)
    const toolResult = await toolResponse.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    const oversized = await send({ ...toolBody, messages: [...toolBody.messages, { role: 'assistant', content: toolResult.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolResult.content[0]!.id, content: 'x'.repeat(200_000) }] }] })
    expect(oversized.status).toBe(400)
  })

  it('aborts failed priming without sending the final request', async () => {
    process.env.AGY_FIXTURE_HISTORY_FAILURE = '1'
    const { send, prompts } = await fixture()
    const response = await send(request(conversation()))
    expect(response.status).toBe(502)
    expect((await prompts()).length).toBe(1)
  })

  it('retains the legacy trimming path when disabled', async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = '0'
    const { send, prompts } = await fixture()
    const messages = conversation()
    messages[messages.length - 1] = { role: 'user', content: 'SKIP_TOOLS next' }
    expect((await send(request(messages))).status).toBe(200)
    const steps = await prompts()
    expect(steps.length).toBe(1)
    expect(steps[0]).toContain('omitted')
  })
})

describe('Antigravity history configuration and token safety', () => {
  it('uses bounded defaults and validates explicit flags', () => {
    expect(agHistoryLimits({})).toEqual({ chunked: true, stepBytes: 180_000, maxSteps: 12, contextTokens: 480_000 })
    expect(agHistoryLimits({ MERIDIAN_AGY_CHUNKED_HISTORY: '0' }).chunked).toBe(false)
    for (const [name, value] of [['MERIDIAN_AGY_HISTORY_STEP_BYTES', '190001'], ['MERIDIAN_AGY_HISTORY_MAX_STEPS', '0'], ['MERIDIAN_AGY_MAX_CONTEXT_TOKENS', '512001'], ['MERIDIAN_AGY_CHUNKED_HISTORY', 'yes']]) expect(() => agHistoryLimits({ [name!]: value })).toThrow(name!)
  })
  it('reserves requested output tokens, including at the boundary', () => {
    const body = request(conversation())
    const size = estimateAgTokens(body).input_tokens + body.max_tokens!
    const limits = { ...agHistoryLimits({}), contextTokens: size }
    expect(agContextTooLarge(body, limits)).toBe(false)
    expect(agContextTooLarge(body, { ...limits, contextTokens: size - 1 })).toBe(true)
    expect(agContextTooLarge(body, limits, size)).toBe(true)
  })
})
