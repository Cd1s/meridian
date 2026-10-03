// Fork patch: serve several Antigravity accounts from one Meridian process on one port.
// Each account is <dir>/<name>/env (MERIDIAN_API_KEY plus the account's proxy variables) with its agy
// login in <dir>/<name>/.gemini; requests are routed to an account by their API key.
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProxyConfig } from "../types"
import { AgProcessPool } from "./antigravityRuntime"

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
}

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

export function readAgAccounts(dir: string): AgAccount[] {
  const accounts: AgAccount[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const home = join(dir, entry.name), file = join(home, "env")
    if (!existsSync(file)) continue
    const text = readFileSync(file, "utf8")
    const vars = parseAgEnvFile(text)
    // The key is what selects the account, so it must exist and be unique.
    if (!vars.MERIDIAN_API_KEY || vars.MERIDIAN_API_KEY.length < 16) throw new Error(`${entry.name}: MERIDIAN_API_KEY of at least 16 characters is required`)
    // Temp and XDG dirs live in the account too: agy keeps caches in os.TempDir(), which would otherwise be shared.
    const env: Record<string, string> = {
      HOME: home, TMPDIR: join(home, ".tmp"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"),
    }
    for (const [key, value] of Object.entries(vars)) if (!key.startsWith("MERIDIAN_")) env[key] = value
    accounts.push({ name: entry.name, home, apiKey: vars.MERIDIAN_API_KEY, env, statePath: vars.MERIDIAN_AGY_STATE_PATH || undefined, digest: createHash("sha256").update(text).digest("hex") })
  }
  const keys = new Map<string, string>()
  for (const account of accounts) {
    const other = keys.get(account.apiKey)
    if (other) throw new Error(`${other} and ${account.name} use the same MERIDIAN_API_KEY`)
    keys.set(account.apiKey, account.name)
  }
  return accounts
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
  private readonly running = new Map<string, { account: AgAccount; backend: AgBackend }>()
  // Keyed by key digest so the routing table never holds raw keys as map keys.
  private readonly byKey = new Map<string, string>()
  private syncing: Promise<unknown> = Promise.resolve()
  constructor(readonly dir: string, readonly base: Partial<ProxyConfig>, readonly start: Start, poolSize?: number) {
    this.pool = poolSize === undefined ? undefined : new AgProcessPool(poolSize)
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
    // An invalid directory throws before anything is stopped.
    const wanted = new Map(readAgAccounts(this.dir).map(account => [account.name, account]))
    for (const name of this.failures.keys()) if (!wanted.has(name)) this.failures.delete(name)
    const stale = [...this.running].filter(([name, { account }]) => wanted.get(name)?.digest !== account.digest)
    for (const [name, { account }] of stale) { this.running.delete(name); this.byKey.delete(digest(account.apiKey)) }
    await Promise.all(stale.map(([, { backend }]) => backend.close()))
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
    return { started, stopped: stale.map(([name]) => name), failed }
  }
  private async startOne(account: AgAccount): Promise<AgBackend> {
    mkdirSync(account.env.TMPDIR!, { recursive: true, mode: 0o700 })
    return this.start({
      ...this.base, backend: "antigravity", apiKey: account.apiKey, silent: true,
      // statePath is set explicitly so a process-wide MERIDIAN_AGY_STATE_PATH is never shared between accounts.
      antigravity: { ...this.base.antigravity, env: account.env, statePath: account.statePath, pool: this.pool },
    })
  }
  /** The shared listener: the request's API key picks the account. */
  route(request: Request): Promise<Response> {
    const key = agRequestKey(request.headers)
    const name = key ? this.byKey.get(digest(key)) : undefined
    const entry = name ? this.running.get(name) : undefined
    if (entry) return entry.backend.fetch(request)
    if (!key && ["/health", "/readyz", "/livez"].includes(new URL(request.url).pathname)) return Promise.resolve(Response.json({ status: "healthy", backend: "antigravity", accounts: this.running.size, failed: this.failures.size }))
    return Promise.resolve(denied())
  }
  /** Calls one account's backend in-process with its own key (admin panel). */
  async request(name: string, path: string): Promise<Response | undefined> {
    const entry = this.running.get(name)
    return entry?.backend.fetch(new Request(`http://accounts.local${path}`, { headers: { "x-api-key": entry.account.apiKey } }))
  }
  async close(): Promise<void> {
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
  return { fetch: request => Promise.resolve(backend.app.fetch(request)), close: async () => { backend.beginDrain?.(); await backend.closeBackend() } }
}
