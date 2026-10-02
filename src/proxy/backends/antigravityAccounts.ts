// Fork patch: serve several Antigravity accounts from one Meridian process.
// Layout matches the one-service-per-account setup: <dir>/<name>/env holds MERIDIAN_PORT,
// MERIDIAN_API_KEY and the account's proxy variables; agy keeps its login in <dir>/<name>/.gemini.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ProxyConfig, ProxyInstance } from "../types"
import { AgProcessPool } from "./antigravityRuntime"

export interface AgAccount {
  name: string
  home: string
  port: number
  apiKey: string
  /** Variables for this account's agy processes: HOME plus every non-MERIDIAN_ entry of its env file. */
  env: Record<string, string>
  statePath?: string
  digest: string
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
    const port = Number(vars.MERIDIAN_PORT)
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw new Error(`${entry.name}: MERIDIAN_PORT must be a TCP port`)
    // Each account answers on its own port, so an empty key would expose it unauthenticated.
    if (!vars.MERIDIAN_API_KEY) throw new Error(`${entry.name}: MERIDIAN_API_KEY is required`)
    const env: Record<string, string> = { HOME: home }
    for (const [key, value] of Object.entries(vars)) if (!key.startsWith("MERIDIAN_")) env[key] = value
    accounts.push({ name: entry.name, home, port, apiKey: vars.MERIDIAN_API_KEY, env, statePath: vars.MERIDIAN_AGY_STATE_PATH || undefined, digest: createHash("sha256").update(text).digest("hex") })
  }
  const ports = new Map<number, string>()
  for (const account of accounts) {
    const other = ports.get(account.port)
    if (other) throw new Error(`${other} and ${account.name} both use port ${account.port}`)
    ports.set(account.port, account.name)
  }
  return accounts
}

type Start = (config: Partial<ProxyConfig>) => Promise<ProxyInstance>

export class AgAccountSet {
  readonly pool?: AgProcessPool
  private readonly running = new Map<string, { account: AgAccount; proxy: ProxyInstance }>()
  private syncing: Promise<unknown> = Promise.resolve()
  constructor(readonly dir: string, readonly base: Partial<ProxyConfig>, readonly start: Start, poolSize?: number) {
    this.pool = poolSize === undefined ? undefined : new AgProcessPool(poolSize)
  }
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
    const stale = [...this.running].filter(([name, { account }]) => wanted.get(name)?.digest !== account.digest)
    for (const [name] of stale) this.running.delete(name)
    await Promise.all(stale.map(([, { proxy }]) => proxy.close()))
    // Each account runs its startup probes (~10s through a proxy), so start them together.
    const pending = [...wanted.values()].filter(account => !this.running.has(account.name))
    const results = await Promise.allSettled(pending.map(account => this.startOne(account)))
    const started: string[] = [], failed: string[] = []
    results.forEach((result, index) => {
      const account = pending[index]!
      if (result.status === "fulfilled") {
        this.running.set(account.name, { account, proxy: result.value })
        started.push(account.name)
      } else {
        console.error(`[accounts] ${account.name}: ${result.reason instanceof Error ? result.reason.message : result.reason}`)
        failed.push(account.name)
      }
    })
    return { started, stopped: stale.map(([name]) => name), failed }
  }
  private async startOne(account: AgAccount): Promise<ProxyInstance> {
    const proxy = await this.start({
      ...this.base, backend: "antigravity", port: account.port, apiKey: account.apiKey, silent: true,
      // statePath is set explicitly so a process-wide MERIDIAN_AGY_STATE_PATH is never shared between accounts.
      antigravity: { ...this.base.antigravity, env: account.env, statePath: account.statePath, pool: this.pool },
    })
    if (!proxy.server.listening) await new Promise<void>((resolve, reject) => {
      proxy.server.once("listening", resolve)
      proxy.server.once("error", error => { void proxy.close().catch(() => {}); reject(error) })
    })
    console.log(`[accounts] ${account.name}: http://${proxy.config.host}:${account.port}`)
    return proxy
  }
  async close(): Promise<void> {
    await this.syncing
    const proxies = [...this.running.values()].map(entry => entry.proxy)
    this.running.clear()
    await Promise.all(proxies.map(proxy => proxy.close()))
  }
}
