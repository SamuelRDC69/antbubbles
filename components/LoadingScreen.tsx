import { ChainConfig } from '@/lib/types'
import LiquidLoader from '@/components/LiquidLoader'

interface Props {
  chain: ChainConfig
  error?: string | null
}

export default function LoadingScreen({ chain, error }: Props) {
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-4">
        <div className="text-4xl">⚠️</div>
        <div className="text-red-400 font-semibold">Failed to load {chain.displayName} tokens</div>
        <div className="text-gray-500 text-sm max-w-xs">{error}</div>
        <div className="text-gray-600 text-xs">Retrying automatically…</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-black">
      <LiquidLoader label={`Loading ${chain.displayName} markets`} size="large" />
      <div className="space-y-1.5 text-center">
        <div className="font-medium text-gray-300">
          Preparing <span className="text-[#f89422]">{chain.displayName}</span> markets…
        </div>
        <div className="text-sm text-gray-500">Loading live data, assets, and liquidity</div>
      </div>
    </div>
  )
}
