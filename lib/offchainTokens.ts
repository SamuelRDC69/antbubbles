import fs from 'fs'
import path from 'path'

import { CHAINS } from './chains'
import { getRedis, REDIS_KEYS, TOKEN_TTL_S } from './redis'
import { getTokensForChain } from './serverTokens'
import { fetchNeftyTokens } from './nefty'
import { fetchTacoTokens } from './taco'
import type { TokenBubbleData } from './types'

export type OffchainDex = 'taco' | 'nefty'

const FRESH_MS = 30_000
const STALE_MS = 5 * 60_000
const REFRESH_MS = 60_000
const SNAPSHOT_PATH = path.join(process.cwd(), '.offchain-token-snapshots.json')
const ALCOR_MCAP_TTL_MS = 30 * 60_000
const HISTORY_KEEP_DAYS = 62

interface CacheEntry {
  data: TokenBubbleData[]
  ts: number
}

interface DailyTokenStats {
  volume24usd: number
  tvlUsd: number
}

interface DailySnap {
  day: string
  tokens: Record<string, DailyTokenStats>
}

interface SnapshotFile {
  taco?: CacheEntry
  nefty?: CacheEntry
  history?: Partial<Record<OffchainDex, DailySnap[]>>
}

interface AlcorMarketCapEntry {
  supply: number
  marketCapUsd: number
}

const memoryCache = new Map<OffchainDex, CacheEntry>()
const inflight = new Map<OffchainDex, Promise<TokenBubbleData[]>>()
const refreshers = new Map<OffchainDex, ReturnType<typeof setInterval>>()
const dailySnaps = new Map<OffchainDex, DailySnap[]>()

let diskLoaded = false
let alcorMcapCache: { ts: number; map: Map<string, AlcorMarketCapEntry> } | null = null
let alcorMcapInflight: Promise<Map<string, AlcorMarketCapEntry>> | null = null

const loaders: Record<OffchainDex, () => Promise<TokenBubbleData[]>> = {
  taco: fetchTacoTokens,
  nefty: fetchNeftyTokens,
}

function now() {
  return Date.now()
}

function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function pctChange(current: number, previous: number): number | undefined {
  if (previous <= 0 || current <= 0) return undefined
  return (current - previous) / previous * 100
}

function isFresh(entry: CacheEntry | undefined): boolean {
  return !!entry && now() - entry.ts < FRESH_MS
}

function isUsable(entry: CacheEntry | undefined): boolean {
  return !!entry && entry.data.length > 0 && now() - entry.ts < STALE_MS
}

function loadDiskSnapshots(): void {
  if (diskLoaded) return
  diskLoaded = true

  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8')
    const parsed = JSON.parse(raw) as SnapshotFile

    for (const dex of ['taco', 'nefty'] as const) {
      const entry = parsed[dex]
      if (entry && Array.isArray(entry.data) && typeof entry.ts === 'number' && entry.data.length > 0) {
        memoryCache.set(dex, entry)
      }

      const history = parsed.history?.[dex]
      if (Array.isArray(history) && history.length > 0) {
        dailySnaps.set(dex, history)
      }
    }
  } catch {
    // Ignore corrupt disk snapshots; live refresh will rebuild them.
  }
}

function saveDiskSnapshots(): void {
  try {
    const payload: SnapshotFile = {
      history: {},
    }
    for (const dex of ['taco', 'nefty'] as const) {
      const entry = memoryCache.get(dex)
      if (entry && entry.data.length > 0) payload[dex] = entry
      const history = dailySnaps.get(dex)
      if (history && history.length > 0) payload.history![dex] = history
    }
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(payload))
  } catch {
    // Disk persistence is best-effort only.
  }
}

function recordDailySnap(dex: OffchainDex, tokens: TokenBubbleData[], ts: number): void {
  const day = utcDay(ts)
  const snaps = dailySnaps.get(dex) ?? []
  const latest = snaps[snaps.length - 1]

  const tokenStats: Record<string, DailyTokenStats> = {}
  for (const token of tokens) {
    tokenStats[token.id] = {
      volume24usd: token.volume24usd ?? 0,
      tvlUsd: token.tvlUsd ?? 0,
    }
  }

  if (latest?.day === day) {
    latest.tokens = tokenStats
  } else {
    snaps.push({ day, tokens: tokenStats })
    const cutoff = utcDay(ts - HISTORY_KEEP_DAYS * 86_400_000)
    while (snaps.length > 0 && snaps[0].day < cutoff) snaps.shift()
    dailySnaps.set(dex, snaps)
  }

  if (!dailySnaps.has(dex)) dailySnaps.set(dex, snaps)
}

function getDailySnap(dex: OffchainDex, daysAgo: number): DailySnap | undefined {
  const snaps = dailySnaps.get(dex)
  if (!snaps) return undefined
  const target = utcDay(Date.now() - daysAgo * 86_400_000)
  return findSnapOnOrBefore(snaps, target)
}

function findSnapOnOrBefore(snaps: DailySnap[], targetDay: string): DailySnap | undefined {
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].day <= targetDay) return snaps[i]
  }
  return undefined
}

function sumWindow(snaps: DailySnap[] | undefined, startDaysAgo: number, endDaysAgo: number, tokenId: string): number | undefined {
  if (!snaps || snaps.length === 0) return undefined

  let total = 0
  let count = 0
  for (let daysAgo = startDaysAgo; daysAgo <= endDaysAgo; daysAgo++) {
    const target = utcDay(Date.now() - daysAgo * 86_400_000)
    const snap = findSnapOnOrBefore(snaps, target)
    const value = snap?.tokens[tokenId]?.volume24usd
    if (typeof value === 'number' && value > 0) {
      total += value
      count++
    }
  }

  return count > 0 ? total : undefined
}

function enrichWithHistory(dex: OffchainDex, tokens: TokenBubbleData[]): TokenBubbleData[] {
  const snaps = dailySnaps.get(dex)
  const prev1d = getDailySnap(dex, 1)

  return tokens.map((token) => {
    const previousDay = prev1d?.tokens[token.id]
    const volume7dusd = sumWindow(snaps, 0, 6, token.id)
    const previous7 = sumWindow(snaps, 7, 13, token.id)
    const volume30dusd = sumWindow(snaps, 0, 29, token.id)
    const previous30 = sumWindow(snaps, 30, 59, token.id)

    return {
      ...token,
      volume7dusd,
      volume30dusd,
      tvlChange24h: previousDay ? pctChange(token.tvlUsd ?? 0, previousDay.tvlUsd) : token.tvlChange24h,
      vol24hChange: previousDay ? pctChange(token.volume24usd ?? 0, previousDay.volume24usd) : token.vol24hChange,
      vol7dChange: volume7dusd !== undefined && previous7 !== undefined ? pctChange(volume7dusd, previous7) : token.vol7dChange,
      vol30dChange: volume30dusd !== undefined && previous30 !== undefined ? pctChange(volume30dusd, previous30) : token.vol30dChange,
    }
  })
}

async function fetchSupplyMap(tokens: TokenBubbleData[]): Promise<Map<string, number>> {
  const refs = tokens.map((t) => ({ id: t.id, contract: t.contract, symbol: t.symbol }))
  const nodeUrl = CHAINS.wax.nodeUrl

  async function getSupply(contract: string, symbol: string): Promise<number | null> {
    try {
      const res = await fetch(`${nodeUrl}/v1/chain/get_table_rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: contract,
          scope: symbol.toUpperCase(),
          table: 'stat',
          json: true,
          limit: 1,
        }),
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) return null
      const json = await res.json()
      const raw: string | undefined = json.rows?.[0]?.supply
      return raw ? parseFloat(raw) : null
    } catch {
      return null
    }
  }

  const results = await Promise.all(refs.map((t) => getSupply(t.contract, t.symbol)))
  const map = new Map<string, number>()
  results.forEach((supply, i) => {
    if (supply !== null) map.set(refs[i].id, supply)
  })
  return map
}

async function getAlcorWaxMarketCaps(): Promise<Map<string, AlcorMarketCapEntry>> {
  const hit = alcorMcapCache
  if (hit && now() - hit.ts < ALCOR_MCAP_TTL_MS) return hit.map
  if (alcorMcapInflight) return alcorMcapInflight

  alcorMcapInflight = (async () => {
    const { data } = await getTokensForChain('wax')
    const supplyMap = await fetchSupplyMap(data)
    const map = new Map<string, AlcorMarketCapEntry>()
    for (const token of data) {
      const supply = supplyMap.get(token.id)
      if (supply === undefined) continue
      map.set(token.id, {
        supply,
        marketCapUsd: supply * token.usd_price,
      })
    }
    alcorMcapCache = { ts: now(), map }
    return map
  })().finally(() => {
    alcorMcapInflight = null
  })

  return alcorMcapInflight
}

async function enrichOffchainTokens(dex: OffchainDex, tokens: TokenBubbleData[]): Promise<TokenBubbleData[]> {
  const [alcorMcapMap] = await Promise.all([
    getAlcorWaxMarketCaps().catch(() => new Map<string, AlcorMarketCapEntry>()),
  ])

  const merged = tokens.map((token) => {
    const alcor = alcorMcapMap.get(token.id)
    if (!alcor) return token
    return {
      ...token,
      supply: alcor.supply,
      marketCapUsd: alcor.marketCapUsd,
    }
  })

  recordDailySnap(dex, merged, now())
  return enrichWithHistory(dex, merged)
}

async function persistRedis(dex: OffchainDex, data: TokenBubbleData[]): Promise<void> {
  const redis = getRedis()
  if (!redis) return
  try {
    await redis.set(REDIS_KEYS.offchainTokens(dex), data, { ex: TOKEN_TTL_S })
  } catch {
    // Ignore Redis write failures; memory/disk snapshots still work.
  }
}

async function hydrateFromRedis(dex: OffchainDex): Promise<CacheEntry | null> {
  const redis = getRedis()
  if (!redis) return null
  try {
    const cached = await redis.get<TokenBubbleData[]>(REDIS_KEYS.offchainTokens(dex))
    if (Array.isArray(cached) && cached.length > 0) {
      const data = process.env.NODE_ENV === 'production'
        ? cached
        : await enrichOffchainTokens(dex, cached)
      const entry = { data, ts: now() }
      memoryCache.set(dex, entry)
      saveDiskSnapshots()
      return entry
    }
  } catch {
    // Ignore Redis read failures and fall through to disk / live rebuild.
  }
  return null
}

export async function refreshOffchainTokens(dex: OffchainDex): Promise<TokenBubbleData[]> {
  const active = inflight.get(dex)
  if (active) return active

  const p = loaders[dex]()
    .then((data) => enrichOffchainTokens(dex, data))
    .then(async (data) => {
      const entry = { data, ts: now() }
      memoryCache.set(dex, entry)
      saveDiskSnapshots()
      await persistRedis(dex, data)
      return data
    })
    .finally(() => inflight.delete(dex))

  inflight.set(dex, p)
  return p
}

export function startOffchainTokenService(dex: OffchainDex): void {
  loadDiskSnapshots()

  if (!refreshers.has(dex)) {
    const timer = setInterval(() => {
      void refreshOffchainTokens(dex)
    }, REFRESH_MS)
    refreshers.set(dex, timer)
  }

  const entry = memoryCache.get(dex)
  if (!isFresh(entry) && !inflight.has(dex)) {
    void hydrateFromRedis(dex).then((redisEntry) => {
      if (!isFresh(redisEntry ?? undefined)) {
        void refreshOffchainTokens(dex)
      }
    })
  }
}

export async function getCachedOffchainTokens(dex: OffchainDex): Promise<TokenBubbleData[] | null> {
  loadDiskSnapshots()

  const mem = memoryCache.get(dex)
  if (isFresh(mem)) return mem!.data

  if (isUsable(mem)) {
    if (!inflight.has(dex)) void refreshOffchainTokens(dex)
    return mem!.data
  }

  const redisEntry = await hydrateFromRedis(dex)
  if (isUsable(redisEntry ?? undefined)) {
    if (!isFresh(redisEntry ?? undefined) && !inflight.has(dex)) void refreshOffchainTokens(dex)
    return redisEntry!.data
  }

  return null
}

export async function getOffchainTokens(dex: OffchainDex): Promise<TokenBubbleData[]> {
  const cached = await getCachedOffchainTokens(dex)
  if (cached) return cached
  return refreshOffchainTokens(dex)
}
