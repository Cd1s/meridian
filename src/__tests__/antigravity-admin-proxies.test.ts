import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgAdmin } from "../proxy/backends/antigravityAdmin"
import { AgAccountSet } from "../proxy/backends/antigravityAccounts"
import type { ProxyConfig } from "../proxy/types"
import type { AdminProxy } from "../proxy/backends/antigravityPanelStore"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step()
})

const TOKEN = "admin-token-0123456789"
const auth = { authorization: `Bearer ${TOKEN}` }

function setup(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-proxies-test-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, "env"), text)
  }

  const syncCalls: string[] = []
  const start = async (_config: Partial<ProxyConfig>) => ({
    close: async () => {},
    fetch: async (_request: Request) => new Response("ok"),
  })
  const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 3)

  const curlCalls: string[][] = []
  const ips: Record<string, string> = {
    "socks5h://u:pw@p1:1": "1.1.1.1",
    "socks5h://p2:1": "2.2.2.2",
    "socks5h://new:1": "3.3.3.3",
    "http://valid:8080": "4.4.4.4",
  }
  const exec = async (_file: string, args: string[]) => {
    curlCalls.push(args)
    const proxyArg = args[4]!
    return ips[proxyArg] ?? ""
  }

  const admin = createAgAdmin(set, {
    token: TOKEN,
    baseUrl: "http://127.0.0.1:3451",
    loginScript: "/dev/null",
    exec,
  })

  const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = auth) =>
    admin.fetch(new Request(`http://local${path}`, { ...init, headers: { ...headers, "content-type": "application/json" } }))
  const get = (path: string, headers: Record<string, string> = auth) => req(path, { method: "GET" }, headers)
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = auth) =>
    req(path, { method: "POST", body: JSON.stringify(body) }, headers)
  const patch = (path: string, body: unknown = {}, headers: Record<string, string> = auth) =>
    req(path, { method: "PATCH", body: JSON.stringify(body) }, headers)
  const del = (path: string, headers: Record<string, string> = auth) => req(path, { method: "DELETE" }, headers)

  return { dir, set, admin, req, get, post, patch, del, curlCalls }
}

const baseAccounts = {
  acc1: "MERIDIAN_API_KEY=secret-key-acc1-0123456789\nALL_PROXY=socks5h://u:pw@p1:1\n",
  acc2: "MERIDIAN_API_KEY=secret-key-acc2-0123456789\nALL_PROXY=socks5h://p2:1\n",
}

describe("Antigravity Proxy Pool API", () => {
  it("requires authorization on /api/proxies", async () => {
    const { get } = setup(baseAccounts)
    expect((await get("/api/proxies", {})).status).toBe(401)
  })

  it("lists auto-imported proxies with masked url and usedBy", async () => {
    const { get } = setup(baseAccounts)
    const res = await get("/api/proxies")
    expect(res.status).toBe(200)
    const data = await res.json() as { proxies: AdminProxy[] }
    expect(data.proxies).toHaveLength(2)

    const p1 = data.proxies.find(p => p.name === "acc1 proxy")
    expect(p1).toBeDefined()
    expect(p1?.url).toBe("socks5h://u:***@p1:1")
    expect(p1?.protocol).toBe("socks5h")
    expect(p1?.usedBy).toEqual(["acc1"])

    const p2 = data.proxies.find(p => p.name === "acc2 proxy")
    expect(p2).toBeDefined()
    expect(p2?.url).toBe("socks5h://p2:1")
    expect(p2?.usedBy).toEqual(["acc2"])
  })

  it("creates a new proxy and rejects duplicate URL or invalid URL", async () => {
    const { post, get } = setup(baseAccounts)
    const badProto = await post("/api/proxies", { url: "ftp://bad:21" })
    expect(badProto.status).toBe(400)

    const dup = await post("/api/proxies", { url: "socks5h://u:pw@p1:1" })
    expect(dup.status).toBe(409)

    const created = await post("/api/proxies", {
      url: "socks5h://new:pw@new:1",
      name: "New Custom Proxy",
      note: "datacenter A",
    })
    expect(created.status).toBe(200)
    const body = await created.json() as AdminProxy
    expect(body.name).toBe("New Custom Proxy")
    expect(body.url).toBe("socks5h://new:***@new:1")
    expect(body.note).toBe("datacenter A")
    expect(body.usedBy).toEqual([])

    const list = await (await get("/api/proxies")).json() as { proxies: AdminProxy[] }
    expect(list.proxies).toHaveLength(3)
  })

  it("imports multiple proxies from text skipping comments and reporting skipped lines", async () => {
    const { post, get } = setup(baseAccounts)
    const text = `
# this is a comment
http://valid:8080 Valid Proxy

invalid-url-line
socks5h://u:pw@p1:1 Duplicate Proxy
socks5h://u:pw@p3:1080 Another Proxy
`
    const res = await post("/api/proxies/import", { text })
    expect(res.status).toBe(200)
    const result = await res.json() as { added: AdminProxy[]; skipped: Array<{ line: string; reason: string }> }
    expect(result.added).toHaveLength(2)
    expect(result.added.map(p => p.name)).toEqual(["Valid Proxy", "Another Proxy"])

    expect(result.skipped).toHaveLength(2)
    expect(result.skipped[0]?.line).toBe("invalid-url-line")
    expect(result.skipped[1]?.reason).toBe("Proxy URL already exists")

    const list = await (await get("/api/proxies")).json() as { proxies: AdminProxy[] }
    expect(list.proxies).toHaveLength(4)
  })

  it("patches proxy and updates account env when URL changes", async () => {
    const { get, patch, dir } = setup(baseAccounts)
    const list = await (await get("/api/proxies")).json() as { proxies: AdminProxy[] }
    const p1 = list.proxies.find(p => p.name === "acc1 proxy")!

    const patched = await patch(`/api/proxies/${p1.id}`, {
      name: "Updated Name",
      note: "Updated Note",
      url: "socks5h://updated:pw@updated:1080",
    })
    expect(patched.status).toBe(200)
    const body = await patched.json() as AdminProxy
    expect(body.name).toBe("Updated Name")
    expect(body.note).toBe("Updated Note")
    expect(body.url).toBe("socks5h://updated:***@updated:1080")

    // Check that acc1 env was updated
    const envText = readFileSync(join(dir, "acc1", "env"), "utf8")
    expect(envText).toContain("ALL_PROXY=socks5h://updated:pw@updated:1080")
  })

  it("deleting a proxy returns 409 if used by account, and 200 {ok:true} if unused", async () => {
    const { get, del, post } = setup(baseAccounts)
    const list = await (await get("/api/proxies")).json() as { proxies: AdminProxy[] }
    const p1 = list.proxies.find(p => p.name === "acc1 proxy")!

    const delUsed = await del(`/api/proxies/${p1.id}`)
    expect(delUsed.status).toBe(409)

    // Create an unused proxy
    const created = await (await post("/api/proxies", { url: "socks5h://unused:1" })).json() as AdminProxy
    const delUnused = await del(`/api/proxies/${created.id}`)
    expect(delUnused.status).toBe(200)
    expect(await delUnused.json()).toEqual({ ok: true })
  })

  it("tests a specific proxy and persists lastTest", async () => {
    const { get, post, dir } = setup(baseAccounts)
    const list = await (await get("/api/proxies")).json() as { proxies: AdminProxy[] }
    const p1 = list.proxies.find(p => p.name === "acc1 proxy")!

    const res = await post(`/api/proxies/${p1.id}/test`)
    expect(res.status).toBe(200)
    const body = await res.json() as AdminProxy
    expect(body.lastTest).toBeDefined()
    expect(body.lastTest?.ok).toBe(true)
    expect(body.lastTest?.exitIp).toBe("1.1.1.1")
    expect(body.lastTest?.latencyMs).toBeGreaterThanOrEqual(1)

    // Check persistence in panel.json
    const panelJson = JSON.parse(readFileSync(join(dir, "panel.json"), "utf8"))
    const savedP1 = panelJson.proxies.find((p: any) => p.id === p1.id)
    expect(savedP1.lastTest.ok).toBe(true)
    expect(savedP1.lastTest.exitIp).toBe("1.1.1.1")
  })

  it("tests all proxies with concurrency limit 4", async () => {
    const { post } = setup(baseAccounts)
    const res = await post("/api/proxies/test-all")
    expect(res.status).toBe(200)
    const body = await res.json() as { proxies: AdminProxy[] }
    expect(body.proxies).toHaveLength(2)
    expect(body.proxies[0]?.lastTest?.ok).toBe(true)
    expect(body.proxies[1]?.lastTest?.ok).toBe(true)
  })

  it("tests a temporary proxy without saving", async () => {
    const { post, get } = setup(baseAccounts)
    const res = await post("/api/proxies/test", { url: "socks5h://u:pw@p1:1" })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; exitIp: string; latencyMs: number; error: null }
    expect(body.ok).toBe(true)
    expect(body.exitIp).toBe("1.1.1.1")

    // Verify it was not added as a new proxy
    const list = await (await get("/api/proxies")).json() as { proxies: AdminProxy[] }
    expect(list.proxies).toHaveLength(2)
  })
})
