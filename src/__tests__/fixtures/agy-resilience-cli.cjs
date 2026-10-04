#!/usr/bin/env node
// Fault-injection shim: runs the deterministic agy fixture with extra markers injected at
// the point where it has read the tool results, so the original file stays untouched.
const Module = require('node:module')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const path = join(__dirname, 'agy-cli.cjs')
const anchor = "let answer = replayedResults.length"
const injected = `
  const nap = ms => new Promise(resolve => setTimeout(resolve, ms))
  const loop = /LOOP_(\\d+)/.exec(prompt)
  if (loop && !replayedResults.length) {
    const seen = []
    for (let n = 0; n < Number(loop[1]); n++) {
      await nap(80)
      const result = await rpc('tools/call', { name: tools[0].name, arguments: { key: 'step' + n } })
      seen.push(JSON.parse(result.content[0].text).meridian_client_result)
    }
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'LOOP_DONE:' + seen.join('|') } })
    emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 120, output_tokens: 10 } } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  if (prompt.includes('CRASH_AFTER_RESULT') && !replayedResults.length) {
    await rpc('tools/call', { name: tools[0].name, arguments: { key: 'probe0' } })
    process.exit(3)
  }
  if (prompt.includes('SLOW_ANSWER') && !replayedResults.length) {
    const result = await rpc('tools/call', { name: tools[0].name, arguments: { key: 'probe0' } })
    await nap(700)
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'SLOW:' + JSON.parse(result.content[0].text).meridian_client_result } })
    emit({ event: 'step_update', step_update: { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 120, output_tokens: 10 } } })
    return emit({ event: 'result', result: { status: 'SUCCESS' } })
  }
  `
const source = readFileSync(path, 'utf8').replace(/^#!.*\n/, '')
if (!source.includes(anchor)) throw new Error('agy-cli.cjs changed; update the resilience shim anchor')
const mod = new Module(path, null)
mod.filename = path
mod.paths = Module._nodeModulePaths(__dirname)
mod._compile(source.replace(anchor, injected + anchor), path)
