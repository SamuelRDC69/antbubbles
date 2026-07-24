import { describe, expect, it } from 'vitest'
import { getChart, setChart } from './chartCache'

describe('chart cache', () => {
  it('does not cache a transient empty response', () => {
    const url = '/api/pool-chart?test=empty'
    setChart(url, [])
    expect(getChart(url)).toBeNull()
  })
})
