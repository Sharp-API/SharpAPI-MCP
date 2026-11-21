#!/usr/bin/env node
/**
 * MCP server for SharpAPI, over stdio: the `sharpapi-mcp` bin a user installs
 * and runs locally. The tools live in src/tools.ts; src/http.ts serves the
 * same factory over HTTP.
 *
 * Auth is `SHARPAPI_KEY` from the environment. `serveStdio` answers both
 * protocol eras on one connection: a 2025-era client that opens with
 * `initialize` and a 2026-07-28 client that opens with `server/discover`.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createSharpApiServer } from './tools.js'

const apiKey = process.env.SHARPAPI_KEY

// Reject a key containing control characters before it is ever used as a header
// value. Node's own `Headers.append` throws on such a value, and its error
// message QUOTES the value back — which then travels into a tool result and so
// into the conversation transcript. Caught by an adversarial review that
// reproduced the leak with a key carrying an embedded CRLF; the realistic
// trigger is a paste that picked up a trailing newline plus following text.
// (The hosted relay applies a stricter printable-ASCII check: src/hosted.ts.)
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

// SHARPAPI_BASE_URL overrides the API host, for testing.
serveStdio(() =>
  createSharpApiServer({ apiKey, mode: 'stdio', baseUrl: process.env.SHARPAPI_BASE_URL }),
)
