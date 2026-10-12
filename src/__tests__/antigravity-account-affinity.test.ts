import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AgAccountSet } from "../proxy/backends/antigravityAccounts"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { hashGatewaySecret } from "../proxy/backends/antigravityPanelStore"
import { agContinuation, type AgContinuation, type AgHold } from "../proxy/backends/antigravityProtocol"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG, type ProxyConfig } from "../proxy/types"

// Routers in front of the account set (gateway-key round-robin, Sub2API upstream) pick an account per request. A
// conversation that lands on an account not holding it can only be replayed as one history JSON value, so the set
// sends continuations back to the account whose process holds them.
const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanups.splice(0).reverse()) await step() })
const keys = { acc1: "secret-key-acc1-0123456789", acc2: "secret-key-acc2-0123456789", acc3: "secret-key-acc3-0123456789" }
const GW = "mk-11112222333344445555666677778888"
const post = (key: string, body: string, path = "/v1/messages") => new Request(`http://localhost${path}`, { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body })

function accountsDir(names: Array<keyof typeof keys>) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-affinity-test-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const name of names) {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, "env"), `MERIDIAN_API_KEY=${keys[name]}\nALL_PROXY=socks5h://p:1\n`)
  }
  return dir
}

describe("agContinuation", () => {
  it("reads tool results and the body of a Messages request", () => {
    const raw = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a" }, { type: "text", text: "and" }] }] }
    expect(agContinuation("/v1/messages", raw)).toEqual({ toolIds: ["toolu_a"], messages: raw })
  })
  it("reads trailing tool messages of a Chat Completions request", () => {
    const raw = { messages: [{ role: "tool", tool_call_id: "old" }, { role: "assistant" }, { role: "tool", tool_call_id: "a" }, { role: "tool", tool_call_id: "b" }] }
    expect(agContinuation("/v1/chat/completions", raw)).toEqual({ toolIds: ["a", "b"] })
  })
  it("reads tool outputs and the previous response of a Responses request", () => {
    const raw = { previous_response_id: "resp_1", input: [{ type: "function_call_output", call_id: "a" }, { type: "message" }, { type: "custom_tool_call_output", call_id: "b" }] }
    expect(agContinuation("/v1/responses", raw)).toEqual({ toolIds: ["a", "b"], responseId: "resp_1" })
  })
  it("continues nothing for other paths and malformed bodies", () => {
    expect(agContinuation("/v1/models", {})).toEqual({ toolIds: [] })
    expect(agContinuation("/v1/chat/completions", "not json")).toEqual({ toolIds: [] })
  })
})

describe("AgAccountSet account affinity", () => {
  function fakeSet(holds: Partial<Record<keyof typeof keys, (continuation: AgContinuation) => AgHold | undefined>>, statuses: Partial<Record<string, number>> = {}) {
    const dir = accountsDir(["acc1", "acc2", "acc3"])
    const served: Array<{ account: string; body: string }> = []
    const start = async (config: Partial<ProxyConfig>) => {
      const name = (Object.keys(keys) as Array<keyof typeof keys>).find(name => keys[name] === config.apiKey)!
      return {
        close: async () => {},
        holds: (continuation: AgContinuation) => holds[name]?.(continuation),
        fetch: async (request: Request) => {
          if (request.headers.get("x-api-key") !== config.apiKey) return new Response("wrong key", { status: 401 })
          served.push({ account: name, body: await request.text() })
          return Response.json({ account: name }, { status: statuses[name] ?? 200 })
        },
      }
    }
    const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 3)
    return { set, served }
  }
  const toolResult = JSON.stringify({ model: "m", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_held", content: "ok" }] }] })

  it("sends a tool result picked for one account to the account holding its call, with that account's key", async () => {
    const { set, served } = fakeSet({ acc3: c => c.toolIds.includes("toolu_held") ? "tool" : undefined })
    await set.sync()
    const response = await set.route(post(keys.acc1, toolResult))
    expect(await response.json()).toEqual({ account: "acc3" })
    expect(served).toEqual([{ account: "acc3", body: toolResult }])
  })

  it("keeps a request on the selected account when it holds the conversation or nobody does", async () => {
    const { set, served } = fakeSet({ acc1: () => "live", acc2: () => "live" })
    await set.sync()
    expect(await (await set.route(post(keys.acc1, toolResult))).json()).toEqual({ account: "acc1" })
    const { set: other, served: otherServed } = fakeSet({})
    await other.sync()
    expect(await (await other.route(post(keys.acc2, toolResult))).json()).toEqual({ account: "acc2" })
    expect([served, otherServed].map(list => list.map(entry => entry.account))).toEqual([["acc1"], ["acc2"]])
  })

  it("falls back to the selected account when the holder fails", async () => {
    const { set, served } = fakeSet({ acc3: () => "tool" }, { acc3: 429 })
    await set.sync()
    expect(await (await set.route(post(keys.acc1, toolResult))).json()).toEqual({ account: "acc1" })
    expect(served.map(entry => entry.account)).toEqual(["acc3", "acc1"])
    expect(served[1]!.body).toBe(toolResult)
  })

  it("only moves gateway-key requests between the key's accounts", async () => {
    const { set, served } = fakeSet({ acc3: () => "tool", acc2: () => "tool" })
    await set.sync()
    set.panel.data.keys.push({ id: "gk", name: "gw", prefix: "mk-1111", hash: hashGatewaySecret(GW), scope: "accounts", accounts: ["acc1", "acc2"], enabled: true, createdAt: 0, lastUsedAt: null, requests: 0 })
    expect(await (await set.route(post(GW, toolResult))).json()).toEqual({ account: "acc2" })
    expect(served.map(entry => entry.account)).toEqual(["acc2"])
  })

  it("leaves other paths and a disabled setting alone", async () => {
    const { set, served } = fakeSet({ acc3: () => "tool" })
    await set.sync()
    expect(await (await set.route(post(keys.acc1, "{}", "/v1/messages/count_tokens"))).json()).toEqual({ account: "acc1" })
    process.env.MERIDIAN_AGY_ACCOUNT_AFFINITY = "0"
    cleanups.push(() => { delete process.env.MERIDIAN_AGY_ACCOUNT_AFFINITY })
    expect(await (await set.route(post(keys.acc1, toolResult))).json()).toEqual({ account: "acc1" })
    expect(served.map(entry => entry.account)).toEqual(["acc1", "acc1"])
  })
})

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
describe.skipIf(process.platform === "win32")("AgAccountSet keeps an Antigravity conversation on its account", () => {
  async function twoAccounts() {
    const dir = accountsDir(["acc1", "acc2"])
    const runtimes = new Map<string, AntigravityRuntime>()
    const start = async (config: Partial<ProxyConfig>) => {
      const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10000 })
      runtimes.set(config.apiKey!, runtime)
      const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity", apiKey: config.apiKey }, runtime)
      return { fetch: (request: Request) => Promise.resolve(server.app.fetch(request)), close: () => server.closeBackend(), holds: (c: AgContinuation) => server.holds(c) }
    }
    const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start)
    cleanups.push(() => set.close())
    await set.sync()
    // acc1 finished its live turn; acc2 never started a process or replayed the history.
    const stayed = () => {
      expect(runtimes.get(keys.acc1)!.completed).toBe(1)
      expect(runtimes.get(keys.acc2)!.runs.size + runtimes.get(keys.acc2)!.completed + runtimes.get(keys.acc2)!.failed).toBe(0)
    }
    return { set, stayed }
  }
  it("continues a tool call on the account that made it even when the result arrives with another account's key", async () => {
    const { set, stayed } = await twoAccounts()
    const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
    const first = { model: "fixture-model", max_tokens: 100, tools: [tool], messages: [{ role: "user", content: "Get receipt" }] }
    const reply = await (await set.route(post(keys.acc1, JSON.stringify(first)))).json() as { content: Array<{ type: string; id: string }> }
    const call = reply.content.find(block => block.type === "tool_use")!
    expect(call.id).toMatch(/^toolu_[0-9a-f]{32}$/)
    const continuation = { ...first, messages: [...first.messages, { role: "assistant", content: reply.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "receipt" }] }] }
    const answer = await set.route(post(keys.acc2, JSON.stringify(continuation)))
    expect(answer.status).toBe(200)
    expect(JSON.stringify((await answer.json() as { content: unknown }).content)).toContain("receipt")
    stayed()
  })
  it("does the same for a Chat Completions tool message", async () => {
    const { set, stayed } = await twoAccounts()
    const tools = [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { key: { type: "string" } } } } }]
    const first = { model: "fixture-model", max_tokens: 100, tools, messages: [{ role: "user", content: "Get receipt" }] }
    const reply = await (await set.route(post(keys.acc1, JSON.stringify(first), "/v1/chat/completions"))).json() as { choices: Array<{ message: { role: string; content: string | null; tool_calls: Array<{ id: string }> } }> }
    const message = reply.choices[0]!.message
    const continuation = { ...first, messages: [...first.messages, message, { role: "tool", tool_call_id: message.tool_calls[0]!.id, content: "receipt" }] }
    const answer = await set.route(post(keys.acc2, JSON.stringify(continuation), "/v1/chat/completions"))
    expect(answer.status).toBe(200)
    expect(JSON.stringify(await answer.json())).toContain("receipt")
    stayed()
  })
})
