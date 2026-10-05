import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgAccountSet } from "../proxy/backends/antigravityAccounts"
import { hashGatewaySecret } from "../proxy/backends/antigravityPanelStore"
import type { ProxyConfig } from "../proxy/types"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanups.splice(0).reverse()) await step()
})

const K1 = "secret-key-acc1-0123456789"
const K2 = "secret-key-acc2-0123456789"
const GW_SECRET = "mk-11112222333344445555666677778888"

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "meridian-gateway-routing-test-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))

  mkdirSync(join(dir, "acc1"))
  writeFileSync(join(dir, "acc1", "env"), `MERIDIAN_API_KEY=${K1}\nALL_PROXY=socks5h://p1:1\n`)
  mkdirSync(join(dir, "acc2"))
  writeFileSync(join(dir, "acc2", "env"), `MERIDIAN_API_KEY=${K2}\nALL_PROXY=socks5h://p2:1\n`)

  const requestsReceived: Array<{ targetAccountKey: string | null; path: string }> = []
  const start = async (config: Partial<ProxyConfig>) => ({
    close: async () => {},
    fetch: async (request: Request) => {
      requestsReceived.push({
        targetAccountKey: request.headers.get("x-api-key"),
        path: new URL(request.url).pathname,
      })
      return Response.json({ accountKey: config.apiKey, hello: "world" })
    },
  })

  const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 3)
  return { dir, set, requestsReceived }
}

describe("AgAccountSet Gateway Routing", () => {
  it("routes direct account keys, and rejects unknown keys with 401", async () => {
    const { set } = setup()
    await set.sync()

    // Health without key
    const health = await set.route(new Request("http://localhost/health"))
    expect(health.status).toBe(200)

    // Direct key K1
    const direct1 = await set.route(new Request("http://localhost/v1/chat", { headers: { "x-api-key": K1 } }))
    expect(direct1.status).toBe(200)
    expect((await direct1.json() as any).accountKey).toBe(K1)

    // Unknown key
    const unknown = await set.route(new Request("http://localhost/v1/chat", { headers: { "x-api-key": "bad-key-1234567890" } }))
    expect(unknown.status).toBe(401)
  })

  it("routes gateway key round-robin across serving accounts with header rewrite and stats update", async () => {
    const { set, requestsReceived } = setup()
    await set.sync()

    // Add enabled gateway key
    const hash = hashGatewaySecret(GW_SECRET)
    set.panel.data.keys.push({
      id: "key_test_1",
      name: "Gateway Test Key",
      prefix: "mk-1111…",
      hash,
      scope: "all",
      accounts: [],
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: null,
      requests: 0,
    })

    // Request 1 via gateway key -> should route to acc1
    const r1 = await set.route(new Request("http://localhost/v1/models", { headers: { "x-api-key": GW_SECRET } }))
    expect(r1.status).toBe(200)

    // Request 2 via gateway key -> should route to acc2
    const r2 = await set.route(new Request("http://localhost/v1/models", { headers: { "x-api-key": GW_SECRET } }))
    expect(r2.status).toBe(200)

    // Request 3 via gateway key -> round-robin back to acc1
    const r3 = await set.route(new Request("http://localhost/v1/models", { headers: { "x-api-key": GW_SECRET } }))
    expect(r3.status).toBe(200)

    // Verify rewritten x-api-key header on the received requests
    expect(requestsReceived).toHaveLength(3)
    expect(requestsReceived[0]?.targetAccountKey).toBe(K1)
    expect(requestsReceived[1]?.targetAccountKey).toBe(K2)
    expect(requestsReceived[2]?.targetAccountKey).toBe(K1)

    // Verify key statistics updated
    const key = set.panel.data.keys.find(k => k.id === "key_test_1")!
    expect(key.requests).toBe(3)
    expect(key.lastUsedAt).toBeNumber()
  })

  it("rejects disabled gateway key with 401", async () => {
    const { set } = setup()
    await set.sync()

    const hash = hashGatewaySecret(GW_SECRET)
    set.panel.data.keys.push({
      id: "key_disabled",
      name: "Disabled Key",
      prefix: "mk-1111…",
      hash,
      scope: "all",
      accounts: [],
      enabled: false,
      createdAt: Date.now(),
      lastUsedAt: null,
      requests: 0,
    })

    const res = await set.route(new Request("http://localhost/v1/models", { headers: { "x-api-key": GW_SECRET } }))
    expect(res.status).toBe(401)
  })

  it("routes scoped gateway key only to allowed accounts, and returns 503 if none available", async () => {
    const { set, requestsReceived } = setup()
    await set.sync()

    const hash = hashGatewaySecret(GW_SECRET)
    // Key scoped only to acc2
    set.panel.data.keys.push({
      id: "key_scoped",
      name: "Scoped to acc2",
      prefix: "mk-1111…",
      hash,
      scope: "accounts",
      accounts: ["acc2"],
      enabled: true,
      createdAt: Date.now(),
      lastUsedAt: null,
      requests: 0,
    })

    const r1 = await set.route(new Request("http://localhost/v1/models", { headers: { "x-api-key": GW_SECRET } }))
    expect(r1.status).toBe(200)
    const r2 = await set.route(new Request("http://localhost/v1/models", { headers: { "x-api-key": GW_SECRET } }))
    expect(r2.status).toBe(200)

    // Both should have gone to acc2
    expect(requestsReceived.map(r => r.targetAccountKey)).toEqual([K2, K2])

    // Key scoped to non-existent account -> 503
    const key = set.panel.data.keys.find(k => k.id === "key_scoped")!
    key.accounts = ["acc99"]
    const r503 = await set.route(new Request("http://localhost/v1/models", { headers: { "x-api-key": GW_SECRET } }))
    expect(r503.status).toBe(503)
    expect(await r503.json()).toEqual({
      type: "error",
      error: {
        type: "api_error",
        message: "No serving account",
      },
    })
  })
})
