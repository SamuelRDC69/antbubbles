export const runtime = 'edge'

import { NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'
import {
  LOGO_ATLAS_REDIS_KEY,
  type LogoAtlasManifest,
} from '@/lib/logoManifest'

export async function GET() {
  const redis = getRedis()
  if (!redis) return NextResponse.json(null, { status: 503 })

  try {
    const atlas = await redis.get<LogoAtlasManifest>(LOGO_ATLAS_REDIS_KEY)
    if (!atlas?.url) return NextResponse.json(null, { status: 404 })
    return NextResponse.json(atlas, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=3600',
      },
    })
  } catch {
    return NextResponse.json(null, { status: 503 })
  }
}
