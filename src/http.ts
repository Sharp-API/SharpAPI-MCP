#!/usr/bin/env node
/**
 * The hosted MCP relay as a long-running service (Streamable HTTP on /mcp).
 * Not part of the npm bin: `npx @sharp-api/mcp-server` still runs stdio.
 *
 * Environment:
 *   SHARPAPI_BASE_URL    required. The API base URL the relay calls,
 *                        e.g. https://api.sharpapi.io.
 *   MCP_ALLOWED_HOSTS    Host header hostnames, comma-separated
 *                        (default localhost,127.0.0.1).
 *   MCP_ALLOWED_ORIGINS  Origin hostnames, comma-separated (default none:
 *                        any request carrying an Origin header gets 403).
 *   MCP_HOST, MCP_PORT   listen address (default 127.0.0.1:8787).
 *   SHARPAPI_KEY         must NOT be set: the relay holds no key of its own.
 */
import { createHostedServer } from './hosted.js'

const env = process.env

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

if (env.SHARPAPI_KEY !== undefined) {
  die('SHARPAPI_KEY is set. The hosted relay must not hold a key: every call uses the caller\'s own key, so one shared key would serve every user. Unset it.')
}
const baseUrl = env.SHARPAPI_BASE_URL
if (!baseUrl || !URL.canParse(baseUrl)) {
  die('SHARPAPI_BASE_URL must be the URL of the API listener this relay calls (it forwards each caller\'s address as X-Real-IP).')
}
const list = (v: string | undefined, fallback: string) =>
  (v ?? fallback).split(',').map((s) => s.trim()).filter(Boolean)

const server = createHostedServer({
  baseUrl,
  allowedHosts: list(env.MCP_ALLOWED_HOSTS, 'localhost,127.0.0.1'),
  allowedOrigins: list(env.MCP_ALLOWED_ORIGINS, ''),
})
const host = env.MCP_HOST || '127.0.0.1'
const port = Number(env.MCP_PORT || 8787)
server.listen(port, host, () => console.error(`sharpapi-mcp hosted relay listening on http://${host}:${port}/mcp`))
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(() => process.exit(0)))
