// Upstash Redis client — shared by all Vercel API routes.
// HTTP-based: works in edge runtime, Node.js, and the Railway worker.
// Gracefully returns null when env vars are absent (local dev without Redis).

import { Redis } from '@upstash/redis'

let _redis: Redis | null = null

export function getRedis(): Redis | null {
  if (_redis) return _redis
  const url   = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  _redis = new Redis({ url, token })
  return _redis
}

// ── Key helpers ───────────────────────────────────────────────────────────────
// Single source of truth so worker and API routes always agree on key format.
export const REDIS_KEYS = {
  tokens:    (chainId: string) => `tokens:${chainId}`,
  offchainTokens: (dex: string) => `tokens:${dex}`,
  offchainChart: (dex: string, tokenId: string, resolution: number) => `chart:offchain:${dex}:${tokenId}:${resolution}`,
  klines:    (key: string)     => `chart:klines:${key}`,
  klinesLatest: (chainId: string, tickerId: string, resolution: string) =>
    `chart:klines:latest:${chainId}:${tickerId}:${resolution}`,
  poolChart: (key: string)     => `chart:pool:${key}`,
  poolChartLatest: (chainId: string, poolId: string | number, resolution: string, reverse: string | boolean) =>
    `chart:pool:latest:${chainId}:${poolId}:${resolution}:${String(reverse)}`,
}

// ── TTL helpers ───────────────────────────────────────────────────────────────
// Historical daily candles don't change — cache aggressively.
export function chartTtlS(resolution: string): number {
  if (resolution === '1M')  return 24 * 60 * 60   // 24 h
  if (resolution === '1W')  return 12 * 60 * 60   // 12 h
  if (resolution === '1D')  return  6 * 60 * 60   //  6 h
  if (resolution === '240') return 30 * 60         // 30 min
  if (resolution === '60')  return 15 * 60         // 15 min
  return 3 * 60                                    //  3 min
}

export const TOKEN_TTL_S = 90   // 90 s — worker refreshes every 30 s
