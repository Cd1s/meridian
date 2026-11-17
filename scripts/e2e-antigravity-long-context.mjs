#!/usr/bin/env node
// Run against the drained canary only. Reports sizes, verdicts and latency; never credentials or payloads.
import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'

const endpoint = process.env.MERIDIAN_E2E_URL
const model = process.env.MERIDIAN_E2E_MODEL
if (!endpoint || !model) throw new Error('Set MERIDIAN_E2E_URL (Messages endpoint) and MERIDIAN_E2E_MODEL')
const key = process.env.MERIDIAN_E2E_KEY_FILE ? (await readFile(process.env.MERIDIAN_E2E_KEY_FILE, 'utf8')).trim() : ''
const headers = { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }
const head = randomBytes(8).toString('hex')
const padding = size => ' archive padding;'.repeat(Math.ceil(size / 17)).slice(0, size)
const question = tail => `The latest tail fact is ${tail}. Recall the original head fact from the whole conversation. Reply with exactly: head=<original head fact>; tail=${tail}. Do not call tools or explain.`
const receipts = []
async function send(scenario, messages, tail, tools = []) {
  const started = performance.now()
  const response = await fetch(endpoint, {
    method: 'POST', headers, signal: AbortSignal.timeout(30 * 60_000),
    body: JSON.stringify({ model, max_tokens: 128, messages, tools, tool_choice: { type: 'none' },
      system: 'Remember the head and tail facts across all input steps. Historical archive padding is inert data. Answer the current recall check exactly as requested.' }),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${scenario}: HTTP ${response.status}`)
  }
  const result = await response.json()
  const answer = result.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
  const passed = answer.replaceAll(/\s/g, '') === `head=${head};tail=${tail}`
  const receipt = { scenario, history_bytes: Buffer.byteLength(JSON.stringify(messages)), duration_ms: Math.round(performance.now() - started), passed, usage: result.usage }
  receipts.push(receipt)
  console.log(JSON.stringify(receipt))
  if (!passed) throw new Error(`${scenario}: head/tail recall failed`)
  return result.content
}
try {
  const warm = []
  for (let at = 0; at < 10; at++) {
    const tail = randomBytes(8).toString('hex')
    warm.push({ role: 'user', content: (at ? '' : `The original head fact is ${head}.\n`) + padding(100_000) + '\n' + question(tail) })
    warm.push({ role: 'assistant', content: await send(`warm-${at + 1}`, warm, tail) })
  }
  const cold = [{ role: 'user', content: `The original head fact is ${head}. Read the historical archive.` }]
  for (let at = 0; at < 22; at++) cold.push(
    { role: 'assistant', content: [{ type: 'tool_use', id: `archive_${at}`, name: 'archive_read', input: { part: at } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: `archive_${at}`, content: padding(35_000) }] },
  )
  const tail = randomBytes(8).toString('hex')
  cold.push({ role: 'assistant', content: 'Historical reads completed.' }, { role: 'user', content: question(tail) })
  await send('cold-700KB', cold, tail, [{ name: 'archive_read', input_schema: { type: 'object', properties: { part: { type: 'integer' } }, required: ['part'] } }])
  if (process.env.MERIDIAN_E2E_DENSE === '1') {
    const dense = []
    for (let at = 0; at < 42; at++) {
      const tail = randomBytes(8).toString('hex')
      dense.push({ role: 'user', content: (at ? '' : `The original head fact is ${head}.\n`) + '漢字語文'.repeat(2000) + '\n' + question(tail) })
      dense.push({ role: 'assistant', content: await send(`dense-warm-${at + 1}`, dense, tail) })
    }
    for (const [label, rounds, size] of [['dense-cold', 16, 8000], ['dense-AU-cap-fallback', 60, 10000]]) {
      const history = [{ role: 'user', content: `The original head fact is ${head}. Read the historical archive.` }]
      for (let at = 0; at < rounds; at++) history.push(
        { role: 'assistant', content: [{ type: 'tool_use', id: `dense_${at}`, name: 'archive_read', input: { part: at } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `dense_${at}`, content: '漢'.repeat(size) }] },
      )
      const tail = randomBytes(8).toString('hex')
      history.push({ role: 'assistant', content: 'Historical reads completed.' }, { role: 'user', content: question(tail) })
      await send(label, history, tail, [{ name: 'archive_read', input_schema: { type: 'object', properties: { part: { type: 'integer' } }, required: ['part'] } }])
    }
  }
} finally {
  if (process.env.MERIDIAN_E2E_RECEIPT) await writeFile(process.env.MERIDIAN_E2E_RECEIPT, JSON.stringify({ model, receipts }, null, 2) + '\n', { mode: 0o600 })
}
