// Server-only utility — do NOT import from client components.
// Called by both /api/tokens (REST) and /api/stream (SSE) so they share the
// same in-process cache and Vercel Data Cache entries.

import { CHAINS } from './chains'
import { mergeTokenData } from './alcor'
import { TokenBubbleData } from './types'
import { AlcorToken, AlcorTicker, AlcorPool } from './types'

const TTL_MS = 30_000
const TTL_S  = 30

// ── Rank snapshot ─────────────────────────────────────────────────────────────
// Saved once per 24 h per chain. Compared against current ranks to derive
// rankChange (positive = moved up the leaderboard, negative = moved down).
const RANK_SNAP_TTL = 24 * 60 * 60 * 1000

interface RankSnap {
  ranks: Map<string, number>   // tokenId → rank at snapshot time
  ts:    number
}

const rankSnaps = new Map<string, RankSnap>()   // per chainId

// ── Rolling daily snapshot (30-day history) ───────────────────────────────────
// One entry per UTC day. Keyed by ISO date string ("2026-05-21").
// Kept for 30 days; older entries are pruned on each write.
// Provides baselines for TVL 24h Δ, Vol7D Δ, Vol30D Δ.

interface DailySnap {
  day:    string                                        // "YYYY-MM-DD"
  tokens: Map<string, { tvl: number; vol7d: number; vol30d: number }>
}

// Per chainId: sorted array of daily snaps, newest last
const dailySnaps = new Map<string, DailySnap[]>()

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)   // "YYYY-MM-DD"
}

function getDailySnap(chainId: string, daysAgo: number): DailySnap | undefined {
  const snaps = dailySnaps.get(chainId)
  if (!snaps) return undefined
  const target = utcDay(Date.now() - daysAgo * 86_400_000)
  // Walk backwards — most recent first
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].day <= target) return snaps[i]
  }
  return undefined
}

function recordDailySnap(
  chainId: string,
  tokens:  TokenBubbleData[],
  now:     number,
) {
  const today  = utcDay(now)
  const snaps  = dailySnaps.get(chainId) ?? []
  const latest = snaps[snaps.length - 1]

  if (latest?.day === today) {
    // Update today's entry with fresher data
    latest.tokens = new Map(
      tokens.map(t => [t.id, {
        tvl:   t.tvlUsd       ?? 0,
        vol7d: t.volume7dusd  ?? 0,
        vol30d:t.volume30dusd ?? 0,
      }])
    )
  } else {
    // New day — append
    snaps.push({
      day: today,
      tokens: new Map(
        tokens.map(t => [t.id, {
          tvl:   t.tvlUsd       ?? 0,
          vol7d: t.volume7dusd  ?? 0,
          vol30d:t.volume30dusd ?? 0,
        }])
      ),
    })
    // Prune entries older than 31 days
    const cutoff = utcDay(now - 31 * 86_400_000)
    while (snaps.length > 0 && snaps[0].day < cutoff) snaps.shift()
    dailySnaps.set(chainId, snaps)
  }
  if (!dailySnaps.has(chainId)) dailySnaps.set(chainId, snaps)
}

function pctChange(current: number, previous: number): number | undefined {
  if (previous <= 0 || current <= 0) return undefined
  return (current - previous) / previous * 100
}

const cache = new Map<string, { data: TokenBubbleData[]; ts: number }>()

export async function getTokensForChain(chainId: string): Promise<{
  data:   TokenBubbleData[]
  status: number
}> {
  const chain = CHAINS[chainId]
  if (!chain) return { data: [], status: 400 }

  const hit = cache.get(chainId)
  if (hit && Date.now() - hit.ts < TTL_MS) return { data: hit.data as TokenBubbleData[], status: 200 }

  const base = chain.apiBase

  try {
    const nextFetchInit = { next: { revalidate: TTL_S } } as RequestInit & { next: { revalidate: number } }

    const [tokensRes, tickersRes, poolsRes] = await Promise.all([
      fetch(`${base}/tokens`,     { signal: AbortSignal.timeout(15_000), ...nextFetchInit }),
      fetch(`${base}/tickers`,    { signal: AbortSignal.timeout(15_000), ...nextFetchInit }),
      // pools response can be >2 MB so Vercel Data Cache can't store it — rely on L1 Map only
      fetch(`${base}/swap/pools`, { signal: AbortSignal.timeout(15_000) }),
    ])

    if (!tokensRes.ok || !tickersRes.ok || !poolsRes.ok) {
      // Return stale data if available
      if (hit) return { data: hit.data as TokenBubbleData[], status: 200 }
      return { data: [], status: 502 }
    }

    const [tokens, tickers, pools]: [AlcorToken[], AlcorTicker[], AlcorPool[]] = await Promise.all([
      tokensRes.json(),
      tickersRes.json(),
      poolsRes.json(),
    ])

    const merged    = mergeTokenData(tokens, tickers, pools, chain)
    const withRanks = merged.map((t, i) => ({ ...t, rank: i + 1 }))

    // ── Rank change ────────────────────────────────────────────────────────
    const snap = rankSnaps.get(chainId)
    const now  = Date.now()

    // ── Daily snapshot lookups ──────────────────────────────────────────────
    const snap1d  = getDailySnap(chainId, 1)    // yesterday  → TVL 24h Δ
    const snap7d  = getDailySnap(chainId, 7)    // 7 days ago → Vol7D Δ
    const snap30d = getDailySnap(chainId, 30)   // 30 days ago→ Vol30D Δ

    // Annotate each token with its rank delta vs the last snapshot.
    // rankChange > 0  → moved UP  (lower rank number = better)
    // rankChange < 0  → moved DOWN
    // rankChange === 0 → unchanged
    const data: TokenBubbleData[] = withRanks.map(t => {
      const prev1d  = snap1d?.tokens.get(t.id)
      const prev7d  = snap7d?.tokens.get(t.id)
      const prev30d = snap30d?.tokens.get(t.id)
      return {
        ...t,
        rankChange:   snap?.ranks.has(t.id) ? snap.ranks.get(t.id)! - t.rank : undefined,
        tvlChange24h: prev1d  ? pctChange(t.tvlUsd       ?? 0, prev1d.tvl)   : undefined,
        vol7dChange:  prev7d  ? pctChange(t.volume7dusd  ?? 0, prev7d.vol7d)  : undefined,
        vol30dChange: prev30d ? pctChange(t.volume30dusd ?? 0, prev30d.vol30d): undefined,
      }
    })

    // Update the rank snapshot once every 24 h
    if (!snap || now - snap.ts >= RANK_SNAP_TTL) {
      rankSnaps.set(chainId, {
        ranks: new Map(withRanks.map(t => [t.id, t.rank])),
        ts:    now,
      })
    }

    // Record daily snapshot (updates today's entry on every cache refresh)
    recordDailySnap(chainId, data, now)

    cache.set(chainId, { data, ts: now })
    return { data, status: 200 }
  } catch {
    if (hit) return { data: hit.data as TokenBubbleData[], status: 200 }
    return { data: [], status: 504 }
  }
}
