export const runtime = 'nodejs'

import { NextResponse } from 'next/server'
import { getCachedOffchainTokens, getOffchainTokens, startOffchainTokenService } from '@/lib/offchainTokens'

startOffchainTokenService('taco')

export async function GET() {
  try {
    const tokens = (process.env.NODE_ENV === 'production'
      ? await getCachedOffchainTokens('taco')
      : await getOffchainTokens('taco')) ?? []
    return NextResponse.json(tokens, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
      },
    })
  } catch (err) {
    console.error('taco-tokens error:', err)
    return NextResponse.json([], { status: 500 })
  }
}
