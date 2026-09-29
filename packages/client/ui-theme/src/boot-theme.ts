/**
 * Theme bootstrap row for the browser's pre-plugin interval. Each index
 * render embeds the current durable built-in preference and content font size.
 * Head CSS colors the document canvas before script execution; the body script
 * installs the palette selector and font size that the client presenters adopt.
 */

import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  DEFAULT_ACCENT, DEFAULT_CORNER_PRESET, DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE,
  DEFAULT_GLIDE_DURATION, DEFAULT_PREFERENCE, DEFAULT_THEME_SET,
  type AccentPreset, type CornerPreset, type FontFamily, type GlideDuration, type ThemePreference, type ThemeSet,
} from './theme-settings.ts'

const BACKGROUNDS = {
  official: { light: '#FFFFFF', dark: '#151517' },
  current: { light: '#FAF9F7', dark: '#1B1B1A' },
} as const

/** CSS that colors the document canvas before any script executes. */
function bootThemeStyle(preference: ThemePreference, themeSet: ThemeSet): string {
  const { light: lightBackground, dark: darkBackground } = BACKGROUNDS[themeSet]
  const light = `:root{color-scheme:light}body{background-color:${lightBackground};--dsh-boot-bg:${lightBackground}}`
  const dark = `:root{color-scheme:dark}body{background-color:${darkBackground};--dsh-boot-bg:${darkBackground}}`
  if (preference === 'light') return light
  if (preference === 'dark') return dark
  return `${light}@media(prefers-color-scheme:dark){${dark}}`
}

/** Build the body script that installs the palette selector and content size. */
function bootThemeBodyScript(
  preference: ThemePreference, fontSize: number, accent: AccentPreset,
  fontFamily: FontFamily, corners: CornerPreset, themeSet: ThemeSet,
  glideDuration: GlideDuration, legacyAccent: boolean,
): string {
  return `(() => {
  const preference = ${JSON.stringify(preference)}
  const systemDark = preference === 'system'
    && typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-color-scheme: dark)').matches
  const dark = preference === 'dark' || systemDark
  document.documentElement.dataset.dsThemeSource = preference
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsh-content-font-size', ${JSON.stringify(`${fontSize}px`)})
  document.body.dataset.dsAccent = ${JSON.stringify(accent)}
  document.body.dataset.dsFontFamily = ${JSON.stringify(fontFamily)}
  document.body.dataset.dsCorners = ${JSON.stringify(corners)}
  document.body.dataset.dsPalette = ${JSON.stringify(themeSet)}
  document.body.dataset.dsLegacyAccent = ${JSON.stringify(String(legacyAccent))}
  document.body.dataset.dsGlideDuration = ${JSON.stringify(String(glideDuration))}
  document.body.style.setProperty('--dsh-glide-duration', ${JSON.stringify(`${glideDuration}ms`)})
})()`
}

/**
 * Theme bootstrap rows: head CSS colors the document canvas before
 * first paint, then the body script installs the palette selector and font
 * size before the shell mount and module script.
 * @param preference - Current Host-backed built-in preference.
 * @param fontSize - Current Host-backed content font size in px.
 * @param accent - Current Host-backed accent palette.
 * @param fontFamily - Current Host-backed interface font.
 * @param corners - Current Host-backed corner scale.
 * @param themeSet - Current Host-backed complete palette.
 * @param glideDuration - Current Host-backed menu animation duration.
 * @param legacyAccent - Whether a persisted pre-palette override is active.
 * @returns head and body script rows in execution order.
 */
export function bootThemeInjections(
  preference: ThemePreference = DEFAULT_PREFERENCE,
  fontSize: number = DEFAULT_FONT_SIZE,
  accent: AccentPreset = DEFAULT_ACCENT,
  fontFamily: FontFamily = DEFAULT_FONT_FAMILY,
  corners: CornerPreset = DEFAULT_CORNER_PRESET,
  themeSet: ThemeSet = DEFAULT_THEME_SET,
  glideDuration: GlideDuration = DEFAULT_GLIDE_DURATION,
  legacyAccent = false,
): IndexInjection[] {
  return [
    { kind: 'style', text: bootThemeStyle(preference, themeSet) },
    { kind: 'script', placement: 'body', text: bootThemeBodyScript(preference, fontSize, accent, fontFamily, corners, themeSet, glideDuration, legacyAccent) },
  ]
}
