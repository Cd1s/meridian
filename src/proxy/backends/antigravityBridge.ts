// Fork patch: local loopback bridge for Antigravity official CLI (agy).
// Bypasses location eligibility blocks by intercepting /v1internal:loadCodeAssist,
// while transparently tunneling through each account's configured proxy.
import { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import net from "node:net"
import { once } from "node:events"
import { pipeline } from "node:stream"
import tls from "node:tls"
import zlib from "node:zlib"
import { URL } from "node:url"

/** Per-account opt-in; the account env and the service env both end up in the runtime's child env. */
export function agBridgeEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.MERIDIAN_AGY_COMPAT_BRIDGE === "1" || env.MERIDIAN_AGY_ENABLE_CLOUD_CODE_BRIDGE === "1"
}

export function getProxyUrl(env: NodeJS.ProcessEnv): URL | null {
  const raw = env.ALL_PROXY || env.all_proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
  if (!raw) return null
  try {
    const formatted = raw.includes("://") ? raw : `socks5://${raw}`
    return new URL(formatted.replace(/^socks5h:/i, "socks5:"))
  } catch {
    return null
  }
}

/** Grants the eligible tier in a loadCodeAssist body; returns whether the body changed. */
export function patchLoadCodeAssist(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false
  const body = data as { currentTier?: unknown; ineligibleTiers?: unknown }
  if (body.currentTier && !(Array.isArray(body.ineligibleTiers) && body.ineligibleTiers.length)) return false
  body.currentTier = { id: "g1-pro-tier", name: "Gemini Pro" }
  delete body.ineligibleTiers
  return true
}

/** Collects a proxy handshake reply, which may arrive split across TCP reads. `size` returns the reply length once known. */
function readReply(socket: net.Socket, size: (buffer: Buffer) => number | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const finish = (error?: Error, reply?: Buffer) => {
      socket.off("data", onData).off("error", finish).off("close", onClose)
      socket.pause()
      if (error) reject(error)
      else resolve(reply!)
    }
    const onClose = () => finish(new Error("Proxy closed the connection during the handshake"))
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      try {
        const length = size(buffered)
        if (length !== undefined) finish(undefined, buffered.subarray(0, length))
      } catch (error) { finish(error as Error) }
    }
    // The previous reply paused the socket; a new data listener alone does not restart reading.
    socket.on("data", onData).once("error", finish).once("close", onClose).resume()
  })
}

function socks5ReplySize(buffer: Buffer): number | undefined {
  if (buffer.length < 2) return undefined
  if (buffer[1] !== 0) return 2
  if (buffer.length < 5) return undefined
  const address = buffer[3] === 1 ? 4 : buffer[3] === 4 ? 16 : buffer[3] === 3 ? 1 + buffer[4]! : undefined
  if (address === undefined) throw new Error(`SOCKS5 reply has unknown address type ${buffer[3]}`)
  return buffer.length >= 6 + address ? 6 + address : undefined
}

async function socks5Handshake(socket: net.Socket, proxyUrl: URL, host: string, port: number): Promise<void> {
  const auth = !!(proxyUrl.username || proxyUrl.password)
  socket.write(Buffer.from([5, 1, auth ? 2 : 0]))
  const greeting = await readReply(socket, buffer => buffer.length >= 2 ? 2 : undefined)
  if (greeting[0] !== 5 || greeting[1] !== (auth ? 2 : 0)) throw new Error(`SOCKS5 proxy rejected auth method (reply ${greeting[1]})`)
  if (auth) {
    const user = Buffer.from(decodeURIComponent(proxyUrl.username))
    const pass = Buffer.from(decodeURIComponent(proxyUrl.password))
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]))
    const reply = await readReply(socket, buffer => buffer.length >= 2 ? 2 : undefined)
    if (reply[1] !== 0) throw new Error("SOCKS5 username/password authentication failed")
  }
  const target = Buffer.from(host)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, target.length]), target, Buffer.from([port >> 8, port & 0xff])]))
  const reply = await readReply(socket, socks5ReplySize)
  if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 connect to ${host}:${port} failed with code ${reply[1]}`)
}

async function httpConnect(socket: net.Socket, proxyUrl: URL, host: string, port: number): Promise<void> {
  let head = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`
  if (proxyUrl.username || proxyUrl.password) {
    head += `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}\r\n`
  }
  socket.write(head + "\r\n")
  const reply = await readReply(socket, buffer => {
    const end = buffer.indexOf("\r\n\r\n")
    if (end >= 0) return end + 4
    if (buffer.length > 16_384) throw new Error("HTTP CONNECT reply headers too large")
    return undefined
  })
  const status = reply.toString("latin1").split("\r\n")[0] ?? ""
  if (!/^HTTP\/1\.[01] 200\b/.test(status)) throw new Error(`HTTP CONNECT failed: ${status}`)
}

/** Opens a raw TCP tunnel to host:port through a SOCKS5 or HTTP CONNECT proxy. */
export async function connectViaProxy(proxyUrl: URL, host: string, port: number, timeoutMs = 15_000): Promise<net.Socket> {
  const socks = proxyUrl.protocol.startsWith("socks")
  const proxyPort = Number(proxyUrl.port) || (socks ? 1080 : 8080)
  const proxyHost = proxyUrl.hostname.replace(/^\[(.*)\]$/, "$1")
  const socket = net.connect(proxyPort, proxyHost)
  const timer = setTimeout(() => socket.destroy(new Error(`Proxy ${proxyHost}:${proxyPort} handshake timed out`)), timeoutMs)
  try {
    await once(socket, "connect")
    if (socks) await socks5Handshake(socket, proxyUrl, host, port)
    else await httpConnect(socket, proxyUrl, host, port)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  } finally { clearTimeout(timer) }
}

async function createProxiedTlsSocket(proxyUrl: URL, host: string, port: number): Promise<tls.TLSSocket> {
  const raw = await connectViaProxy(proxyUrl, host, port)
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => { raw.destroy(); reject(error) }
    const secure = tls.connect({ socket: raw, servername: host }, () => {
      secure.off("error", fail)
      resolve(secure)
    })
    secure.once("error", fail)
  })
}

export function createCloudCodeAgent(env: NodeJS.ProcessEnv): https.Agent {
  const proxyUrl = getProxyUrl(env)
  if (!proxyUrl) return new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000 })
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    // @ts-ignore Node's Agent accepts an async createConnection via the callback.
    createConnection(options, callback) {
      createProxiedTlsSocket(proxyUrl, options.host || "cloudcode-pa.googleapis.com", Number(options.port) || 443)
        .then(sock => callback(null, sock))
        .catch(err => callback(err))
    },
  })
}

const HOP_BY_HOP = ["host", "connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade"]
function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out = { ...headers }
  for (const name of HOP_BY_HOP) delete out[name]
  return out
}

function fail(res: ServerResponse, error: Error): void {
  if (res.headersSent) { res.destroy(error); return }
  res.writeHead(502, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: { message: `CloudCode upstream proxy error: ${error.message}` } }))
}

function decode(body: Buffer, encoding: string | undefined): Buffer | undefined {
  try {
    if (encoding === "gzip") return zlib.gunzipSync(body)
    if (encoding === "deflate") return zlib.inflateSync(body)
    if (encoding === "br") return zlib.brotliDecompressSync(body)
    if (!encoding || encoding === "identity") return body
  } catch {}
  return undefined
}

export async function handleCloudCodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
  agent: https.Agent,
  request: typeof https.request = https.request,
): Promise<void> {
  const upstreamHost = env.CLOUD_CODE_UPSTREAM_HOST || "daily-cloudcode-pa.googleapis.com"
  const [hostname, port] = upstreamHost.split(":")
  const target = { hostname, port: Number(port) || 443, path: req.url, method: req.method, agent }
  const headers = forwardHeaders(req.headers)

  if (req.url?.includes(":loadCodeAssist")) {
    const chunks: Buffer[] = []
    try {
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    } catch (error) { return fail(res, error as Error) }
    const body = Buffer.concat(chunks)
    headers["content-length"] = String(body.length)
    headers["accept-encoding"] = "identity"

    const upstreamReq = request({ ...target, headers }, upstreamRes => {
      const resChunks: Buffer[] = []
      upstreamRes.on("data", c => resChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      upstreamRes.on("error", error => fail(res, error))
      upstreamRes.on("end", () => {
        const raw = Buffer.concat(resChunks)
        const status = upstreamRes.statusCode ?? 502
        const plain = decode(raw, upstreamRes.headers["content-encoding"])
        let out = plain
        // Only a successful eligibility answer is rewritten; errors reach agy unchanged.
        if (plain && status >= 200 && status < 300) {
          try {
            const data = JSON.parse(plain.toString("utf8"))
            if (patchLoadCodeAssist(data)) out = Buffer.from(JSON.stringify(data))
          } catch {}
        }
        const outHeaders = forwardHeaders(upstreamRes.headers)
        if (out) {
          delete outHeaders["content-encoding"]
          outHeaders["content-length"] = String(out.length)
        }
        res.writeHead(status, outHeaders)
        res.end(out ?? raw)
      })
    })
    upstreamReq.setTimeout(60_000, () => upstreamReq.destroy(new Error("loadCodeAssist timed out")))
    upstreamReq.on("error", error => fail(res, error))
    upstreamReq.end(body)
    return
  }

  // Transparent streaming proxy for models, streamGenerateContent, usage/quota, etc.
  const upstreamReq = request({ ...target, headers }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode ?? 502, forwardHeaders(upstreamRes.headers))
    // pipeline propagates a broken upstream stream to agy instead of leaving the response open.
    pipeline(upstreamRes, res, () => {})
  })
  upstreamReq.on("error", error => fail(res, error))
  // A finished response also emits close; destroying then would discard the kept-alive tunnel.
  res.on("close", () => { if (!res.writableFinished) upstreamReq.destroy() })
  req.on("error", err => upstreamReq.destroy(err))
  req.pipe(upstreamReq)
}
