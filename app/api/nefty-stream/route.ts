export const runtime = 'nodejs'

import { startPoller }      from '@/lib/dex-poller'
import { getCachedOffchainTokens, getOffchainTokens, startOffchainTokenService } from '@/lib/offchainTokens'

// Start the Nefty candle poller once when this module first loads
startPoller('nefty')
startOffchainTokenService('nefty')

const enc = new TextEncoder()

export async function GET() {
  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        ctrl.enqueue(enc.encode('retry: 30000\n\n'))
        const tokens = (process.env.NODE_ENV === 'production'
          ? await getCachedOffchainTokens('nefty')
          : await getOffchainTokens('nefty')) ?? []
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify(tokens)}\n\n`))
      } catch {
        ctrl.enqueue(enc.encode('event: error\ndata: []\n\n'))
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
      'X-Accel-Buffering':           'no',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
