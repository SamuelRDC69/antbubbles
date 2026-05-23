// Server component — no 'use client'.
// Next.js renders this on the server with real token data already embedded in
// the HTML. Users see the bubble chart immediately with no loading screen.
//
// revalidate: 30 enables ISR — the page is regenerated in the background every
// 30 seconds so cached HTML is always fresh. On Vercel this means every visitor
// gets a pre-built page; the loading state only appears when switching chains.

import { DEFAULT_CHAIN } from '@/lib/chains'
import { getTokensForChain } from '@/lib/serverTokens'
import HomeClient from '@/components/HomeClient'

export const revalidate = 30

export default async function Page() {
  const { data: initialTokens } = await getTokensForChain(DEFAULT_CHAIN)
  return <HomeClient initialTokens={initialTokens} />
}
