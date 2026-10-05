import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
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

function setup(options: { sub2?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-overview-test-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

  mkdirSync(join(dir, "acc1"))
  writeFileSync(join(dir, "acc1", "env"), "MERIDIAN_API_KEY=secret-key-acc1-0123456789\nALL_PROXY=socks5h://p1:1\n")

  mkdirSync(join(dir, "acc2"))
  writeFileSync(join(dir, "acc2", "env"), "MERIDIAN_API_KEY=secret-key-acc2-0123456789\nALL_PROXY=socks5h://p2:1\n")

  mkdirSync(join(dir, "acc3"))
  writeFileSync(join(dir, "acc3", "env.disabled"), "MERIDIAN_API_KEY=secret-key-acc3-0123456789\nALL_PROXY=socks5h://p3:1\n")

  const start = async (config: Partial<ProxyConfig>) => ({
    close: async () => {},
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      if (path === "/health") {
        if (config.apiKey === "secret-key-acc1-0123456789") {
          return Response.json({ completed: 5, failed: 1, reused: 2 })
        }
        return Response.json({ completed: 15, failed: 2, reused: 8 })
      }
      return new Response("ok")
    },
  })

  const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 4)

  const admin = createAgAdmin(set, {
    token: TOKEN,
    baseUrl: "http://127.0.0.1:3451",
    version: "2.1.0-test",
    loginScript: "/dev/null",
    sub2api: options.sub2 ? { base: "http://s2", key: "s2key", templateId: 1001 } : undefined,
  })

  const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = auth) =>
    admin.fetch(new Request(`http://local${path}`, { ...init, headers: { ...headers, "content-type": "application/json" } }))
  const get = (path: string, headers: Record<string, string> = auth) => req(path, { method: "GET" }, headers)

  return { dir, set, admin, req, get }
}

describe("Antigravity Overview, Session, and Settings API", () => {
  it("GET /api/session returns version and features", async () => {
    const { get } = setup({ sub2: true })
    const res = await get("/api/session")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      version: "2.1.0-test",
      features: { sub2api: true },
    })
  })

  it("GET /api/settings returns settings and sub2api config", async () => {
    const { get, dir } = setup({ sub2: true })
    const res = await get("/api/settings")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      version: "2.1.0-test",
      baseUrl: "http://127.0.0.1:3451",
      pool: { max: 4 },
      sub2api: {
        enabled: true,
        base: "http://s2",
        templateId: 1001,
      },
      accountsDir: dir,
    })
  })

  it("GET /api/overview returns aggregated stats, traffic sum, and proxies/keys counts", async () => {
    const { get, set } = setup({ sub2: false })
    await set.sync()

    // Add an unused proxy with test status
    set.panel.data.proxies.push({
      id: "px_unused",
      name: "Unused Proxy",
      url: "socks5h://unused:1",
      protocol: "socks5h",
      note: "",
      lastTest: { ok: true, exitIp: "9.9.9.9", latencyMs: 50, at: 1000, error: null },
      createdAt: 1000,
    })

    // Add a failed proxy
    set.panel.data.proxies.push({
      id: "px_failed",
      name: "Failed Proxy",
      url: "socks5h://failed:1",
      protocol: "socks5h",
      note: "",
      lastTest: { ok: false, exitIp: null, latencyMs: 500, at: 1000, error: "timeout" },
      createdAt: 1000,
    })

    // Add keys: one enabled, one disabled
    set.panel.data.keys.push({
      id: "key_1",
      name: "Key 1",
      prefix: "mk-1111…",
      hash: "hash1",
      scope: "all",
      accounts: [],
      enabled: true,
      createdAt: 1000,
      lastUsedAt: null,
      requests: 10,
    })
    set.panel.data.keys.push({
      id: "key_2",
      name: "Key 2",
      prefix: "mk-2222…",
      hash: "hash2",
      scope: "all",
      accounts: [],
      enabled: false,
      createdAt: 1000,
      lastUsedAt: null,
      requests: 0,
    })

    const res = await get("/api/overview")
    expect(res.status).toBe(200)
    const data = await res.json() as any

    expect(data.version).toBe("2.1.0-test")
    expect(data.pool).toEqual({ max: 4 })
    expect(data.sub2api).toEqual({ enabled: false })

    // Accounts: acc1 (serving), acc2 (serving), acc3 (disabled)
    expect(data.accounts).toEqual({
      total: 3,
      serving: 2,
      error: 0,
      disabled: 1,
    })

    // Traffic: acc1 (5 completed, 1 failed, 2 reused) + acc2 (15 completed, 2 failed, 8 reused) = 20, 3, 10
    expect(data.traffic).toEqual({
      completed: 20,
      failed: 3,
      reused: 10,
    })

    // Proxies: 3 auto-imported from acc1, acc2, acc3 + 1 unused ok + 1 failed = 5 total
    // ok: 1 (px_unused)
    // failed: 1 (px_failed)
    // untested: 3 (acc1, acc2, acc3 proxies)
    // unused: 2 (px_unused, px_failed)
    expect(data.proxies).toEqual({
      total: 5,
      ok: 1,
      failed: 1,
      untested: 3,
      unused: 2,
    })

    // Keys: 2 total, 1 enabled
    expect(data.keys).toEqual({
      total: 2,
      enabled: 1,
    })
  })
})
