/**
 * The hosted MCP relay: Streamable HTTP in front of the same tool factory the
 * stdio bin serves. It holds no key of its own. Every tool call goes to the
 * API with the caller's own key, so the API applies that key's plan and rate
 * limits exactly as on a direct REST call.
 *
 * Controls, in the order a request meets them:
 *  - only POST /mcp, with no query string (a key in a URL ends up in access
 *    logs and connector settings, so `?api_key=` is refused, never read);
 *  - Host and Origin allowlists (DNS rebinding, cross-site calls), 403;
 *  - a per-address cap on rejected keys, 429. Behind a local reverse proxy
 *    an address-based ban sees only the proxy's address, so the relay counts them
 *    itself, by the forwarded address; IPv6 by /64;
 *  - a key from `Authorization: Bearer` or `X-API-Key` only; none, 401, and
 *    nothing is forwarded;
 *  - a short cache of keys the API just answered 401 for, so a bad key is
 *    not forwarded again and again from one address;
 *  - concurrency caps per key and in total, a body limit, a deadline on
 *    every exchange, and one API call per tool call (no retries).
 * One JSON log line per request, never with the key, a header, the query,
 * tool arguments or result bodies.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node'
import { CLIENT_INFO_META_KEY, createMcpHandler } from '@modelcontextprotocol/server'
import { createSharpApiServer } from './tools.js'

export interface HostedOptions {
  /**
   * The API base URL the relay calls, e.g. https://api.sharpapi.io.
   */
  baseUrl: string
  /** Host header hostnames accepted, without port, e.g. ['localhost']. */
  allowedHosts: string[]
  /** Origin hostnames accepted. A request with any other Origin gets 403. */
  allowedOrigins: string[]
  maxBodyBytes?: number
  upstreamTimeoutMs?: number
  /** Hard deadline on one exchange, response included. */
  maxExchangeMs?: number
  maxInflight?: number
  maxInflightPerKey?: number
  badKeyTtlMs?: number
  authFailLimit?: number
  authFailWindowMs?: number
  /** Receives one JSON line per request. Default: stdout. */
  log?: (line: string) => void
}

export const DEFAULTS = {
  maxBodyBytes: 64 * 1024,
  upstreamTimeoutMs: 30_000,
  maxExchangeMs: 60_000,
  maxInflight: 64,
  maxInflightPerKey: 4,
  badKeyTtlMs: 60_000,
  // The same as the API's own per-address cap on rejected keys: 10 per 5 minutes.
  authFailLimit: 10,
  authFailWindowMs: 5 * 60_000,
}

// Upper bound on entries in each in-memory table, so a flood of distinct
// keys or addresses cannot grow the process without limit.
const TABLE_CAP = 100_000

type KeyResult = { key: string } | { status: 400 | 401; error: string; counts: boolean }

/** The caller's key, from `Authorization: Bearer` or `X-API-Key`, and nothing else. */
export function extractKey(h: IncomingHttpHeaders): KeyResult {
  let bearer: string | undefined
  if (h.authorization !== undefined) {
    const m = /^Bearer +(\S+) *$/i.exec(h.authorization)
    if (!m) return { status: 401, error: 'Authorization must be "Bearer <your SharpAPI key>".', counts: true }
    bearer = m[1]
  }
  const xkey = h['x-api-key'] as string | undefined
  if (bearer !== undefined && xkey !== undefined && bearer !== xkey) {
    return { status: 400, error: 'Authorization and X-API-Key carry different keys. Send one.', counts: false }
  }
  const key = bearer ?? xkey
  if (!key) {
    // Not counted against the address: it is never forwarded, so it tests no key.
    return { status: 401, error: 'Send your SharpAPI key in an Authorization: Bearer header or in X-API-Key. Get a free key at https://sharpapi.io.', counts: false }
  }
  // Printable ASCII only, which also rules out the control characters that
  // make Node quote a header value back in an error (see src/index.ts).
  if (!/^[\x21-\x7e]{1,256}$/.test(key)) return { status: 401, error: 'The key is malformed. Re-copy it with no spaces or extra text.', counts: true }
  return { key }
}

/** The end user's address: X-Real-IP when the peer is the local proxy, else the peer. */
export function clientAddress(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? ''
  const fwd = req.headers['x-real-ip']
  const fromProxy = peer === '::1' || peer.startsWith('127.') || peer.startsWith('::ffff:127.')
  return fromProxy && typeof fwd === 'string' && isIP(fwd) ? fwd : peer
}

/** The rate-limit bucket for an address: IPv4 as is, IPv6 by its /64. */
export function addressBucket(ip: string): string {
  if (ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4) return ip.slice(7)
  if (isIP(ip) !== 6) return ip
  const [head, tail] = ip.split('%')[0].split('::')
  const h = head ? head.split(':') : []
  const t = tail ? tail.split(':') : []
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]
  return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64'
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 64) : undefined)

/** What the log may say about a JSON-RPC message: method, tool name, client. */
function describe(body: unknown) {
  if (Array.isArray(body)) return { method: 'batch' }
  const msg = (body ?? {}) as { method?: unknown; params?: Record<string, any> }
  const params = msg.params ?? {}
  const info = params._meta?.[CLIENT_INFO_META_KEY] ?? (msg.method === 'initialize' ? params.clientInfo : undefined)
  return {
    method: str(msg.method),
    tool: msg.method === 'tools/call' ? str(params.name) : undefined,
    client: str(info?.name),
    client_version: str(info?.version),
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}
const reject = (res: ServerResponse, status: number, error: string, headers?: Record<string, string>) =>
  json(res, status, { error }, headers)

function readBody(req: IncomingMessage, max: number): Promise<Buffer | 'too-large'> {
  if (Number(req.headers['content-length']) > max) return Promise.resolve('too-large')
  return new Promise((resolve, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > max) {
        done = true
        resolve('too-large')
      } else chunks.push(c)
    })
    req.on('end', () => done || resolve(Buffer.concat(chunks)))
    req.on('error', fail)
  })
}

export function createHostedServer(options: HostedOptions): Server {
  const o = { ...DEFAULTS, ...options }
  const log = o.log ?? ((line: string) => process.stdout.write(line + '\n'))
  const validHost = hostHeaderValidation(o.allowedHosts)
  const validOrigin = originValidation(o.allowedOrigins)

  const badKeys = new Map<string, number>() // sha256(key) -> expiry
  const authFails = new Map<string, { n: number; since: number }>()
  const perKey = new Map<string, number>()
  let inflight = 0

  const remember = <V>(m: Map<string, V>, k: string, v: V) => {
    m.delete(k)
    if (m.size >= TABLE_CAP) m.delete(m.keys().next().value!)
    m.set(k, v)
  }
  const failsFor = (bucket: string) => {
    const f = authFails.get(bucket)
    return f && Date.now() - f.since < o.authFailWindowMs ? f : undefined
  }
  const countFail = (bucket: string) => {
    const f = failsFor(bucket)
    remember(authFails, bucket, f ? { n: f.n + 1, since: f.since } : { n: 1, since: Date.now() })
  }

  type Relay = { ip: string; onStatus: (s: number) => void; onResult: (b: number) => void }
  const mcp = createMcpHandler(
    (ctx) => {
      const relay = ctx.authInfo?.extra?.relay as Relay | undefined
      // Never build a server without the caller's own key.
      if (!ctx.authInfo?.token || !relay) throw new Error('no caller credential on this request')
      return createSharpApiServer({
        apiKey: ctx.authInfo.token,
        mode: 'hosted',
        baseUrl: o.baseUrl,
        clientIp: relay.ip,
        attempts: 1,
        timeoutMs: o.upstreamTimeoutMs,
        onStatus: relay.onStatus,
        onResult: relay.onResult,
      })
    },
    { maxRequestBodySize: o.maxBodyBytes, maxSubscriptions: o.maxInflight },
  )
  const serve = toNodeHandler(mcp)

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const [path, query] = (req.url ?? '/').split(/\?(.*)/s)
    // Unlogged: a liveness probe every few seconds would bury the real lines.
    if (path === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true })
    const t0 = Date.now()
    const ip = clientAddress(req)
    const bucket = addressBucket(ip)
    const entry: Record<string, unknown> = { ip }
    res.on('close', () => {
      log(JSON.stringify({
        ts: new Date(t0).toISOString(), ...entry, status: res.statusCode,
        latency_ms: Date.now() - t0, ...(res.writableFinished ? {} : { aborted: true }),
      }))
    })
    const deadline = setTimeout(() => res.destroy(), o.maxExchangeMs)
    res.on('close', () => clearTimeout(deadline))

    if (path !== '/mcp') return reject(res, 404, 'Not found. The MCP endpoint is /mcp.')
    if (query !== undefined) {
      return reject(res, 400, 'This endpoint takes no query parameters. Send your SharpAPI key in an Authorization: Bearer header or in X-API-Key, never in the URL.')
    }
    if (!validHost(req, res) || !validOrigin(req, res)) return
    if (req.method !== 'POST') return reject(res, 405, 'Use POST.', { Allow: 'POST' })
    const f = failsFor(bucket)
    if (f && f.n >= o.authFailLimit) {
      const wait = Math.ceil((f.since + o.authFailWindowMs - Date.now()) / 1000)
      return reject(res, 429, 'Too many rejected keys from this address. Try again later.', { 'Retry-After': String(wait) })
    }

    const got = extractKey(req.headers)
    if (!('key' in got)) {
      if (got.counts) countFail(bucket)
      return reject(res, got.status, got.error, got.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="SharpAPI"' } : {})
    }
    const { key } = got
    const kh = sha(key)
    // The first 12 characters, as the API's own access log records keys, but
    // never more than half the key, so a short key is never logged whole.
    entry.key_id = key.slice(0, Math.min(12, key.length >> 1))
    if ((badKeys.get(kh) ?? 0) > Date.now()) {
      countFail(bucket)
      return reject(res, 401, 'SharpAPI rejected this key moments ago. Check it at https://sharpapi.io.', { 'WWW-Authenticate': 'Bearer realm="SharpAPI", error="invalid_token"' })
    }

    if (inflight >= o.maxInflight) return reject(res, 503, 'The relay is at capacity. Retry shortly.', { 'Retry-After': '5' })
    const mine = perKey.get(kh) ?? 0
    if (mine >= o.maxInflightPerKey) return reject(res, 429, 'Too many concurrent requests for this key.', { 'Retry-After': '1' })
    inflight++
    perKey.set(kh, mine + 1)
    res.on('close', () => {
      inflight--
      const n = (perKey.get(kh) ?? 1) - 1
      if (n > 0) perKey.set(kh, n)
      else perKey.delete(kh)
    })

    const raw = await readBody(req, o.maxBodyBytes)
    if (raw === 'too-large') return reject(res, 413, `Request body over ${o.maxBodyBytes} bytes.`, { Connection: 'close' })
    let body: unknown
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }
    Object.assign(entry, describe(body))

    const relay: Relay = {
      ip,
      onStatus: (s) => {
        entry.upstream = s
        if (s === 401) {
          remember(badKeys, kh, Date.now() + o.badKeyTtlMs)
          countFail(bucket)
        }
      },
      onResult: (b) => { entry.result_bytes = b },
    }
    // toNodeHandler passes `req.auth` through as the factory's authInfo.
    Object.assign(req, { auth: { token: key, clientId: 'sharpapi-key', scopes: [], extra: { relay } } })
    await serve(req, res, body)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) reject(res, 500, 'Internal error.')
      else res.destroy()
    })
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.keepAliveTimeout = 5_000
  server.on('close', () => void mcp.close())
  return server
}
