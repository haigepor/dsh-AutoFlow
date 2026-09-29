/** Host registration for the browser theme preference and pre-plugin palette. */
import type {} from '@deepseek-ai/dsh-settings'

import type { Volatile } from '@deepseek-ai/cordis'
import type { AccentPreset, CornerPreset, FontFamily, GlideDuration, ThemePreference, ThemeSet } from './theme-settings.ts'
import z from '@deepseek-ai/schemastery'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { bootThemeInjections } from './boot-theme.ts'
import {
  ACCENT_PRESETS, CORNER_PRESETS, DEFAULT_ACCENT, DEFAULT_CORNER_PRESET,
  DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, DEFAULT_GLIDE_DURATION, DEFAULT_PREFERENCE,
  DEFAULT_THEME_SET, FONT_FAMILIES, GLIDE_DURATIONS, resolveThemeSet,
  FONT_SIZE_MIN, FONT_SIZE_MAX, THEME_PREFERENCES, THEME_SETS, THEME_SETTINGS_NAMESPACE,
} from './theme-settings.ts'

export {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN,
  THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  ACCENT_PRESETS, CORNER_PRESETS, DEFAULT_ACCENT, DEFAULT_CORNER_PRESET,
  DEFAULT_FONT_FAMILY, FONT_FAMILIES,
  THEME_SETS, GLIDE_DURATIONS, DEFAULT_THEME_SET, DEFAULT_GLIDE_DURATION,
  type AccentPreset, type CornerPreset, type FontFamily, type GlideDuration, type ThemePreference, type ThemeSet, type ThemeSettings,
} from './theme-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Browser palette preference. */
  preference: Volatile<ThemePreference>
  /** Browser font size in pixels. */
  fontSize: Volatile<number>
  /** Product accent palette. */
  accent: Volatile<AccentPreset>
  /** Complete built-in color palette. */
  themeSet: Volatile<ThemeSet>
  /** Sidebar menu glide duration. */
  glideDuration: Volatile<GlideDuration>
  /** Application text family. */
  fontFamily: Volatile<FontFamily>
  /** Shared corner scale. */
  corners: Volatile<CornerPreset>
}

/** Live theme and typography preferences. */
export const Config = z.object({
  preference: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE).volatile(),
  fontSize: z.number().step(1).min(FONT_SIZE_MIN).max(FONT_SIZE_MAX).default(DEFAULT_FONT_SIZE).volatile(),
  accent: z.union([...ACCENT_PRESETS]).default(DEFAULT_ACCENT).volatile(),
  themeSet: z.union([...THEME_SETS]).default(DEFAULT_THEME_SET).volatile(),
  glideDuration: z.union([...GLIDE_DURATIONS]).default(DEFAULT_GLIDE_DURATION).volatile(),
  fontFamily: z.union([...FONT_FAMILIES]).default(DEFAULT_FONT_FAMILY).volatile(),
  corners: z.union([...CORNER_PRESETS]).default(DEFAULT_CORNER_PRESET).volatile(),
})

/** Supply the current palette before browser plugins start.
 * @param ctx Host plugin context.
 * @param config Validated live theme preferences.
 */
export function apply(ctx: Context, config: Config): void {
  let userLayer: unknown
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
    child.effect(() => {
      const refresh = (): void => {
        userLayer = child.settings.describe().find(row => row.ns === THEME_SETTINGS_NAMESPACE)?.user
      }
      refresh()
      child.on('settings/document-updated', refresh)
      return () => { userLayer = undefined }
    }, 'ui-theme: settings user layer')
  })
  ctx.on('webserver/index-inject', (table) => {
    const palette = resolveThemeSet(config.themeSet.get(), userLayer)
    table.push(...bootThemeInjections(
      config.preference.get(), config.fontSize.get(),
      config.accent.get(), config.fontFamily.get(), config.corners.get(),
      palette.themeSet, config.glideDuration.get(), palette.legacyAccent,
    ))
  }, { prepend: true })
}
