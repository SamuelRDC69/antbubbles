'use client'

// ─────────────────────────────────────────────────────────────────────────────
// SETUP REQUIRED BEFORE THIS EARNS YOU MONEY
//
// 1. Register your WAX account as a fee market on swap.alcor:
//    https://wax.bloks.io/account/swap.alcor (Actions → regmarket)
//    Params: marketName = <your account>, marketFee = 1000  (= 0.1%)
//
// 2. Replace MARKET_ACCOUNT below with that account name.
// ─────────────────────────────────────────────────────────────────────────────
const MARKET_ACCOUNT = 'YOUR_MARKET_ACCOUNT'   // ← replace this
const MARKET_FEE_PCT = 0.1                     // for display only

import { useState, useEffect, useRef, useCallback } from 'react'
import { useWallet } from '@/contexts/WalletContext'
import { TokenBubbleData, ChainConfig } from '@/lib/types'
import { formatPrice, formatVolume } from '@/lib/bubbleUtils'
import type { SwapQuote } from '@/app/api/swap-quote/route'

interface Props {
  chain:          ChainConfig
  tokens:         TokenBubbleData[]
  initialToken?:  TokenBubbleData | null  // pre-fill "from" token
  onClose:        () => void
}

// WAX system token entry (not in the regular token list)
function makeSystemToken(chain: ChainConfig): TokenBubbleData {
  return {
    id:          `${chain.systemToken.toLowerCase()}-${chain.systemContract}`,
    symbol:      chain.systemToken,
    contract:    chain.systemContract,
    usd_price:   0,
    system_price:1,
    change24:    0,
    volume24usd: 0,
    high24:      0,
    low24:       0,
    bid:         0,
    ask:         0,
    market_id:   null,
    ticker_id:   null,
    logoUrl:     `/api/logo?id=${encodeURIComponent(`${chain.systemToken.toLowerCase()}-${chain.systemContract}`)}&chain=${chain.id}`,
    decimals:    8,
  }
}

// ── Token selector popup ──────────────────────────────────────────────────────
function TokenPicker({
  tokens,
  selected,
  onSelect,
  onClose,
}: {
  tokens:   TokenBubbleData[]
  selected: TokenBubbleData | null
  onSelect: (t: TokenBubbleData) => void
  onClose:  () => void
}) {
  const [search, setSearch] = useState('')
  const filtered = tokens.filter(t =>
    !search ||
    t.symbol.toLowerCase().includes(search.toLowerCase()) ||
    t.contract.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <div className="absolute inset-0 z-10 flex flex-col rounded-2xl overflow-hidden"
      style={{ background: '#0a0f14' }}>
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-white/[0.06]">
        <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <input
          autoFocus
          type="text"
          placeholder="Search by name or contract…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="flex-1 bg-white/[0.07] border border-white/[0.08] rounded-lg px-3 py-1.5
            text-[13px] text-white placeholder-gray-600 focus:outline-none focus:border-white/20"
        />
      </div>
      <div className="flex-1 overflow-y-auto">
        {filtered.map(t => (
          <button
            key={t.id}
            onClick={() => { onSelect(t); onClose() }}
            className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.05] transition-colors
              border-b border-white/[0.03] last:border-0 ${selected?.id === t.id ? 'bg-white/[0.04]' : ''}`}
          >
            <TokenLogo token={t} size={32} />
            <div className="flex-1 min-w-0 text-left">
              <div className="text-[13px] font-semibold text-white leading-none">{t.symbol}</div>
              <div className="text-[10px] text-gray-600 mt-0.5 truncate">{t.contract}</div>
            </div>
            {t.usd_price > 0 && (
              <span className="text-[11px] tabular-nums text-gray-400 shrink-0">
                {formatPrice(t.usd_price)}
              </span>
            )}
            {selected?.id === t.id && (
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
            )}
          </button>
        ))}
        {filtered.length === 0 && (
          <div className="flex items-center justify-center py-12 text-gray-600 text-[13px]">
            No tokens found
          </div>
        )}
      </div>
    </div>
  )
}

function TokenLogo({ token, size = 28 }: { token: TokenBubbleData; size?: number }) {
  const [err, setErr] = useState(false)
  if (err || !token.logoUrl) {
    return (
      <span className="rounded-full bg-white/10 flex items-center justify-center text-[10px] font-bold text-white shrink-0"
        style={{ width: size, height: size }}>
        {token.symbol.slice(0, 2)}
      </span>
    )
  }
  return (
    <img
      src={token.logoUrl} alt={token.symbol}
      className="rounded-full object-contain shrink-0"
      style={{ width: size, height: size, background: 'rgba(255,255,255,0.06)' }}
      onError={() => setErr(true)}
    />
  )
}

// ── Slippage settings ─────────────────────────────────────────────────────────
const SLIPPAGE_PRESETS = [0.1, 0.5, 1.0, 3.0]

function SlippagePanel({
  slippage,
  onChange,
}: {
  slippage: number
  onChange: (v: number) => void
}) {
  const [custom, setCustom] = useState('')
  return (
    <div className="px-4 py-3 border-t border-white/[0.06]" style={{ background: '#0c1520' }}>
      <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-2 font-semibold">
        Slippage Tolerance
      </div>
      <div className="flex items-center gap-1.5">
        {SLIPPAGE_PRESETS.map(v => (
          <button
            key={v}
            onClick={() => { onChange(v); setCustom('') }}
            className={`px-3 py-1 rounded-lg text-[11px] font-semibold transition-all border ${
              slippage === v && !custom
                ? 'bg-[#f89422]/20 border-[#f89422]/40 text-[#f89422]'
                : 'border-white/[0.08] text-gray-500 hover:text-gray-300'
            }`}
          >{v}%</button>
        ))}
        <div className="flex items-center border border-white/[0.08] rounded-lg overflow-hidden">
          <input
            type="number"
            placeholder="Custom"
            value={custom}
            onChange={e => {
              const v = e.target.value
              setCustom(v)
              const n = parseFloat(v)
              if (!isNaN(n) && n > 0 && n <= 50) onChange(n)
            }}
            className="w-16 bg-transparent px-2 py-1 text-[11px] text-white focus:outline-none"
          />
          <span className="text-[11px] text-gray-500 pr-2">%</span>
        </div>
      </div>
      {slippage > 5 && (
        <p className="text-[10px] text-yellow-500 mt-1.5">
          ⚠ High slippage — you may receive significantly less than expected
        </p>
      )}
    </div>
  )
}

// ── Token amount input card ────────────────────────────────────────────────────
function TokenInput({
  label,
  token,
  amount,
  usdValue,
  readOnly,
  loading,
  onAmountChange,
  onTokenClick,
}: {
  label:          string
  token:          TokenBubbleData | null
  amount:         string
  usdValue:       number
  readOnly:       boolean
  loading:        boolean
  onAmountChange?: (v: string) => void
  onTokenClick:   () => void
}) {
  return (
    <div className="rounded-xl p-4 border border-white/[0.07]" style={{ background: '#0c1520' }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] text-gray-600 uppercase tracking-widest font-semibold">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        {/* Token selector */}
        <button
          onClick={onTokenClick}
          className="flex items-center gap-2 px-3 py-2 rounded-xl font-semibold text-[13px]
            bg-white/[0.07] border border-white/[0.08] hover:bg-white/[0.12]
            transition-colors shrink-0"
        >
          {token ? (
            <>
              <TokenLogo token={token} size={22} />
              <span className="text-white">{token.symbol}</span>
            </>
          ) : (
            <span className="text-gray-400">Select</span>
          )}
          <svg className="w-3 h-3 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {/* Amount */}
        <div className="flex-1 text-right">
          {readOnly ? (
            <div className={`text-[22px] font-bold text-white leading-none tabular-nums
              ${loading ? 'opacity-40 animate-pulse' : ''}`}>
              {loading ? '…' : (parseFloat(amount) > 0 ? amount : '0')}
            </div>
          ) : (
            <input
              type="number"
              value={amount}
              onChange={e => onAmountChange?.(e.target.value)}
              placeholder="0"
              className="w-full text-right text-[22px] font-bold text-white bg-transparent
                focus:outline-none placeholder-gray-700 tabular-nums"
            />
          )}
          {usdValue > 0 && (
            <div className="text-[11px] text-gray-600 mt-0.5 tabular-nums">
              ≈ {formatVolume(usdValue)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Impact badge ──────────────────────────────────────────────────────────────
function ImpactBadge({ pct }: { pct: number }) {
  const cls = pct < 1 ? 'text-green-400' : pct < 3 ? 'text-yellow-400' : 'text-red-400'
  return <span className={`text-[11px] font-semibold ${cls}`}>{pct.toFixed(2)}%</span>
}

// ── Route display ─────────────────────────────────────────────────────────────
function RouteDisplay({
  inToken,
  outToken,
  via,
}: {
  inToken:  TokenBubbleData
  outToken: TokenBubbleData
  via:      string | null   // intermediate symbol for 2-hop
}) {
  const Arrow = () => (
    <svg className="w-3 h-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  )
  return (
    <div className="flex items-center gap-1 flex-wrap">
      <span className="text-[11px] text-gray-300 font-semibold">{inToken.symbol}</span>
      <Arrow />
      {via && (
        <>
          <span className="text-[11px] text-gray-500">{via}</span>
          <Arrow />
        </>
      )}
      <span className="text-[11px] text-gray-300 font-semibold">{outToken.symbol}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function SwapModal({ chain, tokens, initialToken, onClose }: Props) {
  const { actor, login, transact } = useWallet()

  // All available tokens: system token first, then the rest
  const allTokens = [makeSystemToken(chain), ...tokens]

  const [tokenIn,   setTokenIn]   = useState<TokenBubbleData | null>(
    initialToken ?? makeSystemToken(chain)
  )
  const [tokenOut,  setTokenOut]  = useState<TokenBubbleData | null>(
    initialToken ? makeSystemToken(chain) : null
  )
  const [amountIn,  setAmountIn]  = useState('')
  const [slippage,  setSlippage]  = useState(0.5)

  const [quote,     setQuote]     = useState<SwapQuote | null>(null)
  const [quoteErr,  setQuoteErr]  = useState<string | null>(null)
  const [quoteLd,   setQuoteLd]   = useState(false)

  const [showSlip,  setShowSlip]  = useState(false)
  const [picker,    setPicker]    = useState<'in' | 'out' | null>(null)

  const [swapState, setSwapState] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')
  const [txId,      setTxId]      = useState<string | null>(null)
  const [swapErr,   setSwapErr]   = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ESC to close
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  // Fetch quote whenever inputs change (debounced 500 ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const amt = parseFloat(amountIn)
    if (!tokenIn || !tokenOut || isNaN(amt) || amt <= 0) {
      setQuote(null); setQuoteErr(null); return
    }
    debounceRef.current = setTimeout(async () => {
      setQuoteLd(true); setQuoteErr(null)
      try {
        const res = await fetch(
          `/api/swap-quote?chain=${chain.id}` +
          `&tokenIn=${encodeURIComponent(tokenIn.id)}` +
          `&tokenOut=${encodeURIComponent(tokenOut.id)}` +
          `&amountIn=${amt}`
        )
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error ?? `HTTP ${res.status}`)
        }
        const q: SwapQuote = await res.json()
        setQuote(q)
      } catch (e) {
        setQuote(null)
        setQuoteErr(e instanceof Error ? e.message : 'Quote failed')
      } finally {
        setQuoteLd(false)
      }
    }, 500)
  }, [tokenIn, tokenOut, amountIn, chain.id])

  const handleFlip = () => {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmountIn('')
    setQuote(null)
    setQuoteErr(null)
  }

  const handleSwap = async () => {
    if (!tokenIn || !tokenOut || !quote || !actor) return
    setSwapState('pending')
    setSwapErr(null)
    setTxId(null)

    const amt        = parseFloat(amountIn)
    const inDec      = quote.inDecimals  ?? tokenIn.decimals  ?? 8
    const outDec     = quote.outDecimals ?? tokenOut.decimals ?? 8
    const poolIds    = quote.route.join(',')
    const minOut     = quote.amountOut * (1 - slippage / 100)
    const minOutFmt  = `${minOut.toFixed(outDec)} ${quote.outSymbol}@${quote.outContract}`
    const inAmtFmt   = `${amt.toFixed(inDec)} ${tokenIn.symbol}`

    // Alcor swap memo format:
    // swapexactin#<poolIds>#<recipient>#<minOut SYMBOL@contract>#<deadline>#<marketAccount>
    const memo = [
      'swapexactin',
      poolIds,
      actor,
      minOutFmt,
      '0',
      MARKET_ACCOUNT,
    ].join('#')

    try {
      const result = await transact([{
        account:       tokenIn.contract,
        name:          'transfer',
        authorization: [{ actor, permission: 'active' }],
        data: {
          from:     actor,
          to:       'swap.alcor',
          quantity: inAmtFmt,
          memo,
        },
      }])
      // WharfKit returns the transaction response; extract tx ID
      const txid = (result as any)?.response?.transaction_id
        ?? (result as any)?.transaction_id
        ?? null
      setTxId(txid)
      setSwapState('success')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setSwapErr(msg.includes('user rejection') ? 'Transaction cancelled' : msg)
      setSwapState('error')
    }
  }

  // ── Output amount display ────────────────────────────────────────────────────
  const outAmount = quote
    ? quote.amountOut.toFixed(quote.outDecimals ?? 4)
    : ''

  const outUsd = quote && tokenOut?.usd_price
    ? quote.amountOut * tokenOut.usd_price
    : 0

  const inUsd = tokenIn?.usd_price && parseFloat(amountIn) > 0
    ? parseFloat(amountIn) * tokenIn.usd_price
    : 0

  // For 2-hop route, determine intermediate token symbol
  const sysToken = makeSystemToken(chain)
  const routeVia = quote && quote.route.length > 1 ? sysToken.symbol : null

  // ── CTA button logic ─────────────────────────────────────────────────────────
  let ctaLabel = 'Swap'
  let ctaDisabled = false
  let ctaAction = handleSwap
  let ctaStyle  = 'bg-[#f89422] hover:bg-[#e07d10] text-white'

  if (!actor) {
    ctaLabel   = 'Connect Wallet'
    ctaAction  = login
    ctaStyle   = 'bg-white/[0.10] hover:bg-white/[0.15] text-white'
  } else if (swapState === 'pending') {
    ctaLabel    = 'Swapping…'
    ctaDisabled = true
  } else if (!tokenIn || !tokenOut) {
    ctaLabel    = 'Select Tokens'
    ctaDisabled = true
  } else if (!amountIn || parseFloat(amountIn) <= 0) {
    ctaLabel    = 'Enter Amount'
    ctaDisabled = true
  } else if (quoteLd) {
    ctaLabel    = 'Fetching Quote…'
    ctaDisabled = true
  } else if (quoteErr === 'no route found') {
    ctaLabel    = 'No Route Found'
    ctaDisabled = true
    ctaStyle    = 'bg-white/[0.06] text-gray-500 cursor-not-allowed'
  } else if (!quote) {
    ctaDisabled = true
  }

  // ── Success / Error state ────────────────────────────────────────────────────
  if (swapState === 'success') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={e => { if (e.target === e.currentTarget) onClose() }}>
        <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
        <div className="relative z-10 w-full max-w-sm rounded-2xl border border-white/[0.07] p-8
          flex flex-col items-center text-center gap-4"
          style={{ background: '#0a0f14' }}>
          <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center">
            <svg className="w-7 h-7 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <div>
            <div className="text-white font-bold text-lg">Swap Successful!</div>
            <div className="text-gray-500 text-[12px] mt-1">
              {amountIn} {tokenIn?.symbol} → {outAmount} {tokenOut?.symbol}
            </div>
          </div>
          {txId && (
            <a
              href={`${chain.explorerBase}/transaction/${txId}`}
              target="_blank" rel="noopener noreferrer"
              className="text-[11px] text-[#f89422] hover:underline"
            >
              View on Explorer ↗
            </a>
          )}
          <div className="flex gap-2 w-full mt-2">
            <button onClick={() => setSwapState('idle')}
              className="flex-1 py-2.5 rounded-xl bg-white/[0.07] text-[13px] font-semibold text-gray-300 hover:bg-white/[0.12] transition-colors">
              Swap Again
            </button>
            <button onClick={onClose}
              className="flex-1 py-2.5 rounded-xl bg-[#f89422] hover:bg-[#e07d10] text-[13px] font-semibold text-white transition-colors">
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main modal ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />

      <div className="relative z-10 w-full max-w-sm rounded-2xl overflow-hidden border border-white/[0.07] shadow-2xl flex flex-col"
        style={{ background: '#0a0f14' }}>

        {/* Token picker overlay (replaces main content when open) */}
        {picker && (
          <TokenPicker
            tokens={allTokens.filter(t =>
              picker === 'in'  ? t.id !== tokenOut?.id :
              picker === 'out' ? t.id !== tokenIn?.id  : true
            )}
            selected={picker === 'in' ? tokenIn : tokenOut}
            onSelect={t => picker === 'in' ? setTokenIn(t) : setTokenOut(t)}
            onClose={() => setPicker(null)}
          />
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-[#f89422]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
            </svg>
            <span className="text-white font-bold text-[15px]">Swap</span>
            <span className="text-[10px] text-gray-700 font-medium hidden sm:block">
              on {chain.displayName} · {MARKET_FEE_PCT}% platform fee
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSlip(s => !s)}
              title="Slippage settings"
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors
                ${showSlip ? 'bg-[#f89422]/20 text-[#f89422]' : 'bg-white/[0.07] text-gray-500 hover:text-white'}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </button>
            <button onClick={onClose}
              className="w-7 h-7 rounded-lg bg-white/[0.07] hover:bg-white/[0.14] flex items-center
                justify-center text-gray-500 hover:text-white transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Slippage panel */}
        {showSlip && <SlippagePanel slippage={slippage} onChange={setSlippage} />}

        {/* Swap inputs */}
        <div className="p-4 flex flex-col gap-1.5">
          <TokenInput
            label="From"
            token={tokenIn}
            amount={amountIn}
            usdValue={inUsd}
            readOnly={false}
            loading={false}
            onAmountChange={v => { setAmountIn(v); setSwapState('idle') }}
            onTokenClick={() => setPicker('in')}
          />

          {/* Flip button */}
          <div className="flex justify-center">
            <button
              onClick={handleFlip}
              className="w-8 h-8 rounded-full border border-white/[0.08] bg-white/[0.05]
                hover:bg-white/[0.12] flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
            </button>
          </div>

          <TokenInput
            label="To (estimated)"
            token={tokenOut}
            amount={outAmount}
            usdValue={outUsd}
            readOnly={true}
            loading={quoteLd}
            onTokenClick={() => setPicker('out')}
          />
        </div>

        {/* Quote details */}
        {quote && tokenIn && tokenOut && (
          <div className="mx-4 mb-4 rounded-xl border border-white/[0.06] overflow-hidden"
            style={{ background: '#0c1520' }}>
            <div className="px-3 py-2 space-y-1.5">

              {/* Rate */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-gray-600">Rate</span>
                <span className="text-gray-300 tabular-nums">
                  1 {tokenIn.symbol} ≈{' '}
                  {(quote.amountOut / parseFloat(amountIn)).toFixed(
                    Math.min(8, quote.outDecimals ?? 4)
                  )} {tokenOut.symbol}
                </span>
              </div>

              {/* Route */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-gray-600">Route</span>
                <RouteDisplay inToken={tokenIn} outToken={tokenOut} via={routeVia} />
              </div>

              {/* Price impact */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-gray-600">Price Impact</span>
                <ImpactBadge pct={quote.priceImpact} />
              </div>

              {/* Fees */}
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-gray-600">Fees</span>
                <span className="text-gray-400 tabular-nums">
                  {MARKET_FEE_PCT}% platform + {(quote.fee / 10_000).toFixed(2)}% pool
                </span>
              </div>

              {/* Min received */}
              <div className="flex items-center justify-between text-[11px] border-t border-white/[0.04] pt-1.5 mt-1">
                <span className="text-gray-600">Min received ({slippage}% slippage)</span>
                <span className="text-gray-200 font-semibold tabular-nums">
                  {(quote.amountOut * (1 - slippage / 100)).toFixed(quote.outDecimals ?? 4)}{' '}
                  {tokenOut.symbol}
                </span>
              </div>
            </div>

            {/* High impact warning */}
            {quote.priceImpact >= 3 && (
              <div className={`px-3 py-2 text-[11px] font-semibold border-t border-white/[0.04]
                ${quote.priceImpact >= 10 ? 'text-red-400 bg-red-500/10' : 'text-yellow-400 bg-yellow-500/10'}`}>
                {quote.priceImpact >= 10
                  ? '⚠ Very high price impact — consider a smaller amount'
                  : '⚠ Price impact is above 3%'}
              </div>
            )}
          </div>
        )}

        {/* No route message */}
        {quoteErr === 'no route found' && tokenIn && tokenOut && (
          <div className="mx-4 mb-4 rounded-xl border border-white/[0.06] px-3 py-3 text-[12px] text-gray-500 text-center"
            style={{ background: '#0c1520' }}>
            No liquidity route found between {tokenIn.symbol} and {tokenOut.symbol}
          </div>
        )}

        {/* Error state */}
        {swapState === 'error' && (
          <div className="mx-4 mb-2 rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2 text-[11px] text-red-400">
            {swapErr ?? 'Transaction failed'}
          </div>
        )}

        {/* CTA */}
        <div className="px-4 pb-4">
          <button
            onClick={ctaAction}
            disabled={ctaDisabled}
            className={`w-full py-3.5 rounded-xl text-[14px] font-bold transition-all
              ${ctaDisabled ? 'opacity-40 cursor-not-allowed' : ''}
              ${ctaStyle}`}
          >
            {swapState === 'pending' ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                {ctaLabel}
              </span>
            ) : ctaLabel}
          </button>
        </div>

        {/* Footer note */}
        <div className="px-4 pb-3 text-center text-[10px] text-gray-700">
          Powered by{' '}
          <a href="https://alcor.exchange" target="_blank" rel="noopener noreferrer"
            className="text-[#f89422] hover:underline">Alcor Exchange</a>
          {' '}· {MARKET_FEE_PCT}% commission on every swap
        </div>
      </div>
    </div>
  )
}
