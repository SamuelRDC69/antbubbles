import { queryCandles, type Candle, type Resolution } from './taco-db'
import type { DexId } from './dex-contracts'
import type { OffchainChartStep } from './types'

function multiplyCandles(base: Candle, upstream: Candle): Candle {
  return {
    time:   base.time,
    open:   base.open * upstream.open,
    high:   base.high * upstream.high,
    low:    base.low  * upstream.low,
    close:  base.close * upstream.close,
    volume: base.volume,
  }
}

function divideCandles(base: Candle, upstream: Candle): Candle {
  return {
    time:   base.time,
    open:   upstream.open  / base.open,
    high:   upstream.high  / base.low,
    low:    upstream.low   / base.high,
    close:  upstream.close / base.close,
    volume: base.volume,
  }
}

export function buildOffchainWaxCandles(
  dex: DexId,
  path: OffchainChartStep[],
  resolution: Resolution,
  fromSec: number,
  toSec: number,
): Candle[] {
  if (path.length === 0) return []

  let composed = queryCandles(dex, path[path.length - 1].pairId, resolution, fromSec, toSec)
  if (composed.length === 0) return []

  for (let i = path.length - 2; i >= 0; i--) {
    const step = path[i]
    const base = queryCandles(dex, step.pairId, resolution, fromSec, toSec)
    if (base.length === 0) return []

    const upstreamByTime = new Map(composed.map(c => [c.time, c]))
    const merged: Candle[] = []

    for (const candle of base) {
      const upstream = upstreamByTime.get(candle.time)
      if (!upstream) continue
      merged.push(step.invert ? divideCandles(candle, upstream) : multiplyCandles(candle, upstream))
    }

    composed = merged
    if (composed.length === 0) return []
  }

  return composed
}
