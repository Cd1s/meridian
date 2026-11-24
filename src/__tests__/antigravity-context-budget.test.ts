import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { blocks, parseAgRequest, renderAgPrompt, type AgMessage } from "../proxy/backends/antigravityProtocol"
import { estimateAgTextTokens } from "../proxy/backends/antigravityTokens"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const cleanup: (() => Promise<void>)[] = []
const saved = { ...process.env }
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop()
  for (const key of Object.keys(process.env)) if (key.startsWith("MERIDIAN_AGY_")) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
const tools = [{ name: "lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } }]
const text = (content: string): AgMessage => ({ role: "user", content })
const assistant = (content: string): AgMessage => ({ role: "assistant", content })
const historicalPairs = (count: number, payload: string): AgMessage[] =>
  Array.from({ length: count }, (_, i): AgMessage[] => [
    { role: "assistant", content: [{ type: "tool_use", id: `tool_${i}`, name: "lookup", input: { key: String(i) } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: `tool_${i}`, content: payload }] },
  ]).flat()
const unpack = (prompt: string): AgMessage[] => JSON.parse(prompt.split("Client conversation:\n").at(-1)!)
function expectPairs(messages: AgMessage[]) {
  const pending = new Set<string>()
  for (const message of messages) for (const block of blocks(message)) {
    if (block.type === "tool_use") pending.add(block.id)
    if (block.type === "tool_result") expect(pending.delete(block.tool_use_id)).toBe(true)
  }
  expect(pending.size).toBe(0)
}

async function fixture(priming?: string, persist = false) {
  const directory = await mkdtemp(join(tmpdir(), "agy-context-budget-"))
  const path = join(directory, "steps.jsonl")
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 5000, statePath: persist ? join(directory, "state.sqlite") : undefined })
  runtime.childEnv.AGY_FIXTURE_CONTEXT_LOG = path
  if (priming) runtime.childEnv.AGY_FIXTURE_CONTEXT_PRIMING = priming
  const backend = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
  cleanup.push(backend.closeBackend, () => rm(directory, { recursive: true, force: true }))
  const send = (messages: AgMessage[], overrides: Record<string, unknown> = {}) => backend.app.fetch(new Request("http://local/v1/messages", {
    method: "POST", body: JSON.stringify({ model: "fixture-model", tools, max_tokens: 128, messages, ...overrides }),
  }))
  const steps = async (): Promise<{ pid: number; prompt: string }[]> => {
    try {
      const text = (await readFile(path, "utf8")).trim()
      return text ? text.split("\n").map(line => JSON.parse(line)) : []
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
      throw error
    }
  }
  return { send, steps, runtime }
}

describe("Antigravity context budgeting", () => {
  it("defaults to one bounded cold input with the newest request and intact tool pairs", async () => {
    const { send, steps } = await fixture()
    const result = await send([text("EARLIEST"), ...historicalPairs(48, "\u6f22".repeat(1700)), assistant("Done"), text("SKIP_TOOLS CURRENT_TAIL")])
    expect(result.status).toBe(200)
    const prompts = await steps()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]!.prompt).toContain("CURRENT_TAIL")
    expect(prompts[0]!.prompt).toContain("omitted")
    expect(Buffer.byteLength(prompts[0]!.prompt)).toBeLessThanOrEqual(190000)
    expect(estimateAgTextTokens(prompts[0]!.prompt)).toBeLessThanOrEqual(52000)
    expectPairs(unpack(prompts[0]!.prompt))
  })

  it("keeps the user's goal when a long run of short tool pairs has no newer typed request", async () => {
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "5000"
    const { send, steps } = await fixture()
    const result = await send([text("ORIGINAL_GOAL"), ...historicalPairs(64, "short result")])
    expect(result.status).toBe(200)
    const frames = await steps()
    const messages = unpack(frames[0]!.prompt)
    expect(frames).toHaveLength(1)
    expect(Buffer.byteLength(frames[0]!.prompt)).toBeLessThanOrEqual(5000)
    expect(frames[0]!.prompt).toContain("ORIGINAL_GOAL")
    expect(frames[0]!.prompt).toContain("tool_63")
    expect(frames[0]!.prompt).not.toContain("tool_0")
    expectPairs(messages)
  })

  it("restarts at the estimated warm context cap, then resumes with only new input", async () => {
    process.env.MERIDIAN_AGY_MAX_CONTEXT_TOKENS = "16000"
    const { send, steps } = await fixture()
    const messages: AgMessage[] = []
    for (let i = 0; i < 7; i++) {
      messages.push(text(i === 6 ? "SKIP_TOOLS tiny continuation" : `SKIP_TOOLS turn-${i} ` + "a".repeat(10000)))
      const response = await send(messages)
      expect(response.status).toBe(200)
      const answer = await response.json() as { content: { text: string }[] }
      messages.push(assistant(answer.content[0]!.text))
    }
    const frames = await steps()
    expect(frames).toHaveLength(7)
    expect(frames[0]!.pid).toBe(frames[1]!.pid)
    expect(unpack(frames[1]!.prompt)).toHaveLength(1)
    expect(frames[5]!.pid).not.toBe(frames[0]!.pid)
    expect(frames[6]!.pid).toBe(frames[5]!.pid)
    expect(unpack(frames[6]!.prompt)).toEqual([{ role: "user", content: [{ type: "text", text: "SKIP_TOOLS tiny continuation" }] }])
  })

  it("only loads cold history in multiple steps when explicitly enabled", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
    const { send, steps, runtime } = await fixture()
    const result = await send([text("EARLIEST"), ...historicalPairs(12, "x".repeat(24000)), assistant("Done"), text("SKIP_TOOLS CURRENT_TAIL")])
    expect(result.status).toBe(200)
    const reply = await result.json() as { content: { type: string; text: string }[]; usage: { input_tokens: number } }
    expect(reply.content).toEqual([{ type: "text", text: "READY" }])
    expect(reply.usage.input_tokens).toBe(120)
    const frames = await steps()
    expect(frames.length).toBeGreaterThan(1)
    expect(new Set(frames.map(frame => frame.pid)).size).toBe(1)
    for (const frame of frames.slice(0, -1)) {
      expect(frame.prompt).toStartWith("History loading step.")
      expect(Buffer.byteLength(frame.prompt)).toBeLessThanOrEqual(180000)
      expectPairs(unpack(frame.prompt))
    }
    expect(frames.at(-1)!.prompt).toContain("CURRENT_TAIL")
    expect(runtime.requests[0]!.inputTokens).toBe(120 + 100 * (frames.length - 1))
  })

  it("carries the current goal and the latest tool batch into the final input", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
    const { send, steps } = await fixture("silent")
    const result = await send([text("CURRENT_GOAL"), ...historicalPairs(12, "x".repeat(24000))])
    expect(result.status).toBe(200)
    const frames = await steps()
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.slice(0, -1).every(frame => !frame.prompt.includes("CURRENT_GOAL"))).toBe(true)
    const final = unpack(frames.at(-1)!.prompt)
    expect(final[0]).toEqual({ role: "user", content: [{ type: "text", text: "CURRENT_GOAL" }] })
    expect(frames.at(-1)!.prompt).toContain("tool_11")
    expectPairs(final)
  })

  for (const mode of ["rpc", "tool-frame", "no-marker"] as const) {
    it(`enforces the priming boundary for ${mode}`, async () => {
      process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "1"
      const { send, steps } = await fixture(mode)
      const result = await send([text("EARLIEST"), ...historicalPairs(12, "x".repeat(24000)), text("SKIP_TOOLS CURRENT_TAIL")])
      if (mode === "rpc") {
        expect(result.status).toBe(200)
        const reply = await result.json() as { content: { type: string; text: string }[] }
        expect(reply.content).toEqual([{ type: "text", text: "READY" }])
      } else {
        expect(result.status).toBe(502)
        expect(await steps()).toHaveLength(1)
      }
    })
  }

  it("rejects a dense warm input that fits the byte guard but exceeds the step estimate", async () => {
    const { send, steps } = await fixture()
    expect((await send([text("SKIP_TOOLS first")])).status).toBe(200)
    const result = await send([text("SKIP_TOOLS first"), assistant("READY"), text("\u6f22".repeat(20000))])
    expect(result.status).toBe(400)
    expect(await steps()).toHaveLength(1)
  })

  it("rejects an oversized client tool result before the CLI can receive it", async () => {
    const { send } = await fixture()
    const messages = [text("Run lookup")]
    const first = await send(messages)
    expect(first.status).toBe(200)
    const reply = await first.json() as { content: { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }[] }
    const call = reply.content.find(block => block.type === "tool_use")!
    const result = await send([...messages, { role: "assistant", content: reply.content }, {
      role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: "\u6f22".repeat(20000) }],
    }])
    expect(result.status).toBe(400)
    expect(await result.text()).toContain("estimated")
  })

  it("splits an oversized restored latest request before starting the CLI process", async () => {
    const { send, steps, runtime } = await fixture(undefined, true)
    const history = [text("SKIP_TOOLS completed"), assistant("READY")]
    const native = runtime.nativeSessions!
    const workspace = await mkdtemp(join(native.directory, "conversation-"))
    native.save(parseAgRequest({ model: "fixture-model", tools, max_tokens: 128, messages: [...history, text("Next")] }), history, {
      conversationId: "11111111-1111-4111-8111-111111111111", workspace, count: history.length,
    })
    const response = await send([...history, text("\u6f22".repeat(20000))])
    expect(response.status).toBe(200)
    expect(runtime.restored).toBe(1)
    expect((await response.json() as { content: unknown[] }).content).toHaveLength(1)
    expect((await steps()).length).toBeGreaterThan(1)
  })

  it("loads bounded cold history before splitting an oversized latest request", async () => {
    const { send, steps } = await fixture()
    const history = [text("ORIGINAL_TASK")]
    history.push(...historicalPairs(10, "r".repeat(20000)))
    const response = await send([...history, text("z".repeat(300000))])
    expect(response.status).toBe(200)
    expect((await steps()).length).toBeGreaterThan(2)
  })

  it("preserves the production 150620-byte shape by splitting the latest tool result", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "0"
    process.env.MERIDIAN_AGY_HISTORY_STEP_BYTES = "180000"
    process.env.MERIDIAN_AGY_HISTORY_MAX_STEPS = "20"
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "150620"
    const largeTool = { name: "read_report", description: "T".repeat(40000), input_schema: { type: "object", properties: { path: { type: "string" } } } }
    const baseMessages: AgMessage[] = [
      text("U".repeat(30000)),
      { role: "assistant", content: [{ type: "tool_use", id: "old", name: "read_report", input: { path: "/old" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "old", content: "O".repeat(10000) }] },
      { role: "assistant", content: [{ type: "tool_use", id: "latest", name: "read_report", input: { path: "/latest" } }] },
    ]
    for (const size of [60000, 250000]) {
      const { send, steps } = await fixture()
      const latest = { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "latest", content: "N".repeat(size) }] }
      const request = { model: "fixture-model", system: "S".repeat(30000), tools: [largeTool], messages: [...baseMessages, latest], stream: false }
      expect(Buffer.byteLength(renderAgPrompt(request)) > 150620).toBe(true)
      const before = (await steps()).length
      const response = await send(request.messages, { system: request.system, tools: request.tools, stream: false })
      expect(response.status).toBe(200)
      const frames = (await steps()).slice(before)
      expect(frames.length).toBeGreaterThan(1)
      expect(frames.every(frame => Buffer.byteLength(frame.prompt) <= 180000)).toBe(true)
      const joined = frames.map(frame => frame.prompt).join("\n")
      expect(joined).toContain("U".repeat(30000))
      expect((joined.match(/N/g) ?? []).length).toBeGreaterThan(size - 1000)
      expect(joined).not.toContain("omitted by Meridian")
    }
  })

  it("uses the agy 1.5.13 step limit when the configured limit is still 190000", async () => {
    process.env.MERIDIAN_AGY_CHUNKED_HISTORY = "0"
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "190000"
    const { send, steps, runtime } = await fixture()
    runtime.childEnv.AGY_FIXTURE_MAX_PROMPT_BYTES = "150620"
    const request = {
      model: "fixture-model",
      system: "S".repeat(100000),
      messages: [text("U".repeat(60000))],
      tools: [],
      stream: false,
    }
    expect(Buffer.byteLength(renderAgPrompt(request))).toBeGreaterThan(150620)
    const response = await send(request.messages, { system: request.system, tools: request.tools, stream: false })
    expect(response.status).toBe(200)
    expect((await steps()).length).toBeGreaterThan(1)
    expect((await steps()).every(frame => Buffer.byteLength(frame.prompt) <= 150620)).toBe(true)
  })
})
