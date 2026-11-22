// The answer-size helpers in src/fit.ts, on their own: what they keep, what
// they cut and what they say about it. tests/tools.mjs then drives the same
// code through the real tools.
import assert from 'node:assert/strict'
import { closingForMarkets, comparisonForMarkets, deltaWithoutRemoved, fitResult, fitToBytes, pickMarkets } from '../dist/fit.js'

const size = (v) => Buffer.byteLength(JSON.stringify(v))
const row = (i, market_type = 'moneyline') => ({ id: i, market_type, note: 'x'.repeat(80) })
const rows = (n, market_type) => Array.from({ length: n }, (_, i) => row(i, market_type))

// ---- an answer that fits is returned as the same object, untouched
const small = { data: rows(3), updated_at: 't' }
const before = JSON.stringify(small)
assert.equal(fitResult(small, 10_000, 'narrow it'), small)
assert.equal(JSON.stringify(small), before)

// ---- a long `data` list is cut to its FIRST rows, fits, and says so
const big = { data: rows(1000), updated_at: 't' }
assert.ok(size(big) > 10_000)
const cut = fitResult(big, 10_000, 'pass sportsbook')
assert.ok(size(cut.data) <= 10_000, 'the cut list is within the budget')
assert.ok(cut.data.length > 1 && cut.data.length < 1000)
assert.deepEqual(cut.data.map((r) => r.id), cut.data.map((_, i) => i), 'the rows kept are the leading rows, in order')
assert.equal(cut.updated_at, 't', 'the rest of the answer is kept')
assert.deepEqual(cut.truncated.lists, [{ path: 'data', kept: cut.data.length, total: 1000 }])
assert.equal(cut.truncated.narrow, 'pass sportsbook')
assert.match(cut.truncated.reason, /10000 bytes/)
// The note rides on top of the budget; it stays small.
assert.ok(size(cut) - size({ data: cut.data, updated_at: 't' }) < 400)

// ---- a top-level list is wrapped so the note has somewhere to go
const bare = fitResult(rows(1000), 10_000, 'n')
assert.ok(Array.isArray(bare.data) && bare.data.length < 1000)
assert.deepEqual(bare.truncated.lists, [{ path: 'data', kept: bare.data.length, total: 1000 }])
// (the path is the list's own, '', before wrapping; it is reported as written)
const bareCuts = fitToBytes(rows(1000), 10_000)
assert.equal(bareCuts.cuts[0].path, '')

// ---- the closing-line shape: every book is cut by the same factor, none dropped
const closing = { data: { event_id: 'e', books: { a: { odds: rows(400) }, b: { odds: rows(200) }, c: { odds: rows(2) } } } }
const closed = fitResult(closing, 12_000, 'n')
assert.ok(size({ data: closed.data }) <= 12_000)
assert.deepEqual(Object.keys(closed.data.books), ['a', 'b', 'c'])
const kept = Object.fromEntries(Object.entries(closed.data.books).map(([k, v]) => [k, v.odds.length]))
assert.ok(kept.a >= 1 && kept.b >= 1 && kept.c >= 1, 'no book loses every row')
assert.ok(kept.a > kept.b && kept.b > kept.c, `longer lists keep more rows: ${JSON.stringify(kept)}`)
assert.deepEqual(closed.truncated.lists.map((l) => [l.path, l.total]), [
  ['data.books.a.odds', 400], ['data.books.b.odds', 200], ['data.books.c.odds', 2],
])
for (const l of closed.truncated.lists) assert.equal(l.kept, closed.data.books[l.path.split('.')[2]].odds.length)

// ---- one oversized row: its inner list is cut, the row is not left whole
const nested = { data: [{ id: 'future', odds: rows(500) }] }
const inner = fitResult(nested, 8_000, 'n')
assert.equal(inner.data.length, 1)
assert.ok(inner.data[0].odds.length < 500 && size({ data: inner.data }) <= 8_000)
assert.deepEqual(inner.truncated.lists, [{ path: 'data[0].odds', kept: inner.data[0].odds.length, total: 500 }])

// ---- a list cut over several passes still reports its ORIGINAL length
// (rows of uneven size: the first rows are the big ones, so one pass is not enough)
const uneven = { data: [...Array.from({ length: 50 }, (_, i) => ({ id: i, pad: 'y'.repeat(2000) })), ...rows(950)] }
const twice = fitResult(uneven, 20_000, 'n')
assert.ok(size({ data: twice.data }) <= 20_000)
assert.deepEqual(twice.truncated.lists, [{ path: 'data', kept: twice.data.length, total: 1000 }])

// ---- nothing to shorten: the answer is withheld, never returned oversized
const blob = fitResult({ data: { text: 'z'.repeat(50_000) } }, 10_000, 'ask for less')
assert.deepEqual(Object.keys(blob), ['truncated'])
assert.equal(blob.truncated.narrow, 'ask for less')
assert.ok(size(blob) < 1_000)
assert.deepEqual(fitToBytes({ data: { text: 'z'.repeat(50_000) } }, 10_000), { cuts: [], fits: false })

// ---- pickMarkets: whole-id match, case-insensitive, several ids, and what was available
const mixed = [row(1, 'moneyline'), row(2, '1st_half_moneyline'), row(3, 'point_spread'), row(4, 'Moneyline'), { id: 5 }]
assert.deepEqual(pickMarkets(mixed, 'moneyline').rows.map((r) => r.id), [1, 4], '"moneyline" must not match "1st_half_moneyline"')
assert.deepEqual(pickMarkets(mixed, ' point_spread , MONEYLINE ').rows.map((r) => r.id), [1, 3, 4])
assert.deepEqual(pickMarkets(mixed, 'spread'), { rows: [], available: ['1st_half_moneyline', 'Moneyline', 'moneyline', 'point_spread'] })
// A row with no market_type never matches, not even an empty filter value.
assert.deepEqual(pickMarkets(mixed, ',').rows, [])

// ---- comparisonForMarkets
const comparison = { data: mixed, pagination: { count: 5 } }
assert.equal(comparisonForMarkets(comparison, undefined), comparison, 'no market asked: untouched')
// pagination.count is restated for the rows kept; the rest of pagination is kept as sent.
assert.deepEqual(comparisonForMarkets(comparison, 'point_spread'), { data: [mixed[2]], pagination: { count: 1 } })
assert.deepEqual(comparisonForMarkets({ data: mixed, pagination: { limit: 0, count: 5, has_more: false } }, 'moneyline').pagination, { limit: 0, count: 2, has_more: false })
assert.deepEqual(comparisonForMarkets({ data: mixed }, 'moneyline'), { data: [mixed[0], mixed[3]] }, 'no pagination sent: none invented')
assert.equal(comparison.pagination.count, 5, 'the input is not changed')
assert.deepEqual(comparisonForMarkets(comparison, 'spread').available_markets, ['1st_half_moneyline', 'Moneyline', 'moneyline', 'point_spread'])
assert.deepEqual(comparisonForMarkets(comparison, 'spread').data, [])
assert.equal(comparisonForMarkets({ error: 'odd shape' }, 'moneyline').error, 'odd shape')

// ---- closingForMarkets: a book with no row in the market is left out
const lines = { success: true, data: { event_id: 'e', books: {
  a: { odds: [row(1, 'moneyline'), row(2, 'point_spread')] },
  b: { odds: [row(3, 'point_spread')] },
} } }
assert.equal(closingForMarkets(lines, undefined), lines)
assert.deepEqual(closingForMarkets(lines, 'moneyline'), { success: true, data: { event_id: 'e', books: { a: { odds: [row(1, 'moneyline')] } } } })
const none = closingForMarkets(lines, 'total_points')
assert.deepEqual(none.data.books, {})
assert.deepEqual(none.available_markets, ['moneyline', 'point_spread'])
// An event with no closing lines yet has no books: nothing to narrow, nothing said.
const empty = { success: true, data: { event_id: 'e', books: {} } }
assert.equal(closingForMarkets(empty, 'moneyline'), empty)

// ---- deltaWithoutRemoved: the removed list is dropped and counted; the page is untouched
const delta = { data: rows(2), pagination: { has_more: true, next_offset: 2 }, removed: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], removed_truncated: true }
assert.deepEqual(deltaWithoutRemoved(delta, undefined), { data: rows(2), pagination: { has_more: true, next_offset: 2 }, removed_truncated: true, removed_count: 3 })
assert.deepEqual(deltaWithoutRemoved(delta, false).removed_count, 3)
assert.equal(deltaWithoutRemoved(delta, true), delta, 'asked for: returned as the API sent it')
assert.equal(delta.removed.length, 3, 'the input is not changed')
// An empty list is still counted, as zero; an answer with no list says nothing.
assert.deepEqual(deltaWithoutRemoved({ data: [], removed: [] }, undefined), { data: [], removed_count: 0 })
assert.deepEqual(deltaWithoutRemoved({ data: [] }, undefined), { data: [] })

console.log('PASS: oversized answers are cut to their first rows with a note, and market narrowing matches whole ids')
