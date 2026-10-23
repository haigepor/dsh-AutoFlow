/** Theme settings store mirrors current snapshots and rejects stale revisions. */
import { describe, expect, it } from 'vitest'
import { createThemePageStore, createFontRowStore } from '../src/client/settings-store.ts'

describe('createThemePageStore', () => {
  it('starts with the schema defaults', () => {
    const store = createThemePageStore().create()
    expect(store.getSnapshot()).toEqual({
      preference: 'system', accent: 'iris', themeSet: 'official', legacyAccent: false, glideDuration: 220, fontFamily: 'system',
      corners: 'standard', fontSize: 14, revision: -1, fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
    })
  })

  it('mirrors newer revisions and ignores delayed snapshots', () => {
    const store = createThemePageStore().create()
    store.actions.sync({ ...store.getSnapshot(), preference: 'dark', accent: 'ocean', themeSet: 'current', legacyAccent: false, glideDuration: 300, fontFamily: 'inter', corners: 'soft', fontSize: 16, revision: 3 })
    store.actions.sync({ ...store.getSnapshot(), preference: 'light', accent: 'iris', themeSet: 'official', legacyAccent: false, glideDuration: 220, fontFamily: 'system', corners: 'compact', fontSize: 12, revision: 2 })
    expect(store.getSnapshot()).toMatchObject({
      preference: 'dark', accent: 'ocean', themeSet: 'current', legacyAccent: false, glideDuration: 300, fontFamily: 'inter', corners: 'soft', fontSize: 16, revision: 3,
    })
  })
})

describe('createFontRowStore', () => {
  it('init shape: default size with revision at -1', () => {
    const store = createFontRowStore().create()
    expect(store.getSnapshot()).toEqual({ fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' }, revision: -1 })
  })

  it('sync mirrors the size; the revision guard drops stale and duplicate writes', () => {
    const store = createFontRowStore().create()
    const sizes = { text: 16, code: 12, terminal: 14 }
    const fonts = { text: '"Inter"', code: '', terminal: '' }
    store.actions.sync(sizes, { ...fonts }, 3)
    expect(store.getSnapshot()).toEqual({ fontSizes: sizes, fontFamilies: fonts, revision: 3 })
    store.actions.sync({ ...sizes, text: 12 }, fonts, 2)
    store.actions.sync({ ...sizes, text: 12 }, fonts, 3)
    expect(store.getSnapshot().fontSizes.text).toBe(16)
    expect(store.getSnapshot().revision).toBe(3)
  })
})
