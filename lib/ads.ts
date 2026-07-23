export interface MarketingAd {
  id: string
  text: string
  imageUrl: string
  imageMode?: AdImageMode
  font?: AdFont
  textColor?: string
  linkUrl: string
  startAt?: number
  expiresAt: number
  buyer: string
  txId: string
}

export interface AdReservation {
  id: string
  submissionId: string
  text: string
  imageUrl: string
  imageMode?: AdImageMode
  font?: AdFont
  textColor?: string
  linkUrl: string
  hours: number
  buyer: string
  contract: string
  symbol: PaymentSymbol
  quantity: string
  memo: string
  feeUsd: number
  quotedAt: number
  startAt: number
  endAt: number
}

export interface AdSubmission {
  id: string
  status: 'awaiting_payment' | 'pending' | 'approved' | 'rejected'
  text: string
  imageUrl: string
  imageMode?: AdImageMode
  font?: AdFont
  textColor?: string
  linkUrl: string
  hours: number
  buyer: string
  symbol: PaymentSymbol
  submittedAt: number
  startAt: number
  endAt: number
  txId?: string
  paidAt?: number
  feeUsd?: number
  quantity?: string
}

export interface AdPricingState {
  pressure: number
  updatedAt: number
  lastTxId?: string
}

export const AD_RECIPIENT = 'waxpepe.gm'
export const AD_REDIS_KEYS = {
  active: 'ad:active',
  slots: 'ad:slots',
  pricing: 'ad:pricing',
  reservation: 'ad:reservation',
  submissions: 'ad:submissions',
  submission: (id: string) => `ad:submission:${id}`,
}

export const AD_PERIODS = [
  { label: '1 hour', hours: 1, usd: 0.25 },
  { label: '6 hours', hours: 6, usd: 1 },
  { label: '24 hours', hours: 24, usd: 3 },
  { label: '7 days', hours: 168, usd: 12 },
  { label: '30 days', hours: 720, usd: 30 },
] as const

export const PAYMENT_TOKENS = {
  KEK: { contract: 'waxpepetoken', precision: 4 },
  DEAL: { contract: 'dealwithitwx', precision: 8 },
  WAX: { contract: 'eosio.token', precision: 8 },
} as const

export type PaymentSymbol = keyof typeof PAYMENT_TOKENS

export const AD_FONTS = {
  sans: { label: 'Clean sans', canvas: 'Inter, system-ui, sans-serif' },
  serif: { label: 'Classic serif', canvas: 'Georgia, serif' },
  display: { label: 'Bold display', canvas: 'Impact, Haettenschweiler, sans-serif' },
  mono: { label: 'Monospace', canvas: '"Courier New", monospace' },
} as const

export type AdFont = keyof typeof AD_FONTS
export type AdImageMode = 'none' | 'logo' | 'background'

const PRESSURE_HALF_LIFE_MS = 7 * 24 * 3600 * 1000
const VIRTUAL_CAPACITY_HOURS = 7 * 24

// A seven-day virtual reserve with a squared price curve, matching the shape of
// constant-product LP spot pricing. Bookings consume reserve; inactivity restores it.
export function decayedAdPressure(state: AdPricingState | null, now: number): number {
  if (!state) return 0
  const pressure = Math.max(0, state.pressure) * 0.5 ** (Math.max(0, now - state.updatedAt) / PRESSURE_HALF_LIFE_MS)
  return pressure < 1e-9 ? 0 : pressure
}

export function adDemandMultiplier(state: AdPricingState | null, now: number): number {
  return (1 + decayedAdPressure(state, now)) ** 2
}

export function adQuoteUsd(floorUsd: number, state: AdPricingState | null, now: number): number {
  return Math.ceil(floorUsd * adDemandMultiplier(state, now) * 100) / 100
}

export function recordAdUsage(
  state: AdPricingState | null,
  hours: number,
  now: number,
  txId: string,
): AdPricingState {
  if (state?.lastTxId === txId) return state
  return {
    pressure: decayedAdPressure(state, now) + hours / VIRTUAL_CAPACITY_HOURS,
    updatedAt: now,
    lastTxId: txId,
  }
}

export function safeHttpUrl(value: unknown, optional = false, allowRelative = false): string | null {
  if (optional && !value) return ''
  if (allowRelative && typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value
  try {
    const url = new URL(String(value))
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

export function ipfsImageUrl(value: unknown): string | null {
  const path = String(value ?? '').trim().replace(/^ipfs:\/\/(?:ipfs\/)?/, '')
  if (!/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})(?:\/|$)/.test(path)) return null
  return `https://ipfs.io/ipfs/${path}`
}

export function safeAdColor(value: unknown): string | null {
  const color = String(value ?? '')
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null
}

export function bookingOverlaps(startAt: number, endAt: number, slot: Pick<AdSubmission, 'startAt' | 'endAt'>): boolean {
  return startAt < slot.endAt && endAt > slot.startAt
}

export function tokenQuantity(usdFee: number, tokenUsdPrice: number, symbol: PaymentSymbol): string {
  if (!(tokenUsdPrice > 0)) throw new Error(`${symbol} price is unavailable`)
  const precision = PAYMENT_TOKENS[symbol].precision
  const scale = 10 ** precision
  const units = Math.ceil(usdFee / tokenUsdPrice * scale)
  if (!Number.isSafeInteger(units)) throw new Error(`${symbol} price is too small for a safe quote`)
  return `${(units / scale).toFixed(precision)} ${symbol}`
}

interface HyperionTransaction {
  executed?: boolean
  actions?: Array<{
    act?: {
      account?: string
      name?: string
      data?: {
        from?: string
        to?: string
        quantity?: string
        memo?: string
      }
    }
  }>
}

export function hasExpectedPayment(transaction: HyperionTransaction, reservation: AdReservation): boolean {
  return transaction.executed === true && !!transaction.actions?.some(({ act }) =>
    act?.account === reservation.contract &&
    act.name === 'transfer' &&
    act.data?.from === reservation.buyer &&
    act.data.to === AD_RECIPIENT &&
    act.data.quantity === reservation.quantity &&
    act.data.memo === reservation.memo
  )
}
