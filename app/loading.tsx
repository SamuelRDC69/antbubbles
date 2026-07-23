import LoadingScreen from '@/components/LoadingScreen'
import { CHAINS, DEFAULT_CHAIN } from '@/lib/chains'

export default function Loading() {
  return (
    <div className="h-screen bg-black text-white">
      <LoadingScreen chain={CHAINS[DEFAULT_CHAIN]} />
    </div>
  )
}
