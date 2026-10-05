import { describe, expect, it } from "bun:test"
import { normalizeAgRequest, parseAgRequest, type AgMessage } from "../proxy/backends/antigravityProtocol"

describe("Antigravity trailing assistant normalization", () => {
  it("appends a user continuation after a trailing text assistant before validation", () => {
    const contents: AgMessage["content"][] = ["Partial answer", [{ type: "text", text: "Partial answer" }]]
    for (const content of contents) {
      const messages: AgMessage[] = [{ role: "user", content: "Question" }, { role: "assistant", content }]
      expect(parseAgRequest({ model: "fixture-model", messages }).messages).toEqual([
        ...messages,
        { role: "user", content: [{ type: "text", text: "Continue." }] },
      ])
    }
  })

  it("preserves trailing tool calls and their original missing-user validation error", () => {
    const call = { type: "tool_use", id: "call_1", name: "lookup", input: {} }
    for (const content of [[call], [{ type: "text", text: "Looking up" }, call], [{ type: "thinking", thinking: "Reasoning" }, call]]) {
      const source = { model: "fixture-model", messages: [{ role: "assistant", content }] }
      expect(normalizeAgRequest(source)).toEqual(source)
      if (!content.some(block => block.type === "thinking")) {
        expect(() => parseAgRequest(source)).toThrow("The last message must be a user message")
      }
    }
  })

  it("appends after thinking prefills without changing their blocks", () => {
    const thinking = { type: "thinking", thinking: "Reasoning", signature: "fixture" }
    for (const content of [[thinking], [thinking, { type: "text", text: "Partial answer" }]]) {
      const messages = [{ role: "assistant", content }]
      expect(normalizeAgRequest({ model: "fixture-model", messages })).toEqual({
        model: "fixture-model",
        messages: [...messages, { role: "user", content: [{ type: "text", text: "Continue." }] }],
      })
    }
  })

  it("leaves a trailing user message unchanged", () => {
    const contents: AgMessage["content"][] = ["Question", [{ type: "text", text: "Question" }]]
    for (const content of contents) {
      const messages: AgMessage[] = [{ role: "user", content }]
      const source = { model: "fixture-model", messages }
      expect(normalizeAgRequest(source)).toEqual(source)
      expect(normalizeAgRequest(source)).toHaveProperty("messages", source.messages)
      expect(parseAgRequest(source).messages).toEqual(source.messages)
    }
  })

  for (const [label, messages] of [
    ["empty", []], ["missing", undefined], ["null", null], ["string", "invalid"], ["object", {}], ["number", 42],
  ] as const) it(`leaves ${label} messages for normal validation without crashing`, () => {
    const source = { model: "fixture-model", messages }
    expect(normalizeAgRequest(source)).toEqual(source)
    expect(() => parseAgRequest(source)).toThrow("invalid or unsupported request")
  })

  it("returns a new request and messages array without mutating frozen input", () => {
    const content = Object.freeze([Object.freeze({ type: "text", text: "Partial answer" })])
    const messages = Object.freeze([
      Object.freeze({ role: "user", content: "Question" }),
      Object.freeze({ role: "assistant", content }),
    ])
    const source = Object.freeze({ model: "fixture-model", messages })
    const snapshot = JSON.stringify(source)
    const normalized = normalizeAgRequest(source)
    expect(normalized).not.toBe(source)
    expect(normalized).toHaveProperty("messages", [...messages, { role: "user", content: [{ type: "text", text: "Continue." }] }])
    expect(JSON.stringify(source)).toBe(snapshot)
    expect(messages).toHaveLength(2)
  })

  it("combines the append with other repairs in one bounded log line without message content", () => {
    const lines: string[] = []
    const originalWarn = console.warn
    console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
    try {
      parseAgRequest({
        model: "fixture-model-high", output_config: { effort: "max" }, tools: [{ name: "lookup" }],
        messages: [{ role: "assistant", content: "Private assistant text\r\nSecond line" }],
      })
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain("effort:max→high")
      expect(lines[0]).toContain("added schema ×1")
      expect(lines[0]).toContain("appended user continue")
      expect(lines[0]).not.toContain("Private assistant text")
      expect(lines[0]).not.toContain("Second line")
      expect(lines[0]).not.toMatch(/[\x00-\x1f\x7f\u2028\u2029]/)
      expect(lines[0]?.length).toBeLessThanOrEqual(300)
    } finally { console.warn = originalWarn }
  })

  it("does not append another continuation when normalized again", () => {
    const source = { model: "fixture-model", messages: [{ role: "assistant", content: "Partial answer" }] }
    const normalized = normalizeAgRequest(source)
    expect(normalizeAgRequest(normalized)).toEqual(normalized)
  })
})
