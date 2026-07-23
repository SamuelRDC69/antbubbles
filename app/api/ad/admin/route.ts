export const runtime = 'nodejs'

import { timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getRedis } from '@/lib/redis'
import { AD_REDIS_KEYS, AdSubmission } from '@/lib/ads'

function authorized(req: NextRequest): boolean {
  const expected = process.env.AD_ADMIN_TOKEN
  const supplied = req.headers.get('authorization')?.replace(/^Bearer /, '')
  if (!expected || !supplied || expected.length !== supplied.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}

function denied() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return denied()
  const redis = getRedis()
  if (!redis) return NextResponse.json({ error: 'Advertising is not configured' }, { status: 503 })
  const ids = await redis.lrange<string>(AD_REDIS_KEYS.submissions, 0, 99)
  const submissions = (await Promise.all(ids.map(id =>
    redis.get<AdSubmission>(AD_REDIS_KEYS.submission(id))
  ))).filter((submission): submission is AdSubmission =>
    !!submission && submission.status === 'pending' && !!submission.txId
  )
  return NextResponse.json(submissions)
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return denied()
  const redis = getRedis()
  if (!redis) return NextResponse.json({ error: 'Advertising is not configured' }, { status: 503 })
  const body = await req.json().catch(() => null) as { id?: string; action?: 'approve' | 'reject' } | null
  if (!body?.id || !['approve', 'reject'].includes(body.action ?? '')) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  const key = AD_REDIS_KEYS.submission(body.id)
  const submission = await redis.get<AdSubmission>(key)
  if (!submission || submission.status !== 'pending' || !submission.txId) {
    return NextResponse.json({ error: 'Submission is no longer pending' }, { status: 409 })
  }

  if (body.action === 'approve') {
    if (submission.endAt <= Date.now()) {
      return NextResponse.json({ error: 'This paid booking has already ended' }, { status: 409 })
    }
    submission.status = 'approved'
  } else {
    submission.status = 'rejected'
    await redis.zrem(AD_REDIS_KEYS.slots, submission.id)
  }
  await redis.set(key, submission, { ex: 180 * 24 * 3600 })
  await redis.lrem(AD_REDIS_KEYS.submissions, 0, submission.id)
  return NextResponse.json(submission)
}
