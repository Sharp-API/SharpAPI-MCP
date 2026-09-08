// Drive one real MCP handshake over stdio against the built server.
//
// The point is not coverage. It is that `tsc` succeeding proves the code
// compiles, not that the server starts, registers its tools and answers the
// protocol. A malformed tool schema or a bad import only shows up here.
//
// No network: the handshake and tools/list never call SharpAPI, so this runs
// with a dummy key.
import { spawn } from 'node:child_process'

const EXPECTED = [
  'list_sports', 'list_sportsbooks', 'list_events', 'get_odds',
  'get_best_odds', 'get_arbitrage', 'get_ev', 'get_middles',
]

const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, SHARPAPI_KEY: process.env.SHARPAPI_KEY || 'test-key' },
})

let stderr = ''
proc.stderr.on('data', (d) => { stderr += d.toString() })

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n')

const responses = new Map()
let buf = ''
proc.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined) responses.set(msg.id, msg)
    } catch {
      fail(`stdout carried a non-JSON line, which corrupts the MCP stream: ${line.slice(0, 200)}`)
    }
  }
})

function fail(why) {
  console.error('FAIL:', why)
  if (stderr) console.error('server stderr:\n' + stderr)
  proc.kill()
  process.exit(1)
}

const waitFor = (id, ms = 15000) => new Promise((resolve) => {
  const t0 = Date.now()
  const tick = setInterval(() => {
    if (responses.has(id)) { clearInterval(tick); resolve(responses.get(id)) }
    else if (Date.now() - t0 > ms) { clearInterval(tick); fail(`timed out waiting for response id=${id}`) }
  }, 50)
})

send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'ci-handshake', version: '1.0.0' },
  },
})

const init = await waitFor(1)
if (init.error) fail(`initialize returned an error: ${JSON.stringify(init.error)}`)
if (init.result?.serverInfo?.name !== 'sharpapi') {
  fail(`unexpected serverInfo: ${JSON.stringify(init.result?.serverInfo)}`)
}
console.log('initialize ok:', JSON.stringify(init.result.serverInfo))

send({ jsonrpc: '2.0', method: 'notifications/initialized' })
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

const list = await waitFor(2)
if (list.error) fail(`tools/list returned an error: ${JSON.stringify(list.error)}`)
const names = (list.result?.tools ?? []).map((t) => t.name).sort()
console.log(`tools/list returned ${names.length}:`, names.join(', '))

const missing = EXPECTED.filter((n) => !names.includes(n))
if (missing.length) fail(`tools missing from tools/list: ${missing.join(', ')}`)

// Every tool must carry a description; an undescribed tool is unusable to a model.
const undescribed = (list.result.tools ?? []).filter((t) => !t.description || t.description.length < 20)
if (undescribed.length) fail(`tools with a missing or trivial description: ${undescribed.map((t) => t.name).join(', ')}`)

console.log('PASS: server starts, handshakes, and registers all expected tools')
proc.kill()
process.exit(0)
