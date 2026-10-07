import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

// A conversation that already ran tools must stay usable on the next user message. The client replays its whole
// history, which now ends in assistant text that follows tool results.
const executable = fileURLToPath(new URL("./fixtures/agy-resilience-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
function fixture() {
  const runtime = new AntigravityRuntime({ executable, reuseConversations: false, allowToolBridge: true, turnTimeoutMs: 10000 })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  closing.push(server.closeBackend)
  const send = (body: unknown) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
  return { send }
}
type Block = { type: string; id?: string; text?: string }
type Reply = { stop_reason: string; content: Block[] }
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const base = (messages: unknown[]) => ({ model: "fixture-model", max_tokens: 100, messages, tools: [tool] })

describe.skipIf(process.platform === "win32")("Antigravity follow-up after a tool conversation", () => {
  it("answers the next user message after a finished tool exchange, and keeps answering when the client retries", async () => {
    const { send } = fixture()
    const history: unknown[] = [{ role: "user", content: "LOOP_1" }]
    const first = await (await send(base(history))).json() as Reply
    expect(first.stop_reason).toBe("tool_use")
    history.push({ role: "assistant", content: first.content })
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: first.content.find(b => b.type === "tool_use")!.id, content: "receipt" }] })
    const second = await send(base(history))
    expect(second.status, await second.clone().text()).toBe(200)
    const done = await second.json() as Reply
    history.push({ role: "assistant", content: done.content })

    // Next turn: the whole history is replayed and ends with a new user message.
    const next = [...history, { role: "user", content: "thanks, now say hello" }]
    for (const attempt of [1, 2, 3]) {
      const response = await send(base(next))
      expect(response.status, `attempt ${attempt}: ${await response.clone().text()}`).not.toBe(409)
    }
  })

  it("does not turn a replayed tool history that ends in assistant text into a consumed-tool conflict", async () => {
    const { send } = fixture()
    const history: unknown[] = [{ role: "user", content: "LOOP_1" }]
    const first = await (await send(base(history))).json() as Reply
    history.push({ role: "assistant", content: first.content })
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: first.content.find(b => b.type === "tool_use")!.id, content: "receipt" }] })
    const done = await (await send(base(history))).json() as Reply
    // A client (or a proxy converting formats) that sends the history so far, ending in the assistant's final text.
    history.push({ role: "assistant", content: done.content })
    for (const attempt of [1, 2, 3]) {
      const response = await send(base(history))
      expect(response.status, `attempt ${attempt}: ${await response.clone().text()}`).not.toBe(409)
    }
  })
  it("variant: client history lacks the assistant text that followed the tool result, then sends a new user message", async () => {
    const { send } = fixture()
    const history: unknown[] = [{ role: "user", content: "LOOP_1" }]
    const first = await (await send(base(history))).json() as Reply
    history.push({ role: "assistant", content: first.content })
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: first.content.find(b => b.type === "tool_use")!.id, content: "receipt" }] })
    expect((await send(base(history))).status).toBe(200)
    // the assistant's final text never made it into the client's history
    const next = [...history, { role: "user", content: "and now?" }]
    const response = await send(base(next))
    expect(response.status, await response.clone().text()).not.toBe(409)
  })

  it("variant: the same tool_result request is sent twice concurrently", async () => {
    const { send } = fixture()
    const history: unknown[] = [{ role: "user", content: "LOOP_1" }]
    const first = await (await send(base(history))).json() as Reply
    history.push({ role: "assistant", content: first.content })
    history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: first.content.find(b => b.type === "tool_use")!.id, content: "receipt" }] })
    const [a, b] = await Promise.all([send(base(history)), send(base(history))])
    console.log("CONCURRENT", a.status, b.status)
    expect([a.status, b.status].filter(s => s === 409).length).toBe(0)
    const again = await send(base(history))
    expect(again.status, await again.clone().text()).not.toBe(409)
  })
})
