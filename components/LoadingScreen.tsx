'use client'

import { ChainConfig } from '@/lib/types'
import LiquidLoader from '@/components/LiquidLoader'
import { useI18n } from '@/contexts/I18nContext'

interface Props {
  chain: ChainConfig
  error?: string | null
}

export default function LoadingScreen({ chain, error }: Props) {
  const { t } = useI18n()
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
        <div className="text-4xl">⚠️</div>
        <div className="text-red-400 font-semibold">{t('failedTokens', { chain: chain.displayName })}</div>
        <div className="text-gray-500 text-sm max-w-xs">{error}</div>
        <div className="text-gray-600 text-xs">{t('retrying')}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-black">
      <LiquidLoader label={t('loadingMarkets', { chain: chain.displayName })} size="large" />
      <div className="space-y-1.5 text-center">
        <div className="font-medium text-gray-300">
          {t('preparingMarkets', { chain: chain.displayName })}
        </div>
        <div className="text-sm text-gray-500">{t('loadingMarketData')}</div>
      </div>
    </div>
  )
}
