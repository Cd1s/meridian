import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import * as childProcess from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AntigravityRuntime } from '../proxy/backends/antigravityRuntime'
import { parseAgRequest } from '../proxy/backends/antigravityProtocol'

const roots: string[] = []
const fixtures = new Set<string>()
const nodeExecutable = Bun.which('node')
const realSpawn = childProcess.spawn
let spawnSpy: { mockRestore(): void } | undefined
beforeEach(() => {
  if (!nodeExecutable) throw new Error('Node is required for warm-spare fixtures')
  spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(new Proxy(realSpawn, { apply(target, receiver, args) {
    const [executable, argv, options] = args
    return Reflect.apply(target, receiver, fixtures.has(executable) ? [nodeExecutable, [executable, ...argv], options] : args)
  } }))
})
afterEach(() => { spawnSpy?.mockRestore(); fixtures.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agy-spare-upstream-')); roots.push(root)
  const executable = join(root, 'agy.cjs'); fixtures.add(executable)
  const meminfo = join(root, 'meminfo'); writeFileSync(meminfo, 'MemAvailable: 65536000 kB\n')
  writeFileSync(executable, `const args=process.argv.slice(2);if(args.includes('--version')){console.log('1.5.17');process.exit(0)}if(args[0]==='models'){console.log('gemini-test\\tTest');process.exit(0)}if(args[0]==='-p'){console.log(JSON.stringify({status:'SUCCESS',response:'customModelsConfig\\t{}\\nmodelProvider\\t\\ngcp\\t\\nuseG1Credits\\tfalse'}));process.exit(0)}let input='';process.stdin.on('data',c=>{input+=c;while(input.includes('\\n')){input=input.slice(input.indexOf('\\n')+1);process.stdout.write(JSON.stringify({event:'init'})+'\\n');process.stdout.write(JSON.stringify({event:'step_update',step_update:{text_delta:'OK',state:'DONE',usage:{input_tokens:1,output_tokens:1}}})+'\\n');process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS'}})+'\\n')}})` , { mode: 0o755 })
  return { executable, meminfo }
}
function request() { return parseAgRequest({ model: 'gemini-test', tools: [{ name: 'lookup', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'Reply OK' }] }) }
async function waitFor(check: () => boolean): Promise<void> { const until = Date.now() + 3000; while (!check() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10)); expect(check()).toBe(true) }

describe.skipIf(process.platform === 'win32')('Antigravity warm spare', () => {
  it('uses a spare for a completed client-tool history turn and keeps request tools out of the key', async () => {
    const f = fixture()
    const previous = { spare: process.env.MERIDIAN_AGY_SPARE, mem: process.env.MERIDIAN_AGY_MEMINFO_PATH, min: process.env.MERIDIAN_AGY_SPARE_MIN_MEM_MB }
    Object.assign(process.env, { MERIDIAN_AGY_SPARE: '1', MERIDIAN_AGY_MEMINFO_PATH: f.meminfo, MERIDIAN_AGY_SPARE_MIN_MEM_MB: '0' })
    const runtime = new AntigravityRuntime({ executable: f.executable, reuseConversations: false, allowToolBridge: true })
    try {
      const body = parseAgRequest({ ...request(), messages: [{ role: 'user', content: 'old' }, { role: 'assistant', content: [{ type: 'tool_use', id: 'old', name: 'lookup', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'old', content: 'done' }] }, { role: 'user', content: 'new' }] })
      expect(runtime.spareKeyFor(body)).toContain('"toolsOn":true')
      runtime.refillSpare(body)
      await waitFor(() => runtime.sparesIdle === 1)
      const run = await runtime.create(body)
      await run.settled
      expect(runtime.spareHits).toBe(1)
    } finally {
      await runtime.close()
      for (const [key, value] of Object.entries(previous)) { const name = key === 'spare' ? 'MERIDIAN_AGY_SPARE' : key === 'mem' ? 'MERIDIAN_AGY_MEMINFO_PATH' : 'MERIDIAN_AGY_SPARE_MIN_MEM_MB'; if (value === undefined) delete process.env[name]; else process.env[name] = value }
    }
  })
})
