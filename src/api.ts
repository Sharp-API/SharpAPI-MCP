/**
 * The one HTTP path from a tool to the SharpAPI REST API, shared by the stdio
 * and the hosted entry points.
 *
 * It replaces `@sharp-api/client` here because the hosted relay needs three
 * things that client cannot do: send the end user's address (`X-Real-IP`) so
 * the API's per-IP limits land on that user rather than on the relay, send a
 * User-Agent that tells MCP traffic apart from other SDK callers, and report
 * each upstream status so the relay can log it and stop forwarding a key the
 * API has just rejected. The paths and query encoding match that client's
 * (`buildUrl`): undefined and null are skipped, arrays are comma-joined.
 */

export interface ApiOptions {
  apiKey: string
  baseUrl: string
  userAgent: string
  /** The end user's address, forwarded as `X-Real-IP`. Hosted mode only. */
  clientIp?: string
  /** Per attempt. Default 30 s, the same as `@sharp-api/client`. */
  timeoutMs?: number
  /**
   * Total tries on a network error or a 502/503/504. The stdio entry makes 3,
   * as `@sharp-api/client` does; the hosted relay passes 1, so one tool call
   * is exactly one API call and a relay can never multiply a user's traffic.
   */
  attempts?: number
  /** Called once per upstream response that arrived, with its status. */
  onStatus?: (status: number) => void
}

export type Params = Record<string, unknown> | undefined

const RETRY_STATUSES = new Set([502, 503, 504])

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
  }
}

export function createApi(opts: ApiOptions) {
  const attempts = Math.max(1, opts.attempts ?? 3)
  const headers: Record<string, string> = {
    'X-API-Key': opts.apiKey,
    'User-Agent': opts.userAgent,
    Accept: 'application/json',
  }
  if (opts.clientIp) headers['X-Real-IP'] = opts.clientIp

  return async function get(path: string, params?: Params): Promise<unknown> {
    const url = new URL(path, opts.baseUrl)
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v))
    }
    for (let attempt = 1; ; attempt++) {
      let resp: Response
      try {
        resp = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) })
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError'
        if (!timedOut && attempt < attempts) {
          await backoff(attempt)
          continue
        }
        throw timedOut ? new ApiError('Request timeout', 0, 'timeout') : err
      }
      opts.onStatus?.(resp.status)
      if (RETRY_STATUSES.has(resp.status) && attempt < attempts) {
        await resp.body?.cancel()
        await backoff(attempt)
        continue
      }
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { error?: { message?: string; code?: string } }
        throw new ApiError(body.error?.message || `HTTP ${resp.status}`, resp.status, body.error?.code || 'unknown_error')
      }
      return resp.json()
    }
  }
}

// Full-jitter exponential backoff, the same schedule as `@sharp-api/client`: 500 ms base, 4 s cap.
function backoff(attempt: number) {
  const ceiling = Math.min(500 * 2 ** (attempt - 1), 4000)
  return new Promise((r) => setTimeout(r, Math.random() * ceiling))
}
