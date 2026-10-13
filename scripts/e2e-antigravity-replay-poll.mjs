// Live Pi gate for the replay guard (#1340): a legitimate identical read after a history replay must not be answered
// with the stale recorded result. Uses subscription quota through official agy.
//
// Pi polls a status file that says "running". After Pi's first read completes, the relay changes the file to "done"
// and replaces the backend before forwarding that result, so the next request is a completed-history replay. A model
// that re-reads (polls) then repeats the completed call. The previous guard answered that repeat with the recorded
// "running"; the corrected guard answers with a not-executed notice and a repeated read reaches Pi.
//
//   npm run build && E2E_PI_BIN=/path/to/pi node scripts/e2e-antigravity-replay-poll.mjs
//   E2E_MERIDIAN_ROOT=/other/checkout selects another built checkout or installed package root (loads dist/server.js).
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'

const meridianRoot = resolve(process.env.E2E_MERIDIAN_ROOT || '.')
const { startProxyServer } = await import(pathToFileURL(join(meridianRoot, 'dist/server.js')).href)
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-replay-poll-'))
const project = join(root, 'client'), config = join(root, 'pi-config')
await mkdir(project); await mkdir(config)
console.log(`Artifacts: ${root}`)
const model = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const executable = process.env.MERIDIAN_AGY_PATH || 'agy'
const pi = process.env.E2E_PI_BIN || 'pi'
const version = binary => {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return (result.stdout || result.stderr).trim()
}
const report = { model, cli: version(executable), pi: version(pi), platform: `${process.platform}-${process.arch}`, node: process.version, meridianRoot }
report.meridian = JSON.parse(await readFile(join(meridianRoot, 'dist/build-provenance.json'), 'utf8')).build?.displayVersion

// The guard logs one JSON line per intercepted repeat; record them without arguments.
const events = []
const log = console.log
console.log = (...args) => {
  const line = args.map(String).join(' ')
  if (line.includes('"agy_replay_duplicate"')) events.push({ at: Date.now(), line })
  log(...args)
}

const statusPath = join(project, 'build-status.txt')
await writeFile(statusPath, 'running\n')
const options = { backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true } }
let proxy, relay, url, restarted = false, restartAt = 0
const observed = []
try {
  proxy = await startProxyServer(options)
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  url = `http://127.0.0.1:${proxy.server.address().port}`
  relay = createServer(async (req, res) => {
    const abort = new AbortController()
    res.once('close', () => { if (!res.writableFinished) abort.abort() })
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = raw ? JSON.parse(raw) : undefined
      if (body) observed.push({ at: Date.now(), body })
      const returned = body?.messages?.at(-1)?.content
      const statusRead = Array.isArray(returned) && returned.some(block => block.type === 'tool_result' && !block.is_error && JSON.stringify(block.content).includes('running'))
      if (!restarted && statusRead) {
        // The build finishes while the result is in flight; the replayed run must not report the old value as current.
        restarted = true
        await writeFile(statusPath, 'done\n')
        await proxy.close()
        proxy = await startProxyServer(options)
        if (!proxy.server.listening) await once(proxy.server, 'listening')
        url = `http://127.0.0.1:${proxy.server.address().port}`
        restartAt = Date.now()
        log('Status changed to done; backend replaced before forwarding the completed read')
      }
      const response = await fetch(url + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw || undefined, signal: abort.signal })
      if (response.status >= 400) log('HTTP', response.status, await response.clone().text())
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') })
      Readable.fromWeb(response.body).on('error', error => res.destroy(error)).pipe(res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise(done => relay.listen(0, '127.0.0.1', done))
  await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { 'meridian-agy': { baseUrl: `http://127.0.0.1:${relay.address().port}`, apiKey: 'local-fixture', api: 'anthropic-messages', models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  await writeFile(join(config, 'settings.json'), JSON.stringify({ compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 512 }, retry: { enabled: false } }))
  const prompt = `A build is running. Poll its status file ${statusPath} with your read tool until it says done: read it, and whenever it does not say done, read it again, because it is updated while you work. Read it at most 5 times. Then reply with exactly one line: FINAL_STATUS=<the status from your most recent read>. Use only the read tool.`
  const env = { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY|MERIDIAN_)/.test(key)) delete env[key]
  const args = ['--provider', 'meridian-agy', '--model', model, '--thinking', 'off', '--tools', 'read', '--session', join(root, 'pi-session.jsonl'), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--system-prompt', 'Use the client read tool. Report tool results exactly.', '-p', prompt]
  const child = spawn(pi, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
  }, 300000)
  const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) }).finally(() => clearTimeout(timer))
  await writeFile(join(root, 'pi.stdout'), stdout); await writeFile(join(root, 'pi.stderr'), stderr)
  await writeFile(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
  assert.equal(code, 0, stderr)

  // Reads Pi actually executed, in order, with what each returned.
  const calls = new Map(), results = new Map()
  for (const { body } of observed) for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.set(block.id, block)
      if (block.type === 'tool_result') results.set(block.tool_use_id, JSON.stringify(block.content))
    }
  }
  const reads = [...calls.values()].filter(call => call.name === 'read').map(call => ({ id: call.id, returned: results.get(call.id)?.includes('done') ? 'done' : results.get(call.id)?.includes('running') ? 'running' : 'other' }))
  const final = /FINAL_STATUS=(\w+)/.exec(stdout)?.[1]
  Object.assign(report, { restarted, clientReads: reads, guardEvents: events.length, finalStatus: final ?? null, stdoutTail: stdout.trim().slice(-200) })
  assert(restarted, 'The backend must be replaced before the completed read is forwarded')
  assert.equal(reads[0]?.returned, 'running', 'First client read returns running')
  assert(reads.some(read => read.returned === 'done'), 'A read after the replay must reach Pi and return the current status')
  assert.equal(final, 'done', 'The final report must use the current status, not the stale replayed one')
  report.passed = true
} catch (error) {
  report.passed = false
  report.error = String(error?.message ?? error)
  process.exitCode = 1
} finally {
  console.log = log
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (proxy) await proxy.close()
  if (relay) { relay.closeAllConnections(); await new Promise(done => relay.close(done)) }
}
