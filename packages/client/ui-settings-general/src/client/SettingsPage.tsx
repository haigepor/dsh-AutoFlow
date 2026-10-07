/** Full-window Settings page: section navigation and the selected section. */
import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutlineMedium, IconPanelLeftOutlineRegular,
  IconSearchOutlineRegular, IconCloseOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsPageComponentProps, SettingsSearchRow } from './shell-contract.ts'
import { SettingsNavIcon } from './SettingsNavIcon.tsx'
import css from './SettingsPage.module.css'

function sectionGroup(id: string): 'preferences' | 'agent' | 'apps' {
  if (['general', 'appearance-theme', 'account'].includes(id)) return 'preferences'
  if (['models', 'agent-presets'].includes(id)) return 'agent'
  return 'apps'
}

/**
 * Render the settings navigation in the app's main page slot.
 * @param props - Shared settings store, live section ledger, and page slots.
 * @returns The two-column page.
 */
export function SettingsPage({
  renderSlot, useSections, useSearchEntries, useStore, actions, closeSettings, t,
}: SettingsPageComponentProps) {
  const rows = useSections(snapshot => snapshot)
  const entries = useSearchEntries(snapshot => snapshot)
  const activeId = useStore(state => state.activeId)
  // A section can unload while open; the first available section takes its place.
  const active = rows.find(row => row.id === activeId) ?? rows[0]
  const titleId = useId()
  const navId = useId()
  const [collapsed, setCollapsed] = useState(false)
  const [settled, setSettled] = useState(false)
  const wide = !collapsed || !settled
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [target, setTarget] = useState<SettingsSearchRow | null>(null)
  const [displayed, setDisplayed] = useState(active?.id)
  const [leaving, setLeaving] = useState(false)
  const shown = rows.find(row => row.id === displayed) ?? active
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  const results = [
    ...entries.filter(entry => rows.some(row => row.id === entry.sectionId)),
    ...rows.map(row => ({ id: `page.${row.id}`, sectionId: row.id, label: row.label })),
  ].filter(entry => terms.every(term => `${entry.label} ${rows.find(row => row.id === entry.sectionId)?.label ?? ''}`.toLocaleLowerCase().includes(term)))
  const windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  const [pointerInside, setPointerInside] = useState(false)
  const quietTimer = useRef<number | undefined>(undefined)
  const toggleLabel = t(collapsed ? 'sidebar.expand' : 'sidebar.collapse')
  const selectedRef = useRef<HTMLButtonElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    (selectedRef.current ?? backRef.current)?.focus({ preventScroll: true })
  }, [])

  useEffect(() => () => { window.clearTimeout(quietTimer.current) }, [])

  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, 150)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])

  useEffect(() => {
    if (active?.id === displayed) { setLeaving(false); return }
    // 与参考项目一致，旧页先退场；只挂载选中的表单，避免隐藏页触发读取或写入。
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    setLeaving(!reduceMotion)
    const timer = window.setTimeout(() => {
      setDisplayed(active?.id)
      setLeaving(false)
      if (scrollRef.current) scrollRef.current.scrollTop = 0
    }, reduceMotion ? 0 : 175)
    return () => { window.clearTimeout(timer) }
  }, [active?.id, displayed])

  useEffect(() => {
    if (target === null || target.sectionId !== shown?.id || leaving) return
    const body = bodyRef.current
    if (body === null) return
    let highlighted: HTMLElement | null = null
    let previousTabIndex: string | null = null
    let found = false
    const locate = (): void => {
      if (found) return
      const element = target.target === undefined
        ? [...body.querySelectorAll<HTMLElement>('h1,h2,h3,label,button,div,span')]
          .filter(node => node.textContent.trim() === target.label).at(-1)
        : body.querySelector<HTMLElement>(target.target)
      if (element === undefined || element === null) return
      found = true
      highlighted = element
      previousTabIndex = element.getAttribute('tabindex')
      element.setAttribute('tabindex', '-1')
      element.setAttribute('data-settings-found', 'true')
      element.scrollIntoView({ block: 'center', behavior: 'auto' })
      element.focus({ preventScroll: true })
    }
    const frame = window.requestAnimationFrame(locate)
    const observer = new MutationObserver(locate)
    observer.observe(body, { subtree: true, childList: true })
    const timer = window.setTimeout(() => { setTarget(null) }, 2200)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.clearTimeout(timer)
      if (highlighted !== null) {
        highlighted.removeAttribute('data-settings-found')
        if (previousTabIndex === null) highlighted.removeAttribute('tabindex')
        else highlighted.setAttribute('tabindex', previousTabIndex)
      }
    }
  }, [target, shown?.id, leaving])

  const selectResult = (entry: SettingsSearchRow): void => {
    setTarget(entry)
    setQuery('')
    actions.select(entry.sectionId)
  }

  return (
    <div className={clsx(css.page, collapsed && css.collapsed, !wide && css.rail, collapsed && wide && css.fading)}
      data-settings-page data-collapsed={collapsed}>
      <div className={css.navViewport}>
        <nav className={clsx(css.nav, !pointerInside && css.quietBars)} aria-labelledby={titleId}
          onPointerEnter={() => { window.clearTimeout(quietTimer.current); setPointerInside(true) }}
          onPointerLeave={() => { quietTimer.current = window.setTimeout(() => { setPointerInside(false) }, 2000) }}>
          <span id={titleId} className={css.srOnly}>{renderSlot('settings.header', {})}</span>
          <div className={css.navTop} data-window-drag>
            <button ref={backRef} type="button" className={css.back} aria-label={t('back')} title={collapsed ? t('back') : undefined} onClick={() => { closeSettings(true) }}>
              <IconChevronLeftOutlineMedium size={16} />
              <span key={wide ? 'wide' : 'rail'} className={clsx(css.backLabel, wide && css.wide)}>{renderSlot('settings.close', {})}</span>
            </button>
            <Tooltip label={toggleLabel} side="right">
              <button type="button" className={css.toggle} aria-label={toggleLabel} aria-expanded={!collapsed}
                aria-controls={navId} onClick={() => { setCollapsed(value => !value) }}>
                {/* 与主页侧栏一致：普通收起轨道用 18px，Windows 顶栏始终用 16px。 */}
                <IconPanelLeftOutlineRegular size={collapsed && !windowsTitlebar ? 18 : 16} />
              </button>
            </Tooltip>
          </div>
          {wide ? <div className={clsx(css.searchBox, css.wide)}>
            <IconSearchOutlineRegular size={16} />
            <input ref={searchRef} type="search" aria-label={t('search.label')} placeholder={t('search.placeholder')}
              value={query} onChange={(event) => { setQuery(event.target.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query !== '') { event.stopPropagation(); setQuery('') }
                if (event.key === 'Enter' && terms.length > 0 && results[0] !== undefined) { event.preventDefault(); selectResult(results[0]) }
              }} />
            {query !== '' && <button type="button" aria-label={t('search.clear')} onClick={() => { setQuery(''); searchRef.current?.focus() }}><IconCloseOutlineRegular size={14} /></button>}
          </div> : <Tooltip label={t('search.label')} side="right"><button type="button" className={css.searchRail} aria-label={t('search.label')} onClick={() => {
            setCollapsed(false)
            window.requestAnimationFrame(() => { searchRef.current?.focus() })
          }}><IconSearchOutlineRegular size={18} /></button></Tooltip>}
          <div id={navId} className={css.navList}>
            {wide && terms.length > 0 ? <div className={css.searchResults} aria-label={t('search.results')}>
              <p className={css.searchStatus} role="status">{results.length === 0 ? t('search.empty') : t('search.count', { count: results.length })}</p>
              {results.map(entry => <button key={entry.id} type="button" className={css.result}
                aria-label={`${entry.label} ${rows.find(row => row.id === entry.sectionId)?.label ?? ''}`} onClick={() => { selectResult(entry) }}>
                <span>{entry.label}</span><small>{rows.find(row => row.id === entry.sectionId)?.label}</small>
              </button>)}
            </div> : (['preferences', 'agent', 'apps'] as const).map((group) => {
              const groupRows = rows.filter(row => sectionGroup(row.id) === group)
              if (groupRows.length === 0) return null
              return <div key={group} className={css.navGroup}>
                {wide && <h2 className={clsx(css.groupTitle, css.wide)}>{t(`group.${group}`)}<span aria-hidden="true">{groupRows.length}</span></h2>}
                {groupRows.map(row => (
                  <Tooltip key={row.id} label={row.label} side="right" disabled={!collapsed}>
                    <button ref={row.id === active?.id ? selectedRef : undefined}
                      data-settings-nav-row
                      type="button" className={clsx(css.navCell, row.id === active?.id && css.active)}
                      aria-label={row.label}
                      aria-current={row.id === active?.id ? 'page' : undefined}
                      onClick={() => { actions.select(row.id) }}>
                      <span className={css.navGlyph} aria-hidden="true"><SettingsNavIcon id={row.id} /></span>
                      {wide && <span className={clsx(css.navLabel, css.wide)}>{row.label}</span>}
                    </button>
                  </Tooltip>
                ))}
              </div>
            })}
          </div>
        </nav>
      </div>
      <section className={css.content} aria-label={shown?.label ?? t('title')}>
        <div ref={scrollRef} className={css.options} data-settings-section={shown?.id}
          style={{ paddingInlineStart: 'var(--dsh-settings-inset-start)', paddingInlineEnd: 'var(--dsh-settings-inset-end)', paddingBlockStart: 'var(--dsh-settings-inset-top)' }}>
          <div key={shown?.id} ref={bodyRef} className={clsx(css.optionBody, leaving && css.leaving)}>
            {shown !== undefined && renderSlot('settings.section', { close: () => { closeSettings(false) } }, { only: shown.id })}
          </div>
        </div>
      </section>
    </div>
  )
}
