import { describe, expect, it } from "bun:test"
import { parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"

// Long, tool-heavy histories drowned the newest user message at the end of one huge JSON blob: Gemini kept running the
// earlier task instead of answering. The latest request is now stated before the history and repeated right before it.
const longHistory = (question: unknown, endWithToolCall = false) => {
  const messages: unknown[] = [{ role: "user", content: "Inspect the router and list its inbounds." }]
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "bash", input: { command: `cat part${i}.json` } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: "x".repeat(2000) }] })
  }
  messages.push(endWithToolCall
    ? { role: "assistant", content: [{ type: "tool_use", id: "call_last", name: "bash", input: { command: "cat summary.json" } }] }
    : { role: "assistant", content: [{ type: "text", text: "Done: 20 shadowsocks and 55 socks inbounds." }] })
  messages.push({ role: "user", content: question })
  return parseAgRequest({ model: "fixture-model", messages, tools: [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }] })
}

describe("Antigravity prompt keeps the latest user request in focus", () => {
  it("states the latest user text at the top and again right before the history, which stays last", () => {
    const prompt = renderAgPrompt(longHistory("New question: what is 17 times 3?"))
    const history = prompt.indexOf("Client conversation:")
    const preamble = prompt.slice(0, history)
    expect(history).toBeGreaterThan(0)
    // Stated at the top, and again in the reminder that sits right before the history.
    expect(preamble.indexOf("current request")).toBeLessThan(preamble.indexOf("The JSON below"))
    expect(preamble.match(/New question: what is 17 times 3\?/g)).toHaveLength(2)
    expect(preamble.lastIndexOf("The latest user message is:")).toBeGreaterThan(preamble.indexOf("Client system instructions:"))
    // The history is still the last, intact JSON value.
    expect(JSON.parse(prompt.split("Client conversation:\n").at(-1)!)).toHaveLength(83)
  })

  it("collects text blocks of the latest user message, including steering text sent next to tool results", () => {
    const request = longHistory([{ type: "tool_result", tool_use_id: "call_last", content: "ok" }, { type: "text", text: "Stop that. Answer: 2+2?" }], true)
    const prompt = renderAgPrompt(request)
    expect(prompt.indexOf("Stop that. Answer: 2+2?")).toBeLessThan(prompt.indexOf("Client conversation:"))
  })

  it("adds no request section for a pure tool-result continuation, and keeps the full history intact", () => {
    const request = longHistory([{ type: "tool_result", tool_use_id: "call_last", content: "ok" }], true)
    const prompt = renderAgPrompt(request)
    expect(prompt).toContain(JSON.stringify(request.messages))
    expect(prompt).not.toContain("current request")
  })

  it("leaves a short first-turn prompt unchanged apart from the request header", () => {
    const request = parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "hello" }] })
    const prompt = renderAgPrompt(request)
    expect(prompt).toContain(JSON.stringify(request.messages))
    expect(prompt.match(/hello/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
