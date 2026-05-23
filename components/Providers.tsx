'use client'
// Thin client wrapper so layout.tsx (a server component) can nest providers.
import { WalletProvider } from '@/contexts/WalletContext'

export default function Providers({ children }: { children: React.ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>
}
