/**
 * Keeping answers small enough for an assistant to read.
 *
 * Three routes answer with everything they hold for one event and take no
 * page size: /events/{id}/odds, /odds/comparison and /odds/closing. For a busy
 * game that is tens of megabytes. The tools on those routes (src/tools.ts)
 * narrow the answer by market here and then keep it within a byte budget.
 *
 * A page from a paginated route is never cut: that would leave its cursor
 * pointing past rows the caller never saw. The one paginated route handled
 * here, /odds/delta, keeps its page whole; see deltaWithoutRemoved.
 */

export interface Cut {
  /** Where the array sits in the answer: "data", "data.books.draftkings.odds". */
  path: string
  kept: number
  total: number
}

type Json = Record<string, unknown>

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v) ?? '')

/**
 * The arrays worth shortening: each array of two or more elements that is not
 * inside another such array. An array of one element is looked through, so
 * one oversized row is cut inside instead of being left whole.
 */
function outermost(node: unknown, path: string, out: { path: string; arr: unknown[] }[]) {
  if (Array.isArray(node)) {
    if (node.length > 1) out.push({ path, arr: node })
    else if (node.length === 1) outermost(node[0], `${path}[0]`, out)
  } else if (isRecord(node)) {
    for (const [k, v] of Object.entries(node)) outermost(v, path ? `${path}.${k}` : k, out)
  }
}

/**
 * Shorten the arrays in `value`, in place, until its JSON is at most
 * `maxBytes`. Every outermost array is cut by the same factor each pass, so
 * the books of a closing-line answer shrink together and none is dropped.
 * Returns what was cut. `fits` is false only when nothing was left to shorten.
 */
export function fitToBytes(value: unknown, maxBytes: number): { cuts: Cut[]; fits: boolean } {
  const cuts = new Map<string, Cut>()
  for (;;) {
    const size = bytes(value)
    if (size <= maxBytes) return { cuts: [...cuts.values()], fits: true }
    const arrays: { path: string; arr: unknown[] }[] = []
    outermost(value, '', arrays)
    if (!arrays.length) return { cuts: [...cuts.values()], fits: false }
    // size > maxBytes, so the factor is under 1 and floor() drops at least one
    // element from every array here (each has two or more). Each pass shortens
    // something, so the loop ends.
    const factor = maxBytes / size
    for (const { path, arr } of arrays) {
      const keep = Math.max(1, Math.floor(arr.length * factor))
      const cut = cuts.get(path) ?? { path, kept: arr.length, total: arr.length }
      cut.kept = keep
      cuts.set(path, cut)
      arr.length = keep
    }
  }
}

/**
 * `body` within `maxBytes`, with a `truncated` note when rows were dropped:
 * which arrays, how many rows each kept of how many, and `narrow`, the tool's
 * advice on asking for less. A body that already fits is returned unchanged.
 */
export function fitResult(body: unknown, maxBytes: number, narrow: string): unknown {
  const { cuts, fits } = fitToBytes(body, maxBytes)
  if (!fits) {
    return { truncated: { reason: `The answer is larger than ${maxBytes} bytes and has no list to shorten, so it is withheld.`, narrow } }
  }
  if (!cuts.length) return body
  const reason = `The full answer is larger than ${maxBytes} bytes. Each list below was cut to its first rows.`
  if (isRecord(body)) return { ...body, truncated: { reason, lists: cuts, narrow } }
  // A bare list is wrapped as `data` so the note has somewhere to go; its
  // paths ('' or '[0]...') are reported from the wrapper's point of view.
  return { data: body, truncated: { reason, lists: cuts.map((c) => ({ ...c, path: `data${c.path}` })), narrow } }
}

/**
 * Keep only the rows of the asked market types, for the two routes that do
 * not narrow by market themselves: /odds/comparison and /odds/closing.
 * `market` is one id or several
 * comma-separated; the match is on the row's `market_type`, whole and
 * case-insensitive. `available` lists the ids the rows did carry, for a caller
 * whose id matched nothing.
 */
export function pickMarkets(rows: unknown[], market: string): { rows: unknown[]; available: string[] } {
  const wanted = new Set(market.split(',').map((m) => m.trim().toLowerCase()).filter(Boolean))
  const seen = new Set<string>()
  const kept = rows.filter((row) => {
    const type = isRecord(row) && typeof row.market_type === 'string' ? row.market_type : ''
    if (type) seen.add(type)
    return wanted.has(type.toLowerCase())
  })
  return { rows: kept, available: [...seen].sort() }
}

/**
 * /odds/comparison: `data` is the list of rows, and `pagination.count` is how
 * many the route sent. The count is restated for the rows kept, so the answer
 * does not claim thousands of rows beside a handful.
 */
export function comparisonForMarkets(body: unknown, market: string | undefined): unknown {
  if (!market || !isRecord(body) || !Array.isArray(body.data)) return body
  const { rows, available } = pickMarkets(body.data, market)
  const out: Json = { ...body, data: rows }
  if (isRecord(body.pagination) && typeof body.pagination.count === 'number') {
    out.pagination = { ...body.pagination, count: rows.length }
  }
  if (!rows.length) out.available_markets = available
  return out
}

/** /odds/closing: `data.books` maps each sportsbook to `{ odds: [...] }`. */
export function closingForMarkets(body: unknown, market: string | undefined): unknown {
  if (!market || !isRecord(body) || !isRecord(body.data) || !isRecord(body.data.books)) return body
  const books: Json = {}
  const available = new Set<string>()
  let kept = 0
  let read = 0
  for (const [book, entry] of Object.entries(body.data.books)) {
    if (!isRecord(entry) || !Array.isArray(entry.odds)) {
      books[book] = entry
      continue
    }
    read++
    const picked = pickMarkets(entry.odds, market)
    for (const id of picked.available) available.add(id)
    kept += picked.rows.length
    // A book with no row in the asked markets is left out, not sent empty.
    if (picked.rows.length) books[book] = { ...entry, odds: picked.rows }
  }
  // No book in the shape this reads (an event with no closing lines has none):
  // there was nothing to narrow, so say nothing about markets.
  if (!read) return body
  const data = { ...body.data, books }
  return kept ? { ...body, data } : { ...body, data, available_markets: [...available].sort() }
}

/**
 * /odds/delta sends a `removed` list beside its page of changed rows: up to
 * 1,000 entries, about 150 kB, whatever the page size and filters. A caller
 * keeping a local copy in step needs it; one asking what moved does not. So it
 * is left out unless asked for, and `removed_count` says how many there were.
 * The page itself (`data`, `pagination`) is never touched.
 */
export function deltaWithoutRemoved(body: unknown, includeRemoved: boolean | undefined): unknown {
  if (includeRemoved || !isRecord(body) || !Array.isArray(body.removed)) return body
  const { removed, ...rest } = body
  return { ...rest, removed_count: removed.length }
}
