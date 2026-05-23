/**
 * AntBubbles Railway Worker
 * ─────────────────────────
 * Always-on Node.js service deployed on Railway ($5/month plan).
 *
 * Two polling loops run concurrently:
 *
 *   1. Token loop   (every 30 s per chain)
 *      Fetches tokens + tickers + pools from Alcor, merges them into
 *      TokenBubbleData[], tracks rank changes and daily TVL/vol snapshots,
 *      then writes the result to Upstash Redis (TTL 90 s) so Vercel edge
 *      functions can serve fresh data instantly without touching Alcor.
 *
 *   2. Chart loop   (every 5 min, top 30 tokens by 24h volume)
 *      Pre-warms the chart cache for the most popular tokens so modal opens
 *      are instant for all users including mobile (where hover doesn't fire).
 *      Writes both pool candles and ticker charts to Redis with appropriate TTLs.
 *
 * Required env vars (set in Railway):
 *   UPSTASH_REDIS_REST_URL   — from Upstash console
 *   UPSTASH_REDIS_REST_TOKEN — from Upstash console
 */

import { Redis } from '@upstash/redis'
import { mergeTokenData } from '../lib/alcor.js'
import type {
  TokenBubbleData,
  ChainConfig,
  AlcorToken,
  AlcorTicker,
  AlcorPool,
} from '../lib/types.js'

// ── Shared headers for Alcor API (without User-Agent Alcor hangs server requests) ─────

const ALCOR_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
}

// ── Redis client ──────────────────────────────────────────────────────────────

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
})

// ── Chain definitions ─────────────────────────────────────────────────────────
// Duplicated from lib/chains.ts to avoid Next.js-specific imports.

const CHAINS: ChainConfig[] = [
  {
    id: 'wax', name: 'wax', displayName: 'WAX',
    apiBase: 'https://wax.alcor.exchange/api/v2',
    systemToken: 'WAX', systemContract: 'eosio.token',
    explorerBase: 'https://waxblock.io', color: '#f89422',
    nodeUrl: 'https://wax.greymass.com',
  },
  {
    id: 'eos', name: 'eos', displayName: 'EOS',
    apiBase: 'https://eos.alcor.exchange/api/v2',
    systemToken: 'EOS', systemContract: 'eosio.token',
    explorerBase: 'https://eosauthority.com', color: '#3d3d3d',
    nodeUrl: 'https://eos.greymass.com',
  },
  {
    id: 'telos', name: 'telos', displayName: 'Telos',
    apiBase: 'https://telos.alcor.exchange/api/v2',
    systemToken: 'TLOS', systemContract: 'eosio.token',
    explorerBase: 'https://explorer.telos.net', color: '#571aff',
    nodeUrl: 'https://telos.greymass.com',
  },
  {
    id: 'proton', name: 'proton', displayName: 'Proton',
    apiBase: 'https://proton.alcor.exchange/api/v2',
    systemToken: 'XPR', systemContract: 'eosio.token',
    explorerBase: 'https://explorer.xprnetwork.org', color: '#7b3fe4',
    nodeUrl: 'https://proton.greymass.com',
  },
]

// ── Redis key helpers (must match lib/redis.ts) ───────────────────────────────

const KEY = {
  tokens:    (chainId: string) => `tokens:${chainId}`,
  klines:    (key: string)     => `chart:klines:${key}`,
  poolChart: (key: string)     => `chart:pool:${key}`,
}

function chartTtlS(resolution: string): number {
  if (resolution === '1M')  return 24 * 60 * 60
  if (resolution === '1W')  return 12 * 60 * 60
  if (resolution === '1D')  return  6 * 60 * 60
  if (resolution === '240') return 30 * 60
  if (resolution === '60')  return 15 * 60
  return 3 * 60
}

const TOKEN_TTL_S = 90   // worker refreshes every 30 s; 90 s gives a 2× safety margin

// ── Rank & daily-snapshot state (per chain, lives in worker process memory) ───

const RANK_SNAP_TTL_MS = 24 * 60 * 60 * 1000

interface RankSnap {
  ranks: Map<string, number>
  ts:    number
}
const rankSnaps = new Map<string, RankSnap>()

interface DailySnap {
  day:    string
  tokens: Map<string, { tvl: number; vol7d: number; vol30d: number }>
}
const dailySnaps = new Map<string, DailySnap[]>()

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function getDailySnap(chainId: string, daysAgo: number): DailySnap | undefined {
  const snaps = dailySnaps.get(chainId)
  if (!snaps) return undefined
  const target = utcDay(Date.now() - daysAgo * 86_400_000)
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].day <= target) return snaps[i]
  }
  return undefined
}

function recordDailySnap(chainId: string, tokens: TokenBubbleData[], now: number) {
  const today = utcDay(now)
  const snaps = dailySnaps.get(chainId) ?? []
  const latest = snaps[snaps.length - 1]

  if (latest?.day === today) {
    latest.tokens = new Map(tokens.map(t => [t.id, {
      tvl:   t.tvlUsd       ?? 0,
      vol7d: t.volume7dusd  ?? 0,
      vol30d:t.volume30dusd ?? 0,
    }]))
  } else {
    snaps.push({
      day: today,
      tokens: new Map(tokens.map(t => [t.id, {
        tvl:   t.tvlUsd       ?? 0,
        vol7d: t.volume7dusd  ?? 0,
        vol30d:t.volume30dusd ?? 0,
      }])),
    })
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

// ── Token polling loop ────────────────────────────────────────────────────────

async function pollChain(chain: ChainConfig): Promise<TokenBubbleData[] | null> {
  const base = chain.apiBase
  try {
    const [tokensRes, tickersRes, poolsRes] = await Promise.all([
      fetch(`${base}/tokens`,     { signal: AbortSignal.timeout(30_000), headers: ALCOR_HEADERS }),
      fetch(`${base}/tickers`,    { signal: AbortSignal.timeout(30_000), headers: ALCOR_HEADERS }),
      fetch(`${base}/swap/pools`, { signal: AbortSignal.timeout(30_000), headers: ALCOR_HEADERS }),
    ])

    if (!tokensRes.ok || !tickersRes.ok || !poolsRes.ok) {
      console.warn(`[${chain.id}] Alcor returned non-ok:`, {
        tokens: tokensRes.status, tickers: tickersRes.status, pools: poolsRes.status,
      })
      return null
    }

    const [tokens, tickers, pools]: [AlcorToken[], AlcorTicker[], AlcorPool[]] =
      await Promise.all([tokensRes.json(), tickersRes.json(), poolsRes.json()])

    const merged    = mergeTokenData(tokens, tickers, pools, chain)
    const withRanks = merged.map((t, i) => ({ ...t, rank: i + 1 }))

    const now      = Date.now()
    const snap     = rankSnaps.get(chain.id)
    const snap1d   = getDailySnap(chain.id, 1)
    const snap7d   = getDailySnap(chain.id, 7)
    const snap30d  = getDailySnap(chain.id, 30)

    const data: TokenBubbleData[] = withRanks.map(t => ({
      ...t,
      rankChange:   snap?.ranks.has(t.id) ? snap.ranks.get(t.id)! - t.rank : undefined,
      tvlChange24h: snap1d  ? pctChange(t.tvlUsd       ?? 0, snap1d.tokens.get(t.id)?.tvl   ?? 0) : undefined,
      vol7dChange:  snap7d  ? pctChange(t.volume7dusd  ?? 0, snap7d.tokens.get(t.id)?.vol7d  ?? 0) : undefined,
      vol30dChange: snap30d ? pctChange(t.volume30dusd ?? 0, snap30d.tokens.get(t.id)?.vol30d ?? 0) : undefined,
    }))

    if (!snap || now - snap.ts >= RANK_SNAP_TTL_MS) {
      rankSnaps.set(chain.id, {
        ranks: new Map(withRanks.map(t => [t.id, t.rank])),
        ts: now,
      })
    }
    recordDailySnap(chain.id, data, now)

    return data
  } catch (err) {
    console.error(`[${chain.id}] poll error:`, err)
    return null
  }
}

// ── Chart pre-warming loop ────────────────────────────────────────────────────

function roundHour(ms: number): number {
  return Math.floor(ms / (60 * 60 * 1000)) * 60 * 60 * 1000
}

const LINE_WINDOW_MS = 365 * 24 * 60 * 60 * 1000

async function warmPoolChart(
  chain: ChainConfig,
  poolId: number,
  resolution: string,
  from: string,
  to: string,
  reverse: boolean,
): Promise<void> {
  const reverseStr = reverse ? 'true' : ''
  const key        = `pool:${chain.id}:${poolId}:${resolution}:${from}:${to}:${reverseStr}`
  const redisKey   = KEY.poolChart(key)

  // Skip if already warm
  const exists = await redis.exists(redisKey)
  if (exists) return

  const url = new URL(`https://${chain.id}.alcor.exchange/api/v2/swap/pools/${poolId}/candles`)
  url.searchParams.set('resolution', resolution)
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)
  if (reverse) url.searchParams.set('reverse', 'true')

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000), headers: ALCOR_HEADERS })
    if (!res.ok) return
    const data = await res.json()
    await redis.set(redisKey, data, { ex: chartTtlS(resolution) })
  } catch { /* non-fatal */ }
}

async function warmKlines(
  chain: ChainConfig,
  tickerId: string,
  resolution: string,
  from: string,
  to: string,
): Promise<void> {
  const key      = `${chain.id}:${tickerId}:${resolution}:${from}:${to}`
  const redisKey = KEY.klines(key)

  const exists = await redis.exists(redisKey)
  if (exists) return

  const url = new URL(`https://${chain.id}.alcor.exchange/api/v2/tickers/${encodeURIComponent(tickerId)}/charts`)
  url.searchParams.set('resolution', resolution)
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)

  try {
    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(30_000), headers: ALCOR_HEADERS })
    if (!res.ok) return
    const data = await res.json()
    await redis.set(redisKey, data, { ex: chartTtlS(resolution) })
  } catch { /* non-fatal */ }
}

async function warmChartsForChain(chain: ChainConfig, tokens: TokenBubbleData[]) {
  const now  = String(roundHour(Date.now()))
  const from = String(roundHour(Date.now() - LINE_WINDOW_MS))
  const systemTokenId = `${chain.systemToken.toLowerCase()}-${chain.systemContract}`

  // Top 30 by 24h volume — these are the most-clicked bubbles
  const top30 = [...tokens]
    .sort((a, b) => (b.volume24usd ?? 0) - (a.volume24usd ?? 0))
    .slice(0, 30)

  for (const token of top30) {
    const defaultPool = token.pools?.find(p => p.counterpartId === systemTokenId)
      ?? token.pools?.[0]

    if (defaultPool) {
      await warmPoolChart(chain, defaultPool.id, '1D', from, now, defaultPool.reversed ?? false)
    } else if (token.ticker_id) {
      await warmKlines(chain, token.ticker_id, '1D', from, now)
    }

    // Small delay between requests to be a good Alcor citizen
    await new Promise(r => setTimeout(r, 200))
  }
}

// ── Per-chain state machine ───────────────────────────────────────────────────
// Tracks the latest token list so the chart warmer always has fresh data.

const latestTokens = new Map<string, TokenBubbleData[]>()

// ── Main loops ────────────────────────────────────────────────────────────────

const TOKEN_POLL_MS  = 30_000    // 30 s
const CHART_WARM_MS  = 5 * 60_000  // 5 min

async function tokenLoop() {
  console.log(`[worker] token loop starting for ${CHAINS.length} chains`)
  while (true) {
    const start = Date.now()

    await Promise.allSettled(CHAINS.map(async chain => {
      const data = await pollChain(chain)
      if (!data) return

      latestTokens.set(chain.id, data)

      try {
        await redis.set(KEY.tokens(chain.id), data, { ex: TOKEN_TTL_S })
        console.log(`[${chain.id}] wrote ${data.length} tokens to Redis`)
      } catch (err) {
        console.error(`[${chain.id}] Redis write failed:`, err)
      }
    }))

    const elapsed = Date.now() - start
    const wait    = Math.max(0, TOKEN_POLL_MS - elapsed)
    await new Promise(r => setTimeout(r, wait))
  }
}

async function chartWarmLoop() {
  // Stagger slightly so token loop has time to populate latestTokens on startup
  await new Promise(r => setTimeout(r, 15_000))
  console.log('[worker] chart warm loop starting')

  while (true) {
    const start = Date.now()

    await Promise.allSettled(CHAINS.map(async chain => {
      const tokens = latestTokens.get(chain.id)
      if (!tokens || tokens.length === 0) return
      console.log(`[${chain.id}] warming charts for top 30 tokens…`)
      await warmChartsForChain(chain, tokens)
      console.log(`[${chain.id}] chart warm done`)
    }))

    const elapsed = Date.now() - start
    const wait    = Math.max(0, CHART_WARM_MS - elapsed)
    await new Promise(r => setTimeout(r, wait))
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log('[worker] starting AntBubbles worker…')
console.log('[worker] Redis URL:', process.env.UPSTASH_REDIS_REST_URL?.slice(0, 40) + '…')

// Verify Redis connectivity before entering loops
try {
  await redis.ping()
  console.log('[worker] Redis ping OK')
} catch (err) {
  console.error('[worker] FATAL: Redis not reachable', err)
  process.exit(1)
}

// Run both loops concurrently (they never resolve)
await Promise.all([tokenLoop(), chartWarmLoop()])
