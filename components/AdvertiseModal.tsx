'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWallet } from '@/contexts/WalletContext'
import { GiphyFetch } from '@giphy/js-fetch-api'
import {
  AD_PERIODS,
  AD_FONTS,
  AD_OVERLAY_POSITIONS,
  PAYMENT_TOKENS,
  AdFont,
  AdImageMode,
  AdOverlayPosition,
  AdReservation,
  AdSubmission,
  PaymentSymbol,
  bookingOverlaps,
  ipfsImageUrl,
  safeHttpUrl,
  tokenQuantity,
} from '@/lib/ads'
import { TokenBubbleData } from '@/lib/types'
import LiquidLoader from '@/components/LiquidLoader'

interface Props {
  tokens: TokenBubbleData[]
  marketDataAt: number | null
  onClose: () => void
}

const SUBMISSION_KEY = 'antbubbles-ad-submission'
const PAYMENT_KEY = 'antbubbles-ad-payment'
const GIPHY_API_KEY = process.env.NEXT_PUBLIC_GIPHY_API_KEY

interface Pricing {
  asOf: number
  multiplier: number
  quotes: Array<{ hours: number; usd: number }>
}

interface CalendarSlot {
  startAt: number
  endAt: number
  status: 'pending' | 'approved'
}

interface GiphyGif {
  id: string
  title: string
  previewUrl: string
  url: string
}

function displayAsset(asset: string | null): string {
  if (!asset) return 'Unavailable'
  const [amount, symbol] = asset.split(' ')
  return `${Number(amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} ${symbol}`
}

function datetimeLocal(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:00`
}

const OVERLAY_LABELS: Record<AdOverlayPosition, string> = {
  'top-left': 'Top left', 'top-center': 'Top centre', 'top-right': 'Top right',
  'center-left': 'Centre left', 'center': 'Centre', 'center-right': 'Centre right',
  'bottom-left': 'Bottom left', 'bottom-center': 'Bottom centre', 'bottom-right': 'Bottom right',
}

function OverlayPositionPicker({
  label,
  value,
  onChange,
}: {
  label: string
  value: AdOverlayPosition
  onChange: (position: AdOverlayPosition) => void
}) {
  return (
    <fieldset>
      <legend className="text-xs font-semibold text-gray-400">{label}</legend>
      <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-[#080c10] p-1.5">
        {AD_OVERLAY_POSITIONS.map(position => (
          <button key={position} type="button" onClick={() => onChange(position)}
            aria-label={OVERLAY_LABELS[position]} aria-pressed={value === position}
            className={`h-7 rounded text-[9px] font-bold transition-colors ${
              value === position ? 'bg-[#ffd700] text-black' : 'text-gray-500 hover:bg-white/[0.08] hover:text-white'
            }`}>
            {position.replace('center', 'C').replace('top', 'T').replace('bottom', 'B').replace('-left', 'L').replace('-right', 'R')}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

function overlayStyle(position: AdOverlayPosition): React.CSSProperties {
  const [vertical, horizontal = 'center'] = position.split('-')
  const left = horizontal === 'left' ? '18%' : horizontal === 'right' ? '82%' : '50%'
  const top = vertical === 'top' ? '18%' : vertical === 'bottom' ? '68%' : '43%'
  return { left, top, transform: 'translate(-50%, -50%)' }
}

export default function AdvertiseModal({ tokens, marketDataAt, onClose }: Props) {
  const { actor, accounts, login, switchAccount, transact } = useWallet()
  const [text, setText] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [tokenId, setTokenId] = useState('')
  const [imageMode, setImageMode] = useState<AdImageMode>('none')
  const [ipfsUrl, setIpfsUrl] = useState('')
  const [gifSearch, setGifSearch] = useState('')
  const [gifResults, setGifResults] = useState<GiphyGif[]>([])
  const [gifLoading, setGifLoading] = useState(false)
  const [gifError, setGifError] = useState('')
  const [font, setFont] = useState<AdFont>('sans')
  const [textColor, setTextColor] = useState('#ffe066')
  const [textPosition, setTextPosition] = useState<AdOverlayPosition>('center')
  const [logoPosition, setLogoPosition] = useState<AdOverlayPosition>('top-center')
  const [hours, setHours] = useState(24)
  const [startTime, setStartTime] = useState('')
  const [minimumStart, setMinimumStart] = useState('')
  const [slotAvailability, setSlotAvailability] = useState<{ key: string; available: boolean } | null>(null)
  const [calendarView, setCalendarView] = useState<'week' | 'month'>('week')
  const [calendarAvailability, setCalendarAvailability] = useState<{
    key: string
    slots: CalendarSlot[]
    failed: boolean
  } | null>(null)
  const [symbol, setSymbol] = useState<PaymentSymbol>('KEK')
  const [submission, setSubmission] = useState<AdSubmission | null>(null)
  const [pricing, setPricing] = useState<Pricing | null>(null)
  const [pendingPayment, setPendingPayment] = useState<{ reservationId: string; txId: string } | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      const saved = localStorage.getItem(PAYMENT_KEY)
      return saved ? JSON.parse(saved) : null
    } catch {
      return null
    }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [accountPickerOpen, setAccountPickerOpen] = useState(false)

  const selectedToken = tokens.find(token => token.id === tokenId)
  const previewBackground = imageMode === 'background' ? ipfsImageUrl(ipfsUrl) ?? safeHttpUrl(ipfsUrl) : ''
  const previewLogo = selectedToken?.logoUrl ?? ''
  const giphyFetch = useMemo(() => GIPHY_API_KEY
    ? new GiphyFetch(GIPHY_API_KEY)
    : null, [])
  const searchGifs = useCallback(async (query: string) => {
    if (!giphyFetch) return
    setGifLoading(true)
    setGifError('')
    try {
      const result = query
        ? await giphyFetch.search(query, { limit: 12, rating: 'g' })
        : await giphyFetch.trending({ limit: 12, rating: 'g' })
      setGifResults(result.data.flatMap(gif => {
        const url = gif.images.fixed_width?.url ?? gif.images.original.url
        const previewUrl = gif.images.fixed_width_small?.url ?? url
        return url ? [{ id: String(gif.id), title: gif.title || 'GIF', previewUrl, url }] : []
      }))
    } catch (cause) {
      setGifError(cause instanceof Error ? cause.message : 'GIF search failed')
    } finally {
      setGifLoading(false)
    }
  }, [giphyFetch])
  const bookingStartAt = startTime ? new Date(startTime).getTime() : 0
  const availabilityKey = `${bookingStartAt}:${hours}`
  const slotAvailable = slotAvailability?.key === availabilityKey ? slotAvailability.available : null
  const calendarStart = minimumStart ? new Date(new Date(minimumStart).setHours(0, 0, 0, 0)).getTime() : 0
  const calendarDays = calendarView === 'week' ? 7 : 30
  const calendarDates = calendarStart ? Array.from({ length: calendarDays }, (_, index) => {
    const date = new Date(calendarStart)
    date.setDate(date.getDate() + index)
    return date
  }) : []
  const calendarEnd = calendarDates.length
    ? new Date(new Date(calendarDates.at(-1)!).setDate(calendarDates.at(-1)!.getDate() + 1)).getTime()
    : 0
  const calendarKey = `${calendarStart}:${calendarEnd}`
  const visibleCalendar = calendarAvailability?.key === calendarKey ? calendarAvailability : null
  const quoteHours = submission?.hours ?? hours
  const floorUsd = AD_PERIODS.find(period => period.hours === quoteHours)?.usd ?? 0
  const quoteUsd = pricing?.quotes.find(quote => quote.hours === quoteHours)?.usd ?? floorUsd
  const assetQuote = (paymentSymbol: PaymentSymbol) => {
    const token = tokens.find(item => item.contract === PAYMENT_TOKENS[paymentSymbol].contract)
    const waxReference = tokens.find(item => item.system_price > 0)
    const tokenUsdPrice = paymentSymbol === 'WAX' && waxReference
      ? waxReference.usd_price / waxReference.system_price
      : token?.usd_price
    try {
      return tokenUsdPrice ? tokenQuantity(quoteUsd, tokenUsdPrice, paymentSymbol) : null
    } catch {
      return null
    }
  }
  const quotePanel = (
    <div className="rounded-xl bg-white/[0.05] p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="text-gray-400">Current fee</span>
        <strong className="text-white">${quoteUsd.toFixed(2)} USD</strong>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-gray-500">KEK</span>
        <span className="font-medium text-[#ffd700]">≈ {displayAsset(assetQuote('KEK'))}</span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-gray-500">DEAL</span>
        <span className="font-medium text-[#ffd700]">≈ {displayAsset(assetQuote('DEAL'))}</span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="text-gray-500">WAX</span>
        <span className="font-medium text-[#ffd700]">≈ {displayAsset(assetQuote('WAX'))}</span>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-gray-500">
        Floor ${floorUsd.toFixed(2)} · demand {pricing?.multiplier.toFixed(2) ?? '1.00'}× as of{' '}
        {pricing ? new Date(pricing.asOf).toLocaleTimeString() : 'loading'} · token prices as of{' '}
        {marketDataAt ? new Date(marketDataAt).toLocaleTimeString() : 'the latest bubble snapshot'}
      </p>
    </div>
  )

  const refreshSubmission = useCallback(async (id: string) => {
    const response = await fetch(`/api/ad?submission=${encodeURIComponent(id)}`, { cache: 'no-store' })
    const body = await response.json()
    if (response.ok && body) setSubmission(body)
  }, [])

  useEffect(() => {
    const id = localStorage.getItem(SUBMISSION_KEY)
    if (id) fetch(`/api/ad?submission=${encodeURIComponent(id)}`, { cache: 'no-store' })
      .then(response => response.json())
      .then(body => { if (body) setSubmission(body) })
      .catch(() => {})
  }, [refreshSubmission])

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const nextHour = new Date()
      nextHour.setMinutes(0, 0, 0)
      nextHour.setHours(nextHour.getHours() + 1)
      const value = datetimeLocal(nextHour)
      setMinimumStart(value)
      setStartTime(value)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    if (!bookingStartAt) return
    let active = true
    fetch(`/api/ad?availability=1&from=${bookingStartAt}&to=${bookingStartAt + hours * 3_600_000}`, { cache: 'no-store' })
      .then(response => response.json())
      .then(body => { if (active) setSlotAvailability({ key: availabilityKey, available: Array.isArray(body.slots) && body.slots.length === 0 }) })
      .catch(() => { if (active) setSlotAvailability({ key: availabilityKey, available: false }) })
    return () => { active = false }
  }, [availabilityKey, bookingStartAt, hours])

  useEffect(() => {
    if (!calendarStart || !calendarEnd) return
    let active = true
    fetch(`/api/ad?availability=1&from=${calendarStart}&to=${calendarEnd}`, { cache: 'no-store' })
      .then(response => response.json())
      .then(body => {
        if (active) setCalendarAvailability({
          key: calendarKey,
          slots: Array.isArray(body.slots) ? body.slots : [],
          failed: !Array.isArray(body.slots),
        })
      })
      .catch(() => {
        if (active) setCalendarAvailability({ key: calendarKey, slots: [], failed: true })
      })
    return () => { active = false }
  }, [calendarEnd, calendarKey, calendarStart])

  useEffect(() => {
    let active = true
    const refresh = () => fetch('/api/ad/quote', { cache: 'no-store' })
      .then(response => response.json())
      .then(body => { if (active) setPricing(body) })
      .catch(() => {})
    refresh()
    const interval = setInterval(refresh, 30_000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  useEffect(() => {
    if (submission?.status !== 'pending') return
    const interval = setInterval(() => refreshSubmission(submission.id).catch(() => {}), 10_000)
    return () => clearInterval(interval)
  }, [refreshSubmission, submission])

  useEffect(() => {
    if (submission?.status === 'approved') localStorage.removeItem(SUBMISSION_KEY)
  }, [submission?.status])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  async function submitForReview() {
    if (!actor) return login()
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/ad', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          linkUrl,
          imageUrl: imageMode === 'background' ? ipfsUrl : '',
          imageMode,
          logoUrl: previewLogo,
          font,
          textColor,
          textPosition,
          logoPosition,
          hours,
          startAt: bookingStartAt,
          timezoneOffset: new Date().getTimezoneOffset(),
          symbol,
          buyer: actor,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not submit the ad')
      localStorage.setItem(SUBMISSION_KEY, body.id)
      setSubmission(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function confirmPayment(payment: { reservationId: string; txId: string }) {
    let response: Response | undefined
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch('/api/ad?confirm=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payment),
      })
      if (response.status !== 425) break
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
    const body = await response!.json()
    if (!response!.ok) throw new Error(body.error ?? 'Could not verify the paid booking')
    localStorage.removeItem(PAYMENT_KEY)
    setPendingPayment(null)
    setSubmission(body as AdSubmission)
  }

  async function pay() {
    if (!actor) return login()
    if (!submission || submission.status !== 'awaiting_payment') return
    setBusy(true)
    setError('')
    try {
      if (pendingPayment) {
        await confirmPayment(pendingPayment)
        return
      }
      const prepared = await fetch('/api/ad?payment=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: submission.id, buyer: actor }),
      })
      const body = await prepared.json()
      if (!prepared.ok) throw new Error(body.error ?? 'Could not reserve the ad slot')

      const reservation = body.reservation as AdReservation
      const result = await transact([{
        account: reservation.contract,
        name: 'transfer',
        authorization: [{ actor, permission: 'active' }],
        data: {
          from: actor,
          to: body.recipient,
          quantity: reservation.quantity,
          memo: reservation.memo,
        },
      }]) as { response?: { transaction_id?: string }; transaction_id?: string }
      const txId = result.response?.transaction_id ?? result.transaction_id
      if (!txId) throw new Error('Wallet did not return a transaction ID')
      const payment = { reservationId: reservation.id, txId }
      localStorage.setItem(PAYMENT_KEY, JSON.stringify(payment))
      setPendingPayment(payment)
      await confirmPayment(payment)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (!message.toLowerCase().includes('cancel') && !message.toLowerCase().includes('reject')) setError(message)
    } finally {
      setBusy(false)
    }
  }

  async function selectPaymentAccount(account?: string) {
    setError('')
    try {
      if (account) await switchAccount(account)
      else await login()
      setAccountPickerOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not switch wallet')
    }
  }

  function startOver() {
    localStorage.removeItem(SUBMISSION_KEY)
    localStorage.removeItem(PAYMENT_KEY)
    setSubmission(null)
    setPendingPayment(null)
    setError('')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={event => {
      if (event.target === event.currentTarget && !busy) onClose()
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="advertise-title"
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-white/10 bg-[#0a0f14] p-5 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 id="advertise-title" className="font-bold text-white">Advertise on AntBubbles</h2>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="text-gray-500 hover:text-white">×</button>
        </div>

        {!submission ? (
          <div className="space-y-4">
            <label className="block text-xs font-semibold text-gray-400">
              Bubble text
              <input autoFocus value={text} onChange={event => setText(event.target.value)} maxLength={30} required
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-white outline-none focus:border-[#ffd700]/50" />
            </label>
            <label className="block text-xs font-semibold text-gray-400">
              Destination
              <input type="url" value={linkUrl} onChange={event => setLinkUrl(event.target.value)}
                placeholder="https://your-project.com" required
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-white outline-none focus:border-[#ffd700]/50" />
            </label>
            <label className="block text-xs font-semibold text-gray-400">
              Creative background
              <select value={imageMode} onChange={event => setImageMode(event.target.value as AdImageMode)}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#111820] px-3 py-2 text-white">
                <option value="none">No background</option>
                <option value="background">GIF, meme, or image</option>
              </select>
            </label>
            {imageMode === 'background' && (
              <div className="space-y-3">
                <label className="block text-xs font-semibold text-gray-400">
                  GIF, meme, or image URL
                  <input value={ipfsUrl} onChange={event => setIpfsUrl(event.target.value)}
                    placeholder="https://…/meme.gif or ipfs://bafy…"
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-white outline-none focus:border-[#ffd700]/50" />
                  <span className="mt-1.5 block font-normal leading-relaxed text-gray-500">
                    GIF, PNG, WebP, JPEG, and IPFS links work. Square artwork reads best; the bubble crops the edges.
                  </span>
                </label>
                <section aria-labelledby="gif-picker-title" className="rounded-xl border border-white/10 bg-[#080c10] p-3">
                  <h3 id="gif-picker-title" className="mb-2 text-xs font-semibold text-gray-300">Find a GIF</h3>
                  {giphyFetch ? (
                    <div className="space-y-2">
                      <div className="flex gap-2">
                        <input value={gifSearch} onChange={event => setGifSearch(event.target.value)}
                          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void searchGifs(gifSearch.trim()) } }}
                          placeholder="Search GIPHY" className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm text-white outline-none focus:border-[#ffd700]/50" />
                        <button type="button" onClick={() => void searchGifs(gifSearch.trim())} disabled={gifLoading}
                          className="rounded-lg bg-[#ffd700] px-3 text-sm font-bold text-black disabled:opacity-40">
                          {gifSearch.trim() ? 'Search' : 'Trending'}
                        </button>
                      </div>
                      {gifLoading && <p className="text-center text-xs text-gray-500">Loading GIFs…</p>}
                      {gifError && <p role="alert" className="text-xs text-red-300">{gifError}</p>}
                      {gifResults.length > 0 && !gifLoading && (
                        <div className="grid grid-cols-3 gap-1.5">
                          {gifResults.map(gif => (
                            <button key={gif.id} type="button" title={`Use ${gif.title}`} onClick={() => setIpfsUrl(gif.url)}
                              className="aspect-square overflow-hidden rounded-md border border-white/10 focus:outline-none focus:ring-2 focus:ring-[#ffd700]">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={gif.previewUrl} alt={gif.title} className="h-full w-full object-cover" />
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="text-center text-[10px] font-semibold text-gray-500">Powered by GIPHY</p>
                    </div>
                  ) : (
                    <p className="text-[11px] leading-relaxed text-gray-500">GIF search needs <code className="text-gray-300">NEXT_PUBLIC_GIPHY_API_KEY</code>; you can still paste any GIF URL above.</p>
                  )}
                </section>
              </div>
            )}
            <label className="block text-xs font-semibold text-gray-400">
              Token logo overlay
              <select value={tokenId} onChange={event => setTokenId(event.target.value)}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#111820] px-3 py-2 text-white">
                <option value="">No token logo</option>
                {tokens.map(token => <option key={token.id} value={token.id}>{token.symbol} · {token.contract}</option>)}
              </select>
            </label>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <label className="text-xs font-semibold text-gray-400">
                Text font
                <select value={font} onChange={event => setFont(event.target.value as AdFont)}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#111820] px-3 py-2 text-white">
                  {Object.entries(AD_FONTS).map(([value, option]) => (
                    <option key={value} value={value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold text-gray-400">
                Text colour
                <input type="color" value={textColor} onChange={event => setTextColor(event.target.value)}
                  className="mt-1.5 block h-[38px] w-14 cursor-pointer rounded-lg border border-white/10 bg-[#111820] p-1" />
              </label>
            </div>
            <div className={`grid gap-3 ${previewLogo ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <OverlayPositionPicker label="Text placement" value={textPosition} onChange={setTextPosition} />
              {previewLogo && <OverlayPositionPicker label="Logo placement" value={logoPosition} onChange={setLogoPosition} />}
            </div>
            <div className="flex items-center gap-4 rounded-xl bg-white/[0.05] p-3">
              <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-[#291900] ring-1 ring-[#ffd700]">
                {previewBackground && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewBackground} alt="" className="absolute inset-0 h-full w-full object-cover" />
                )}
                {previewLogo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={previewLogo} alt="" className="absolute h-7 w-7 rounded-full object-contain p-0.5"
                    style={overlayStyle(logoPosition)} />
                )}
                <span className="absolute w-[68%] text-center text-xs font-bold leading-tight [text-shadow:0_1px_3px_#000]"
                  style={{ ...overlayStyle(textPosition), color: textColor, fontFamily: AD_FONTS[font].canvas }}>
                  {text || 'Your text'}
                </span>
              </div>
              <p className="text-xs leading-relaxed text-gray-400">Preview: your GIF or image fills the bubble; text and token logo use the placements above.</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-semibold text-gray-400">
                Duration
                <select value={hours} onChange={event => setHours(Number(event.target.value))}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#111820] px-3 py-2 text-white">
                  {AD_PERIODS.map(period => {
                    const current = pricing?.quotes.find(quote => quote.hours === period.hours)?.usd ?? period.usd
                    const discount = Math.round((1 - period.usd / (AD_PERIODS[0].usd * period.hours)) * 100)
                    return <option key={period.hours} value={period.hours}>{period.label} — ${current.toFixed(2)} · {discount}% discount</option>
                  })}
                </select>
              </label>
              <label className="text-xs font-semibold text-gray-400">
                Pay with
                <select value={symbol} onChange={event => setSymbol(event.target.value as PaymentSymbol)}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#111820] px-3 py-2 text-white">
                  <option value="KEK">KEK · waxpepetoken</option>
                  <option value="DEAL">DEAL · dealwithitwx</option>
                  <option value="WAX">WAX · eosio.token</option>
                </select>
              </label>
            </div>
            <section aria-labelledby="booking-calendar-title">
              <div className="flex items-center justify-between">
                <h3 id="booking-calendar-title" className="text-xs font-semibold text-gray-400">Booking calendar</h3>
                <div className="flex rounded-lg bg-white/[0.06] p-0.5">
                  {(['week', 'month'] as const).map(view => (
                    <button key={view} type="button" onClick={() => setCalendarView(view)}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-semibold capitalize ${
                        calendarView === view ? 'bg-[#ffd700] text-black' : 'text-gray-400 hover:text-white'
                      }`}>
                      {view}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-gray-400">
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-green-500/70" />Free</span>
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-red-500/70" />Occupied</span>
                <span><i className="mr-1 inline-block h-2 w-2 rounded-sm bg-amber-400/70" />Pending confirmation</span>
              </div>
              <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-white/10 bg-[#080c10]">
                {!visibleCalendar ? (
                  <div className="flex items-center justify-center px-3 py-8">
                    <LiquidLoader label="Loading hourly availability" />
                  </div>
                ) : visibleCalendar.failed ? (
                  <p className="px-3 py-8 text-center text-xs text-red-400">Could not load booking availability.</p>
                ) : (
                  <div className="flex min-w-max">
                    <div className="sticky left-0 z-20 w-11 shrink-0 bg-[#080c10] pt-9">
                      {Array.from({ length: 24 }, (_, hour) => (
                        <div key={hour} className="flex h-7 items-center justify-center text-[9px] tabular-nums text-gray-600">
                          {String(hour).padStart(2, '0')}
                        </div>
                      ))}
                    </div>
                    {calendarDates.map(date => (
                      <div key={date.getTime()} className="w-11 shrink-0 border-l border-white/[0.06]">
                        <div className="sticky top-0 z-10 flex h-9 flex-col items-center justify-center bg-[#111820] text-[9px] leading-tight text-gray-400">
                          <span>{date.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                          <strong className="text-[11px] text-white">{date.getDate()}</strong>
                        </div>
                        {Array.from({ length: 24 }, (_, hour) => {
                          const start = new Date(date)
                          start.setHours(hour, 0, 0, 0)
                          const startAt = start.getTime()
                          const endAt = startAt + 3_600_000
                          const matching = visibleCalendar.slots.filter(slot => bookingOverlaps(startAt, endAt, slot))
                          const status = matching.some(slot => slot.status === 'approved') ? 'occupied' :
                            matching.length ? 'pending' : startAt < new Date(minimumStart).getTime() ? 'past' : 'free'
                          const selected = bookingStartAt === startAt
                          const label = `${start.toLocaleString()} — ${status === 'pending' ? 'pending confirmation' : status}`
                          return (
                            <button key={hour} type="button" title={label} aria-label={label}
                              disabled={status !== 'free'}
                              onClick={() => setStartTime(datetimeLocal(start))}
                              className={`block h-7 w-11 rounded-sm border-2 border-[#080c10] transition-colors ${
                                selected ? 'ring-2 ring-inset ring-[#ffd700] ' : ''
                              }${
                                status === 'free' ? 'bg-green-500/35 hover:bg-green-400/65' :
                                status === 'occupied' ? 'bg-red-500/55' :
                                status === 'pending' ? 'bg-amber-400/55' : 'bg-white/[0.03]'
                              } disabled:cursor-not-allowed`}
                            />
                          )
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <p aria-live="polite" className={`mt-2 text-xs ${
                slotAvailable === true ? 'text-green-400' : slotAvailable === false ? 'text-red-400' : 'text-gray-500'
              }`}>
                {startTime ? new Date(bookingStartAt).toLocaleString() : 'Choose a free hour'} ·{' '}
                {slotAvailable === true ? `${hours}-hour booking available` :
                  slotAvailable === false ? `${hours}-hour booking overlaps another slot` : 'checking full duration…'}
              </p>
            </section>
            {quotePanel}
            {error && <p role="alert" className="rounded-lg bg-red-950/50 px-3 py-2 text-xs text-red-300">{error}</p>}
            <button onClick={submitForReview} disabled={busy || !text.trim() || !linkUrl.trim() ||
              slotAvailable !== true || (imageMode === 'background' && !previewBackground)}
              className="w-full rounded-xl bg-[#ffd700] py-3 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-40">
              {busy ? 'Submitting…' : actor ? 'Continue to payment' : 'Connect wallet'}
            </button>
            <p className="text-center text-[11px] text-gray-500">
              Payment is taken before owner review and does not guarantee approval. USD pricing converts to KEK, DEAL, or WAX at checkout using the live Alcor price.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl bg-white/[0.05] p-4">
              <div className="flex items-center justify-between gap-3">
                <span className="font-bold text-white">{submission.text}</span>
                <span className={`text-xs font-semibold ${
                  submission.status === 'approved' ? 'text-green-400' :
                  submission.status === 'rejected' ? 'text-red-400' : 'text-amber-400'
                }`}>{submission.status === 'awaiting_payment' ? 'awaiting payment' : submission.status}</span>
              </div>
              <a href={submission.linkUrl} target="_blank" rel="noopener noreferrer"
                className="mt-2 block truncate text-xs text-[#f89422] hover:underline">{submission.linkUrl} ↗</a>
              <p className="mt-2 text-xs text-gray-400">
                {new Date(submission.startAt).toLocaleString()}–{new Date(submission.endAt).toLocaleString()}
              </p>
            </div>

            {submission.status === 'awaiting_payment' && (
              <>
                {quotePanel}
                <p className="text-sm text-gray-300">
                  Pay now to send this booked slot to owner review. It displays only if the owner approves it.
                </p>
                {actor && !pendingPayment && !busy && (
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">Paying from</p>
                        <p className="truncate text-sm font-semibold text-white">{actor}</p>
                      </div>
                      <button onClick={() => setAccountPickerOpen(open => !open)}
                        className="shrink-0 text-xs font-semibold text-[#f89422] hover:text-[#ffad4d]">
                        Switch wallet
                      </button>
                    </div>
                    {accountPickerOpen && (
                      <div className="mt-3 space-y-1 border-t border-white/10 pt-2">
                        {accounts.filter(account => account !== actor).map(account => (
                          <button key={account} onClick={() => void selectPaymentAccount(account)}
                            className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-xs text-gray-300 hover:bg-white/[0.07] hover:text-white">
                            <span className="truncate">{account}</span><span className="text-[#f89422]">Use</span>
                          </button>
                        ))}
                        <button onClick={() => void selectPaymentAccount()} className="w-full rounded-lg px-2 py-2 text-left text-xs font-semibold text-[#f89422] hover:bg-white/[0.07]">
                          Connect another wallet
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {error && <p role="alert" className="rounded-lg bg-red-950/50 px-3 py-2 text-xs text-red-300">{error}</p>}
                <button onClick={pay} disabled={busy}
                  className="w-full rounded-xl bg-[#ffd700] py-3 text-sm font-bold text-black disabled:opacity-40">
                  {busy ? 'Waiting…' : pendingPayment ? 'Retry payment verification' : actor ? `Pay with ${submission.symbol}` : 'Connect wallet'}
                </button>
                {!pendingPayment && (
                  <button onClick={startOver} disabled={busy}
                    className="w-full rounded-xl border border-white/15 py-3 text-sm font-semibold text-white disabled:opacity-40">
                    Back to edit
                  </button>
                )}
              </>
            )}
            {submission.status === 'pending' && (
              <p className="text-sm text-green-300">Payment confirmed and slot reserved. Awaiting owner review; this window checks automatically.</p>
            )}
            {submission.status === 'rejected' && (
              <>
                <p className="text-sm text-red-300">This paid creative or destination was rejected. Contact the app owner about a refund.</p>
                <button onClick={startOver} className="w-full rounded-xl border border-white/15 py-3 text-sm font-semibold text-white">
                  Create another ad
                </button>
              </>
            )}
            {submission.status === 'approved' && (
              <>
                <p className="text-sm text-green-300">
                  Approved and scheduled for the booked hourly slot.
                </p>
                <button onClick={onClose}
                  className="w-full rounded-xl bg-[#ffd700] py-3 text-sm font-bold text-black">
                  Done
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
