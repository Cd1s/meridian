import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { blocks, parseAgRequest, renderAgPrompt, type AgMessage } from '../proxy/backends/antigravityProtocol'
import { estimateAgTextTokens } from '../proxy/backends/antigravityTokens'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'

const saved = { ...process.env }, closing: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closing.splice(0)) await close()
  for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_AGY_') || key.startsWith('AGY_FIXTURE_')) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
const tool = { name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }
describe.skipIf(process.platform === 'win32')('Antigravity stable cold default', () => {
  for (const [name, text, flag] of [
    ['plain700KB', 'x'.repeat(48000), undefined],
    ['dense16x8000', '漢'.repeat(8000), '0'],
    ['denseEmoji', '中文🧪'.repeat(4000), undefined],
  ] as const) {
    it(`trims ${name} into one safe input and preserves latest request and tool pairs`, async () => {
      if (flag === undefined) delete process.env.MERIDIAN_AGY_CHUNKED_HISTORY
      else process.env.MERIDIAN_AGY_CHUNKED_HISTORY = flag
      process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = '1'
      const directory = await mkdtemp(join(tmpdir(), 'agy-cold-default-'))
      closing.push(() => rm(directory, { recursive: true, force: true }))
      const log = join(directory, 'prompts.jsonl')
      const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), allowToolBridge: true, turnTimeoutMs: 10000 })
      runtime.childEnv.AGY_FIXTURE_PROMPTS = log
      const app = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
      closing.unshift(app.closeBackend)
      const messages: AgMessage[] = [{ role: 'user', content: 'HEAD_OLD_HISTORY' }]
      for (let at = 0; at < 16; at++) messages.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `old_${at}`, name: 'lookup', input: { key: String(at) } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `old_${at}`, content: text }] },
      )
      messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'SKIP_TOOLS TRIM_TAIL_ONLY NEEDLE_TAIL_963' })
      const body = parseAgRequest({ model: 'fixture-model', max_tokens: 128, tools: [tool], messages })
      expect(Buffer.byteLength(renderAgPrompt(body))).toBeGreaterThan(name === 'plain700KB' ? 700000 : 190000)
      const send = () => app.app.fetch(new Request('http://local/v1/messages', { method: 'POST', body: JSON.stringify(body) }))
      const response = await send()
      expect(response.status).toBe(200)
      expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'NEEDLE_TAIL_963' }])
      const prompts = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string)
      expect(prompts).toHaveLength(1)
      expect(prompts[0]).not.toStartWith('History loading step.')
      expect(prompts[0]).toContain('omitted')
      expect(Buffer.byteLength(prompts[0]!)).toBeLessThanOrEqual(190000)
      expect(estimateAgTextTokens(prompts[0]!)).toBeLessThanOrEqual(52000)
      const delivered = JSON.parse(prompts[0]!.split('Client conversation:\n').at(-1)!) as AgMessage[]
      const pending = new Set<string>()
      for (const message of delivered) for (const block of blocks(message)) {
        if (block.type === 'tool_use') pending.add(block.id)
        if (block.type === 'tool_result') expect(pending.delete(block.tool_use_id)).toBe(true)
      }
      expect(pending.size).toBe(0)
      expect(runtime.historyLimits.chunked).toBe(false)
    })
  }
})
