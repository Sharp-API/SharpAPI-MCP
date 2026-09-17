# SharpAPI MCP Server

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/sharp-api/sharpapi-mcp)

MCP server for [SharpAPI](https://sharpapi.io). Exposes live sports betting odds, +EV, arbitrage and middles as Model Context Protocol tools, for compatible AI applications to query sports betting data.

Uses the official TypeScript SDK, [`@sharp-api/client`](https://www.npmjs.com/package/@sharp-api/client), for HTTP requests.

## Install

Install from GitHub:

```bash
npx github:Sharp-API/SharpAPI-MCP
```

The npm package is not published yet. Once it is:

```bash
npm install -g @sharp-api/mcp-server
```

## Configure

Set `SHARPAPI_KEY` in the environment. Get a free key at <https://sharpapi.io>; the free tier serves DraftKings and FanDuel at 12 requests/min with no card.

The key is read from the environment only. There is deliberately no way to pass it as a tool argument: tool arguments are model-generated and end up in transcripts and logs.

Claude Desktop (`claude_desktop_config.json`):

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

The API enforces plan requirements. The server returns API errors unchanged, including details about the required tier.

There is no separate no-vig tool. SharpAPI does not expose de-vigged odds as its own endpoint; the fair number arrives as `fairProbability` on each `get_ev` opportunity.

## Notes

- Tool errors are returned with `isError` so clients can handle rate limits and plan requirements.
- Diagnostics are written to stderr; stdout is reserved for the MCP protocol.

## License

MIT
