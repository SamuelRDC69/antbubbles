'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { TokenBubbleData, ChainConfig, TokenSupplyInfo } from '@/lib/types'
import { fetchSupplies } from '@/lib/alcor'
import { DEFAULT_CHAIN } from '@/lib/chains'

const CACHE_MAX_AGE  = 5 * 60 * 1000   // 5 min — show stale data up to this old
const cacheKey = (chainId: string) => `abt:v2:${chainId}`

// ── localStorage helpers (safe — no-ops on server / quota errors) ─────────────

function lsRead(chainId: string): TokenBubbleData[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(cacheKey(chainId))
    if (!raw) return []
    const { data, ts } = JSON.parse(raw) as { data: TokenBubbleData[]; ts: number }
    return Date.now() - ts < CACHE_MAX_AGE ? data : []
  } catch { return [] }
}

function lsWrite(chainId: string, tokens: TokenBubbleData[]) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(cacheKey(chainId), JSON.stringify({ data: tokens, ts: Date.now() }))
  } catch {} // storage quota exceeded — silently skip
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useTokens(
  chain: ChainConfig,
  // Pre-rendered tokens from SSR for the default chain (skips loading screen on first paint)
  initialTokens: TokenBubbleData[] = [],
) {
  const isDefaultChain = chain.id === DEFAULT_CHAIN

  // Seed order of priority: SSR data → localStorage → empty
  const seed = isDefaultChain && initialTokens.length > 0
    ? initialTokens
    : lsRead(chain.id)

  const [tokens,      setTokens]      = useState<TokenBubbleData[]>(seed)
  const [loading,     setLoading]     = useState(seed.length === 0)
  const [error,       setError]       = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  // true = stream is delivering fresh data; false = no data for >75 s (genuine outage).
  // Driven by a watchdog timer, NOT by onerror — the server closes the connection after
  // each SSE event (by design) which fires onerror on reconnect, so onerror cannot
  // distinguish "normal reconnect" from "real network failure".
  const [connected,    setConnected]   = useState(false)
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const supplyMapRef   = useRef<Map<string, TokenSupplyInfo>>(new Map())
  const supplyChainRef = useRef<string>('')

  const applySupply = useCallback((
    list: TokenBubbleData[],
    map:  Map<string, TokenSupplyInfo>,
  ): TokenBubbleData[] =>
    list.map(t => {
      const info = map.get(t.id)
      return info !== undefined
        ? {
            ...t,
            supply: info.circulating,
            totalSupply: info.total,
            burnedSupply: info.burned,
            burnedSupplyPct: info.burnedPct,
            marketCapUsd: info.circulating * t.usd_price,
          }
        : t
    })
  , [])

  const ensureSupply = useCallback((list: TokenBubbleData[], chainId: string) => {
    if (supplyChainRef.current === chainId || list.length === 0) return
    supplyChainRef.current = chainId

    const refs = list.map(t => ({ id: t.id, contract: t.contract, symbol: t.symbol }))
    fetchSupplies({ id: chainId } as ChainConfig, refs)
      .then(map => {
        supplyMapRef.current = map
        setTokens(prev => {
          const updated = applySupply(prev, map)
          lsWrite(chainId, updated)
          return updated
        })
      })
      .catch(() => {
        supplyChainRef.current = ''
      })
  }, [applySupply])

  const handleTokenData = useCallback((merged: TokenBubbleData[], chainId: string) => {
    const withSupply = applySupply(merged, supplyMapRef.current)

    setTokens(withSupply)
    setLoading(false)
    setLastUpdated(new Date())
    setError(null)

    // Mark live and reset the 75-second watchdog.
    // If no fresh message arrives within 75 s (2.5 × the 30-second retry interval)
    // we consider the stream genuinely broken and flip to amber.
    setConnected(true)
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current)
    liveTimerRef.current = setTimeout(() => setConnected(false), 75_000)

    lsWrite(chainId, withSupply)

    // Fetch supplies once per chain session (background — doesn't block render)
    ensureSupply(merged, chainId)
  }, [applySupply, ensureSupply])

  useEffect(() => {
    supplyChainRef.current = ''
    supplyMapRef.current   = new Map()

    const hasSeeded = isDefaultChain && initialTokens.length > 0

    // Show cached data immediately while SSE connects
    if (!hasSeeded) {
      const cached = lsRead(chain.id)
      if (cached.length > 0) {
        setTokens(cached)
        setLoading(false)
        ensureSupply(cached, chain.id)
      } else {
        setLoading(true)
        setTokens([])
      }
    }
    if (hasSeeded) ensureSupply(initialTokens, chain.id)
    setError(null)

    // ── EventSource ──────────────────────────────────────────────────────────
    // The SSE stream sends one event with fresh token data then closes.
    // The browser's native EventSource reconnects after the `retry` interval
    // (30 s) — giving us polling semantics without setInterval or fetch loops.
    const es = new EventSource(`/api/stream?chain=${chain.id}`)

    es.onmessage = (evt) => {
      try {
        const data: TokenBubbleData[] = JSON.parse(evt.data)
        if (Array.isArray(data) && data.length > 0) {
          handleTokenData(data, chain.id)
        }
      } catch {
        // malformed JSON — ignore
      }
    }

    es.onerror = () => {
      // EventSource handles reconnection automatically.
      // Do NOT touch connected here — the server closes the connection after every
      // event (by design), which triggers onerror on each 30-second reconnect cycle.
      // connected is managed by the watchdog timer above instead.
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
  }, [chain.id])

  const updateToken = useCallback((id: string, patch: Partial<TokenBubbleData>) => {
    setTokens(prev => prev.map(t => t.id === id ? { ...t, ...patch } : t))
  }, [])

  return { tokens, loading, error, lastUpdated, connected, updateToken }
}
