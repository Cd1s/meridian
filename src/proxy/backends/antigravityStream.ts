import { setImmediate as yieldIO } from 'node:timers/promises'
import type { Writable } from 'node:stream'

/** The stdout callback only enqueues; parsing and input advancement run in this loop. */
export class AgCliDrain {
  private readonly lines: Array<{ text: string; bytes: number }> = []
  private bytes = 0
  private active = false
  private inFlight = false
  private ended = false
  private stopped = false
  private error?: Error
  private settled = false
  private readonly flushes: Array<{ target: number; resolve: () => void; reject: (error: Error) => void }> = []
  private resolve!: () => void
  private reject!: (error: Error) => void
  readonly done = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject })
  readonly stats = { received: 0, frames: 0, peakBytes: 0, peakLines: 0, maxProcessingWallMs: 0 }
  constructor(
    private readonly process: (line: string) => Promise<void>,
    private readonly failed: (error: Error) => void,
    private readonly maxBytes = 16 * 1024 * 1024,
    private readonly maxLines = 8192,
  ) { void this.done.catch(() => undefined) }
  push(text: string): void {
    if (this.stopped || this.ended) return
    const bytes = Buffer.byteLength(text)
    if (bytes + this.bytes > this.maxBytes || this.lines.length + Number(this.inFlight) >= this.maxLines) {
      this.fail(new Error('Antigravity CLI update buffer exceeded'))
      return
    }
    this.lines.push({ text, bytes }); this.bytes += bytes
    this.stats.received++
    this.stats.peakBytes = Math.max(this.stats.peakBytes, this.bytes)
    this.stats.peakLines = Math.max(this.stats.peakLines, this.lines.length + Number(this.inFlight))
    this.schedule()
  }
  flush(): Promise<void> {
    if (this.stopped) return this.done
    const target = this.stats.received
    if (this.stats.frames >= target) return Promise.resolve()
    return new Promise((resolve, reject) => { this.flushes.push({ target, resolve, reject }) })
  }
  finish(): Promise<void> { this.ended = true; this.schedule(); return this.done }
  cancel(): void {
    this.stopped = true
    this.bytes -= this.lines.reduce((sum, line) => sum + line.bytes, 0)
    this.lines.length = 0
    this.settle()
  }
  private fail(error: Error): void {
    if (this.error) return
    this.error = error
    this.cancel()
    this.failed(error)
  }
  private settle(): void {
    if (this.settled || this.active || (!this.stopped && (!this.ended || this.lines.length))) return
    this.settled = true
    for (const waiter of this.flushes.splice(0)) { if (this.error) waiter.reject(this.error); else waiter.resolve() }
    if (this.error) this.reject(this.error)
    else this.resolve()
  }
  private schedule(): void {
    if (this.active) return
    if (this.stopped || !this.lines.length) { this.settle(); return }
    this.active = true
    void this.drain()
  }
  private async drain(): Promise<void> {
    try {
      await yieldIO()
      let batch = 0
      while (!this.stopped && this.lines.length) {
        const line = this.lines.shift()!, started = performance.now()
        this.inFlight = true
        try { await this.process(line.text) }
        finally {
          this.inFlight = false
          this.bytes -= line.bytes
          this.stats.frames++
          for (let at = this.flushes.length - 1; at >= 0; at--) if (this.flushes[at]!.target <= this.stats.frames) this.flushes.splice(at, 1)[0]!.resolve()
          this.stats.maxProcessingWallMs = Math.max(this.stats.maxProcessingWallMs, performance.now() - started)
        }
        if (++batch === 32) { batch = 0; await yieldIO() }
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Antigravity CLI processing failed')) }
    finally { this.active = false; this.settle(); if (!this.stopped && this.lines.length) this.schedule() }
  }
}

/** Await the write callback, keeping at most one complete input frame buffered. */
export function writeAgFrame(stream: Writable, frame: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error | null) => {
      signal.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve()
    }
    const cancel = () => finish(new Error('Antigravity input write cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { cancel(); return }
    try { stream.write(frame, finish) }
    catch (error) { finish(error instanceof Error ? error : new Error('Antigravity input write failed')) }
  })
}

export function agSubscriberFailure(message: string): boolean {
  return /^(?:the connection to the agent was interrupted before the response finished: )?subscriber fell behind updates, stalled for \d+(?:\.\d+)?s$/i.test(message.trim())
}
