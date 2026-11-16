import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { parseAgRequestWithMeta, resolveAgRequestWithMeta } from "../proxy/backends/antigravityProtocol"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const hosted = { type: "web_search_20250305", name: "web_search" }
const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0)) await close() })
const payload = () => ({
  model: "gemini-fixture", system: "Original system", temperature: 0.5,
  thinking: { type: "enabled", budget_tokens: 4096 }, tools: [hosted],
  messages: [
    { role: "user", content: "SKIP_TOOLS initial" },
    { role: "assistant", content: [{ type: "thinking", thinking: "old" }, { type: "text", text: "Prior answer" }] },
    { role: "system", content: "Late steering" },
    { role: "user", content: "SKIP_TOOLS next" },
  ],
})

describe("combined Antigravity normalization and effort contracts", () => {
  it("keeps dropped-tool metadata through discovery while normalizing late systems and sampling", async () => {
    const body = { ...payload(), model: "gemini-partial-low" }
    const parsed = await resolveAgRequestWithMeta(body, true, async () => ["gemini-partial-low", "gemini-partial-high"])
    expect(parsed.request.model).toBe("gemini-partial-high")
    expect(parsed.request.system).toBe("Original system")
    expect(JSON.stringify(parsed.request.messages)).toContain("[system]\\nLate steering")
    expect(parsed.request.temperature).toBeUndefined()
    expect(parsed.request.tools).toEqual([])
    expect(parsed.droppedTools).toEqual(["web_search"])
    expect(JSON.stringify(parsed.request)).not.toContain('"droppedTools"')
    expect(parseAgRequestWithMeta(body, true, ["gemini-partial-low", "gemini-partial-high"]).request.model).toBe("gemini-partial-high")
    await expect(resolveAgRequestWithMeta({ ...body, betas: ["unsupported"] }, true, async () => [])).rejects.toThrow("betas")
  })

  it.skipIf(process.platform === "win32")("emits both header families once for a combined HTTP request and retains budget opt-in", async () => {
    const runtime = new AntigravityRuntime({ executable, adaptThinkingBudgets: true })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    closing.push(server.closeBackend)
    const warnings: string[] = []
    const warn = spyOn(console, "warn").mockImplementation((...args) => { warnings.push(args.map(String).join(" ")) })
    try {
      const response = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(payload()) }))
      expect(response.status).toBe(200)
      expect(response.headers.get("x-meridian-dropped-tools")).toBe("web_search")
      expect(response.headers.get("x-meridian-thinking-budgets")).toBe("approximate-effort")
      expect(response.headers.get("x-meridian-effective-model")).toBe("gemini-fixture-medium")
      expect(warnings.filter(line => line.includes("Dropped unsupported hosted tools"))).toHaveLength(1)
      const answer = await response.json() as { model: string }
      expect(answer.model).toBe("gemini-fixture-medium")
      expect([...runtime.runs.values()][0]?.request.system).toBe("Original system")
    } finally { warn.mockRestore() }
    const strict = new AntigravityRuntime({ executable })
    const strictServer = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, strict)
    closing.push(strictServer.closeBackend)
    const refused = await strictServer.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(payload()) }))
    expect(refused.status).toBe(400)
    expect(await refused.text()).toContain("ADAPT_THINKING_BUDGETS=1")
    expect(strict.runs.size).toBe(0)
  })
})
