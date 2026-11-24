import { describe, expect, it } from 'bun:test'
import { AntigravityError, renderAgPromptWithinLimit, type AgRequest } from '../proxy/backends/antigravityProtocol'
import { planAgLatestContent } from '../proxy/backends/antigravityHistory'

function request(size: number, unicode: boolean): AgRequest {
  const unit = unicode ? '中文🙂' : 'x'
  return {
    model: 'gemini-4-neon-high',
    system: 'system',
    tools: [],
    stream: false,
    messages: [{ role: 'user', content: unit.repeat(size) }],
  }
}

describe('Antigravity prompt-planning termination', () => {
  it('bounds random latest payloads and tiny limits', () => {
    let seed = 0x9e3779b9
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed
    }
    const started = Date.now()
    for (let i = 0; i < 80; i++) {
      const size = 1 + next() % 80_000
      const limit = 1 + next() % 150_620
      const tokens = 1 + next() % 52_000
      const input = request(size, i % 3 === 0)
      try {
        const plans = planAgLatestContent(input, [], '', limit, tokens, 480_000, true)
        for (const plan of plans ?? []) {
          expect(Buffer.byteLength(plan)).toBeLessThanOrEqual(limit)
        }
      } catch (error) {
        expect(error).toBeInstanceOf(AntigravityError)
        expect(String(error)).toContain('prompt is too long')
      }
    }
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('fails fast when trimming cannot fit any indivisible prompt', () => {
    const input = request(250_000, true)
    const started = Date.now()
    expect(() => renderAgPromptWithinLimit(input, [], '', 1)).toThrow('prompt is too long')
    expect(Date.now() - started).toBeLessThan(500)
  })
})
