'use client'

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { Locale, Translate, matchLocale, translate } from '@/lib/i18n'

const I18nContext = createContext<{ locale: Locale; t: Translate }>({
  locale: 'en',
  t: (key, values) => translate('en', key, values),
})

const subscribe = (onChange: () => void) => {
  window.addEventListener('languagechange', onChange)
  return () => window.removeEventListener('languagechange', onChange)
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const locale = useSyncExternalStore(
    subscribe,
    () => matchLocale(navigator.languages.length ? navigator.languages : [navigator.language]),
    () => 'en' as const,
  )

  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dir = locale === 'ur' ? 'rtl' : 'ltr'
  }, [locale])

  const value = useMemo(() => ({
    locale,
    t: ((key, values) => translate(locale, key, values)) as Translate,
  }), [locale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  return useContext(I18nContext)
}
