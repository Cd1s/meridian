import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { agContextTooLarge, agHistoryLimits, planAgHistory } from '../proxy/backends/antigravityHistory'
import { blocks, parseAgRequest, renderAgPrompt, type AgMessage } from '../proxy/backends/antigravityProtocol'
import { estimateAgTokens, estimateAgTextTokens } from '../proxy/backends/antigravityTokens'
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
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `old_${at}`, content: `${at}:` + 'x'.repeat(30_000) }] },
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
    const { send, prompts, runtime } = await fixture()
    const body = request(conversation())
    const response = await send(body)
    expect(response.status).toBe(200)
    const result = await response.json() as { content: Array<{ type: string; text: string }>; usage: { output_tokens: number } }
    expect(result.content).toEqual([{ type: 'text', text: 'NEEDLE_HEAD_742 NEEDLE_TAIL_963' }])
    const steps = await prompts()
    expect(steps.flatMap(decode).map(message => ({ ...message, content: blocks(message) }))).toEqual(body.messages.map(message => ({ ...message, content: blocks(message) })))
    expect(result.usage.output_tokens).toBe(10)
    expect(runtime.requests[0]!.inputTokens).toBe(120 + (steps.length - 1) * 100)
    expect(runtime.requests[0]!.outputTokens).toBe(10 + steps.length - 1)
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
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = '1'
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

  it('keeps compacted conversations warm on subsequent small turns', async () => {
    process.env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS = '8000'
    process.env.MERIDIAN_AGY_HISTORY_STEP_BYTES = '18000'
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = '1'
    const { send, runtime } = await fixture()
    const messages = conversation()
    messages[messages.length - 1] = { role: 'user', content: 'SKIP_TOOLS next' }
    const first = await send(request(messages))
    expect(first.status).toBe(200)
    const result = await first.json() as { content: AgMessage['content'] }
    expect([...runtime.runs.values()][0]!.compacted).toBe(true)
    messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: 'SKIP_TOOLS follow up' })
    expect((await send(request(messages))).status).toBe(200)
    expect(runtime.reused).toBe(1)
  })

  it('honors whole-turn trimming opt-in when the context cap is reached', async () => {
    delete process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS
    process.env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS = '8000'
    process.env.MERIDIAN_AGY_HISTORY_STEP_BYTES = '18000'
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS task' }]
    for (let at = 0; at < 200; at++) messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `short_${at}`, name: 'lookup', input: { key: 'k' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `short_${at}`, content: 'short result' }] },
    )
    messages.push({ role: 'user', content: 'SKIP_TOOLS next' })
    const { send } = await fixture()
    const response = await send(request(messages))
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).toContain('prompt is too long')
  })

  it('counts images as attachments for both warm turns and pending tool results', async () => {
    const png = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(2_500_000)]).toString('base64')
    const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: png } }
    const { send, runtime, prompts } = await fixture()
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS initial' }]
    const first = await send(request(messages))
    const initial = await first.json() as { content: AgMessage['content'] }
    messages.push({ role: 'assistant', content: initial.content }, { role: 'user', content: [{ type: 'text', text: 'SKIP_TOOLS screenshot' }, image] })
    expect((await send(request(messages))).status).toBe(200)
    expect(runtime.reused).toBe(1)
    const pendingMessages: AgMessage[] = [{ role: 'user', content: 'look up' }]
    const pending = await send(request(pendingMessages))
    const calls = await pending.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    const steps = (await prompts()).length
    pendingMessages.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: [{ type: 'text', text: 'screenshot result' }, image] }] })
    expect((await send(request(pendingMessages))).status).toBe(200)
    expect((await prompts()).length).toBe(steps)
  })

  it('preserves legacy large tool results and warm histories when disabled', async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = '0'
    const { send, runtime } = await fixture()
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS first' }, { role: 'assistant', content: 'x'.repeat(2_000_000) }, { role: 'user', content: 'SKIP_TOOLS next' }]
    const first = await send(request(messages))
    expect(first.status).toBe(200)
    const result = await first.json() as { content: AgMessage['content'] }
    messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: 'SKIP_TOOLS warm' })
    expect((await send(request(messages))).status).toBe(200)
    expect(runtime.reused).toBe(1)
    const tools: AgMessage[] = [{ role: 'user', content: 'lookup legacy' }]
    const pending = await send(request(tools))
    const calls = await pending.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    tools.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: 'z'.repeat(250_000) }] })
    expect((await send(request(tools))).status).toBe(200)
  })

  it('does not save a retired over-cap native snapshot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agy-longctx-state-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const { runtime, send } = await fixture({ statePath: join(directory, 'state.db') })
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS first' }]
    const first = await send(request(messages))
    const result = await first.json() as { content: AgMessage['content'] }
    const old = [...runtime.runs.values()][0]!
    old.conversationId = 'b95ea3ee-25c8-40ef-ac60-ac77d23275ed'
    old.contextTokens = 480_000
    messages.push({ role: 'assistant', content: result.content }, { role: 'user', content: 'SKIP_TOOLS next' })
    expect((await send(request(messages))).status).toBe(200)
    expect(runtime.state!.list('native-sessions')).toHaveLength(0)
  })

  it('validates fenced JSON after narration and a client tool during chunked replay', async () => {
    const { send } = await fixture()
    const messages = conversation()
    messages[messages.length - 1] = { role: 'user', content: 'STRUCTURED_PROSE FENCED_JSON lookup' }
    const body = { ...request(messages), output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } } } }
    const first = await send(body)
    expect(first.status).toBe(200)
    const calls = await first.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    messages.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: 'structured result' }] })
    const second = await send({ ...body, messages })
    expect(second.status).toBe(200)
    const result = await second.json() as { content: Array<{ text: string }> }
    expect(JSON.parse(result.content[0]!.text)).toEqual({ answer: 'structured result' })
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

  for (const [label, filler] of [
    ['Chinese', '漢'.repeat(5000)],
    ['CJK with code', '变量 = fn("中文");\n'.repeat(900)],
    ['emoji and joining characters', '😀🧪‍🚀'.repeat(1000)],
  ] as const) {
    it(`keeps dense ${label} warm steps under both budgets with head/tail recall`, async () => {
      const { runtime, send, prompts } = await fixture()
      const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS NEEDLE_HEAD_742' }]
      const first = await send(request(messages))
      const initial = await first.json() as { content: AgMessage['content'] }
      messages.push({ role: 'assistant', content: initial.content })
      for (let at = 0; at < 28; at++) {
        messages.push({ role: 'user', content: filler + ' SKIP_TOOLS LONGCTX_NEEDLES NEEDLE_TAIL_963' })
        const response = await send(request(messages))
        expect(response.status).toBe(200)
        const result = await response.json() as { content: AgMessage['content'] }
        expect(JSON.stringify(result.content)).toContain('NEEDLE_HEAD_742 NEEDLE_TAIL_963')
        messages.push({ role: 'assistant', content: result.content })
      }
      expect(Buffer.byteLength(JSON.stringify(messages))).toBeGreaterThan(400_000)
      expect(runtime.reused).toBe(28)
      for (const step of await prompts()) {
        expect(Buffer.byteLength(step)).toBeLessThanOrEqual(190_000)
        expect(estimateAgTextTokens(step)).toBeLessThanOrEqual(52_000)
      }
    })
    it(`loads dense ${label} cold history losslessly using the token budget`, async () => {
      const { send, prompts } = await fixture()
      const messages: AgMessage[] = [{ role: 'user', content: 'NEEDLE_HEAD_742' }]
      for (let at = 0; at < 20; at++) messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `dense_${at}`, name: 'lookup', input: { key: `${at}` } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `dense_${at}`, content: filler }] },
      )
      messages.push({ role: 'user', content: 'SKIP_TOOLS LONGCTX_NEEDLES NEEDLE_TAIL_963' })
      const body = request(messages)
      const plan = planAgHistory(body, [], '', 180_000, 12)
      expect(plan.length).toBeGreaterThan(2)
      expect(plan.flatMap(decode)).toEqual(body.messages)
      for (const step of plan) {
        const independent = Math.ceil([...step].reduce((sum, point) => sum + (point.codePointAt(0)! <= 127 ? 0.25 : Buffer.byteLength(point)), 0))
        expect(estimateAgTextTokens(step)).toBe(independent)
        expect(independent).toBeLessThanOrEqual(52_000)
        expect(Buffer.byteLength(step)).toBeLessThanOrEqual(180_000)
      }
      const response = await send(body)
      expect(response.status).toBe(200)
      expect(JSON.stringify(await response.json())).toContain('NEEDLE_HEAD_742 NEEDLE_TAIL_963')
      expect((await prompts()).length).toBe(plan.length)
    })
  }

  it('rejects a dense warm delta and tool result that fit bytes but exceed the token budget', async () => {
    const { send, prompts } = await fixture()
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS first' }]
    const first = await send(request(messages))
    const initial = await first.json() as { content: AgMessage['content'] }
    const count = (await prompts()).length
    messages.push({ role: 'assistant', content: initial.content }, { role: 'user', content: '漢'.repeat(20_000) })
    expect((await send(request(messages))).status).toBe(400)
    expect((await prompts()).length).toBe(count)
    const tools: AgMessage[] = [{ role: 'user', content: 'lookup dense' }]
    const pending = await send(request(tools))
    const calls = await pending.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    tools.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: '漢'.repeat(20_000) }] })
    expect((await send(request(tools))).status).toBe(400)
  })

  it('compacts the AU 1.83MB dense-history failure before any oversized step is sent', async () => {
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = '1'
    const { send, prompts, runtime } = await fixture()
    const messages: AgMessage[] = [{ role: 'user', content: 'NEEDLE_HEAD_742' }]
    for (let at = 0; at < 60; at++) messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: `au_${at}`, name: 'lookup', input: { key: `${at}` } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `au_${at}`, content: '漢'.repeat(10_000) }] },
    )
    messages.push({ role: 'user', content: 'SKIP_TOOLS LONGCTX_NEEDLES NEEDLE_TAIL_963' })
    const body = request(messages)
    expect(Math.ceil(Buffer.byteLength(renderAgPrompt(body)) / 4)).toBeLessThan(480_000)
    expect(estimateAgTokens(body).input_tokens).toBeGreaterThan(1_000_000)
    const response = await send(body)
    expect(response.status).toBe(200)
    expect(JSON.stringify(await response.json())).toContain('NEEDLE_HEAD_742 NEEDLE_TAIL_963')
    const steps = await prompts()
    expect(steps.length).toBe(1)
    expect(steps[0]).toContain('omitted')
    expect(estimateAgTextTokens(steps[0]!)).toBeLessThanOrEqual(52_000)
    expect([...runtime.runs.values()][0]!.compacted).toBe(true)
  })

  it('rejects empty native success instead of reporting HTTP 200 with zero usage', async () => {
    const { send, prompts } = await fixture()
    const empty = await send(request([{ role: 'user', content: 'SKIP_TOOLS NATIVE_EMPTY_SUCCESS' }]))
    expect(empty.status).toBe(502)
    process.env.AGY_FIXTURE_HISTORY_EMPTY = '1'
    const second = await fixture()
    const response = await second.send(request(conversation()))
    expect(response.status).toBe(502)
    expect((await second.prompts()).length).toBe(1)
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
    expect(agHistoryLimits({})).toEqual({ chunked: true, stepBytes: 180_000, stepTokens: 52_000, maxSteps: 12, contextTokens: 480_000 })
    expect(agHistoryLimits({ MERIDIAN_AGY_CHUNKED_HISTORY: '0' }).chunked).toBe(false)
    for (const [name, value] of [['MERIDIAN_AGY_HISTORY_STEP_BYTES', '190001'], ['MERIDIAN_AGY_HISTORY_MAX_STEPS', '0'], ['MERIDIAN_AGY_MAX_STEP_TOKENS', '64000'], ['MERIDIAN_AGY_MAX_CONTEXT_TOKENS', '512001'], ['MERIDIAN_AGY_CHUNKED_HISTORY', 'yes']]) expect(() => agHistoryLimits({ [name!]: value })).toThrow(name!)
  })
  it('conservatively counts CJK, kana, hangul, emoji and other dense scripts', () => {
    for (const text of ['中文漢字', 'かなカナ', '한국어', '😀🧪‍🚀', 'العربية', 'देवनागरी']) {
      expect(estimateAgTextTokens(text)).toBeGreaterThanOrEqual([...text].length)
      expect(estimateAgTextTokens(text)).toBe(Buffer.byteLength(text))
    }
    for (const text of ['plain ASCII code'.repeat(1000), 'const x = "中文";'.repeat(1000)]) expect(estimateAgTextTokens(text)).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(text) / 4))
    expect(estimateAgTextTokens('a'.repeat(1000))).toBe(250)
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
