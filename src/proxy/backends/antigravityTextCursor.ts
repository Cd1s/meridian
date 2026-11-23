export interface AgTextScope {
  textAllowed: boolean
  stale: boolean
  stepIndex?: number
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** Fences stale indexed frames while allowing legacy unindexed text after the current input marker. */
export class AgTextCursor {
  after = -1
  private observedThrough = -1
  private requireIndex = false
  private awaitingInput = false

  begin(requireIndex = false): void {
    this.observedThrough = this.after
    this.requireIndex ||= requireIndex
    this.awaitingInput = this.requireIndex
  }

  nextPhase(): void {
    this.after = Math.max(this.after, this.observedThrough)
    this.observedThrough = this.after
    this.awaitingInput = this.requireIndex
  }

  commit(): void {
    this.after = Math.max(this.after, this.observedThrough)
    this.observedThrough = this.after
  }

  observe(value: unknown): AgTextScope {
    const event = record(value) ?? {}
    const update = record(event.step_update)
    const index = update?.step_index
    if (index !== undefined) {
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) return { textAllowed: false, stale: true }
      if (index <= this.after) {
        if (update?.step_type === "agent_response" && !this.awaitingInput) return { textAllowed: true, stale: false, stepIndex: index }
        return { textAllowed: false, stale: true, stepIndex: index }
      }
      this.requireIndex = true
      if (update?.step_type === "user_input") {
        this.after = index
        this.observedThrough = Math.max(this.observedThrough, index)
        this.awaitingInput = false
        return { textAllowed: false, stale: false, stepIndex: index }
      }
      if (this.awaitingInput) return { textAllowed: false, stale: true, stepIndex: index }
      this.observedThrough = Math.max(this.observedThrough, index)
      return { textAllowed: true, stale: false, stepIndex: index }
    }
    return { textAllowed: !this.awaitingInput, stale: false }
  }
}

export function agTextEventShape(value: unknown): Record<string, unknown> {
  const event = record(value) ?? {}
  const update = record(event.step_update) ?? {}
  const result = record(event.result) ?? {}
  const textBytes = typeof update.text_delta === "string" ? Buffer.byteLength(update.text_delta) : 0
  const responseBytes = typeof result.response === "string" ? Buffer.byteLength(result.response) : 0
  return {
    event: typeof event.event === "string" ? event.event : undefined,
    type: typeof update.step_type === "string" ? update.step_type : undefined,
    state: typeof update.state === "string" ? update.state : undefined,
    stepIndex: typeof update.step_index === "number" ? update.step_index : undefined,
    textBytes,
    responseBytes,
    eventKeys: Object.keys(event).slice(0, 20),
    updateKeys: Object.keys(update).slice(0, 20),
    resultKeys: Object.keys(result).slice(0, 20),
  }
}
