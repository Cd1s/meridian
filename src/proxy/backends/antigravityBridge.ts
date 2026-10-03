// Fork patch: local loopback bridge for Antigravity official CLI (agy).
// Bypasses location eligibility blocks by intercepting /v1internal:loadCodeAssist,
// while transparently tunneling through each account's configured proxy.
import { type IncomingMessage, type ServerResponse } from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import zlib from "node:zlib"
import { URL } from "node:url"

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

function connectSocks5(proxyUrl: URL, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const port = Number(proxyUrl.port) || 1080
    const socket = net.connect(port, proxyUrl.hostname)
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`SOCKS5 proxy connection to ${proxyUrl.hostname}:${port} timed out`))
    }, 15_000)
    timeout.unref()

    socket.once("connect", () => {
      const hasAuth = !!(proxyUrl.username || proxyUrl.password)
      socket.write(hasAuth ? Buffer.from([5, 1, 2]) : Buffer.from([5, 1, 0]))
      socket.once("data", greetingResp => {
        if (greetingResp[0] !== 5) {
          clearTimeout(timeout)
          socket.destroy()
          return reject(new Error("Invalid SOCKS5 greeting response"))
        }
        const method = greetingResp[1]
        if (hasAuth) {
          if (method !== 2) {
            clearTimeout(timeout)
            socket.destroy()
            return reject(new Error(`SOCKS5 auth method rejected: ${method}`))
          }
          const userBuf = Buffer.from(decodeURIComponent(proxyUrl.username || ""))
          const passBuf = Buffer.from(decodeURIComponent(proxyUrl.password || ""))
          socket.write(Buffer.concat([
            Buffer.from([1, userBuf.length]),
            userBuf,
            Buffer.from([passBuf.length]),
            passBuf,
          ]))
          socket.once("data", authResp => {
            if (authResp[1] !== 0) {
              clearTimeout(timeout)
              socket.destroy()
              return reject(new Error("SOCKS5 username/password auth failed"))
            }
            sendConnect()
          })
        } else {
          if (method !== 0) {
            clearTimeout(timeout)
            socket.destroy()
            return reject(new Error(`SOCKS5 greeting rejected: ${method}`))
          }
          sendConnect()
        }
      })
    })

    function sendConnect() {
      const hostBuf = Buffer.from(targetHost)
      const reqBuf = Buffer.concat([
        Buffer.from([5, 1, 0, 3, hostBuf.length]),
        hostBuf,
        Buffer.from([targetPort >> 8, targetPort & 0xff]),
      ])
      socket.write(reqBuf)
      socket.once("data", connectResp => {
        clearTimeout(timeout)
        if (connectResp[0] !== 5 || connectResp[1] !== 0) {
          socket.destroy()
          return reject(new Error(`SOCKS5 connect to ${targetHost}:${targetPort} failed with code ${connectResp[1]}`))
        }
        resolve(socket)
      })
    }

    socket.once("error", err => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

function connectHttp(proxyUrl: URL, targetHost: string, targetPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const port = Number(proxyUrl.port) || 8080
    const socket = net.connect(port, proxyUrl.hostname)
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`HTTP proxy connection to ${proxyUrl.hostname}:${port} timed out`))
    }, 15_000)
    timeout.unref()

    socket.once("connect", () => {
      let req = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n`
      if (proxyUrl.username || proxyUrl.password) {
        const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username || "")}:${decodeURIComponent(proxyUrl.password || "")}`).toString("base64")
        req += `Proxy-Authorization: Basic ${auth}\r\n`
      }
      req += "Proxy-Connection: Keep-Alive\r\n\r\n"
      socket.write(req)
      socket.once("data", chunk => {
        clearTimeout(timeout)
        const line = chunk.toString("utf8").split("\r\n")[0] || ""
        if (line.includes(" 200 ")) {
          resolve(socket)
        } else {
          socket.destroy()
          reject(new Error(`HTTP CONNECT failed: ${line}`))
        }
      })
    })

    socket.once("error", err => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

async function createProxiedTlsSocket(proxyUrl: URL, targetHost: string, targetPort: number): Promise<tls.TLSSocket> {
  const isSocks = proxyUrl.protocol.startsWith("socks")
  const underlying = isSocks
    ? await connectSocks5(proxyUrl, targetHost, targetPort)
    : await connectHttp(proxyUrl, targetHost, targetPort)

  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket: underlying,
      servername: targetHost,
    }, () => resolve(secure))
    secure.once("error", reject)
    underlying.once("error", reject)
  })
}

export function createCloudCodeAgent(env: NodeJS.ProcessEnv): https.Agent {
  const proxyUrl = getProxyUrl(env)
  if (!proxyUrl) {
    return new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 30_000,
    })
  }
  return new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    // @ts-ignore
    createConnection(options, callback) {
      createProxiedTlsSocket(proxyUrl, options.host || "cloudcode-pa.googleapis.com", Number(options.port) || 443)
        .then(sock => callback(null, sock))
        .catch(err => callback(err))
    },
  })
}

export async function handleCloudCodeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  env: NodeJS.ProcessEnv,
  agent: https.Agent,
): Promise<void> {
  const upstreamHost = env.CLOUD_CODE_UPSTREAM_HOST || process.env.CLOUD_CODE_UPSTREAM_HOST || "daily-cloudcode-pa.googleapis.com"
  const isLoadCodeAssist = req.url?.includes("loadCodeAssist")
  const headers = { ...req.headers }
  delete headers.host

  if (isLoadCodeAssist) {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    headers["content-length"] = String(body.length)

    const upstreamReq = https.request({
      hostname: upstreamHost,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
      agent,
    }, upstreamRes => {
      const resChunks: Buffer[] = []
      upstreamRes.on("data", c => resChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      upstreamRes.on("end", () => {
        let respBuf = Buffer.concat(resChunks)
        const encoding = upstreamRes.headers["content-encoding"]
        let decompressed: Buffer | null = null
        try {
          if (encoding === "gzip") decompressed = zlib.gunzipSync(respBuf)
          else if (encoding === "deflate") decompressed = zlib.inflateSync(respBuf)
          else if (encoding === "br") decompressed = zlib.brotliDecompressSync(respBuf)
        } catch {
          // Decompression failed; use raw buffer
        }

        const jsonBuf = decompressed ?? respBuf
        try {
          const data = JSON.parse(jsonBuf.toString("utf8"))
          // Patch eligibility: remove ineligibleTiers and ensure currentTier is set
          if (!data.currentTier || (Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.length > 0)) {
            data.currentTier = { id: "g1-pro-tier", name: "Gemini Pro" }
            delete data.ineligibleTiers
            const patched = Buffer.from(JSON.stringify(data))
            const outHeaders = { ...upstreamRes.headers }
            delete outHeaders["content-encoding"]
            delete outHeaders["transfer-encoding"]
            outHeaders["content-length"] = String(patched.length)
            res.writeHead(upstreamRes.statusCode || 200, outHeaders)
            res.end(patched)
            return
          }
        } catch {}

        if (decompressed) {
          const outHeaders = { ...upstreamRes.headers }
          delete outHeaders["content-encoding"]
          delete outHeaders["transfer-encoding"]
          outHeaders["content-length"] = String(decompressed.length)
          res.writeHead(upstreamRes.statusCode || 200, outHeaders)
          res.end(decompressed)
        } else {
          res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers)
          res.end(respBuf)
        }
      })
    })

    upstreamReq.on("error", err => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: `CloudCode upstream proxy error: ${err.message}` } }))
      }
    })
    upstreamReq.end(body)
    return
  }

  // Transparent streaming proxy for models, streamGenerateContent, usage/quota, etc.
  const upstreamReq = https.request({
    hostname: upstreamHost,
    port: 443,
    path: req.url,
    method: req.method,
    headers,
    agent,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 200, upstreamRes.headers)
    upstreamRes.pipe(res)
  })

  upstreamReq.on("error", err => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: `CloudCode upstream proxy error: ${err.message}` } }))
    }
  })
  res.on("close", () => upstreamReq.destroy())
  req.on("error", err => upstreamReq.destroy(err))
  req.pipe(upstreamReq)
}
