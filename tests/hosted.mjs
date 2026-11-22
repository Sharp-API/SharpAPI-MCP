// The hosted relay (dist/hosted.js) against a fake SharpAPI upstream.
//
// Every abuse control in src/hosted.ts gets a case here, and each case also
// asserts what reached the upstream, because "refused" means "never
// forwarded", not just "answered with an error".
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import http from 'node:http'
import { addressBucket, createHostedServer } from '../dist/hosted.js'

const GOOD = 'sk_test_GOOD_0123456789abcdef'
const BAD = 'sk_test_BAD_0123456789'
const ECHO = 'sk_test_ECHO_0123456789'
const FLAKY = 'sk_test_FLAKY_0123456789'

// ---- fake upstream: records every request it receives
const upstream = []
const api = http.createServer((req, res) => {
  const key = req.headers['x-api-key']
  upstream.push({ url: req.url, key, ip: req.headers['x-real-ip'], ua: req.headers['user-agent'] })
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  if (key === BAD) return send(401, { error: { message: 'Invalid API key', code: 'invalid_api_key' } })
  if (key === ECHO) return send(400, { error: { message: `rejected key ${ECHO} for this call`, code: 'validation_error' } })
  if (key === FLAKY) return send(502, { error: { message: 'bad gateway' } })
  if (req.url.includes('market=slow')) return setTimeout(() => send(200, { data: ['slow'] }), 400)
  send(200, { data: [{ book: 'draftkings', price: -110 }] })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))

const logs = []
const relay = createHostedServer({
  baseUrl: `http://127.0.0.1:${api.address().port}`,
  allowedHosts: ['127.0.0.1'],
  allowedOrigins: ['allowed.example'],
  maxInflightPerKey: 1,
  authFailLimit: 3,
  log: (l) => logs.push(l),
})
await new Promise((r) => relay.listen(0, '127.0.0.1', r))
const port = relay.address().port

// Raw node:http, so Host and every other header are exactly what the test says.
function request({ method = 'POST', path = '/mcp', headers = {}, body }) {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    }, (res) => {
      let text = ''
      res.on('data', (d) => { text += d })
      res.on('end', () => {
        // The legacy leg answers as one SSE event; the modern leg as plain JSON.
        const json = text.startsWith('event:') ? JSON.parse(text.split('\ndata: ')[1]) : text ? JSON.parse(text) : undefined
        resolve({ status: res.statusCode, headers: res.headers, json, text })
      })
    })
    req.on('error', reject)
    if (data !== undefined) req.write(data)
    req.end()
  })
}

const META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'hosted-test', version: '2.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const modern = (method, params = {}, name) => ({
  body: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: META } },
  headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method, ...(name ? { 'Mcp-Name': name } : {}) },
})
const callTool = (key, name, args = {}, extra = {}) => {
  const m = modern('tools/call', { name, arguments: args }, name)
  return request({ body: m.body, headers: { ...m.headers, 'X-API-Key': key, ...extra } })
}

// ---- both protocol eras on one URL
const init = await request({
  headers: { 'X-API-Key': GOOD },
  body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } },
})
assert.equal(init.status, 200)
assert.equal(init.json.result.serverInfo.name, 'sharpapi')

const disc = modern('server/discover')
const discover = await request({ body: disc.body, headers: { ...disc.headers, Authorization: `Bearer ${GOOD}` } })
assert.equal(discover.status, 200)
assert.deepEqual(discover.json.result.supportedVersions, ['2026-07-28'])
assert.equal(discover.json.result.cacheScope, 'public')

const list = modern('tools/list')
const tools = await request({ body: list.body, headers: { ...list.headers, 'X-API-Key': GOOD } })
assert.deepEqual(tools.json.result.tools.map((t) => t.name), [
  'list_sports', 'list_sportsbooks', 'list_events', 'get_odds', 'get_best_odds',
  'get_arbitrage', 'get_ev', 'get_middles', 'get_event_odds', 'get_splits',
  'get_leagues', 'get_markets', 'get_market_types', 'get_odds_delta', 'compare_odds',
  'get_closing_lines', 'get_futures', 'get_futures_odds', 'compare_futures_lines',
  'find_low_hold', 'get_account_info',
])
assert.equal(tools.json.result.cacheScope, 'public')
assert.equal(upstream.length, 0, 'handshake and listing must not call the API')

// ---- a tool call goes upstream once, with the caller's key, address and our User-Agent
const ok = await callTool(GOOD, 'get_odds', { player_name: 'ARG_SECRET_VALUE' }, { 'X-Real-IP': '203.0.113.7' })
assert.equal(ok.status, 200)
assert.match(ok.json.result.content[0].text, /draftkings/)
assert.deepEqual(upstream, [{
  url: '/api/v1/odds?player_name=ARG_SECRET_VALUE', key: GOOD, ip: '203.0.113.7', ua: 'sharpapi-mcp/0.1.1 (hosted)',
}])
const line = JSON.parse(logs.at(-1))
assert.deepEqual(
  { ip: line.ip, key_id: line.key_id, method: line.method, tool: line.tool, client: line.client, upstream: line.upstream, status: line.status },
  { ip: '203.0.113.7', key_id: GOOD.slice(0, 12), method: 'tools/call', tool: 'get_odds', client: 'hosted-test', upstream: 200, status: 200 },
)

// A short key is never logged whole: at most half of it.
await callTool('sk_short01', 'list_sports')
assert.equal(JSON.parse(logs.at(-1)).key_id, 'sk_sh')

// ---- get_splits reads /api/v1/splits with its arguments as the query
upstream.length = 0
const splits = await callTool(GOOD, 'get_splits', { league: 'nba', sportsbook: 'consensus', market: 'spread', limit: 200, offset: 20 })
assert.equal(splits.json.result.isError, undefined, splits.text)
assert.deepEqual(upstream.map((u) => u.url), ['/api/v1/splits?league=nba&sportsbook=consensus&market=spread&limit=200&offset=20'])
// A page over the API's 200-row cap is refused before the API.
const tooBig = await callTool(GOOD, 'get_splits', { limit: 201 })
assert.ok(tooBig.json.error || tooBig.json.result?.isError, 'get_splits accepted limit 201')
assert.equal(upstream.length, 1, 'a get_splits call over the 200-row cap reached the API')

// ---- no retries: one 502 is one upstream call and an error result
upstream.length = 0
const flaky = await callTool(FLAKY, 'list_sports')
assert.equal(flaky.json.result.isError, true)
assert.equal(upstream.length, 1, 'the relay must not retry, or it multiplies a user\'s traffic')

// ---- an upstream error that quotes the key back is redacted
const echo = await callTool(ECHO, 'list_sports')
assert.ok(!echo.text.includes(ECHO), 'the key came back in a tool result')
assert.match(echo.json.result.content[0].text, /\[redacted SHARPAPI_KEY\]/)

// ---- refused requests: right status, and nothing forwarded
upstream.length = 0
// Each case is a valid tool call apart from the one defect under test, so a
// control that stopped working would answer 200 and call the API.
const call = modern('tools/call', { name: 'list_sports', arguments: {} }, 'list_sports')
const valid = (headers = {}, extra = {}) => ({ body: call.body, headers: { ...call.headers, 'X-API-Key': GOOD, ...headers }, ...extra })
const cases = [
  ['no credential', { body: call.body, headers: call.headers }, 401],
  ['key in the query string', valid({}, { path: `/mcp?api_key=${GOOD}` }), 400],
  ['two different keys', valid({ Authorization: `Bearer ${ECHO}` }), 400],
  ['unlisted Origin', valid({ Origin: 'https://evil.example' }), 403],
  ['unlisted Host', valid({ Host: 'evil.example' }), 403],
  ['GET', valid({}, { method: 'GET', body: undefined }), 405],
  ['other path', valid({}, { path: '/' }), 404],
  ['body over 64 KiB', valid({}, { body: { ...call.body, params: { ...call.body.params, pad: 'x'.repeat(65 * 1024) } } }), 413],
  ['not JSON', valid({}, { body: '{not json' }), 400],
]
for (const [name, req, status] of cases) {
  const r = await request(req)
  assert.equal(r.status, status, `${name}: expected ${status}, got ${r.status} ${r.text}`)
}
assert.equal((await request(cases[0][1])).headers['www-authenticate'], 'Bearer realm="SharpAPI"')
assert.equal(upstream.length, 0, 'a refused request reached the API')
assert.equal((await request(valid())).status, 200, 'the valid base request must pass')
assert.equal((await request(valid({ Origin: 'https://allowed.example' }))).status, 200, 'a listed Origin must pass')
assert.equal(upstream.length, 2)
upstream.length = 0
for (const l of logs) assert.ok(!l.includes(GOOD) && !l.includes('ARG_SECRET_VALUE'), `log line leaks: ${l}`)

// ---- a key the API rejected is not forwarded again
const first = await callTool(BAD, 'list_sports', {}, { 'X-Real-IP': '198.51.100.20' })
assert.equal(first.json.result.isError, true)
assert.equal(upstream.length, 1)
const again = await callTool(BAD, 'list_sports', {}, { 'X-Real-IP': '198.51.100.21' })
assert.equal(again.status, 401)
assert.equal(upstream.length, 1, 'a key the API just rejected was forwarded again')

// ---- rejected keys are capped per address (limit 3 here), and only for that address
for (let i = 0; i < 3; i++) await callTool('bad key with spaces', 'list_sports', {}, { 'X-Real-IP': '198.51.100.9' })
const capped = await callTool(GOOD, 'list_sports', {}, { 'X-Real-IP': '198.51.100.9' })
assert.equal(capped.status, 429)
assert.ok(Number(capped.headers['retry-after']) > 0)
assert.equal((await callTool(GOOD, 'list_sports', {}, { 'X-Real-IP': '198.51.100.10' })).status, 200)

// ---- concurrency per key (limit 1 here)
const [a, b] = await Promise.all([callTool(GOOD, 'get_odds', { market: 'slow' }), callTool(GOOD, 'get_odds', { market: 'slow' })])
assert.deepEqual([a.status, b.status].sort(), [200, 429])

// ---- IPv6 is bucketed by /64, so one host cannot dodge the cap by rotating addresses
assert.equal(addressBucket('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64')
assert.equal(addressBucket('2001:db8:1:2::9'), '2001:db8:1:2::/64')
assert.equal(addressBucket('2001:db8::1'), '2001:db8:0:0::/64')
assert.equal(addressBucket('::ffff:192.0.2.1'), '192.0.2.1')
assert.equal(addressBucket('192.0.2.1'), '192.0.2.1')

relay.close()
api.close()

// ---- the service refuses to start holding a shared key, or with no upstream
const start = (env) => spawnSync('node', ['dist/http.js'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 10_000 })
const shared = start({ SHARPAPI_KEY: GOOD, SHARPAPI_BASE_URL: 'http://127.0.0.1:1' })
assert.equal(shared.status, 1)
assert.match(shared.stderr, /must not hold a key/)
assert.ok(!shared.stderr.includes(GOOD))
const noBase = start({})
assert.equal(noBase.status, 1)
assert.match(noBase.stderr, /SHARPAPI_BASE_URL/)

console.log('PASS: hosted relay serves both eras, forwards only the caller\'s key, and refuses every abuse case')
