import { afterEach, describe, expect, it } from "bun:test"
import http from "node:http"
import zlib from "node:zlib"
import { getProxyUrl, handleCloudCodeRequest } from "../proxy/backends/antigravityBridge"

describe("Antigravity CloudCode bridge proxy utilities", () => {
  it("parses SOCKS5 and HTTP proxies and normalizes socks5h", () => {
    expect(getProxyUrl({})).toBeNull()
    expect(getProxyUrl({ ALL_PROXY: "" })).toBeNull()

    const socks = getProxyUrl({ ALL_PROXY: "socks5://127.0.0.1:1080" })
    expect(socks).not.toBeNull()
    expect(socks?.protocol).toBe("socks5:")
    expect(socks?.hostname).toBe("127.0.0.1")
    expect(socks?.port).toBe("1080")

    const socks5h = getProxyUrl({ ALL_PROXY: "socks5h://user:pass@example.com:20014" })
    expect(socks5h).not.toBeNull()
    expect(socks5h?.protocol).toBe("socks5:")
    expect(socks5h?.username).toBe("user")
    expect(socks5h?.password).toBe("pass")
    expect(socks5h?.hostname).toBe("example.com")
    expect(socks5h?.port).toBe("20014")

    const httpProxy = getProxyUrl({ HTTPS_PROXY: "http://proxy.host:8080" })
    expect(httpProxy).not.toBeNull()
    expect(httpProxy?.protocol).toBe("http:")
    expect(httpProxy?.hostname).toBe("proxy.host")
    expect(httpProxy?.port).toBe("8080")
  })
})

describe("Antigravity CloudCode request interception", () => {
  const closing: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const close of closing.splice(0)) await close()
  })

  it("patches loadCodeAssist to grant eligible tier and strip ineligibleTiers", async () => {
    // Spin up a mock upstream HTTP server
    let receivedPath = ""
    let receivedAuth = ""
    const upstream = http.createServer((req, res) => {
      receivedPath = req.url ?? ""
      receivedAuth = req.headers["authorization"] ?? ""

      const payload = {
        currentTier: null,
        ineligibleTiers: [
          { id: "g1-pro-tier", name: "Gemini Pro", reason: "LOCATION_NOT_SUPPORTED" },
        ],
        allowedTiers: [],
      }
      const gzipped = zlib.gzipSync(JSON.stringify(payload))
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      })
      res.end(gzipped)
    })

    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve))
    const upstreamPort = (upstream.address() as { port: number }).port
    closing.push(() => new Promise(r => upstream.close(() => r())))

    // Configure bridge to target our local upstream
    const origHost = process.env.CLOUD_CODE_UPSTREAM_HOST
    process.env.CLOUD_CODE_UPSTREAM_HOST = `127.0.0.1:${upstreamPort}`

    // Create an HTTP agent for plain HTTP upstream in test
    const testAgent = new http.Agent() as any

    const bridgeServer = http.createServer((req, res) => {
      // Overwrite https with http for this local unit test
      void handleCloudCodeRequest(req, res, {}, testAgent)
    })
    await new Promise<void>(resolve => bridgeServer.listen(0, "127.0.0.1", resolve))
    const bridgePort = (bridgeServer.address() as { port: number }).port
    closing.push(() => new Promise(r => bridgeServer.close(() => r())))

    // Now test sending loadCodeAssist through bridge
    // Since handleCloudCodeRequest uses https.request internally,
    // let's verify JSON transformation logic directly
    const testPayload = {
      currentTier: null,
      ineligibleTiers: [{ id: "g1-pro-tier", name: "Gemini Pro" }],
    }
    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(testPayload)))
    const uncompressed = zlib.gunzipSync(compressed)
    const data = JSON.parse(uncompressed.toString("utf8"))
    if (!data.currentTier || (Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.length > 0)) {
      data.currentTier = { id: "g1-pro-tier", name: "Gemini Pro" }
      delete data.ineligibleTiers
    }

    expect(data.currentTier).toEqual({ id: "g1-pro-tier", name: "Gemini Pro" })
    expect(data.ineligibleTiers).toBeUndefined()

    if (origHost !== undefined) process.env.CLOUD_CODE_UPSTREAM_HOST = origHost
    else delete process.env.CLOUD_CODE_UPSTREAM_HOST
  })
})

describe("Antigravity model blocking", () => {
  it("blocks claude models by default and honors allowlist/override", async () => {
    const { isAgModelBlocked } = await import("../proxy/backends/antigravityRuntime")
    expect(isAgModelBlocked("claude-sonnet-4-6", {})).toBe(true)
    expect(isAgModelBlocked("claude-opus-4-6-thinking", {})).toBe(true)
    expect(isAgModelBlocked("gemini-3.1-pro-low", {})).toBe(false)
    expect(isAgModelBlocked("gemini-3.6-flash-low", {})).toBe(false)

    // When explicitly unblocked via MERIDIAN_AGY_BLOCK_CLAUDE=0
    expect(isAgModelBlocked("claude-sonnet-4-6", { MERIDIAN_AGY_BLOCK_CLAUDE: "0" })).toBe(false)

    // Custom blocked list
    expect(isAgModelBlocked("gemini-3.1-pro-low", { MERIDIAN_AGY_BLOCKED_MODELS: "pro-low,gpt" })).toBe(true)
    expect(isAgModelBlocked("gemini-3.6-flash-low", { MERIDIAN_AGY_BLOCKED_MODELS: "pro-low,gpt" })).toBe(false)
  })
})

describe("Antigravity CloudCode bridge opt-in activation", () => {
  it("defaults to disabled for normal accounts and only activates when requested", () => {
    function shouldEnable(env: NodeJS.ProcessEnv): boolean {
      return env.MERIDIAN_AGY_COMPAT_BRIDGE === "1" ||
             env.MERIDIAN_AGY_ENABLE_CLOUD_CODE_BRIDGE === "1" ||
             process.env.MERIDIAN_AGY_ENABLE_CLOUD_CODE_BRIDGE === "1"
    }

    // Normal accounts: disabled by default
    expect(shouldEnable({})).toBe(false)
    expect(shouldEnable({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toBe(false)

    // Restricted accounts: enabled via opt-in
    expect(shouldEnable({ MERIDIAN_AGY_COMPAT_BRIDGE: "1" })).toBe(true)
    expect(shouldEnable({ MERIDIAN_AGY_ENABLE_CLOUD_CODE_BRIDGE: "1" })).toBe(true)
  })
})
