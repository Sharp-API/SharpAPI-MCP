/**
 * The SharpAPI MCP server, built by one factory that both entry points serve:
 * src/index.ts over stdio (the npm bin) and src/http.ts over Streamable HTTP
 * (the hosted relay). The tool list is identical for every caller; only the
 * key, and in hosted mode the caller's address, differ per instance.
 *
 * There is no way to pass a key as a tool argument, deliberately: tool
 * arguments are model-generated and end up in transcripts and logs.
 */
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { createApi } from './api.js'
import { closingForMarkets, comparisonForMarkets, deltaWithoutRemoved, fitResult } from './fit.js'
import { makeRedactor } from './redact.js'

export const SERVER_NAME = 'sharpapi'
// Keep equal to package.json's version, so a client reports the release it is
// actually running. tests/handshake.mjs checks it.
export const VERSION = '0.1.1'
export const DEFAULT_BASE_URL = 'https://api.sharpapi.io'

/**
 * The most JSON one of the unpaged tools returns: about one default page of
 * get_odds (50 rows). Three routes send everything they hold for an event and
 * take no page size, which for one busy game is tens of megabytes. See
 * src/fit.ts.
 */
export const MAX_UNPAGED_BYTES = 100_000

export interface SharpApiServerOptions {
  apiKey: string
  mode: 'stdio' | 'hosted'
  baseUrl?: string
  /** The end user's address, forwarded upstream as `X-Real-IP` (hosted). */
  clientIp?: string
  /** See ApiOptions.attempts: 3 for stdio, 1 for the hosted relay. */
  attempts?: number
  timeoutMs?: number
  /** Each upstream status, for the hosted relay's log and bad-key cache. */
  onStatus?: (status: number) => void
  /** Byte length of each tool result returned to the client. */
  onResult?: (bytes: number) => void
}

// Every tool only reads; none changes anything for the caller or anyone else.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true }

// The tool list is the same for every caller and changes only on a release,
// so a shared cache may hold it (2026-07-28 `ttlMs` / `cacheScope`).
const PUBLIC_HOUR = { ttlMs: 3_600_000, cacheScope: 'public' as const }

/**
 * Tool arguments as the API's query. `event` and `live` are argument names
 * this server has always had; the API now calls both spellings deprecated in
 * favor of `event_id` and `is_live`, so they are sent under the current
 * names and a published release does not rest on an alias.
 */
function query({ event, live, ...rest }: Record<string, unknown>): Record<string, unknown> {
  return {
    ...rest,
    ...(event !== undefined && { event_id: event }),
    ...(live !== undefined && { is_live: live }),
  }
}

export function createSharpApiServer(opts: SharpApiServerOptions): McpServer {
  const get = createApi({
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
    userAgent: `sharpapi-mcp/${VERSION} (${opts.mode})`,
    clientIp: opts.clientIp,
    attempts: opts.attempts,
    timeoutMs: opts.timeoutMs,
    onStatus: opts.onStatus,
  })

  /**
   * Tool results are JSON text, printed without indentation: indented, every
   * answer was a third larger for no gain to the model reading it.
   * Errors are returned with `isError` so clients can handle plan requirements
   * and rate limits. API error messages are preserved to provide the details
   * needed to handle each failure. Only `err.message` is ever read, so an
   * attached request object is not serialised either way. See src/redact.ts.
   *
   * `narrow` marks an unpaged tool: its answer is kept within
   * MAX_UNPAGED_BYTES, and `narrow` is the advice a cut answer carries on how
   * to ask for less. Paginated tools pass none and are returned whole.
   */
  const redact = makeRedactor(opts.apiKey)
  const text = (t: string) => {
    const out = redact(t)
    opts.onResult?.(Buffer.byteLength(out))
    return [{ type: 'text' as const, text: out }]
  }
  async function run(fn: () => Promise<unknown>, narrow?: string) {
    try {
      const body = await fn()
      return { content: text(JSON.stringify(narrow ? fitResult(body, MAX_UNPAGED_BYTES, narrow) : body)) }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { isError: true, content: text(`SharpAPI request failed: ${msg}`) }
    }
  }

  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    {
      // No change notifications: the list is fixed per release, so a
      // `subscriptions/listen` stream has nothing to wait for.
      capabilities: { tools: { listChanged: false } },
      cacheHints: { 'tools/list': PUBLIC_HOUR, 'server/discover': PUBLIC_HOUR },
    },
  )

  server.registerTool(
    'list_sports',
    {
      description: 'List the sports SharpAPI covers, with live and upcoming event counts for each. Call this first to discover valid sport ids for the other tools.',
      annotations: READ_ONLY,
    },
    async () => run(() => get('/api/v1/sports')),
  )

  server.registerTool(
    'list_sportsbooks',
    {
      description: 'List the sportsbooks SharpAPI normalizes, with their ids. Use the returned ids for the `sportsbook` argument elsewhere. Which books a key can actually read depends on its plan: the free tier serves DraftKings and FanDuel only.',
      annotations: READ_ONLY,
    },
    async () => run(() => get('/api/v1/sportsbooks')),
  )

  server.registerTool(
    'list_events',
    {
      description: 'List events (games) with ids, start times and teams. Use this to find an event id before fetching odds for it.',
      inputSchema: z.object({
        sport: z.string().optional().describe('Sport id from list_sports, e.g. "baseball"'),
        league: z.string().optional().describe('League id, e.g. "mlb"'),
        live: z.boolean().optional().describe('Only events currently in play'),
        date: z.string().optional().describe('ISO date, e.g. "2026-09-08"'),
        limit: z.number().int().positive().max(500).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/events', query(args))),
  )

  server.registerTool(
    'get_odds',
    {
      description: 'Get normalized odds across sportsbooks. Returns American and decimal prices plus implied probability, one row per book/market/selection, so prices are directly comparable between books. Results are paginated at 50 rows by default; pass the cursor from pagination.next_cursor to fetch the next page when pagination.has_more is true.',
      inputSchema: z.object({
        sport: z.string().optional().describe('Sport id from list_sports'),
        league: z.string().optional(),
        event: z.string().optional().describe('Event id from list_events'),
        sportsbook: z.string().optional().describe('Restrict to one book id'),
        market: z.string().optional().describe('e.g. "moneyline", "spread", "total"'),
        live: z.boolean().optional().describe('Only in-play markets'),
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.string().optional().describe('Pagination cursor from a previous response (pagination.next_cursor). Pass this to fetch the next page of results when pagination.has_more is true.'),
        player_name: z.string().optional().describe('Filter to one player. Full name, case-insensitive exact match — "Travis Kelce" matches, "Kelce" does not. Only appears on player-prop markets.'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/odds', query(args))),
  )

  server.registerTool(
    'get_best_odds',
    {
      description: 'Get the best available price per selection across all covered books. This is the line shopping view: one row per selection rather than one per book.',
      inputSchema: z.object({
        sport: z.string().optional(),
        league: z.string().optional(),
        event: z.string().optional(),
        market: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/odds/best', query(args))),
  )

  server.registerTool(
    'get_arbitrage',
    {
      description: 'Find cross-book arbitrage opportunities: sets of prices whose combined implied probability is under 100%, so backing every outcome locks a margin. Requires a Hobby plan or above.',
      inputSchema: z.object({
        sport: z.string().optional(),
        league: z.string().optional(),
        min_profit: z.number().optional().describe('Minimum profit percent, e.g. 1.5'),
        limit: z.number().int().positive().max(500).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/opportunities/arbitrage', args)),
  )

  server.registerTool(
    'get_ev',
    {
      description: 'Find positive expected value (+EV) bets: prices that beat the fair probability implied by the wider market. Each opportunity carries a fairProbability field, which is the de-vigged number. Requires a Pro plan or above.',
      inputSchema: z.object({
        sport: z.string().optional(),
        league: z.string().optional(),
        min_ev: z.number().optional().describe('Minimum EV percent, e.g. 2'),
        sportsbook: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/opportunities/ev', args)),
  )

  server.registerTool(
    'get_middles',
    {
      description: 'Find middle opportunities: two prices on opposite sides with a gap where both bets can win. Sorted by quality unless told otherwise. Requires a Pro plan or above.',
      inputSchema: z.object({
        sport: z.string().optional(),
        league: z.string().optional(),
        market: z.string().optional().describe('Market id from get_markets, e.g. "point_spread" or "total_points"'),
        min_size: z.number().optional().describe('Minimum middle width in points'),
        sort: z.enum(['quality', 'ev', 'probability', 'middle_size']).optional(),
        limit: z.number().int().positive().max(500).optional(),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/opportunities/middles', args)),
  )

  server.registerTool(
    'get_event_odds',
    {
      description: 'Get the odds for one event across every covered sportsbook, in one call with no pagination. A busy event holds thousands of rows, so pass sportsbook to read one book: an answer over about 100 kB is cut to its first rows and carries a `truncated` note with the full row count. To read one market, or to page through every row, use get_odds with event, market and cursor. Use list_events to find event ids.',
      inputSchema: z.object({
        event_id: z.string().describe('Event id from list_events, e.g. "nfl_chiefs_ravens_2026-01-18_a4"'),
        sportsbook: z.string().optional().describe('Restrict to one book id from list_sportsbooks'),
      }),
      annotations: READ_ONLY,
    },
    async ({ event_id, sportsbook }) =>
      run(
        () => get(`/api/v1/events/${encodeURIComponent(event_id)}/odds`, { sportsbook }),
        'Pass sportsbook to read one book. To read one market, or to page through every row, use get_odds with event, market and cursor.',
      ),
  )

  server.registerTool(
    'get_splits',
    {
      description: 'Get public betting splits: the share of bets (bets_pct) and of money (handle_pct) on each side of an event\'s spread, total and moneyline, per source. sportsbook "consensus" is the deduplicated row most events carry. Results are paginated, 20 rows by default; when pagination.has_more is true, pass pagination.next_offset back as offset to fetch the next page. Requires a Pro plan or above.',
      inputSchema: z.object({
        sport: z.string().optional().describe('Sport id from list_sports, e.g. "basketball". Comma-separate for several.'),
        league: z.string().optional().describe('League id, e.g. "nfl", "ncaaf", "nba", "ncaab". Comma-separate for several.'),
        sportsbook: z.string().optional().describe('Splits source: "consensus" or a book id from list_sportsbooks. Comma-separate for several.'),
        event_id: z.string().optional().describe('Event id from list_events. Comma-separate for several.'),
        market: z.string().optional().describe('Only events carrying this market: "spread", "total" or "moneyline". Comma-separate for several.'),
        // The API caps a page at 200 rows (it clamps anything larger).
        limit: z.number().int().positive().max(200).optional().describe('Rows per page, default 20, max 200'),
        offset: z.number().int().nonnegative().optional().describe('pagination.next_offset from the previous page'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/splits', args)),
  )

  server.registerTool(
    'get_leagues',
    {
      description: 'List leagues with their ids, sport and event counts. Pass sport to list one sport: without it the list covers every sport and runs to several hundred leagues. Use the returned ids for the `league` argument elsewhere.',
      inputSchema: z.object({
        sport: z.string().optional().describe('Sport id from list_sports, e.g. "football". Comma-separate for several.'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/leagues', args)),
  )

  server.registerTool(
    'get_markets',
    {
      description: 'List the markets SharpAPI prices, with their ids (e.g. "moneyline", "point_spread", "player_points"), how many events carry each and which books price it. Pass league or sport to scope the list and its counts. Use the returned ids for the `market` argument elsewhere. Each row carries market_type_id; see get_market_types.',
      inputSchema: z.object({
        league: z.string().optional().describe('League id, e.g. "nfl". Counts become league-local.'),
        sport: z.string().optional().describe('Sport id, or several comma-separated. Combined with league, a market must match both.'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/markets', args)),
  )

  server.registerTool(
    'get_market_types',
    {
      description: 'List market types: the shape of a market\'s selections (e.g. moneyline: home/away, total: over/under), each with a stable numeric id. get_markets rows carry that id as market_type_id.',
      annotations: READ_ONLY,
    },
    async () => run(() => get('/api/v1/market-types')),
  )

  server.registerTool(
    'get_odds_delta',
    {
      description: 'Get only the odds that changed since a timestamp, plus the odds removed since then: the incremental follow-up to a get_odds call, e.g. "which prices moved on tonight\'s NBA games in the last 5 minutes?". The API looks back 10 minutes at most. Results are paginated, 50 rows by default; when pagination.has_more is true, pass pagination.next_offset back as offset to fetch the next page. The list of removed odds is left out unless include_removed is true; removed_count says how many there were.',
      inputSchema: z.object({
        since: z.string().describe('ISO 8601 timestamp, e.g. "2026-05-06T19:30:00Z". Only odds changed after it are returned.'),
        sport: z.string().optional().describe('Sport id from list_sports'),
        league: z.string().optional(),
        sportsbook: z.string().optional().describe('Restrict to one book id'),
        event_id: z.string().optional().describe('Event id from list_events'),
        market: z.string().optional().describe('Market id from get_markets, e.g. "moneyline"'),
        market_segment: z.string().optional().describe('Contest slice, e.g. "full_game", "1st_half". Comma-separate for several.'),
        live: z.boolean().optional().describe('Only in-play markets'),
        // The API caps a page at 500 rows (it clamps anything larger).
        limit: z.number().int().positive().max(500).optional().describe('Rows per page, default 50, max 500'),
        offset: z.number().int().nonnegative().optional().describe('pagination.next_offset from the previous page'),
        include_removed: z.boolean().optional().describe('Also return the `removed` list: the odds taken down since the timestamp, up to 1,000 entries (about 150 kB). For keeping a local copy in step.'),
      }),
      annotations: READ_ONLY,
    },
    // include_removed is this tool's own switch and is not sent to the API.
    async ({ include_removed, ...args }) =>
      run(async () => deltaWithoutRemoved(await get('/api/v1/odds/delta', query(args)), include_removed)),
  )

  server.registerTool(
    'compare_odds',
    {
      description: 'Compare prices across sportsbooks for one event: one row per market, selection and line, listing each book\'s price side by side. Pass market to compare one market, e.g. "moneyline". An event carries thousands of rows across all its markets: an answer over about 100 kB is cut to its first rows and carries a `truncated` note with the full row count. Use list_events to find the event id.',
      inputSchema: z.object({
        event_id: z.string().describe('Event id from list_events'),
        market: z.string().optional().describe('Market id from get_markets, e.g. "moneyline" or "point_spread". Comma-separate for several. Matched whole against each row\'s market_type; when nothing matches, the answer lists the ids the event does carry as available_markets.'),
        market_segment: z.string().optional().describe('Contest slice, e.g. "full_game", "1st_half". Comma-separate for several.'),
      }),
      annotations: READ_ONLY,
    },
    // This route does not narrow by market, so `market` is not sent to it:
    // the rows are narrowed here. See comparisonForMarkets in src/fit.ts.
    async ({ event_id, market, market_segment }) =>
      run(
        async () => comparisonForMarkets(await get('/api/v1/odds/comparison', { event_id, market_segment }), market),
        'Pass market to compare one market, e.g. "moneyline". get_markets lists the ids.',
      ),
  )

  server.registerTool(
    'get_closing_lines',
    {
      description: 'Get the closing lines captured for an event: each book\'s last pre-match prices from the moment the event went live, with no-vig and fair closing probabilities. Use it for closing-line value (CLV): was a bet better or worse than the close? Pass sportsbook and market to read one book and one market: an answer over about 100 kB is cut to its first rows and carries a `truncated` note with the full row count. An event that has not started returns no books. Requires a Pro plan or above.',
      inputSchema: z.object({
        event_id: z.string().describe('Event id from list_events'),
        sportsbook: z.string().optional().describe('Book id from list_sportsbooks. Comma-separate for several.'),
        market: z.string().optional().describe('Market id from get_markets, e.g. "moneyline". Comma-separate for several. Matched whole against each row\'s market_type; when nothing matches, the answer lists the ids the event does carry as available_markets.'),
      }),
      annotations: READ_ONLY,
    },
    // This route does not narrow by market either, so `market` is not sent to
    // it: the rows are narrowed here. See closingForMarkets in src/fit.ts.
    async ({ event_id, sportsbook, market }) =>
      run(
        async () => closingForMarkets(await get('/api/v1/odds/closing', { event_id, sportsbook }), market),
        'Pass sportsbook and market to read one book and one market, e.g. sportsbook "draftkings", market "moneyline".',
      ),
  )

  server.registerTool(
    'get_futures',
    {
      description: 'List futures: season-long markets such as championship, conference and division winners, MVP and other awards, and win totals. Each has an id, e.g. "nfl__super_bowl_winner", to pass to get_futures_odds or compare_futures_lines, and lists the books pricing it. Pass league or sport to scope the list. Requires an Enterprise plan.',
      inputSchema: z.object({
        league: z.string().optional().describe('League id, e.g. "nfl", "nba"'),
        sport: z.string().optional().describe('Sport id from list_sports, e.g. "football"'),
        future_type: z.string().optional().describe('TEAM, PLAYER, or UNKNOWN (the selection is neither, e.g. a conference)'),
        future_id: z.string().optional().describe('Future ids, comma-separated, to look up specific futures'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/futures', args)),
  )

  server.registerTool(
    'get_futures_odds',
    {
      description: 'Get odds on futures, grouped by future: one row per sportsbook, selection, side (selection_line: over/under on win totals, yes/no) and line. Pass future_id (from get_futures), or league for every future in it. One future can hold hundreds of rows, so narrow with team_id, selection or sportsbook, and ask for a few futures at a time with limit. is_main marks each book\'s main line on a ladder. Paginated by future, 50 per page by default; when pagination.has_more is true, pass pagination.next_offset back as offset. Requires an Enterprise plan.',
      inputSchema: z.object({
        future_id: z.string().optional().describe('Future id from get_futures, e.g. "nba__championship_winner". Comma-separate for several. Required unless league is given.'),
        league: z.string().optional().describe('Every future in a league, e.g. "nfl". Required unless future_id is given.'),
        sport: z.string().optional().describe('Sport id from list_sports'),
        future_type: z.string().optional().describe('TEAM, PLAYER or UNKNOWN'),
        sportsbook: z.string().optional().describe('Book ids, comma-separated, e.g. "draftkings,fanduel"'),
        team_id: z.string().optional().describe('Team ids, comma-separated, e.g. "los_angeles_lakers": only rows on those teams'),
        selection: z.string().optional().describe('Selection names, comma-separated, e.g. "Patrick Mahomes": only rows on those'),
        is_main: z.boolean().optional().describe('true: only each book\'s main line on a ladder (win totals); false: only the alternate lines'),
        // The API takes at most 200 futures per page.
        limit: z.number().int().positive().max(200).optional().describe('Futures per page, default 50, max 200'),
        offset: z.number().int().nonnegative().optional().describe('pagination.next_offset from the previous page, counted in futures'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/futures/odds', args)),
  )

  server.registerTool(
    'compare_futures_lines',
    {
      description: 'Compare one future across sportsbooks, to find the best price on a futures bet: for "best odds on Patrick Mahomes for MVP", pass future_id "nfl__mvp_winner" and selection "Patrick Mahomes". Same data as get_futures_odds, for one future. Requires an Enterprise plan.',
      inputSchema: z.object({
        future_id: z.string().describe('The future to compare across books, an id from get_futures'),
        sportsbook: z.string().optional().describe('Book ids to compare, comma-separated'),
        team_id: z.string().optional().describe('Team ids, comma-separated: only rows on those teams'),
        selection: z.string().optional().describe('Selection names, comma-separated: only rows on those'),
        is_main: z.boolean().optional().describe('true: only each book\'s main line on a ladder'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/futures/odds', args)),
  )

  server.registerTool(
    'find_low_hold',
    {
      description: 'Find low-hold markets: the tightest lines across sportsbooks, where the combined margin of the best prices on each side (hold_percentage) is lowest. Requires a Pro plan or above.',
      inputSchema: z.object({
        sport: z.string().optional().describe('Sport id from list_sports'),
        league: z.string().optional(),
        live: z.boolean().optional().describe('Only in-play markets'),
        // The API caps a page at 200 rows (it clamps anything larger).
        limit: z.number().int().positive().max(200).optional().describe('Rows per page, default 50, max 200'),
      }),
      annotations: READ_ONLY,
    },
    async (args) => run(() => get('/api/v1/opportunities/low_hold', query(args))),
  )

  server.registerTool(
    'get_account_info',
    {
      description: 'Get the account behind the API key in use: its plan (tier), rate limit, streaming allowance and the features it unlocks. Use it to check what the key can call before a tool that needs a higher plan.',
      annotations: READ_ONLY,
    },
    async () => run(() => get('/api/v1/account')),
  )

  return server
}
