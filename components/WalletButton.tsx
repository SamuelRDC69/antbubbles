'use client'

import { useState, useRef, useEffect } from 'react'
import { useWallet } from '@/contexts/WalletContext'
import LiquidLoader from '@/components/LiquidLoader'

export default function WalletButton({ onSwapClick }: { onSwapClick?: () => void }) {
  const { actor, loading, login, logout } = useWallet()
  const [menuOpen, setMenuOpen]           = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close dropdown on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  if (loading) {
    return (
      <div className="flex h-7 w-24 shrink-0 items-center justify-center">
        <LiquidLoader label="Loading wallet" size="small" />
      </div>
    )
  }

  if (!actor) {
    return (
      <button
        onClick={login}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold
          bg-[#f89422] hover:bg-[#e07d10] text-white transition-colors shrink-0 shadow-md shadow-orange-500/20"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
        Connect
      </button>
    )
  }

  // Connected state — name + dropdown
  return (
    <div ref={menuRef} className="relative shrink-0">
      <button
        onClick={() => setMenuOpen(o => !o)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-semibold
          bg-white/[0.07] border border-white/[0.10] hover:bg-white/[0.12] text-white
          transition-colors"
      >
        {/* Green dot indicator */}
        <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
        <span className="max-w-[90px] truncate">{actor}</span>
        <svg className={`w-2.5 h-2.5 text-gray-500 transition-transform shrink-0 ${menuOpen ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {menuOpen && (
        <div className="absolute right-0 top-full mt-1.5 z-50 min-w-[160px] rounded-xl
          border border-white/[0.08] shadow-2xl overflow-hidden"
          style={{ background: '#0c1218' }}>

          {/* Account info */}
          <div className="px-3 pt-3 pb-2 border-b border-white/[0.06]">
            <div className="text-[9px] text-gray-600 uppercase tracking-widest mb-0.5">Connected</div>
            <div className="text-[11px] text-white font-semibold break-all">{actor}</div>
          </div>

          {/* Swap shortcut */}
          {onSwapClick && (
            <button
              onClick={() => { setMenuOpen(false); onSwapClick() }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] font-semibold
                text-[#f89422] hover:bg-white/[0.05] transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
              </svg>
              Swap Tokens
            </button>
          )}

          {/* Disconnect */}
          <button
            onClick={() => { setMenuOpen(false); logout() }}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-[12px] text-gray-400
              hover:bg-white/[0.05] hover:text-white transition-colors border-t border-white/[0.04]"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Disconnect
          </button>
        </div>
      )}
    </div>
  )
}
