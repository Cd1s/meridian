import { afterEach, describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { createAntigravityServer } from "../proxy/backends/antigravity"
import { AntigravityRun, AntigravityRuntime } from "../proxy/backends/antigravityRuntime"
import { parseAgRequest, renderAgPrompt, renderAgPromptWithinLimit } from "../proxy/backends/antigravityProtocol"
import { DEFAULT_PROXY_CONFIG } from "../proxy/types"

const executable = fileURLToPath(new URL("./fixtures/agy-cli.cjs", import.meta.url))
const tools = [{ name: "bash", input_schema: { type: "object", properties: { command: { type: "string" } } } }]
const closing: Array<() => Promise<void>> = []
const tempDirs: string[] = []
const savedEnv = process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES
const savedTrimEnv = process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES
  else process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = savedEnv
  if (savedTrimEnv === undefined) delete process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS
  else process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = savedTrimEnv
  for (const close of closing.splice(0)) await close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manyShortTurns(pairs: number, resultSize = 150, question = "Now summarize.") {
  const messages: unknown[] = [{ role: "user", content: "Original task: inspect every module carefully." }]
  for (let i = 0; i < pairs; i++) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `call_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `call_${i}`, content: `R${i}:` + "x".repeat(resultSize) }] })
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: "Done." }] }, { role: "user", content: question })
  return { model: "fixture-model", max_tokens: 100, messages, tools }
}

function parseRenderedConversation(prompt: string) {
  const marker = "Client conversation:\n"
  const idx = prompt.indexOf(marker)
  if (idx < 0) throw new Error("Missing Client conversation marker")
  const rest = prompt.slice(idx + marker.length)
  const end = rest.lastIndexOf("]")
  const messages = JSON.parse(rest.slice(0, end + 1)) as unknown[]
  return parseAgRequest({ model: "fixture-model", max_tokens: 100, messages, tools })
}

describe.skipIf(process.platform === "win32")("Antigravity prompt history cap", () => {
  it("keeps default 400 behavior when trimOldestTurns is disabled", () => {
    delete process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS
    const req = parseAgRequest(manyShortTurns(70, 140))
    expect(Buffer.byteLength(renderAgPrompt(req, []))).toBeGreaterThan(20_000)
    expect(() => renderAgPromptWithinLimit(req, [], "", 20_000)).toThrow("prompt is too long")
  })

  it("drops oldest whole turns when trimOldestTurns is enabled, preserving tool pairing via parseAgRequest and bounded first-user note", () => {
    const body = manyShortTurns(70, 140)
    ;(body.messages[0] as { content: string }).content = "START:" + "A".repeat(12_000)
    const req = parseAgRequest(body)
    let recordedCut: number | undefined
    const prompt = renderAgPromptWithinLimit(req, [], "", 20_000, {
      trimOldestTurns: true,
      onCut: cut => { recordedCut = cut },
    })
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000)
    expect(recordedCut).toBeGreaterThan(1)
    expect(prompt).toContain("[The earlier part of this conversation")
    expect(prompt).toContain("[... original request truncated ...]")
    expect(prompt).toContain("Now summarize.")
    // Validate full tool_use/tool_result pairing via JSON.parse + parseAgRequest
    const parsedPrompt = parseRenderedConversation(prompt)
    expect(parsedPrompt.messages.length).toBeLessThan(req.messages.length)
    expect(parsedPrompt.messages[0]!.role).toBe("user")
    expect(parsedPrompt.messages[1]!.role).toBe("assistant")
  })

  it("caps cut at latestTypedRequest > 0 and retains newest assistant/result pair during active result-only tool loop", () => {
    const messages: unknown[] = [{ role: "user", content: "Original task: start." }]
    for (let i = 0; i < 30; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `pre_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `pre_${i}`, content: "P:" + "x".repeat(140) }] })
    }
    const typedIdx = messages.length
    messages.push({ role: "user", content: "CRITICAL NEWER TYPED INSTRUCTION" })
    for (let i = 0; i < 25; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `post_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `post_${i}`, content: "Q:" + "y".repeat(140) }] })
    }
    const req = parseAgRequest({ model: "fixture-model", max_tokens: 100, messages, tools })
    let recordedCut: number | undefined
    const prompt = renderAgPromptWithinLimit(req, [], "", 20_000, {
      trimOldestTurns: true,
      onCut: cut => { recordedCut = cut },
    })
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000)
    expect(recordedCut).toBeLessThanOrEqual(typedIdx)
    expect(prompt).toContain("CRITICAL NEWER TYPED INSTRUCTION")
    expect(prompt).toContain("post_24")
    parseRenderedConversation(prompt)
  })

  it("uses actual first user message for synthetic note even when messages[0] is assistant, and omits AG_OMIT_NOTE when no middle omission occurred", () => {
    const messages: unknown[] = [
      { role: "assistant", content: "Greeting from assistant." },
      { role: "user", content: "REAL_FIRST_USER_TASK" },
    ]
    for (let i = 0; i < 70; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c_${i}`, content: "R:" + "x".repeat(140) }] })
    }
    const req = parseAgRequest({ model: "fixture-model", max_tokens: 100, messages, tools })
    let cut1: number | undefined
    const prompt1 = renderAgPromptWithinLimit(req, [], "", 20_000, {
      trimOldestTurns: true,
      onCut: cut => { cut1 = cut },
    })
    expect(cut1).toBeGreaterThan(1)
    expect(prompt1).toContain("REAL_FIRST_USER_TASK")
    expect(prompt1).not.toContain("content omitted")

    // Re-applying previousCut without middle omission must also not inject AG_OMIT_NOTE
    const prompt2 = renderAgPromptWithinLimit(req, [], "", 20_000, {
      trimOldestTurns: true,
      previousCut: () => cut1,
    })
    expect(prompt2).toContain("REAL_FIRST_USER_TASK")
    expect(prompt2).not.toContain("content omitted")
  })

  it("stabilizes the cut across subsequent requests and advances only when needed", () => {
    const body1 = manyShortTurns(70, 140)
    const req1 = parseAgRequest(body1)
    let cut1: number | undefined
    const prompt1 = renderAgPromptWithinLimit(req1, [], "", 20_000, {
      trimOldestTurns: true,
      onCut: cut => { cut1 = cut },
    })
    expect(cut1).toBeGreaterThan(1)

    // Append a small turn that still fits under the same cut1: previousCut should be reused without shifting
    const body2 = manyShortTurns(70, 140)
    body2.messages.push({ role: "assistant", content: "ok" }, { role: "user", content: "next" })
    const req2 = parseAgRequest(body2)
    let cut2: number | undefined
    const prompt2 = renderAgPromptWithinLimit(req2, [], "", 20_000, {
      trimOldestTurns: true,
      previousCut: () => cut1,
      onCut: cut => { cut2 = cut },
    })
    expect(cut2).toBe(cut1)
    expect(Buffer.byteLength(prompt2)).toBeLessThanOrEqual(20_000)
    expect(prompt1.slice(0, 200)).toBe(prompt2.slice(0, 200))

    // Append many more turns so cut1..end no longer fits: cut should advance forward
    const req3 = parseAgRequest(manyShortTurns(140, 140))
    let cut3: number | undefined
    const prompt3 = renderAgPromptWithinLimit(req3, [], "", 20_000, {
      trimOldestTurns: true,
      previousCut: () => cut2,
      onCut: cut => { cut3 = cut },
    })
    expect(cut3).toBeGreaterThan(cut2!)
    expect(Buffer.byteLength(prompt3)).toBeLessThanOrEqual(20_000)
  })

  it("handles HTTP /v1/messages with MERIDIAN_AGY_TRIM_OLDEST_TURNS=1 and isolates promptCut by full prefix hash", async () => {
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "20000"
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = "1"

    const runtime = new AntigravityRuntime({ executable, turnTimeoutMs: 10_000, idleConversationMs: 3000, allowToolBridge: true })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    closing.push(server.closeBackend)
    const reqBody = manyShortTurns(70, 140, "SKIP_TOOLS summarize")
    const res = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(reqBody) }))
    expect(res.status).toBe(200)

    const parsed = parseAgRequest(reqBody)
    const savedCut = runtime.getPromptCut(parsed)
    expect(savedCut).toBeGreaterThan(1)

    // Appending a new turn with the exact same 0..savedCut-1 prefix reuses savedCut
    const extended = parseAgRequest(manyShortTurns(71, 140, "SKIP_TOOLS next"))
    expect(runtime.getPromptCut(extended)).toBe(savedCut)

    // A diverged branch sharing messages[0..1] but editing a message before savedCut MUST NOT inherit savedCut
    const divergedBody = manyShortTurns(70, 140, "SKIP_TOOLS summarize")
    ;(divergedBody.messages[2] as { content: unknown }).content = [{ type: "tool_result", tool_use_id: "call_0", content: "EDITED_BRANCH" }]
    const diverged = parseAgRequest(divergedBody)
    expect(runtime.getPromptCut(diverged)).toBeUndefined()

    // Warm reuse: append actual assistant response + next user turn and assert runtime.reused === 1
    const msg1 = await res.json() as { content: unknown[] }
    const res2 = await server.app.fetch(new Request("http://local/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        ...reqBody,
        messages: [...reqBody.messages, { role: "assistant", content: msg1.content }, { role: "user", content: "SKIP_TOOLS follow-up" }],
      }),
    }))
    expect(res2.status).toBe(200)
    expect(runtime.reused).toBe(1)
  })

  it("does not apply full-history trimming to a restored conversation delta even when the env flag is enabled", async () => {
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "20000"
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = "1"
    const runtime = new AntigravityRuntime({ executable, allowToolBridge: true })
    closing.push(() => runtime.close())
    await runtime.initialize()
    const workspace = await mkdtemp(join(tmpdir(), "meridian-trim-restored-"))
    const request = parseAgRequest(manyShortTurns(70, 140, "SKIP_TOOLS summarize"))
    const run = new AntigravityRun(runtime, request, { conversationId: randomUUID(), workspace, count: 1 })
    runtime.runs.set(run.id, run)
    await expect(run.start()).rejects.toThrow("prompt is too long")
    await run.settled
  })

  it("supports pending tool continuation on large trimmed history without 409", async () => {
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "20000"
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = "1"

    const runtime = new AntigravityRuntime({ executable, turnTimeoutMs: 10_000, idleConversationMs: 3000, allowToolBridge: true })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    closing.push(server.closeBackend)

    const reqBody = manyShortTurns(70, 140, "Run a bash command now.")
    const res1 = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(reqBody) }))
    expect(res1.status).toBe(200)
    const msg1 = await res1.json() as { stop_reason: string; content: Array<{ type: string; id?: string }> }
    expect(msg1.stop_reason).toBe("tool_use")
    const toolUse = msg1.content.find(b => b.type === "tool_use")!
    expect(toolUse?.id).toBeTruthy()

    const res2 = await server.app.fetch(new Request("http://local/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        ...reqBody,
        messages: [
          ...reqBody.messages,
          { role: "assistant", content: msg1.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "tool output ok" }] },
        ],
      }),
    }))
    expect(res2.status).toBe(200)
    const msg2 = await res2.json() as { stop_reason: string }
    expect(msg2.stop_reason).toBe("end_turn")
    expect(runtime.reclaimed).toBe(0)
    expect(runtime.completed).toBe(1)
  })

  it("prefers oldest whole-turn cuts before shrinking the newest tool result, and shrinks newest only if no cut fits", () => {
    // 120 short pairs + typed request + 12,000-char newest tool result, limit 30,000
    const messages: unknown[] = [{ role: "user", content: "Original task." }]
    for (let i = 0; i < 120; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `c_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c_${i}`, content: "R:" + "x".repeat(140) }] })
    }
    messages.push({ role: "user", content: "Inspect the big output." })
    const bigNewest = "NEWEST_START_" + "Z".repeat(12_000) + "_NEWEST_END"
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "big_call", name: "bash", input: { command: "cat big" } }] })
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "big_call", content: bigNewest }] })

    const req = parseAgRequest({ model: "fixture-model", max_tokens: 100, messages, tools })
    const prompt = renderAgPromptWithinLimit(req, [], "", 30_000, { trimOldestTurns: true })
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(30_000)
    expect(prompt).toContain(bigNewest)
    expect(prompt).not.toContain("content omitted")
    parseRenderedConversation(prompt)

    // When newest alone + note cannot fit intact, Phase 3 shrinks newest so the request still succeeds
    const hugeNewest = "HUGE_START_" + "W".repeat(29_000) + "_HUGE_END"
    const messages2 = [...messages.slice(0, -1), { role: "user", content: [{ type: "tool_result", tool_use_id: "big_call", content: hugeNewest }] }]
    const req2 = parseAgRequest({ model: "fixture-model", max_tokens: 100, messages: messages2, tools })
    const prompt2 = renderAgPromptWithinLimit(req2, [], "", 30_000, { trimOldestTurns: true })
    expect(Buffer.byteLength(prompt2)).toBeLessThanOrEqual(30_000)
    expect(prompt2).toContain("content omitted")
    parseRenderedConversation(prompt2)
  })

  it("handles 150-step loop after greeting + newer typed instruction (with image, excluding tool_result) losslessly", () => {
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const messages: unknown[] = [
      { role: "user", content: "Hi!" },
      { role: "assistant", content: [{ type: "tool_use", id: "g_0", name: "bash", input: { command: "pwd" } }] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "g_0", content: "SHOULD_NOT_BE_IN_OPENING_NOTE_RESULT" },
          { type: "text", text: "EXACT_LATEST_TYPED_INSTRUCTION_KEEP_ME" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: tinyPng } },
        ],
      },
    ]
    for (let i = 0; i < 150; i++) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `loop_${i}`, name: "bash", input: { command: `echo ${i}` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `loop_${i}`, content: `L${i}:` + "x".repeat(140) }] })
    }
    const req = parseAgRequest({ model: "fixture-model", max_tokens: 100, messages, tools })
    let cut: number | undefined
    const prompt = renderAgPromptWithinLimit(req, [], "", 20_000, {
      trimOldestTurns: true,
      onCut: c => { cut = c },
    })
    expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(20_000)
    expect(cut).toBeGreaterThan(3)
    expect(prompt).toContain("Hi!")
    expect(prompt).toContain("EXACT_LATEST_TYPED_INSTRUCTION_KEEP_ME")
    expect(prompt).toContain(tinyPng)
    expect(prompt).not.toContain("SHOULD_NOT_BE_IN_OPENING_NOTE_RESULT")
    expect(prompt).toContain("loop_149")
    parseRenderedConversation(prompt)
  })

  it("validates pairing across multiple limits and rejects non-assistant previousCut", () => {
    const req = parseAgRequest(manyShortTurns(70, 140))
    for (const limit of [12_000, 15_000, 20_000, 25_000]) {
      const prompt = renderAgPromptWithinLimit(req, [], "", limit, { trimOldestTurns: true })
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(limit)
      const parsed = parseRenderedConversation(prompt)
      expect(parsed.messages[0]!.role).toBe("user")
      expect(parsed.messages[1]!.role).toBe("assistant")
    }
    // Passing a user-message index as previousCut must be ignored, not slice at a user index
    let chosenCut: number | undefined
    const prompt = renderAgPromptWithinLimit(req, [], "", 20_000, {
      trimOldestTurns: true,
      previousCut: () => 2,
      onCut: c => { chosenCut = c },
    })
    expect(chosenCut).toBeGreaterThan(2)
    expect(req.messages[chosenCut!]!.role).toBe("assistant")
    parseRenderedConversation(prompt)
  })

  it("reuses cached cut across two cold starts through runtime and keys by raw request with early image", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-cold-starts-"))
    tempDirs.push(dir)
    const logFile = join(dir, "prompts.log")
    const wrapper = join(dir, "agy-wrapper.cjs")
    writeFileSync(wrapper, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
if (process.argv.includes("--version") || process.argv.includes("/config")) {
  process.exitCode = 0;
  require(${JSON.stringify(executable)});
} else {
  const child = spawn(process.execPath, [${JSON.stringify(executable)}, ...process.argv.slice(2)], { stdio: ["pipe", "inherit", "inherit"] });
  let buf = "";
  process.stdin.on("data", chunk => {
    child.stdin.write(chunk);
    buf += chunk.toString("utf8");
    for (let i; (i = buf.indexOf("\\n")) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (m.event === "user") fs.appendFileSync(${JSON.stringify(logFile)}, m.message.content + "\\n===END_PROMPT===\\n"); } catch (err) { process.stderr.write("agy-wrapper stdin parse error: " + String(err) + "\\n"); throw err; }
    }
  });
  process.stdin.on("end", () => child.stdin.end());
  child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));
}
`)
    chmodSync(wrapper, 0o755)

    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "20000"
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = "1"
    const runtime = new AntigravityRuntime({ executable: wrapper, turnTimeoutMs: 10_000, idleConversationMs: 1, allowToolBridge: true })
    const server = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: "antigravity" }, runtime)
    closing.push(server.closeBackend)

    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const reqBody = manyShortTurns(70, 140, "SKIP_TOOLS summarize")
    reqBody.messages[0] = {
      role: "user",
      content: [
        { type: "text", text: "Original task with image." },
        { type: "image", source: { type: "base64", media_type: "image/png", data: tinyPng } },
      ],
    }

    const res1 = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(reqBody) }))
    expect(res1.status).toBe(200)
    const msg1 = await res1.json() as { content: unknown[] }

    const parsed1 = parseAgRequest(reqBody)
    const initialCut = runtime.getPromptCut(parsed1)!
    expect(initialCut).toBeGreaterThan(1)

    // Seed an intentionally larger valid assistant cut so ignoring previousCut would pick initialCut instead
    const largerCut = initialCut + 4
    expect(parsed1.messages[largerCut]?.role).toBe("assistant")
    runtime.setPromptCut(parsed1, largerCut)

    // Wait for idleConversationMs: 1 process to exit so the second request is a true cold start
    await new Promise(r => setTimeout(r, 40))

    const reqBody2 = {
      ...reqBody,
      messages: [...reqBody.messages, { role: "assistant", content: msg1.content }, { role: "user", content: "SKIP_TOOLS next" }],
    }
    const res2 = await server.app.fetch(new Request("http://local/v1/messages", { method: "POST", body: JSON.stringify(reqBody2) }))
    expect(res2.status).toBe(200)
    expect(runtime.reused).toBe(0)

    const prompts = readFileSync(logFile, "utf8").split("\n===END_PROMPT===\n").filter(Boolean)
    expect(prompts.length).toBe(2)
    expect(prompts[1]).toContain(`(${largerCut} messages) was omitted`)
  })

  it("bounds promptCuts to 512 LRU entries, expires at 30m TTL, and skips cache access when opt-out or under limit", async () => {
    const runtime = new AntigravityRuntime({ executable, turnTimeoutMs: 10_000, idleConversationMs: 3000, allowToolBridge: true })
    closing.push(() => runtime.close())

    const makeReq = (id: number) => parseAgRequest({
      model: "fixture-model",
      max_tokens: 100,
      messages: [
        { role: "user", content: `task-${id}` },
        { role: "assistant", content: "step1" },
        { role: "user", content: "step2" },
      ],
    })

    // 513-session LRU eviction: access req0 before inserting req512 so req1 is evicted instead of req0
    for (let i = 0; i < 512; i++) runtime.setPromptCut(makeReq(i), 1)
    expect(runtime.getPromptCut(makeReq(0))).toBe(1)
    runtime.setPromptCut(makeReq(512), 1)
    expect(runtime.getPromptCut(makeReq(0))).toBe(1)
    expect(runtime.getPromptCut(makeReq(1))).toBeUndefined()
    expect(runtime.getPromptCut(makeReq(512))).toBe(1)

    // 30-min TTL expiration via synchronous Date.now override
    const realNow = Date.now
    let fakeNow = 1_700_000_000_000
    Date.now = () => fakeNow
    try {
      const ttlReq = makeReq(999)
      runtime.setPromptCut(ttlReq, 1)
      fakeNow += 29 * 60_000
      expect(runtime.getPromptCut(ttlReq)).toBe(1)
      fakeNow += 60_001
      expect(runtime.getPromptCut(ttlReq)).toBeUndefined()
    } finally {
      Date.now = realNow
    }

    // Negative control: no cache access when opt-in disabled OR when prompt is under limit
    let getCalls = 0, setCalls = 0
    const origGet = runtime.getPromptCut.bind(runtime)
    const origSet = runtime.setPromptCut.bind(runtime)
    runtime.getPromptCut = req => { getCalls++; return origGet(req) }
    runtime.setPromptCut = (req, cut) => { setCalls++; return origSet(req, cut) }

    const smallReq = parseAgRequest({ model: "fixture-model", max_tokens: 100, messages: [{ role: "user", content: "hi" }] })
    renderAgPromptWithinLimit(smallReq, [], "", 20_000, {
      trimOldestTurns: true,
      previousCut: () => runtime.getPromptCut(smallReq),
      onCut: c => runtime.setPromptCut(smallReq, c),
    })
    expect(getCalls).toBe(0)
    expect(setCalls).toBe(0)

    const overReq = parseAgRequest(manyShortTurns(70, 140))
    expect(() => renderAgPromptWithinLimit(overReq, [], "", 20_000, {
      trimOldestTurns: false,
      previousCut: () => runtime.getPromptCut(overReq),
      onCut: c => runtime.setPromptCut(overReq, c),
    })).toThrow("prompt is too long")
    expect(getCalls).toBe(0)
    expect(setCalls).toBe(0)
  })

  it("keeps cut changes bounded (<= 12) over a 150-turn growth loop with real runtime cut cache and preserves newest typed/media+tool pairing", () => {
    const runtime = new AntigravityRuntime({ trimOldestTurns: true })
    const limit = 30_000
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    const messages: unknown[] = [
      { role: "user", content: "Original task: inspect every module carefully." },
      { role: "assistant", content: [{ type: "text", text: "Starting inspection." }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Latest typed instruction: check screenshot and run 150 steps." },
          { type: "image", source: { type: "base64", media_type: "image/png", data: tinyPng } },
        ],
      },
    ]

    let lastCut: number | undefined
    let cutChanges = 0

    for (let turn = 1; turn <= 150; turn++) {
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: `call_${turn}`, name: "bash", input: { command: `echo step_${turn}` } }],
      })
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: `call_${turn}`, content: `R${turn}:` + "x".repeat(250) }],
      })

      const req = parseAgRequest({
        model: "fixture-model",
        max_tokens: 100,
        meridian_session_key: "growth-150",
        messages: [...messages],
        tools,
      })

      const prompt = renderAgPromptWithinLimit(req, [], "", limit, {
        trimOldestTurns: true,
        previousCut: () => runtime.getPromptCut(req),
        onCut: cut => runtime.setPromptCut(req, cut),
      })

      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(limit)

      const nextCut = runtime.getPromptCut(req)
      if (nextCut !== undefined && nextCut !== lastCut) {
        if (lastCut !== undefined) expect(nextCut).toBeGreaterThan(lastCut)
        cutChanges++
        lastCut = nextCut
      }

      const parsed = parseRenderedConversation(prompt)
      const tail = parsed.messages.slice(-2)
      expect(tail).toHaveLength(2)
      expect(tail[0]?.role).toBe("assistant")
      expect(tail[1]?.role).toBe("user")
      expect(JSON.stringify(tail[0])).toContain(`call_${turn}`)
      expect(JSON.stringify(tail[1])).toContain(`call_${turn}`)

      if (nextCut !== undefined && nextCut > 2) {
        expect(prompt).toContain("Latest typed instruction: check screenshot and run 150 steps.")
        expect(JSON.stringify(parsed.messages[0])).toContain(tinyPng)
      }
    }

    expect(cutChanges).toBeGreaterThan(0)
    expect(cutChanges).toBeLessThanOrEqual(12)
  })

  it("parses MERIDIAN_AGY_TRIM_OLDEST_TURNS once at config boundary rather than inside renderAgPromptWithinLimit", () => {
    process.env.MERIDIAN_AGY_TRIM_OLDEST_TURNS = "1"
    const req = parseAgRequest(manyShortTurns(70, 140))
    expect(() => renderAgPromptWithinLimit(req, [], "", 20_000)).toThrow("prompt is too long")
  })
})
