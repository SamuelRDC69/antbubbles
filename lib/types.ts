export interface TokenPool {
  id:                number
  tvl:               number
  counterpartId:     string   // e.g. "wax-eosio.token"
  counterpartSymbol: string   // e.g. "WAX"
  reversed:          boolean  // true when our token is tokenB (price chart needs &reverse=true)
}

export interface AlcorToken {
  contract:        string
  decimals:        number
  symbol:          string
  id:              string
  system_price:    number
  usd_price:       number
  score?:          number
  is_scam?:        boolean
  is_trusted?:     boolean
  cmc_id?:         number
}

export interface AlcorTicker {
  ticker_id: string
  market_id: number
  base_currency: string
  target_currency: string
  global_ticker_id: string | null
  last_price: number
  change24: number
  high24: number
  low24: number
  bid: number
  ask: number
  base_volume: number
  target_volume: number
  frozen: boolean
  fee: number
  base_amm_liquidity: number
  target_amm_liquidity: number
}

export interface AlcorPool {
  id: number
  active: boolean
  tokenA: { id: string; symbol: string; contract: string }
  tokenB: { id: string; symbol: string; contract: string }
  change24: number
  changeWeek: number
  volumeUSD24: number
  volumeUSDWeek: number
  volumeUSDMonth: number
  tvlUSD: number
}

export interface TokenBubbleData {
  id: string
  symbol: string
  contract: string
  usd_price: number
  system_price: number
  change24: number
  volume24usd: number
  high24: number
  low24: number
  bid: number
  ask: number
  market_id: number | null
  ticker_id: string | null
  logoUrl: string
  // Extended from AMM pools
  change7d?: number
  volume7dusd?: number
  volume30dusd?: number
  tvlUsd?: number
  // CoinMarketCap ID (when available, enables TradingView widget)
  cmc_id?: number
  // All AMM pools this token participates in, sorted by TVL desc
  pools?: TokenPool[]
  // Market cap (from on-chain supply)
  supply?: number
  marketCapUsd?: number
  // Token precision (decimal places), e.g. 8 for WAX, 4 for USDT
  decimals?: number
  // Alcor quality score (0–100), used for ranking
  score?: number
  // Rank in the sorted token list (1 = highest score)
  rank?: number
  // Rank change vs 24h-ago snapshot: positive = moved up, negative = moved down
  rankChange?: number
  // Historical change % for TVL and volume (from rolling daily snapshots)
  // tvlChange24h: TVL today vs yesterday  (positive = grew)
  // vol7dChange:  volume7d this week vs 7 days ago
  // vol30dChange: volume30d this month vs 30 days ago
  tvlChange24h?: number
  vol7dChange?:  number
  vol30dChange?: number
  // D3 simulation fields (set by BubbleChart)
  x?: number
  y?: number
  vx?: number
  vy?: number
  radius?: number
}

export type Metric    = 'change' | 'price' | 'volume' | 'tvl' | 'mcap'
export type Timeframe = '24h' | '7d' | '30d'

export interface DisplayMode {
  metric:    Metric
  timeframe: Timeframe
}

export interface ChainConfig {
  id: string
  name: string
  displayName: string
  apiBase: string
  systemToken: string
  systemContract: string
  explorerBase: string
  color: string
  nodeUrl: string
}
