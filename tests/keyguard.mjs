// Regression test for the key-disclosure finding.
//
// A key containing a control character makes Node's own Headers.append throw,
// and that error message quotes the value back. Before the startup guard, that
// message reached a tool result and therefore the conversation transcript.
//
// This asserts the server refuses to start on such a key, and that the
// diagnostic it prints does NOT contain the key itself.
import { spawn } from 'node:child_process'

const SENTINEL = 'sk_LEAK_SENTINEL_VALUE'
const BAD_KEY = `${SENTINEL}\r\nextra`

const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, SHARPAPI_KEY: BAD_KEY },
})

let out = '', err = ''
proc.stdout.on('data', (d) => { out += d.toString() })
proc.stderr.on('data', (d) => { err += d.toString() })

// A hang IS the regression, so fail on it rather than waiting. With the startup
// guard the server exits 1 immediately; without it the server starts normally
// and holds stdio open, so `close` never fires. Left unbounded that runs to
// GitHub's 360-minute job default and reads as "stuck CI" rather than "the leak
// is back". `code` is declared before the timer so the handler can read it.
let code = null
const timer = setTimeout(() => {
  proc.kill('SIGKILL')
  fail('server did not exit within 10s; it started with the control-character key')
}, 10_000)
code = await new Promise((resolve) => proc.on('close', resolve))
clearTimeout(timer)

function fail(why) {
  console.error('FAIL:', why)
  console.error('exit:', code, '\nstdout:', JSON.stringify(out), '\nstderr:', err)
  process.exit(1)
}

if (code === 0) fail('server started with a control-character key; it must refuse')
if (err.includes(SENTINEL) || out.includes(SENTINEL)) {
  fail('the diagnostic echoed the key back, which is the leak this guard exists to stop')
}
if (!/control character/i.test(err)) fail(`expected a control-character diagnostic, got: ${err.slice(0, 200)}`)
if (out.trim() !== '') fail(`server wrote to stdout, which corrupts the MCP transport: ${out.slice(0, 200)}`)

console.log('PASS: refuses a control-character key, says why, and never echoes the key')
