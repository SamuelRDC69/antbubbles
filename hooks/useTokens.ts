'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { TokenBubbleData, ChainConfig, DexMode } from '@/lib/types'
import { fetchSupplies } from '@/lib/alcor'
import { DEFAULT_CHAIN } from '@/lib/chains'

const CACHE_MAX_AGE  = 5 * 60 * 1000   // 5 min — show stale data up to this old
const cacheKey = (id: string) => `abt:v1:${id}`

// ── localStorage helpers (safe — no-ops on server / quota errors) ─────────────

function lsRead(id: string): TokenBubbleData[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(cacheKey(id))
    if (!raw) return []
    const { data, ts } = JSON.parse(raw) as { data: TokenBubbleData[]; ts: number }
    return Date.now() - ts < CACHE_MAX_AGE ? data : []
  } catch { return [] }
}

function lsWrite(id: string, tokens: TokenBubbleData[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(cacheKey(id), JSON.stringify({ data: tokens, ts: Date.now() }))
  } catch {} // storage quota exceeded — silently skip
}

function buildMarketCapMap(tokens: TokenBubbleData[]): Map<string, { supply?: number; marketCapUsd?: number }> {
  const map = new Map<string, { supply?: number; marketCapUsd?: number }>()
  for (const token of tokens) {
    if (token.marketCapUsd !== undefined || token.supply !== undefined) {
      map.set(token.id, { supply: token.supply, marketCapUsd: token.marketCapUsd })
    }
  }
  return map
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTokens(
  chain: ChainConfig,
  initialTokens: TokenBubbleData[] = [],
  dex: DexMode = 'alcor',
) {
  const isOffChain    = dex === 'taco' || dex === 'nefty'
  const isDefaultChain = !isOffChain && chain.id === DEFAULT_CHAIN

  const cacheId = dex === 'taco' ? 'taco-wax'
                : dex === 'nefty' ? 'nefty-wax'
                : chain.id

  const offchainUrl = dex === 'taco'  ? '/api/taco-tokens'
                   : dex === 'nefty' ? '/api/nefty-tokens'
                   : null
  const streamUrl = `/api/stream?chain=${chain.id}`

  // Seed order of priority: SSR data → localStorage → empty
  const seed = isDefaultChain && initialTokens.length > 0
    ? initialTokens
    : lsRead(cacheId)

  const [tokens,      setTokens]      = useState<TokenBubbleData[]>(seed)
  const [loading,     setLoading]     = useState(seed.length === 0)
  const [error,       setError]       = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [connected,   setConnected]   = useState(false)
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const supplyMapRef   = useRef<Map<string, number>>(new Map())
  const supplyChainRef = useRef<string>('')
  const alcorMarketCapsRef = useRef<Map<string, { supply?: number; marketCapUsd?: number }>>(
    buildMarketCapMap(initialTokens.length > 0 ? initialTokens : lsRead(DEFAULT_CHAIN))
  )

  const applySupply = useCallback((
    list: TokenBubbleData[],
    map:  Map<string, number>,
  ): TokenBubbleData[] =>
    list.map(t => {
      const supply = map.get(t.id)
      return supply !== undefined ? { ...t, supply, marketCapUsd: supply * t.usd_price } : t
    })
  , [])

  const applyAlcorMarketCaps = useCallback((list: TokenBubbleData[]): TokenBubbleData[] => {
    const map = alcorMarketCapsRef.current.size > 0
      ? alcorMarketCapsRef.current
      : buildMarketCapMap(lsRead(DEFAULT_CHAIN))

    if (map.size === 0) return list

    return list.map((token) => {
      const match = map.get(token.id)
      return match ? {
        ...token,
        supply: match.supply ?? token.supply,
        marketCapUsd: match.marketCapUsd ?? token.marketCapUsd,
      } : token
    })
  }, [])

  const handleTokenData = useCallback((merged: TokenBubbleData[], id: string) => {
    const withSupply = applySupply(merged, supplyMapRef.current)
    const withMarketCaps = isOffChain ? applyAlcorMarketCaps(withSupply) : withSupply

    if (!isOffChain) {
      alcorMarketCapsRef.current = buildMarketCapMap(withMarketCaps)
    }

    setTokens(withMarketCaps)
    setLoading(false)
    setLastUpdated(new Date())
    setError(null)

    setConnected(true)
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
    liveTimerRef.current = setTimeout(() => setConnected(false), 75_000)

    lsWrite(id, withMarketCaps)

    // Only fetch on-chain supplies for Alcor — not for off-chain DEXes
    if (!isOffChain && supplyChainRef.current !== id) {
      const refs = merged.map(t => ({ id: t.id, contract: t.contract, symbol: t.symbol }))
      fetchSupplies({ id } as ChainConfig, refs)
        .then(map => {
          supplyMapRef.current   = map
          supplyChainRef.current = id
          setTokens(prev => {
            const updated = applySupply(prev, map)
            lsWrite(id, updated)
            return updated
          })
        })
        .catch(() => {})
    }
  }, [applyAlcorMarketCaps, applySupply, isOffChain])

  useEffect(() => {
    supplyChainRef.current = ''
    supplyMapRef.current   = new Map()

    const hasSeeded = isDefaultChain && initialTokens.length > 0

    if (hasSeeded) {
      setTokens(initialTokens)
      setLoading(false)
    } else {
      const cached = lsRead(cacheId)
      if (cached.length > 0) {
        setTokens(cached)
        setLoading(false)
      } else {
        setLoading(true)
        setTokens([])
      }
    }
    setError(null)

    if (isOffChain && offchainUrl) {
      const ctrl = new AbortController()

      const load = async () => {
        try {
          const data = await fetch(offchainUrl, {
            signal: ctrl.signal,
            headers: { Accept: 'application/json' },
          }).then(r => r.ok ? r.json() : [])

          if (!ctrl.signal.aborted && Array.isArray(data) && data.length > 0) {
            handleTokenData(data, cacheId)
          }
        } catch {
          if (!ctrl.signal.aborted) {
            setTokens(prev => {
              if (prev.length === 0) setError('Failed to load token data')
              if (prev.length > 0)  setLoading(false)
              return prev
            })
          }
        }
      }

      void load()
      const interval = setInterval(load, 30_000)

      return () => {
        ctrl.abort()
        clearInterval(interval)
        if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
      }
    }

    const es = new EventSource(streamUrl)

    es.onmessage = (evt) => {
      try {
        const data: TokenBubbleData[] = JSON.parse(evt.data)
        if (Array.isArray(data) && data.length > 0) {
          handleTokenData(data, cacheId)
        }
      } catch {
        // malformed JSON — ignore
      }
    }

    es.onerror = () => {
      setTokens(prev => {
        if (prev.length === 0) setError('Failed to load token data')
        if (prev.length > 0)  setLoading(false)
        return prev
      })
    }

    return () => {
      es.close()
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheId, chain.id, dex, handleTokenData, isOffChain, offchainUrl])

  const updateToken = useCallback((id: string, patch: Partial<TokenBubbleData>) => {
    setTokens(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
  }, [])

  return { tokens, loading, error, lastUpdated, connected, updateToken }
}
