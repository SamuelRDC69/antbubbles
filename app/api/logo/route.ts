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
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
      },
    })
  } catch {
    return new NextResponse(null, { status: 502 })
  }
}
