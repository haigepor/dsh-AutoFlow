/**
 * Browser theme registry over the `--dsw-*` token stylesheets. The service
 * owns the live theme preference (light/dark/system), resolves `system` through
 * `prefers-color-scheme`, and publishes immutable snapshots; it never touches
 * the DOM — ui-layout's presenter consumes the resolved snapshot. The Host
 * settings scope loads and stores the preference in the user-settings
 * document. The plugin also registers the Appearance and font settings rows
 * into the settings General section — the theme feature owns its own settings
 * surface. Desktop shortcuts adjust text, code, and terminal font sizes together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { NormalizedBinding } from '@deepseek-ai/dsh-client-shortcuts/protocol'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ThemeSettingsPageInjected } from './ThemeSettingsPage.tsx'
import { ThemeSettingsPage } from './ThemeSettingsPage.tsx'
import { createThemePageStore } from './settings-store.ts'
import { installThemeStyles } from './styles.ts'
import { en, zh, type ThemeKey } from './locales.ts'
import {
  ACCENT_PRESETS, CORNER_PRESETS, DEFAULT_ACCENT, DEFAULT_CORNER_PRESET,
  DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, DEFAULT_GLIDE_DURATION, DEFAULT_PREFERENCE,
  DEFAULT_THEME_SET, FONT_FAMILIES, GLIDE_DURATIONS, THEME_SETS, resolveThemeSet,
  FONT_SIZE_FIELD,
  DEFAULT_FONT_SIZES, FONT_FAMILY_FIELDS, FONT_ROLES, FONT_SIZE_SPECS,
  fontFamilyVariable, isFontSize, normalizeFontFamily, sectionFontSizes,
  type FontFamilies, type FontRole, type FontSizes,
  isThemePreference, THEME_PREFERENCE_FIELD, THEME_SETTINGS_NAMESPACE,
  type AccentPreset, type CornerPreset, type FontFamily, type GlideDuration, type ThemePreference,
  type ThemeSet, type ThemeSettings,
} from '../theme-settings.ts'

export type { ThemeSettingsPageInjected, ThemeSettingsPageProps } from './ThemeSettingsPage.tsx'
export type { ThemePageState } from './settings-store.ts'
export type { FontRowState } from './settings-store.ts'
export type { FontSettingsGroupProps, FontSettingsInjected } from './FontSettingsGroup.tsx'
export type { ThemeKey } from './locales.ts'
export type { ThemePreference, ThemeSettings } from '../theme-settings.ts'
export type { AccentPreset, CornerPreset, FontFamily, GlideDuration, ThemeSet } from '../theme-settings.ts'
export type { FontFamilies, FontRole, FontSizes } from '../theme-settings.ts'

/** Namespace owning this feature's settings-row copy. */
export const SETTINGS_NS = 'settings.theme'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Appearance settings row's copy. */
    'settings.theme': ThemeKey
  }
}

/** Theme token dictionary: --dsw-alias-* overrides keyed by variable name. */
export type ThemeTokens = Record<string, string>

/**
 * One override-layer token value: both palette modes are mandatory (repeat
 * the same value when the token is scheme-invariant) so an override never
 * goes illegible when the user switches to the other scheme.
 */
export interface ThemeTokenModes {
  /** Value applied while the light base palette is active. */
  light: string
  /** Value applied while the dark base palette is active. */
  dark: string
}

/** Override-layer dictionary: token names to per-mode value pairs. */
export type ThemeTokenOverrides = Record<string, ThemeTokenModes>

/** One selectable theme: id, dark/light semantics, and alias-token overrides. */
export interface ThemeDefinition {
  /** Theme id (the setTheme argument for concrete themes). */
  id: string
  /**
   * Which base palette this theme builds on. The presenter switches
   * `body[data-ds-dark-theme]` from this field — never from the id.
   */
  colorScheme: 'light' | 'dark'
  /** Alias-layer overrides applied as inline CSS variables over the base palette. */
  tokens: ThemeTokens
}

/** Immutable theme state published on every change. */
export interface ThemeSnapshot {
  /** The persisted preference (may be `system`). */
  preference: ThemePreference
  /** Conversation content font size in px (integer within FONT_SIZE_MIN..FONT_SIZE_MAX). */
  fontSize: number
  /** Product accent palette. */
  accent: AccentPreset
  /** Complete color palette. */
  themeSet: ThemeSet
  /** Whether an older accent override remains active. */
  legacyAccent: boolean
  /** Sidebar menu glide duration in milliseconds. */
  glideDuration: GlideDuration
  /** Application text family. */
  fontFamily: FontFamily
  /** Shared corner scale. */
  corners: CornerPreset
  /** Integer px font sizes by role, each within its `FONT_SIZE_SPECS` range (`text` is the conversation content size). */
  fontSizes: FontSizes
  /** Normalized user font lists by role; `''` selects the role's built-in stack. */
  fontFamilies: FontFamilies
  /**
   * The resolved active theme (`system` resolved via prefers-color-scheme)
   * with override layers folded into its tokens (seq order, later layers win
   * per-token; each value picked for the active color scheme).
   */
  active: ThemeDefinition
  /** Registered themes in registration order. */
  themes: readonly ThemeDefinition[]
  /** Monotonic change counter (registry or active changes). */
  revision: number
}

/** One theme token exposed to pre-definition Cordis inspection. */
export interface ThemeTokenInspection {
  /** Token name accepted by {@link ThemeRuntime.overrideTokens}. */
  name: string
  /** Intended visual role. */
  description: string
  /** CSS value category. */
  valueType: string
  /** Whether override layers must supply both palette modes. */
  requiresLightAndDark: boolean
  /** CSS custom property consumed by UI styles. */
  cssVariable?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    theme: ThemeRuntime
  }
  interface Events {
    /**
     * Theme state changed (preference switched, registry updated, or the OS
     * color scheme changed while the preference is `system`).
     * @param snapshot - Current immutable theme snapshot.
     * @mode emit
     */
    'theme/change'(snapshot: ThemeSnapshot): void
  }
}

const BUILTIN_THEMES: readonly ThemeDefinition[] = Object.freeze([
  Object.freeze({ id: 'light', colorScheme: 'light' as const, tokens: Object.freeze({}) }),
  Object.freeze({ id: 'dark', colorScheme: 'dark' as const, tokens: Object.freeze({}) }),
])

const BUILTIN_INSPECT_TOKENS: readonly ThemeTokenInspection[] = Object.freeze([
  { name: '--dsw-alias-bg-base', description: 'Application base background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-base' },
  { name: '--dsw-alias-bg-layer-1', description: 'Primary raised surface background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-1' },
  { name: '--dsw-alias-bg-layer-2', description: 'Secondary nested surface background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-layer-2' },
  { name: '--dsw-alias-bg-overlay', description: 'Overlay and popover background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-bg-overlay' },
  { name: '--dsw-alias-border-l1', description: 'Primary subtle border.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l1' },
  { name: '--dsw-alias-border-l2', description: 'Secondary stronger border.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-border-l2' },
  { name: '--dsw-alias-brand-primary', description: 'Primary brand accent.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-brand-primary' },
  { name: '--dsw-alias-label-primary', description: 'Primary text color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-primary' },
  { name: '--dsw-alias-label-secondary', description: 'Secondary text color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-label-secondary' },
  { name: '--dsw-alias-state-error-primary', description: 'Primary error state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-error-primary' },
  { name: '--dsw-alias-state-idle-primary', description: 'Primary inactive state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-idle-primary' },
  { name: '--dsw-alias-state-success-primary', description: 'Primary success state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-success-primary' },
  { name: '--dsw-alias-state-warn-primary', description: 'Primary warning state color.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-alias-state-warn-primary' },
  { name: '--dsw-specific-sidebar-fill', description: 'Sidebar column and title-row background.', valueType: 'CSS color', requiresLightAndDark: true, cssVariable: '--dsw-specific-sidebar-fill' },
])

/**
 * Theme registry and preference owner. `light`/`dark` are built in (the base
 * stylesheets carry both palettes); third-party themes register alias-layer
 * overrides. Reads go through {@link getTheme}; preference writes only
 * through {@link setTheme}; continuous sync only through the `theme/change`
 * event. {@link overrideTokens} stacks partial token layers over the active
 * theme without touching the registry.
 * The service holds the `prefers-color-scheme` media query (environment
 * sensing, not presentation) and re-emits when the OS scheme flips while the
 * preference is `system`.
 */
export class ThemeRuntime {
  private readonly ctx: ClientContext
  private readonly host: ConfigForm<ThemeSettings>
  private themes: ThemeDefinition[] = [...BUILTIN_THEMES]
  private preference: ThemePreference
  private fontSize: number = bootstrapFontSizes().text
  private accent: AccentPreset = bootstrapChoice('dsAccent', ACCENT_PRESETS, DEFAULT_ACCENT)
  private themeSet: ThemeSet = bootstrapChoice('dsPalette', THEME_SETS, DEFAULT_THEME_SET)
  /** A local selection must not be overwritten by an in-flight legacy snapshot. */
  private themeSetExplicit = false
  private legacyAccent = typeof document !== 'undefined' && document.body.dataset.dsLegacyAccent === 'true'
  private glideDuration: GlideDuration = bootstrapNumberChoice('dsGlideDuration', GLIDE_DURATIONS, DEFAULT_GLIDE_DURATION)
  private fontFamily: FontFamily = bootstrapChoice('dsFontFamily', FONT_FAMILIES, DEFAULT_FONT_FAMILY)
  private corners: CornerPreset = bootstrapChoice('dsCorners', CORNER_PRESETS, DEFAULT_CORNER_PRESET)
  /** Optimistic writes stay authoritative until their Host mutation settles. */
  private readonly pendingValues = new Map<string, unknown>()
  private fontSizes: FontSizes = bootstrapFontSizes()
  private fontFamilies: FontFamilies = bootstrapFontFamilies()
  private revision = 0
  /** Own settings writes not yet settled; adoption waits for zero so a Host echo of an earlier write cannot revert a later local change. */
  private pendingWrites = 0
  private snapshot: ThemeSnapshot
  private readonly media: MediaQueryList | undefined
  /** Override layers by source; seq (monotonic) is the stacking order. */
  private readonly overrides = new Map<string, { seq: number; tokens: ThemeTokenOverrides }>()
  private overrideSeq = 0

  /**
   * @param ctx - owning context (change events are emitted on it; the
   * media-query and scope listeners are released through ctx.effect on dispose).
   * @param host - durable preference scope owned by the same plugin.
   */
  constructor(ctx: ClientContext, host: ConfigForm<ThemeSettings>) {
    this.ctx = ctx
    this.host = host
    this.preference = DEFAULT_PREFERENCE
    // Non-browser runs (node e2e booting the client tree) have no matchMedia.
    this.media = typeof matchMedia === 'undefined' ? undefined : matchMedia('(prefers-color-scheme: dark)')
    this.snapshot = this.buildSnapshot()
    if (this.media !== undefined) {
      const media = this.media
      const onChange = (): void => {
        if (this.preference !== 'system') return
        this.publish()
      }
      ctx.effect(() => {
        media.addEventListener('change', onChange)
        return () => { media.removeEventListener('change', onChange) }
      }, 'ui-theme: prefers-color-scheme listener')
    }
    ctx.effect(() => host.subscribe(() => { this.adopt() }), 'ui-theme: settings scope adoption')
    this.adopt()
    installFontSizeShortcuts(ctx, (delta) => { this.adjustFontSizes(delta) })
  }

  /**
   * Read the current immutable theme snapshot.
   * @returns the current snapshot (stable reference until the next change).
   */
  getTheme(): ThemeSnapshot {
    return this.snapshot
  }

  /**
   * Export the current token directory without reading DOM or computed styles.
   * @returns stable JSON-safe token descriptions, including registered and override-only names.
   */
  exportInspectTokens(): ThemeTokenInspection[] {
    const tokens = new Map(BUILTIN_INSPECT_TOKENS.map(token => [token.name, token]))
    for (const theme of this.themes) {
      for (const name of Object.keys(theme.tokens)) {
        if (!tokens.has(name)) tokens.set(name, dynamicToken(name))
      }
    }
    for (const layer of this.overrides.values()) {
      for (const name of Object.keys(layer.tokens)) {
        if (!tokens.has(name)) tokens.set(name, dynamicToken(name))
      }
    }
    return [...tokens.values()].map(token => ({ ...token })).sort((left, right) => left.name.localeCompare(right.name))
  }

  /**
   * Switch the theme preference — the only user preference write entry.
   * Built-in preferences are written through the settings scope and every
   * accepted value emits `theme/change`.
   * @param id - a registered theme id or `system`; unknown ids throw.
   */
  setTheme(id: string): void {
    if (id !== 'system' && !this.themes.some(t => t.id === id)) {
      throw new Error(`theme "${id}" is not registered`)
    }
    if (this.preference === id) return
    this.preference = id as ThemePreference
    if (isThemePreference(id)) this.persist(THEME_PREFERENCE_FIELD, id)
    this.publish()
  }

  /**
   * Change the conversation text size and persist it through the settings scope.
   * @param px - integer pixel size within the text role's range.
   */
  setFontSize(px: number): void
  /**
   * Change one role's font size and publish the optimistic value.
   * @param role - text, code, or terminal.
   * @param px - integer pixel size within the selected role's range.
   */
  setFontSize(role: FontRole, px: number): void
  setFontSize(roleOrPx: FontRole | number, value?: number): void {
    const role = typeof roleOrPx === 'number' ? 'text' : roleOrPx
    const px = typeof roleOrPx === 'number' ? roleOrPx : value
    const spec = FONT_SIZE_SPECS[role]
    if (px === undefined || !isFontSize(role, px)) throw new Error(`${role} font size ${px} is outside ${spec.min}..${spec.max}`)
    if (this.fontSizes[role] === px) return
    this.fontSizes = Object.freeze({ ...this.fontSizes, [role]: px })
    this.fontSize = this.fontSizes.text
    this.persist(spec.field, px)
    this.publish()
  }

  /**
   * Set a built-in accent palette and persist it in the theme namespace.
   * @param value - The selected palette.
   */
  setAccent(value: AccentPreset): void {
    if (this.accent === value) return
    this.accent = value
    this.persist('accent', value)
    this.publish()
  }

  /**
   * Select and persist a complete palette; this ends legacy accent overrides.
   * @param value - The selected complete palette.
   */
  setThemeSet(value: ThemeSet): void {
    if (this.themeSet === value && !this.legacyAccent) return
    this.themeSet = value
    this.themeSetExplicit = true
    this.legacyAccent = false
    this.persist('themeSet', value)
    this.publish()
  }

  /**
   * Persist the sidebar menu glide duration.
   * @param value - The selected duration in milliseconds.
   */
  setGlideDuration(value: GlideDuration): void {
    if (!GLIDE_DURATIONS.includes(value)) throw new Error(`unsupported glide duration ${value}`)
    if (this.glideDuration === value) return
    this.glideDuration = value
    this.persist('glideDuration', value)
    this.publish()
  }

  /** Restore appearance defaults with one durable settings revision. */
  resetAppearance(): void {
    this.preference = DEFAULT_PREFERENCE
    this.themeSet = DEFAULT_THEME_SET
    this.themeSetExplicit = true
    this.legacyAccent = false
    this.accent = DEFAULT_ACCENT
    this.fontFamily = DEFAULT_FONT_FAMILY
    this.corners = DEFAULT_CORNER_PRESET
    this.fontSize = DEFAULT_FONT_SIZE
    this.fontSizes = DEFAULT_FONT_SIZES
    this.fontFamilies = Object.freeze({ text: '', code: '', terminal: '' })
    this.glideDuration = DEFAULT_GLIDE_DURATION
    const values = {
      preference: this.preference, themeSet: this.themeSet, accent: this.accent,
      fontFamily: this.fontFamily, corners: this.corners, fontSize: this.fontSize,
      glideDuration: this.glideDuration,
      codeFontSize: this.fontSizes.code, terminalFontSize: this.fontSizes.terminal,
      textFontFamily: '', codeFontFamily: '', terminalFontFamily: '',
    }
    for (const [field, value] of Object.entries(values)) this.pendingValues.set(field, value)
    void this.host.mutate([
      { path: ['preference'], op: 'set', value: this.preference },
      { path: ['themeSet'], op: 'set', value: this.themeSet },
      { path: ['accent'], op: 'set', value: this.accent },
      { path: ['fontFamily'], op: 'set', value: this.fontFamily },
      { path: ['corners'], op: 'set', value: this.corners },
      { path: ['fontSize'], op: 'set', value: this.fontSize },
      { path: ['glideDuration'], op: 'set', value: this.glideDuration },
      { path: ['codeFontSize'], op: 'set', value: this.fontSizes.code },
      { path: ['terminalFontSize'], op: 'set', value: this.fontSizes.terminal },
      { path: ['textFontFamily'], op: 'set', value: '' },
      { path: ['codeFontFamily'], op: 'set', value: '' },
      { path: ['terminalFontFamily'], op: 'set', value: '' },
    ]).then(
      () => { this.settleWrites(values) },
      () => { this.settleWrites(values) },
    )
    this.publish()
  }

  /**
   * Set the application text family without changing code or brand text.
   * @param value - The selected family.
   */
  setFontFamily(value: FontFamily): void
  /**
   * Persist a role-specific font list; an empty list restores its fallback stack.
   * @param role - text, code, or terminal.
   * @param value - comma-separated font families.
   */
  setFontFamily(role: FontRole, value: string): void
  setFontFamily(roleOrValue: FontRole | FontFamily, value?: string): void {
    if (value === undefined) {
      const preset = FONT_FAMILIES.find(font => font === roleOrValue)
      if (preset === undefined) throw new Error(`unsupported font preset ${roleOrValue}`)
      if (this.fontFamily === preset) return
      this.fontFamily = preset
      this.persist('fontFamily', preset)
    } else {
      const role = FONT_ROLES.find(candidate => candidate === roleOrValue)
      if (role === undefined) throw new Error(`unsupported font role ${roleOrValue}`)
      const list = normalizeFontFamily(value)
      if (this.fontFamilies[role] === list) return
      this.fontFamilies = Object.freeze({ ...this.fontFamilies, [role]: list })
      this.persist(FONT_FAMILY_FIELDS[role], list)
    }
    this.publish()
  }

  /**
   * Set the shared corner scale.
   * @param value - The selected scale.
   */
  setCorners(value: CornerPreset): void {
    if (this.corners === value) return
    this.corners = value
    this.persist('corners', value)
    this.publish()
  }

  /**
   * Step all font sizes within their own ranges and save changed fields in one mutation.
   * Emits one `theme/change`; no write or event occurs when every role is at its limit.
   * @param delta - one pixel to add or remove from each role's current size.
   */
  private adjustFontSizes(delta: 1 | -1): void {
    const fontSizes = { ...this.fontSizes }
    const fields: Record<string, number> = {}
    for (const role of FONT_ROLES) {
      const { field, min, max } = FONT_SIZE_SPECS[role]
      const px = Math.max(min, Math.min(max, fontSizes[role] + delta))
      if (px === fontSizes[role]) continue
      fontSizes[role] = px
      fields[field] = px
    }
    const ops = Object.entries(fields).map(([field, value]) => ({ op: 'set' as const, path: [field], value }))
    if (ops.length === 0) return
    this.fontSizes = Object.freeze(fontSizes)
    this.fontSize = fontSizes.text
    this.write(() => this.host.mutate(ops))
    this.publish()
  }

  /** Queue one settings write, then adopt the durable section once no own write remains. */
  private write(operation: () => Promise<boolean>): void {
    this.pendingWrites += 1
    void operation().finally(() => {
      this.pendingWrites -= 1
      this.adopt()
    })
  }

  /** Adopt the scope's accepted durable preference without writing it back. */
  private adopt(): void {
    if (this.pendingWrites > 0 || this.pendingValues.size > 0) return
    const form = this.host.getSnapshot()
    const section = form.value
    if (section === undefined) return
    const preference = this.pendingOr(THEME_PREFERENCE_FIELD, section.preference)
    const fontSize = this.pendingOr(FONT_SIZE_FIELD, section.fontSize)
    const accent = this.pendingOr('accent', section.accent)
    const fontFamily = this.pendingOr('fontFamily', section.fontFamily)
    const corners = this.pendingOr('corners', section.corners)
    const glideDuration = this.pendingOr('glideDuration', section.glideDuration)
    const sizes = sectionFontSizes(section)
    const families = durableFontFamilies(section)
    const fontSizes: FontSizes = Object.freeze({
      text: fontSize,
      code: this.pendingOr('codeFontSize', sizes.code),
      terminal: this.pendingOr('terminalFontSize', sizes.terminal),
    })
    const fontFamilies: FontFamilies = Object.freeze({
      text: this.pendingOr('textFontFamily', families.text),
      code: this.pendingOr('codeFontFamily', families.code),
      terminal: this.pendingOr('terminalFontFamily', families.terminal),
    })
    const userHasThemeSet = isOwnThemeSet(form.user)
    if (userHasThemeSet) this.themeSetExplicit = true
    const palette = this.themeSetExplicit
      ? { themeSet: this.pendingOr('themeSet', section.themeSet), legacyAccent: false }
      : resolveThemeSet(section.themeSet, form.user)
    if (this.preference === preference && this.fontSize === fontSize
      && this.accent === accent && this.fontFamily === fontFamily
      && this.corners === corners && this.themeSet === palette.themeSet
      && this.legacyAccent === palette.legacyAccent
      && this.glideDuration === glideDuration
      && FONT_ROLES.every(role => this.fontSizes[role] === fontSizes[role] && this.fontFamilies[role] === fontFamilies[role])) return
    this.preference = preference
    this.fontSize = fontSize
    this.fontSizes = fontSizes
    this.fontFamilies = fontFamilies
    this.accent = accent
    this.themeSet = palette.themeSet
    this.legacyAccent = palette.legacyAccent
    this.glideDuration = glideDuration
    this.fontFamily = fontFamily
    this.corners = corners
    this.publish()
  }

  /** Queue one durable value and keep it visible while an older snapshot is in flight. */
  private persist(field: string, value: unknown): void {
    this.pendingValues.set(field, value)
    void this.host.set(field, value).then(
      () => { this.settleWrites({ [field]: value }) },
      () => { this.settleWrites({ [field]: value }) },
    )
  }

  /** Drop only the writes this completion still owns, then reconcile Host state. */
  private settleWrites(values: Record<string, unknown>): void {
    for (const [field, value] of Object.entries(values)) {
      if (this.pendingValues.get(field) === value) this.pendingValues.delete(field)
    }
    this.adopt()
  }

  /** Read an optimistic value for one field, or the latest Host value. */
  private pendingOr<T>(field: string, value: T): T {
    return this.pendingValues.has(field) ? this.pendingValues.get(field) as T : value
  }

  /**
   * Register a theme. Duplicate id throws (single occupant per id; the
   * built-in pair counts; `system` is a preference, not a registrable id).
   * @param definition - theme id, colorScheme, and alias-token overrides.
   * @returns disposer. Disposing the theme backing the active preference
   * resets the preference to the default so the UI never keeps tokens of an
   * unregistered theme.
   */
  register(definition: ThemeDefinition): () => void {
    if (definition.id === 'system') throw new Error('"system" is a preference, not a registrable theme id')
    if (this.themes.some(t => t.id === definition.id)) {
      throw new Error(`theme "${definition.id}" is already registered`)
    }
    this.themes = [...this.themes, definition]
    this.publish()
    return () => {
      if (!this.themes.some(t => t.id === definition.id)) return
      this.themes = this.themes.filter(t => t.id !== definition.id)
      if (this.preference === definition.id) {
        this.preference = DEFAULT_PREFERENCE
      }
      this.publish()
    }
  }

  /**
   * Stack a token override layer on top of the active theme — the token-level
   * analogue of slot shading: the base theme stays untouched, layers compose
   * in seq order with later layers winning per-token, and removing a layer
   * restores whatever it covered. Calling again with the same source replaces
   * that source's whole layer and restacks it on top (effect re-registration
   * semantics). Emits `theme/change` with the recomposed snapshot.
   * @param source - layer identity; one layer per source (dynamic packages
   * pass their package id — the façade pins it, so it also names the layer's
   * origin for inspection).
   * @param tokens - token-name → `{ light, dark }` value pairs. Validated at
   * runtime (model-authored callers reach this boundary with untyped JS);
   * a bare string value throws a teaching error.
   * @returns disposer removing exactly the layer this call created; a no-op
   * once the source has re-overridden (the newer layer is not torn down).
   */
  overrideTokens(source: string, tokens: ThemeTokenOverrides): () => void {
    const layer = { seq: this.overrideSeq++, tokens: validateOverrides(source, tokens) }
    this.overrides.set(source, layer)
    this.publish()
    return () => {
      if (this.overrides.get(source) !== layer) return
      this.overrides.delete(source)
      this.publish()
    }
  }

  private buildSnapshot(): ThemeSnapshot {
    const resolvedId = this.preference === 'system'
      ? (this.media?.matches === true ? 'dark' : 'light')
      : this.preference
    // Both built-ins always exist; a registered preference id resolves or has
    // been reset by its disposer, so the lookup cannot miss.
    const active = this.themes.find(t => t.id === resolvedId)
    /* v8 ignore next 2 -- needs a registry without light/dark, which register()/dispose() cannot produce */
    if (active === undefined) throw new Error(`theme registry lost "${resolvedId}"`)
    return Object.freeze({
      preference: this.preference,
      fontSize: this.fontSize,
      accent: this.accent,
      themeSet: this.themeSet,
      legacyAccent: this.legacyAccent,
      glideDuration: this.glideDuration,
      fontFamily: this.fontFamily,
      corners: this.corners,
      fontSizes: this.fontSizes,
      fontFamilies: this.fontFamilies,
      active: this.composeActive(active),
      themes: Object.freeze([...this.themes]),
      revision: this.revision,
    })
  }

  /**
   * Fold the override layers into the active definition: seq order, later
   * layers win per-token, each value picked for the active color scheme (the
   * presenter consumes the composed snapshot and needs no override awareness).
   * Without layers the registered definition passes through by identity.
   */
  private composeActive(active: ThemeDefinition): ThemeDefinition {
    if (this.overrides.size === 0) return active
    const tokens: ThemeTokens = { ...active.tokens }
    for (const layer of [...this.overrides.values()].sort((a, b) => a.seq - b.seq)) {
      for (const [name, modes] of Object.entries(layer.tokens)) {
        tokens[name] = modes[active.colorScheme]
      }
    }
    return Object.freeze({ ...active, tokens: Object.freeze(tokens) })
  }

  private publish(): void {
    this.revision += 1
    this.snapshot = this.buildSnapshot()
    this.ctx.emit('theme/change', this.snapshot)
  }
}

/**
 * Read the font sizes the Host boot script wrote on `body` before any plugin
 * ran, so the initial snapshot matches first paint and ui-layout's presenter
 * does not flash the schema defaults while the settings read is in flight.
 * Non-browser runs, mounts without the boot script, and out-of-range values
 * fall back to each role's default; the durable settings adoption still lands afterwards.
 */
function bootstrapFontSizes(): FontSizes {
  /* v8 ignore next -- needs a documentless run (node e2e booting the client tree), not constructible under jsdom */
  if (typeof document === 'undefined') return DEFAULT_FONT_SIZES
  const read = (role: FontRole): number => {
    const parsed = Number.parseInt(document.body.style.getPropertyValue(FONT_SIZE_SPECS[role].variable), 10)
    return isFontSize(role, parsed) ? parsed : FONT_SIZE_SPECS[role].default
  }
  return Object.freeze({ text: read('text'), code: read('code'), terminal: read('terminal') })
}

/** Font lists the Host boot script wrote on `body`, read for the same first-paint reason as {@link bootstrapFontSizes}. */
function bootstrapFontFamilies(): FontFamilies {
  /* v8 ignore next -- needs a documentless run (node e2e booting the client tree), not constructible under jsdom */
  if (typeof document === 'undefined') return Object.freeze({ text: '', code: '', terminal: '' })
  const style = document.body.style
  return Object.freeze({
    text: normalizeFontFamily(style.getPropertyValue(fontFamilyVariable('text'))),
    code: normalizeFontFamily(style.getPropertyValue(fontFamilyVariable('code'))),
    terminal: normalizeFontFamily(style.getPropertyValue(fontFamilyVariable('terminal'))),
  })
}

/** Normalized font lists from one accepted settings section (hand-edited documents may hold raw input). */
function durableFontFamilies(section: ThemeSettings): FontFamilies {
  return Object.freeze({
    text: normalizeFontFamily(section.textFontFamily),
    code: normalizeFontFamily(section.codeFontFamily),
    terminal: normalizeFontFamily(section.terminalFontFamily),
  })
}

/** Read a validated choice installed by the Host before the client activates. */
function bootstrapChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  if (typeof document === 'undefined') return fallback
  const raw = document.body.dataset[key]
  return choices.find(choice => choice === raw) ?? fallback
}

/** Read the bootstrapped menu animation speed before the Host section arrives. */
function bootstrapNumberChoice<T extends number>(key: string, choices: readonly T[], fallback: T): T {
  if (typeof document === 'undefined') return fallback
  const value = Number(document.body.dataset[key])
  return choices.find(choice => choice === value) ?? fallback
}

/** Check raw settings field presence without confusing schema defaults for a user choice. */
function isOwnThemeSet(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.hasOwn(value, 'themeSet')
}

/**
 * Runtime shape check for one override layer (model-authored callers pass
 * untyped JS through the dynamic-package façade, so the static type cannot
 * enforce the pair shape there). Returns a defensive per-token copy so later
 * caller mutation cannot reach the stored layer.
 */function validateOverrides(source: string, tokens: ThemeTokenOverrides): ThemeTokenOverrides {
  const validated: ThemeTokenOverrides = {}
  for (const [name, value] of Object.entries<unknown>(tokens)) {
    if (typeof value === 'string') {
      throw new TypeError(
        `theme override "${name}" from "${source}" is a bare string — pass { light: ${JSON.stringify(value)}, dark: ${JSON.stringify(value)} } `
        + '(repeat the value when it is the same in both palettes); a single value goes illegible when the user switches color scheme',
      )
    }
    if (typeof value !== 'object' || value === null
      || typeof (value as { light?: unknown }).light !== 'string'
      || typeof (value as { dark?: unknown }).dark !== 'string') {
      throw new TypeError(
        `theme override "${name}" from "${source}" must map to a { light, dark } pair of strings — one value per color scheme`,
      )
    }
    const modes = value as ThemeTokenModes
    validated[name] = { light: modes.light, dark: modes.dark }
  }
  return validated
}

function dynamicToken(name: string): ThemeTokenInspection {
  return {
    name,
    description: 'Theme token registered by the current Client composition.',
    valueType: 'CSS value',
    requiresLightAndDark: true,
    ...(name.startsWith('--') ? { cssVariable: name } : {}),
  }
}

/** Register desktop font-size keys when keyboard and locale services are available. */
function installFontSizeShortcuts(ctx: ClientContext, adjust: (delta: 1 | -1) => void): void {
  ctx.inject(['shortcuts', 'locale'], (scope) => {
    if (scope.shortcuts.runtime !== 'desktop') return
    const t = scope.locale.bind(SETTINGS_NS)
    const combinations: { binding: NormalizedBinding; delta: 1 | -1 }[] = []
    // Fixed bindings drive both reservation and matching.
    for (const [direction, code, delta] of [['increase', 'Equal', 1], ['decrease', 'Minus', -1]] as const) {
      const binding = { code, modifiers: ['primary'] as const }
      const bindings = direction === 'increase'
        ? [binding, { code, modifiers: ['primary', 'shift'] as const }] as const : [binding] as const
      for (const candidate of bindings) {
        combinations.push({ binding: scope.shortcuts.describeBinding(candidate).binding as NormalizedBinding, delta })
      }
      scope.effect(() => scope.shortcuts.registerFixed({
        id: `fontSize.${direction}` as ShortcutCommandId, label: () => t(`fontSize.text.${direction}`),
        keys: scope.shortcuts.describeBinding(binding).keys,
        bindings, group: 'application',
      }), `ui-theme: ${direction} font size reference`)
    }
    scope.effect(() => scope.shortcuts.observeFixedInput((input) => {
      if (input.type === 'reset') return
      const { gesture, context } = input
      if (gesture.composing || gesture.defaultPrevented || gesture.repeat || context.region === 'terminal') return
      const matched = combinations.find(({ binding }) => binding.code === gesture.code
        && (['control', 'alt', 'shift', 'meta'] as const).every(modifier => gesture[modifier] === binding.modifiers.includes(modifier)))
      if (matched === undefined) return
      input.consume()
      adjust(matched.delta)
    }), 'ui-theme: font size input')
  })
}

/**
 * Required services: settings transport plus slots/locale for the Appearance
 * row. `remote` carries the forwarded settings invalidation that
 * `ctx.configForms.get(entryId)` subscribes to on this context.
 */
export const inject = ['slots', 'locale', 'remote', 'configForms']

/**
 * Client plugin body: provide the theme service and register the
 * feature-owned Appearance and font settings rows into the General section's item
 * slot (a feature owns its settings surface). Desktop font-size shortcuts share
 * all three font-size settings when the keyboard service is available.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  installThemeStyles(ctx)
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ui-theme: settings row dictionaries')
  const host = ctx.configForms.get<ThemeSettings>(THEME_SETTINGS_NAMESPACE)
  const theme = new ThemeRuntime(ctx, host)
  ctx.provide('theme', theme)

  const store = createThemePageStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (snapshot: ThemeSnapshot): void => {
    bound?.sync({
      preference: snapshot.preference, accent: snapshot.accent,
      themeSet: snapshot.themeSet, legacyAccent: snapshot.legacyAccent,
      glideDuration: snapshot.glideDuration,
      fontFamily: snapshot.fontFamily, corners: snapshot.corners,
      fontSize: snapshot.fontSize, revision: snapshot.revision,
      fontSizes: snapshot.fontSizes, fontFamilies: snapshot.fontFamilies,
    })
  }
  ctx.on('theme/change', sync)
  const injected = (actions: BoundActions<typeof store>): ThemeSettingsPageInjected => {
    bound = actions
    // Re-sync from the getter so no event is lost between registration and
    // first render (the store's revision guard drops stale duplicates).
    sync(theme.getTheme())
    return {
      setTheme: (id) => { theme.setTheme(id) },
      setAccent: (value) => { theme.setAccent(value) },
      setThemeSet: (value) => { theme.setThemeSet(value) },
      setGlideDuration: (value) => { theme.setGlideDuration(value) },
      resetAppearance: () => { theme.resetAppearance() },
      setFontFamily: (value) => { theme.setFontFamily(value) },
      setCorners: (value) => { theme.setCorners(value) },
      setFontSize: (value) => { theme.setFontSize(value) },
      setRoleFontSize: (role, value) => { theme.setFontSize(role, value) },
      setRoleFontFamily: (role, value) => { theme.setFontFamily(role, value) },
    }
  }
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'appearance-theme',
    order: 5,
    label: () => ctx.locale.bind(SETTINGS_NS)('page.title'),
    store,
    locale: SETTINGS_NS,
    inject: injected,
  }, ThemeSettingsPage))
  ctx.inject(['settingsSearch'], (scope) => {
    const searchTargets = [
      ['mode', 'preset.modeHeading'], ['palette', 'preset.colorHeading'],
      ['font', 'preset.fontHeading'], ['radius', 'preset.radiusHeading'],
      ['motion', 'preset.motionHeading'],
    ] as const
    for (const [id, key] of searchTargets) scope.effect(() => scope.settingsSearch.register({
      id: `appearance.${id}`, sectionId: 'appearance-theme',
      label: () => ctx.locale.bind(SETTINGS_NS)(key), target: `#appearance-${id}-heading`,
    }))
  })
}
