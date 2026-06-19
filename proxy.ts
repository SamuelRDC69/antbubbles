import { NextRequest, NextResponse } from 'next/server'

// Runs at the edge on every request before it hits a page or API route.
// Adds security headers + rate limiting on API routes.
// Named "proxy" per Next.js 16 convention (renamed from "middleware" in v16).

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Only active when UPSTASH_REDIS_REST_URL is set (i.e. production on Vercel).
// Falls back to a no-op in local dev so no Upstash account is needed.
// Setup: https://console.upstash.com → create Redis DB → add env vars:
//   UPSTASH_REDIS_REST_URL=...
//   UPSTASH_REDIS_REST_TOKEN=...

let ratelimit: null | { limit(id: string): Promise<{ success: boolean; limit: number; remaining: number }> } = null

async function getRatelimit() {
  if (ratelimit !== null) return ratelimit
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    // No Upstash configured — allow all traffic (dev/preview)
    ratelimit = { limit: async () => ({ success: true, limit: 0, remaining: 0 }) }
    return ratelimit
  }
  // Lazy-import so the edge bundle only pays this cost when env vars are present
  const [{ Ratelimit }, { Redis }] = await Promise.all([
    import('@upstash/ratelimit'),
    import('@upstash/redis'),
  ])
  ratelimit = new Ratelimit({
    redis:    Redis.fromEnv(),
    // 100 requests per minute per IP — generous for a real user, tight for a scraper
    limiter:  Ratelimit.slidingWindow(100, '1 m'),
    analytics: true,
    prefix:   'abt:rl',
  })
  return ratelimit
}

// ── Proxy ──────────────────────────────────────────────────────────────────────
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl

  // Rate-limit our API routes only
  // Logos are immutable CDN assets and load in a large initial burst. Counting
  // them against the API data limit causes valid image requests to be throttled.
  if (
    pathname.startsWith('/api/')
    && pathname !== '/api/logo'
    && pathname !== '/api/logo-atlas'
  ) {
    const ip  = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '127.0.0.1'
    const rl  = await getRatelimit()
    const { success, limit, remaining } = await rl.limit(ip)

    if (!success) {
      return new NextResponse('Too Many Requests', {
        status:  429,
        headers: {
          'Content-Type':          'text/plain',
          'Retry-After':           '60',
          'X-RateLimit-Limit':     String(limit),
          'X-RateLimit-Remaining': '0',
        },
      })
    }

    const res = NextResponse.next()
    addSecurityHeaders(res)
    res.headers.set('X-RateLimit-Limit',     String(limit))
    res.headers.set('X-RateLimit-Remaining', String(remaining))
    return res
  }

  const res = NextResponse.next()
  addSecurityHeaders(res)
  return res
}

function addSecurityHeaders(res: NextResponse) {
  const h = res.headers

  h.set('X-Frame-Options',         'DENY')
  h.set('X-Content-Type-Options',  'nosniff')
  h.set('Referrer-Policy',         'strict-origin-when-cross-origin')
  h.set('Permissions-Policy',      'camera=(), microphone=(), geolocation=(), payment=()')
  h.set('X-DNS-Prefetch-Control',  'on')

  if (process.env.NODE_ENV === 'production') {
    h.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  }
}

// Apply to everything except Next.js internals and static files
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
