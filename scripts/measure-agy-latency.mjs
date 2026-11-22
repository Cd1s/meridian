#!/usr/bin/env node

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const baseUrl = option('--base-url', 'http://127.0.0.1:3456').replace(/\/$/, '')
const count = Math.max(1, Number(option('--count', option('-n', '6'))))
const gapSec = Math.max(0, Number(option('--gap-sec', '20')))
const apiKey = process.env.MERIDIAN_MEASURE_KEY
if (!apiKey) throw new Error('MERIDIAN_MEASURE_KEY is required')

async function status() {
  const response = await fetch(`${baseUrl}/health`)
  const body = await response.json().catch(() => ({}))
  return { status: response.status, body }
}

async function measure(index) {
  const started = performance.now()
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ model: 'gemini-3.8-flash-low', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
  })
  let firstByte
  if (response.body) {
    const reader = response.body.getReader()
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        if (part.value?.byteLength) {
          firstByte ??= performance.now()
          break
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
  const finished = performance.now()
  return { request: index, status: response.status, ttfbMs: Math.round((firstByte ?? finished) - started), totalMs: Math.round(finished - started) }
}

const before = await status()
const results = []
for (let index = 1; index <= count; index++) {
  results.push(await measure(index))
  console.log(JSON.stringify(results.at(-1)))
  if (index < count && gapSec) await new Promise(resolve => setTimeout(resolve, gapSec * 1000))
}
const after = await status()
const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}
for (const key of ['ttfbMs', 'totalMs']) {
  const values = results.map(result => result[key])
  console.log(JSON.stringify({ metric: key, p50: percentile(values, 0.5), p90: percentile(values, 0.9) }))
}
const counters = ['verifyCacheHits', 'verifyCacheMisses', 'modelsCacheHits', 'modelsRefreshes']
const pick = snapshot => Object.fromEntries(counters.map(key => [key, snapshot.body?.[key] ?? null]))
console.log(JSON.stringify({ statusBefore: before.status, countersBefore: pick(before), statusAfter: after.status, countersAfter: pick(after) }))
