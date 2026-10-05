import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'

const executable = fileURLToPath(new URL('./fixtures/agy-resilience-cli.cjs', import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close(); delete process.env.MERIDIAN_AGY_REQUEST_LOG })
const tool = { name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }
const SECRET = 'sk-SECRET-BODY-MARKER'
function fixture(options = {}) {
  const runtime = new AntigravityRuntime({ executable, reuseConversations: false, allowToolBridge: true, turnTimeoutMs: 10000, env: { HOME: '/accounts/someone@example.com' }, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
  closing.push(server.closeBackend)
  const send = (body: unknown, path = '/v1/messages') => server.app.fetch(new Request('http://local' + path, { method: 'POST', body: JSON.stringify(body) }))
  return { send, server }
}
const initial = (content: string, extra = {}) => ({ model: 'fixture-model', max_tokens: 100, messages: [{ role: 'user', content }], tools: [tool], ...extra })
const followup = (request: ReturnType<typeof initial>, reply: { content: unknown[] }, content: string) => ({ ...request, messages: [...request.messages, { role: 'assistant', content: reply.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: (reply.content.find(b => Object(b).type === 'tool_use') as { id: string }).id, content }] }] })
function capture() {
  const spy = spyOn(console, 'log').mockImplementation(() => {})
  const lines = () => spy.mock.calls.map(call => String(call[0])).filter(line => line.includes('"agy_request"')).map(line => JSON.parse(line) as Record<string, unknown>)
  return { lines, raw: () => spy.mock.calls.map(call => String(call[0])).join('\n'), restore: () => spy.mockRestore() }
}

describe.skipIf(process.platform === 'win32')('Antigravity request log', () => {
  it('logs one structured line for a success and one for a 504, without bodies or identifiers', async () => {
    const log = capture()
    try {
      const { send } = fixture({ turnTimeoutMs: 300 })
      const request = initial('SLOW_ANSWER ' + SECRET)
      const ok = await send(request)
      expect(ok.status).toBe(200)
      const first = await ok.json() as { content: unknown[] }
      expect(log.lines()).toHaveLength(1)
      const [success] = log.lines()
      expect(success).toMatchObject({ event: 'agy_request', status: 200, model: 'fixture-model', stream: false, isToolResultContinuation: false, recovered: false })
      for (const key of ['ts', 'requestId', 'durationMs', 'continuation', 'inputTokens', 'outputTokens', 'accountHash']) expect(success).toHaveProperty(key)
      expect(success!.accountHash).toMatch(/^[0-9a-f]{8}$/)
      const timedOut = await send(followup(request, first, 'TIMEOUT ' + SECRET))
      expect(timedOut.status).toBe(504)
      const lines = log.lines()
      expect(lines).toHaveLength(2)
      expect(lines[1]).toMatchObject({ status: 504, isToolResultContinuation: true })
      expect(String(lines[1]!.error).length).toBeGreaterThan(0)
      expect(String(lines[1]!.error).length).toBeLessThanOrEqual(200)
      const raw = log.raw()
      expect(raw).not.toContain(SECRET)
      expect(raw).not.toContain('someone@example.com')
    } finally { log.restore() }
  })

  it('logs a failure that never reached a run (invalid request) once', async () => {
    const log = capture()
    try {
      const { send } = fixture()
      const response = await send({ model: 'fixture-model', messages: 'nope', stream: true })
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect(log.lines()).toHaveLength(1)
      expect(log.lines()[0]).toMatchObject({ event: 'agy_request', status: response.status, model: 'fixture-model', stream: true })
    } finally { log.restore() }
  })

  it('logs OpenAI-compatible requests and skips health/admin endpoints', async () => {
    const log = capture()
    try {
      const { send, server } = fixture()
      await server.app.fetch(new Request('http://local/health'))
      await server.app.fetch(new Request('http://local/telemetry/summary'))
      expect(log.lines()).toHaveLength(0)
      const response = await send({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] }, '/v1/chat/completions')
      expect(response.status).toBe(200)
      expect(log.lines()).toHaveLength(1)
    } finally { log.restore() }
  })

  it('MERIDIAN_AGY_REQUEST_LOG=0 disables the line', async () => {
    process.env.MERIDIAN_AGY_REQUEST_LOG = '0'
    const log = capture()
    try {
      const { send } = fixture()
      expect((await send(initial('hello'))).status).toBe(200)
      expect(log.lines()).toHaveLength(0)
    } finally { log.restore() }
  })
})
