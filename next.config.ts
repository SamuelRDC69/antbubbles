import type { NextConfig } from 'next'
import bundleAnalyzer from '@next/bundle-analyzer'

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
})

const nextConfig: NextConfig = {
  // WharfKit packages ship as ESM — Next.js needs to transpile them
  transpilePackages: [
    '@wharfkit/session',
    '@wharfkit/web-renderer',
    '@wharfkit/wallet-plugin-anchor',
    '@wharfkit/wallet-plugin-cloudwallet',
    '@wharfkit/wallet-plugin-wombat',
  ],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: 'wax.alcor.exchange' },
      { protocol: 'https', hostname: 'eos.alcor.exchange' },
      { protocol: 'https', hostname: 'telos.alcor.exchange' },
      { protocol: 'https', hostname: 'proton.alcor.exchange' },
      { protocol: 'https', hostname: 'alcor.exchange' },
    ],
  },
  async headers() {
    return [{
      source: '/token-logos/:path*',
      headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
    }]
  },
}

export default withBundleAnalyzer(nextConfig)
