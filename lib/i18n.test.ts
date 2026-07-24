import { describe, expect, it } from 'vitest'
import { matchLocale, translate } from './i18n'

describe('browser locale matching', () => {
  it('uses the first supported browser language and falls back to English', () => {
    expect(matchLocale(['fr-FR', 'pt-BR', 'en'])).toBe('pt')
    expect(matchLocale(['tl-PH'])).toBe('fil')
    expect(matchLocale(['ja-JP'])).toBe('en')
  })

  it('translates reviewed strings and interpolates values', () => {
    expect(translate('vi', 'failedTokens', { chain: 'WAX' })).toBe('Không thể tải token WAX')
    expect(translate('en', 'bookingAvailable', { hours: 24 })).toBe('24-hour booking available')
  })
})
