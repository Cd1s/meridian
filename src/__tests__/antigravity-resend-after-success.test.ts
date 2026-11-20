import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-resilience-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
type Reply = { stop_reason: string; content: Array<{ type: string; id?: string; text?: string }> }

describe.skipIf(process.platform === "win32")("Antigravity resend of a delivered tool-result continuation", () => {
  for (const reuseConversations of [false, true]) for (const stream of [false, true]) {
    it(`answers an identical resend after the first reply was fully delivered (reuse=${reuseConversations}, stream=${stream})`, async () => {
      const runtime = new AntigravityRuntime({ executable, reuseConversations, allowToolBridge: true, turnTimeoutMs: 10000 })
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
      closing.push(server.closeBackend)
      const send = (body: unknown) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
      // Production shape: the client's last turn ends in assistant text, so normalization may append a user turn.
      const first = { model: "fixture-model", max_tokens: 100, tools: [tool], messages: [{ role: "user", content: "Get receipt" }] }
      const reply = await (await send(first)).json() as Reply
      const call = reply.content.find(block => block.type === "tool_use")!
      const continuation = { ...first, stream, messages: [...first.messages, { role: "assistant", content: reply.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "receipt" }] }] }
      const delivered = await send(continuation)
      expect(delivered.status).toBe(200)
      const text = await delivered.text()
      // The client never got that reply (e.g. a proxy in between timed out) and resends the identical request.
      for (const attempt of [1, 2]) {
        const again = await send(continuation)
        expect(again.status, `resend ${attempt}: ${await again.clone().text()}`).toBe(200)
        if (!stream) expect(JSON.stringify((await again.json() as Reply).content)).toBe(JSON.stringify((JSON.parse(text) as Reply).content))
      }
    })
  }
})
