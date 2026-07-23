export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import type { Redis } from '@upstash/redis'
import { getRedis } from '@/lib/redis'
import {
  AD_PERIODS,
  AD_FONTS,
  AD_OVERLAY_POSITIONS,
  AD_RECIPIENT,
  AD_REDIS_KEYS,
  AdFont,
  AdImageMode,
  AdOverlayPosition,
  AdPricingState,
  AdReservation,
  AdSubmission,
  MarketingAd,
  PAYMENT_TOKENS,
  PaymentSymbol,
  adQuoteUsd,
  bookingOverlaps,
  hasExpectedPayment,
  ipfsImageUrl,
  recordAdUsage,
  safeAdColor,
  safeHttpUrl,
  tokenQuantity,
} from '@/lib/ads'

const ACCOUNT_RE = /^[a-z1-5.]{1,12}$/
const ID_RE = /^[a-f0-9-]{36}$/
const TX_RE = /^[a-f0-9]{64}$/
const HOUR_MS = 3_600_000
const MAX_BOOKING_MS = Math.max(...AD_PERIODS.map(period => period.hours)) * HOUR_MS

function jsonError(error: string, status: number) {
  return NextResponse.json({ error }, { status })
}

function isOverlayPosition(value: unknown): value is AdOverlayPosition {
  return AD_OVERLAY_POSITIONS.includes(value as AdOverlayPosition)
}

async function bookedSlots(redis: Redis, from: number, to: number): Promise<AdSubmission[]> {
  // ponytail: low-volume global scan; index slot ends separately if bookings become busy.
  const ids = await redis.zrange<string[]>(
    AD_REDIS_KEYS.slots,
    from - MAX_BOOKING_MS,
    to - 1,
    { byScore: true },
  )
  const submissions = await Promise.all(ids.map(id => redis.get<AdSubmission>(AD_REDIS_KEYS.submission(id))))
  return submissions.filter((submission): submission is AdSubmission =>
    !!submission &&
    (submission.status === 'pending' || submission.status === 'approved') &&
    bookingOverlaps(from, to, submission)
  )
}

function marketingAd(submission: AdSubmission): MarketingAd {
  return {
    id: submission.id,
    text: submission.text,
    imageUrl: submission.imageUrl,
    imageMode: submission.imageMode,
    logoUrl: submission.logoUrl,
    font: submission.font,
    textColor: submission.textColor,
    textPosition: submission.textPosition,
    logoPosition: submission.logoPosition,
    linkUrl: submission.linkUrl,
    startAt: submission.startAt,
    expiresAt: submission.endAt,
    buyer: submission.buyer,
    txId: submission.txId!,
  }
}

export async function GET(req: NextRequest) {
  const redis = getRedis()
  const availability = req.nextUrl.searchParams.get('availability') === '1'
  if (!redis) return NextResponse.json(availability ? { slots: [] } : null)

  const submissionId = req.nextUrl.searchParams.get('submission')
  if (submissionId) {
    if (!ID_RE.test(submissionId)) return jsonError('Invalid submission', 400)
    return NextResponse.json(await redis.get<AdSubmission>(AD_REDIS_KEYS.submission(submissionId)))
  }

  if (availability) {
    const from = Number(req.nextUrl.searchParams.get('from'))
    const to = Number(req.nextUrl.searchParams.get('to'))
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to - from > 90 * 24 * HOUR_MS) {
      return jsonError('Invalid availability range', 400)
    }
    const slots = await bookedSlots(redis, from, to)
    return NextResponse.json({
      slots: slots.map(slot => ({ startAt: slot.startAt, endAt: slot.endAt, status: slot.status })),
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const now = Date.now()
  const legacyAd = await redis.get<MarketingAd>(AD_REDIS_KEYS.active)
  const scheduledAd = (await bookedSlots(redis, now, now + 1)).find(slot => slot.status === 'approved')
  return NextResponse.json(scheduledAd ? marketingAd(scheduledAd) :
    legacyAd?.expiresAt && legacyAd.expiresAt > now ? legacyAd : null, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

async function currentUsdPrice(contract: string, symbol: PaymentSymbol): Promise<number> {
  const response = await fetch('https://wax.alcor.exchange/api/v2/tokens', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error('Token pricing is temporarily unavailable')
  const tokens = await response.json() as Array<{ contract?: string; symbol?: string; usd_price?: number | string }>
  const price = Number(tokens.find(token => token.contract === contract && token.symbol === symbol)?.usd_price)
  if (!(price > 0)) throw new Error('Token pricing is temporarily unavailable')
  return price
}

async function submitForReview(req: NextRequest) {
  const redis = getRedis()
  if (!redis) return jsonError('Advertising is not configured', 503)
  const body = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError('Invalid request', 400)

  const text = String(body.text ?? '').trim().slice(0, 30)
  const linkUrl = safeHttpUrl(body.linkUrl)
  const imageMode = String(body.imageMode ?? 'none') as AdImageMode
  const imageUrl = imageMode === 'background'
    ? ipfsImageUrl(body.imageUrl) ?? safeHttpUrl(body.imageUrl)
    : imageMode === 'logo'
      ? safeHttpUrl(body.imageUrl, false, true)
      : imageMode === 'none' ? '' : null
  const logoUrl = safeHttpUrl(body.logoUrl, true, true)
  const font = String(body.font ?? '') as AdFont
  const textColor = safeAdColor(body.textColor)
  const textPosition = body.textPosition ?? 'center'
  const logoPosition = body.logoPosition ?? 'top-center'
  const buyer = String(body.buyer ?? '')
  const symbol = String(body.symbol ?? '') as PaymentSymbol
  const period = AD_PERIODS.find(option => option.hours === Number(body.hours))
  const startAt = Number(body.startAt)
  const timezoneOffset = Number(body.timezoneOffset)
  const endAt = startAt + (period?.hours ?? 0) * HOUR_MS
  const hourly = Number.isInteger(timezoneOffset) && (startAt - timezoneOffset * 60_000) % HOUR_MS === 0

  if (!text || !linkUrl || imageUrl === null || logoUrl === null || !isOverlayPosition(textPosition) ||
      !isOverlayPosition(logoPosition) || !Object.hasOwn(AD_FONTS, font) || !textColor ||
      !ACCOUNT_RE.test(buyer) || !period || !PAYMENT_TOKENS[symbol] || !hourly ||
      startAt <= Date.now() || startAt > Date.now() + 90 * 24 * HOUR_MS) {
    return jsonError('Invalid ad details', 400)
  }

  const submission: AdSubmission = {
    id: crypto.randomUUID(),
    status: 'awaiting_payment',
    text,
    imageUrl,
    imageMode,
    logoUrl,
    font,
    textColor,
    textPosition,
    logoPosition,
    linkUrl,
    hours: period.hours,
    buyer,
    symbol,
    submittedAt: Date.now(),
    startAt,
    endAt,
  }
  await redis.set(AD_REDIS_KEYS.submission(submission.id), submission, { ex: 180 * 24 * 3600 })
  await redis.lpush(AD_REDIS_KEYS.submissions, submission.id)
  return NextResponse.json(submission, { status: 201 })
}

async function preparePayment(req: NextRequest) {
  const redis = getRedis()
  if (!redis) return jsonError('Advertising is not configured', 503)

  const body = await req.json().catch(() => null) as { submissionId?: string; buyer?: string } | null
  const buyer = String(body?.buyer ?? '')
  if (!body?.submissionId || !ID_RE.test(body.submissionId)) return jsonError('Invalid submission', 400)
  if (!ACCOUNT_RE.test(buyer)) return jsonError('Invalid payment account', 400)
  const submission = await redis.get<AdSubmission>(AD_REDIS_KEYS.submission(body.submissionId))
  if (!submission || submission.status !== 'awaiting_payment') {
    return jsonError('This submission is not awaiting payment', 403)
  }
  if ((await bookedSlots(redis, submission.startAt, submission.endAt)).length) {
    return jsonError('That booking overlaps an unavailable slot', 409)
  }

  try {
    const payment = PAYMENT_TOKENS[submission.symbol]
    const period = AD_PERIODS.find(option => option.hours === submission.hours)!
    const quotedAt = Date.now()
    const pricingState = await redis.get<AdPricingState>(AD_REDIS_KEYS.pricing)
    const feeUsd = adQuoteUsd(period.usd, pricingState, quotedAt)
    const id = crypto.randomUUID()
    const reservation: AdReservation = {
      id,
      submissionId: submission.id,
      text: submission.text,
      imageUrl: submission.imageUrl,
      imageMode: submission.imageMode,
      logoUrl: submission.logoUrl,
      font: submission.font,
      textColor: submission.textColor,
      textPosition: submission.textPosition,
      logoPosition: submission.logoPosition,
      linkUrl: submission.linkUrl,
      hours: submission.hours,
      buyer,
      contract: payment.contract,
      symbol: submission.symbol,
      quantity: tokenQuantity(feeUsd, await currentUsdPrice(payment.contract, submission.symbol), submission.symbol),
      memo: `antbubbles-ad:${id}`,
      feeUsd,
      quotedAt,
      startAt: submission.startAt,
      endAt: submission.endAt,
    }
    const reserved = await redis.set(AD_REDIS_KEYS.reservation, reservation, { nx: true, ex: 5 * 60 })
    if (!reserved) return jsonError('Another advertiser is checking out', 409)
    if (submission.buyer !== buyer) {
      await redis.set(AD_REDIS_KEYS.submission(submission.id), { ...submission, buyer }, { ex: 180 * 24 * 3600 })
    }
    return NextResponse.json({ reservation, recipient: AD_RECIPIENT })
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Could not prepare payment', 502)
  }
}

async function confirmPayment(req: NextRequest) {
  const redis = getRedis()
  if (!redis) return jsonError('Advertising is not configured', 503)
  const body = await req.json().catch(() => null) as { reservationId?: string; txId?: string } | null
  const reservation = await redis.get<AdReservation>(AD_REDIS_KEYS.reservation)

  if (!reservation || body?.reservationId !== reservation.id || !TX_RE.test(body.txId ?? '')) {
    return jsonError('Payment reservation expired or is invalid', 400)
  }

  try {
    const response = await fetch(`https://wax.eosphere.io/v2/history/get_transaction?id=${body.txId}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return jsonError('Payment is not indexed yet; retry in a few seconds', 425)
    const transaction = await response.json()
    if (!hasExpectedPayment(transaction, reservation)) return jsonError('Payment does not match the reservation', 400)

    const submission = await redis.get<AdSubmission>(AD_REDIS_KEYS.submission(reservation.submissionId))
    if (!submission || submission.status !== 'awaiting_payment') {
      return jsonError('Submission is no longer awaiting payment', 409)
    }
    submission.status = 'pending'
    submission.txId = body.txId!
    submission.paidAt = Date.now()
    submission.feeUsd = reservation.feeUsd
    submission.quantity = reservation.quantity
    if ((await bookedSlots(redis, submission.startAt, submission.endAt)).length) {
      return jsonError('That slot became unavailable; contact the app owner about the payment', 409)
    }
    const pricingState = await redis.get<AdPricingState>(AD_REDIS_KEYS.pricing)
    await redis.multi()
      .set(AD_REDIS_KEYS.submission(submission.id), submission, { ex: 180 * 24 * 3600 })
      .zadd(AD_REDIS_KEYS.slots, { score: submission.startAt, member: submission.id })
      .set(AD_REDIS_KEYS.pricing, recordAdUsage(pricingState, reservation.hours, Date.now(), body.txId!))
      .del(AD_REDIS_KEYS.reservation)
      .exec()
    return NextResponse.json(submission)
  } catch {
    return jsonError('Could not verify payment; retry in a few seconds', 502)
  }
}

export async function POST(req: NextRequest) {
  if (req.nextUrl.searchParams.get('confirm') === '1') return confirmPayment(req)
  if (req.nextUrl.searchParams.get('payment') === '1') return preparePayment(req)
  return submitForReview(req)
}
