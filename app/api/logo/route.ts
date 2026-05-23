export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'

// Server-side logo proxy — avoids CORS and browser rate limits on Alcor's CDN
export async function GET(req: NextRequest) {
  const tokenId = req.nextUrl.searchParams.get('id')
  const chain = req.nextUrl.searchParams.get('chain') ?? 'wax'

  if (!tokenId) {
    return new NextResponse('Missing id', { status: 400 })
  }

  const url = `https://${chain}.alcor.exchange/api/v2/tokens/${tokenId}/logo`

  try {
    const res = await fetch(url, {
      next: { revalidate: 86400 }, // Cache logos for 24 hours server-side
      headers: { 'User-Agent': 'AntBubbles/1.0' },
    })

    if (!res.ok) {
      return new NextResponse(null, { status: res.status })
    }

    const contentType = res.headers.get('content-type') ?? 'image/png'
    const buffer = await res.arrayBuffer()

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        // s-maxage tells Vercel's CDN to cache at the edge — without it every
        // request hits the function even though max-age is set. Logos never
        // change for a given token, so a 7-day edge cache is safe.
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800',
      },
    })
  } catch {
    return new NextResponse(null, { status: 502 })
  }
}
