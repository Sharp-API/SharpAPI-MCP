// The stdio bin on the 2026-07-28 revision: a client that opens with
// `server/discover` instead of `initialize`. handshake.mjs covers the 2025-era
// opening on the same bin; together they show serveStdio answers both eras.
// A tool call then goes to a fake API, which answers 502 once: stdio keeps the
// retry on 502/503/504 that the old HTTP client had (the hosted relay does not).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'

const seen = []
const api = http.createServer((req, res) => {
  seen.push({ url: req.url, key: req.headers['x-api-key'], ua: req.headers['user-agent'] })
  res.writeHead(seen.length === 1 ? 502 : 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(seen.length === 1 ? {} : { data: [{ id: 'baseball' }] }))
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))

const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, SHARPAPI_KEY: 'test-key', SHARPAPI_BASE_URL: `http://127.0.0.1:${api.address().port}` },
})
const timer = setTimeout(() => { proc.kill(); console.error('FAIL: no answer within 15s'); process.exit(1) }, 15_000)

const replies = new Map()
let buf = ''
proc.stdout.on('data', (d) => {
  buf += d
  for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i))
    replies.set(msg.id, msg)
  }
})
const ask = (id, method, params = {}) => new Promise((resolve) => {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'ci-discover', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } } }) + '\n')
  const tick = setInterval(() => replies.has(id) && (clearInterval(tick), resolve(replies.get(id))), 20)
})

const discover = await ask(1, 'server/discover')
assert.equal(discover.error, undefined, JSON.stringify(discover.error))
assert.deepEqual(discover.result.supportedVersions, ['2026-07-28'])
assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'sharpapi')
// No change notifications: the tool list is fixed per release.
assert.deepEqual(discover.result.capabilities.tools, { listChanged: false })

const list = await ask(2, 'tools/list')
assert.equal(list.result.tools.length, 9)
assert.equal(list.result.cacheScope, 'public')
assert.ok(list.result.ttlMs > 0)
assert.ok(list.result.tools.every((t) => t.annotations?.readOnlyHint === true), 'every tool is read-only')

const call = await ask(3, 'tools/call', { name: 'list_sports', arguments: {} })
assert.match(call.result.content[0].text, /baseball/)
assert.deepEqual(seen.map((s) => s.url), ['/api/v1/sports', '/api/v1/sports'], 'one retry after the 502')
assert.ok(seen.every((s) => s.key === 'test-key' && s.ua === 'sharpapi-mcp/0.1.1 (stdio)'))

clearTimeout(timer)
proc.kill()
api.close()
console.log('PASS: stdio answers server/discover, a cacheable tools/list and a tool call on 2026-07-28')
