import { afterEach, describe, expect, it } from "bun:test"
import { AntigravityError, assertAgPromptFits, parseAgRequest, renderAgPrompt } from "../proxy/backends/antigravityProtocol"

// agy 1.3.5 silently drops everything past ~192,000 bytes of one user message (measured on prod: the tail of the history,
// i.e. the newest content, is cut and the model never learns about it). A clear 400 lets clients compact instead.
const request = (bytes: number) => parseAgRequest({ model: "fixture-model", messages: [{ role: "user", content: "x".repeat(bytes) }] })
const saved = process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES
afterEach(() => { if (saved === undefined) delete process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES; else process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = saved })

describe("Antigravity prompt size limit", () => {
  it("accepts a prompt under the agy input cap", () => {
    expect(() => assertAgPromptFits(renderAgPrompt(request(100_000)))).not.toThrow()
  })

  it("rejects a prompt agy would silently truncate with a 400 prompt-too-long error", () => {
    const error = (() => { try { assertAgPromptFits(renderAgPrompt(request(250_000))) } catch (e) { return e } })()
    expect(error).toBeInstanceOf(AntigravityError)
    expect(error).toMatchObject({ status: 400, type: "invalid_request_error" })
    expect((error as Error).message).toMatch(/prompt is too long: \d+ bytes > 190000/)
  })

  it("counts UTF-8 bytes, not characters", () => {
    expect(() => assertAgPromptFits("é".repeat(100_000))).toThrow(/prompt is too long/)
  })

  it("lets the operator raise or disable the cap", () => {
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "400000"
    expect(() => assertAgPromptFits(renderAgPrompt(request(250_000)))).not.toThrow()
    process.env.MERIDIAN_AGY_MAX_PROMPT_BYTES = "0"
    expect(() => assertAgPromptFits("x".repeat(900_000))).not.toThrow()
  })
})
