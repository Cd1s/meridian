import { describe, expect, it } from 'bun:test'
import { renderAgPromptWithinLimit, type AgRequest } from '../proxy/backends/antigravityProtocol'
import { renderAgColdTrim } from '../proxy/backends/antigravityColdTrim'
import { estimateAgTextTokens } from '../proxy/backends/antigravityTokens'

function longSession(): AgRequest {
  const messages: AgRequest['messages'] = [
    { role: 'user', content: 'INITIAL_TASK_BRIEF_' + 'brief '.repeat(1000) },
  ]
  for (let i = 0; i < 30; i++) {
    const id = `toolu_${i}`
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: { path: `/report-${i}.md` } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `TOOL_RESULT_${i}_` + 'r'.repeat(20_000) }] })
    if (i % 5 === 4) messages.push({ role: 'user', content: `USER_STEER_${(i + 1) / 5}: keep the original task and inspect the next report` })
  }
  messages.push({ role: 'user', content: 'FINAL_USER_INSTRUCTION: finish the original task' })
  return { model: 'gemini-4-neon-high', messages, tools: [], stream: true }
}

describe('Antigravity history preservation', () => {
  it('keeps the first brief and every user-authored steer while omitting tool results first', () => {
    const request = longSession()
    const prompt = renderAgPromptWithinLimit(request, [], '', 190_000)
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    expect(prompt).toContain('INITIAL_TASK_BRIEF_' + 'brief '.repeat(1000))
    expect(prompt).toContain('FINAL_USER_INSTRUCTION')
    for (let i = 1; i <= 6; i++) expect(prompt).toContain(`USER_STEER_${i}: keep the original task and inspect the next report`)
    expect(prompt).toContain('omitted by Meridian')
    expect(prompt).not.toContain('TOOL_RESULT_0_' + 'r'.repeat(20_000))
  })

  it('keeps user-authored text through cold trimming and stays within both limits', () => {
    const request = longSession()
    const prompt = renderAgColdTrim(request, [], '', { bytes: 190_000, tokens: 52_000, estimateTokens: estimateAgTextTokens })
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    expect(estimateAgTextTokens(prompt)).toBeLessThanOrEqual(52_000)
    expect(prompt).toContain('INITIAL_TASK_BRIEF_' + 'brief '.repeat(1000))
    for (let i = 1; i <= 6; i++) expect(prompt).toContain(`USER_STEER_${i}: keep the original task and inspect the next report`)
  })
})
