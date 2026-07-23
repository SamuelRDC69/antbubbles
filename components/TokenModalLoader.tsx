import LiquidLoader from '@/components/LiquidLoader'

interface Props {
  label?: string
  onClose?: () => void
}

export default function TokenModalLoader({
  label = 'Loading token market',
  onClose,
}: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-end overflow-hidden sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
      <div
        className="relative z-10 flex min-h-[360px] w-full max-w-5xl items-center justify-center overflow-hidden rounded-t-2xl border border-white/[0.07] bg-[#0a0f14] shadow-2xl sm:min-h-[560px] sm:rounded-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close token details"
            className="absolute right-3 top-3 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-white/[0.07] text-gray-400 transition-colors hover:bg-white/[0.14] hover:text-white"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
        <div className="flex flex-col items-center gap-4">
          <LiquidLoader label={label} size="large" />
          <span className="text-sm font-medium text-gray-400">{label}…</span>
        </div>
      </div>
    </div>
  )
}
