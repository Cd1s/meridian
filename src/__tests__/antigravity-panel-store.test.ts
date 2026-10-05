import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AgPanelStore,
  hashGatewaySecret,
  maskProxyUrl,
} from "../proxy/backends/antigravityPanelStore"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "panel-store-test-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("AgPanelStore", () => {
  it("returns default panel data when panel.json does not exist", () => {
    const dir = createTempDir()
    const store = new AgPanelStore(dir)
    expect(store.data).toEqual({
      labels: {},
      proxies: [],
      keys: [],
      sub2api: null,
    })
    expect(existsSync(store.filePath)).toBe(false)
  })

  it("keeps a copy of an unreadable panel.json instead of overwriting it", () => {
    const dir = createTempDir()
    writeFileSync(join(dir, "panel.json"), "{ not json")
    const store = new AgPanelStore(dir)
    expect(store.data.keys).toEqual([])
    expect(readdirSync(dir).some(name => name.startsWith("panel.json.corrupt-"))).toBe(true)
  })
  it("saves panel data atomically with 0600 mode and loads it back", () => {
    const dir = createTempDir()
    const store = new AgPanelStore(dir)
    store.data.labels["acc1"] = "Team A"
    store.data.proxies.push({
      id: "px_12345678",
      name: "Proxy 1",
      url: "socks5h://user:pass@host:1080",
      protocol: "socks5h",
      note: "test note",
      lastTest: {
        ok: true,
        exitIp: "1.2.3.4",
        latencyMs: 120,
        at: 1000,
        error: null,
      },
      createdAt: 500,
    })
    store.save()

    expect(existsSync(store.filePath)).toBe(true)
    const mode = statSync(store.filePath).mode & 0o777
    expect(mode).toBe(0o600)

    const raw = JSON.parse(readFileSync(store.filePath, "utf8"))
    expect(raw.labels["acc1"]).toBe("Team A")
    expect(raw.proxies).toHaveLength(1)
    expect(raw.proxies[0]?.id).toBe("px_12345678")

    const loaded = new AgPanelStore(dir)
    expect(loaded.data.labels["acc1"]).toBe("Team A")
    expect(loaded.data.proxies[0]?.name).toBe("Proxy 1")
  })

  it("auto-imports unique ALL_PROXY from account env files on first read when proxies is empty", () => {
    const dir = createTempDir()
    mkdirSync(join(dir, "acc1"))
    writeFileSync(
      join(dir, "acc1", "env"),
      "MERIDIAN_API_KEY=key1\nALL_PROXY=socks5h://u:p@proxy1:1080\n",
    )
    mkdirSync(join(dir, "acc2"))
    writeFileSync(
      join(dir, "acc2", "env"),
      "MERIDIAN_API_KEY=key2\nALL_PROXY=socks5h://u:p@proxy1:1080\n", // duplicate proxy
    )
    mkdirSync(join(dir, "acc3"))
    writeFileSync(
      join(dir, "acc3", "env.disabled"),
      "MERIDIAN_API_KEY=key3\nALL_PROXY=http://proxy2:8080\n",
    )

    const store = new AgPanelStore(dir)
    expect(store.data.proxies).toHaveLength(2)

    const p1 = store.data.proxies.find(p => p.url === "socks5h://u:p@proxy1:1080")
    expect(p1).toBeDefined()
    expect(p1!.name).toBe("acc1 proxy")
    expect(p1!.protocol).toBe("socks5h")
    expect(p1!.id).toMatch(/^px_[0-9a-f]{8}$/)

    const p2 = store.data.proxies.find(p => p.url === "http://proxy2:8080")
    expect(p2).toBeDefined()
    expect(p2!.name).toBe("acc3 proxy")
    expect(p2!.protocol).toBe("http")

    // Verify it was persisted with 0600
    expect(existsSync(store.filePath)).toBe(true)
    expect(statSync(store.filePath).mode & 0o777).toBe(0o600)
  })

  it("masks proxy passwords correctly", () => {
    expect(maskProxyUrl("socks5h://u:password@host:1080")).toBe("socks5h://u:***@host:1080")
    expect(maskProxyUrl("http://host:8080")).toBe("http://host:8080")
    expect(maskProxyUrl("socks5://:secret@host:1080")).toBe("socks5://:***@host:1080")
  })

  it("hashes gateway secret using sha256", () => {
    const hash = hashGatewaySecret("mk-test-secret")
    expect(hash).toHaveLength(64)
  })

  it("flushes throttled save to disk", () => {
    const dir = createTempDir()
    const store = new AgPanelStore(dir)
    store.data.labels["acc5"] = "Throttled Label"
    store.saveThrottled()
    // Not immediately saved
    expect(existsSync(store.filePath)).toBe(false)
    store.flush()
    expect(existsSync(store.filePath)).toBe(true)
    const raw = JSON.parse(readFileSync(store.filePath, "utf8"))
    expect(raw.labels["acc5"]).toBe("Throttled Label")
  })
})
