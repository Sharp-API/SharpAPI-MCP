# Changelog

What changed in each release of `@sharp-api/mcp-server`, newest first.

## 0.2.0 (2026-11-22)

**Needs Node.js 20 or later.** 0.1.x supported Node.js 18; the MCP SDK this version is built on requires 20.

- 12 new tools, 21 in total: `get_leagues`, `get_markets`, `get_market_types`, `get_account_info`, `get_odds_delta`, `compare_odds`, `get_closing_lines`, `get_splits`, `find_low_hold`, `get_futures`, `get_futures_odds` and `compare_futures_lines`.
- A second way to run it: the same tools over Streamable HTTP (`npm run start:http`). See "Run as a remote (HTTP) server" in the README.
- Answers are compact JSON, without indentation.
- `get_event_odds`, `compare_odds` and `get_closing_lines` cut an answer over about 100 kB to its first rows and say so in a `truncated` note. `get_event_odds` returned everything before; to read every row, page through `get_odds` with `event` and `cursor`.
- `get_odds_delta` leaves out the list of removed odds unless `include_removed` is true.
- Built on version 2 of the official MCP TypeScript SDK. It speaks the 2026-07-28 revision of the protocol and the 2025 revisions.

## 0.1.1 (2026-10-29)

The README points at the npm package. No change to the server.

## 0.1.0 (2026-10-27)

First release: 9 tools over stdio.
