import { afterEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AgAccountSet, parseAgEnvFile, readAgAccounts } from "../proxy/backends/antigravityAccounts"
import { AgProcessPool, AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { DEFAULT_PROXY_CONFIG, type ProxyConfig, type ProxyInstance } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const tool = { name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }
const initial = (content = "Get receipt") => ({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content }], tools: [tool] })
const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

function account(options: Record<string, unknown> = {}, config: Partial<ProxyConfig> = {}) {
  const runtime = new AntigravityRuntime({ executable, reuseConversations: false, allowToolBridge: true, turnTimeoutMs: 10000, ...options })
  const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity", ...config }, runtime)
  cleanup.push(server.closeBackend)
  const send = (body: unknown, headers: Record<string, string> = {}) => server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(body), headers }))
  return { runtime, send }
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
      acc2: "MERIDIAN_PORT=3452\nMERIDIAN_API_KEY=k2\nALL_PROXY=socks5h://p2:1\n",
      acc1: "MERIDIAN_PORT=3451\nMERIDIAN_API_KEY=k1\nHTTPS_PROXY=socks5h://p1:1\nMERIDIAN_AGY_STATE_PATH=/s1\n",
    })
    mkdirSync(join(dir, "empty"))
    const [first, second] = readAgAccounts(dir)
    expect(readAgAccounts(dir).map(a => a.name)).toEqual(["acc1", "acc2"])
    expect(first).toMatchObject({ port: 3451, apiKey: "k1", statePath: "/s1", env: { HOME: join(dir, "acc1"), HTTPS_PROXY: "socks5h://p1:1" } })
    expect(Object.keys(first!.env).some(key => key.startsWith("MERIDIAN_"))).toBe(false)
    expect(second).toMatchObject({ port: 3452, env: { HOME: join(dir, "acc2"), ALL_PROXY: "socks5h://p2:1" } })
  })
  it("rejects accounts without a key, with a bad port, or sharing a port", () => {
    expect(() => readAgAccounts(accountsDir({ a: "MERIDIAN_PORT=1\n" }))).toThrow("MERIDIAN_API_KEY")
    expect(() => readAgAccounts(accountsDir({ a: "MERIDIAN_PORT=x\nMERIDIAN_API_KEY=k\n" }))).toThrow("MERIDIAN_PORT")
    expect(() => readAgAccounts(accountsDir({ a: "MERIDIAN_PORT=9\nMERIDIAN_API_KEY=k\n", b: "MERIDIAN_PORT=9\nMERIDIAN_API_KEY=j\n" }))).toThrow("both use port 9")
  })
  it("starts, restarts and stops only the accounts whose files changed", async () => {
    const dir = accountsDir({ acc1: "MERIDIAN_PORT=3451\nMERIDIAN_API_KEY=k1\n", acc2: "MERIDIAN_PORT=3452\nMERIDIAN_API_KEY=k2\n" })
    const configs: Array<Partial<ProxyConfig>> = [], closed: number[] = []
    const start = async (config: Partial<ProxyConfig>) => {
      configs.push(config)
      const server = Object.assign(new EventEmitter(), { listening: true })
      return { server, config: { ...DEFAULT_PROXY_CONFIG, ...config }, close: async () => { closed.push(config.port!) } } as unknown as ProxyInstance
    }
    const set = new AgAccountSet(dir, { host: "127.0.0.1", antigravity: { statePath: "/shared" } }, start, 3)
    expect(await set.sync()).toEqual({ started: ["acc1", "acc2"], stopped: [], failed: [] })
    expect(configs[0]).toMatchObject({ backend: "antigravity", port: 3451, apiKey: "k1", antigravity: { env: { HOME: join(dir, "acc1") }, statePath: undefined, pool: set.pool } })
    writeFileSync(join(dir, "acc2", "env"), "MERIDIAN_PORT=3452\nMERIDIAN_API_KEY=k2b\n")
    mkdirSync(join(dir, "acc3")); writeFileSync(join(dir, "acc3", "env"), "MERIDIAN_PORT=3453\nMERIDIAN_API_KEY=k3\n")
    expect(await set.sync()).toEqual({ started: ["acc2", "acc3"], stopped: ["acc2"], failed: [] })
    rmSync(join(dir, "acc1"), { recursive: true })
    expect(await set.sync()).toEqual({ started: [], stopped: ["acc1"], failed: [] })
    writeFileSync(join(dir, "acc3", "env"), "MERIDIAN_PORT=3452\nMERIDIAN_API_KEY=k3\n")
    await expect(set.sync()).rejects.toThrow("both use port")
    expect(set.names).toEqual(["acc2", "acc3"])
    await set.close()
    expect(closed).toEqual([3452, 3451, 3452, 3453])
  })
  it("gives each account its own agy environment and API key", async () => {
    const { runtime, send } = account({ env: { HOME: "/accounts/a", ALL_PROXY: "socks5h://a:1", MERIDIAN_API_KEY: "leak" } }, { apiKey: "key-a" })
    expect(runtime.childEnv).toMatchObject({ HOME: "/accounts/a", ALL_PROXY: "socks5h://a:1" })
    expect(runtime.childEnv.MERIDIAN_API_KEY).toBeUndefined()
    expect((await send({ ...initial(), tools: [] })).status).toBe(401)
    expect((await send({ ...initial(), tools: [] }, { "x-api-key": "key-b" })).status).toBe(401)
    expect((await send({ ...initial(), tools: [] }, { authorization: "Bearer key-a" })).status).toBe(200)
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
  it("rejects invalid pool sizes", () => {
    for (const size of [0, -1, 1.5]) expect(() => new AgProcessPool(size)).toThrow("pool size")
  })
})
