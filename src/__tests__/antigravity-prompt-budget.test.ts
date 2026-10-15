import { afterEach, describe, expect, it } from "bun:test"
import { AntigravityError, parseAgRequest, renderAgPrompt, renderAgPromptWithinLimit } from "../proxy/backends/antigravityProtocol"

// agy drops everything past ~192,000 bytes of one user message, newest content first. Past the budget the gateway shrinks the
// oldest big tool results itself, so the newest request and its tool results always reach the model.
const saved = process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES
afterEach(() => { if (saved === undefined) delete process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES; else process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = saved })
const tools = [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }]
const session = (pairs: number, size: number, fill = "r", question: unknown = "Now summarize everything.") => {
  const messages: unknown[] = [{ role: "user", content: "Inspect the repo." }]
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "bash", input: { command: `cat part${i}.txt` } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: `RESULT${i}-` + fill.repeat(size) + `-END${i}` }] })
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: "Looked at everything." }] }, { role: "user", content: question })
  return parseAgRequest({ model: "fixture-model", messages, tools })
}

describe("Antigravity prompt byte budget", () => {
  it("renders byte-identically to renderAgPrompt when the prompt fits", () => {
    const request = session(3, 1000)
    expect(renderAgPromptWithinLimit(request, [], "\nsuffix")).toBe(renderAgPrompt(request, []) + "\nsuffix")
    expect(renderAgPromptWithinLimit(request, [])).not.toContain("omitted by gateway")
  })

  it("omits the oldest big tool results first, keeps the newest intact, and says so before the history", () => {
    const request = session(12, 30_000)
    expect(Buffer.byteLength(renderAgPrompt(request, []))).toBeGreaterThan(190_000)
    const prompt = renderAgPromptWithinLimit(request, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    const history = JSON.parse(prompt.split("Client conversation:\n").at(-1)!) as { content: { type: string; content?: string }[] }[]
    const result = (i: number) => String(history[2 + 2 * i]!.content[0]!.content)
    expect(result(0)).toMatch(/^RESULT0-/)
    expect(result(0)).toMatch(/\[\.\.\. \d+ chars omitted by gateway: Antigravity input limit; re-read if needed \.\.\.\]/)
    expect(result(0)).toMatch(/-END0$/)
    // The newest result and the question are untouched; so are roles, order and tool_use/tool_result ids.
    expect(result(11)).toBe(((request.messages[24]!.content as { content: string }[])[0]!).content)
    expect(history.map(m => m.content instanceof Array ? m.content[0]!.type : "text")).toEqual(request.messages.map(m => m.content instanceof Array ? m.content[0]!.type : "text"))
    expect(prompt.slice(0, prompt.indexOf("Client conversation:"))).toMatch(/omitted .* larger earlier .*re-read/i)
    // Older results shrink before newer ones.
    const omitted = history.flatMap((_, i) => i >= 2 && i % 2 === 0 && /omitted by gateway/.test(result((i - 2) / 2)) ? [(i - 2) / 2] : [])
    expect(omitted[0]).toBe(0)
    expect(omitted).toEqual(omitted.map((_, i) => i))
    expect(omitted.length).toBeLessThan(12)
  })

  it("counts UTF-8 bytes, not characters", () => {
    const request = session(10, 20_000, "é")
    expect(renderAgPrompt(request, []).length).toBeLessThan(190_000 * 2)
    const prompt = renderAgPromptWithinLimit(request, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    expect(prompt).toContain("omitted by gateway")
  })

  it("honors MERIDIAN_AGY_MAX_PROMPT_BYTES and counts the suffix", () => {
    const request = session(12, 30_000)
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "100000"
    expect(Buffer.byteLength(renderAgPromptWithinLimit(request, [], "z".repeat(5000)))).toBeLessThanOrEqual(100_000)
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "0"
    expect(renderAgPromptWithinLimit(request, [])).toBe(renderAgPrompt(request, []))
  })

  it("shrinks old big tool_use arguments and old long text after the tool results", () => {
    const messages: unknown[] = [{ role: "user", content: "P".repeat(120_000) }, { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "bash", input: { command: "C".repeat(120_000) } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] }, { role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: "next question" }]
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages, tools }), [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    const history = JSON.parse(prompt.split("Client conversation:\n").at(-1)!)
    expect(history.at(-1).content).toBe("next question")
    expect(history[1].content[0]).toMatchObject({ type: "tool_use", id: "c1", name: "bash" })
    expect(history[1].content[0].input.command).toMatch(/omitted by gateway/)
  })

  it("throws the 400 prompt-too-long error when the newest request itself is over the limit", () => {
    const request = session(2, 100, "r", "Q".repeat(300_000))
    const error = (() => { try { renderAgPromptWithinLimit(request, []) } catch (e) { return e } })()
    expect(error).toBeInstanceOf(AntigravityError)
    expect(error).toMatchObject({ status: 400 })
    expect((error as Error).message).toMatch(/prompt is too long/)
  })

  const agentic = (rounds: number, size: number, lastSize = size) => {
    const messages: unknown[] = [{ role: "user", content: "Read all parts and report." }]
    for (let i = 0; i < rounds; i++) messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c${i}`, name: "bash", input: { command: `cat part${i}`, note: i === rounds - 1 ? "N".repeat(30_000) : "short" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: `RESULT${i}-` + "r".repeat(i === rounds - 1 ? lastSize : size) + `-END${i}` }] })
    return parseAgRequest({ model: "fixture-model", messages, tools })
  }
  type Hist = { role: string; content: { type: string; content?: string; input?: { note: string } }[] | string }[]
  const histOf = (prompt: string) => JSON.parse(prompt.split("Client conversation:\n").at(-1)!) as Hist
  const resultAt = (history: Hist, round: number) => String((history[2 + 2 * round]!.content as { content?: string }[])[0]!.content)

  it("after the newest request, shrinks the oldest tool results of a long agentic turn and keeps the last round verbatim", () => {
    const request = agentic(12, 30_000)
    expect(Buffer.byteLength(renderAgPrompt(request, []))).toBeGreaterThan(190_000)
    const prompt = renderAgPromptWithinLimit(request, [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    const history = histOf(prompt)
    expect(history[0]!.content).toBe("Read all parts and report.")
    expect(resultAt(history, 0)).toMatch(/omitted by gateway/)
    expect(resultAt(history, 0)).toMatch(/^RESULT0-.*-END0$/s)
    // Last assistant message (tool_use with its big argument) and last user message (newest tool_result) are verbatim.
    expect(resultAt(history, 11)).toBe(resultAt(request.messages as unknown as Hist, 11))
    expect(history.at(-2)).toEqual(request.messages.at(-2) as never)
    expect(history.length).toBe(request.messages.length)
    expect(prompt.slice(0, prompt.indexOf("Client conversation:"))).toMatch(/omitted .* re-read/i)
    expect(prompt.slice(0, prompt.indexOf("Client conversation:")).match(/Read all parts and report\./g)).toHaveLength(2)
  })

  it("shrinks old tool_use arguments after the tool results after the newest request", () => {
    const messages: unknown[] = [{ role: "user", content: "Write the files." }]
    for (let i = 0; i < 6; i++) messages.push({ role: "assistant", content: [{ type: "tool_use", id: `w${i}`, name: "bash", input: { command: "W".repeat(40_000) } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: `w${i}`, content: "ok" }] })
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages, tools }), [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    const history = JSON.parse(prompt.split("Client conversation:\n").at(-1)!) as { content: { input: { command: string } }[] }[]
    expect(history[1]!.content[0]!.input.command).toMatch(/omitted by gateway/)
    expect(history.at(-2)!.content[0]!.input.command).toBe("W".repeat(40_000))
  })

  it("throws the 400 error when the protected last round alone is over the limit", () => {
    expect(() => renderAgPromptWithinLimit(agentic(3, 100, 185_000), [])).toThrow(/prompt is too long/)
  })

  const lastUserHistory = (prompt: string) => JSON.parse(prompt.split("Client conversation:\n").at(-1)!) as { content: any }[]

  it("shrinks big strings nested in tool_use arguments and keeps keys, shape and non-string values", () => {
    const input = { path: "a.txt", edits: [{ old: "O".repeat(30_000), new: "N".repeat(30_000), count: 2, flags: { all: true, none: null } }, "short"], meta: { deep: { blob: "B".repeat(30_000) } } }
    const messages: unknown[] = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] }, { role: "assistant", content: "done" }, { role: "user", content: "next" }]
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "20000"
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages }), [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000)
    const shrunk = lastUserHistory(prompt)[1]!.content[0].input
    expect(shrunk.path).toBe("a.txt")
    expect(shrunk.edits[0].old).toMatch(/omitted by gateway/)
    expect(shrunk.edits[0].new).toMatch(/omitted by gateway/)
    expect(shrunk.edits[0]).toMatchObject({ count: 2, flags: { all: true, none: null } })
    expect(shrunk.edits[1]).toBe("short")
    expect(shrunk.meta.deep.blob).toMatch(/omitted by gateway/)
    expect(Object.keys(shrunk)).toEqual(["path", "edits", "meta"])
  })

  it("never cuts a surrogate pair in half when keeping the head and tail", () => {
    // "x" + 1001 emoji: an odd UTF-16 length puts both 300-unit cut points inside a pair.
    const body = "x" + "😀".repeat(1001)
    const messages: unknown[] = [{ role: "user", content: "q" }, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: { a: "1" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: body }] }, { role: "assistant", content: "done" }, { role: "user", content: "next" }]
    const request = parseAgRequest({ model: "fixture-model", messages })
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = String(Buffer.byteLength(renderAgPrompt(request, [])) - 1500)
    const prompt = renderAgPromptWithinLimit(request, [])
    const kept = String(lastUserHistory(prompt)[2]!.content[0].content)
    expect(kept).toMatch(/omitted by gateway/)
    expect(kept.isWellFormed()).toBe(true)
    expect(prompt.isWellFormed()).toBe(true)
    expect(Buffer.from(prompt).toString("utf8")).toBe(prompt)
    const [head, tail] = kept.split(/\n\[\.\.\. \d+ chars omitted[^\n]*\n/)
    expect(head).toMatch(/^x(😀)+$/u)
    expect(tail).toMatch(/^(😀)+$/u)
  })

  it("shrinks old results when there is no typed user request at all", () => {
    const messages: unknown[] = [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "bash", input: { command: "cat a" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "A".repeat(60_000) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "bash", input: { command: "cat b" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "B".repeat(60_000) }] }]
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "100000"
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages }), [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(100_000)
    const history = lastUserHistory(prompt)
    expect(history[1]!.content[0].content).toMatch(/omitted by gateway/)
    expect(history[3]!.content[0].content).toBe("B".repeat(60_000))
  })

  it("leaves non-text blocks and result flags alone while shrinking the text next to them", () => {
    const image = { type: "image", source: { type: "url", url: "https://example.test/a.png" } }
    const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "see this" }, image] }, { role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: { a: "1" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "x", is_error: true, cache_control: { type: "ephemeral" }, content: [image, { type: "text", text: "T".repeat(40_000) }] }] }, { role: "assistant", content: "done" }, { role: "user", content: "next" }]
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "20000"
    const prompt = renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages }), [])
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000)
    const history = lastUserHistory(prompt)
    expect(history[0]!.content[1]).toEqual(image)
    const result = history[2]!.content[0]
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "x", is_error: true })
    expect(result.content[0]).toEqual(image)
    expect(result.content[1].text).toMatch(/omitted by gateway/)
  })

  it("still throws when a huge non-text block is all that is left", () => {
    const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: "see this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(60_000) } }] }, { role: "assistant", content: "ok" }, { role: "user", content: "next" }]
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "20000"
    expect(() => renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages }), [])).toThrow(/prompt is too long/)
  })

  it("throws when the only user message is a huge tool result (it is the protected last user message)", () => {
    const messages: unknown[] = [{ role: "assistant", content: [{ type: "tool_use", id: "x", name: "t", input: { x: "x" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "R".repeat(10_000) }] }]
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "3000"
    expect(() => renderAgPromptWithinLimit(parseAgRequest({ model: "fixture-model", messages }), [])).toThrow(/prompt is too long/)
  })

  it("throws instead of truncating when everything omittable is already omitted", () => {
    const request = session(2, 100, "r", "Q".repeat(1000))
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "3000"
    expect(() => renderAgPromptWithinLimit(request, [])).toThrow(/prompt is too long/)
  })

  it("does not mutate the request", () => {
    const request = session(12, 30_000), before = JSON.stringify(request.messages)
    renderAgPromptWithinLimit(request, [])
    expect(JSON.stringify(request.messages)).toBe(before)
  })
})
