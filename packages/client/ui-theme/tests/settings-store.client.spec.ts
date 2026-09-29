/** Theme settings store mirrors current snapshots and rejects stale revisions. */
import { describe, expect, it } from 'vitest'
import { createThemePageStore } from '../src/client/settings-store.ts'

describe('createThemePageStore', () => {
  it('starts with the schema defaults', () => {
    const store = createThemePageStore().create()
    expect(store.getSnapshot()).toEqual({
      preference: 'system', accent: 'iris', themeSet: 'official', legacyAccent: false, glideDuration: 220, fontFamily: 'system',
      corners: 'standard', fontSize: 14, revision: -1,
    })
  })

  it('mirrors newer revisions and ignores delayed snapshots', () => {
    const store = createThemePageStore().create()
    store.actions.sync({ preference: 'dark', accent: 'ocean', themeSet: 'current', legacyAccent: false, glideDuration: 300, fontFamily: 'inter', corners: 'soft', fontSize: 16, revision: 3 })
    store.actions.sync({ preference: 'light', accent: 'iris', themeSet: 'official', legacyAccent: false, glideDuration: 220, fontFamily: 'system', corners: 'compact', fontSize: 12, revision: 2 })
    expect(store.getSnapshot()).toMatchObject({
      preference: 'dark', accent: 'ocean', themeSet: 'current', legacyAccent: false, glideDuration: 300, fontFamily: 'inter', corners: 'soft', fontSize: 16, revision: 3,
    })
  })
})
