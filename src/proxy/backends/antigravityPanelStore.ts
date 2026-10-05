import { createHash, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseAgEnvFile } from "./antigravityAccounts"

export type ProxyProtocol = "socks5" | "socks5h" | "http" | "https"

export interface ProxyTestResult {
  ok: boolean
  exitIp: string | null
  latencyMs: number | null
  at: number
  error: string | null
}

export interface AdminProxy extends PanelProxy {
  usedBy: string[]
}

export interface PanelProxy {
  id: string
  name: string
  url: string
  protocol: ProxyProtocol
  note: string
  lastTest: ProxyTestResult | null
  createdAt: number
}

export interface PanelGatewayKey {
  id: string
  name: string
  prefix: string
  hash: string
  scope: "all" | "accounts"
  accounts: string[]
  enabled: boolean
  createdAt: number
  lastUsedAt: number | null
  requests: number
}

/** Sub2API sync settings entered in the panel; the admin key lives only in the 0600 panel.json on the server. */
export interface PanelSub2api {
  base: string
  key: string
  groupIds: number[]
  concurrency: number
  priority: number
  templateId: number | null
}

export interface PanelData {
  labels: Record<string, string>
  proxies: PanelProxy[]
  keys: PanelGatewayKey[]
  sub2api: PanelSub2api | null
}

const NAME_REGEX = /^acc[0-9]+$/

export function maskProxyUrl(proxy: string): string {
  return proxy.replace(/(\/\/[^:/@]*:)[^@]*@/, "$1***@")
}

export function hashGatewaySecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex")
}

export function createDefaultPanelData(): PanelData {
  return {
    labels: {},
    proxies: [],
    keys: [],
    sub2api: null,
  }
}

export class AgPanelStore {
  readonly filePath: string
  data: PanelData
  private throttleTimer: ReturnType<typeof setTimeout> | null = null
  private pendingThrottledSave = false

  constructor(readonly dir: string) {
    this.filePath = join(dir, "panel.json")
    this.data = this.load()
  }

  load(): PanelData {
    let data: PanelData = createDefaultPanelData()
    if (existsSync(this.filePath)) {
      try {
        const text = readFileSync(this.filePath, "utf8")
        const parsed = JSON.parse(text) as Partial<PanelData>
        data = {
          labels: typeof parsed.labels === "object" && parsed.labels !== null ? parsed.labels : {},
          proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
          keys: Array.isArray(parsed.keys) ? parsed.keys : [],
          sub2api: parsed.sub2api && typeof parsed.sub2api === "object" && typeof parsed.sub2api.base === "string" && typeof parsed.sub2api.key === "string" ? parsed.sub2api : null,
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[panelStore] Failed to read ${this.filePath}: ${msg}`)
        data = createDefaultPanelData()
      }
    }

    if (data.proxies.length === 0 && existsSync(this.dir)) {
      const imported = this.autoImportProxies(data)
      if (imported) {
        this.saveData(data)
      }
    }

    return data
  }

  save(): void {
    this.saveData(this.data)
  }

  private saveData(data: PanelData): void {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    }
    const tmp = join(this.dir, `.panel.json.${randomBytes(6).toString("hex")}.tmp`)
    const content = JSON.stringify(data, null, 2) + "\n"
    writeFileSync(tmp, content, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.filePath)
  }

  saveThrottled(): void {
    this.pendingThrottledSave = true
    if (this.throttleTimer) return
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null
      if (this.pendingThrottledSave) {
        this.pendingThrottledSave = false
        this.save()
      }
    }, 5000)
    this.throttleTimer.unref?.()
  }

  flush(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer)
      this.throttleTimer = null
    }
    if (this.pendingThrottledSave) {
      this.pendingThrottledSave = false
      this.save()
    }
  }

  autoImportProxies(data: PanelData): boolean {
    const accountDirs: string[] = []
    try {
      const entries = readdirSync(this.dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && NAME_REGEX.test(entry.name)) {
          accountDirs.push(entry.name)
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.error(`[panelStore] readdir failed for ${this.dir}: ${msg}`)
      return false
    }

    accountDirs.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))

    const seenUrls = new Set<string>()
    for (const p of data.proxies) {
      seenUrls.add(p.url)
    }

    let addedCount = 0
    for (const name of accountDirs) {
      const envFile = [join(this.dir, name, "env"), join(this.dir, name, "env.disabled")].find(existsSync)
      if (!envFile) continue
      try {
        const text = readFileSync(envFile, "utf8")
        const vars = parseAgEnvFile(text)
        const proxyUrl = vars.ALL_PROXY
        if (proxyUrl && !seenUrls.has(proxyUrl)) {
          let protocol: ProxyProtocol = "http"
          try {
            const parsedUrl = new URL(proxyUrl)
            const proto = parsedUrl.protocol.replace(/:$/, "")
            if (proto === "socks5" || proto === "socks5h" || proto === "http" || proto === "https") {
              protocol = proto
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            console.error(`[panelStore] invalid URL for ${name}: ${msg}`)
          }

          seenUrls.add(proxyUrl)
          data.proxies.push({
            id: `px_${randomBytes(4).toString("hex")}`,
            name: `${name} proxy`,
            url: proxyUrl,
            protocol,
            note: "",
            lastTest: null,
            createdAt: Date.now(),
          })
          addedCount++
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[panelStore] Failed to read env for ${name}: ${msg}`)
      }
    }

    return addedCount > 0
  }
}
