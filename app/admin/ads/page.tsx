'use client'

import { FormEvent, useState } from 'react'
import { AD_FONTS, AD_PERIODS, AdSubmission } from '@/lib/ads'
import LiquidLoader from '@/components/LiquidLoader'

export default function AdReviewPage() {
  const [token, setToken] = useState('')
  const [submissions, setSubmissions] = useState<AdSubmission[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function load(event?: FormEvent) {
    event?.preventDefault()
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/ad/admin', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not load submissions')
      setSubmissions(body)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  async function review(id: string, action: 'approve' | 'reject') {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/api/ad/admin', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id, action }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? 'Could not review submission')
      setSubmissions(current => current.map(item => item.id === id ? body : item))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-black px-4 py-10 text-white">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-bold">Ad review</h1>
        <p className="mt-1 text-sm text-gray-400">Verify each paid destination and creative before scheduling it.</p>

        <form onSubmit={load} className="mt-6 flex gap-2">
          <label className="sr-only" htmlFor="admin-token">Admin token</label>
          <input
            id="admin-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={event => setToken(event.target.value)}
            placeholder="AD_ADMIN_TOKEN"
            className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-sm outline-none focus:border-[#f89422]"
          />
          <button disabled={!token || loading}
            className="flex min-w-20 items-center justify-center rounded-lg bg-[#f89422] px-4 py-2 text-sm font-semibold disabled:opacity-40">
            {loading ? <LiquidLoader label="Loading ad submissions" size="small" /> : 'Load'}
          </button>
        </form>

        {error && <p role="alert" className="mt-4 rounded-lg bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</p>}

        <div className="mt-6 space-y-3">
          {submissions.map(submission => {
            const period = AD_PERIODS.find(option => option.hours === submission.hours)
            return (
              <article key={submission.id} className="rounded-xl border border-white/10 bg-[#0a0f14] p-4">
                <div className="flex items-start gap-3">
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-full bg-[#291900] ring-1 ring-[#ffd700]">
                    {submission.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={submission.imageUrl} alt=""
                        className={`absolute inset-0 h-full w-full ${submission.imageMode === 'background' ? 'object-cover' : 'object-contain p-4'}`} />
                    )}
                    <span className="absolute inset-2 flex items-center justify-center text-center text-[11px] font-bold leading-tight [text-shadow:0_1px_3px_#000]"
                      style={{
                        color: submission.textColor ?? '#ffe066',
                        fontFamily: AD_FONTS[submission.font ?? 'sans'].canvas,
                      }}>
                      {submission.text}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="font-bold">{submission.text}</h2>
                      <span className={`text-xs font-semibold ${
                        submission.status === 'approved' ? 'text-green-400' : 'text-amber-400'
                      }`}>{submission.status}</span>
                    </div>
                    <a href={submission.linkUrl} target="_blank" rel="noopener noreferrer"
                      className="mt-1 block truncate text-sm text-[#f89422] hover:underline">
                      {submission.linkUrl} ↗
                    </a>
                    {submission.imageUrl && (
                      <a href={submission.imageUrl} target="_blank" rel="noopener noreferrer"
                        className="mt-1 block truncate text-xs text-gray-400 hover:text-white">
                        Creative source ↗
                      </a>
                    )}
                    <p className="mt-2 text-xs text-gray-500">
                      {submission.buyer} · {period?.label} · ${period?.usd.toFixed(2)} floor · pays with {submission.symbol}
                    </p>
                    <p className="mt-1 text-xs text-gray-400">
                      Booked {new Date(submission.startAt).toLocaleString()}–{new Date(submission.endAt).toLocaleString()} · paid {submission.quantity}
                    </p>
                  </div>
                </div>
                {submission.status === 'pending' && (
                  <div className="mt-4 flex gap-2">
                    <button onClick={() => review(submission.id, 'approve')} disabled={loading}
                      className="rounded-lg bg-green-500 px-3 py-2 text-sm font-semibold text-black disabled:opacity-40">
                      Approve and schedule
                    </button>
                    <button onClick={() => review(submission.id, 'reject')} disabled={loading}
                      className="rounded-lg border border-red-500/50 px-3 py-2 text-sm font-semibold text-red-400 disabled:opacity-40">
                      Reject paid ad
                    </button>
                  </div>
                )}
              </article>
            )
          })}
          {!loading && token && submissions.length === 0 && !error && (
            <p className="py-12 text-center text-sm text-gray-500">No submissions awaiting review.</p>
          )}
        </div>
      </div>
    </main>
  )
}
