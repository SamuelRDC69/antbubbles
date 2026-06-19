import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildLogoCandidates,
  canonicalLogoKey,
} from '../lib/logoManifest.js'
import type { TokenBubbleData } from '../lib/types.js'
import {
  dedupeLogoCandidates,
  fallbackLogoSvg,
} from './logoMirror.js'
import {
  applyPersistentPriceHistory,
  type PriceHistory,
} from './priceHistory.js'

function token(overrides: Partial<TokenBubbleData> = {}): TokenBubbleData {
  return {
    id: 'wienr-token.wienr',
    symbol: 'WIENR',
    contract: 'token.wienr',
    usd_price: 2,
    system_price: 1,
    change24: 0,
    volume24usd: 1,
    high24: 0,
    low24: 0,
    bid: 0,
    ask: 0,
    market_id: null,
    ticker_id: null,
    logoUrl: '/fallback.png',
    ...overrides,
  }
}

test('canonical logo identity is shared across exchanges and symbol case', () => {
  assert.equal(
    canonicalLogoKey(token()),
    canonicalLogoKey(token({ id: 'different-dex-id', symbol: 'wienr' })),
  )
})

test('persistent history calculates a real 24h change', () => {
  const now = Date.UTC(2026, 5, 7, 12)
  const history: PriceHistory = {
    samples: {
      'wienr-token.wienr': [{ ts: now - 24 * 60 * 60_000, price: 1 }],
    },
    lastValidChange: {},
  }

  const [result] = applyPersistentPriceHistory([token()], history, now)
  assert.equal(result.change24, 100)
})

test('an incomplete candle window never overwrites last-known-good change with zero', () => {
  const history: PriceHistory = {
    samples: {},
    lastValidChange: { 'wienr-token.wienr': 5.25 },
  }

  const [result] = applyPersistentPriceHistory([token({ change24: 0 })], history)
  assert.equal(result.change24, 5.25)
})

test('image identity helpers do not mutate token market data', () => {
  const source = token({ change24: -4.5, volume24usd: 123, tvlUsd: 456 })
  canonicalLogoKey(source)
  assert.equal(source.change24, -4.5)
  assert.equal(source.volume24usd, 123)
  assert.equal(source.tvlUsd, 456)
})

test('reliable shared artwork wins before an Alcor fallback source', () => {
  const shared = token()
  const candidates = [
    ...buildLogoCandidates([shared], 'taco', 'taco'),
    ...buildLogoCandidates([shared], 'alcor', 'wax'),
  ]
  const [winner] = dedupeLogoCandidates(candidates)

  assert.match(winner.sourceUrl, /^https:\/\/assets\.tacostudios\.io\//)
})

test('every token identity has a deterministic local atlas fallback', () => {
  const key = canonicalLogoKey(token())
  const first = fallbackLogoSvg(key)
  const second = fallbackLogoSvg(key)

  assert.ok(first.length > 100)
  assert.deepEqual(first, second)
  assert.match(first.toString(), />WIENR</)
})
