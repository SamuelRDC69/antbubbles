import type { Redis } from '@upstash/redis'
import type { TokenBubbleData } from '../lib/types.js'

const SAMPLE_INTERVAL_MS = 10 * 60_000
const HISTORY_WINDOW_MS = 30 * 60 * 60_000
const TARGET_24H_MS = 24 * 60 * 60_000
const MIN_BASELINE_AGE_MS = 20 * 60 * 60_000

interface PriceSample {
  ts: number
  price: number
}

export interface PriceHistory {
  samples: Record<string, PriceSample[]>
  lastValidChange: Record<string, number>
}

const emptyHistory = (): PriceHistory => ({ samples: {}, lastValidChange: {} })
const redisKey = (dex: 'taco' | 'nefty') => `prices:history:${dex}:v1`

export async function loadPriceHistory(
  redis: Redis,
  dex: 'taco' | 'nefty',
): Promise<PriceHistory> {
  try {
    return await redis.get<PriceHistory>(redisKey(dex)) ?? emptyHistory()
  } catch {
    return emptyHistory()
  }
}

export function applyPersistentPriceHistory(
  tokens: TokenBubbleData[],
  history: PriceHistory,
  now = Date.now(),
): TokenBubbleData[] {
  const cutoff = now - HISTORY_WINDOW_MS
  const target = now - TARGET_24H_MS

  return tokens.map((token) => {
    const samples = (history.samples[token.id] ?? [])
      .filter((sample) => sample.ts >= cutoff && sample.price > 0)

    const latest = samples[samples.length - 1]
    if (
      token.usd_price > 0
      && (!latest || now - latest.ts >= SAMPLE_INTERVAL_MS)
    ) {
      samples.push({ ts: now, price: token.usd_price })
    }
    history.samples[token.id] = samples

    let change24: number | undefined
    const eligible = samples.filter((sample) =>
      sample.ts <= target && now - sample.ts >= MIN_BASELINE_AGE_MS
    )
    const baseline = eligible[eligible.length - 1]
    if (baseline?.price && token.usd_price > 0) {
      change24 = (token.usd_price - baseline.price) / baseline.price * 100
    } else if (Number.isFinite(token.change24) && token.change24 !== 0) {
      change24 = token.change24
    } else {
      change24 = history.lastValidChange[token.id]
    }

    if (change24 !== undefined && Number.isFinite(change24)) {
      history.lastValidChange[token.id] = change24
      return { ...token, change24 }
    }
    return token
  })
}

export async function persistPriceHistory(
  redis: Redis,
  dex: 'taco' | 'nefty',
  history: PriceHistory,
): Promise<void> {
  await redis.set(redisKey(dex), history, { ex: 72 * 60 * 60 })
}
