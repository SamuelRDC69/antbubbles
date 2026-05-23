'use client'

import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react'

// Lazy type imports only — actual imports happen dynamically on the client
// to avoid SSR crashes (WharfKit uses browser APIs like localStorage).
type Session    = import('@wharfkit/session').Session
type SessionKit = import('@wharfkit/session').SessionKit

// WAX mainnet chain ID
const WAX_CHAIN_ID = '1064487b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d44e01aea5a4'

export interface WalletContextValue {
  session:  Session | null
  actor:    string | null     // "myaccount" — null when not connected
  loading:  boolean
  login:    () => Promise<void>
  logout:   () => Promise<void>
  // Pass AnyAction-compatible array; resolves with the transaction result
  transact: (actions: unknown[]) => Promise<unknown>
}

const WalletContext = createContext<WalletContextValue>({
  session:  null,
  actor:    null,
  loading:  true,
  login:    async () => {},
  logout:   async () => {},
  transact: async () => { throw new Error('Not connected') },
})

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const kitRef = useRef<SessionKit | null>(null)

  // Build the SessionKit lazily so it only runs in the browser
  const getKit = useCallback(async (): Promise<SessionKit> => {
    if (kitRef.current) return kitRef.current

    const [
      { SessionKit },
      { WebRenderer },
      { WalletPluginAnchor },
      { WalletPluginCloudWallet },
      { WalletPluginWombat },
    ] = await Promise.all([
      import('@wharfkit/session'),
      import('@wharfkit/web-renderer'),
      import('@wharfkit/wallet-plugin-anchor'),
      import('@wharfkit/wallet-plugin-cloudwallet'),
      import('@wharfkit/wallet-plugin-wombat'),
    ])

    kitRef.current = new SessionKit({
      appName: 'AntBubbles',
      chains: [{ id: WAX_CHAIN_ID, url: 'https://wax.greymass.com' }],
      ui: new WebRenderer(),
      walletPlugins: [
        new WalletPluginCloudWallet(),   // WAX Cloud Wallet (most popular)
        new WalletPluginAnchor(),        // Anchor (power users)
        new WalletPluginWombat(),        // Wombat (mobile / gamers)
      ],
    })
    return kitRef.current
  }, [])

  // Restore existing session on mount
  useEffect(() => {
    getKit()
      .then(kit => kit.restore())
      .then(s  => { setSession(s ?? null); setLoading(false) })
      .catch(() => setLoading(false))
  }, [getKit])

  const login = useCallback(async () => {
    const kit = await getKit()
    try {
      const { session: s } = await kit.login()
      setSession(s)
    } catch {
      // User dismissed the wallet selection dialog — not an error
    }
  }, [getKit])

  const logout = useCallback(async () => {
    const kit = await getKit()
    if (session) {
      try { await kit.logout(session) } catch {}
    }
    setSession(null)
  }, [getKit, session])

  const transact = useCallback(async (actions: unknown[]) => {
    if (!session) throw new Error('Wallet not connected')
    return session.transact({ actions } as Parameters<Session['transact']>[0])
  }, [session])

  return (
    <WalletContext.Provider value={{
      session,
      actor:   session ? String(session.actor) : null,
      loading,
      login,
      logout,
      transact,
    }}>
      {children}
    </WalletContext.Provider>
  )
}

export const useWallet = () => useContext(WalletContext)
