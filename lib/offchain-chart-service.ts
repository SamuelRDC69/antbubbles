import { buildOffchainWaxCandles } from './offchain-chart'
import { buildOffchainVolumeMapUsd } from './offchain-volume'
import { getWaxUsdPrice } from './taco'
import { queryCandles, type Candle, type Resolution } from './taco-db'
import type { DexId } from './dex-contracts'
import type { OffchainChartStep } from './types'

const VALID_RESOLUTIONS = new Set([60, 300, 900, 1800, 3600, 14400, 86400, 604800])
const VOLUME_TIMEOUT_MS = 1500

export const OFFCHAIN_CHART_WINDOWS_MS: Partial<Record<Resolution, number>> = {
  60: 2 * 24 * 60 * 60 * 1000,
  300: 10 * 24 * 60 * 60 * 1000,
  900: 21 * 24 * 60 * 60 * 1000,
  1800: 42 * 24 * 60 * 60 * 1000,
  3600: 120 * 24 * 60 * 60 * 1000,
  14400: 540 * 24 * 60 * 60 * 1000,
}

export interface OffchainChartPoint {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface OffchainChartRequest {
  pair?: string | null
  path?: string | null
  symbol?: string | null
  resolution?: string | number | null
  from?: string | number | null
  to?: string | number | null
}

function withTimeout<T>(promise: Promise<T>, fallback: T, timeoutMs = VOLUME_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ])
}

export function parsePath(pathParam: string | null | undefined, pair: string): OffchainChartStep[] {
  let path: OffchainChartStep[] = []

  if (pathParam) {
    try {
      const parsed = JSON.parse(pathParam) as unknown
      if (Array.isArray(parsed)) {
        path = parsed.filter((step): step is OffchainChartStep =>
          !!step &&
          typeof step === 'object' &&
          typeof step.pairId === 'string' &&
          typeof step.invert === 'boolean'
        )
      }
    } catch {
      path = []
    }
  }

  if (path.length === 0 && pair) path = [{ pairId: pair, invert: false }]
  return path
}

export function parseOffchainChartRequest(request: OffchainChartRequest) {
  const pair = request.pair ?? ''
  const path = parsePath(request.path, pair)
  const symbol = request.symbol ?? ''
  const resolution = Number(request.resolution ?? 3600) as Resolution
  const fromRaw = Number(request.from ?? 0)
  const toRaw = Number(request.to ?? Date.now())

  if (!VALID_RESOLUTIONS.has(resolution) || path.length === 0) {
    return null
  }

  const fromSec = fromRaw > 1e10 ? Math.floor(fromRaw / 1000) : fromRaw
  const toSec = toRaw > 1e10 ? Math.floor(toRaw / 1000) : toRaw

  return { pair, path, symbol, resolution, fromSec, toSec }
}

export function buildOffchainPriceCandlesRaw(
  dex: DexId,
  request: OffchainChartRequest,
): Candle[] {
  const parsed = parseOffchainChartRequest(request)
  if (!parsed) return []

  const { path, resolution, fromSec, toSec } = parsed
  return path.length === 1
    ? queryCandles(dex, path[0].pairId, resolution, fromSec, toSec)
    : buildOffchainWaxCandles(dex, path, resolution, fromSec, toSec)
}

export function filterRawCandles(
  candles: Candle[],
  request: OffchainChartRequest,
): Candle[] {
  const parsed = parseOffchainChartRequest(request)
  if (!parsed) return []
  const { fromSec, toSec } = parsed
  return candles.filter((c) => c.time >= fromSec && c.time <= toSec)
}

export async function buildUsdChartDataFromRawCandles(
  dex: DexId,
  request: OffchainChartRequest,
  candles: Candle[],
): Promise<OffchainChartPoint[]> {
  const parsed = parseOffchainChartRequest(request)
  if (!parsed) return []

  const { path, symbol, resolution, fromSec, toSec } = parsed

  const [volumeByBucket, waxUsd] = await Promise.all([
    withTimeout(
      buildOffchainVolumeMapUsd(dex, path[0].pairId, symbol, resolution, fromSec, toSec, candles)
        .catch(() => new Map<number, number>()),
      new Map<number, number>(),
    ),
    getWaxUsdPrice(),
  ])

  return candles.map((c) => ({
    time: c.time * 1000,
    open: c.open * waxUsd,
    high: c.high * waxUsd,
    low: c.low * waxUsd,
    close: c.close * waxUsd,
    volume: (volumeByBucket.get(c.time) ?? 0) * waxUsd,
  }))
}

export async function buildOffchainChartData(
  dex: DexId,
  request: OffchainChartRequest,
): Promise<OffchainChartPoint[]> {
  const parsed = parseOffchainChartRequest(request)
  if (!parsed) return []

  const { path, symbol, resolution, fromSec, toSec } = parsed
  const candles = buildOffchainPriceCandlesRaw(dex, request)

  return buildUsdChartDataFromRawCandles(dex, request, candles)
}
