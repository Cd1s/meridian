import { afterEach, describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'

// Fault-injection safety net for client-visible Antigravity failures. Cases in the
// "known-red" group document real defects; run them with MERIDIAN_RESILIENCE_STRICT=1.
const executable = fileURLToPath(new URL('./fixtures/agy-resilience-cli.cjs', import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
function fixture(options = {}) {
  const runtime = new AntigravityRuntime({ executable, reuseConversations: false, allowToolBridge: true, turnTimeoutMs: 10000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
  closing.push(server.closeBackend)
  const send = async (body: unknown, signal?: AbortSignal) => server.app.fetch(new Request('http://local/v1/messages', { method: 'POST', body: JSON.stringify(body), signal }))
  return { runtime, server, send }
}
type Block = { type: string; id?: string; text?: string }
type Reply = { stop_reason: string; content: Block[] }
const tool = { name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }
type Message = { role: string; content: unknown }
type Body = { model: string; max_tokens: number; messages: Message[]; tools: unknown[]; [key: string]: unknown }
const initial = (content: string, extra = {}): Body => ({ model: 'fixture-model', max_tokens: 100, messages: [{ role: 'user', content }], tools: [tool], ...extra })
const followup = (request: Body, reply: Reply, content = 'receipt'): Body => ({ ...request, messages: [...request.messages, { role: 'assistant', content: reply.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: reply.content.find(b => b.type === 'tool_use')!.id, content }] }] })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const sse = (text: string) => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
const describeKnownRed = process.env.MERIDIAN_RESILIENCE_STRICT ? describe : describe.skip

describe.skipIf(process.platform === 'win32')('Antigravity resilience', () => {
  it('does not time out a long tool loop whose total duration exceeds turnTimeoutMs', async () => {
    const { send, runtime } = fixture({ turnTimeoutMs: 300 })
    const request = initial('LOOP_6')
    const started = Date.now()
    let current = request, reply = await (await send(current)).json() as Reply, rounds = 0
    while (reply.stop_reason === 'tool_use') {
      rounds++
      current = followup(current, reply, 'r' + rounds)
      const response = await send(current)
      expect(response.status, await response.clone().text()).toBe(200)
      reply = await response.json() as Reply
    }
    expect(Date.now() - started).toBeGreaterThan(300)
    expect(rounds).toBe(6)
    expect(reply.content[0]!.text).toStartWith('LOOP_DONE:')
    expect(runtime.failed).toBe(0)
  })

  it('reports usage.input_tokens > 0 in streaming message_start, for plain and tool-continuation requests', async () => {
    const { send } = fixture()
    const plain = sse(await (await send({ ...initial('hello'), tools: [], stream: true })).text())
    expect(plain[0].type).toBe('message_start')
    expect(plain[0].message.usage.input_tokens).toBeGreaterThan(0)
    const request = initial('Get receipt')
    const first = await (await send(request)).json() as Reply
    const continued = sse(await (await send({ ...followup(request, first), stream: true })).text())
    expect(continued[0].message.usage.input_tokens).toBeGreaterThan(0)
  })

  it('terminates with an SSE error event or HTTP error when agy exits after a tool_result', async () => {
    const { send } = fixture({ turnTimeoutMs: 5000 })
    const request = initial('CRASH_AFTER_RESULT')
    const first = await (await send(request)).json() as Reply
    const response = await Promise.race([send({ ...followup(request, first), stream: true }), sleep(4000).then(() => 'hung' as const)])
    expect(response).not.toBe('hung')
    const final = response as Response
    const text = await Promise.race([final.text(), sleep(4000).then(() => 'hung')])
    expect(text).not.toBe('hung')
    if (final.status === 200) { expect(text).toContain('event: error'); expect(text).not.toContain('event: message_stop') }
    else expect(final.status).toBeGreaterThanOrEqual(500)
  })
})

describeKnownRed('known-red: Antigravity resilience (MERIDIAN_RESILIENCE_STRICT=1)', () => {
  it('answers a tool_result retry storm with one execution and a deterministic second result', async () => {
    const { send, runtime } = fixture()
    const request = initial('Get receipt')
    const first = await (await send(request)).json() as Reply
    const body = followup(request, first, 'STORM')
    const [a, b] = await Promise.all([send(body), send(body)])
    const texts = await Promise.all([a.text(), b.text()])
    expect([a.status, b.status], texts.join(' || ')).toEqual([200, 200])
    expect(JSON.parse(texts[0]!)).toEqual(JSON.parse(texts[1]!))
    expect(texts[0]).toContain('STORM')
    expect(runtime.completed).toBe(1)
    expect(runtime.runs.size).toBe(0)
  })

  it('recovers when the client aborts mid-stream and replays the same tool_result', async () => {
    const { send } = fixture()
    const request = initial('SLOW_ANSWER')
    const first = await (await send(request)).json() as Reply
    const body = followup(request, first, 'ABORTED')
    const abort = new AbortController()
    const pending = send({ ...body, stream: true }, abort.signal).then(async response => { await response.text() }).catch(() => undefined)
    await sleep(250); abort.abort(); await pending
    for (const attempt of [1, 2]) {
      const retry = await send(body)
      expect(retry.status, `retry ${attempt}: ${await retry.clone().text()}`).not.toBe(409)
      expect(retry.status).toBe(200)
    }
  })

  it('gives a recoverable or terminal non-409 result when replaying after a turn timeout', async () => {
    const { send } = fixture({ turnTimeoutMs: 300 })
    const request = initial('SLOW_ANSWER')
    const first = await (await send(request)).json() as Reply
    const body = followup(request, first, 'TIMEOUT')
    const timedOut = await send(body)
    expect(timedOut.status).toBe(504)
    for (const attempt of [1, 2]) {
      const retry = await send(body)
      expect(retry.status, `retry ${attempt}: ${await retry.clone().text()}`).not.toBe(409)
    }
  })

  it('accepts an unknown thinking.display value instead of returning 400', async () => {
    const { send } = fixture()
    const response = await send({ ...initial('hello'), tools: [], thinking: { type: 'adaptive', display: 'full' } })
    expect(response.status, await response.clone().text()).toBe(200)
  })
})
