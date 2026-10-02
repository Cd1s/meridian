// Fork patch: admin API for multi-account mode (list, add, log in, disable accounts; mirror them into Sub2API).
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { hasValidApiKey } from "../auth"
import { agAdminPageHtml } from "./antigravityAdminPage"
import { parseAgEnvFile, type AgAccountSet } from "./antigravityAccounts"

type Json = Record<string, any>
export interface AgAdminOptions {
  token: string
  loginScript: string
  sub2api?: { base: string; key: string; templateId: number }
  exec?: (file: string, args: string[]) => Promise<string>
  fetch?: typeof fetch
  spawn?: (name: string) => ChildProcess
  fifoPath?: (name: string) => string
}
class HttpError extends Error { constructor(readonly status: number, message: string) { super(message) } }
const NAME = /^acc[0-9]+$/
const run = promisify(execFile)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const mask = (proxy: string) => proxy.replace(/(\/\/[^:/@]*:)[^@]*@/, "$1***@")
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, "")
const fail = (status: number, message: string): never => { throw new HttpError(status, message) }

export function createAgAdmin(set: AgAccountSet, options: AgAdminOptions) {
  const { token, sub2api } = options
  if (!token) throw new Error("Admin token is required")
  const http = options.fetch ?? fetch
  const exec = options.exec ?? (async (file, args) => (await run(file, args, { timeout: 20_000 })).stdout)
  const fifo = options.fifoPath ?? (name => `/tmp/agy_${name}.fifo`)
  const logins = new Map<string, { child: ChildProcess; out: string }>()
  // Each quota read makes the account run `agy -p /usage`; the panel polls every 15s, so keep results for 5 minutes.
  const quotas = new Map<string, { at: number; value: Json | null }>()

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
    } catch { return null }
  }
  const probe = async (url: string, headers: Record<string, string> = {}) => {
    try {
      const response = await http(url, { headers, signal: AbortSignal.timeout(5000) })
      return response.ok ? await response.json() as Json : null
    } catch { return null }
  }

  const s2 = async (path: string, init: { method?: string; body?: unknown } = {}): Promise<Json> => {
    const response = await http(`${sub2api!.base}${path}`, { method: init.method, headers: { "x-api-key": sub2api!.key, "content-type": "application/json" }, body: init.body === undefined ? undefined : JSON.stringify(init.body), signal: AbortSignal.timeout(15_000) })
    const body = await response.json().catch(() => ({})) as Json
    if (!response.ok || (body.code !== undefined && body.code !== 0)) fail(502, `Sub2API: ${body.message ?? response.status}`)
    return body.data
  }
  const sub2Accounts = async (): Promise<Json[]> => sub2api ? (await s2("/admin/accounts?page=1&page_size=500")).items ?? [] : []
  const baseUrl = (port: number) => `http://127.0.0.1:${port}`
  const findSub2 = (items: Json[], port: number) => items.find(item => item.credentials?.base_url === baseUrl(port))
  const setStatus = async (port: number, status: string) => {
    const found = findSub2(await sub2Accounts(), port)
    if (found && found.status !== status) await s2(`/admin/accounts/${found.id}`, { method: "PUT", body: { status } })
    return found?.id ?? null
  }

  async function describe(name: string, items: Json[] | null) {
    const { vars, disabled } = readEnv(name)!, port = Number(vars.MERIDIAN_PORT)
    const serving = set.names.includes(name), cached = quotas.get(name)
    const fresh = cached && Date.now() - cached.at < 300_000 && cached.value?.fetchedAt
    const [health, status] = await Promise.all([probe(`${baseUrl(port)}/health`), serving && !fresh ? probe(`${baseUrl(port)}/providers/status`, { "x-api-key": vars.MERIDIAN_API_KEY ?? "" }) : null])
    if (status) quotas.set(name, { at: Date.now(), value: status.providers?.find((p: Json) => p.id === "antigravity")?.accounts?.[0] ?? null })
    const quota = serving ? quotas.get(name)?.value : undefined
    return {
      name, port, email: email(name), proxy: mask(vars.ALL_PROXY ?? vars.HTTPS_PROXY ?? ""), disabled, serving, error: set.failures.get(name) ?? null,
      sub2apiId: items ? findSub2(items, port)?.id ?? null : null,
      health: health && Object.fromEntries(["completed", "failed", "reused", "prewarmed", "processes", "activeProcesses", "spareReady"].map(key => [key, health[key]])),
      quota: quota ? { fetchedAt: quota.fetchedAt ?? null, error: quota.error ?? null, windows: quota.windows ?? [] } : null,
    }
  }
  async function create(body: Json) {
    const proxy = String(body.proxy ?? "").trim()
    let url: URL
    try { url = new URL(proxy) } catch { return fail(400, "Invalid proxy URL") }
    if (!["socks5:", "socks5h:", "http:", "https:"].includes(url.protocol) || /[\s"'$`\\]/.test(proxy)) fail(400, "Proxy must be a socks5, socks5h, http or https URL")
    const others = names().map(name => readEnv(name)!.vars)
    const [ip, ...used] = await Promise.all([exitIp(proxy), ...others.map(vars => exitIp(vars.ALL_PROXY ?? vars.HTTPS_PROXY ?? "").catch(() => null))])
    if (used.includes(ip!)) fail(409, `Exit IP ${ip} is already used by another account`)
    const number = Math.max(0, ...names().map(name => Number(name.slice(3)))) + 1, name = `acc${number}`
    const port = Math.max(34600, ...others.map(vars => Number(vars.MERIDIAN_PORT) || 0)) + 10
    mkdirSync(join(set.dir, name), { recursive: true, mode: 0o700 })
    const lines = [`MERIDIAN_PORT=${port}`, `ALL_PROXY=${proxy}`, `HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, `MERIDIAN_API_KEY=cheek-meridian-${name}-${randomBytes(12).toString("hex")}`]
    writeFileSync(envPath(name), lines.join("\n") + "\n", { mode: 0o600 })
    return { name, port, exitIp: ip }
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
    if (!existsSync(fifo(name))) fail(409, "Login is not ready for a code")
    await writeFile(fifo(name), `${code}\n`)
    const saved = await until(entry, /TOKEN_SAVED=(yes|no)/, 40_000)
    if (saved?.[1] !== "yes") fail(400, `Login failed: ${strip(/LOGIN_RESULT=([\s\S]*?)(?:TOKEN_SAVED=|$)/.exec(entry.out)?.[1] ?? entry.out).trim().slice(-400)}`)
    logins.delete(name)
    await set.sync()
    const { vars } = existing(name), port = Number(vars.MERIDIAN_PORT), address = email(name)
    return { email: address, serving: set.names.includes(name), error: set.failures.get(name) ?? null, sub2apiId: await mirror(name, port, vars.MERIDIAN_API_KEY ?? "", address) }
  }
  async function mirror(name: string, port: number, apiKey: string, address: string | null) {
    if (!sub2api) return null
    const found = findSub2(await sub2Accounts(), port)
    if (found) {
      if (found.status !== "active") await s2(`/admin/accounts/${found.id}`, { method: "PUT", body: { status: "active" } })
      return found.id
    }
    const template = await s2(`/admin/accounts/${sub2api.templateId}`)
    const created = await s2("/admin/accounts", { method: "POST", body: {
      name: address ?? name, platform: "anthropic", type: "apikey", concurrency: template.concurrency, priority: template.priority, group_ids: template.group_ids,
      notes: `Antigravity Meridian ${name} (port ${port})`, credentials: { base_url: baseUrl(port), api_key: apiKey, model_mapping: template.credentials?.model_mapping },
    } })
    return created.id
  }
  async function toggle(name: string, disable: boolean) {
    const { vars, disabled } = existing(name)
    if (disabled !== disable) renameSync(disable ? envPath(name) : `${envPath(name)}.disabled`, disable ? `${envPath(name)}.disabled` : envPath(name))
    await set.sync()
    if (disable) logins.get(name)?.child.kill()
    await setStatus(Number(vars.MERIDIAN_PORT), disable ? "inactive" : "active")
    return { ok: true }
  }

  async function route(request: Request, path: string): Promise<unknown> {
    const method = request.method, parts = path.split("/").filter(Boolean).slice(1)
    const body = method === "POST" ? await request.json().catch(() => ({})) as Json : {}
    if (parts[0] === "reload" && method === "POST") return set.sync()
    if (parts[0] !== "accounts") fail(404, "Not found")
    if (parts.length === 1 && method === "GET") {
      const items = sub2api ? await sub2Accounts().catch(() => null) : null
      return { accounts: await Promise.all(names().map(name => describe(name, items))), pool: { max: set.pool?.maxProcesses ?? null } }
    }
    if (parts.length === 1 && method === "POST") return create(body)
    const [, name = "", action] = parts
    const { vars } = existing(name)
    if (method !== "POST") fail(405, "Method not allowed")
    if (action === "ip") return { exitIp: await exitIp(vars.ALL_PROXY ?? vars.HTTPS_PROXY ?? "") }
    if (action === "login") return login(name)
    if (action === "code") return submitCode(name, body.code)
    if (action === "disable" || action === "enable") return toggle(name, action === "disable")
    return fail(404, "Not found")
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
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status })
      }
    },
  }
}
