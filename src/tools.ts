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
import { makeRedactor } from './redact.js'

export const SERVER_NAME = 'sharpapi'
// Keep equal to package.json's version, so a client reports the release it is
// actually running. tests/handshake.mjs checks it.
export const VERSION = '0.2.0'
export const DEFAULT_BASE_URL = 'https://api.sharpapi.io'

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
   * Tool results are JSON text. Errors are returned with `isError` so clients
   * can handle plan requirements and rate limits. API error messages are
   * preserved to provide the details needed to handle each failure. Only
   * `err.message` is ever read, so an attached request object is not
   * serialised either way. See src/redact.ts.
   */
  const redact = makeRedactor(opts.apiKey)
  const text = (t: string) => {
    const out = redact(t)
    opts.onResult?.(Buffer.byteLength(out))
    return [{ type: 'text' as const, text: out }]
  }
  async function run(fn: () => Promise<unknown>) {
    try {
      return { content: text(JSON.stringify(await fn(), null, 2)) }
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
    async (args) => run(() => get('/api/v1/events', args)),
  )

  server.registerTool(
    'get_odds',
    {
      description: 'Get normalized odds across sportsbooks. Returns American and decimal prices plus implied probability, one row per book/market/selection, so prices are directly comparable between books. Results are paginated at 100 rows by default; pass the cursor from pagination.next_cursor to fetch the next page when pagination.has_more is true.',
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
    async (args) => run(() => get('/api/v1/odds', args)),
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
    async (args) => run(() => get('/api/v1/odds/best', args)),
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
      description: 'Find middle opportunities: two prices on opposite sides with a gap where both bets can win. Sorted by quality unless told otherwise.',
      inputSchema: z.object({
        sport: z.string().optional(),
        league: z.string().optional(),
        market: z.string().optional(),
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
      description: 'Get all odds for a specific event across every covered sportsbook. Returns the complete set of rows for that event in one call — no pagination. Use list_events to find event ids. To narrow by book, pass sportsbook.',
      inputSchema: z.object({
        event_id: z.string().describe('Event id from list_events, e.g. "nfl_chiefs_ravens_2026-01-18_a4"'),
        sportsbook: z.string().optional().describe('Restrict to one book id from list_sportsbooks'),
      }),
      annotations: READ_ONLY,
    },
    async ({ event_id, sportsbook }) =>
      run(() => get(`/api/v1/events/${encodeURIComponent(event_id)}/odds`, { sportsbook })),
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

  return server
}
