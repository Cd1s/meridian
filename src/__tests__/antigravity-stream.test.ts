import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { getEventListeners } from 'node:events'
import { setImmediate as tick } from 'node:timers/promises'
import { AgCliDrain, writeAgFrame } from '../proxy/backends/antigravityStream'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { planAgHistory } from '../proxy/backends/antigravityHistory'
import { blocks, parseAgRequest, AntigravityError, type AgMessage } from '../proxy/backends/antigravityProtocol'
import { AgNativeRecords } from '../proxy/backends/antigravityNativeRecord'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
const cleanup: Array<() => Promise<void>> = []
const env = { ...process.env }
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
  for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_AGY_') || key.startsWith('AGY_FIXTURE_')) {
    if (env[key] === undefined) delete process.env[key]
    else process.env[key] = env[key]
  }
})

describe('Antigravity asynchronous CLI drain', () => {
  it('keeps accepting a burst while processing is suspended, then drains in order before EOF', async () => {
    const entered = deferred(), release = deferred(), seen: string[] = []
    const queue = new AgCliDrain(async line => { if (!seen.length) { entered.resolve(); await release.promise }; seen.push(line) }, error => { throw error })
    queue.push('0'); await entered.promise
    for (let at = 1; at < 200; at++) queue.push(String(at))
    let finished = false
    const done = queue.finish().then(() => { finished = true })
    await tick(); expect(finished).toBe(false); expect(queue.stats.peakLines).toBe(200)
    release.resolve(); await done
    expect(seen).toEqual(Array.from({ length: 200 }, (_, at) => String(at)))
  })
  it('bounds bytes and lines even while a callback is awaiting, and reports one failure', async () => {
    for (const limits of [[5, 100], [100, 2]]) {
      const entered = deferred(), release = deferred(), errors: Error[] = []
      const queue = new AgCliDrain(async () => { entered.resolve(); await release.promise }, error => errors.push(error), ...limits as [number, number])
      queue.push('abc'); await entered.promise
      queue.push('def'); queue.push('ghi'); queue.push('jkl')
      expect(errors).toHaveLength(1)
      release.resolve()
      await expect(queue.finish()).rejects.toThrow('buffer exceeded')
      expect(queue.stats.peakBytes).toBeLessThanOrEqual(limits[0]!)
    }
  })
  it('joins the in-flight callback on cancel while discarding queued work', async () => {
    const entered = deferred(), release = deferred(), seen: string[] = []
    const queue = new AgCliDrain(async line => { entered.resolve(); await release.promise; seen.push(line) }, error => { throw error })
    queue.push('one'); await entered.promise; queue.push('two'); queue.cancel()
    let done = false; const closing = queue.finish().then(() => { done = true })
    await tick(); expect(done).toBe(false); release.resolve(); await closing
    expect(seen).toEqual(['one'])
  })
  it('waits for an input frame to flush and releases its cancellation listener', async () => {
    const release = deferred(), received: string[] = [], controller = new AbortController()
    const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { received.push(chunk.toString()); void release.promise.then(() => callback()) } })
    let done = false
    const writing = writeAgFrame(output, 'input frame', controller.signal).then(() => { done = true })
    await tick(); expect(done).toBe(false)
    release.resolve(); await writing; output.end()
    expect(received).toEqual(['input frame'])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
  it('cancels a backpressured input write without leaving an abort listener', async () => {
    const release = deferred(), controller = new AbortController()
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { void release.promise.then(() => callback()) } })
    const writing = writeAgFrame(output, 'input frame', controller.signal)
    controller.abort()
    await expect(writing).rejects.toThrow('cancelled')
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    release.resolve(); await tick(); output.end()
  })
  it('yields to I/O during a burst of immediately completed handlers', async () => {
    let ioRanAt = -1
    const queue = new AgCliDrain(async () => {}, error => { throw error })
    for (let at = 0; at < 200; at++) queue.push('line')
    setImmediate(() => { ioRanAt = queue.stats.frames })
    await queue.finish()
    expect(ioRanAt).toBeLessThan(200)
    expect(queue.stats.frames).toBe(200)
  })
})

const tool = { name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } } } }
function denseHistory(): AgMessage[] {
  const messages: AgMessage[] = [{ role: 'user', content: 'NEEDLE_HEAD_742' }]
  for (let at = 0; at < 16; at++) messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `old_${at}`, name: 'lookup', input: { key: String(at) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `old_${at}`, content: '漢'.repeat(8000) }] },
  )
  messages.push({ role: 'assistant', content: 'done' }, { role: 'user', content: 'SKIP_TOOLS LONGCTX_NEEDLES NEEDLE_TAIL_963' })
  return messages
}
async function fixture(maxSteps = 20, options: { reuseConversations?: boolean; persist?: boolean; maxConcurrent?: number } = {}) {
  process.env.MERIDIAN_AGY_HISTORY_MAX_STEPS = String(maxSteps)
  const directory = await mkdtemp(join(tmpdir(), 'agy-subscriber-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const log = join(directory, 'processes.jsonl')
  const runtime = new AntigravityRuntime({ executable: fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url)), allowToolBridge: true, turnTimeoutMs: 10000, reuseConversations: options.reuseConversations, maxConcurrent: options.maxConcurrent, ...(options.persist ? { statePath: join(directory, 'state.sqlite') } : {}) })
  runtime.childEnv.HOME = directory
  runtime.childEnv.AGY_FIXTURE_NATIVE_RECORDS = '1'
  runtime.childEnv.AGY_FIXTURE_PROCESS_LOG = log
  const app = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
  cleanup.unshift(app.closeBackend)
  const body = parseAgRequest({ model: 'fixture-model', max_tokens: 128, messages: denseHistory(), tools: [tool] })
  const send = (extra = {}, signal?: AbortSignal) => app.app.fetch(new Request('http://local/v1/messages', { method: 'POST', signal, body: JSON.stringify({ ...body, ...extra }) }))
  const processes = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { pid: number; cid: string; index: number; hash: string; history: boolean; workspace: string })
  return { runtime, app, directory, body, send, processes }
}

describe.skipIf(process.platform === 'win32')('Antigravity cold subscriber recovery', () => {
  it('drains burst ACK updates with slow stdin, preserves dense history and final-only process exit', async () => {
    const { runtime, send, processes } = await fixture(20, { reuseConversations: false })
    runtime.childEnv.AGY_FIXTURE_HISTORY_BURST = '1'; runtime.childEnv.AGY_FIXTURE_SLOW_STDIN = '1'
    const response = await send()
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'NEEDLE_HEAD_742 NEEDLE_TAIL_963' }])
    expect(new Set((await processes()).map(row => row.cid)).size).toBe(1)
    expect(runtime.completed).toBe(1)
    expect(runtime.runs.size).toBe(0)
  }, 30000)
  it('flushes already queued post-terminal snapshots before committing a partial streamed answer', async () => {
    const { runtime, send } = await fixture()
    delete runtime.childEnv.AGY_FIXTURE_NATIVE_RECORDS
    const response = await send({ messages: [{ role: 'user', content: 'SKIP_TOOLS FINAL_BUFFERED_TAIL' }], tools: [] })
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'READY' }])
  })
  for (const stream of [false, true]) {
    it(`retries the AU seven-input failure once in a fresh CID within the original20-step budget, stream=${stream}`, async () => {
      const { runtime, directory, body, send, processes } = await fixture(20, { persist: !stream })
      runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ONCE = join(directory, 'failed-once')
      runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_AT = '7'
      runtime.childEnv.AGY_FIXTURE_HISTORY_BURST = '1'
      const claim = runtime.nativeSessions ? spyOn(runtime.nativeSessions, 'claim') : undefined
      const deadlines: number[] = [], original = runtime.create.bind(runtime)
      const create = spyOn(runtime, 'create').mockImplementation(async (...args: Parameters<typeof original>) => { const run = await original(...args); deadlines.push(run.turnDeadline); return run })
      try {
        const response = await send({ stream })
        expect(response.status).toBe(200)
        if (stream) {
          const text = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { type: string; delta?: { text?: string } })
          expect(text.filter(event => event.type === 'message_start')).toHaveLength(1)
          expect(text.filter(event => event.type === 'content_block_delta').map(event => event.delta?.text ?? '').join('')).toBe('NEEDLE_HEAD_742 NEEDLE_TAIL_963')
        } else expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'NEEDLE_HEAD_742 NEEDLE_TAIL_963' }])
        const rows = await processes(), ids = [...new Set(rows.map(row => row.cid))]
        expect(ids).toHaveLength(2)
        const plan = planAgHistory({ ...body, messages: body.messages.map(message => ({ ...message, content: blocks(message) })) }, [], '', 180000, 20, 52000)
        const hashes = plan.map(text => createHash('sha256').update(text).digest('hex'))
        expect(rows.filter(row => row.cid === ids[0]).map(row => row.hash)).toEqual(hashes.slice(0, 7))
        expect(rows.filter(row => row.cid === ids[1]).map(row => row.hash)).toEqual(hashes)
        expect(rows.length).toBeLessThanOrEqual(20)
        expect(deadlines).toHaveLength(2); expect(deadlines[1]).toBe(deadlines[0])
        if (claim) expect(claim).toHaveBeenCalledTimes(1)
        expect(runtime.totals.errors).toBe(0)
        expect(runtime.failed).toBe(1) // Physical failed attempts remain visible, not HTTP errors.
        expect(runtime.requests[0]!.inputTokens).toBe(120 + (6 + plan.length - 1) * 100)
      } finally { create.mockRestore(); claim?.mockRestore() }
    }, 30000)
  }
  it('rematerializes a final image and its allowlist in the fresh workspace', async () => {
    const { runtime, directory, body, send, processes } = await fixture()
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ONCE = join(directory, 'failed-once')
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_AT = '7'
    const messages = body.messages.slice(0, -1)
    messages.push({ role: 'user', content: [
      { type: 'text', text: 'SKIP_TOOLS IMAGE_PROBE LONGCTX_NEEDLES NEEDLE_TAIL_963' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1sAAAAASUVORK5CYII=' } },
    ] })
    const response = await send({ messages })
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'NEEDLE_HEAD_742 NEEDLE_TAIL_963' }])
    const rows = await processes(), ids = [...new Set(rows.map(row => row.cid))]
    expect(ids).toHaveLength(2)
    const oldPath = rows.find(row => row.cid === ids[0])!.workspace, newPath = rows.find(row => row.cid === ids[1])!.workspace
    expect(newPath).not.toBe(oldPath)
    await expect(access(oldPath)).rejects.toThrow()
    await access(newPath)
  }, 30000)
  for (const cap of [16, 15]) {
    it(`enforces the shared step budget at the exact sixteen-step retry boundary, cap=${cap}`, async () => {
      const { runtime, directory, send, processes } = await fixture(cap)
      runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ONCE = join(directory, 'failed-once')
      runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_AT = '7'
      const create = spyOn(runtime, 'create')
      try {
        expect((await send()).status).toBe(cap === 16 ? 200 : 502)
        expect(create).toHaveBeenCalledTimes(cap === 16 ? 2 : 1)
        expect((await processes())).toHaveLength(cap === 16 ? 16 : 7)
        expect(runtime.preparing).toBe(0)
      } finally { create.mockRestore() }
    }, 30000)
  }
  for (const guard of ['AUDIT_ALLOWED', 'TOOL_EVENT', 'NEAR_MATCH', 'DENIED']) {
    it(`declines subscriber recovery with ${guard}`, async () => {
      const { runtime, send, processes } = await fixture()
      runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ALWAYS = '1'
      runtime.childEnv['AGY_FIXTURE_SUBSCRIBER_' + guard] = '1'
      expect((await send()).status).toBe(502)
      expect(new Set((await processes()).map(row => row.cid)).size).toBe(1)
      expect(runtime.preparing).toBe(0)
    })
  }
  it('reserves the failed process slot against a competing request until the fresh retry claims it', async () => {
    const { runtime, directory, body, send, processes } = await fixture(20, { maxConcurrent: 1 })
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ONCE = join(directory, 'failed-once')
    let competitor: Promise<number> | undefined
    const warn = spyOn(console, 'warn').mockImplementation(value => {
      if (String(value).includes('antigravity.cold_replay_retry')) competitor = runtime.create({ ...body, tools: [], messages: [{ role: 'user', content: 'SKIP_TOOLS competitor' }] }).then(() => 0, error => error instanceof AntigravityError ? error.status : 500)
    })
    try {
      expect((await send()).status).toBe(200)
      expect(await competitor).toBe(429)
      expect(new Set((await processes()).map(row => row.cid)).size).toBe(2)
      expect(runtime.preparing).toBe(0)
    } finally { warn.mockRestore() }
  }, 30000)
  it('preserves subscriber failure as the cause if the fresh process cannot be created', async () => {
    const { runtime, send, processes } = await fixture()
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ALWAYS = '1'
    const original = runtime.create.bind(runtime)
    const create = spyOn(runtime, 'create').mockImplementation(async (...args: Parameters<typeof original>) => {
      if (args[3]?.fresh) throw new AntigravityError('Fixture retry unavailable', 503, 'api_error')
      return original(...args)
    })
    try {
      const response = await send()
      expect(response.status).toBe(503)
      const error = await response.text()
      expect(error).toContain('subscriber fell behind updates')
      expect(error).toContain('Fixture retry unavailable')
      expect(new Set((await processes()).map(row => row.cid)).size).toBe(1)
      expect(runtime.preparing).toBe(0)
    } finally { create.mockRestore() }
  })
  it('never retries twice even when the second priming subscription fails', async () => {
    const { runtime, send, processes } = await fixture()
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ALWAYS = '1'
    expect((await send()).status).toBe(502)
    expect(new Set((await processes()).map(row => row.cid)).size).toBe(2)
  })
  it('declines a retry before another process when its whole plan cannot fit the remaining step cap', async () => {
    const { runtime, directory, send, processes } = await fixture(12)
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ONCE = join(directory, 'failed-once')
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_AT = '7'
    expect((await send()).status).toBe(502)
    expect(new Set((await processes()).map(row => row.cid)).size).toBe(1)
    expect((await processes())).toHaveLength(7)
  }, 30000)
  it('never replays an answering-step subscriber failure', async () => {
    const { runtime, send, processes } = await fixture()
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_FINAL = '1'
    expect((await send()).status).toBe(502)
    expect(new Set((await processes()).map(row => row.cid)).size).toBe(1)
  }, 30000)
  it('honors cancellation after the failed process is joined, before starting another', async () => {
    const { runtime, send, processes } = await fixture()
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ALWAYS = '1'
    const controller = new AbortController()
    const warn = spyOn(console, 'warn').mockImplementation(value => { if (String(value).includes('antigravity.cold_replay_retry')) controller.abort() })
    try { expect((await send({}, controller.signal)).status).toBe(499) } finally { warn.mockRestore() }
    expect(new Set((await processes()).map(row => row.cid)).size).toBe(1)
  })
  it('honors shutdown at the retry boundary without another process', async () => {
    const { runtime, app, send, processes } = await fixture()
    runtime.childEnv.AGY_FIXTURE_SUBSCRIBER_ALWAYS = '1'
    let closing: Promise<void> | undefined
    const warn = spyOn(console, 'warn').mockImplementation(value => { if (String(value).includes('antigravity.cold_replay_retry')) closing = app.closeBackend() })
    try { expect((await send()).status).toBe(503); await closing } finally { warn.mockRestore() }
    expect(new Set((await processes()).map(row => row.cid)).size).toBe(1)
  })
  it('bounds an unterminated oversized ACK line and joins without retrying it', async () => {
    const { runtime, app, send, processes } = await fixture()
    runtime.childEnv.AGY_FIXTURE_PARTIAL_HISTORY = '1'
    expect((await send()).status).toBe(502)
    await app.closeBackend()
    expect(runtime.runs.size).toBe(0)
    expect((await processes())).toHaveLength(1)
  })
  it('refuses the final step if a cold native boundary stays unreadable', async () => {
    const { send, processes } = await fixture()
    const marker = spyOn(AgNativeRecords.prototype, 'watermark').mockReturnValue(undefined)
    try {
      expect((await send()).status).toBe(502)
      expect(marker).toHaveBeenCalledTimes(3)
      expect((await processes())).toHaveLength(8)
    } finally { marker.mockRestore() }
  })
  it('joins a child if persistent PID registration fails before the first input', async () => {
    const { runtime, send, processes } = await fixture(20, { persist: true })
    const sessions = runtime.nativeSessions!, original = sessions.register.bind(sessions)
    let pid: number | undefined
    const register = spyOn(sessions, 'register').mockImplementation((workspace, childPid) => {
      if (childPid) { pid = childPid; throw new Error('Fixture PID registration failed') }
      return original(workspace, childPid)
    })
    try {
      expect((await send()).status).toBe(503)
      expect(runtime.runs.size).toBe(0)
      expect(pid).toBeDefined()
      expect(() => process.kill(pid!, 0)).toThrow()
      await expect(processes()).rejects.toThrow()
    } finally { register.mockRestore() }
  })
  it('refuses a retry whose original absolute deadline already elapsed', async () => {
    const { runtime, body, processes } = await fixture()
    await expect(runtime.create(body, undefined, false, { fresh: true, deadline: Date.now() - 1 })).rejects.toMatchObject({ status: 504 })
    await expect(processes()).rejects.toThrow()
  })
})
