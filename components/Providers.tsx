'use client'
// Thin client wrapper so layout.tsx (a server component) can nest providers.
import { WalletProvider } from '@/contexts/WalletContext'
import { I18nProvider } from '@/contexts/I18nContext'

export default function Providers({ children }: { children: React.ReactNode }) {
  return <I18nProvider><WalletProvider>{children}</WalletProvider></I18nProvider>
}
