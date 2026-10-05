import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgAdmin } from "../proxy/backends/antigravityAdmin"
import { AgAccountSet } from "../proxy/backends/antigravityAccounts"
import type { ProxyConfig } from "../proxy/types"
import type { PanelGatewayKey } from "../proxy/backends/antigravityPanelStore"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step()
})

const TOKEN = "admin-token-0123456789"
const auth = { authorization: `Bearer ${TOKEN}` }
const K1 = "secret-key-acc1-0123456789"

function setup(files: Record<string, string>, options: { sub2?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-keys-test-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, "env"), text)
  }

  const start = async (_config: Partial<ProxyConfig>) => ({
    close: async () => {},
    fetch: async (_request: Request) => new Response("ok"),
  })
  const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 3)

  const sub2Items: any[] = [{ id: 42, name: "acc1", status: "active", notes: "Antigravity Meridian acc1" }]
  const s2Calls: Array<{ url: string; method: string; body?: any }> = []
  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined
    s2Calls.push({ url, method, body })
    if (url.startsWith("http://s2/admin/accounts?")) return Response.json({ code: 0, message: "ok", data: { items: sub2Items } })
    if (url === "http://s2/admin/accounts/42" && method === "GET") {
      return Response.json({
        code: 0,
        message: "ok",
        data: {
          id: 42,
          credentials: {
            base_url: "http://127.0.0.1:3451",
            api_key: K1,
            model_mapping: { "claude-3": "antigravity-claude-3" },
          },
        },
      })
    }
    if (url.startsWith("http://s2/admin/accounts/") && method === "PUT") return Response.json({ code: 0, message: "ok", data: {} })
    return new Response("?", { status: 500 })
  }) as unknown as typeof fetch

  const admin = createAgAdmin(set, {
    token: TOKEN,
    baseUrl: "http://127.0.0.1:3451",
    loginScript: "/dev/null",
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

  return { dir, set, admin, req, get, post, patch, del, s2Calls }
}

const baseAccounts = {
  acc1: `MERIDIAN_API_KEY=${K1}\nALL_PROXY=socks5h://u:pw@p1:1\n`,
}

describe("Antigravity Keys API", () => {
  it("requires authorization on /api/keys", async () => {
    const { get } = setup(baseAccounts)
    expect((await get("/api/keys", {})).status).toBe(401)
  })

  it("creates a gateway key with secret returned once, and no plaintext secret stored in panel.json", async () => {
    const { post, get, dir } = setup(baseAccounts)
    const createRes = await post("/api/keys", { name: "Client A" })
    expect(createRes.status).toBe(200)
    const body = await createRes.json() as { key: PanelGatewayKey; secret: string }
    expect(body.key.name).toBe("Client A")
    expect(body.key.id).toMatch(/^key_[0-9a-f]{8}$/)
    expect(body.key.scope).toBe("all")
    expect(body.key.accounts).toEqual([])
    expect(body.key.enabled).toBe(true)
    expect(body.key.prefix).toMatch(/^mk-[0-9a-f]{4}…$/)
    expect(body.secret).toMatch(/^mk-[0-9a-f]{32}$/)

    // Check panel.json file directly on disk - must NOT contain secret
    const panelRaw = readFileSync(join(dir, "panel.json"), "utf8")
    expect(panelRaw).not.toContain(body.secret)
    const panelData = JSON.parse(panelRaw)
    expect(panelData.keys[0].hash).toBeString()
    expect(panelData.keys[0].hash).toHaveLength(64)
    expect(panelData.keys[0].secret).toBeUndefined()

    // GET /api/keys returns gateway list without secrets
    const listRes = await get("/api/keys")
    const listData = await listRes.json() as { gateway: any[]; accounts: any[] }
    expect(listData.gateway).toHaveLength(1)
    expect(listData.gateway[0].name).toBe("Client A")
    expect(listData.gateway[0].secret).toBeUndefined()
    expect(listData.gateway[0].hash).toBeUndefined()
    expect(listData.accounts).toHaveLength(1)
    expect(listData.accounts[0].account).toBe("acc1")
    expect(listData.accounts[0].prefix).toBe(`${K1.slice(0, 7)}…`)
  })

  it("patches and deletes gateway keys", async () => {
    const { post, patch, del, get } = setup(baseAccounts)
    const created = (await (await post("/api/keys", { name: "Key 1" })).json() as any).key

    // Patch key
    const patched = await patch(`/api/keys/${created.id}`, {
      name: "Key 1 Renamed",
      enabled: false,
      accounts: ["acc1"],
    })
    expect(patched.status).toBe(200)
    const patchedBody = await patched.json() as any
    expect(patchedBody.name).toBe("Key 1 Renamed")
    expect(patchedBody.enabled).toBe(false)
    expect(patchedBody.scope).toBe("accounts")
    expect(patchedBody.accounts).toEqual(["acc1"])

    // Delete key
    const delRes = await del(`/api/keys/${created.id}`)
    expect(delRes.status).toBe(200)
    expect(await delRes.json()).toEqual({ ok: true })

    const listData = await (await get("/api/keys")).json() as any
    expect(listData.gateway).toHaveLength(0)
  })

  it("reveals account key via GET /api/accounts/:name/key", async () => {
    const { get } = setup(baseAccounts)
    const res = await get("/api/accounts/acc1/key")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ key: K1 })
  })

  it("rotates account key, updates env, and preserves Sub2API credentials", async () => {
    const { post, dir, s2Calls } = setup(baseAccounts, { sub2: true })
    const res = await post("/api/accounts/acc1/key/rotate")
    expect(res.status).toBe(200)
    const body = await res.json() as { key: string }
    expect(body.key).toMatch(/^cheek-meridian-acc1-[0-9a-f]{24}$/)
    expect(body.key).not.toBe(K1)

    // Check env file
    const envText = readFileSync(join(dir, "acc1", "env"), "utf8")
    expect(envText).toContain(`MERIDIAN_API_KEY=${body.key}`)
    expect(envText).not.toContain(K1)

    // Check Sub2API call
    const putCall = s2Calls.find(c => c.method === "PUT" && c.url === "http://s2/admin/accounts/42")
    expect(putCall).toBeDefined()
    expect(putCall?.body.credentials).toEqual({
      base_url: "http://127.0.0.1:3451",
      api_key: body.key,
      model_mapping: { "claude-3": "antigravity-claude-3" },
    })
  })
})
