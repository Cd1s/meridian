import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { parseAgRequest, renderAgPromptWithinLimit, parseAgRequestWithMeta, resolveAgRequestWithMeta } from "../proxy/backends/antigravityProtocol"
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

describe("combined Antigravity request and history contracts", () => {
  it("elides old tool results independently of their tagged system steering with trimming off", () => {
    const messages: unknown[] = [{ role: "user", content: "ACTUAL_TASK: Inspect Alpha." }]
    for (let i = 0; i < 150; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `steer_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
      messages.push({ role: "system", content: `Reminder ${i}: ` + "steering".repeat(i === 75 ? 400 : 1) })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `steer_${i}`, content: "result".repeat(500) }] })
    }
    const request = parseAgRequest({ model: "fixture-model", messages, tools: [{ name: "bash", input_schema: { type: "object" } }] })
    const prompt = renderAgPromptWithinLimit(request, [], "", 190_000, { trimOldestTurns: false })
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(190_000)
    expect(prompt).toContain("ACTUAL_TASK: Inspect Alpha.")
    expect(prompt).toContain("Reminder 75: " + "steering".repeat(400))
    expect(prompt).toContain("Reminder 149:")
    const conversation = prompt.slice(prompt.indexOf("Client conversation:\n") + "Client conversation:\n".length)
    const rendered = parseAgRequest({ ...request, messages: JSON.parse(conversation.slice(0, conversation.lastIndexOf("]") + 1)) as unknown })
    const firstResult = rendered.messages.flatMap(message => typeof message.content === "string" ? [] : message.content)
      .find(block => block.type === "tool_result" && block.tool_use_id === "steer_0")
    if (firstResult?.type !== "tool_result" || typeof firstResult.content !== "string") throw new Error("Missing first completed result")
    expect(firstResult.content.length).toBeLessThan(3000)
  })


  it("preserves the actual user task and subsequent tagged system steering across whole-turn cuts", () => {
    for (const limit of [15_000, 20_000, 25_000]) {
      const messages: unknown[] = [
        { role: "user", content: "Hello" }, { role: "assistant", content: "Hello." },
        { role: "user", content: "ACTUAL_TASK: Keep every change confined to module Alpha." },
      ]
      for (let i = 0; i < 150; i++) {
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: `cut_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
        if (i === 75 || i === 100) messages.push({ role: "system", content: `Reminder ${i}: continue carefully.` })
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `cut_${i}`, content: "x".repeat(180) }] })
      }
      const tools = [{ name: "bash", input_schema: { type: "object" } }]
      const request = parseAgRequest({ model: "fixture-model", messages, tools })
      let previousCut: number | undefined
      for (let replay = 0; replay < 2; replay++) {
        const prompt = renderAgPromptWithinLimit(request, [], "", limit, {
          trimOldestTurns: true, previousCut: () => previousCut, onCut: cut => { previousCut = cut },
        })
        expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(limit)
        expect(previousCut).toBeGreaterThan(203)
        expect(prompt).toContain("ACTUAL_TASK: Keep every change confined to module Alpha.")
        expect(prompt).toContain("Reminder 75: continue carefully.")
        expect(prompt).toContain("Reminder 100: continue carefully.")
        expect(prompt.indexOf("ACTUAL_TASK")).toBeLessThan(prompt.indexOf("Reminder 75"))
        expect(prompt.indexOf("Reminder 75")).toBeLessThan(prompt.indexOf("Reminder 100"))
        const conversation = prompt.slice(prompt.indexOf("Client conversation:\n") + "Client conversation:\n".length)
        const tail = JSON.parse(conversation.slice(0, conversation.lastIndexOf("]") + 1)) as unknown
        expect(() => parseAgRequest({ model: "fixture-model", messages: tail, tools })).not.toThrow()
      }
    }
  })


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
