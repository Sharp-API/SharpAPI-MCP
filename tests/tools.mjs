// Every tool, driven through the built stdio bin against a fake API: which
// route each one calls and with which query, that answers are compact JSON,
// and that the three unpaged tools narrow and cut an oversized answer while a
// paginated tool is returned whole.
//
// The table below is the list of tools. It is written out here, not read from
// src/tools.ts: tools/list and the README's table are both checked against it,
// so a tool added in one place and not the others fails.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'

// [tool, arguments, route, query the API must receive]
const CALLS = [
  ['list_sports', {}, '/api/v1/sports', {}],
  ['list_sportsbooks', {}, '/api/v1/sportsbooks', {}],
  // `live` and `event` are this server's argument names; the API's current
  // spellings are is_live and event_id, and those are what must be sent.
  ['list_events', { sport: 'football', league: 'nfl', live: true, date: '2026-09-08', limit: 5 }, '/api/v1/events', { sport: 'football', league: 'nfl', is_live: 'true', date: '2026-09-08', limit: '5' }],
  ['get_odds', { league: 'nfl', event: 'ev1', sportsbook: 'draftkings', market: 'moneyline', live: false, limit: 5, cursor: 'c1', player_name: 'A B' }, '/api/v1/odds', { league: 'nfl', event_id: 'ev1', sportsbook: 'draftkings', market: 'moneyline', is_live: 'false', limit: '5', cursor: 'c1', player_name: 'A B' }],
  ['get_best_odds', { sport: 'football', event: 'ev1', market: 'moneyline', limit: 5 }, '/api/v1/odds/best', { sport: 'football', event_id: 'ev1', market: 'moneyline', limit: '5' }],
  ['get_arbitrage', { league: 'nfl', min_profit: 1.5, limit: 5 }, '/api/v1/opportunities/arbitrage', { league: 'nfl', min_profit: '1.5', limit: '5' }],
  ['get_ev', { league: 'nfl', min_ev: 2, sportsbook: 'draftkings', limit: 5 }, '/api/v1/opportunities/ev', { league: 'nfl', min_ev: '2', sportsbook: 'draftkings', limit: '5' }],
  ['get_middles', { market: 'point_spread', min_size: 1, sort: 'quality', limit: 5 }, '/api/v1/opportunities/middles', { market: 'point_spread', min_size: '1', sort: 'quality', limit: '5' }],
  ['get_event_odds', { event_id: 'ev 1/x', sportsbook: 'draftkings' }, '/api/v1/events/ev%201%2Fx/odds', { sportsbook: 'draftkings' }],
  ['get_splits', { league: 'nba', sportsbook: 'consensus', limit: 200, offset: 20 }, '/api/v1/splits', { league: 'nba', sportsbook: 'consensus', limit: '200', offset: '20' }],
  ['get_leagues', { sport: 'football' }, '/api/v1/leagues', { sport: 'football' }],
  ['get_markets', { league: 'nfl', sport: 'football' }, '/api/v1/markets', { league: 'nfl', sport: 'football' }],
  ['get_market_types', {}, '/api/v1/market-types', {}],
  // include_removed is the tool's own switch: it is not part of the query.
  ['get_odds_delta', { since: '2026-05-06T19:30:00Z', league: 'nba', event_id: 'ev1', market: 'moneyline', market_segment: '1st_half', live: true, limit: 500, offset: 50, include_removed: true }, '/api/v1/odds/delta', { since: '2026-05-06T19:30:00Z', league: 'nba', event_id: 'ev1', market: 'moneyline', market_segment: '1st_half', is_live: 'true', limit: '500', offset: '50' }],
  // `market` is narrowed by the tool on these two routes and never sent.
  ['compare_odds', { event_id: 'ev1', market: 'moneyline', market_segment: 'full_game' }, '/api/v1/odds/comparison', { event_id: 'ev1', market_segment: 'full_game' }],
  ['get_closing_lines', { event_id: 'ev1', sportsbook: 'draftkings', market: 'moneyline' }, '/api/v1/odds/closing', { event_id: 'ev1', sportsbook: 'draftkings' }],
  ['get_futures', { league: 'nfl', sport: 'football', future_type: 'TEAM', future_id: 'nfl__mvp_winner' }, '/api/v1/futures', { league: 'nfl', sport: 'football', future_type: 'TEAM', future_id: 'nfl__mvp_winner' }],
  ['get_futures_odds', { future_id: 'nfl__mvp_winner', sportsbook: 'draftkings,fanduel', team_id: 't', selection: 'A B', is_main: true, limit: 200, offset: 2 }, '/api/v1/futures/odds', { future_id: 'nfl__mvp_winner', sportsbook: 'draftkings,fanduel', team_id: 't', selection: 'A B', is_main: 'true', limit: '200', offset: '2' }],
  ['compare_futures_lines', { future_id: 'nfl__mvp_winner', selection: 'A B', is_main: false }, '/api/v1/futures/odds', { future_id: 'nfl__mvp_winner', selection: 'A B', is_main: 'false' }],
  ['find_low_hold', { sport: 'football', league: 'nfl', live: true, limit: 200 }, '/api/v1/opportunities/low_hold', { sport: 'football', league: 'nfl', is_live: 'true', limit: '200' }],
  ['get_account_info', {}, '/api/v1/account', {}],
]
const TOOLS = CALLS.map((c) => c[0])

// ---- the fake API: records each request, answers from `canned` by path
const seen = []
const canned = new Map()
const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), raw: req.url })
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(canned.get(url.pathname) ?? { data: [{ id: 'row' }], updated_at: 't' }))
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))

const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, SHARPAPI_KEY: 'test-key', SHARPAPI_BASE_URL: `http://127.0.0.1:${api.address().port}` },
})
const timer = setTimeout(() => { proc.kill(); console.error('FAIL: no answer within 30s'); process.exit(1) }, 30_000)

const replies = new Map()
let buf = ''
proc.stdout.on('data', (d) => {
  buf += d
  for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i))
    replies.set(msg.id, msg)
  }
})
let nextId = 1
const ask = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'ci-tools', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } } }) + '\n')
  const tick = setInterval(() => replies.has(id) && (clearInterval(tick), resolve(replies.get(id))), 10)
})
// One tool call: the result's text, and the request the API received for it.
async function call(name, args) {
  seen.length = 0
  const reply = await ask('tools/call', { name, arguments: args })
  assert.equal(reply.error, undefined, `${name}: ${JSON.stringify(reply.error)}`)
  assert.notEqual(reply.result.isError, true, `${name}: ${reply.result.content?.[0]?.text}`)
  assert.equal(seen.length, 1, `${name} made ${seen.length} API requests, not 1`)
  return { text: reply.result.content[0].text, request: seen[0] }
}

// ---- tools/list is exactly the table, and so is the README's table
const list = await ask('tools/list')
assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [...TOOLS].sort())
assert.equal(new Set(TOOLS).size, TOOLS.length, 'a tool is listed twice in CALLS')
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
const documented = [...readme.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1])
assert.deepEqual([...documented].sort(), [...TOOLS].sort(), 'README.md tools table and tools/list differ')

// ---- every tool calls its route with its arguments under the API's names
for (const [name, args, route, query] of CALLS) {
  const { text, request } = await call(name, args)
  assert.equal(request.raw.split('?')[0], route, `${name} route`)
  assert.deepEqual(request.query, query, `${name} query`)
  // Compact JSON: one line, no indentation.
  assert.equal(text, JSON.stringify(JSON.parse(text)), `${name} answer is not compact JSON`)
}
// Stated once more as a rule over every call above: the two deprecated
// spellings never reach the API.
for (const [name, args] of CALLS) {
  const { request } = await call(name, args)
  assert.ok(!('event' in request.query) && !('live' in request.query), `${name} sent a deprecated spelling: ${request.raw}`)
}

// ---- an input the schema forbids is refused before the API is called
seen.length = 0
for (const [name, args] of [['find_low_hold', { limit: 201 }], ['get_futures_odds', { league: 'nfl', limit: 201 }], ['get_odds_delta', { since: 't', limit: 501 }], ['get_odds_delta', {}], ['compare_odds', {}], ['get_closing_lines', {}], ['compare_futures_lines', {}]]) {
  const bad = await ask('tools/call', { name, arguments: args })
  assert.ok(bad.error || bad.result?.isError, `${name} accepted ${JSON.stringify(args)}`)
}
assert.equal(seen.length, 0, 'a refused call reached the API')

// ---- unpaged tools: an oversized answer is cut to its first rows, with a note
const MAX = 100_000
const fat = (i, market_type) => ({ id: i, market_type, sportsbook: 'draftkings', pad: 'x'.repeat(400) })
const many = (n, market_type = 'moneyline') => Array.from({ length: n }, (_, i) => fat(i, market_type))

canned.set('/api/v1/events/ev1/odds', { data: many(5000), updated_at: 't' })
let out = JSON.parse((await call('get_event_odds', { event_id: 'ev1' })).text)
assert.ok(Buffer.byteLength(JSON.stringify({ data: out.data })) <= MAX, 'get_event_odds rows exceed the budget')
assert.ok(out.data.length > 100 && out.data.length < 5000, `kept ${out.data.length} rows`)
assert.deepEqual(out.data.slice(0, 3).map((r) => r.id), [0, 1, 2])
assert.deepEqual(out.truncated.lists, [{ path: 'data', kept: out.data.length, total: 5000 }])
assert.match(out.truncated.narrow, /sportsbook/)
assert.equal(out.updated_at, 't')
// A small answer from the same tool is returned whole, with no note.
canned.set('/api/v1/events/ev1/odds', { data: many(3), updated_at: 't' })
out = JSON.parse((await call('get_event_odds', { event_id: 'ev1' })).text)
assert.deepEqual(out, { data: many(3), updated_at: 't' })

// compare_odds: the market is narrowed by the tool, then the answer is cut.
const comparison = [...many(3000, '1st_half_moneyline'), ...many(2, 'moneyline'), ...many(3000, 'point_spread')]
canned.set('/api/v1/odds/comparison', { data: comparison, pagination: { count: comparison.length } })
out = JSON.parse((await call('compare_odds', { event_id: 'ev1', market: 'moneyline' })).text)
assert.deepEqual(out.data, many(2, 'moneyline'), '"moneyline" must return the two moneyline rows only')
assert.equal(out.pagination.count, 2, 'pagination.count still counts the rows that were filtered out')
assert.equal(out.truncated, undefined)
out = JSON.parse((await call('compare_odds', { event_id: 'ev1', market: 'spread' })).text)
assert.deepEqual(out.data, [])
assert.deepEqual(out.available_markets, ['1st_half_moneyline', 'moneyline', 'point_spread'])
out = JSON.parse((await call('compare_odds', { event_id: 'ev1' })).text)
assert.ok(out.data.length < comparison.length && Buffer.byteLength(JSON.stringify({ data: out.data })) <= MAX)
assert.deepEqual(out.truncated.lists, [{ path: 'data', kept: out.data.length, total: comparison.length }])
assert.match(out.truncated.narrow, /market/)

// get_closing_lines: books keyed by name; narrowed by market, then every book cut alike.
canned.set('/api/v1/odds/closing', { success: true, data: { event_id: 'ev1', books: {
  draftkings: { odds: [...many(2000, 'point_spread'), ...many(1, 'moneyline')] },
  fanduel: { odds: many(1000, 'point_spread') },
} } })
out = JSON.parse((await call('get_closing_lines', { event_id: 'ev1', market: 'moneyline' })).text)
assert.deepEqual(out.data.books, { draftkings: { odds: many(1, 'moneyline') } })
assert.equal(out.truncated, undefined)
out = JSON.parse((await call('get_closing_lines', { event_id: 'ev1' })).text)
assert.ok(Buffer.byteLength(JSON.stringify({ data: out.data })) <= MAX)
assert.deepEqual(out.truncated.lists.map((l) => [l.path, l.total]), [['data.books.draftkings.odds', 2001], ['data.books.fanduel.odds', 1000]])
assert.ok(out.data.books.draftkings.odds.length > out.data.books.fanduel.odds.length && out.data.books.fanduel.odds.length >= 1)

// ---- get_odds_delta leaves the removed list out unless asked, and never touches the page
const removed = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), sportsbook: 'draftkings', removed_at: 't' }))
canned.set('/api/v1/odds/delta', { data: many(3), pagination: { has_more: true, next_offset: 3 }, removed, removed_truncated: true })
out = JSON.parse((await call('get_odds_delta', { since: '2026-05-06T19:30:00Z' })).text)
assert.deepEqual(out, { data: many(3), pagination: { has_more: true, next_offset: 3 }, removed_truncated: true, removed_count: 1000 })
out = JSON.parse((await call('get_odds_delta', { since: '2026-05-06T19:30:00Z', include_removed: true })).text)
assert.equal(out.removed.length, 1000)
assert.equal(out.removed_count, undefined)

// ---- a paginated tool is never cut: its cursor would skip the dropped rows
canned.set('/api/v1/odds', { data: many(5000), pagination: { has_more: true, next_cursor: 'c2' } })
out = JSON.parse((await call('get_odds', { limit: 500 })).text)
assert.equal(out.data.length, 5000, 'a paginated answer was cut')
assert.equal(out.truncated, undefined)

clearTimeout(timer)
proc.kill()
api.close()
console.log(`PASS: all ${TOOLS.length} tools call their routes, answer in compact JSON, and only the unpaged ones are cut`)
