export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { CHAINS } from '@/lib/chains'
import { resolveAlcorGithubLogoUrl } from '@/lib/tokenLogos'

function fallbackSvg(symbol: string): string {
  const label = symbol.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase() || '?'
  let hash = 0
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const hue = hash % 360
  const hueEnd = (hue + 36) % 360
  const fontSize = label.length > 4 ? 15 : label.length > 3 ? 18 : label.length > 2 ? 21 : 25
  return `<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="g" x1="8" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
        <stop stop-color="hsl(${hue} 72% 58%)"/>
        <stop offset="1" stop-color="hsl(${hueEnd} 72% 34%)"/>
      </linearGradient>
    </defs>
    <circle cx="32" cy="32" r="29" fill="url(#g)"/>
    <circle cx="32" cy="32" r="27.5" fill="none" stroke="white" stroke-opacity=".28"/>
    <text x="32" y="33" fill="white" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="central">${label}</text>
  </svg>`
}

// Server-side logo proxy — avoids CORS and browser rate limits on Alcor's CDN
export async function GET(req: NextRequest) {
  const tokenId = req.nextUrl.searchParams.get('id')
  const chain = req.nextUrl.searchParams.get('chain') ?? 'wax'

  if (!tokenId) {
    return new NextResponse('Missing id', { status: 400 })
  }

  const dash = tokenId.indexOf('-')
  if (dash > 0) {
    const symbol = tokenId.slice(0, dash)
    const contract = tokenId.slice(dash + 1)
    const chainConfig = CHAINS[chain] ?? CHAINS.wax
    try {
      const githubUrl = await resolveAlcorGithubLogoUrl(chainConfig, { symbol, contract })
      const logo = await fetch(githubUrl, {
        signal: AbortSignal.timeout(5_000),
        next: { revalidate: 24 * 60 * 60 },
      })
      if (logo.ok) {
        return new NextResponse(logo.body, {
          status: 200,
          headers: {
            'Content-Type': logo.headers.get('content-type') ?? 'image/png',
            'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800',
          },
        })
      }
    } catch {
      // Fall through to Alcor's runtime logo endpoint.
    }
  }

  const url = `https://${chain}.alcor.exchange/api/v2/tokens/${tokenId}/logo`

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8_000),
      next: { revalidate: 86400 },
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
    })

    if (!res.ok) throw new Error(`Alcor logo returned ${res.status}`)

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
    const symbol = dash > 0 ? tokenId.slice(0, dash) : tokenId
    return new NextResponse(fallbackSvg(symbol), {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800',
      },
    })
  }
}
