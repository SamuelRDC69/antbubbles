import { NextRequest, NextResponse } from 'next/server'
import { isAlcorTradingAllowed } from '@/lib/tradingAccess'

export function GET(request: NextRequest) {
  const country = request.headers.get('x-vercel-ip-country')
    ?? request.headers.get('cf-ipcountry')

  return NextResponse.json(
    { allowed: isAlcorTradingAllowed(country) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
