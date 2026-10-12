// Fork patch: serve several Antigravity accounts from one Meridian process on one port.
// Each account is <dir>/<name>/env (MERIDIAN_API_KEY plus the account's proxy variables) with its agy
// login in <dir>/<name>/.gemini; requests are routed to an account by their API key.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProxyConfig } from "../types"
import { AgProcessPool } from "./antigravityRuntime"
import { AgPanelStore } from "./antigravityPanelStore"
import { agContinuation, type AgContinuation, type AgHold } from "./antigravityProtocol"

export interface AgAccount {
  name: string
  home: string
  apiKey: string
  /** Variables for this account's agy processes: HOME and private temp/XDG dirs, then every non-MERIDIAN_ entry of its env file. */
  env: Record<string, string>
  statePath?: string
  digest: string
}
/** One account's Antigravity backend, served in-process without its own listener. */
export interface AgBackend {
  fetch(request: Request): Promise<Response>
  close(): Promise<void>
  /** Whether this account holds the conversation a request continues (see createAntigravityServer). */
  holds?(continuation: AgContinuation): AgHold | undefined
}
const AFFINITY_PATHS = new Set(["/v1/messages", "/messages", "/v1/chat/completions", "/v1/responses"])

export function parseAgEnvFile(text: string): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || !line.includes("=")) continue
    const index = line.indexOf("=")
    const key = line.slice(0, index).replace(/^export\s+/, "").trim()
    let value = line.slice(index + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) vars[key] = value
  }
  return vars
}

/** Valid accounts plus the reason each invalid one was skipped; one bad file never blocks the others. */
export function readAgAccounts(dir: string): { accounts: AgAccount[]; invalid: Map<string, string> } {
  const accounts: AgAccount[] = [], invalid = new Map<string, string>()
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const home = join(dir, entry.name), file = join(home, "env")
    if (!existsSync(file)) continue
    const text = readFileSync(file, "utf8")
    const vars = parseAgEnvFile(text)
    // The key is what selects the account, so it must exist and be unique.
    if (!vars.MERIDIAN_API_KEY || vars.MERIDIAN_API_KEY.length < 16) { invalid.set(entry.name, "MERIDIAN_API_KEY of at least 16 characters is required"); continue }
    // Temp and XDG dirs live in the account too: agy keeps caches in os.TempDir(), which would otherwise be shared.
    const env: Record<string, string> = {
      HOME: home, TMPDIR: join(home, ".tmp"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
    }
    for (const [key, value] of Object.entries(vars)) {
      if (key === "MERIDIAN_AGY_COMPAT_BRIDGE" || key === "MERIDIAN_AGY_ENABLE_CLOUD_CODE_BRIDGE" || !key.startsWith("MERIDIAN_")) env[key] = value
    }
    accounts.push({ name: entry.name, home, apiKey: vars.MERIDIAN_API_KEY, env, statePath: vars.MERIDIAN_AGY_STATE_PATH || undefined, digest: createHash("sha256").update(text).digest("hex") })
  }
  const owners = new Map<string, string[]>()
  for (const account of accounts) owners.set(account.apiKey, [...owners.get(account.apiKey) ?? [], account.name])
  // A shared key cannot pick one account, so every account using it is skipped.
  for (const names of owners.values()) if (names.length > 1) for (const name of names) invalid.set(name, `${names.join(" and ")} use the same MERIDIAN_API_KEY`)
  return { accounts: accounts.filter(account => !invalid.has(account.name)), invalid }
}

type Start = (config: Partial<ProxyConfig>) => Promise<AgBackend>
const digest = (key: string) => createHash("sha256").update(key).digest("hex")
export function agRequestKey(headers: Headers): string | undefined {
  const authorization = headers.get("authorization")
  return headers.get("x-api-key") || (authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined) || undefined
}
const denied = () => Response.json({ type: "error", error: { type: "authentication_error", message: "Invalid or missing API key" } }, { status: 401 })

export class AgAccountSet {
  readonly pool?: AgProcessPool
  readonly panel: AgPanelStore
  private readonly running = new Map<string, { account: AgAccount; backend: AgBackend }>()
  // Keyed by key digest so the routing table never holds raw keys as map keys.
  private readonly byKey = new Map<string, string>()
  private readonly rrIndex = new Map<string, number>()
  private syncing: Promise<unknown> = Promise.resolve()
  constructor(readonly dir: string, readonly base: Partial<ProxyConfig>, readonly start: Start, poolSize?: number) {
    this.pool = poolSize === undefined ? undefined : new AgProcessPool(poolSize)
    this.panel = new AgPanelStore(this.dir)
  }
  /** Last start error per account that is not serving; retried on the next sync. */
  readonly failures = new Map<string, string>()
  get names(): string[] { return [...this.running.keys()] }
  /** Start added accounts, stop removed ones and restart changed ones; unchanged accounts keep serving. */
  sync(): Promise<{ started: string[]; stopped: string[]; failed: string[] }> {
    const next = this.syncing.then(() => this.syncOnce())
    this.syncing = next.catch(() => {})
    return next
  }
  private async syncOnce() {
    const { accounts, invalid } = readAgAccounts(this.dir)
    const wanted = new Map(accounts.map(account => [account.name, account]))
    for (const name of this.failures.keys()) if (!wanted.has(name) && !invalid.has(name)) this.failures.delete(name)
    for (const [name, message] of invalid) {
      if (this.failures.get(name) !== message) console.error(`[accounts] ${name}: ${message}`)
      this.failures.set(name, message)
    }
    const stale = [...this.running].filter(([name, { account }]) => wanted.get(name)?.digest !== account.digest)
    for (const [name, { account }] of stale) { this.running.delete(name); this.byKey.delete(digest(account.apiKey)) }
    // A backend that fails to close must not stop the rest of the sync; its account restarts below if still wanted.
    for (const [index, result] of (await Promise.allSettled(stale.map(([, { backend }]) => backend.close()))).entries())
      if (result.status === "rejected") console.error(`[accounts] ${stale[index]![0]}: close failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`)
    // Each account runs its startup probes (~10s through a proxy), so start them together.
    const pending = [...wanted.values()].filter(account => !this.running.has(account.name))
    const results = await Promise.allSettled(pending.map(account => this.startOne(account)))
    const started: string[] = [], failed: string[] = []
    results.forEach((result, index) => {
      const account = pending[index]!
      if (result.status === "fulfilled") {
        this.running.set(account.name, { account, backend: result.value })
        this.byKey.set(digest(account.apiKey), account.name)
        this.failures.delete(account.name)
        started.push(account.name)
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
        if (this.failures.get(account.name) !== message) console.error(`[accounts] ${account.name}: ${message}`)
        this.failures.set(account.name, message)
        failed.push(account.name)
      }
    })
    return { started, stopped: stale.map(([name]) => name), failed: [...invalid.keys(), ...failed] }
  }
  private async startOne(account: AgAccount): Promise<AgBackend> {
    mkdirSync(account.env.TMPDIR!, { recursive: true, mode: 0o700 })
    return this.start({
      ...this.base, backend: "antigravity", apiKey: account.apiKey, silent: true,
      // statePath is set explicitly so a process-wide MERIDIAN_AGY_STATE_PATH is never shared between accounts.
      antigravity: { ...this.base.antigravity, env: account.env, statePath: account.statePath, pool: this.pool },
    })
  }
  /** The shared listener: the request's API key picks the account, or routes via gateway keys. */
  route(request: Request): Promise<Response> {
    const key = agRequestKey(request.headers)
    const name = key ? this.byKey.get(digest(key)) : undefined
    if (name && this.running.has(name)) return this.dispatch(request, name, [...this.running.keys()], false)

    if (!key && ["/health", "/readyz", "/livez"].includes(new URL(request.url).pathname)) {
      return Promise.resolve(Response.json({ status: "healthy", backend: "antigravity", accounts: this.running.size, failed: this.failures.size }))
    }

    if (key) {
      const keyHash = digest(key)
      const gwKey = this.panel.data.keys.find(k => k.hash === keyHash)
      if (gwKey && gwKey.enabled) {
        const runningNames = [...this.running.keys()].sort()
        const eligible = (gwKey.scope === "accounts"
          ? runningNames.filter(n => gwKey.accounts.includes(n))
          : runningNames)
        if (eligible.length === 0) {
          return Promise.resolve(Response.json({
            type: "error",
            error: {
              type: "api_error",
              message: "No serving account",
            },
          }, { status: 503 }))
        }
        const idx = this.rrIndex.get(gwKey.id) ?? 0
        const selectedName = eligible[idx % eligible.length]!
        this.rrIndex.set(gwKey.id, idx + 1)

        gwKey.requests += 1
        gwKey.lastUsedAt = Date.now()
        this.panel.saveThrottled()
        return this.dispatch(request, selectedName, eligible, true)
      }
    }

    return Promise.resolve(denied())
  }
  /**
   * Sends a request to the selected account, unless another eligible account holds the conversation it continues: a
   * delivered tool call, an idle live process or native snapshot it extends, or a stored Responses id. Routers in front
   * (key round-robin here, Sub2API upstream) pick accounts per request, and an account that does not hold the
   * conversation can only replay it. If the holder fails before responding, the selected account still serves it.
   */
  private async dispatch(request: Request, selectedName: string, eligible: string[], rekey: boolean): Promise<Response> {
    const path = new URL(request.url).pathname
    const affinity = process.env.MERIDIAN_AGY_ACCOUNT_AFFINITY !== "0" && request.method === "POST" && AFFINITY_PATHS.has(path) && eligible.length > 1
    if (!affinity) return this.send(request, selectedName, rekey)
    // node-server's lightweight Request has a body stream but no text().
    const text = request.body ? await new Response(request.body).text() : ""
    let raw: unknown
    try { raw = JSON.parse(text) } catch { raw = undefined }
    const continuation = agContinuation(path, raw)
    const selected = this.running.get(selectedName)!
    const kind = selected.backend.holds?.(continuation)
    let holder: { name: string; kind: AgHold } | undefined
    if (!kind) for (const name of eligible) {
      if (name === selectedName) continue
      const held = this.running.get(name)?.backend.holds?.(continuation)
      if (held) { holder = { name, kind: held }; break }
    }
    if (!holder) return this.send(request, selectedName, rekey, text)
    const response = await this.send(request, holder.name, true, text)
    const fallback = response.status >= 400
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "agy_account_affinity", path, kind: holder.kind, selected: selectedName, holder: holder.name, status: response.status, fallback }))
    if (!fallback) return response
    await response.body?.cancel()
    return this.send(request, selectedName, rekey, text)
  }
  /** Forwards to one account, with that account's key when the request did not arrive with it. */
  private send(request: Request, name: string, rekey: boolean, body?: string): Promise<Response> {
    const entry = this.running.get(name)!
    if (!rekey && body === undefined) return entry.backend.fetch(request)
    const headers = new Headers(request.headers)
    if (rekey) {
      headers.set("x-api-key", entry.account.apiKey)
      if (headers.has("authorization")) headers.set("authorization", `Bearer ${entry.account.apiKey}`)
    }
    // Rebuild from the URL: node-server's lightweight Request cannot be cloned with `new Request(request, ...)`.
    const hasBody = request.method !== "GET" && request.method !== "HEAD"
    const payload = body ?? (hasBody ? request.body : undefined)
    return entry.backend.fetch(new Request(request.url, { method: request.method, headers, body: payload, signal: request.signal, ...(payload instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit))
  }
  /** Calls one account's backend in-process with its own key (admin panel). */
  async request(name: string, path: string): Promise<Response | undefined> {
    const entry = this.running.get(name)
    return entry?.backend.fetch(new Request(`http://accounts.local${path}`, { headers: { "x-api-key": entry.account.apiKey } }))
  }
  async close(): Promise<void> {
    this.panel.flush()
    this.rrIndex.clear()
    await this.syncing
    const backends = [...this.running.values()].map(entry => entry.backend)
    this.running.clear()
    this.byKey.clear()
    await Promise.all(backends.map(backend => backend.close()))
  }
}

/** In-process backend for one account: same construction as startProxyServer's antigravity branch, minus the listener. */
export async function startAgBackend(config: Partial<ProxyConfig>): Promise<AgBackend> {
  const { resolveBackendConfig } = await import("../types")
  const { createAntigravityServer } = await import("./antigravity")
  const backend = createAntigravityServer(resolveBackendConfig(config))
  try { await backend.initPlugins?.() } catch (error) { await backend.closeBackend(); throw error }
  return { fetch: request => Promise.resolve(backend.app.fetch(request)), close: async () => { backend.beginDrain?.(); await backend.closeBackend() }, holds: continuation => backend.holds(continuation) }
}
