import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import BubbleChart from './BubbleChart'

describe('sponsored bubble', () => {
  it('uses a native animated image inside a new-tab link', () => {
    const html = renderToStaticMarkup(
      <BubbleChart
        tokens={[]}
        displayMode={{ metric: 'change', timeframe: '24h' }}
        searchQuery=""
        onSelectToken={() => {}}
        onAdvertise={() => {}}
        ad={{
          id: 'ad',
          text: 'Animated ad',
          imageUrl: 'https://media.giphy.com/example.gif',
          imageMode: 'background',
          linkUrl: 'https://example.com/',
          expiresAt: Date.now() + 1_000,
          buyer: 'buyer.gm',
          txId: 'tx',
        }}
      />,
    )

    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer sponsored"')
    expect(html).toContain('<img src="https://media.giphy.com/example.gif"')
  })
})
