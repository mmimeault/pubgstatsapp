import { describe, expect, it } from 'vitest'
import { mapLabel, modeLabel, seasonLabel, weaponLabel } from './labels'

describe('map labels', () => {
  it('uses the official PUBG map dictionary names', () => {
    expect(mapLabel('Neon_Main')).toBe('Rondo')
    expect(mapLabel('Baltic_Main')).toBe('Erangel')
    expect(mapLabel('Tiger_Main')).toBe('Taego')
    expect(mapLabel('Kiki_Main')).toBe('Deston')
    expect(mapLabel('Range_Main')).toBe('Camp Jackal')
  })

  it('falls back to a readable name for unknown maps', () => {
    expect(mapLabel('Something_Main')).toBe('Something')
    expect(mapLabel('Custom_Map_Name')).toBe('Custom Map Name')
  })
})

describe('mode labels', () => {
  it('formats known and unknown modes', () => {
    expect(modeLabel('duo-fpp')).toBe('Duo FPP')
    expect(modeLabel('ranked-squad')).toBe('Ranked Squad')
    expect(modeLabel('some-new-mode')).toBe('Some New Mode')
  })
})

describe('season labels', () => {
  it('extracts the numeric season', () => {
    expect(seasonLabel('division.bro.official.pc-2018-43')).toBe('Season 43')
  })
})

describe('weapon labels', () => {
  it('maps weapon assets and falls back cleanly', () => {
    expect(weaponLabel('WeapM24_C')).toBe('M24')
    expect(weaponLabel('WeapACE32_C')).toBe('ACE32')
    expect(weaponLabel('ProjGrenade_C')).toBe('Frag Grenade')
    expect(weaponLabel('BP_MolotovFireDebuff_C')).toBe('Molotov')
    expect(weaponLabel('WeapUnknown_C')).toBe('Unknown')
    expect(weaponLabel(null)).toBe('Unknown')
  })
})
