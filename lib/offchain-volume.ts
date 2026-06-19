import type { DexId } from './dex-contracts'
import type { Candle } from './taco-db'

const HYPERION_BASES = [
  'https://wax.eosusa.io/v2/history/get_actions',
  'https://wax.eosphere.io/v2/history/get_actions',
  'https://api.waxsweden.org/v2/history/get_actions',
]
const PAGE_LIMIT = 1000
const MAX_PAGES = 20
const WINDOW_CACHE_TTL_MS = 15 * 60_000

function parseAsset(asset: string): [number, string] {
  const parts = asset.trim().split(' ')
  return [parseFloat(parts[0]) || 0, parts[1] ?? '']
}

interface TacoSwapData {
  id?: string
  quantity_in?: string
  quantity_out?: string
}

interface NeftySwapData {
  code?: string
  quantity_in?: string
  quantity_out?: string
}

interface HyperionAction<T> {
  timestamp: string
  global_sequence: number
  act?: {
    data?: T
  }
}

interface ParsedSwapAction {
  pairId: string
  quantityIn: string
  quantityOut: string
}

export interface OffchainTokenVolumeWindows {
  current24: number
  previous24: number
  current7d: number
  previous7d: number
  current30d: number
  previous30d: number
}

type PairTokenWindowMap = Map<string, Map<string, OffchainTokenVolumeWindows>>

const volumeWindowCache = new Map<DexId, { ts: number; data: PairTokenWindowMap }>()
const volumeWindowInflight = new Map<DexId, Promise<PairTokenWindowMap>>()

function getConfig(dex: DexId): { account: string; action: string; pairField: 'id' | 'code' } {
  return dex === 'taco'
    ? { account: 'swap.taco', action: 'exchangelog', pairField: 'id' }
    : { account: 'swap.nefty', action: 'logswap', pairField: 'code' }
}

function parseSwapAction(
  dex: DexId,
  action: HyperionAction<TacoSwapData | NeftySwapData>,
): ParsedSwapAction | null {
  const data = action.act?.data
  if (!data) return null

  if (dex === 'taco') {
    const taco = data as TacoSwapData
    if (!taco.id || !taco.quantity_in || !taco.quantity_out) return null
    return {
      pairId: taco.id,
      quantityIn: taco.quantity_in,
      quantityOut: taco.quantity_out,
    }
  }

  const nefty = data as NeftySwapData
  if (!nefty.code || !nefty.quantity_in || !nefty.quantity_out) return null
  return {
    pairId: nefty.code,
    quantityIn: nefty.quantity_in,
    quantityOut: nefty.quantity_out,
  }
}

async function fetchDexActions(
  dex: DexId,
  fromSec: number,
  toSec: number,
): Promise<Array<HyperionAction<TacoSwapData | NeftySwapData>>> {
  const cfg = getConfig(dex)
  const after = new Date(Math.max(0, fromSec) * 1000).toISOString()
  let before = new Date(Math.max(0, toSec) * 1000).toISOString()

  const seen = new Set<number>()
  const collected: Array<HyperionAction<TacoSwapData | NeftySwapData>> = []

  for (let page = 0; page < MAX_PAGES; page++) {
    let actions: Array<HyperionAction<TacoSwapData | NeftySwapData>> = []

    for (const base of HYPERION_BASES) {
      try {
        const url = new URL(base)
        url.searchParams.set('account', cfg.account)
        url.searchParams.set('filter', `${cfg.account}:${cfg.action}`)
        url.searchParams.set('sort', 'desc')
        url.searchParams.set('limit', String(PAGE_LIMIT))
        url.searchParams.set('after', after)
        url.searchParams.set('before', before)

        const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) })
        if (!res.ok) continue

        const json = await res.json() as {
          actions?: Array<HyperionAction<TacoSwapData | NeftySwapData>>
        }
        actions = Array.isArray(json.actions) ? json.actions : []
        break
      } catch {
        continue
      }
    }

    if (actions.length === 0) break

    for (const action of actions) {
      if (seen.has(action.global_sequence)) continue
      seen.add(action.global_sequence)
      collected.push(action)
    }

    if (actions.length < PAGE_LIMIT) break

    const oldest = actions[actions.length - 1]?.timestamp
    if (!oldest) break
    before = new Date(new Date(oldest).getTime() - 1).toISOString()
  }

  return collected
}

async function fetchPairActions(
  dex: DexId,
  pairId: string,
  fromSec: number,
  toSec: number,
): Promise<Array<HyperionAction<TacoSwapData | NeftySwapData>>> {
  const actions = await fetchDexActions(dex, fromSec, toSec)
  return actions.filter((action) => parseSwapAction(dex, action)?.pairId === pairId)
}

export async function buildOffchainPairTokenVolumeMap(
  dex: DexId,
  fromSec: number,
  toSec: number,
): Promise<Map<string, Map<string, number>>> {
  const actions = await fetchDexActions(dex, fromSec, toSec)
  const pairVolumeMap = new Map<string, Map<string, number>>()

  for (const action of actions) {
    const parsed = parseSwapAction(dex, action)
    if (!parsed) continue

    const pairBucket = pairVolumeMap.get(parsed.pairId) ?? new Map<string, number>()
    pairVolumeMap.set(parsed.pairId, pairBucket)

    const [inAmount, inSymbol] = parseAsset(parsed.quantityIn)
    const [outAmount, outSymbol] = parseAsset(parsed.quantityOut)

    if (inAmount > 0 && inSymbol) {
      pairBucket.set(inSymbol, (pairBucket.get(inSymbol) ?? 0) + inAmount)
    }
    if (outAmount > 0 && outSymbol) {
      pairBucket.set(outSymbol, (pairBucket.get(outSymbol) ?? 0) + outAmount)
    }
  }

  return pairVolumeMap
}

function addVolumeWindow(
  pairMap: PairTokenWindowMap,
  pairId: string,
  symbol: string,
  field: keyof OffchainTokenVolumeWindows,
  amount: number,
) {
  if (amount <= 0 || !symbol) return
  const tokenMap = pairMap.get(pairId) ?? new Map<string, OffchainTokenVolumeWindows>()
  pairMap.set(pairId, tokenMap)

  const entry = tokenMap.get(symbol) ?? {
    current24: 0,
    previous24: 0,
    current7d: 0,
    previous7d: 0,
    current30d: 0,
    previous30d: 0,
  }
  entry[field] += amount
  tokenMap.set(symbol, entry)
}

async function computeOffchainPairTokenVolumeWindows(dex: DexId): Promise<PairTokenWindowMap> {
  const nowSec = Math.floor(Date.now() / 1000)
  const previous30Start = nowSec - 60 * 86_400
  const actions = await fetchDexActions(dex, previous30Start, nowSec)
  const pairMap: PairTokenWindowMap = new Map()

  const current24Start = nowSec - 1 * 86_400
  const previous24Start = nowSec - 2 * 86_400
  const current7Start = nowSec - 7 * 86_400
  const previous7Start = nowSec - 14 * 86_400
  const current30Start = nowSec - 30 * 86_400

  for (const action of actions) {
    const parsed = parseSwapAction(dex, action)
    if (!parsed) continue

    const timeSec = Math.floor(new Date(action.timestamp).getTime() / 1000)
    const [inAmount, inSymbol] = parseAsset(parsed.quantityIn)
    const [outAmount, outSymbol] = parseAsset(parsed.quantityOut)

    const addWindow = (field: keyof OffchainTokenVolumeWindows) => {
      addVolumeWindow(pairMap, parsed.pairId, inSymbol, field, inAmount)
      addVolumeWindow(pairMap, parsed.pairId, outSymbol, field, outAmount)
    }

    if (timeSec >= current30Start) addWindow('current30d')
    else if (timeSec >= previous30Start) addWindow('previous30d')

    if (timeSec >= current7Start) addWindow('current7d')
    else if (timeSec >= previous7Start) addWindow('previous7d')

    if (timeSec >= current24Start) addWindow('current24')
    else if (timeSec >= previous24Start) addWindow('previous24')
  }

  return pairMap
}

export async function getOffchainPairTokenVolumeWindows(
  dex: DexId,
): Promise<PairTokenWindowMap> {
  const cached = volumeWindowCache.get(dex)
  if (cached && Date.now() - cached.ts < WINDOW_CACHE_TTL_MS) {
    return cached.data
  }

  const active = volumeWindowInflight.get(dex)
  if (active) return active

  const task = computeOffchainPairTokenVolumeWindows(dex)
    .then((data) => {
      volumeWindowCache.set(dex, { ts: Date.now(), data })
      return data
    })
    .finally(() => {
      volumeWindowInflight.delete(dex)
    })

  volumeWindowInflight.set(dex, task)
  return task
}

export async function buildOffchainVolumeMapUsd(
  dex: DexId,
  pairId: string,
  tokenSymbol: string,
  resolution: number,
  fromSec: number,
  toSec: number,
  candles: Candle[],
): Promise<Map<number, number>> {
  if (!pairId || !tokenSymbol || candles.length === 0) return new Map()

  const actions = await fetchPairActions(dex, pairId, fromSec, toSec)
  if (actions.length === 0) return new Map()

  const tokenVolumeByBucket = new Map<number, number>()

  for (const action of actions) {
    const parsed = parseSwapAction(dex, action)
    if (!parsed) continue

    const [inAmount, inSymbol] = parseAsset(parsed.quantityIn)
    const [outAmount, outSymbol] = parseAsset(parsed.quantityOut)
    const tradedTokenAmount =
      inSymbol === tokenSymbol ? inAmount :
      outSymbol === tokenSymbol ? outAmount :
      0

    if (tradedTokenAmount <= 0) continue

    const timeSec = Math.floor(new Date(action.timestamp).getTime() / 1000)
    const bucket = Math.floor(timeSec / resolution) * resolution
    tokenVolumeByBucket.set(bucket, (tokenVolumeByBucket.get(bucket) ?? 0) + tradedTokenAmount)
  }

  const usdVolumeByBucket = new Map<number, number>()
  for (const candle of candles) {
    const tokenVolume = tokenVolumeByBucket.get(candle.time) ?? 0
    if (tokenVolume > 0) {
      usdVolumeByBucket.set(candle.time, tokenVolume * candle.close)
    }
  }

  return usdVolumeByBucket
}
