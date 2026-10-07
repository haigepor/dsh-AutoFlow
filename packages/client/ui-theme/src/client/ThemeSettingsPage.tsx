/** Appearance settings rows backed by the browser theme runtime. */
import { useState, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular, IconDarkOutlineRegular, IconFollowsystemOutlineRegular,
  IconLightOutlineRegular, IconRefreshOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  GLIDE_DURATIONS,
  type AccentPreset, type CornerPreset, type FontFamily, type GlideDuration,
  type ThemePreference, type ThemeSet,
} from '../theme-settings.ts'
import type { createThemePageStore } from './settings-store.ts'
import { PalettePreview } from './previews/PalettePreview.tsx'
import css from './ThemeSettingsPage.module.css'

/** Theme writes supplied by the plugin. */
export interface ThemeSettingsPageInjected {
  setTheme: (value: ThemePreference) => void
  setAccent: (value: AccentPreset) => void
  setThemeSet: (value: ThemeSet) => void
  setFontFamily: (value: FontFamily) => void
  setCorners: (value: CornerPreset) => void
  setGlideDuration: (value: GlideDuration) => void
  setFontSize: (value: number) => void
  resetAppearance: () => void
}

/** Full settings section props. */
export type ThemeSettingsPageProps = PropsRuntime<'settings.section'>
  & PropsStore<ReturnType<typeof createThemePageStore>>
  & PropsLocale<'settings.theme'> & ThemeSettingsPageInjected

const MODES: readonly ThemePreference[] = ['system', 'light', 'dark']
const THEME_SETS: readonly ThemeSet[] = ['official', 'current']
const FONTS: readonly FontFamily[] = ['system', 'source-sans-3', 'ibm-plex-serif', 'jetbrains-mono', 'ibm-plex-sans-condensed']
const LEGACY_FONTS: readonly FontFamily[] = ['inter', 'noto-sans-sc']
const RADII = ['0', '0.25', '0.5', '0.75', '1'] as const satisfies readonly CornerPreset[]

function AppearanceRow<Value extends string | number>({ id, title, description, label, selected, options, onSelect }: {
  id: string
  title: string
  description: string
  label: ReactNode
  selected: Value | undefined
  options: readonly { value: Value; label: ReactNode }[]
  onSelect: (value: Value) => void
}) {
  const [open, setOpen] = useState(false)
  return <section className={css.row} aria-labelledby={id}>
    <div className={css.rowText}>
      <h2 id={id} className={css.rowTitle}>{title}</h2>
      <p className={css.description}>{description}</p>
    </div>
    <Menu open={open} portal autoFocus align="end" className={css.menu} listClassName={css.menuList}
      selectedId={selected === undefined ? undefined : String(selected)}
      items={options.map(option => ({ id: String(option.value), label: option.label }))}
      onClose={() => { setOpen(false) }}
      onSelect={(value) => {
        const option = options.find(candidate => String(candidate.value) === value)
        if (option) onSelect(option.value)
        setOpen(false)
      }}
      anchor={<button type="button" className={css.selector} aria-labelledby={id}
        aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}>
        <span>{label}</span><IconChevronDownOutlineRegular className={css.chevron} size={14} />
      </button>}
    />
  </section>
}

/**
 * Render Appearance as General-style settings rows, retaining saved legacy choices.
 * @param props - composed settings props and appearance writes.
 * @returns the Appearance section and its shared selection menus.
 */
export function ThemeSettingsPage({
  t, useStore, setTheme, setThemeSet, setFontFamily, setCorners, setGlideDuration, resetAppearance,
}: ThemeSettingsPageProps) {
  const state = useStore(snapshot => snapshot)
  // 旧字体只在仍被使用时展示；浏览页面不会改写已有偏好。
  const fonts = FONTS.includes(state.fontFamily) ? FONTS : [...FONTS, ...LEGACY_FONTS.filter(font => font === state.fontFamily)]
  const radius = state.corners === 'compact' ? '0.25' : state.corners === 'standard' ? '0.75'
    : state.corners === 'soft' ? '1' : state.corners

  return <div className={css.section} data-appearance-settings>
    <header className={css.header} data-settings-page-header>
      <h1 className={css.heading}>{t('preset.pageTitle')}</h1>
      <button type="button" className={css.resetButton} onClick={resetAppearance}>
        <IconRefreshOutlineRegular size={14} />{t('preset.reset')}
      </button>
    </header>
    <section className={css.row} aria-labelledby="appearance-mode-heading">
      <div className={css.rowText}>
        <h2 id="appearance-mode-heading" className={css.rowTitle}>{t('preset.modeHeading')}</h2>
        <p className={css.description}>{t('mode.description')}</p>
      </div>
      <div className={css.modeCards} role="group" aria-labelledby="appearance-mode-heading">
        {MODES.map((mode) => {
          const Icon = mode === 'system' ? IconFollowsystemOutlineRegular
            : mode === 'light' ? IconLightOutlineRegular : IconDarkOutlineRegular
          return <button key={mode} type="button" className={css.modeCard}
            aria-pressed={state.preference === mode} onClick={() => { setTheme(mode) }}>
            <Icon size={18} aria-hidden="true" /><span>{t(`preset.mode.${mode}.label`)}</span>
          </button>
        })}
      </div>
    </section>
    <section className={css.row} aria-labelledby="appearance-palette-heading">
      <div className={css.rowText}>
        <h2 id="appearance-palette-heading" className={css.rowTitle}>{t('preset.colorHeading')}</h2>
        <p className={css.description}>{state.legacyAccent ? t('preset.theme.custom.label') : t('preset.paletteDescription')}</p>
      </div>
      <div className={`${css.modeCards} ${css.paletteCards}`} role="group" aria-labelledby="appearance-palette-heading">
        {THEME_SETS.map(themeSet => <button key={themeSet} type="button" className={css.modeCard}
          aria-pressed={state.themeSet === themeSet && !state.legacyAccent} onClick={() => { setThemeSet(themeSet) }}>
          <PalettePreview palette={themeSet} />
          <span>{t(`preset.theme.${themeSet}.label`)}</span>
        </button>)}
      </div>
    </section>
    <AppearanceRow id="appearance-font-heading" title={t('preset.fontHeading')} description={t('font.description')}
      label={<span className={css.fontSample} data-font={state.fontFamily}>{t(`preset.font.${state.fontFamily}.label`)}</span>}
      selected={state.fontFamily}
      options={fonts.map(value => ({ value,
        label: <span className={css.fontSample} data-font={value}>{t(`preset.font.${value}.label`)}</span>,
      }))} onSelect={setFontFamily} />
    <AppearanceRow id="appearance-radius-heading" title={t('preset.radiusHeading')} description={t('corners.description')}
      label={t(`preset.radius.${radius}.label`)} selected={radius}
      options={RADII.map(value => ({ value, label: t(`preset.radius.${value}.label`) }))} onSelect={setCorners} />
    <AppearanceRow id="appearance-motion-heading" title={t('preset.motionHeading')} description={t('preset.motionDescription')}
      label={t(`preset.motion.${state.glideDuration}`)} selected={state.glideDuration}
      options={GLIDE_DURATIONS.map(value => ({ value, label: t(`preset.motion.${value}`) }))} onSelect={setGlideDuration} />
  </div>
}
