import { spawn } from "node:child_process"
import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgAdmin } from "../proxy/backends/antigravityAdmin"
import { AgAccountSet } from "../proxy/backends/antigravityAccounts"
import type { ProxyConfig } from "../proxy/types"

const cleanup: Array<() => unknown> = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })
const TOKEN = "admin-token-0123456789"
const auth = { authorization: `Bearer ${TOKEN}` }
const jwt = (email: string) => `h.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.s`
const K1 = "secret-key-acc1-0123456789", K2 = "secret-key-acc2-0123456789"
const sub2 = (data: unknown) => Response.json({ code: 0, message: "ok", data })

function setup(files: Record<string, string>, options: { sub2: boolean } = { sub2: false }) {
  const dir = mkdtempSync(join(tmpdir(), "meridian-admin-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) { mkdirSync(join(dir, name)); writeFileSync(join(dir, name, "env"), text) }
  const backendCalls: Array<{ key: string | null; path: string }> = []
  const start = async (config: Partial<ProxyConfig>) => ({
    close: async () => {},
    fetch: async (request: Request) => {
      const path = new URL(request.url).pathname
      backendCalls.push({ key: request.headers.get("x-api-key"), path })
      if (config.apiKey !== K1) return new Response("down", { status: 503 })
      if (path === "/health") return Response.json({ completed: 3, failed: 1, reused: 2, prewarmed: 0, processes: 1, activeProcesses: 0, spareReady: 1, secret: "no" })
      return Response.json({ providers: [{ id: "antigravity", accounts: [{ fetchedAt: 5, windows: [{ type: "5h", group: "g", utilization: 0.25, resetsAt: 9 }] }] }] })
    },
  })
  const set = new AgAccountSet(dir, { host: "127.0.0.1" }, start, 3)
  const calls: Array<{ url: string; method: string; body?: any }> = []
  const sub2Items: any[] = [{ id: 7, name: "x", status: "active", notes: "Antigravity Meridian acc1 (port 34610)" }, { id: 8, name: "y", status: "active", notes: "Antigravity Meridian acc10" }]
  const fakeFetch = (async (input: any, init: any = {}) => {
    const url = String(input), method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ url, method, body })
    if (url.startsWith("http://s2/admin/accounts?")) return sub2({ items: sub2Items })
    if (url === "http://s2/admin/accounts/2255") return sub2({ concurrency: 4, priority: 3, group_ids: [9], credentials: { model_mapping: { a: "b" } } })
    if (url === "http://s2/admin/accounts" && method === "POST") return sub2({ id: 99 })
    if (url.startsWith("http://s2/admin/accounts/") && method === "PUT") return sub2({})
    return new Response("?", { status: 500 })
  }) as unknown as typeof fetch
  const ips: Record<string, string> = { "socks5h://u:pw@p1:1": "1.1.1.1", "socks5h://p2:1": "2.2.2.2", "socks5h://new:1": "3.3.3.3", "socks5h://dup:1": "1.1.1.1" }
  const exec = async (_file: string, args: string[]) => ips[args[4]!] ?? ""
  const fifo = join(dir, "fifo")
  const script = join(dir, "login.cjs")
  writeFileSync(script, `const fs=require("fs"),[dir,fifo,name]=[process.env.D,process.env.F,process.argv[2]]
fs.writeFileSync(fifo,"");console.log("AUTH_URL=https://auth.example/x");console.log("READY_FOR_CODE")
const t=setInterval(()=>{if(!fs.readFileSync(fifo,"utf8").includes("\\n"))return;clearInterval(t)
const d=dir+"/"+name+"/.gemini/antigravity-cli";fs.mkdirSync(d,{recursive:true});fs.writeFileSync(d+"/antigravity-oauth-token",JSON.stringify({token:{id_token:"${jwt("new@x.com")}"}}))
console.log("LOGIN_RESULT=\\x1b[1mok\\x1b[0m");console.log("TOKEN_SAVED="+(fs.readFileSync(fifo,"utf8").startsWith("bad")?"no":"yes"))},50)`)
  const admin = createAgAdmin(set, {
    token: TOKEN, baseUrl: "http://127.0.0.1:3451", loginScript: script, exec, fetch: fakeFetch, fifoPath: () => fifo,
    sub2api: options.sub2 ? { base: "http://s2", key: "s2key", templateId: 2255 } : undefined,
    spawn: name => spawn(process.execPath, [script, name], { env: { ...process.env, D: dir, F: fifo } }),
  })
  const req = (path: string, init: RequestInit = {}, headers: Record<string, string> = auth) =>
    admin.fetch(new Request(`http://local${path}`, { ...init, headers: { ...headers, "content-type": "application/json" } }))
  const post = (path: string, body: unknown = {}) => req(path, { method: "POST", body: JSON.stringify(body) })
  return { dir, set, calls, backendCalls, sub2Items, req, post, admin }
}
const base = { acc1: `MERIDIAN_PORT=34610\nMERIDIAN_API_KEY=${K1}\nALL_PROXY=socks5h://u:pw@p1:1\n`, acc2: `MERIDIAN_API_KEY=${K2}\nALL_PROXY=socks5h://p2:1\n` }

describe("Antigravity admin API", () => {
  it("requires the token under /api but serves the page without it", async () => {
    const { req } = setup(base)
    expect((await req("/", {}, {})).headers.get("content-type")).toContain("text/html")
    expect((await req("/api/accounts", {}, {})).status).toBe(401)
    expect((await req("/api/accounts", {}, { authorization: "Bearer wrong" })).status).toBe(401)
    expect(((await (await req("/api/accounts", {}, {})).json()) as any).error).toBeString()
  })
  it("lists accounts without secrets, with email, health, quota and Sub2API ids", async () => {
    const { req, set, dir, backendCalls } = setup({ ...base, acc3: "MERIDIAN_API_KEY=secret-key-acc3-0123456789\n" }, { sub2: true })
    renameSync(join(dir, "acc3", "env"), join(dir, "acc3", "env.disabled"))
    mkdirSync(join(dir, "acc1/.gemini/antigravity-cli"), { recursive: true })
    writeFileSync(join(dir, "acc1/.gemini/antigravity-cli/antigravity-oauth-token"), JSON.stringify({ id_token: jwt("a@b.com") }))
    await set.sync()
    const text = await (await req("/api/accounts")).text()
    expect(text).not.toContain("secret-key")
    expect(text).not.toContain("port")
    expect(text).not.toContain("pw@")
    const { accounts, pool } = JSON.parse(text)
    expect(pool).toEqual({ max: 3 })
    expect(accounts.map((a: any) => a.name)).toEqual(["acc1", "acc2", "acc3"])
    expect(accounts[0]).toMatchObject({ email: "a@b.com", proxy: "socks5h://u:***@p1:1", disabled: false, serving: true, error: null, sub2apiId: 7,
      health: { completed: 3, failed: 1, reused: 2, prewarmed: 0, processes: 1, activeProcesses: 0, spareReady: 1 },
      quota: { fetchedAt: 5, error: null, windows: [{ type: "5h", group: "g", utilization: 0.25, resetsAt: 9 }] } })
    expect(accounts[0].health.secret).toBeUndefined()
    expect(accounts[0].port).toBeUndefined()
    expect(accounts[1].sub2apiId).toBe(null)
    expect(backendCalls.filter(c => c.key === K1).map(c => c.path).sort()).toEqual(["/health", "/providers/status"])
    expect(accounts[1]).toMatchObject({ email: null, health: null, quota: null, sub2apiId: null })
    expect(accounts[2]).toMatchObject({ disabled: true, serving: false })
  })
  it("creates the next account with a private env file and rejects duplicate exit IPs and bad proxies", async () => {
    const { post, dir } = setup(base)
    const response = await post("/api/accounts", { proxy: "socks5h://new:1" })
    expect(await response.json()).toEqual({ name: "acc3", exitIp: "3.3.3.3" })
    const file = join(dir, "acc3", "env")
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, "acc3")).mode & 0o777).toBe(0o700)
    const text = readFileSync(file, "utf8")
    expect(text).toMatch(/^ALL_PROXY=socks5h:\/\/new:1\nHTTP_PROXY=socks5h:\/\/new:1\nHTTPS_PROXY=socks5h:\/\/new:1\nMERIDIAN_API_KEY=cheek-meridian-acc3-[0-9a-f]{24}\n$/)
    expect(text).not.toContain("MERIDIAN_PORT")
    expect((await post("/api/accounts", { proxy: "socks5h://dup:1" })).status).toBe(409)
    expect(existsSync(join(dir, "acc4"))).toBe(false)
    expect((await post("/api/accounts", { proxy: "ftp://x:1" })).status).toBe(400)
    expect((await post("/api/accounts", { proxy: "nonsense" })).status).toBe(400)
  })
  it("reports an account's exit IP and rejects bad or traversing names", async () => {
    const { post, req, dir } = setup(base)
    expect(await (await post("/api/accounts/acc2/ip")).json()).toEqual({ exitIp: "2.2.2.2" })
    mkdirSync(join(dir, "acc9"))
    for (const name of ["acc9", "acc7", "..", "acc1%2F..%2Facc2", "x", "acc1.."]) expect((await post(`/api/accounts/${name}/ip`)).status).toBe(404)
    expect((await req("/api/accounts/acc1/ip")).status).toBe(405)
  })
  it("disables and re-enables an account and mirrors the status to Sub2API", async () => {
    const { post, set, dir, calls, sub2Items } = setup(base, { sub2: true })
    await set.sync()
    expect(await (await post("/api/accounts/acc1/disable")).json()).toEqual({ ok: true })
    expect(existsSync(join(dir, "acc1", "env"))).toBe(false)
    expect(existsSync(join(dir, "acc1", "env.disabled"))).toBe(true)
    expect(set.names).toEqual(["acc2"])
    expect(calls.find(c => c.method === "PUT")).toMatchObject({ url: "http://s2/admin/accounts/7", body: { status: "inactive" } })
    expect(calls.filter(c => c.method === "PUT")).toHaveLength(1)
    sub2Items[0].status = "inactive"
    await post("/api/accounts/acc1/enable")
    expect(existsSync(join(dir, "acc1", "env"))).toBe(true)
    expect(set.names).toContain("acc1")
    expect(calls.filter(c => c.method === "PUT").at(-1)?.body).toEqual({ status: "active" })
  })
  it("logs in, takes the code and creates the Sub2API account from the template", async () => {
    const { post, calls, dir, sub2Items } = setup({ acc1: base.acc1 }, { sub2: true })
    sub2Items.length = 0
    expect(await (await post("/api/accounts/acc1/code", { code: "x" })).json()).toEqual({ error: "No login in progress" })
    expect(await (await post("/api/accounts/acc1/login")).json()).toEqual({ url: "https://auth.example/x" })
    expect((await post("/api/accounts/acc1/code", { code: "has space" })).status).toBe(400)
    const result = await (await post("/api/accounts/acc1/code", { code: "4/abc" })).json() as any
    expect(result).toEqual({ email: "new@x.com", serving: true, error: null, sub2apiId: 99 })
    expect(calls.find(c => c.method === "POST")?.body).toEqual({
      name: "new@x.com", platform: "anthropic", type: "apikey", concurrency: 4, priority: 3, group_ids: [9], notes: "Antigravity Meridian acc1",
      credentials: { base_url: "http://127.0.0.1:3451", api_key: K1, model_mapping: { a: "b" } },
    })
    expect(existsSync(join(dir, "acc1/.gemini/antigravity-cli/antigravity-oauth-token"))).toBe(true)
  })
  it("answers a failed login with the cleaned result", async () => {
    const { post } = setup({ acc1: base.acc1 })
    await post("/api/accounts/acc1/login")
    const response = await post("/api/accounts/acc1/code", { code: "bad" })
    expect(response.status).toBe(400)
    expect(((await response.json()) as any).error).toBe("Login failed: ok")
    // One code per login: a retry must start a new login instead of writing into a FIFO nobody reads.
    expect((await post("/api/accounts/acc1/code", { code: "again" })).status).toBe(409)
  })
})
