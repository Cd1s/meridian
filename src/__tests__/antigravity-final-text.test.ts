import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import Database from 'libsql'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { AgFinalText, agEventShape } from '../proxy/backends/antigravityFinalText'
import { AgNativeRecords, agNativeRecordUri, type AgNativeAnchor } from '../proxy/backends/antigravityNativeRecord'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { createAntigravityServer } from '../proxy/backends/antigravity'
import { DEFAULT_PROXY_CONFIG } from '../proxy/types'
import type { AgMessage } from '../proxy/backends/antigravityProtocol'

interface Turn { home: string; cid: string; trajectory: string; execution: string; inputIdx: number }
const native = createRequire(import.meta.url)('./fixtures/agy-native-record.cjs') as {
  schema: string
  input(home: string, cid: string, prompt: string): Turn
  answer(turn: Turn, text: string, options?: { tool?: boolean; execution?: string; status?: number; error?: string; modified?: string; thinking?: string; at?: number }): number
}
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agy-final-text-'))
  cleanup.push(() => rm(path, { recursive: true, force: true }))
  return path
}
function dbPath(home: string, cid: string) { return join(home, '.gemini', 'antigravity-cli', 'conversations', cid + '.db') }
function anchor(prompt: string, after = -1): AgNativeAnchor { return { prompt, inputAfter: after, responseAfter: after, startedAt: Date.now(), firstInput: after < 0 } }

describe('Antigravity final response channels', () => {
  it('deduplicates complete snapshots, extends streamed prefixes, and excludes thinking', () => {
    const text = new AgFinalText()
    text.accept({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'head=' } })
    expect(text.take()).toBe('head=')
    text.accept({ event: 'step_update', step_update: { step_type: 'thinking', text_delta: 'SECRET_THINKING' } })
    text.accept({ event: 'step_update', step_update: { step_type: 'agent_response', planner_response: { response: 'head=H;tail=T', thinking: 'SECRET_THINKING' } } })
    expect(text.take()).toBe('H;tail=T')
    text.accept({ event: 'result', result: { status: 'SUCCESS', planner_response: { modified_response: 'head=H;tail=T' } } })
    expect(text.take()).toBe('')
    expect(text.text).not.toContain('SECRET_THINKING')
  })
  it('rejects conflicting snapshots after publishing a prefix', () => {
    const text = new AgFinalText()
    text.accept({ step_update: { step_type: 'agent_response', text_delta: 'one' } })
    text.take()
    text.accept({ step_update: { step_type: 'agent_response', planner_response: { response: 'other' } } })
    expect(text.conflict).toBe(true)
  })
  it('records field shapes without text, arguments or reasoning values', () => {
    const shape = agEventShape({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'SECRET_ANSWER', thinking: 'SECRET_THINKING', arguments: { token: 'SECRET_CREDENTIAL' } } })
    const serialized = JSON.stringify(shape)
    expect(serialized).toContain('text_delta')
    expect(serialized).not.toContain('SECRET_')
  })
})

describe.skipIf(process.platform === 'win32')('Antigravity current-turn native record', () => {
  it('reads the independently supplied 1.2.7 protobuf fixture without changing the DB', async () => {
    const home = await directory()
    const fixture = JSON.parse(await readFile(fileURLToPath(new URL('./fixtures/agy-native-turn-1.2.7.json', import.meta.url)), 'utf8')) as {
      conversation_id: string; trajectory_meta: Array<[string, string, number, number]>;
      steps: Array<{ idx: number; step_type: number; status: number; step_format: number; metadata_hex: string; step_payload_hex: string }>
      expected: { user_response: string; final_text: string }
    }
    const path = dbPath(home, fixture.conversation_id)
    await mkdir(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
    const db = new Database(path)
    db.exec(native.schema)
    for (const row of fixture.trajectory_meta) db.prepare('INSERT INTO trajectory_meta VALUES(?,?,?,?)').run(...row)
    for (const row of fixture.steps) db.prepare('INSERT INTO steps VALUES(?,?,?,?,?,?,NULL)').run(row.idx, row.step_type, row.status, row.step_format, Buffer.from(row.metadata_hex, 'hex'), Buffer.from(row.step_payload_hex, 'hex'))
    db.close()
    const before = createHash('sha256').update(await readFile(path)).digest('hex')
    const records = new AgNativeRecords(home)
    const result = records.recover(fixture.conversation_id, { ...anchor(fixture.expected.user_response, 9), firstInput: false, startedAt: 1700000000000 })
    expect(result?.text).toBe(fixture.expected.final_text)
    expect(result?.inputStep).toBe(10)
    expect(result?.responseStep).toBe(11)
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(before)
  })
  it('enforces actual SQLite read-only mode despite libsql ignoring the readonly option', async () => {
    const home = await directory(), cid = randomUUID()
    native.answer(native.input(home, cid, 'CURRENT'), 'ANSWER')
    const db = new Database(agNativeRecordUri(dbPath(home, cid)))
    try { expect(() => db.exec('DELETE FROM steps')).toThrow() } finally { db.close() }
  })
  it('rejects an old answer even when the new prompt would be identical', async () => {
    const home = await directory(), cid = randomUUID(), records = new AgNativeRecords(home)
    native.answer(native.input(home, cid, 'SAME_PROMPT'), 'OLD_ANSWER')
    const mark = records.watermark(cid)!
    expect(records.recover(cid, { ...anchor('SAME_PROMPT', mark), conversationId: cid })).toBeUndefined()
  })
  it('selects only the new execution and rejects mismatched input, conversation, phase and timestamps', async () => {
    const home = await directory(), cid = randomUUID(), records = new AgNativeRecords(home)
    native.answer(native.input(home, cid, 'OLD'), 'OLD_ANSWER')
    const current = anchor('CURRENT', records.watermark(cid)!)
    native.answer(native.input(home, cid, 'CURRENT'), 'NEW_ANSWER')
    expect(records.recover(cid, current)?.text).toBe('NEW_ANSWER')
    expect(records.recover(cid, { ...current, prompt: 'DIFFERENT' })).toBeUndefined()
    expect(records.recover(cid, { ...current, conversationId: randomUUID() })).toBeUndefined()
    expect(records.recover(cid, { ...current, responseAfter: records.watermark(cid)! })).toBeUndefined()
    expect(records.recover(cid, { ...current, startedAt: Date.now() + 60000 })).toBeUndefined()
  })
  for (const failure of ['execution', 'status', 'error', 'tool', 'empty', 'ambiguous'] as const) {
    it(`rejects native ${failure} records`, async () => {
      const home = await directory(), cid = randomUUID(), records = new AgNativeRecords(home), current = anchor('CURRENT')
      const turn = native.input(home, cid, 'CURRENT')
      native.answer(turn, failure === 'empty' ? '' : 'ANSWER', {
        ...(failure === 'execution' ? { execution: randomUUID() } : {}),
        ...(failure === 'status' ? { status: 2 } : {}),
        ...(failure === 'error' ? { error: 'native failure' } : {}),
        ...(failure === 'tool' ? { tool: true } : {}),
        ...(failure === 'ambiguous' ? { modified: 'DIFFERENT' } : {}), thinking: 'PRIVATE_THINKING',
      })
      expect(records.recover(cid, current)).toBeUndefined()
    })
  }
  it('rejects oversized and malformed protobuf records without retaining a read transaction', async () => {
    const home = await directory(), cid = randomUUID(), records = new AgNativeRecords(home), current = anchor('CURRENT')
    native.answer(native.input(home, cid, 'CURRENT'), 'ANSWER')
    for (const value of ["X'80'", 'zeroblob(4194305)']) {
      const db = new Database(dbPath(home, cid))
      try { db.exec(`UPDATE steps SET step_payload = ${value} WHERE step_type = 15`) } finally { db.close() }
      expect(records.recover(cid, current)).toBeUndefined()
    }
  })
  it('sees committed WAL content and never follows a database symlink', async () => {
    const home = await directory(), cid = randomUUID(), records = new AgNativeRecords(home)
    const turn = native.input(home, cid, 'CURRENT')
    const held = new Database(dbPath(home, cid)); held.pragma('journal_mode = WAL')
    try {
      const current = { ...anchor('CURRENT'), startedAt: Date.now() - 1000 }
      native.answer(turn, 'WAL_ANSWER')
      expect(records.recover(cid, current)?.text).toBe('WAL_ANSWER')
    } finally { held.close() }
    const alias = randomUUID()
    await symlink(dbPath(home, cid), dbPath(home, alias))
    expect(records.watermark(alias)).toBeUndefined()
    expect(records.recover('../bad', anchor('CURRENT'))).toBeUndefined()
  })
})

const executable = fileURLToPath(new URL('./fixtures/agy-cli.cjs', import.meta.url))
async function server(nativeRecords = true) {
  const home = await directory()
  const runtime = new AntigravityRuntime({ executable, allowToolBridge: true, turnTimeoutMs: 10000, idleConversationMs: 5000, trimOldestTurns: true })
  runtime.childEnv.HOME = home
  if (nativeRecords) runtime.childEnv.AGY_FIXTURE_NATIVE_RECORDS = '1'
  const app = createAntigravityServer({ ...DEFAULT_PROXY_CONFIG, backend: 'antigravity' }, runtime)
  cleanup.unshift(app.closeBackend)
  const send = (messages: AgMessage[], extra = {}, signal?: AbortSignal) => app.app.fetch(new Request('http://local/v1/messages', { method: 'POST', signal, body: JSON.stringify({ model: 'fixture-model', max_tokens: 128, messages, tools: [], ...extra }) }))
  return { runtime, send, app, home }
}

describe.skipIf(process.platform === 'win32')('Antigravity final-text recovery integration', () => {
  for (const channel of ['FINAL_RESPONSE_SNAPSHOT', 'FINAL_RESULT_SNAPSHOT', 'FINAL_LATE_RESPONSE']) {
    it(`collects ${channel} without requiring native records`, async () => {
      const { send } = await server(false)
      const response = await send([{ role: 'user', content: `SKIP_TOOLS ${channel}` }])
      expect(response.status).toBe(200)
      const answer = await response.json() as { content: unknown }
      expect(answer.content).toEqual([{ type: 'text', text: 'READY' }])
    })
  }
  it('recovers dense warm turn25 after compaction from the current native record, with no answer text in logs', async () => {
    const { send, runtime } = await server()
    const messages: AgMessage[] = [{ role: 'user', content: 'SKIP_TOOLS NEEDLE_HEAD_742' }]
    const log = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (let turn = 1; turn <= 40; turn++) {
        if (turn > 1) messages.push({ role: 'user', content: '漢字語文'.repeat(2000) + ` SKIP_TOOLS LONGCTX_NEEDLES NEEDLE_TAIL_963 ${turn === 25 ? 'NATIVE_RECORD_ONLY' : ''}` })
        const response = await send(messages)
        expect(response.status).toBe(200)
        const answer = await response.json() as { content: AgMessage['content'] }
        if (turn === 25) expect([...runtime.runs.values()].some(run => run.compacted)).toBe(true)
        if (turn > 1) expect(answer.content).toEqual([{ type: 'text', text: 'NEEDLE_HEAD_742 NEEDLE_TAIL_963' }])
        messages.push({ role: 'assistant', content: answer.content })
      }
      expect(runtime.reused).toBeLessThan(39)
      const lines = log.mock.calls.map(args => String(args[0]))
      expect(lines.some(line => line.includes('antigravity.final_text_recovered') && line.includes('native-record'))).toBe(true)
      expect(lines.join('\n')).not.toContain('NEEDLE_HEAD_742')
      expect(lines.join('\n')).not.toContain('PRIVATE_REASONING_NEVER_RETURN')
    } finally { log.mockRestore() }
  }, 30000)
  it('recovers an unrecognized stream channel from the native record and still rejects genuinely empty or wrong-execution records', async () => {
    const { send } = await server()
    expect((await send([{ role: 'user', content: 'SKIP_TOOLS FINAL_UNRECOGNIZED' }])).status).toBe(200)
    expect((await send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_EMPTY' }])).status).toBe(502)
    expect((await send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_WRONG_EXEC' }])).status).toBe(502)
  })
  it('never reuses pre-tool narration as the final answer', async () => {
    const { send } = await server()
    const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }]
    const messages: AgMessage[] = [{ role: 'user', content: 'NATIVE_EMPTY_AFTER_TOOL lookup' }]
    const first = await send(messages, { tools })
    const calls = await first.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    messages.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: 'new result' }] })
    expect((await send(messages, { tools })).status).toBe(502)
  })
  it('recovers only the post-tool answer from the same native execution', async () => {
    const { send } = await server()
    const tools = [{ name: 'lookup', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }]
    const messages: AgMessage[] = [{ role: 'user', content: 'NATIVE_RECORD_ONLY lookup' }]
    const first = await send(messages, { tools })
    const calls = await first.json() as { content: Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> }
    messages.push({ role: 'assistant', content: calls.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: calls.content[0]!.id, content: 'post-tool answer' }] })
    const response = await send(messages, { tools })
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: 'post-tool answer' }])
  })
  for (const interruption of ['cancel', 'shutdown']) {
    it(`joins native recovery on ${interruption}`, async () => {
      const { send, runtime, app } = await server()
      const controller = new AbortController()
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const read = spyOn(AgNativeRecords.prototype, 'recover').mockImplementation(() => { entered(); return undefined })
      try {
        const pending = send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_EMPTY' }], {}, controller.signal)
        await started
        if (interruption === 'cancel') controller.abort()
        else await app.closeBackend()
        expect((await pending).status).toBe(interruption === 'cancel' ? 499 : 503)
        await app.closeBackend()
        expect(runtime.settling.size).toBe(0)
        expect(runtime.runs.size).toBe(0)
      } finally { read.mockRestore() }
    })
  }
  it('validates recovered structured JSON rather than returning unvalidated native text', async () => {
    const { send } = await server()
    const format = { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] } }
    const response = await send([{ role: 'user', content: 'SKIP_TOOLS NATIVE_RECORD_ONLY MISSING_STRUCTURED' }], { output_config: { format } })
    expect(response.status).toBe(200)
    expect((await response.json() as { content: unknown }).content).toEqual([{ type: 'text', text: '{"answer":"READY"}' }])
  })
})
