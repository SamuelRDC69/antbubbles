export const runtime = 'edge'

// SSE stream for real-time token updates.
// The response sends one data event immediately with current token data, then
// sets `retry: 30000` and closes — the browser's native EventSource reconnects
// after 30 s, getting a fresh snapshot each time.  This pairs serverless-safe
// short-lived edge functions with the clean EventSource reconnect loop.

import { NextRequest } from 'next/server'
import { getTokensForChain } from '@/lib/serverTokens'
import { getRedis, REDIS_KEYS } from '@/lib/redis'

const enc = new TextEncoder()

function sseEvent(data: unknown): Uint8Array {
  return enc.encode(`data: ${JSON.stringify(data)}\n\n`)
}

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get('chain') ?? 'wax'

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        // Tell browser to reconnect after 30 s if this connection closes
        ctrl.enqueue(enc.encode('retry: 30000\n\n'))

        // 1. Try Redis (Railway worker keeps this fresh)
        const redis = getRedis()
        if (redis) {
          try {
            const cached = await redis.get<unknown>(REDIS_KEYS.tokens(chainId))
            if (cached) {
              ctrl.enqueue(sseEvent(cached))
              return
            }
          } catch { /* Redis unavailable — fall through */ }
        }

        // 2. Fallback: fetch directly from Alcor
        const { data } = await getTokensForChain(chainId)
        ctrl.enqueue(sseEvent(data))
      } catch {
        ctrl.enqueue(enc.encode('event: error\ndata: {}\n\n'))
      } finally {
        ctrl.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':                'text/event-stream',
      'Cache-Control':               'no-cache, no-transform',
      'Connection':                  'keep-alive',
      'X-Accel-Buffering':           'no',   // nginx: disable proxy buffering
      'Access-Control-Allow-Origin': '*',
    },
  })
}
