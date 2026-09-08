# sharpapi-mcp

MCP server for [SharpAPI](https://sharpapi.io). Exposes live sports betting odds, +EV, arbitrage and middles as Model Context Protocol tools, so an agent can query the market directly instead of being told about it.

A thin tool layer over [`@sharp-api/client`](https://www.npmjs.com/package/@sharp-api/client), which does the HTTP. Nothing here re-implements the transport.

## Install

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

Plan gates are the API's, not this server's. A key below the required tier gets the API's own error back rather than a rewritten one, because "403, this key is below Pro" is actionable and paraphrasing it hides that.

There is no separate no-vig tool. SharpAPI does not expose de-vigged odds as its own endpoint; the fair number arrives as `fairProbability` on each `get_ev` opportunity.

## Notes

- Errors come back as tool results with `isError`, not thrown, so a rate limit or tier gate is something the model can see and react to rather than a dead server.
- Diagnostics go to stderr. stdout is the MCP transport and a stray byte there corrupts the stream.

## License

MIT
