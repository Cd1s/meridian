import { describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgAttachments } from "../proxy/backends/antigravityAttachments"
import { parseAgRequest, parallelAgTool, renderAgPrompt, renderAgPromptWithinLimit } from "../proxy/backends/antigravityProtocol"

const request = () => parseAgRequest({
  model: "fixture-model", max_tokens: 100,
  tools: [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }],
  messages: [{ role: "user", content: "Read the supplied data." }],
})
const neutral = (text: string) => {
  expect(text).not.toMatch(/meridian|\b(?:proxy|bridge|gateway)\b/i)
}
describe("neutral agy-facing instructions", () => {
  it("uses neutral instructions, server and parallel-tool names", () => {
    const body = request()
    body.tool_choice = { type: "any" }
    const prompt = renderAgPrompt(body)
    neutral(prompt)
    expect(prompt).toStartWith("Follow the instructions below and answer the latest user message.")
    expect(prompt).toContain("client_result")
    expect(prompt).toContain("client_followup")
    expect(parallelAgTool(body)?.name).toBe("workspace_parallel")
  })
  it("keeps structured-output and omission instructions neutral", () => {
    const body = request()
    body.output_config = { format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } }
    neutral(renderAgPrompt(body, [], true))
    body.messages = [{ role: "user", content: "Read supplied data." }, { role: "assistant", content: "padding ".repeat(40000) }, { role: "user", content: "Summarize briefly." }]
    const prompt = renderAgPromptWithinLimit(body, [], "", 20000)
    neutral(prompt)
    expect(prompt).toContain("content omitted")
  })
  it("does not rewrite caller-owned product names", () => {
    const body = request()
    body.messages = [{ role: "user", content: "Explain the Meridian repository." }]
    expect(renderAgPrompt(body)).toContain("Explain the Meridian repository.")
  })
  it("renders supplied attachments with a neutral note", async () => {
    const root = await mkdtemp(join(tmpdir(), "outbound-attachment-"))
    try {
      const attachments = new AgAttachments(root)
      const blocks = await attachments.content([{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF5sAAAAASUVORK5CYII=" } }])
      neutral(JSON.stringify(blocks))
      expect(JSON.stringify(blocks)).toContain("Image attachment")
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
