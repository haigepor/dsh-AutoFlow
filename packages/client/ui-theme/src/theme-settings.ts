/** Theme preferences stored in the Host user-settings document. */

import z from '@deepseek-ai/schemastery'

/** Built-in preferences accepted at the registry and settings boundaries. */
export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** Settings namespace owned by the theme plugin. */
export const THEME_SETTINGS_NAMESPACE = 'ui-theme'

/** Field carrying the selected built-in theme preference. */
export const THEME_PREFERENCE_FIELD = 'preference'

/** Field carrying the conversation content font size. */
export const FONT_SIZE_FIELD = 'fontSize'

/** Built-in accent palettes, font families, and corner scales. */
export const ACCENT_PRESETS = ['iris', 'ocean', 'forest', 'coral'] as const
/** Complete built-in color palettes. */
export const THEME_SETS = ['official', 'current'] as const
/** Menu glide durations in milliseconds. */
export const GLIDE_DURATIONS = [80, 140, 220, 300, 400] as const
/** Interface font choices backed by the system stack and local font files. */
export const FONT_FAMILIES = ['system', 'source-sans-3', 'ibm-plex-serif', 'jetbrains-mono', 'ibm-plex-sans-condensed', 'inter', 'noto-sans-sc'] as const
/** Scales for the shared radius tokens. */
export const CORNER_PRESETS = ['0', '0.25', '0.5', '0.75', '1', 'compact', 'standard', 'soft'] as const

/** Built-in accent palette id. */
export type AccentPreset = typeof ACCENT_PRESETS[number]
/** Built-in color palette. */
export type ThemeSet = typeof THEME_SETS[number]
/** Menu glide duration in milliseconds. */
export type GlideDuration = typeof GLIDE_DURATIONS[number]
/** Interface text family id. */
export type FontFamily = typeof FONT_FAMILIES[number]
/** Shared corner scale id. */
export type CornerPreset = typeof CORNER_PRESETS[number]

/** Default accent palette. */
export const DEFAULT_ACCENT: AccentPreset = 'iris'
/** Default palette for a new installation. */
export const DEFAULT_THEME_SET: ThemeSet = 'official'
/** Default menu glide duration. */
export const DEFAULT_GLIDE_DURATION: GlideDuration = 220
/** Default interface family. */
export const DEFAULT_FONT_FAMILY: FontFamily = 'system'
/** Default shared corner scale. */
export const DEFAULT_CORNER_PRESET: CornerPreset = 'standard'

/** Theme preference persisted by the product Appearance row. */
export type ThemePreference = typeof THEME_PREFERENCES[number]

/** Default preference when the user-settings document has no override. */
export const DEFAULT_PREFERENCE: ThemePreference = 'system'

/** Smallest accepted content font size (px). */
export const FONT_SIZE_MIN = 10

/** Largest accepted content font size (px). */
export const FONT_SIZE_MAX = 22

/** Content font size when the user-settings document has no override (px). */
export const DEFAULT_FONT_SIZE = 14

/** Independently configurable font roles. */
export const FONT_ROLES = ['text', 'code', 'terminal'] as const

/** One configurable font role: interface text, code, or the sidebar terminal. */
export type FontRole = typeof FONT_ROLES[number]

/** Settings field, body variable, and accepted integer px range of one role's font size. */
export interface FontSizeSpec {
  /** Settings field carrying the size. */
  field: string
  /** Body variable carrying the size in px. */
  variable: string
  /** Smallest accepted size. */
  min: number
  /** Largest accepted size. */
  max: number
  /** Size when the user-settings document has no override. */
  default: number
}

/**
 * Font sizes by role. `text` is the conversation content size; `code` is the
 * code-block size (inline code stays 1px larger); `terminal` is the sidebar
 * terminal cell font size.
 */
export const FONT_SIZE_SPECS = {
  text: { field: FONT_SIZE_FIELD, variable: '--dsh-content-font-size', min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, default: DEFAULT_FONT_SIZE },
  code: { field: 'codeFontSize', variable: '--dsh-code-font-size', min: 10, max: 16, default: 11 },
  terminal: { field: 'terminalFontSize', variable: '--dsh-terminal-font-size', min: 10, max: 20, default: 13 },
} as const satisfies Record<FontRole, FontSizeSpec>

/** Integer px font sizes by role. */
export type FontSizes = Readonly<Record<FontRole, number>>

/** Default font sizes by role. */
export const DEFAULT_FONT_SIZES: FontSizes = Object.freeze({
  text: FONT_SIZE_SPECS.text.default, code: FONT_SIZE_SPECS.code.default, terminal: FONT_SIZE_SPECS.terminal.default,
})

/** Settings field carrying each role's font-family list. */
export const FONT_FAMILY_FIELDS = {
  text: 'textFontFamily',
  code: 'codeFontFamily',
  terminal: 'terminalFontFamily',
} as const satisfies Record<FontRole, string>

/**
 * Body variable carrying one role's normalized font list; the token sheet
 * places it ahead of that role's built-in stack.
 * @param kind - font role.
 * @returns the CSS custom property name.
 */
export function fontFamilyVariable(kind: FontRole): string {
  return `--dsh-font-family-${kind}`
}

/** Normalized CSS font-family lists by role; `''` selects the built-in stack. */
export type FontFamilies = Readonly<Record<FontRole, string>>

/** Durable theme section shared by the Host schema and the browser scope. */
export interface ThemeSettings {
  /** Selected built-in preference. */
  preference: ThemePreference
  /** Conversation content font size in px (integer within {@link FONT_SIZE_MIN}..{@link FONT_SIZE_MAX}). */
  fontSize: number
  /** Accent palette used by product controls. */
  accent: AccentPreset
  /** Complete palette; legacy user layers omit this field. */
  themeSet: ThemeSet
  /** Sidebar menu glide duration in milliseconds. */
  glideDuration: GlideDuration
  /** Application text family; code and brand text retain their own families. */
  fontFamily: FontFamily
  /** Scale applied to the shared corner tokens. */
  corners: CornerPreset
  /** Code-block font size in px (integer within the {@link FONT_SIZE_SPECS} `code` range). */
  codeFontSize: number
  /** Sidebar terminal font size in px (integer within the {@link FONT_SIZE_SPECS} `terminal` range). */
  terminalFontSize: number
  /** Interface and body text fonts placed before the built-in stack; `''` keeps the built-in stack. */
  textFontFamily: string
  /** Code fonts placed before the built-in code stack; `''` keeps the built-in stack. */
  codeFontFamily: string
  /** Sidebar terminal fonts placed before the built-in terminal stack; `''` keeps the built-in stack. */
  terminalFontFamily: string
}

/**
 * Integer px schema for one role's font size.
 * @param spec - the role's range and default.
 * @returns the validated number schema.
 */
export function fontSizeSchema(spec: FontSizeSpec): z<number> {
  return z.number().step(1).min(spec.min).max(spec.max).default(spec.default)
}

/**
 * Collect every role's size from a settings section.
 * @param section - accepted theme settings.
 * @returns integer px sizes by role.
 */
export function sectionFontSizes(section: ThemeSettings): FontSizes {
  return Object.freeze({ text: section.fontSize, code: section.codeFontSize, terminal: section.terminalFontSize })
}

/**
 * Whether one value is an accepted size for a role.
 * @param role - font role.
 * @param px - candidate size.
 * @returns true for an integer within the role's range.
 */
export function isFontSize(role: FontRole, px: number): boolean {
  const spec = FONT_SIZE_SPECS[role]
  return Number.isInteger(px) && px >= spec.min && px <= spec.max
}

/** Durable theme schema; also the wire envelope the browser scope validates against. */
export const ThemeSettingsSchema: z<ThemeSettings> = z.object({
  [THEME_PREFERENCE_FIELD]: z.union([...THEME_PREFERENCES]).default(DEFAULT_PREFERENCE),
  [FONT_SIZE_FIELD]: fontSizeSchema(FONT_SIZE_SPECS.text),
  [FONT_SIZE_SPECS.code.field]: fontSizeSchema(FONT_SIZE_SPECS.code),
  [FONT_SIZE_SPECS.terminal.field]: fontSizeSchema(FONT_SIZE_SPECS.terminal),
  [FONT_FAMILY_FIELDS.text]: z.string().default(''),
  [FONT_FAMILY_FIELDS.code]: z.string().default(''),
  [FONT_FAMILY_FIELDS.terminal]: z.string().default(''),
  accent: z.union([...ACCENT_PRESETS]).default(DEFAULT_ACCENT),
  themeSet: z.union([...THEME_SETS]).default(DEFAULT_THEME_SET),
  glideDuration: z.union([...GLIDE_DURATIONS]).default(DEFAULT_GLIDE_DURATION),
  fontFamily: z.union([...FONT_FAMILIES]).default(DEFAULT_FONT_FAMILY),
  corners: z.union([...CORNER_PRESETS]).default(DEFAULT_CORNER_PRESET),
})

/** CSS Fonts generic and system family keywords, which must stay unquoted. */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif',
  'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
])

/**
 * Normalize user input into a CSS font-family list. Names are comma separated;
 * quotes, backslashes, angle brackets, and control characters are dropped, and
 * every non-generic name is double-quoted, so the result is always a valid list
 * safe to embed in inline CSS and boot scripts. Normalizing a result returns it unchanged.
 * @param value - user-entered or stored font list.
 * @returns the normalized list, or `''` when no family name remains.
 */
export function normalizeFontFamily(value: string): string {
  return value.split(',')
    .map(name => name.replace(/["'\\<>\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim())
    .filter(name => name !== '')
    .map(name => GENERIC_FAMILIES.has(name.toLowerCase()) ? name : `"${name}"`)
    .join(', ')
}

/**
 * Preserve configured palettes without inferring a palette from older appearance fields.
 * @param value - The configured palette after schema defaults are applied.
 * @param user - The raw persisted user layer, when one exists.
 * @returns resolved palette and whether its legacy accent remains active.
 */
export function resolveThemeSet(value: ThemeSet, user: unknown): { themeSet: ThemeSet; legacyAccent: boolean } {
  if (typeof user !== 'object' || user === null || Array.isArray(user)) {
    return { themeSet: value, legacyAccent: false }
  }
  const layer = user as Record<string, unknown>
  if (Object.hasOwn(layer, 'themeSet')) return { themeSet: value, legacyAccent: false }
  const legacy = ['preference', 'fontSize', 'accent', 'fontFamily', 'corners'].some(key => Object.hasOwn(layer, key))
  // 字体、字号和模式的旧设置不再把默认蓝灰切换为鸢尾紫。
  return { themeSet: value, legacyAccent: legacy && value === 'current' }
}

/**
 * Narrow one wire or registry value to a persistable preference.
 * @param value - value crossing the settings or registry boundary.
 * @returns whether the value is a built-in preference.
 */
export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.some(preference => preference === value)
}
