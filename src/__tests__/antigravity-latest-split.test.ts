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

  it('reports an unsplittable base prompt with its measured limit', () => {
    const request = base('latest')
    request.system = 'S'.repeat(STEP_BYTES)
    expect(() => planAgLatestContent(request, [], '', STEP_BYTES, STEP_TOKENS, 480_000, true)).toThrow(`base prompt is`)
    expect(() => planAgLatestContent(request, [], '', STEP_BYTES, STEP_TOKENS, 480_000, true)).toThrow(`${STEP_BYTES} per-step input limit`)
  })

  it('keeps the prefix of earlier split steps stable when only the latest content grows', () => {
    const common = 'prefix-' + 'p'.repeat(220_000)
    const first = split(base(common + 'A'.repeat(10_000)))
    const larger = split(base(common + 'A'.repeat(10_000) + 'B'.repeat(150_000)))
    expect(larger[0]).toBe(first[0])
  })

  it('fails fast for tiny limits and dense Unicode inputs', () => {
    const request = base('中文🙂'.repeat(200_000))
    const started = Date.now()
    expect(() => planAgLatestContent(request, [], '', 1, 1, 480_000, true)).toThrow('prompt is too long')
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('plans production-sized shapes in under 50 ms on the build host', () => {
    const shapes: AgRequest[] = [
      base('x'.repeat(300_000)),
      base([{ type: 'tool_result', tool_use_id: 'bench', content: 'x'.repeat(250_000) }]),
      { ...base('x'.repeat(60_000)), system: 's'.repeat(100_000) },
    ]
    const started = performance.now()
    for (const request of shapes) expect(planAgLatestContent(request, [], '', 150_620, STEP_TOKENS, 480_000, true)).toBeDefined()
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('Antigravity latest split with a large preceding message', () => {
  // Live tool continuation delta: the assistant's parallel tool_use batch, then its results.
  function delta(inputBytes: number, resultBytes: number): AgRequest {
    const calls = Array.from({ length: 5 }, (_, i) => ({ type: 'tool_use' as const, id: `toolu_p${i}`, name: 'Write', input: { file_path: `/w/f${i}.ts`, content: `INPUT-${i}-` + 'w'.repeat(inputBytes) } }))
    return {
      model: 'gemini-4-neon-xhigh',
      messages: [
        { role: 'assistant', content: calls },
        { role: 'user', content: calls.map(c => ({ type: 'tool_result' as const, tool_use_id: c.id, content: `RESULT-${c.id}-` + 'r'.repeat(resultBytes) })) },
      ],
      tools: [],
      stream: true,
    }
  }

  it('folds the preceding tool_use batch into the split when the final step cannot fit it', () => {
    const request = delta(40_000, 4_000)
    // Before the fix this threw "latest request exceeds the per-step input limit".
    const parts = planAgLatestContent(request, [], '', STEP_BYTES, STEP_TOKENS, 1_000_000, true)
    expect(parts).toBeDefined()
    expect(parts!.length).toBeGreaterThan(1)
    for (const part of parts!) {
      expect(Buffer.byteLength(part)).toBeLessThanOrEqual(STEP_BYTES)
      expect(estimateAgTextTokens(part)).toBeLessThanOrEqual(STEP_TOKENS)
    }
    const joined = parts!.join('\n')
    for (let i = 0; i < 5; i++) {
      expect(joined).toContain(`INPUT-${i}-`)
      expect(joined).toContain(`RESULT-toolu_p${i}-`)
    }
    expect(joined.indexOf('INPUT-4-')).toBeLessThan(joined.indexOf('RESULT-toolu_p0-'))
    expect(parts!.at(-1)).toContain('array of the newest 2 client messages')
  })

  it('keeps the single-message split when the preceding message is small', () => {
    const request = delta(100, 60_000)
    const parts = planAgLatestContent(request, [], '', STEP_BYTES, STEP_TOKENS, 1_000_000, true)
    expect(parts).toBeDefined()
    expect(parts!.at(-1)).not.toContain('array of the newest')
    expect(parts!.at(-1)).toContain('INPUT-0-')
  })

  it('still rejects when the base prompt itself exceeds the step limit', () => {
    const request = delta(40_000, 4_000)
    request.system = 's'.repeat(STEP_BYTES + 1)
    expect(() => planAgLatestContent(request, [], '', STEP_BYTES, STEP_TOKENS, 1_000_000, true)).toThrow('base prompt')
  })
})
