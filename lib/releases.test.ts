import { describe, expect, it } from 'vitest'
import packageJson from '../package.json'
import { CURRENT_RELEASE } from './releases'

describe('releases', () => {
  it('matches the package version', () => {
    expect(CURRENT_RELEASE.version).toBe(packageJson.version)
  })
})
