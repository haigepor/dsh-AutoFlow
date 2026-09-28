/** Full-window Settings page: section navigation and the selected section. */
import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconAgentPresetOutlineMedium, IconArchiveOutlineMedium, IconChevronLeftOutlineMedium,
  GlideHighlight, IconDataOutlineMedium, IconPersonalizationOutlineMedium, IconSettingsOutlineMedium,
  IconUserOutlineMedium, IconPanelLeftOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsPageComponentProps } from './shell-contract.ts'
import css from './SettingsPage.module.css'

/** Nav glyph by section id; unknown sections use the settings glyph. */
function navIcon(id: string) {
  if (id === 'account') return <IconUserOutlineMedium size={16} />
  if (id === 'models') return <IconDataOutlineMedium size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutlineMedium size={16} />
  if (id === 'plugins') return <IconPersonalizationOutlineMedium size={16} />
  if (id === 'archived-sessions') return <IconArchiveOutlineMedium size={16} />
  return <IconSettingsOutlineMedium size={16} />
}

/**
 * Render the settings navigation in the app's main page slot.
 * @param props - Shared settings store, live section ledger, and page slots.
 * @returns The two-column page.
 */
export function SettingsPage({ renderSlot, useSections, useStore, actions, closeSettings, t }: SettingsPageComponentProps) {
  const rows = useSections(snapshot => snapshot)
  const activeId = useStore(state => state.activeId)
  // A section can unload while open; the first available section takes its place.
  const active = rows.find(row => row.id === activeId) ?? rows[0]
  const titleId = useId()
  const navId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [pointerInside, setPointerInside] = useState(false)
  const quietTimer = useRef<number | undefined>(undefined)
  const toggleLabel = t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')
  const selectedRef = useRef<HTMLButtonElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    (selectedRef.current ?? backRef.current)?.focus({ preventScroll: true })
  }, [])

  useEffect(() => () => { window.clearTimeout(quietTimer.current) }, [])

  return (
    <div className={clsx(css.page, collapsed && css.collapsed)} data-settings-page data-collapsed={collapsed}>
      <nav className={clsx(css.nav, !pointerInside && css.quietBars)} aria-labelledby={titleId}
        onPointerEnter={() => { window.clearTimeout(quietTimer.current); setPointerInside(true) }}
        onPointerLeave={() => { quietTimer.current = window.setTimeout(() => { setPointerInside(false) }, 2000) }}>
        <span id={titleId} className={css.srOnly}>{renderSlot('settings.header', {})}</span>
        <div className={css.navTop} data-window-drag>
          <button ref={backRef} type="button" className={css.back} aria-label={t('back')} title={collapsed ? t('back') : undefined} onClick={() => { closeSettings(true) }}>
            <IconChevronLeftOutlineMedium size={16} />
            <span className={css.backLabel}>{renderSlot('settings.close', {})}</span>
          </button>
          <Tooltip label={toggleLabel} side="right">
            <button type="button" className={css.toggle} aria-label={toggleLabel} aria-expanded={!collapsed}
              aria-controls={navId} onClick={() => { setCollapsed(value => !value) }}>
              <IconPanelLeftOutlineRegular size={18} />
            </button>
          </Tooltip>
        </div>
        <div id={navId} className={css.navList}>
          <GlideHighlight className={collapsed ? undefined : css.glideHighlight} rowSelector="[data-settings-nav-row]" />
          {rows.map(row => (
            <Tooltip key={row.id} label={row.label} side="right" disabled={!collapsed}>
              <button ref={row.id === active?.id ? selectedRef : undefined}
                data-settings-nav-row
                type="button" className={clsx(css.navCell, row.id === active?.id && css.active)}
                aria-label={row.label}
                aria-current={row.id === active?.id ? 'page' : undefined}
                onClick={() => { actions.select(row.id) }}>
                <span className={css.navGlyph} aria-hidden="true">{navIcon(row.id)}</span>
                <span className={css.navLabel}>{row.label}</span>
              </button>
            </Tooltip>
          ))}
        </div>
      </nav>
      <section className={css.content} aria-label={active?.label ?? t('title')}>
        <div className={css.options} data-settings-section={active?.id}>
          <div className={css.optionBody}>
            {active !== undefined && renderSlot('settings.section', { close: () => { closeSettings(false) } }, { only: active.id })}
            <footer className={css.actions}>{renderSlot('settings.action', {})}</footer>
          </div>
        </div>
      </section>
    </div>
  )
}
