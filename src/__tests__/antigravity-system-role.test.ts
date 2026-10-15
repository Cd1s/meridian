import { describe, expect, it } from "bun:test"
import { normalizeAgRequest, parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"

// Claude Code 2.1.29x sends an environment block as a mid-conversation `role: "system"` message to models it does not
// recognise (Anthropic accepts these on newer models); Meridian only speaks user/assistant, so fold them into `system`.
const env = "# Environment\nPrimary working directory: C:\\Users\\Administrator"

describe("Antigravity mid-conversation system messages", () => {
  it("folds a trailing system message into a string system prompt", () => {
    const parsed = parseAgRequest({ model: "fixture-model", system: "Base instructions", messages: [
      { role: "user", content: "你好" },
      { role: "system", content: [{ type: "text", text: env }] },
    ] })
    expect(parsed.messages).toEqual([{ role: "user", content: "你好" }])
    expect(parsed.system).toBe("Base instructions\n\n" + env)
  })

  it("appends text blocks to a block system prompt in message order, from string or block content", () => {
    const parsed = parseAgRequest({ model: "fixture-model", system: [{ type: "text", text: "Base" }], messages: [
      { role: "system", content: "First note" },
      { role: "user", content: "Question" },
      { role: "system", content: [{ type: "text", text: "Second note" }, { type: "text", text: "Third note" }] },
    ] })
    expect(parsed.messages).toEqual([{ role: "user", content: "Question" }])
    expect(parsed.system).toEqual([{ type: "text", text: "Base" }, { type: "text", text: "First note" }, { type: "text", text: "Second note" }, { type: "text", text: "Third note" }])
  })

  it("creates the system prompt when the request has none", () => {
    const parsed = parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "Hi" }, { role: "system", content: env }] })
    expect(parsed.system).toBe(env)
    expect(parsed.messages).toEqual([{ role: "user", content: "Hi" }])
  })

  it("still appends the user continuation when the folded message followed a text assistant", () => {
    const parsed = parseAgRequest({ model: "fixture-model", messages: [
      { role: "user", content: "Question" },
      { role: "assistant", content: "Partial answer" },
      { role: "system", content: env },
    ] })
    expect(parsed.messages).toEqual([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Partial answer" },
      { role: "user", content: [{ type: "text", text: "Continue." }] },
    ])
  })

  it("keeps only the text of system messages and drops empty ones", () => {
    const parsed = parseAgRequest({ model: "fixture-model", system: "Base", messages: [
      { role: "user", content: "Question" },
      { role: "system", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }, { type: "text", text: "Kept" }] },
      { role: "system", content: [] },
    ] })
    expect(parsed.system).toBe("Base\n\nKept")
    expect(parsed.messages).toEqual([{ role: "user", content: "Question" }])
  })

  it("does not mutate the input and is idempotent", () => {
    const source = Object.freeze({ model: "fixture-model", system: "Base", messages: Object.freeze([
      Object.freeze({ role: "user", content: "Question" }), Object.freeze({ role: "system", content: env }),
    ]) })
    const once = normalizeAgRequest(source)
    expect(source.messages).toHaveLength(2)
    expect(normalizeAgRequest(once)).toEqual(once)
  })

  it("renders the folded text with the client system instructions", () => {
    const prompt = renderAgPrompt(parseAgRequest({ model: "fixture-model", system: "Base", messages: [{ role: "user", content: "Hi" }, { role: "system", content: env }] }))
    expect(prompt).toContain("Client system instructions:\nBase\n\n" + env)
    expect(prompt).not.toContain('"role":"system"')
  })
})
