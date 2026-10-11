import { afterEach, describe, expect, it } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { completedToolTail, parseAgRequest, stable } from "../proxy/backends/antigravityProtocol"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

// A request that reaches a new run ending in tool results is a history replay: the live turn is gone (backend
// replaced, process reclaimed, other account). Gemini then often requests the call that just completed again; a
// second write, append or deploy must not run in the client.
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const replay = (prompt: string, result: { content: string; is_error?: boolean }) => ({
  model: "fixture-model", max_tokens: 100, tools: [tool],
  messages: [
    { role: "user", content: prompt },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_done", name: "lookup", input: { key: "probe0" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_done", ...result }] },
  ],
})

describe("completedToolTail", () => {
  const request = (calls: unknown[], results: unknown[]) => parseAgRequest({ model: "fixture-model", messages: [
    { role: "user", content: "go" }, { role: "assistant", content: calls }, { role: "user", content: results },
  ] })
  const use = (id: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name: "write", input })
  const result = (id: string, extra: Record<string, unknown> = {}) => ({ type: "tool_result", tool_use_id: id, content: "ok " + id, ...extra })

  it("keys successful calls of the completed batch by name and input, independent of argument order", () => {
    const tail = completedToolTail(request([use("a", { content: "x", file_path: "/f" }), use("b", { file_path: "/g" })], [result("a"), result("b")]).messages)
    expect([...tail.keys()]).toEqual([stable({ name: "write", input: { file_path: "/f", content: "x" } }), stable({ name: "write", input: { file_path: "/g" } })])
    expect(tail.get(stable({ name: "write", input: { file_path: "/f", content: "x" } }))?.tool_use_id).toBe("a")
  })

  it("leaves out failed calls and identities repeated within the batch", () => {
    const tail = completedToolTail(request([use("a", { file_path: "/f" }), use("b", { file_path: "/f" }), use("c", { file_path: "/e" })], [result("a"), result("b"), result("c", { is_error: true })]).messages)
    expect(tail.size).toBe(0)
  })

  it("is empty unless the request ends in tool results only", () => {
    const typed = request([use("a", { file_path: "/f" })], [result("a"), { type: "text", text: "now do something else" }])
    expect(completedToolTail(typed.messages).size).toBe(0)
    expect(completedToolTail(parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "hi" }] }).messages).size).toBe(0)
  })
})

const executable = fileURLToPath(new URL("./fixtures/agy-replay-repeat-cli.cjs", import.meta.url))
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
type Reply = { stop_reason: string; content: Array<{ type: string; text?: string; name?: string; input?: unknown }> }

describe.skipIf(process.platform === "win32")("Antigravity history replay does not execute a completed call twice", () => {
  const server = () => {
    const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10000 })
    const app = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    closing.push(app.closeBackend)
    const send = async (body: unknown) => {
      const response = await app.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
      expect(response.status, await response.clone().text()).toBe(200)
      return await response.json() as Reply
    }
    return { runtime, send }
  }

  it("answers an identical repeat of the completed call from its recorded result", async () => {
    const { runtime, send } = server()
    const reply = await send(replay("REPEAT_COMPLETED write the receipt", { content: "receipt" }))
    expect(reply.stop_reason).toBe("end_turn")
    expect(reply.content.filter(block => block.type === "tool_use")).toEqual([])
    expect(reply.content.map(block => block.text).join("")).toBe("REPLAYED:receipt")
    expect(runtime.replayDuplicates).toBe(1)
  })

  it("answers only the first repeat; a second identical request in the same turn goes to the client", async () => {
    const { runtime, send } = server()
    const reply = await send(replay("REPEAT_COMPLETED REPEAT_TWICE", { content: "receipt" }))
    expect(reply.stop_reason).toBe("tool_use")
    expect(reply.content.filter(block => block.type === "tool_use").map(block => [block.name, block.input])).toEqual([["lookup", { key: "probe0" }]])
    expect(runtime.replayDuplicates).toBe(1)
  })

  it("sends a retry of a failed call to the client", async () => {
    const { runtime, send } = server()
    const reply = await send(replay("REPEAT_COMPLETED", { content: "disk full", is_error: true }))
    expect(reply.content.filter(block => block.type === "tool_use").map(block => block.input)).toEqual([{ key: "probe0" }])
    expect(runtime.replayDuplicates).toBe(0)
  })
})
