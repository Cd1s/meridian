import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AgAccountSet, parseAgEnvFile, readAgAccounts, startAgBackend } from "../proxy/backends/antigravityAccounts"
import { AgProcessPool, AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG, type ProxyConfig } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const initial = (content = "Get receipt") => ({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content }], tools: [tool] })
const K1 = "key-account-one-0001", K2 = "key-account-two-0002", K3 = "key-account-three-003"
const cleanup: Array<() => unknown> = []
const fakeBackend = (key: string, closed: string[] = []) => ({ fetch: async () => new Response(key), close: async () => { closed.push(key) } })
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

function account(options: Record<string, unknown> = {}, config: Partial<ProxyConfig> = {}) {
  const runtime = new AntigravityRuntime({ executable, reuseConversations: false, allowToolBridge: true, turnTimeoutMs: 10000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity", ...config }, runtime)
  cleanup.push(server.closeBackend)
  const send = (body: unknown, headers: Record<string, string> = {}) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body), headers }))
  return { runtime, send }
}
async function until(done: () => boolean) {
  const deadline = Date.now() + 5000
  while (!done()) {
    if (Date.now() > deadline) throw new Error("Condition not reached")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
function accountsDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-accounts-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "env"), text) }
  return dir
}

describe("Antigravity multi-account process", () => {
  it("parses account env files into per-account agy environments", () => {
    expect(parseAgEnvFile('# c\nexport A="1"\nB=\'two\'\nC=x=y\nbad line\n')).toEqual({ A: "1", B: "two", C: "x=y" })
    const dir = accountsDir({
      acc2: `MERIDIAN_API_KEY=${K2}\nALL_PROXY=socks5h://p2:1\n`,
      acc1: `MERIDIAN_PORT=3451\nMERIDIAN_API_KEY=${K1}\nHTTPS_PROXY=socks5h://p1:1\nMERIDIAN_AGY_STATE_PATH=/s1\n`,
    })
    mkdirSync(join(dir, "empty"))
    const [first, second] = readAgAccounts(dir).accounts
    expect(readAgAccounts(dir).accounts.map(a => a.name)).toEqual(["acc1", "acc2"])
    expect(first).toMatchObject({ apiKey: K1, statePath: "/s1", env: { HOME: join(dir, "acc1"), TMPDIR: join(dir, "acc1", ".tmp"), HTTPS_PROXY: "socks5h://p1:1" } })
    expect(Object.keys(first!.env).some(key => key.startsWith("MERIDIAN_"))).toBe(false)
    expect(second).toMatchObject({ env: { HOME: join(dir, "acc2"), ALL_PROXY: "socks5h://p2:1" } })
  })
  it("skips only the accounts without a long enough key or sharing a key", () => {
    const result = readAgAccounts(accountsDir({ a: "ALL_PROXY=x\n", b: "MERIDIAN_API_KEY=short\n", c: `MERIDIAN_API_KEY=${K1}\n`, d: `MERIDIAN_API_KEY=${K1}\n`, e: `MERIDIAN_API_KEY=${K2}\n` }))
    expect(result.accounts.map(a => a.name)).toEqual(["e"])
    expect([...result.invalid.keys()]).toEqual(["a", "b", "c", "d"])
    expect(result.invalid.get("b")).toContain("16 characters")
    expect(result.invalid.get("c")).toBe("c and d use the same MERIDIAN_API_KEY")
  })
  it("starts, restarts and stops only the accounts whose files changed", async () => {
    const dir = accountsDir({ acc1: `MERIDIAN_API_KEY=${K1}\n`, acc2: `MERIDIAN_API_KEY=${K2}\n` })
    const configs: Array<Partial<ProxyConfig>> = [], closed: string[] = []
    const start = async (config: Partial<ProxyConfig>) => { configs.push(config); return fakeBackend(config.apiKey!, closed) }
    const set = new AgAccountSet(dir, { host: "127.0.0.1", antigravity: { statePath: "/shared" } }, start, 3)
    expect(await set.sync()).toEqual({ started: ["acc1", "acc2"], stopped: [], failed: [] })
    expect(configs[0]).toMatchObject({ backend: "antigravity", apiKey: K1, antigravity: { env: { HOME: join(dir, "acc1") }, statePath: undefined, pool: set.pool } })
    expect(configs[0]!.port).toBeUndefined()
    writeFileSync(join(dir, "acc2", "env"), `MERIDIAN_API_KEY=${K2}b\n`)
    mkdirSync(join(dir, "acc3")); writeFileSync(join(dir, "acc3", "env"), `MERIDIAN_API_KEY=${K3}\n`)
    expect(await set.sync()).toEqual({ started: ["acc2", "acc3"], stopped: ["acc2"], failed: [] })
    expect(set.failures.size).toBe(0)
    rmSync(join(dir, "acc1"), { recursive: true })
    expect(await set.sync()).toEqual({ started: [], stopped: ["acc1"], failed: [] })
    mkdirSync(join(dir, "acc4")); writeFileSync(join(dir, "acc4", "env"), `MERIDIAN_API_KEY=${K2}b\n`)
    // acc2 and acc4 now share a key: both stop and are reported, acc3 keeps serving.
    expect(await set.sync()).toEqual({ started: [], stopped: ["acc2"], failed: ["acc2", "acc4"] })
    expect(set.names).toEqual(["acc3"])
    expect(set.failures.get("acc4")).toBe("acc2 and acc4 use the same MERIDIAN_API_KEY")
    rmSync(join(dir, "acc4"), { recursive: true })
    expect(await set.sync()).toEqual({ started: ["acc2"], stopped: [], failed: [] })
    expect(set.failures.size).toBe(0)
    await set.close()
    expect(closed).toEqual([K2, K1, K2 + "b", K3, K2 + "b"])
  })
  it("records accounts that fail to start and recovers them on a later sync", async () => {
    const dir = accountsDir({ acc1: `MERIDIAN_API_KEY=${K1}\n`, acc2: `MERIDIAN_API_KEY=${K2}\n` })
    let broken = true
    const start = async (config: Partial<ProxyConfig>) => {
      if (config.apiKey === K2 && broken) throw new Error("401 UNAUTHENTICATED")
      return fakeBackend(config.apiKey!)
    }
    const set = new AgAccountSet(dir, {}, start)
    expect(await set.sync()).toEqual({ started: ["acc1"], stopped: [], failed: ["acc2"] })
    expect([...set.failures]).toEqual([["acc2", "401 UNAUTHENTICATED"]])
    broken = false
    expect(await set.sync()).toEqual({ started: ["acc2"], stopped: [], failed: [] })
    expect(set.failures.size).toBe(0)
    await set.close()
  })
  it("keeps syncing when a stale backend fails to close", async () => {
    const dir = accountsDir({ acc1: `MERIDIAN_API_KEY=${K1}\n`, acc2: `MERIDIAN_API_KEY=${K2}\n` })
    const set = new AgAccountSet(dir, {}, async config => ({ fetch: async () => new Response(config.apiKey), close: async () => { if (config.apiKey === K1) throw new Error("stuck") } }))
    await set.sync()
    writeFileSync(join(dir, "acc1", "env"), `MERIDIAN_API_KEY=${K3}\n`)
    expect(await set.sync()).toEqual({ started: ["acc1"], stopped: ["acc1"], failed: [] })
    expect(await (await set.route(new Request("http://local/", { headers: { "x-api-key": K3 } }))).text()).toBe(K3)
    await set.close()
  })
  it("routes each request to the account whose API key it carries", async () => {
    const dir = accountsDir({ acc1: `MERIDIAN_API_KEY=${K1}\n`, acc2: `MERIDIAN_API_KEY=${K2}\n` })
    const set = new AgAccountSet(dir, {}, async config => fakeBackend(config.apiKey!))
    await set.sync()
    const call = async (headers: Record<string, string>, path = "/v1/messages") => { const r = await set.route(new Request("http://local" + path, { method: "POST", headers })); return [r.status, await r.text()] }
    expect(await call({ "x-api-key": K1 })).toEqual([200, K1])
    expect(await call({ authorization: `Bearer ${K2}` })).toEqual([200, K2])
    expect((await call({ "x-api-key": "unknown-key-0000000000" }))[0]).toBe(401)
    expect((await call({}))[0]).toBe(401)
    expect(JSON.parse((await call({}, "/health"))[1] as string)).toMatchObject({ status: "healthy", accounts: 2, failed: 0 })
    expect(await (await set.request("acc2", "/health"))!.text()).toBe(K2)
    expect(await set.request("acc9", "/health")).toBeUndefined()
    rmSync(join(dir, "acc1"), { recursive: true })
    await set.sync()
    expect((await call({ "x-api-key": K1 }))[0]).toBe(401)
    await set.close()
  })
  it("serves two real accounts from one listener by key", async () => {
    const dir = accountsDir({ acc1: `MERIDIAN_API_KEY=${K1}\n`, acc2: `MERIDIAN_API_KEY=${K2}\n` })
    const set = new AgAccountSet(dir, { antigravity: { executable, reuseConversations: false } }, startAgBackend)
    cleanup.push(() => set.close())
    expect(await set.sync()).toMatchObject({ started: ["acc1", "acc2"], failed: [] })
    for (const key of [K1, K2]) {
      const response = await set.route(new Request("http://local/v1/messages", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ ...initial("hello"), tools: [] }) }))
      expect(response.status).toBe(200)
    }
    const wrong = await set.route(new Request("http://local/v1/messages", { method: "POST", headers: { "x-api-key": K3 }, body: "{}" }))
    expect(wrong.status).toBe(401)
  })
  it("gives each account its own agy environment and API key", async () => {
    const { runtime, send } = account({ env: { HOME: "/accounts/a", ALL_PROXY: "socks5h://a:1", MERIDIAN_API_KEY: "leak" } }, { apiKey: "key-a" })
    expect(runtime.childEnv).toMatchObject({ HOME: "/accounts/a", ALL_PROXY: "socks5h://a:1" })
    expect(runtime.childEnv.MERIDIAN_API_KEY).toBeUndefined()
    expect((await send({ ...initial(), tools: [] })).status).toBe(401)
    expect((await send({ ...initial(), tools: [] }, { "x-api-key": "key-b" })).status).toBe(401)
    expect((await send({ ...initial(), tools: [] }, { authorization: "Bearer key-a" })).status).toBe(200)
  })
  it("rejects a blocked model before it can reclaim another account's idle process", async () => {
    const pool = new AgProcessPool(1)
    const a = account({ pool }), b = account({ pool })
    expect((await a.send(initial())).status).toBe(200)
    expect(pool.used).toBe(1)
    const blocked = await b.send({ ...initial(), model: "claude-sonnet-4-6", tools: [] })
    expect(blocked.status).toBe(400)
    expect(await blocked.text()).toContain("blocked on Antigravity runtime")
    expect(a.runtime.reclaimed).toBe(0)
    expect(pool.used).toBe(1)
  })
  it("lets a full shared pool take another account's idle process but never an active one", async () => {
    const pool = new AgProcessPool(1)
    const a = account({ pool }), b = account({ pool })
    expect(pool.runtimes.size).toBe(2)
    expect((await a.send(initial())).status).toBe(200)
    const idle = [...a.runtime.runs.values()][0]!
    expect(pool.used).toBe(1)
    expect((await b.send({ ...initial(), tools: [] })).status).toBe(200)
    await idle.settled
    expect(a.runtime.reclaimed).toBe(1)
    const active = a.send({ ...initial("HANG"), tools: [] })
    const deadline = Date.now() + 3000
    while (![...a.runtime.runs.values()].some(run => run.child?.pid)) {
      if (Date.now() > deadline) throw new Error("Active fixture process did not start")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect((await b.send({ ...initial(), tools: [] })).status).toBe(429)
    await a.runtime.close()
    expect(pool.runtimes.size).toBe(1)
    expect([502, 503]).toContain((await active).status)
  })
  it("adopts a pre-started agy for the next new conversation of the same shape", async () => {
    const { runtime, send } = account({ prewarmIdleMs: 60_000 })
    expect((await send({ ...initial("first"), tools: [] })).status).toBe(200)
    await until(() => runtime.spareReady)
    const reply = await send({ ...initial("second"), tools: [] })
    expect(reply.status).toBe(200)
    expect(runtime.prewarmed).toBe(1)
    expect(((await reply.json()) as { content: Array<{ text?: string }> }).content[0]!.text).toBeTruthy()
    await until(() => runtime.spareReady)
    expect(runtime.mcpAliases.size).toBe(0)
  })
  it("binds client tools to an adopted process through its MCP alias", async () => {
    const { runtime, send } = account({ prewarmIdleMs: 60_000 })
    expect((await send(initial("tools one"))).status).toBe(200)
    await until(() => runtime.spareReady)
    const reply = await send(initial("tools two"))
    expect(reply.status).toBe(200)
    expect(((await reply.json()) as { content: Array<{ type: string; name?: string }> }).content).toContainEqual(expect.objectContaining({ type: "tool_use", name: "lookup" }))
    expect(runtime.prewarmed).toBe(1)
  })
  it("never adopts a process started for another model or with prewarm disabled", async () => {
    const { runtime, send } = account({ prewarmIdleMs: 60_000 })
    expect((await send({ ...initial(), tools: [] })).status).toBe(200)
    await until(() => runtime.spareReady)
    expect((await send({ ...initial(), model: "fixture-model-high", tools: [] })).status).toBe(200)
    expect(runtime.prewarmed).toBe(0)
    await until(() => runtime.spareReady)
    expect((await send({ ...initial("again"), model: "fixture-model-high", tools: [] })).status).toBe(200)
    expect(runtime.prewarmed).toBe(1)
    const off = account()
    expect((await off.send({ ...initial(), tools: [] })).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect([off.runtime.spareReady, off.runtime.spareCount]).toEqual([false, 0])
  })
  it("retires the pre-started process after the idle window and on close", async () => {
    const { runtime, send } = account({ prewarmIdleMs: 400 })
    expect((await send({ ...initial(), tools: [] })).status).toBe(200)
    await until(() => runtime.spareReady)
    const spare = (runtime as any).spare
    await new Promise(resolve => setTimeout(resolve, 450))
    await runtime.refillSpare()
    await spare.done
    expect([runtime.spareReady, spare.child.exitCode !== null || spare.child.signalCode !== null]).toEqual([false, true])
    const other = account({ prewarmIdleMs: 60_000 })
    expect((await other.send({ ...initial(), tools: [] })).status).toBe(200)
    await until(() => other.runtime.spareReady)
    const kept = (other.runtime as any).spare
    await other.runtime.close()
    await kept.done
    expect(kept.closed).toBeDefined()
  })
  it("gives a pre-started process up when the shared pool is needed for a request", async () => {
    const pool = new AgProcessPool(1)
    const a = account({ pool, prewarmIdleMs: 60_000 }), b = account({ pool })
    expect((await a.send({ ...initial(), tools: [] })).status).toBe(200)
    await until(() => a.runtime.spareReady)
    expect(pool.used).toBe(1)
    expect((await b.send({ ...initial(), tools: [] })).status).toBe(200)
    expect(a.runtime.prewarmed).toBe(0)
  })
  it("starts the fallback level without changing the conversation's model, so it can continue", async () => {
    const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10000 })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    cleanup.push(server.closeBackend)
    runtime.availableModels = async () => ["gemini-fixture-low", "gemini-fixture-high"]
    const send = (body: unknown) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body) }))
    const first = { model: "gemini-fixture-medium", max_tokens: 100, output_config: { effort: "medium" }, messages: [{ role: "user", content: "one" }] }
    const reply = await send(first)
    expect(reply.status).toBe(200)
    const run = [...runtime.runs.values()][0]!
    expect([run.request.model, run.launch.model, run.launch.effort]).toEqual(["gemini-fixture-medium", "gemini-fixture-high", "high"])
    const content = ((await reply.json()) as { content: unknown }).content
    expect((await send({ ...first, messages: [...first.messages, { role: "assistant", content }, { role: "user", content: "two" }] })).status).toBe(200)
    expect(runtime.reused).toBe(1)
  })
  it("rejects invalid prewarm times", () => {
    for (const prewarmIdleMs of [-1, 1.5]) expect(() => new AntigravityRuntime({ prewarmIdleMs })).toThrow("prewarm")
  })
  it("rejects invalid pool sizes", () => {
    for (const size of [0, -1, 1.5]) expect(() => new AgProcessPool(size)).toThrow("pool size")
  })
})
