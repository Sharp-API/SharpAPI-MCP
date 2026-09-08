#!/usr/bin/env node
/**
 * MCP server for SharpAPI.
 *
 * Exposes the SharpAPI REST surface as Model Context Protocol tools, so an
 * agent can query live odds rather than read about them. A thin tool layer over
 * `@sharp-api/client`, which is the transport and the source of truth for the
 * request shapes; nothing here re-implements HTTP.
 *
 * Auth is `SHARPAPI_KEY` from the environment. There is no way to pass a key as
 * a tool argument, deliberately: tool arguments are model-generated and end up
 * in transcripts and logs.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SharpAPI } from '@sharp-api/client'
import { z } from 'zod'

const apiKey = process.env.SHARPAPI_KEY

// Reject a key containing control characters before it is ever used as a header
// value. Node's own `Headers.append` throws on such a value, and its error
// message QUOTES the value back — which then travels into a tool result and so
// into the conversation transcript. Caught by an adversarial review that
// reproduced the leak with a key carrying an embedded CRLF; the realistic
// trigger is a paste that picked up a trailing newline plus following text.
if (apiKey && /[\u0000-\u001f\u007f]/.test(apiKey)) {
  console.error(
    'SHARPAPI_KEY contains a control character (newline, tab or similar). Re-copy the key with no surrounding whitespace or trailing text.',
  )
  process.exit(1)
}

if (!apiKey) {
  // stderr, not stdout: stdout is the MCP transport and any stray byte there
  // corrupts the protocol stream.
  console.error(
    'SHARPAPI_KEY is not set. Get a free key at https://sharpapi.io (the free tier serves DraftKings and FanDuel at 12 requests/min).',
  )
  process.exit(1)
}

const client = new SharpAPI(apiKey)

/**
 * Tool results are JSON text. Errors are returned as `isError` content rather
 * than thrown, so the model sees the tier gate or rate limit and can react,
 * instead of the server dying mid-conversation.
 *
 * The message is deliberately the API's own: a 403 on +EV means "this key is
 * below Pro", which is actionable, and inventing our own wording would hide it.
 */
/**
 * Strip the configured key out of anything about to be returned to the model.
 *
 * Defence in depth behind the startup check above: that check stops the one
 * reproduced leak, this stops any future error path that quotes the key back
 * for a reason nobody has thought of yet. Only `err.message` is ever read, so
 * an attached request object is not serialised either way.
 */
function redact(text: string): string {
  if (!apiKey) return text
  return text.split(apiKey).join('[redacted SHARPAPI_KEY]')
}

async function run<T>(fn: () => Promise<T>) {
  try {
    const out = await fn()
    return { content: [{ type: 'text' as const, text: redact(JSON.stringify(out, null, 2)) }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      isError: true,
      content: [{ type: 'text' as const, text: redact(`SharpAPI request failed: ${msg}`) }],
    }
  }
}

const server = new McpServer({ name: 'sharpapi', version: '0.1.0' })

server.tool(
  'list_sports',
  'List the sports SharpAPI covers, with live and upcoming event counts for each. Call this first to discover valid sport ids for the other tools.',
  {},
  async () => run(() => client.sports.list()),
)

server.tool(
  'list_sportsbooks',
  'List the sportsbooks SharpAPI normalizes, with their ids. Use the returned ids for the `sportsbook` argument elsewhere. Which books a key can actually read depends on its plan: the free tier serves DraftKings and FanDuel only.',
  {},
  async () => run(() => client.sportsbooks.list()),
)

server.tool(
  'list_events',
  'List events (games) with ids, start times and teams. Use this to find an event id before fetching odds for it.',
  {
    sport: z.string().optional().describe('Sport id from list_sports, e.g. "baseball"'),
    league: z.string().optional().describe('League id, e.g. "mlb"'),
    live: z.boolean().optional().describe('Only events currently in play'),
    date: z.string().optional().describe('ISO date, e.g. "2026-09-08"'),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (args) => run(() => client.events.list(args)),
)

server.tool(
  'get_odds',
  'Get normalized odds across sportsbooks. Returns American and decimal prices plus implied probability, one row per book/market/selection, so prices are directly comparable between books.',
  {
    sport: z.string().optional().describe('Sport id from list_sports'),
    league: z.string().optional(),
    event: z.string().optional().describe('Event id from list_events'),
    sportsbook: z.string().optional().describe('Restrict to one book id'),
    market: z.string().optional().describe('e.g. "moneyline", "spread", "total"'),
    live: z.boolean().optional().describe('Only in-play markets'),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (args) => run(() => client.odds.get(args)),
)

server.tool(
  'get_best_odds',
  'Get the best available price per selection across all covered books. This is the line shopping view: one row per selection rather than one per book.',
  {
    sport: z.string().optional(),
    league: z.string().optional(),
    event: z.string().optional(),
    market: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (args) => run(() => client.odds.best(args)),
)

server.tool(
  'get_arbitrage',
  'Find cross-book arbitrage opportunities: sets of prices whose combined implied probability is under 100%, so backing every outcome locks a margin. Requires a Hobby plan or above.',
  {
    sport: z.string().optional(),
    league: z.string().optional(),
    min_profit: z.number().optional().describe('Minimum profit percent, e.g. 1.5'),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (args) => run(() => client.arbitrage.get(args)),
)

server.tool(
  'get_ev',
  'Find positive expected value (+EV) bets: prices that beat the fair probability implied by the wider market. Each opportunity carries a fairProbability field, which is the de-vigged number. Requires a Pro plan or above.',
  {
    sport: z.string().optional(),
    league: z.string().optional(),
    min_ev: z.number().optional().describe('Minimum EV percent, e.g. 2'),
    sportsbook: z.string().optional(),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (args) => run(() => client.ev.get(args)),
)

server.tool(
  'get_middles',
  'Find middle opportunities: two prices on opposite sides with a gap where both bets can win. Sorted by quality unless told otherwise.',
  {
    sport: z.string().optional(),
    league: z.string().optional(),
    market: z.string().optional(),
    min_size: z.number().optional().describe('Minimum middle width in points'),
    sort: z.enum(['quality', 'ev', 'probability', 'middle_size']).optional(),
    limit: z.number().int().positive().max(500).optional(),
  },
  async (args) => run(() => client.middles.get(args)),
)

const transport = new StdioServerTransport()
await server.connect(transport)
