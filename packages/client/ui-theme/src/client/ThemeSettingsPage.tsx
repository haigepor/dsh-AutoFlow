/** Appearance settings controls backed by the browser theme runtime. */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  IconCheckOutlineRegular, IconDarkOutlineRegular, IconFollowsystemOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular,
  IconLightOutlineRegular, IconRefreshOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  GLIDE_DURATIONS,
  type AccentPreset, type CornerPreset, type FontFamily, type GlideDuration,
  type ThemePreference, type ThemeSet,
} from '../theme-settings.ts'
import type { createThemePageStore } from './settings-store.ts'
import { IconThemeDark } from './previews/IconThemeDark.tsx'
import { IconThemeLight } from './previews/IconThemeLight.tsx'
import { IconThemeSystem } from './previews/IconThemeSystem.tsx'
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
const PALETTE_PAGE_SIZE = 4
const PALETTE_PAGES = Array.from(
  { length: Math.ceil(THEME_SETS.length / PALETTE_PAGE_SIZE) },
  (_, page) => THEME_SETS.slice(page * PALETTE_PAGE_SIZE, (page + 1) * PALETTE_PAGE_SIZE),
)
const FONTS: readonly FontFamily[] = ['system', 'source-sans-3', 'ibm-plex-serif', 'jetbrains-mono', 'ibm-plex-sans-condensed']
const LEGACY_FONTS: readonly FontFamily[] = ['inter', 'noto-sans-sc']
const RADII = ['0', '0.25', '0.5', '0.75', '1'] as const satisfies readonly CornerPreset[]
const RADIUS_VALUES: Record<(typeof RADII)[number], string> = {
  '0': '0px', '0.25': '4px', '0.5': '8px', '0.75': '12px', '1': '16px',
}

function ChoiceCard({ label, description, selected, onSelect, children }: {
  label: string
  description: string
  selected: boolean
  onSelect: () => void
  children: ReactNode
}) {
  return <button type="button" className={css.choiceCard} data-selected={selected || undefined}
    aria-pressed={selected} onClick={onSelect}>
    <span className={css.choicePreview}>{children}</span>
    <span className={css.choiceMeta}><span className={css.choiceLabel}>{label}</span>
      {selected && <span className={css.selectedMark}><IconCheckOutlineRegular size={13} /></span>}
    </span>
    <span className={css.choiceDescription}>{description}</span>
  </button>
}

/** Upstream SVG previews for the three appearance modes. */
function ShellPreview({ mode, palette }: { mode: ThemePreference; palette?: ThemeSet }) {
  if (palette !== undefined) return <PalettePreview mode={mode} palette={palette} />
  const Preview = mode === 'system' ? IconThemeSystem : mode === 'light' ? IconThemeLight : IconThemeDark
  const Icon = mode === 'system' ? IconFollowsystemOutlineRegular
    : mode === 'light' ? IconLightOutlineRegular : IconDarkOutlineRegular
  return <span className={`${css.appearancePreview} ${css.modePreview}`} data-preview-mode={mode}>
    <Preview className={css.assetPreview} aria-hidden="true" />
    <span className={css.appearanceIcon}><Icon size={14} /></span>
  </span>
}

/** Palette-specific shell preview for the project's two selectable colour sets. */
function PalettePreview({ mode, palette }: { mode: ThemePreference; palette: ThemeSet }) {
  return <span className={`${css.appearancePreview} ${css.palettePreview}`} data-preview-palette={palette} data-preview-mode={mode}>
    <span className={css.windowPreview} aria-hidden="true">
      <span className={css.previewSidebar}>
        <span className={css.previewDot} />
        <span className={css.previewLine} />
        <span className={css.previewLineShort} />
        <span className={css.previewLineAccent} />
      </span>
      <span className={css.previewCanvas}>
        <span className={css.previewAccent} />
        <span className={css.previewBlock} />
        <span className={css.previewText} />
      </span>
    </span>
  </span>
}

/** Render the complete Appearance page. */
export function ThemeSettingsPage({
  t, useStore, setTheme, setThemeSet, setFontFamily, setCorners, setGlideDuration, resetAppearance,
}: ThemeSettingsPageProps) {
  const state = useStore(snapshot => snapshot)
  const fonts = FONTS.includes(state.fontFamily) ? FONTS : [...FONTS, ...LEGACY_FONTS.filter(font => font === state.fontFamily)]
  const [palettePage, setPalettePage] = useState(() => Math.max(0, Math.floor(THEME_SETS.indexOf(state.themeSet) / PALETTE_PAGE_SIZE)))
  const [motionMenuOpen, setMotionMenuOpen] = useState(false)
  const [draggingPalette, setDraggingPalette] = useState(false)
  const [paletteDragOffset, setPaletteDragOffset] = useState(0)
  const paletteDragStart = useRef<{ x: number; page: number } | null>(null)
  const suppressPaletteClick = useRef(false)
  const clampPalettePage = (page: number): number => Math.min(PALETTE_PAGES.length - 1, Math.max(0, page))

  useEffect(() => {
    setPalettePage(Math.max(0, Math.floor(THEME_SETS.indexOf(state.themeSet) / PALETTE_PAGE_SIZE)))
  }, [state.themeSet])

  useEffect(() => {
    if (!draggingPalette) return
    const onMove = (event: PointerEvent): void => {
      if (!paletteDragStart.current) return
      setPaletteDragOffset(event.clientX - paletteDragStart.current.x)
    }
    const onEnd = (event: PointerEvent): void => {
      const start = paletteDragStart.current
      paletteDragStart.current = null
      setDraggingPalette(false)
      setPaletteDragOffset(0)
      if (!start) return
      const offset = event.clientX - start.x
      if (Math.abs(offset) >= 8) suppressPaletteClick.current = true
      if (offset <= -48) setPalettePage(clampPalettePage(start.page + 1))
      else if (offset >= 48) setPalettePage(clampPalettePage(start.page - 1))
    }
    const onCancel = (): void => {
      paletteDragStart.current = null
      setDraggingPalette(false)
      setPaletteDragOffset(0)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onCancel)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onCancel)
    }
  }, [draggingPalette])

  const selectThemeSet = (themeSet: ThemeSet): void => {
    if (suppressPaletteClick.current) {
      suppressPaletteClick.current = false
      return
    }
    setThemeSet(themeSet)
  }

  const onPaletteCarouselKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      setPalettePage(clampPalettePage(palettePage - 1))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      setPalettePage(clampPalettePage(palettePage + 1))
    }
  }

  return <div className={css.section} data-appearance-settings>
    <header className={css.header}>
      <div className={css.headerCopy}><h1 className={css.heading}>{t('preset.pageTitle')}</h1></div>
      <button type="button" className={css.resetButton} onClick={resetAppearance}>
        <IconRefreshOutlineRegular size={14} />{t('preset.reset')}
      </button>
    </header>

    <section className={css.group} aria-labelledby="appearance-mode-heading">
      <div className={css.groupHeading}><h2 id="appearance-mode-heading">{t('preset.modeHeading')}</h2></div>
      <div className={css.gridThree}>{MODES.map(mode => <ChoiceCard key={mode}
        label={t(`preset.mode.${mode}.label`)} description={t(`preset.mode.${mode}.description`)}
        selected={state.preference === mode} onSelect={() => { setTheme(mode) }}><ShellPreview mode={mode} /></ChoiceCard>)}</div>
    </section>

    <section className={css.group} aria-labelledby="appearance-palette-heading">
      <div className={css.groupHeading}><h2 id="appearance-palette-heading">{t('preset.colorHeading')}</h2></div>
      <div className={css.carousel} role="group" aria-roledescription={t('preset.carousel.label')}
        aria-label={t('preset.colorHeading')} onKeyDown={onPaletteCarouselKeyDown}>
        <div className={css.carouselViewport}>
          <div className={css.carouselTrack} data-dragging={draggingPalette || undefined}
            style={draggingPalette
              ? { transform: `translateX(calc(-${palettePage * 100}% + ${paletteDragOffset}px))`, transition: 'none' }
              : { transform: `translateX(-${palettePage * 100}%)` }}
            onPointerDown={(event) => {
              paletteDragStart.current = { x: event.clientX, page: palettePage }
              suppressPaletteClick.current = false
              setDraggingPalette(true)
            }}>
            {PALETTE_PAGES.map((page, index) => <div key={index} className={css.carouselPage}
              data-carousel-page={index} aria-hidden={index !== palettePage}
              ref={(node) => { if (node) node.inert = index !== palettePage }}>
              <div className={css.carouselPageGrid}>{page.map(themeSet => <ChoiceCard key={themeSet}
                label={t(`preset.theme.${themeSet}.label`)} description={t(`preset.theme.${themeSet}.description`)}
                selected={state.themeSet === themeSet && !state.legacyAccent} onSelect={() => { selectThemeSet(themeSet) }}>
                <ShellPreview mode={state.preference} palette={themeSet} />
              </ChoiceCard>)}</div>
            </div>)}
          </div>
        </div>
        {PALETTE_PAGES.length > 1 && <div className={css.carouselControls}>
          <button type="button" className={css.carouselArrow} disabled={palettePage === 0}
            aria-label={t('preset.carousel.previous')} onClick={() => { setPalettePage(clampPalettePage(palettePage - 1)) }}>
            <IconChevronLeftOutlineRegular size={14} />
          </button>
          <div className={css.carouselDots} role="group" aria-label={t('preset.colorHeading')}>
            {PALETTE_PAGES.map((page, index) => <button key={index} type="button" className={css.carouselDot}
              data-active={index === palettePage || undefined} aria-current={index === palettePage ? 'true' : undefined}
              aria-label={page.map(themeSet => t(`preset.theme.${themeSet}.label`)).join(', ')} onClick={() => { setPalettePage(index) }} />)}
          </div>
          <button type="button" className={css.carouselArrow} disabled={palettePage === PALETTE_PAGES.length - 1}
            aria-label={t('preset.carousel.next')} onClick={() => { setPalettePage(clampPalettePage(palettePage + 1)) }}>
            <IconChevronRightOutlineRegular size={14} />
          </button>
        </div>}
      </div>
    </section>

    <section className={css.group} aria-labelledby="appearance-font-heading">
      <div className={css.groupHeading}><h2 id="appearance-font-heading">{t('preset.fontHeading')}</h2></div>
      <div className={css.gridFive}>{fonts.map(option => <ChoiceCard key={option}
        label={t(`preset.font.${option}.label`)} description={t(`preset.font.${option}.description`)}
        selected={state.fontFamily === option} onSelect={() => { setFontFamily(option) }}>
        <span className={css.fontPreview} data-font={option}>Aa</span>
      </ChoiceCard>)}</div>
    </section>

    <section className={css.group} aria-labelledby="appearance-radius-heading">
      <div className={css.groupHeading}><h2 id="appearance-radius-heading">{t('preset.radiusHeading')}</h2></div>
      <div className={css.gridFive}>{RADII.map(option => <ChoiceCard key={option}
        label={t(`preset.radius.${option}.label`)} description={t(`preset.radius.${option}.description`)}
        selected={state.corners === option
          || (state.corners === 'compact' && option === '0.25')
          || (state.corners === 'standard' && option === '0.75')
          || (state.corners === 'soft' && option === '1')}
        onSelect={() => { setCorners(option) }}>
        <span className={css.radiusPreview} style={{ '--preview-radius': RADIUS_VALUES[option] } as CSSProperties}><span /></span>
      </ChoiceCard>)}</div>
    </section>

    <section className={`${css.group} ${css.motionGroup}`} aria-labelledby="appearance-motion-heading">
      <div className={css.groupHeading}><h2 id="appearance-motion-heading">{t('preset.motionHeading')}</h2></div>
      <Menu open={motionMenuOpen} portal autoFocus align="end" className={css.motionMenu}
        listClassName={css.motionMenuList} selectedId={String(state.glideDuration)}
        items={GLIDE_DURATIONS.map(value => ({ id: String(value), label: t(`preset.motion.${value}`) }))}
        onClose={() => { setMotionMenuOpen(false) }}
        onSelect={(value) => {
          setGlideDuration(Number(value) as GlideDuration)
          setMotionMenuOpen(false)
        }}
        anchor={<button type="button" className={css.motionSelector} aria-label={t('preset.motionPreview')}
          aria-haspopup="menu" aria-expanded={motionMenuOpen} onClick={() => { setMotionMenuOpen(open => !open) }}>
          <span>{t(`preset.motion.${state.glideDuration}`)}</span>
          <IconChevronDownOutlineRegular className={css.motionSelectorChevron} size={14} />
        </button>}
      />
    </section>
  </div>
}
