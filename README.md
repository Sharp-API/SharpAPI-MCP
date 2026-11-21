# SharpAPI MCP Server

[![npm](https://img.shields.io/npm/v/@sharp-api/mcp-server)](https://www.npmjs.com/package/@sharp-api/mcp-server)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/sharp-api/sharpapi-mcp)

MCP server for [SharpAPI](https://sharpapi.io). Exposes live sports betting odds, +EV, arbitrage, middles and betting splits as Model Context Protocol tools, for compatible AI applications to query sports betting data.

Built on the official MCP TypeScript SDK v2. It speaks the current MCP revision (2026-07-28) and the 2025-era revisions, over stdio and over Streamable HTTP. Requires Node.js 20 or later.

## Install

Install the [npm package](https://www.npmjs.com/package/@sharp-api/mcp-server) globally, which puts `sharpapi-mcp` on your PATH:

```bash
npm install -g @sharp-api/mcp-server
```

Or run it without installing:

```bash
npx -y @sharp-api/mcp-server
```

To run from source instead, use the GitHub repository:

```bash
npx github:Sharp-API/SharpAPI-MCP
```

## Configure

Set `SHARPAPI_KEY` in the environment. Get a free key at <https://sharpapi.io>; the free tier serves DraftKings and FanDuel at 12 requests/min with no card.

The key is read from the environment only. There is deliberately no way to pass it as a tool argument: tool arguments are model-generated and end up in transcripts and logs.

Claude Desktop (`claude_desktop_config.json`), running the npm package through `npx`:

```json
{
  "mcpServers": {
    "sharpapi": {
      "command": "npx",
      "args": ["-y", "@sharp-api/mcp-server"],
      "env": { "SHARPAPI_KEY": "sk_your_key_here" }
    }
  }
}
```

With the global install, call the `sharpapi-mcp` binary directly:

```json
{
  "mcpServers": {
    "sharpapi": {
      "command": "sharpapi-mcp",
      "env": { "SHARPAPI_KEY": "sk_your_key_here" }
    }
  }
}
```

## Run as a remote (HTTP) server

The same tools can be served over Streamable HTTP for clients that connect by URL. This entry point is a separate script (`dist/http.js`), not the `sharpapi-mcp` binary. From a clone:

```bash
npm ci && npm run build
SHARPAPI_BASE_URL=https://api.sharpapi.io npm run start:http
# listening on http://127.0.0.1:8787/mcp
```

Each caller sends their own SharpAPI key with every request, in an `Authorization: Bearer <key>` header or in `X-API-Key`. The server holds no key of its own and refuses to start if `SHARPAPI_KEY` is set, so every API call runs under the caller's own plan and rate limits.

| variable | meaning | default |
|---|---|---|
| `SHARPAPI_BASE_URL` | API base URL the server calls (required) | none |
| `MCP_ALLOWED_HOSTS` | Host header names accepted, comma-separated | `localhost,127.0.0.1` |
| `MCP_ALLOWED_ORIGINS` | Origin host names accepted; a request with any other `Origin` gets 403 | none |
| `MCP_HOST`, `MCP_PORT` | listen address | `127.0.0.1`, `8787` |

What it refuses, without calling the API:

- a request with no key (401), or with a key in the URL: any query string on `/mcp` is rejected (400);
- an unlisted `Host` or `Origin` (403), and anything but `POST /mcp` (`GET /healthz` answers a liveness probe);
- a key the API rejected in the last minute, and further requests from an address that has sent 10 rejected keys in 5 minutes (429);
- more than 4 concurrent requests per key or 64 in total, and request bodies over 64 KiB.

Each tool call makes exactly one API request, with no retries. The server writes one JSON line per request to stdout: time, client address, MCP method, tool name, client name and version, the first 12 characters of the key (never more than half of it), HTTP and API status, latency and result size. It never logs the full key, request headers, the query string, tool arguments or results.

## Tools

| tool | what it does | plan |
|---|---|---|
| `list_sports` | Sports covered, with live/upcoming counts. Start here to find valid sport ids. | any |
| `list_sportsbooks` | Book ids for the `sportsbook` argument. | any |
| `list_events` | Events with ids, start times, teams. | any |
| `get_odds` | Normalized odds across books: American, decimal, implied probability. | any |
| `get_best_odds` | Best price per selection across books. The line-shopping view. | any |
| `get_arbitrage` | Cross-book arbitrage: combined implied probability under 100%. | Hobby+ |
| `get_ev` | +EV bets against fair probability. Carries `fairProbability`, the de-vigged number. | Pro+ |
| `get_middles` | Two-sided gaps where both bets can win. | any |
| `get_event_odds` | Every odds row for one event across books, in one call with no pagination. Takes an event id from `list_events`. | any |
| `get_splits` | Public betting splits: share of bets (`bets_pct`) and of money (`handle_pct`) on each side of the spread, total and moneyline. `sportsbook: "consensus"` is the deduplicated row. Paginated: pass `pagination.next_offset` back as `offset`. | Pro+ |

The API enforces plan requirements. The server returns API errors unchanged, including details about the required tier.

There is no separate no-vig tool. SharpAPI does not expose de-vigged odds as its own endpoint; the fair number arrives as `fairProbability` on each `get_ev` opportunity.

## Notes

- Tool errors are returned with `isError` so clients can handle rate limits and plan requirements.
- Diagnostics are written to stderr; in stdio mode stdout is reserved for the MCP protocol.

## License

MIT
