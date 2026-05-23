export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { getTokensForChain } from '@/lib/serverTokens'

// Consolidated token endpoint — fetches tokens + tickers + pools from Alcor in
// parallel server-side, merges and filters them, and returns a single processed
// payload. Users make 1 request instead of 3, and receive only what the UI needs.

export async function GET(req: NextRequest) {
  const chainId = req.nextUrl.searchParams.get('chain') ?? 'wax'
  const { data, status } = await getTokensForChain(chainId)
  return NextResponse.json(data, { status })
}
