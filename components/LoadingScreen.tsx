import { ChainConfig } from '@/lib/types'

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
      {/* Animated bubbles */}
      <div className="relative w-32 h-32">
        {[
          { size: 56, x: 0, y: 0, delay: '0s', color: '#f89422' },
          { size: 36, x: 48, y: 16, delay: '0.3s', color: '#00e676' },
          { size: 28, x: 8, y: 52, delay: '0.6s', color: '#ff5252' },
          { size: 20, x: 60, y: 56, delay: '0.9s', color: '#f89422' },
        ].map((b, i) => (
          <div
            key={i}
            className="absolute animate-pulse rounded-full motion-reduce:animate-none"
            style={{
              width: b.size,
              height: b.size,
              left: b.x,
              top: b.y,
              backgroundColor: b.color,
              opacity: 0.7,
              animationDelay: b.delay,
            }}
          />
        ))}
      </div>
      <div className="font-medium text-gray-300">
        Preparing <span style={{ color: chain.color }}>{chain.displayName}</span> markets…
      </div>
      <div className="text-sm text-gray-400">Loading live data, assets, and liquidity</div>
    </div>
  )
}
