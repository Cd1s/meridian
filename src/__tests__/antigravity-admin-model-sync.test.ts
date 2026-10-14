import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { agModelFamilies, createAgAdmin, syncAgModelMapping } from "../proxy/backends/antigravityAdmin"
import { AgAccountSet } from "../proxy/backends/antigravityAccounts"
import type { ProxyConfig } from "../proxy/types"

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
const TOKEN = "admin-token-0123456789"
const PRO = "secret-key-pro-0123456789", ULTRA = "secret-key-ultra-0123456789", EMPTY = "secret-key-empty-0123456789"
const FLASH = ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"]
const ARGON = ["gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low"]
const TEMPLATE = {
  "gemini-3.1-pro": "gemini-3.1-pro-low", "gemini-3.1-pro-high": "gemini-3.1-pro-high",
  "gemini-3.8-flash": "gemini-3.8-flash-low", "gemini-3.8-flash-low": "gemini-3.8-flash-low",
  "gemini-3.8-flash-medium": "gemini-3.8-flash-medium", "gemini-3.8-flash-high": "gemini-3.8-flash-high",
}
const ARGON_KEYS = { "gemini-4-argon": "gemini-4-argon-low", "gemini-4-argon-low": "gemini-4-argon-low", "gemini-4-argon-medium": "gemini-4-argon-medium", "gemini-4-argon-high": "gemini-4-argon-high" }

describe("syncAgModelMapping", () => {
  it("adds a family the account lists, with the bare name on its lowest effort", () => {
    const { mapping, added, removed } = syncAgModelMapping(TEMPLATE, [...ARGON, ...FLASH, "gpt-oss-120b-medium"], agModelFamilies([...ARGON, ...FLASH]))
    expect(mapping).toEqual({ ...TEMPLATE, ...ARGON_KEYS })
    expect(added.sort()).toEqual(Object.keys(ARGON_KEYS).sort())
    expect(removed).toEqual([])
  })
  it("removes a family other accounts list but this one does not, and leaves unlisted legacy families alone", () => {
    const { mapping, added, removed } = syncAgModelMapping({ ...TEMPLATE, ...ARGON_KEYS }, FLASH, ["gemini-3.8-flash", "gemini-4-argon"])
    expect(mapping).toEqual(TEMPLATE)
    expect(added).toEqual([])
    expect(removed.sort()).toEqual(Object.keys(ARGON_KEYS).sort())
    expect(mapping["gemini-3.1-pro"]).toBe("gemini-3.1-pro-low")
  })
  it("keeps existing values and maps a new bare name to the lowest listed effort", () => {
    const custom = { ...TEMPLATE, "gemini-3.8-flash": "gemini-3.8-flash-high" }
    expect(syncAgModelMapping(custom, FLASH, ["gemini-3.8-flash"]).mapping).toEqual(custom)
    expect(syncAgModelMapping({}, ["gemini-9-pro-high", "gemini-9-pro-medium"], ["gemini-9-pro"]).mapping)
      .toEqual({ "gemini-9-pro": "gemini-9-pro-medium", "gemini-9-pro-medium": "gemini-9-pro-medium", "gemini-9-pro-high": "gemini-9-pro-high" })
  })
  it("removes an excluded family even though the account lists it", () => {
    const { mapping, added, removed } = syncAgModelMapping({ ...TEMPLATE, ...ARGON_KEYS }, [...ARGON, ...FLASH], ["gemini-3.8-flash", "gemini-4-argon"], ["gemini-3.8-flash"])
    expect(mapping).toEqual({ "gemini-3.1-pro": "gemini-3.1-pro-low", "gemini-3.1-pro-high": "gemini-3.1-pro-high", ...ARGON_KEYS })
    expect(added).toEqual([])
    expect(removed.sort()).toEqual(["gemini-3.8-flash", "gemini-3.8-flash-high", "gemini-3.8-flash-low", "gemini-3.8-flash-medium"])
  })
  it("only treats gemini effort slugs as families", () => {
    expect(agModelFamilies(["gpt-oss-120b-medium", "claude-opus-5-5-high", "gemini-3.8-live", ...ARGON, ...FLASH])).toEqual(["gemini-3.8-flash", "gemini-4-argon"])
  })
})

function setup(options: { sub2: boolean; exclude?: Record<string, string[]>; ultraMapping?: Record<string, string> }) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-model-sync-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, key] of [["acc1", PRO], ["acc2", ULTRA], ["acc3", EMPTY]] as const) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "env"), `MERIDIAN_API_KEY=${key}\n`) }
  const lists: Record<string, string[]> = { [PRO]: FLASH, [ULTRA]: [...ARGON, ...FLASH], [EMPTY]: FLASH }
  const start = async (config: Partial<ProxyConfig>) => ({
    close: async () => {},
    fetch: async (request: Request) => new URL(request.url).pathname === "/v1/models"
      ? Response.json({ object: "list", data: (lists[config.apiKey!] ?? []).map(id => ({ id, type: "model" })) })
      : new Response("?", { status: 404 }),
  })
  const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 3)
  cleanup.push(() => set.close())
  const sub2 = (data: unknown) => Response.json({ code: 0, message: "ok", data })
  const details: Record<number, any> = {
    11: { credentials: { base_url: "http://127.0.0.1:3451", model_mapping: { ...TEMPLATE, ...ARGON_KEYS } } },
    12: { credentials: { base_url: "http://127.0.0.1:3451", model_mapping: options.ultraMapping ?? { ...TEMPLATE } } },
    13: { credentials: { base_url: "http://127.0.0.1:3451", model_mapping: {} } },
  }
  const calls: Array<{ url: string; method: string; body?: any }> = []
  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method, body })
    if (url.startsWith("http://s2/admin/accounts?")) return sub2({ items: [11, 12, 13].map(id => ({ id, status: "active", notes: `Antigravity Meridian acc${id - 10}` })) })
    const id = Number(/\/admin\/accounts\/(\d+)$/.exec(url)?.[1])
    if (details[id] && method === "GET") return sub2(details[id])
    if (details[id] && method === "PUT") return sub2({})
    return new Response("?", { status: 500 })
  }) as unknown as typeof fetch
  const admin = createAgAdmin(set, {
    token: TOKEN, baseUrl: "http://127.0.0.1:3451", loginScript: "/nonexistent", fetch: fakeFetch,
    sub2api: options.sub2 ? { base: "http://s2", key: "s2key", templateId: 11 } : undefined,
    modelSyncExclude: options.exclude,
  })
  const post = (path: string) => admin.fetch(new Request(`http://local${path}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: "{}" }))
  return { set, calls, post }
}

describe("POST /api/sub2api/models", () => {
  it("routes a family only to the accounts that list it and leaves empty mappings alone", async () => {
    const { set, calls, post } = setup({ sub2: true })
    await set.sync()
    const response = await post("/api/sub2api/models")
    expect(response.status).toBe(200)
    const result = await response.json() as any
    expect(result.families).toEqual(["gemini-3.8-flash", "gemini-4-argon"])
    const puts = calls.filter(call => call.method === "PUT")
    expect(puts.map(call => call.url).sort()).toEqual(["http://s2/admin/accounts/11", "http://s2/admin/accounts/12"])
    // acc1 (Pro) loses the stale Argon keys; acc2 (Ultra) gains them. Both keep their key and base URL.
    expect(puts.find(call => call.url.endsWith("/11"))!.body).toEqual({ credentials: { base_url: "http://127.0.0.1:3451", api_key: PRO, model_mapping: TEMPLATE } })
    expect(puts.find(call => call.url.endsWith("/12"))!.body).toEqual({ credentials: { base_url: "http://127.0.0.1:3451", api_key: ULTRA, model_mapping: { ...TEMPLATE, ...ARGON_KEYS } } })
    expect(result.results.map((r: any) => [r.name, r.added.length, r.removed.length]).sort()).toEqual([["acc1", 0, 4], ["acc2", 4, 0]])
    expect(JSON.stringify(result)).not.toContain("secret-key")
  })
  it("keeps an excluded family off an account that lists it", async () => {
    const { set, calls, post } = setup({ sub2: true, exclude: { acc2: ["gemini-3.8-flash"] } })
    await set.sync()
    await post("/api/sub2api/models")
    const ultra = calls.find(call => call.method === "PUT" && call.url.endsWith("/12"))!.body.credentials.model_mapping
    expect(ultra).toEqual({ "gemini-3.1-pro": "gemini-3.1-pro-low", "gemini-3.1-pro-high": "gemini-3.1-pro-high", ...ARGON_KEYS })
  })
  it("never leaves an empty mapping, which Sub2API reads as every model", async () => {
    const flashOnly = { "gemini-3.8-flash": "gemini-3.8-flash-low", "gemini-3.8-flash-low": "gemini-3.8-flash-low" }
    const { set, calls, post } = setup({ sub2: true, exclude: { acc2: ["gemini-3.8-flash", "gemini-4-argon"] }, ultraMapping: flashOnly })
    await set.sync()
    const result = await (await post("/api/sub2api/models")).json() as any
    expect(calls.some(call => call.method === "PUT" && call.url.endsWith("/12"))).toBe(false)
    expect(result.results.find((r: any) => r.name === "acc2").error).toContain("empty model mapping")
  })
  it("refuses without Sub2API", async () => {
    const { set, post } = setup({ sub2: false })
    await set.sync()
    expect((await post("/api/sub2api/models")).status).toBe(409)
  })
})
