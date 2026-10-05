// Fork patch: admin API for multi-account mode (list, add, log in, disable accounts; mirror them into Sub2API).
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { closeSync, constants, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { hasValidApiKey } from "../auth"
import { agAdminPageHtml } from "./antigravityAdminPage"
import { parseAgEnvFile, type AgAccountSet } from "./antigravityAccounts"
import {
  hashGatewaySecret,
  maskProxyUrl,
  type PanelGatewayKey,
  type PanelProxy,
  type ProxyProtocol,
  type ProxyTestResult,
} from "./antigravityPanelStore"

type Json = Record<string, any>
export interface AgAdminOptions {
  token: string
  baseUrl: string
  loginScript: string
  version?: string
  sub2api?: { base: string; key: string; templateId: number }
  exec?: (file: string, args: string[]) => Promise<string>
  fetch?: typeof fetch
  spawn?: (name: string) => ChildProcess
  fifoPath?: (name: string) => string
  /** Runs agy once as the account and returns its combined output (the eligibility check runs on first use). */
  agyCheck?: (name: string) => Promise<string>
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const NAME = /^acc[0-9]+$/
const run = promisify(execFile)
/** Writes a private file via a temp file and rename, so a crash can never leave a truncated env behind. */
const writePrivate = (file: string, content: string) => {
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, file)
}
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const mask = (proxy: string) => maskProxyUrl(proxy)
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
const fail = (status: number, message: string): never => { throw new HttpError(status, message) }
/** Error text that is safe to store or return: Node puts the full curl command line, proxy password included, into exec errors. */
const safeError = (error: unknown) => maskProxyUrl(error instanceof Error ? error.message : String(error))
/** agy's "Eligibility check failed" error: the Google verification link it asks the user to open, if any. */
export function parseEligibility(output: string): { eligible: boolean; message: string | null; verifyUrl: string | null } {
  const text = output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "")
  if (!/Eligibility check failed|not eligible|verify your account/i.test(text)) return { eligible: true, message: null, verifyUrl: null }
  const url = /https:\/\/[^\s"'<>\x00-\x1f]+/.exec(text.slice(text.search(/verify your account in your browser/i) >= 0 ? text.search(/verify your account in your browser/i) : 0))?.[0] ?? null
  const message = /Eligibility check failed:\s*([^\n]+)/i.exec(text)?.[1]?.trim() ?? "Account is not eligible"
  return { eligible: false, message, verifyUrl: url }
}

export function createAgAdmin(set: AgAccountSet, options: AgAdminOptions) {
  const { token } = options
  if (!token) throw new Error("Admin token is required")
  const http = options.fetch ?? fetch
  const exec = options.exec ?? (async (file, args) => (await run(file, args, { timeout: 20_000 })).stdout)
  const fifo = options.fifoPath ?? (name => `/tmp/agy_${name}.fifo`)
  const logins = new Map<string, { child: ChildProcess; out: string; codeSent?: boolean }>()
  // Each quota read makes the account run `agy -p /usage`; the panel polls every 15s, so keep results for 5 minutes.
  const quotas = new Map<string, { at: number; value: Json | null }>()
  const panel = set.panel
  /** Sub2API sync settings: the panel's own config wins over the service environment. */
  type Sub2Cfg = { base: string; key: string; templateId: number | null; groupIds: number[]; concurrency: number | null; priority: number | null; source: "panel" | "env" }
  const getSub2 = (): Sub2Cfg | undefined => {
    const saved = panel.data.sub2api
    if (saved) return { base: saved.base, key: saved.key, templateId: saved.templateId, groupIds: saved.groupIds, concurrency: saved.concurrency, priority: saved.priority, source: "panel" }
    const env = options.sub2api
    return env ? { base: env.base, key: env.key, templateId: env.templateId, groupIds: [], concurrency: null, priority: null, source: "env" } : undefined
  }

  let defaultVersion = "unknown"
  try {
    const pkgPath = join(__dirname, "../../../package.json")
    if (existsSync(pkgPath)) {
      const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }
      defaultVersion = parsed.version ?? "unknown"
    }
  } catch (error) {
    defaultVersion = "unknown"
  }
  const version = options.version ?? defaultVersion

  const envPath = (name: string) => join(set.dir, name, "env")
  const readEnv = (name: string) => {
    const file = [envPath(name), `${envPath(name)}.disabled`].find(existsSync)
    return file ? { vars: parseAgEnvFile(readFileSync(file, "utf8")), disabled: file.endsWith(".disabled") } : undefined
  }
  const names = () => readdirSync(set.dir, { withFileTypes: true }).filter(e => e.isDirectory() && NAME.test(e.name) && readEnv(e.name)).map(e => e.name).sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
  const existing = (name: string) => {
    const env = NAME.test(name) ? readEnv(name) : undefined
    return env ?? fail(404, `Unknown account ${name}`)
  }
  const exitIp = async (proxy: string) => {
    const ip = (await exec("curl", ["-s", "-m", "15", "-x", proxy, "https://api.ipify.org"])).trim()
    return /^[0-9a-fA-F.:]{3,45}$/.test(ip) ? ip : fail(502, "Proxy did not return an exit IP")
  }
  const email = (name: string) => {
    try {
      const file = JSON.parse(readFileSync(join(set.dir, name, ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8"))
      const jwt = file.id_token ?? file.token?.id_token
      return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).email ?? null
    } catch (error) { return null }
  }
  const probe = async (name: string, path: string) => {
    try {
      const response = await set.request(name, path)
      return response?.ok ? await response.json() as Json : null
    } catch (error) { return null }
  }

  const s2With = async (cfg: { base: string; key: string }, path: string, init: { method?: string; body?: unknown } = {}): Promise<Json> => {
    const response = await http(`${cfg.base}${path}`, { method: init.method, headers: { "x-api-key": cfg.key, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(15_000), redirect: "error" })
    const body = await response.json().catch(() => ({})) as Json
    if (!response.ok || (body.code !== undefined && body.code !== 0)) fail(502, `Sub2API: ${body.message ?? response.status}`)
    return body.data
  }
  const s2 = (path: string, init: { method?: string; body?: unknown } = {}) => s2With(getSub2() ?? fail(409, "Sub2API is not configured"), path, init)
  const sub2Accounts = async (): Promise<Json[]> => getSub2() ? (await s2("/admin/accounts?page=1&page_size=500")).items ?? [] : []
  // All accounts share one base_url and Sub2API never returns api keys, so an account is identified by its notes.
  const findSub2 = (items: Json[], name: string) => items.find(item => /^Antigravity Meridian (acc\d+)\b/.exec(item.notes ?? "")?.[1] === name)
  const setStatus = async (name: string, status: string) => {
    const found = findSub2(await sub2Accounts(), name)
    if (found && found.status !== status) await s2(`/admin/accounts/${found.id}`, { method: "PUT", body: { status } })
    return found?.id ?? null
  }

  function validateProxyUrl(rawUrl: unknown): { url: string; protocol: ProxyProtocol } {
    const proxy = String(rawUrl ?? "").trim()
    let parsed: URL
    try { parsed = new URL(proxy) } catch (error) { return fail(400, "Invalid proxy URL") }
    if (!["socks5:", "socks5h:", "http:", "https:"].includes(parsed.protocol) || /[\s"'$`\\]/.test(proxy)) {
      fail(400, "Proxy must be a socks5, socks5h, http or https URL")
    }
    const protocol = parsed.protocol.slice(0, -1) as ProxyProtocol
    return { url: proxy, protocol }
  }

  function describeProxy(p: PanelProxy) {
    const accountVars = names().map(name => ({ name, proxy: readEnv(name)?.vars.ALL_PROXY }))
    const usedBy = accountVars.filter(a => a.proxy === p.url).map(a => a.name)
    return {
      id: p.id,
      name: p.name,
      url: mask(p.url),
      protocol: p.protocol,
      note: p.note,
      usedBy,
      lastTest: p.lastTest,
      createdAt: p.createdAt,
    }
  }

  function describeGatewayKey(k: PanelGatewayKey) {
    return {
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      scope: k.scope,
      accounts: k.accounts,
      enabled: k.enabled,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      requests: k.requests,
    }
  }

  /**
   * One curl, three requests over the same connection: the first pays the handshakes, the next two show what a warm connection costs.
   * cloudflare's trace answers with the exit IP and is much faster than ipify; ipify stays as a fallback.
   */
  async function testProxyUrl(proxyUrl: string): Promise<ProxyTestResult> {
    const at = Date.now()
    const start = Date.now()
    const trace = "https://www.cloudflare.com/cdn-cgi/trace"
    try {
      let ip: string | null = null, firstMs: number | null = null, warmMs: number | null = null
      try {
        const out = await exec("curl", ["-s", "-m", "15", "-x", proxyUrl, "-w", "\n@@%{time_total}\n", trace, trace, trace])
        const times = [...out.matchAll(/@@([0-9.]+)/g)].map(match => Math.max(1, Math.round(Number(match[1]) * 1000)))
        const found = /^ip=([0-9a-fA-F.:]{3,45})$/m.exec(out)?.[1]
        if (found && times.length >= 1) { ip = found; firstMs = times[0]!; warmMs = times.length > 1 ? Math.min(...times.slice(1)) : null }
        else if (/^[0-9a-fA-F.:]{3,45}$/.test(out.trim())) { ip = out.trim(); firstMs = Math.max(1, Date.now() - start) }
      } catch { ip = null }
      if (!ip) {
        const out = (await exec("curl", ["-s", "-m", "15", "-x", proxyUrl, "https://api.ipify.org"])).trim()
        if (/^[0-9a-fA-F.:]{3,45}$/.test(out)) { ip = out; firstMs = Math.max(1, Date.now() - start) }
      }
      if (ip) return { ok: true, exitIp: ip, latencyMs: warmMs ?? firstMs, firstMs, at, error: null }
      return { ok: false, exitIp: null, latencyMs: Math.max(1, Date.now() - start), firstMs: null, at, error: "Proxy did not return an exit IP" }
    } catch (error) {
      return { ok: false, exitIp: null, latencyMs: Math.max(1, Date.now() - start), firstMs: null, at, error: safeError(error) }
    }
  }

  async function testAllProxies() {
    const proxies = panel.data.proxies
    let index = 0
    const workers = Array.from({ length: Math.min(4, proxies.length) }, async () => {
      while (index < proxies.length) {
        const i = index++
        const p = proxies[i]!
        p.lastTest = await testProxyUrl(p.url)
      }
    })
    await Promise.all(workers)
    panel.save()
    return { proxies: proxies.map(describeProxy) }
  }

  async function updateAccountsProxy(oldUrl: string, newUrl: string) {
    let changed = false
    for (const name of names()) {
      const file = [envPath(name), `${envPath(name)}.disabled`].find(existsSync)
      if (!file) continue
      const text = readFileSync(file, "utf8")
      const vars = parseAgEnvFile(text)
      if (vars.ALL_PROXY === oldUrl) {
        const lines = text.split("\n")
        const newLines = lines.map(line => {
          const trimmed = line.trim()
          if (trimmed.startsWith("ALL_PROXY=") || trimmed.startsWith("export ALL_PROXY=")) return `ALL_PROXY=${newUrl}`
          if (trimmed.startsWith("HTTP_PROXY=") || trimmed.startsWith("export HTTP_PROXY=")) return `HTTP_PROXY=${newUrl}`
          if (trimmed.startsWith("HTTPS_PROXY=") || trimmed.startsWith("export HTTPS_PROXY=")) return `HTTPS_PROXY=${newUrl}`
          return line
        })
        writePrivate(file, newLines.join("\n"))
        changed = true
      }
    }
    if (changed) {
      await set.sync()
    }
  }

  async function routeProxies(method: string, parts: string[], body: Json): Promise<unknown> {
    if (parts.length === 0) {
      if (method === "GET") return { proxies: panel.data.proxies.map(describeProxy) }
      if (method === "POST") {
        const validated = validateProxyUrl(body.url)
        if (panel.data.proxies.some(p => p.url === validated.url)) fail(409, "Proxy URL already exists")
        const proxy: PanelProxy = {
          id: `px_${randomBytes(4).toString("hex")}`,
          name: body.name ? String(body.name).trim() : `${validated.protocol} proxy`,
          url: validated.url,
          protocol: validated.protocol,
          note: body.note ? String(body.note).trim() : "",
          lastTest: null,
          createdAt: Date.now(),
        }
        panel.data.proxies.push(proxy)
        panel.save()
        return describeProxy(proxy)
      }
      fail(405, "Method not allowed")
    }
    if (parts.length === 1) {
      const sub = parts[0]!
      if (sub === "import") {
        if (method !== "POST") fail(405, "Method not allowed")
        const text = String(body.text ?? "")
        const added: PanelProxy[] = []
        const skipped: Array<{ line: string; reason: string }> = []
        for (const rawLine of text.split("\n")) {
          const line = rawLine.trim()
          if (!line || line.startsWith("#")) continue
          const match = line.match(/^(\S+)(?:\s+(.*))?$/)
          if (!match) continue
          const rawUrl = match[1]!
          const customName = match[2]?.trim()
          let validated: { url: string; protocol: ProxyProtocol }
          try {
            validated = validateProxyUrl(rawUrl)
          } catch (error) {
            const message = error instanceof Error ? error.message : "Invalid proxy URL"
            skipped.push({ line, reason: message })
            continue
          }
          if (panel.data.proxies.some(p => p.url === validated.url) || added.some(p => p.url === validated.url)) {
            skipped.push({ line, reason: "Proxy URL already exists" })
            continue
          }
          const proxy: PanelProxy = {
            id: `px_${randomBytes(4).toString("hex")}`,
            name: customName || `${validated.protocol} proxy`,
            url: validated.url,
            protocol: validated.protocol,
            note: "",
            lastTest: null,
            createdAt: Date.now(),
          }
          panel.data.proxies.push(proxy)
          added.push(proxy)
        }
        if (added.length > 0) panel.save()
        return { added: added.map(describeProxy), skipped }
      }
      if (sub === "test-all") {
        if (method !== "POST") fail(405, "Method not allowed")
        return testAllProxies()
      }
      if (sub === "test") {
        if (method !== "POST") fail(405, "Method not allowed")
        const validated = validateProxyUrl(body.url)
        const res = await testProxyUrl(validated.url)
        return { ok: res.ok, exitIp: res.exitIp, latencyMs: res.latencyMs, firstMs: res.firstMs ?? null, error: res.error }
      }
      const id = sub
      const proxy = panel.data.proxies.find(p => p.id === id) ?? fail(404, `Unknown proxy ${id}`)
      if (method === "PATCH") {
        if (body.name !== undefined) proxy.name = String(body.name).trim()
        if (body.note !== undefined) proxy.note = String(body.note).trim()
        if (body.url !== undefined) {
          const validated = validateProxyUrl(body.url)
          if (panel.data.proxies.some(p => p.id !== id && p.url === validated.url)) fail(409, "Proxy URL already exists")
          const oldUrl = proxy.url
          proxy.url = validated.url
          proxy.protocol = validated.protocol
          await updateAccountsProxy(oldUrl, validated.url)
        }
        panel.save()
        return describeProxy(proxy)
      }
      if (method === "DELETE") {
        const usedBy = names().filter(name => readEnv(name)?.vars.ALL_PROXY === proxy.url)
        if (usedBy.length > 0) fail(409, `Proxy is in use by account(s): ${usedBy.join(", ")}`)
        panel.data.proxies = panel.data.proxies.filter(p => p.id !== id)
        panel.save()
        return { ok: true }
      }
      fail(405, "Method not allowed")
    }
    if (parts.length === 2 && parts[1] === "test") {
      if (method !== "POST") fail(405, "Method not allowed")
      const id = parts[0]!
      const proxy = panel.data.proxies.find(p => p.id === id) ?? fail(404, `Unknown proxy ${id}`)
      proxy.lastTest = await testProxyUrl(proxy.url)
      panel.save()
      return describeProxy(proxy)
    }
    fail(404, "Not found")
  }

  async function routeKeys(method: string, parts: string[], body: Json): Promise<unknown> {
    if (parts.length === 0) {
      if (method === "GET") {
        return {
          gateway: panel.data.keys.map(describeGatewayKey),
          accounts: names().map(name => {
            const key = readEnv(name)?.vars.MERIDIAN_API_KEY ?? ""
            const prefix = key.length > 7 ? `${key.slice(0, 7)}…` : key
            return { account: name, prefix }
          }),
        }
      }
      if (method === "POST") {
        const keyName = String(body.name ?? "").trim()
        if (!keyName) fail(400, "Name is required")
        const accountsList = Array.isArray(body.accounts) ? body.accounts.filter(a => typeof a === "string" && a.trim()) : []
        const scope: "all" | "accounts" = accountsList.length > 0 ? "accounts" : "all"
        const secret = `mk-${randomBytes(16).toString("hex")}`
        const hash = hashGatewaySecret(secret)
        const prefix = `${secret.slice(0, 7)}…`
        const id = `key_${randomBytes(4).toString("hex")}`
        const keyEntry: PanelGatewayKey = {
          id,
          name: keyName,
          prefix,
          hash,
          scope,
          accounts: accountsList,
          enabled: true,
          createdAt: Date.now(),
          lastUsedAt: null,
          requests: 0,
        }
        panel.data.keys.push(keyEntry)
        panel.save()
        return { key: describeGatewayKey(keyEntry), secret }
      }
      fail(405, "Method not allowed")
    }
    if (parts.length === 1) {
      const id = parts[0]!
      const key = panel.data.keys.find(k => k.id === id) ?? fail(404, `Unknown gateway key ${id}`)
      if (method === "PATCH") {
        if (body.name !== undefined) key.name = String(body.name).trim()
        if (body.enabled !== undefined) key.enabled = Boolean(body.enabled)
        if (body.accounts !== undefined) {
          const list = Array.isArray(body.accounts) ? body.accounts.filter(a => typeof a === "string" && a.trim()) : []
          key.accounts = list
          key.scope = list.length > 0 ? "accounts" : "all"
        }
        panel.save()
        return describeGatewayKey(key)
      }
      if (method === "DELETE") {
        panel.data.keys = panel.data.keys.filter(k => k.id !== id)
        panel.save()
        return { ok: true }
      }
      fail(405, "Method not allowed")
    }
    fail(404, "Not found")
  }

  async function rotateAccountKey(name: string) {
    existing(name)
    const newKey = `cheek-meridian-${name}-${randomBytes(12).toString("hex")}`
    const file = [envPath(name), `${envPath(name)}.disabled`].find(existsSync)!
    const text = readFileSync(file, "utf8")
    const lines = text.split("\n")
    const newLines = lines.map(line => {
      const trimmed = line.trim()
      if (trimmed.startsWith("MERIDIAN_API_KEY=") || trimmed.startsWith("export MERIDIAN_API_KEY=")) {
        return `MERIDIAN_API_KEY=${newKey}`
      }
      return line
    })
    if (!newLines.some(l => l.startsWith("MERIDIAN_API_KEY="))) {
      newLines.push(`MERIDIAN_API_KEY=${newKey}`)
    }
    writePrivate(file, newLines.join("\n"))
    await set.sync()

    if (getSub2()) {
      const items = await sub2Accounts()
      const found = findSub2(items, name)
      if (found) {
        const detail = await s2(`/admin/accounts/${found.id}`)
        const currentCredentials = (typeof detail.credentials === "object" && detail.credentials !== null) ? detail.credentials : {}
        await s2(`/admin/accounts/${found.id}`, {
          method: "PUT",
          body: {
            credentials: {
              ...currentCredentials,
              api_key: newKey,
            },
          },
        })
      }
    }

    return { key: newKey }
  }

  async function getOverview() {
    const allNames = names()
    const servingNames = set.names
    const serving = allNames.filter(n => servingNames.includes(n)).length
    const disabled = allNames.filter(n => Boolean(readEnv(n)?.disabled)).length
    const errorCount = allNames.filter(n => Boolean(set.failures.get(n))).length

    const proxies = panel.data.proxies
    const usedUrls = new Set(allNames.map(n => readEnv(n)?.vars.ALL_PROXY).filter(Boolean))
    const ok = proxies.filter(p => p.lastTest?.ok === true).length
    const failed = proxies.filter(p => p.lastTest !== null && p.lastTest.ok === false).length
    const untested = proxies.filter(p => p.lastTest === null).length
    const unused = proxies.filter(p => !usedUrls.has(p.url)).length

    const keys = panel.data.keys
    const keysEnabled = keys.filter(k => k.enabled).length

    let completed = 0, trafficFailed = 0, reused = 0
    const healthList = await Promise.all(allNames.map(n => servingNames.includes(n) ? probe(n, "/health") : null))
    for (const h of healthList) {
      if (h) {
        completed += Number(h.completed ?? 0)
        trafficFailed += Number(h.failed ?? 0)
        reused += Number(h.reused ?? 0)
      }
    }

    return {
      accounts: {
        total: allNames.length,
        serving,
        error: errorCount,
        disabled,
      },
      proxies: {
        total: proxies.length,
        ok,
        failed,
        untested,
        unused,
      },
      keys: {
        total: keys.length,
        enabled: keysEnabled,
      },
      traffic: {
        completed,
        failed: trafficFailed,
        reused,
      },
      pool: {
        max: set.pool?.maxProcesses ?? null,
      },
      sub2api: {
        enabled: Boolean(getSub2()),
      },
      version,
    }
  }

  async function describe(name: string, items: Json[] | null) {
    const { vars, disabled } = readEnv(name)!
    const serving = set.names.includes(name), cached = quotas.get(name)
    const fresh = cached && Date.now() - cached.at < 300_000 && cached.value?.fetchedAt
    const [health, status] = await Promise.all([probe(name, "/health"), serving && !fresh ? probe(name, "/providers/status") : null])
    if (status) quotas.set(name, { at: Date.now(), value: status.providers?.find((p: Json) => p.id === "antigravity")?.accounts?.[0] ?? null })
    const quota = serving ? quotas.get(name)?.value : undefined

    let createdAt: number | null = null
    try {
      const st = statSync(join(set.dir, name))
      createdAt = Math.round(st.birthtimeMs || st.ctimeMs)
    } catch (error) {
      createdAt = null
    }

    const matchedProxy = vars.ALL_PROXY ? panel.data.proxies.find(p => p.url === vars.ALL_PROXY) : undefined

    return {
      name,
      label: panel.data.labels[name] ?? "",
      email: email(name),
      proxyId: matchedProxy?.id ?? null,
      proxy: mask(vars.ALL_PROXY ?? vars.HTTPS_PROXY ?? ""),
      disabled,
      serving,
      error: set.failures.get(name) ?? null,
      sub2apiId: items ? findSub2(items, name)?.id ?? null : null,
      createdAt,
      health: health && Object.fromEntries(["completed", "failed", "reused", "prewarmed", "processes", "activeProcesses", "spareReady"].map(key => [key, health[key]])),
      quota: quota ? { fetchedAt: quota.fetchedAt ?? null, error: quota.error ?? null, windows: quota.windows ?? [] } : null,
    }
  }

  async function create(body: Json) {
    let proxyUrl = ""
    let proxyId: string | null = null

    if (body.proxyId) {
      const p = panel.data.proxies.find(p => p.id === body.proxyId) ?? fail(404, `Unknown proxy ${body.proxyId}`)
      proxyUrl = p.url
      proxyId = p.id
    } else if (body.proxy) {
      const validated = validateProxyUrl(body.proxy)
      proxyUrl = validated.url
      let p = panel.data.proxies.find(p => p.url === proxyUrl)
      if (!p) {
        p = {
          id: `px_${randomBytes(4).toString("hex")}`,
          name: `${validated.protocol} proxy`,
          url: proxyUrl,
          protocol: validated.protocol,
          note: "",
          lastTest: null,
          createdAt: Date.now(),
        }
        panel.data.proxies.push(p)
        panel.save()
      }
      proxyId = p.id
    } else {
      fail(400, "proxy or proxyId is required")
    }

    const others = names().map(name => readEnv(name)!.vars)
    const [ip, ...used] = await Promise.all([exitIp(proxyUrl), ...others.map(vars => exitIp(vars.ALL_PROXY ?? vars.HTTPS_PROXY ?? "").catch(() => null))])
    if (used.includes(ip!)) fail(409, `Exit IP ${ip} is already used by another account`)

    const deletedNumbers = existsSync(join(set.dir, "_deleted")) ? readdirSync(join(set.dir, "_deleted")).map(entry => Number(/^acc(\d+)-/.exec(entry)?.[1] ?? 0)) : []
    const number = Math.max(0, ...names().map(name => Number(name.slice(3))), ...deletedNumbers) + 1, name = `acc${number}`
    mkdirSync(join(set.dir, name), { recursive: true, mode: 0o700 })
    const lines = [`ALL_PROXY=${proxyUrl}`, `HTTP_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`, `MERIDIAN_API_KEY=cheek-meridian-${name}-${randomBytes(12).toString("hex")}`]
    writeFileSync(envPath(name), lines.join("\n") + "\n", { mode: 0o600 })

    if (body.label !== undefined) {
      panel.data.labels[name] = String(body.label).trim()
      panel.save()
    }

    if (body.proxyId !== undefined || "proxyId" in body || body.label !== undefined || "label" in body) {
      return { name, exitIp: ip, proxyId }
    }
    return { name, exitIp: ip }
  }

  async function patchAccount(name: string, body: Json) {
    existing(name)
    if (body.label !== undefined) {
      panel.data.labels[name] = String(body.label).trim()
      panel.save()
    }
    if (body.proxyId !== undefined || body.proxy !== undefined) {
      let newProxyUrl = ""
      if (body.proxyId) {
        const p = panel.data.proxies.find(p => p.id === body.proxyId) ?? fail(404, `Unknown proxy ${body.proxyId}`)
        newProxyUrl = p.url
      } else {
        const validated = validateProxyUrl(body.proxy)
        newProxyUrl = validated.url
        let p = panel.data.proxies.find(p => p.url === newProxyUrl)
        if (!p) {
          p = {
            id: `px_${randomBytes(4).toString("hex")}`,
            name: `${name} proxy`,
            url: newProxyUrl,
            protocol: validated.protocol,
            note: "",
            lastTest: null,
            createdAt: Date.now(),
          }
          panel.data.proxies.push(p)
          panel.save()
        }
      }
      const ip = await exitIp(newProxyUrl)
      const others = names().filter(n => n !== name).map(n => readEnv(n)!.vars)
      const used = await Promise.all(others.map(v => exitIp(v.ALL_PROXY ?? v.HTTPS_PROXY ?? "").catch(() => null)))
      if (used.includes(ip)) fail(409, `Exit IP ${ip} is already used by another account`)

      const file = [envPath(name), `${envPath(name)}.disabled`].find(existsSync)!
      const text = readFileSync(file, "utf8")
      const lines = text.split("\n")
      const newLines = lines.map(line => {
        const trimmed = line.trim()
        if (trimmed.startsWith("ALL_PROXY=") || trimmed.startsWith("export ALL_PROXY=")) return `ALL_PROXY=${newProxyUrl}`
        if (trimmed.startsWith("HTTP_PROXY=") || trimmed.startsWith("export HTTP_PROXY=")) return `HTTP_PROXY=${newProxyUrl}`
        if (trimmed.startsWith("HTTPS_PROXY=") || trimmed.startsWith("export HTTPS_PROXY=")) return `HTTPS_PROXY=${newProxyUrl}`
        return line
      })
      writePrivate(file, newLines.join("\n"))
      await set.sync()
    }
    const items = getSub2() ? await sub2Accounts().catch(() => null) : null
    return describe(name, items)
  }

  async function deleteAccount(name: string) {
    existing(name)
    logins.get(name)?.child.kill()
    logins.delete(name)
    const deletedDir = join(set.dir, "_deleted")
    mkdirSync(deletedDir, { recursive: true, mode: 0o700 })
    const ts = Date.now()
    renameSync(join(set.dir, name), join(deletedDir, `${name}-${ts}`))
    delete panel.data.labels[name]
    for (const key of panel.data.keys) key.accounts = key.accounts.filter(account => account !== name)
    panel.save()
    await set.sync()
    await setStatus(name, "inactive")
    return { ok: true }
  }

  /** Runs agy once as the account: a new account that is not yet verified answers with Google's verification link. */
  const agyCheck = options.agyCheck ?? (async (name: string) => {
    const home = join(set.dir, name), tmp = join(home, ".tmp"), { vars } = existing(name)
    mkdirSync(tmp, { recursive: true, mode: 0o700 })
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmp, TERM: "dumb",
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state") }
    for (const [key, value] of Object.entries(vars)) if (!key.startsWith("MERIDIAN_")) env[key] = value
    try { const { stdout, stderr } = await run("agy", ["-p", "/usage"], { env, timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 1 << 20 }); return `${stdout}\n${stderr}` }
    catch (error) { const e = error as { stdout?: string; stderr?: string; message?: string }; return `${e.stdout ?? ""}\n${e.stderr ?? ""}\nEligibility check failed: could not run agy (${safeError(e.message ?? "unknown error")})` }
  })
  async function verify(name: string) {
    const { vars, disabled } = existing(name)
    if (disabled) fail(409, "Account is disabled")
    if (!email(name)) fail(409, "Account is not logged in yet")
    return reconcile(name, vars.MERIDIAN_API_KEY ?? "", email(name))
  }
  /** Settings as shown to the browser: the admin key is never returned, only whether one is stored. */
  const sub2Public = () => {
    const cfg = getSub2()
    return { enabled: Boolean(cfg), source: cfg?.source ?? null, base: cfg?.base ?? null, hasKey: Boolean(cfg?.key), groupIds: cfg?.groupIds ?? [], concurrency: cfg?.concurrency ?? null, priority: cfg?.priority ?? null, templateId: cfg?.templateId ?? null }
  }
  const sub2Url = (raw: unknown) => {
    let url: URL
    try { url = new URL(String(raw ?? "").trim()) } catch { return fail(400, "Invalid Sub2API address") }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail(400, "Sub2API address must be an http(s) URL without credentials")
    // Accept either the site root or the /api/v1 base; store the /api/v1 base.
    return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "")}/api/v1`
  }
  const sub2Groups = async (cfg: { base: string; key: string }) => {
    const data = await s2With(cfg, "/admin/groups/all")
    return (Array.isArray(data) ? data : (data?.items ?? [])).map((g: Json) => ({ id: Number(g.id), name: String(g.name ?? ""), platform: String(g.platform ?? ""), status: String(g.status ?? "") }))
  }
  async function saveSub2(body: Json) {
    const current = getSub2()
    const base = body.base === undefined ? current?.base ?? fail(400, "Sub2API address is required") : sub2Url(body.base)
    const keyInput = typeof body.key === "string" ? body.key.trim() : ""
    // A stored key only ever goes to the address it was stored for; a different address needs its own key.
    if (!keyInput && current && base !== current.base) fail(400, "Changing the Sub2API address requires entering the admin key again")
    const key = keyInput || current?.key || fail(400, "Sub2API admin key is required")
    if (/[\s\x00-\x1f]/.test(key)) fail(400, "Invalid Sub2API admin key")
    const ids = Array.isArray(body.groupIds) ? body.groupIds.map(Number) : current?.groupIds ?? []
    if (!ids.length || ids.some(id => !Number.isInteger(id) || id <= 0)) fail(400, "Pick at least one Sub2API group")
    const int = (v: unknown, fallback: number | null) => v === undefined || v === null || v === "" ? fallback : Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : fail(400, "concurrency and priority must be non-negative integers")
    const templateId = body.templateId === undefined ? current?.templateId ?? null : body.templateId === null || body.templateId === "" ? null : Number(body.templateId)
    if (templateId !== null && (!Number.isInteger(templateId) || templateId <= 0)) fail(400, "Invalid template account id")
    // Verify before saving so a typo never replaces a working configuration.
    const groups = await sub2Groups({ base, key })
    const missing = ids.filter(id => !groups.some((g: Json) => g.id === id))
    if (missing.length) fail(400, `Unknown Sub2API group ${missing.join(", ")}`)
    panel.data.sub2api = { base, key, groupIds: ids, concurrency: int(body.concurrency, current?.concurrency ?? 5) ?? 5, priority: int(body.priority, current?.priority ?? 1) ?? 1, templateId }
    panel.save()
    return { ...sub2Public(), groups }
  }
  async function testSub2(body: Json) {
    const current = getSub2()
    const base = body.base ? sub2Url(body.base) : current?.base ?? fail(400, "Sub2API address is required")
    const given = typeof body.key === "string" ? body.key.trim() : ""
    if (!given && current && base !== current.base) fail(400, "Testing a different Sub2API address requires entering the admin key")
    const key = given || current?.key || fail(400, "Sub2API admin key is required")
    const started = Date.now()
    try { const groups = await sub2Groups({ base, key }); return { ok: true, latencyMs: Date.now() - started, groups, error: null } }
    catch (error) { return { ok: false, latencyMs: null, groups: [], error: safeError(error) } }
  }
  /** Brings every logged-in account to Sub2API (eligible ones only); safe to repeat. */
  async function syncSub2() {
    if (!getSub2()) fail(409, "Sub2API is not configured")
    const results: Array<{ name: string; status: string; sub2apiId: number | null; error: string | null }> = []
    for (const name of names()) {
      const env = readEnv(name)!
      if (env.disabled || !email(name)) { results.push({ name, status: env.disabled ? "disabled" : "not-logged-in", sub2apiId: null, error: null }); continue }
      try { const r = await reconcile(name, env.vars.MERIDIAN_API_KEY ?? "", email(name)); results.push({ name, status: r.sub2apiStatus, sub2apiId: r.sub2apiId, error: null }) }
      catch (error) { results.push({ name, status: "error", sub2apiId: null, error: safeError(error) }) }
    }
    return { results }
  }

  async function testAccount(name: string) {
    const { vars } = existing(name)
    if (!set.names.includes(name)) {
      const err = set.failures.get(name) ?? "Account is not serving"
      return { ok: false, latencyMs: null, exitIp: null, health: null, quota: null, error: err }
    }
    const start = Date.now()
    let ip: string | null = null
    let testError: string | null = null
    try {
      ip = await exitIp(vars.ALL_PROXY ?? vars.HTTPS_PROXY ?? "")
    } catch (error) {
      testError = safeError(error)
    }
    const latencyMs = Math.max(1, Date.now() - start)
    quotas.delete(name)
    const [health, status] = await Promise.all([
      probe(name, "/health"),
      probe(name, "/providers/status"),
    ])
    if (status) {
      quotas.set(name, { at: Date.now(), value: status.providers?.find((p: Json) => p.id === "antigravity")?.accounts?.[0] ?? null })
    }
    const quota = quotas.get(name)?.value
    const healthData = health ? Object.fromEntries(["completed", "failed", "reused", "prewarmed", "processes", "activeProcesses", "spareReady"].map(k => [k, health[k]])) : null
    const quotaData = quota ? { fetchedAt: quota.fetchedAt ?? null, error: quota.error ?? null, windows: quota.windows ?? [] } : null
    return {
      ok: testError === null && health !== null,
      latencyMs,
      exitIp: ip,
      health: healthData,
      quota: quotaData,
      error: testError,
    }
  }

  async function login(name: string) {
    logins.get(name)?.child.kill()
    const child = options.spawn?.(name) ?? spawn("python3", [options.loginScript, name], { env: { ...process.env, MERIDIAN_AGY_ACCOUNTS_DIR: set.dir } })
    const entry = { child, out: "" }
    logins.set(name, entry)
    const collect = (chunk: Buffer) => { entry.out += chunk.toString() }
    child.stdout?.on("data", collect)
    child.stderr?.on("data", collect)
    const timer = setTimeout(() => child.kill(), 600_000)
    timer.unref()
    child.once("close", () => { clearTimeout(timer); if (logins.get(name) === entry) logins.delete(name) })
    const found = await until(entry, /AUTH_URL=(\S+)/, 30_000)
    if (!found) { child.kill(); fail(502, `No login URL: ${strip(entry.out).slice(-300)}`) }
    return { url: found![1] }
  }
  async function until(entry: { child: ChildProcess; out: string }, pattern: RegExp, ms: number) {
    for (const end = Date.now() + ms; Date.now() < end;) {
      const match = pattern.exec(entry.out)
      if (match) return match
      if (entry.child.exitCode !== null) return pattern.exec(entry.out)
      await sleep(50)
    }
    return null
  }
  async function submitCode(name: string, code: unknown) {
    if (typeof code !== "string" || !/^\S{1,512}$/.test(code)) fail(400, "Invalid code")
    const entry = logins.get(name) ?? fail(409, "No login in progress")
    if (entry.codeSent) fail(409, "A code was already submitted for this login; start a new login to retry")
    // Non-blocking open: a blocking write to a FIFO nobody reads would pin a libuv thread forever.
    let fd: number
    try { fd = openSync(fifo(name), constants.O_WRONLY | constants.O_NONBLOCK) } catch (error) { return fail(409, "Login is not ready for a code") }
    try { writeSync(fd, `${code}\n`) } finally { closeSync(fd) }
    entry.codeSent = true
    const saved = await until(entry, /TOKEN_SAVED=(yes|no)/, 40_000)
    if (saved?.[1] !== "yes") fail(400, `Login failed: ${strip(/LOGIN_RESULT=([\s\S]*?)(?:TOKEN_SAVED=|$)/.exec(entry.out)?.[1] ?? entry.out).trim().slice(-400)}`)
    logins.delete(name)
    await set.sync()
    const { vars } = existing(name), address = email(name)
    return { email: address, serving: set.names.includes(name), error: set.failures.get(name) ?? null, ...await reconcile(name, vars.MERIDIAN_API_KEY ?? "", address) }
  }
  /** Checks eligibility, then makes Sub2API follow it: eligible accounts are mirrored and active; an unverified one never serves traffic. */
  async function reconcile(name: string, apiKey: string, address: string | null) {
    const eligibility = parseEligibility(await agyCheck(name))
    let sub2apiId: number | null = null, sub2apiStatus: "active" | "inactive" | "pending" | "off" = getSub2() ? "pending" : "off"
    if (getSub2()) {
      if (eligibility.eligible) { sub2apiId = await mirror(name, apiKey, address); sub2apiStatus = "active" }
      else { sub2apiId = await setStatus(name, "inactive"); sub2apiStatus = sub2apiId == null ? "pending" : "inactive" }
    }
    return { sub2apiId, sub2apiStatus, ...eligibility }
  }
  async function mirror(name: string, apiKey: string, address: string | null) {
    const cfg = getSub2()
    if (!cfg) return null
    const found = findSub2(await sub2Accounts(), name)
    if (found) {
      // A record left over from an earlier account with the same number must follow the current key.
      const detail = await s2(`/admin/accounts/${found.id}`)
      const credentials = typeof detail.credentials === "object" && detail.credentials !== null ? detail.credentials : {}
      const stale = credentials.api_key !== apiKey || credentials.base_url !== options.baseUrl
      if (stale || found.status !== "active") await s2(`/admin/accounts/${found.id}`, { method: "PUT", body: { status: "active", ...(stale ? { credentials: { ...credentials, api_key: apiKey, base_url: options.baseUrl } } : {}) } })
      return found.id
    }
    // The template (optional) supplies model mapping, groups and limits; explicit panel settings override it.
    const template = cfg.templateId ? await s2(`/admin/accounts/${cfg.templateId}`) : {}
    const groupIds = cfg.groupIds.length ? cfg.groupIds : template.group_ids ?? []
    if (!groupIds.length) fail(409, "Sub2API group is not configured")
    const created = await s2("/admin/accounts", { method: "POST", body: {
      name: address ?? name, platform: "anthropic", type: "apikey", concurrency: cfg.concurrency ?? template.concurrency ?? 5, priority: cfg.priority ?? template.priority ?? 1, group_ids: groupIds,
      notes: `Antigravity Meridian ${name}`, credentials: { base_url: options.baseUrl, api_key: apiKey, ...(template.credentials?.model_mapping ? { model_mapping: template.credentials.model_mapping } : {}) },
    } })
    return created.id
  }
  async function toggle(name: string, disable: boolean) {
    const { disabled } = existing(name)
    if (disabled !== disable) renameSync(disable ? envPath(name) : `${envPath(name)}.disabled`, disable ? `${envPath(name)}.disabled` : envPath(name))
    await set.sync()
    if (disable) logins.get(name)?.child.kill()
    await setStatus(name, disable ? "inactive" : "active")
    return { ok: true }
  }

  async function route(request: Request, path: string): Promise<unknown> {
    const method = request.method, parts = path.split("/").filter(Boolean).slice(1)
    const body = (method === "POST" || method === "PATCH" || method === "PUT") ? await request.json().catch(() => ({})) as Json : {}
    if (parts[0] === "reload" && method === "POST") return set.sync()
    if (parts[0] === "session" && method === "GET") {
      return { ok: true, version, features: { sub2api: Boolean(getSub2()) } }
    }
    if (parts[0] === "overview" && method === "GET") {
      return getOverview()
    }
    if (parts[0] === "settings" && method === "GET") {
      return {
        version,
        baseUrl: options.baseUrl,
        pool: { max: set.pool?.maxProcesses ?? null },
        sub2api: sub2Public(),
        accountsDir: set.dir,
      }
    }
    if (parts[0] === "sub2api") {
      if (parts.length === 1 && method === "GET") { const cfg = getSub2(); return { ...sub2Public(), groups: cfg ? await sub2Groups(cfg).catch(() => []) : [] } }
      if (parts.length === 1 && method === "PUT") return saveSub2(body)
      if (parts.length === 1 && method === "DELETE") { panel.data.sub2api = null; panel.save(); return sub2Public() }
      if (parts[1] === "test" && method === "POST") return testSub2(body)
      if (parts[1] === "sync" && method === "POST") return syncSub2()
      return fail(404, "Not found")
    }
    if (parts[0] === "proxies") return routeProxies(method, parts.slice(1), body)
    if (parts[0] === "keys") return routeKeys(method, parts.slice(1), body)
    if (parts[0] === "accounts") {
      if (parts.length === 1 && method === "GET") {
        const items = getSub2() ? await sub2Accounts().catch(() => null) : null
        return { accounts: await Promise.all(names().map(name => describe(name, items))), pool: { max: set.pool?.maxProcesses ?? null } }
      }
      if (parts.length === 1 && method === "POST") return create(body)
      const [, name = "", action, subAction] = parts
      const { vars } = existing(name)
      if (parts.length === 2) {
        if (method === "PATCH") return patchAccount(name, body)
        if (method === "DELETE") return deleteAccount(name)
        fail(405, "Method not allowed")
      }
      if (parts.length === 3) {
        if (action === "key") {
          if (method !== "GET") fail(405, "Method not allowed")
          return { key: vars.MERIDIAN_API_KEY ?? "" }
        }
        if (method !== "POST") fail(405, "Method not allowed")
        if (action === "ip") return { exitIp: await exitIp(vars.ALL_PROXY ?? vars.HTTPS_PROXY ?? "") }
        if (action === "login") return login(name)
        if (action === "code") return submitCode(name, body.code)
        if (action === "disable" || action === "enable") return toggle(name, action === "disable")
        if (action === "test") return testAccount(name)
        if (action === "verify") return verify(name)
        return fail(404, "Not found")
      }
      if (parts.length === 4 && action === "key" && subAction === "rotate") {
        if (method !== "POST") fail(405, "Method not allowed")
        return rotateAccountKey(name)
      }
      return fail(404, "Not found")
    }
    fail(404, "Not found")
  }
  return {
    async fetch(request: Request): Promise<Response> {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/") return new Response(agAdminPageHtml, { headers: { "content-type": "text/html; charset=utf-8" } })
      try {
        if (!path.startsWith("/api/")) fail(404, "Not found")
        if (!hasValidApiKey(request.headers, token)) fail(401, "Invalid or missing token")
        return Response.json(await route(request, path))
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        return Response.json({ error: safeError(error) }, { status })
      }
    },
  }
}
