import { describe, expect, it } from 'bun:test'
import { AntigravityError, renderAgPrompt, type AgRequest } from '../proxy/backends/antigravityProtocol'
import { planAgLatestContent } from '../proxy/backends/antigravityHistory'
import { estimateAgTextTokens } from '../proxy/backends/antigravityTokens'

const STEP_BYTES = 180_000
const STEP_TOKENS = 52_000

function base(latest: AgRequest['messages'][number]['content']): AgRequest {
  return {
    model: 'gemini-4-neon-high',
    messages: [
      { role: 'user', content: 'Earlier request' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: latest },
    ],
    tools: [],
    stream: true,
  }
}

function split(request: AgRequest, contextTokens = 480_000): string[] {
  const result = planAgLatestContent(request, [], '', STEP_BYTES, STEP_TOKENS, contextTokens)
  if (!result) throw new Error('expected latest content to split')
  return result
}

describe('Antigravity oversized latest request splitting', () => {
  it('splits a 300 KB latest message under byte and token limits with ordered content', () => {
    const first = 'FIRST-' + 'a'.repeat(150_000)
    const second = 'SECOND-' + 'b'.repeat(150_000)
    const parts = split(base(first + second))
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(STEP_BYTES)
      expect(estimateAgTextTokens(part)).toBeLessThanOrEqual(STEP_TOKENS)
    }
    const joined = parts.join('\n')
    expect(joined.indexOf('FIRST-')).toBeLessThan(joined.indexOf('SECOND-'))
    expect(joined).toContain('a'.repeat(1000))
    expect(joined).toContain('b'.repeat(1000))
  })

  it('splits a large tool_result without dropping its id or content order', () => {
    const result = 'RESULT-' + 'r'.repeat(250_000)
    const request = base([{ type: 'tool_result', tool_use_id: 'toolu_big', content: result }])
    request.messages[1] = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_big', name: 'read', input: {} }] }
    const parts = split(request)
    const joined = parts.join('\n')
    expect(joined).toContain('toolu_big')
    expect(joined.indexOf('RESULT-')).toBeGreaterThan(-1)
    expect(joined).toContain('r'.repeat(1000))
  })

  it('keeps mixed text and tool batches in order', () => {
    const request = base([
      { type: 'text', text: 'TEXT-START-' + 't'.repeat(110_000) },
      { type: 'tool_result', tool_use_id: 'toolu_mix', content: 'TOOL-RESULT-' + 'u'.repeat(110_000) },
      { type: 'text', text: 'TEXT-END-' + 'v'.repeat(50_000) },
    ])
    const parts = split(request)
    const joined = parts.join('\n')
    expect(joined.indexOf('TEXT-START-')).toBeLessThan(joined.indexOf('TOOL-RESULT-'))
    expect(joined.indexOf('TOOL-RESULT-')).toBeLessThan(joined.indexOf('TEXT-END-'))
  })

  it('leaves an exactly fitting request unsplit', () => {
    const request = base('exact boundary')
    const full = renderAgPrompt(request)
    expect(planAgLatestContent(request, [], '', Buffer.byteLength(full), estimateAgTextTokens(full), 480_000)).toBeUndefined()
  })

  it('preserves dense Unicode and never emits a replacement character', () => {
    const content = '中文🙂'.repeat(40_000)
    const parts = split(base(content))
    expect(parts.join('')).not.toContain('�')
    expect(parts.join('')).toContain('中文🙂')
  })

  it('keeps the existing context-budget error when all parts exceed the model budget', () => {
    expect(() => split(base('x'.repeat(300_000)), 1_000).toString()).toThrow()
    try {
      split(base('x'.repeat(300_000)), 1_000)
    } catch (error) {
      expect(error).toBeInstanceOf(AntigravityError)
      expect(String(error)).toContain('context budget')
    }
  })

  it('produces deterministic chunks for retries', () => {
    const request = base('retry-' + 'z'.repeat(300_000))
    expect(split(request)).toEqual(split(structuredClone(request)))
  })
})
