import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgAdmin } from "../proxy/backends/antigravityAdmin"
import { AgAccountSet } from "../proxy/backends/antigravityAccounts"
import type { ProxyConfig } from "../proxy/types"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step()
})

const TOKEN = "admin-token-0123456789"
const auth = { authorization: `Bearer ${TOKEN}` }

function setup(files: Record<string, string>, options: { sub2?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-accounts-test-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, "env"), text)
  }

  const backendCalls: Array<{ key: string | null; path: string }> = []
  const start = async (config: Partial<ProxyConfig>) => ({
    close: async () => {},
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      backendCalls.push({ key: request.headers.get("x-api-key"), path })
      if (path === "/health") return Response.json({ completed: 10, failed: 0, reused: 5, prewarmed: 1, processes: 2, activeProcesses: 1, spareReady: 1 })
      return Response.json({ providers: [{ id: "antigravity", accounts: [{ fetchedAt: 12345, windows: [{ type: "5h", group: "g", utilization: 0.1, resetsAt: 99999 }] }] }] })
    },
  })
  const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 3)

  const curlCalls: string[][] = []
  const ips: Record<string, string> = {
    "socks5h://u:pw@p1:1": "1.1.1.1",
    "socks5h://p2:1": "2.2.2.2",
    "socks5h://p3:1": "3.3.3.3",
    "socks5h://dup:1": "1.1.1.1",
  }
  const exec = async (_file: string, args: string[]) => {
    curlCalls.push(args)
    const proxyArg = args[4]!
    return ips[proxyArg] ?? ""
  }

  const sub2Items: any[] = [{ id: 10, name: "x", status: "active", notes: "Antigravity Meridian acc1" }]
  const s2Calls: Array<{ url: string; method: string; body?: any }> = []
  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined
    s2Calls.push({ url, method, body })
    if (url.startsWith("http://s2/admin/accounts?")) return Response.json({ code: 0, message: "ok", data: { items: sub2Items } })
    if (url.startsWith("http://s2/admin/accounts/") && method === "PUT") return Response.json({ code: 0, message: "ok", data: {} })
    return new Response("?", { status: 500 })
  }) as unknown as typeof fetch

  const admin = createAgAdmin(set, {
    token: TOKEN,
    baseUrl: "http://127.0.0.1:3451",
    loginScript: "/dev/null",
    exec,
    fetch: fakeFetch,
    sub2api: options.sub2 ? { base: "http://s2", key: "s2key", templateId: 1001 } : undefined,
  })

  const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = auth) =>
    admin.fetch(new Request(`http://local${path}`, { ...init, headers: { ...headers, "content-type": "application/json" } }))
  const get = (path: string, headers: Record<string, string> = auth) => req(path, { method: "GET" }, headers)
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = auth) =>
    req(path, { method: "POST", body: JSON.stringify(body) }, headers)
  const patch = (path: string, body: unknown = {}, headers: Record<string, string> = auth) =>
    req(path, { method: "PATCH", body: JSON.stringify(body) }, headers)
  const del = (path: string, headers: Record<string, string> = auth) => req(path, { method: "DELETE" }, headers)

  return { dir, set, admin, req, get, post, patch, del, curlCalls, s2Calls, backendCalls }
}

const baseAccounts = {
  acc1: "MERIDIAN_API_KEY=secret-key-acc1-0123456789\nALL_PROXY=socks5h://u:pw@p1:1\n",
  acc2: "MERIDIAN_API_KEY=secret-key-acc2-0123456789\nALL_PROXY=socks5h://p2:1\n",
}

describe("Antigravity Enhanced Accounts API", () => {
  it("GET /api/accounts returns label, proxyId, and createdAt", async () => {
    const { get, set } = setup(baseAccounts)
    set.panel.data.labels["acc1"] = "Primary Account"
    set.panel.save()

    const res = await get("/api/accounts")
    expect(res.status).toBe(200)
    const data = await res.json() as { accounts: any[] }
    expect(data.accounts).toHaveLength(2)
    const acc1 = data.accounts[0]
    expect(acc1.name).toBe("acc1")
    expect(acc1.label).toBe("Primary Account")
    expect(acc1.proxyId).toMatch(/^px_[0-9a-f]{8}$/)
    expect(acc1.createdAt).toBeNumber()
  })

  it("POST /api/accounts supports proxyId and label", async () => {
    const { post, get, set } = setup(baseAccounts)
    // Find proxyId of existing auto-imported proxy for acc1
    // Add a new proxy with IP 3.3.3.3 to pool first
    set.panel.data.proxies.push({
      id: "px_pool_test",
      name: "Pool Proxy 3",
      url: "socks5h://p3:1",
      protocol: "socks5h",
      note: "",
      lastTest: null,
      createdAt: Date.now(),
    })
    set.panel.save()

    const res = await post("/api/accounts", {
      proxyId: "px_pool_test",
      label: "Third Account",
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { name: string; exitIp: string; proxyId: string }
    expect(body.name).toBe("acc3")
    expect(body.exitIp).toBe("3.3.3.3")
    expect(body.proxyId).toBe("px_pool_test")

    // Verify label persisted in panel.json
    expect(set.panel.data.labels["acc3"]).toBe("Third Account")

    // Verify in GET /api/accounts
    const accounts = (await (await get("/api/accounts")).json() as any).accounts
    const acc3 = accounts.find((a: any) => a.name === "acc3")
    expect(acc3.label).toBe("Third Account")
    expect(acc3.proxyId).toBe("px_pool_test")
  })

  it("PATCH /api/accounts/:name updates label and switches proxy", async () => {
    const { patch, get, set, dir } = setup(baseAccounts)
    const res = await patch("/api/accounts/acc1", {
      label: "Updated Label",
      proxy: "socks5h://p3:1",
    })
    expect(res.status).toBe(200)
    const updated = await res.json() as any
    expect(updated.label).toBe("Updated Label")
    expect(updated.proxy).toBe("socks5h://p3:1")

    // Verify file on disk
    const envText = readFileSync(join(dir, "acc1", "env"), "utf8")
    expect(envText).toContain("ALL_PROXY=socks5h://p3:1")

    // Duplicate exit IP should fail (dup has 1.1.1.1, but acc2 has 2.2.2.2. If we try to change acc1 to p2:1 which is 2.2.2.2, conflict!)
    const dupRes = await patch("/api/accounts/acc1", { proxy: "socks5h://p2:1" })
    expect(dupRes.status).toBe(409)
  })

  it("DELETE /api/accounts/:name soft-deletes directory, removes label, and mirrors to Sub2API", async () => {
    const { del, get, dir, s2Calls } = setup(baseAccounts, { sub2: true })
    const res = await del("/api/accounts/acc1")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // acc1 directory moved to _deleted
    expect(existsSync(join(dir, "acc1"))).toBe(false)
    const deletedDir = join(dir, "_deleted")
    expect(existsSync(deletedDir)).toBe(true)
    const deletedEntries = readdirSync(deletedDir)
    expect(deletedEntries.some(e => e.startsWith("acc1-"))).toBe(true)

    // Sub2API called with inactive
    expect(s2Calls.some(c => c.method === "PUT" && c.body?.status === "inactive")).toBe(true)

    // Account list should now only have acc2
    const accounts = (await (await get("/api/accounts")).json() as any).accounts
    expect(accounts).toHaveLength(1)
    expect(accounts[0].name).toBe("acc2")
  })

  it("POST /api/accounts/:name/test tests serving account and bypasses cache", async () => {
    const { post, set, backendCalls } = setup(baseAccounts)
    await set.sync()

    const res = await post("/api/accounts/acc1/test")
    expect(res.status).toBe(200)
    const data = await res.json() as any
    expect(data.ok).toBe(true)
    expect(data.exitIp).toBe("1.1.1.1")
    expect(data.latencyMs).toBeGreaterThanOrEqual(1)
    expect(data.health.completed).toBe(10)
    expect(data.quota.fetchedAt).toBe(12345)

    // Check that backend /providers/status was queried
    expect(backendCalls.some(c => c.path === "/providers/status")).toBe(true)

    // If account is not serving, returns ok:false with error
    const nonServingRes = await post("/api/accounts/nonexistent/test")
    expect(nonServingRes.status).toBe(404)
  })
})
