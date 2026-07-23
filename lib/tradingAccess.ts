const EU_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI',
  'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

export function isEuCountry(countryCode: string | null | undefined): boolean {
  return EU_COUNTRY_CODES.has(countryCode?.trim().toUpperCase() ?? '')
}

export function isAlcorTradingAllowed(countryCode: string | null | undefined): boolean {
  const normalized = countryCode?.trim().toUpperCase() ?? ''
  return /^[A-Z]{2}$/.test(normalized) && !isEuCountry(normalized)
}
