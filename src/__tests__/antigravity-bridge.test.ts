import { afterEach, describe, expect, it } from "bun:test"
import http from "node:http"
import type https from "node:https"
import net from "node:net"
import zlib from "node:zlib"
import { agBridgeEnabled, connectViaProxy, getProxyUrl, handleCloudCodeRequest, patchLoadCodeAssist } from "../proxy/backends/antigravityBridge"
import { isAgModelBlocked } from "../proxy/backends/antigravityRuntime"

const closing: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closing.splice(0)) await close()
})

async function listen(server: net.Server): Promise<number> {
  const sockets = new Set<net.Socket>()
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)) })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  closing.push(() => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()) }))
  return (server.address() as net.AddressInfo).port
}

/** Queues everything a mock proxy receives, so bytes sent while it is busy writing are not dropped. */
function inbox(socket: net.Socket) {
  const chunks: Buffer[] = []
  let wake: (() => void) | undefined
  const onData = (chunk: Buffer) => { chunks.push(chunk); wake?.() }
  socket.on("data", onData)
  return {
    async read(): Promise<Buffer> {
      while (!chunks.length) await new Promise<void>(resolve => { wake = resolve })
      return chunks.shift()!
    },
    /** Hands the connection to a tunnel, replaying anything already queued. */
    tunnel(port: number) {
      socket.off("data", onData)
      const upstream = net.connect(port, "127.0.0.1", () => {
        upstream.write(Buffer.concat(chunks.splice(0)))
        socket.pipe(upstream); upstream.pipe(socket)
      })
      socket.pause()
    },
  }
}

/** Writes each byte separately so handshake parsers see replies split across reads. */
async function dribble(socket: net.Socket, bytes: Buffer): Promise<void> {
  for (const byte of bytes) {
    socket.write(Buffer.from([byte]))
    await new Promise(resolve => setTimeout(resolve, 1))
  }
}

describe("Antigravity CloudCode bridge proxy utilities", () => {
  it("parses SOCKS5 and HTTP proxies and normalizes socks5h", () => {
    expect(getProxyUrl({})).toBeNull()
    expect(getProxyUrl({ ALL_PROXY: "" })).toBeNull()

    const socks = getProxyUrl({ ALL_PROXY: "socks5://127.0.0.1:1080" })
    expect(socks?.protocol).toBe("socks5:")
    expect(socks?.hostname).toBe("127.0.0.1")
    expect(socks?.port).toBe("1080")

    const socks5h = getProxyUrl({ ALL_PROXY: "socks5h://user:pass@example.com:20014" })
    expect(socks5h?.protocol).toBe("socks5:")
    expect(socks5h?.username).toBe("user")
    expect(socks5h?.password).toBe("pass")
    expect(socks5h?.hostname).toBe("example.com")
    expect(socks5h?.port).toBe("20014")

    const httpProxy = getProxyUrl({ HTTPS_PROXY: "http://proxy.host:8080" })
    expect(httpProxy?.protocol).toBe("http:")
    expect(httpProxy?.hostname).toBe("proxy.host")
    expect(httpProxy?.port).toBe("8080")
  })

  it("tunnels through a SOCKS5 proxy whose replies arrive split across reads", async () => {
    const target = net.createServer(socket => socket.pipe(socket))
    const targetPort = await listen(target)
    let credentials = ""
    let requested = ""
    const proxy = net.createServer(async client => {
      const box = inbox(client)
      await box.read()
      await dribble(client, Buffer.from([5, 2]))
      const auth = await box.read()
      credentials = auth.subarray(2, 2 + auth[1]!).toString() + ":" + auth.subarray(3 + auth[1]!).toString()
      await dribble(client, Buffer.from([1, 0]))
      const connect = await box.read()
      requested = connect.subarray(5, 5 + connect[4]!).toString() + ":" + connect.readUInt16BE(5 + connect[4]!)
      // Domain-typed bound address: the reply length depends on a byte the parser must wait for.
      await dribble(client, Buffer.from([5, 0, 0, 3, 9, ...Buffer.from("localhost"), 0, 80]))
      box.tunnel(targetPort)
    })
    const proxyPort = await listen(proxy)

    const socket = await connectViaProxy(new URL(`socks5://us%40er:p%3Ass@127.0.0.1:${proxyPort}`), "cloudcode.example", 443)
    const echoed = new Promise<string>(resolve => socket.once("data", chunk => resolve(chunk.toString())))
    socket.resume()
    socket.write("ping")
    expect(await echoed).toBe("ping")
    expect(credentials).toBe("us@er:p:ss")
    expect(requested).toBe("cloudcode.example:443")
    socket.destroy()
  })

  it("tunnels through an HTTP CONNECT proxy and rejects non-200 replies", async () => {
    const target = net.createServer(socket => socket.pipe(socket))
    const targetPort = await listen(target)
    let status = "200 Connection established"
    let authorization = ""
    const proxy = net.createServer(async client => {
      const box = inbox(client)
      const head = await box.read()
      authorization = /Proxy-Authorization: Basic (\S+)/.exec(head.toString())?.[1] ?? ""
      await dribble(client, Buffer.from(`HTTP/1.1 ${status}\r\nVia: test\r\n\r\n`))
      if (!status.startsWith("200")) return client.end()
      box.tunnel(targetPort)
    })
    const proxyPort = await listen(proxy)

    const socket = await connectViaProxy(new URL(`http://user:pass@127.0.0.1:${proxyPort}`), "cloudcode.example", 443)
    const echoed = new Promise<string>(resolve => socket.once("data", chunk => resolve(chunk.toString())))
    socket.resume()
    socket.write("ping")
    expect(await echoed).toBe("ping")
    expect(Buffer.from(authorization, "base64").toString()).toBe("user:pass")
    socket.destroy()

    status = "407 Proxy Authentication Required"
    await expect(connectViaProxy(new URL(`http://127.0.0.1:${proxyPort}`), "cloudcode.example", 443)).rejects.toThrow("HTTP CONNECT failed: HTTP/1.1 407")
  })

  it("times out a proxy that never answers the handshake", async () => {
    const proxy = net.createServer(() => {})
    const proxyPort = await listen(proxy)
    await expect(connectViaProxy(new URL(`socks5://127.0.0.1:${proxyPort}`), "cloudcode.example", 443, 100)).rejects.toThrow("handshake timed out")
  })
})

describe("Antigravity CloudCode loadCodeAssist patch", () => {
  it("grants the tier only when the account is ineligible", () => {
    const blocked = { currentTier: null, ineligibleTiers: [{ id: "g1-pro-tier", reason: "LOCATION_NOT_SUPPORTED" }], allowedTiers: [] }
    expect(patchLoadCodeAssist(blocked)).toBe(true)
    expect(blocked).toEqual({ currentTier: { id: "g1-pro-tier", name: "Gemini Pro" }, allowedTiers: [] } as never)

    const eligible = { currentTier: { id: "standard-tier" }, ineligibleTiers: [] }
    expect(patchLoadCodeAssist(eligible)).toBe(false)
    expect(eligible.currentTier).toEqual({ id: "standard-tier" })

    expect(patchLoadCodeAssist(null)).toBe(false)
    expect(patchLoadCodeAssist([])).toBe(false)
  })
})

describe("Antigravity CloudCode request forwarding", () => {
  async function bridge(upstream: http.RequestListener): Promise<{ port: number; seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> }> {
    const seen: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = []
    const upstreamServer = http.createServer(async (req, res) => {
      let body = ""
      for await (const chunk of req) body += chunk
      seen.push({ url: req.url ?? "", headers: req.headers, body })
      upstream(req, res)
    })
    const upstreamPort = await listen(upstreamServer)
    const agent = new http.Agent({ keepAlive: true })
    closing.push(async () => agent.destroy())
    const env = { CLOUD_CODE_UPSTREAM_HOST: `127.0.0.1:${upstreamPort}` }
    const bridgeServer = http.createServer((req, res) => {
      void handleCloudCodeRequest(req, res, env, agent as unknown as https.Agent, http.request as unknown as typeof https.request)
    })
    return { port: await listen(bridgeServer), seen }
  }

  it("rewrites a successful gzip loadCodeAssist answer and forwards the request body", async () => {
    const { port, seen } = await bridge((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" })
      res.end(zlib.gzipSync(JSON.stringify({ currentTier: null, ineligibleTiers: [{ id: "g1-pro-tier" }] })))
    })
    const response = await fetch(`http://127.0.0.1:${port}/v1internal:loadCodeAssist`, { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: "{\"metadata\":{}}" })
    expect(response.status).toBe(200)
    expect(response.headers.get("content-encoding")).toBeNull()
    expect(await response.json()).toEqual({ currentTier: { id: "g1-pro-tier", name: "Gemini Pro" } })
    expect(seen[0]).toMatchObject({ url: "/v1internal:loadCodeAssist", body: "{\"metadata\":{}}" })
    expect(seen[0]!.headers.authorization).toBe("Bearer t")
    expect(seen[0]!.headers["accept-encoding"]).toBe("identity")
  })

  it("passes loadCodeAssist errors through unchanged", async () => {
    const error = { error: { code: 401, message: "UNAUTHENTICATED" } }
    const { port } = await bridge((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify(error))
    })
    const response = await fetch(`http://127.0.0.1:${port}/v1internal:loadCodeAssist`, { method: "POST", body: "{}" })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(error)
  })

  it("streams other endpoints verbatim and reuses the upstream connection", async () => {
    const sockets = new Set<string>()
    const { port, seen } = await bridge((req, res) => {
      sockets.add(`${req.socket.remotePort}`)
      res.writeHead(429, { "content-type": "text/event-stream" })
      res.write("data: 1\n\n")
      setTimeout(() => res.end("data: 2\n\n"), 5)
    })
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/v1internal:streamGenerateContent?alt=sse`, { method: "POST", body: "{\"n\":1}" })
      expect(response.status).toBe(429)
      expect(await response.text()).toBe("data: 1\n\ndata: 2\n\n")
    }
    expect(seen.map(entry => entry.body)).toEqual(["{\"n\":1}", "{\"n\":1}"])
    expect(sockets.size).toBe(1)
  })

  it("answers 502 when the upstream is unreachable", async () => {
    const agent = new http.Agent()
    const server = http.createServer((req, res) => {
      void handleCloudCodeRequest(req, res, { CLOUD_CODE_UPSTREAM_HOST: "127.0.0.1:1" }, agent as unknown as https.Agent, http.request as unknown as typeof https.request)
    })
    const port = await listen(server)
    const response = await fetch(`http://127.0.0.1:${port}/v1internal:fetchAvailableModels`, { method: "POST", body: "{}" })
    expect(response.status).toBe(502)
    expect((await response.json() as { error: { message: string } }).error.message).toContain("CloudCode upstream proxy error")
  })
})

describe("Antigravity model blocking", () => {
  it("blocks claude models by default and honors allowlist/override", () => {
    expect(isAgModelBlocked("claude-sonnet-4-6", {})).toBe(true)
    expect(isAgModelBlocked("Claude-Opus-4-6-thinking", {})).toBe(true)
    expect(isAgModelBlocked("gemini-3.1-pro-low", {})).toBe(false)
    expect(isAgModelBlocked("gemini-3.6-flash-low", {})).toBe(false)

    expect(isAgModelBlocked("claude-sonnet-4-6", { MERIDIAN_AGY_BLOCK_CLAUDE: "0" })).toBe(false)

    expect(isAgModelBlocked("gemini-3.1-pro-low", { MERIDIAN_AGY_BLOCKED_MODELS: "pro-low,gpt" })).toBe(true)
    expect(isAgModelBlocked("gemini-3.6-flash-low", { MERIDIAN_AGY_BLOCKED_MODELS: "pro-low,gpt" })).toBe(false)
    expect(isAgModelBlocked("gemini-3.6-flash-low", { MERIDIAN_AGY_BLOCKED_MODELS: " , " })).toBe(false)
  })
})

describe("Antigravity CloudCode bridge opt-in activation", () => {
  it("is off unless the account or service opts in", () => {
    expect(agBridgeEnabled({})).toBe(false)
    expect(agBridgeEnabled({ ALL_PROXY: "socks5://127.0.0.1:1080" })).toBe(false)
    expect(agBridgeEnabled({ AGY_COMPAT_BRIDGE: "1" })).toBe(false)
    expect(agBridgeEnabled({ MERIDIAN_AGY_COMPAT_BRIDGE: "1" })).toBe(true)
    expect(agBridgeEnabled({ MERIDIAN_AGY_ENABLE_CLOUD_CODE_BRIDGE: "1" })).toBe(true)
  })
})
