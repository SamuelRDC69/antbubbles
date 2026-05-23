'use client'

import { useEffect, useRef } from 'react'
import { ChainConfig } from '@/lib/types'

interface TickerUpdate {
  close: number
  open: number
  high: number
  low: number
  volume: number
  time: number
}

interface DealUpdate {
  time: number
  ask: number
  bid: number
  type: 'buymatch' | 'sellmatch'
  unit_price: number
  trx_id: string
}

interface UseAlcorSocketOptions {
  chain: ChainConfig
  marketIds: number[]
  onTicker?: (marketId: number, update: TickerUpdate) => void
  onDeal?: (marketId: number, deal: DealUpdate) => void
}

export function useAlcorSocket({ chain, marketIds, onTicker, onDeal }: UseAlcorSocketOptions) {
  const socketRef = useRef<any>(null)
  const subscribedRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    if (typeof window === 'undefined' || marketIds.length === 0) return

    let socket: any
    let mounted = true

    const wsUrl = chain.apiBase.replace('/api/v2', '')

    import('socket.io-client').then(({ io }) => {
      if (!mounted) return

      socket = io(wsUrl, {
        transports: ['websocket'],
        reconnectionAttempts: 5,
        reconnectionDelay: 2000,
      })

      socketRef.current = socket

      socket.on('connect', () => {
        // Subscribe to tickers for each market
        for (const marketId of marketIds) {
          if (!subscribedRef.current.has(marketId)) {
            socket.emit('subscribe', {
              room: 'ticker',
              params: { chain: chain.id, market: marketId, resolution: '1' },
            })
            subscribedRef.current.add(marketId)
          }
        }
      })

      socket.on('ticker', (data: any) => {
        if (!onTicker) return
        // data format: ['tick', { close, open, high, low, volume, time }]
        // The socket sends per-market updates; we match by subscription
        if (Array.isArray(data) && data[0] === 'tick') {
          // We don't know which market without the room param back
          // Alcor sends updates in the subscribed room context
        }
      })

      // Listen for raw events
      socket.onAny((event: string, ...args: any[]) => {
        if (event === 'ticker' || event === 'tick') {
          const payload = args[0]
          if (Array.isArray(payload) && payload[0] === 'tick' && onTicker) {
            // Match the market from subscription tracking
          }
        }
      })
    })

    return () => {
      mounted = false
      if (socket) {
        for (const marketId of subscribedRef.current) {
          socket.emit('unsubscribe', {
            room: 'ticker',
            params: { chain: chain.id, market: marketId, resolution: '1' },
          })
        }
        socket.disconnect()
        subscribedRef.current.clear()
      }
    }
  }, [chain, marketIds, onTicker, onDeal])
}
