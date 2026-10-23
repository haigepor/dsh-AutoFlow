/** Theme settings page store mirrors the service's durable choices. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import {
  DEFAULT_ACCENT, DEFAULT_CORNER_PRESET, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE,
  DEFAULT_GLIDE_DURATION, DEFAULT_THEME_SET,
  DEFAULT_FONT_SIZES, type FontSizes, type FontFamilies,
  type AccentPreset, type CornerPreset, type FontFamily, type GlideDuration, type ThemePreference, type ThemeSet,
} from '../theme-settings.ts'

/** Settings page values mirrored from the theme service. */
export interface ThemePageState {
  /** Color mode preference, including system. */
  preference: ThemePreference
  /** Product accent palette. */
  accent: AccentPreset
  /** Complete color palette. */
  themeSet: ThemeSet
  /** Whether the old accent override remains active. */
  legacyAccent: boolean
  /** Sidebar menu glide duration. */
  glideDuration: GlideDuration
  /** Application text family. */
  fontFamily: FontFamily
  /** Shared corner scale. */
  corners: CornerPreset
  /** Conversation content size in pixels. */
  fontSize: number
  /** Independent font sizes and normalized font lists by role. */
  fontSizes: FontSizes
  fontFamilies: FontFamilies
  /** Service revision used to reject delayed updates. */
  revision: number
}

type ThemePageActions = {
  sync: (draft: ThemePageState, value: ThemePageState) => void
}

/**
 * Create the settings page store, whose revision guard rejects stale snapshots.
 * @returns The settings page store handle.
 */
export function createThemePageStore(): EngineStoreHandle<ThemePageState, ThemePageActions> {
  return defineStore({
    init: (): ThemePageState => ({
      preference: 'system', accent: DEFAULT_ACCENT, themeSet: DEFAULT_THEME_SET,
      legacyAccent: false, glideDuration: DEFAULT_GLIDE_DURATION, fontFamily: DEFAULT_FONT_FAMILY,
      corners: DEFAULT_CORNER_PRESET, fontSize: DEFAULT_FONT_SIZE, revision: -1,
      fontSizes: DEFAULT_FONT_SIZES, fontFamilies: { text: '', code: '', terminal: '' },
    }),
    actions: {
      sync: (draft, value) => {
        if (value.revision <= draft.revision) return
        Object.assign(draft, value)
      },
    },
  })
}

/** Font preferences shared by the role-specific controls. */
export interface FontRowState {
  fontSizes: FontSizes
  fontFamilies: FontFamilies
  revision: number
}

type FontRowActions = {
  sync: (draft: FontRowState, fontSizes: FontSizes, fontFamilies: FontFamilies, revision: number) => void
}

/**
 * Create a font-only store for independently composed role controls.
 * @returns Font state with a monotonic revision guard.
 */
export function createFontRowStore(): EngineStoreHandle<FontRowState, FontRowActions> {
  return defineStore({
    init: (): FontRowState => ({ fontSizes: DEFAULT_FONT_SIZES, fontFamilies: { text: '', code: '', terminal: '' }, revision: -1 }),
    actions: {
      sync: (draft, fontSizes, fontFamilies, revision) => {
        if (revision <= draft.revision) return
        Object.assign(draft, { fontSizes, fontFamilies, revision })
      },
    },
  })
}
