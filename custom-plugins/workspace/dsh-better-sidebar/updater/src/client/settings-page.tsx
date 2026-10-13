/** Local settings presentation, bundled with the companion so official sidebar updates cannot replace it. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, Switch, IconPlusOutlineRegular, IconChevronRightOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SideCardSectionProps } from '../../../src/client/SideCardSection.tsx'
import { SettingsBody } from './settings-fields.tsx'
import { PluginListBody, type PluginKind } from './plugin-catalog.tsx'
import { api } from '../../../src/client/api.ts'
import { parsePrefs, type SidebarPrefs } from '../../../src/client/prefs.ts'
import { t as upstreamT } from '../../../src/client/locales.ts'
import type { TabDescriptor, FileViewerDescriptor, SidebarSettingToggle } from '../../../src/client/service.ts'
import { createPreferences } from './preferences.js'
import { settingsIcon } from './settings-icons.tsx'
import { CssCodeEditor } from './css-code-editor.tsx'
import { SettingsDialog } from './settings-dialog.tsx'
import styles from './settings-page.css'

type Feature = TabDescriptor | FileViewerDescriptor
type Translate = (key: string) => string
type Patch = (prefs: SidebarPrefs) => Partial<SidebarPrefs>
type View = { prefs: SidebarPrefs; ready: boolean; loading: boolean; pending: number; error: string | null }
const drafts = new WeakMap<SideCardSectionProps['store'], string>()
const text = (value: string | (() => string) | undefined) => typeof value === 'function' ? value() : value ?? ''
const title = (feature: Feature) => text(feature.title) || feature.id
const configured = (feature: Feature) => Boolean(feature.settings?.render || feature.settings?.toggles?.length || feature.settings?.pluginToggles?.length)

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (value: boolean) => void }) {
  return <Switch className="bs-settings-switch" checked={checked} disabled={disabled} label={label} onChange={onChange} />
}

/** Keep the draft across settings navigation; only an acknowledged save clears it. */
function CssEditor({ value, store, write, disabled, t }: { value: string; store: SideCardSectionProps['store']; write: (patch: Patch) => Promise<boolean>; disabled: boolean; t: Translate }) {
  const [draft, setDraft] = useState(() => drafts.get(store) ?? value)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const dirty = draft !== value
  useEffect(() => { if (!drafts.has(store)) setDraft(value) }, [value, store])
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  return <details className="bs-settings-advanced">
    <summary><IconChevronRightOutlineRegular size={16} /><span>{t('settingsAppearance')}</span><small>{t(dirty ? 'settingsUnsaved' : value ? 'settingsConfigured' : 'settingsNotConfigured')}</small></summary>
    <div className="bs-settings-css-body">
      <label id="bs-settings-css-label" htmlFor="bs-settings-css">{t('settingsCss')}</label>
      <p>{t('settingsCssHint')}</p>
      <CssCodeEditor value={draft} disabled={saving} onChange={value => { setDraft(value); drafts.set(store, value); setFailed(false) }} />
      <div className="bs-settings-css-actions">
        <span role="status">{t(failed ? 'settingsDraftFailed' : dirty ? 'settingsDraftKept' : 'settingsCssApplied')}</span>
        <Button className="bs-settings-outline" variant="outline" disabled={!dirty || saving} onClick={() => { drafts.delete(store); setDraft(value); setFailed(false) }}>{t('settingsDiscard')}</Button>
        <Button variant="primary" disabled={!dirty || disabled || saving} onClick={async () => {
          setSaving(true)
          const ok = await write(() => ({ customCss: draft }))
          if (ok) drafts.delete(store)
          setFailed(!ok); setSaving(false)
        }}>{t(saving ? 'settingsSaving' : 'settingsApply')}</Button>
      </div>
    </div>
  </details>
}

/** Render dynamic upstream descriptors through the original injected store and service. */
export function SidebarSettingsPage({ store, service, t }: SideCardSectionProps & { t: Translate }) {
  const [view, setView] = useState<View>(() => ({ prefs: store.getPrefs(), ready: false, loading: true, pending: 0, error: null }))
  const writer = useRef<ReturnType<typeof createPreferences> | null>(null)
  const [registryVersion, setRegistryVersion] = useState(0)
  const [settingsFor, setSettingsFor] = useState<{ kind: PluginKind; id: string } | null>(null)
  const [add, setAdd] = useState<PluginKind | null>(null)
  useEffect(() => {
    const controller = createPreferences(api, store, parsePrefs, setView)
    writer.current = controller
    void controller.load()
    return () => { controller.dispose(); writer.current = null }
  }, [store])
  useEffect(() => service.subscribe(() => setRegistryVersion(value => value + 1)), [service])
  const tabs = [...service.getTabs()].sort((a, b) => Number(Boolean(a.hidden)) - Number(Boolean(b.hidden)) || (a.order ?? 100) - (b.order ?? 100))
  const viewers = [...service.getFileViewers()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
  const feature = settingsFor ? (settingsFor.kind === 'tab' ? tabs : viewers).find(item => item.id === settingsFor.id) : undefined
  useEffect(() => { if (settingsFor && !feature) setSettingsFor(null) }, [registryVersion, feature, settingsFor])
  const { prefs } = view
  const write = (patch: Patch): Promise<boolean> => writer.current?.write(patch) ?? Promise.resolve(false)
  const pref = (key: string, value: unknown) => { void write(current => ({ [key]: value })) }
  const pluginPref = (key: string, value: unknown) => { if (feature) void write(current => ({ pluginSettings: { ...current.pluginSettings, [feature.id]: { ...current.pluginSettings[feature.id], [key]: value } } })) }
  const commit = (toggle: SidebarSettingToggle, raw: string, plugin = false) => {
    let value: string | number = raw
    if (toggle.type === 'number') {
      if (!Number.isFinite(Number(raw))) return String(plugin && feature ? prefs.pluginSettings[feature.id]?.[toggle.key] ?? '' : Reflect.get(prefs, toggle.key) ?? '')
      value = Math.round(Number(raw))
      if (toggle.min !== undefined) value = Math.max(toggle.min, value)
      if (toggle.max !== undefined) value = Math.min(toggle.max, value)
    }
    if (plugin) pluginPref(toggle.key, value); else pref(toggle.key, value)
    return String(value)
  }
  const row = (item: Feature, kind: PluginKind) => {
    const map = kind === 'tab' ? 'tabsEnabled' : 'viewersEnabled'
    const enabled = prefs[map][item.id] !== false
    const name = kind === 'tab' && item.id === 'diff' ? t('settingsDiffTitle') : title(item)
    const icon: ReactNode = settingsIcon(kind, item.id) ?? (typeof item.icon === 'function' ? item.icon(18) : item.icon)
    const desc = kind === 'viewer' && 'exts' in item ? item.exts.join(' · ') || t('settingsOtherFiles')
      : kind === 'tab' && ['git', 'diff', 'editor', 'terminal-bottom', 'subagent', 'sidechat'].includes(item.id) ? t(`settingsDesc_${item.id}`)
        : text('description' in item ? item.description : undefined)
    return <div className="bs-settings-feature" key={item.id} data-enabled={enabled}>
      <span className="bs-settings-icon" aria-hidden="true">{icon}</span>
      <div className="bs-settings-feature-copy"><span className="bs-settings-title">{name}</span><span className="bs-settings-description">{desc}</span></div>
      <div className="bs-settings-feature-actions">
        {kind === 'tab' && 'hidden' in item && item.hidden && <small className="bs-settings-on-demand">{t('settingsOnDemand')}</small>}
        {configured(item) && <Button variant="outline" className="bs-settings-outline bs-settings-configure" aria-label={`${name} ${t('settingsConfigure')}`} onClick={() => setSettingsFor({ kind, id: item.id })}>{t('settingsConfigure')}</Button>}
        <Toggle label={name} checked={enabled} disabled={!view.ready} onChange={next => { void write(current => ({ [map]: { ...current[map], [item.id]: next } })) }} />
      </div>
    </div>
  }
  const behavior = (key: 'agentOpenTools' | 'mobileNoAutoOpen' | 'mobileDefaultTree', label: string, description: string) => <div className="bs-settings-behavior-row">
    <div className="bs-settings-feature-copy"><span className="bs-settings-title">{label}</span><span className="bs-settings-description">{description}</span></div>
    <Toggle label={label} checked={prefs[key]} disabled={!view.ready} onChange={value => pref(key, value)} />
  </div>
  return <div className="bs-settings" data-better-sidebar-settings="local">
    <style>{styles}</style>
    <header className="bs-settings-header">
      <h1>{t('settingsPageTitle')}</h1>
      <div className="bs-settings-header-meta"><span className="bs-settings-version">v{service.version}</span><span className="bs-settings-save-state" role="status">{view.error ? '' : t(view.loading ? 'settingsLoading' : view.pending ? 'settingsSaving' : 'settingsAutoSave')}</span></div>
    </header>
    {view.error && <div className="bs-settings-feedback" role="alert"><span>{t('settingsSaveFailed')}</span><Button size="sm" variant="outline" disabled={view.loading || view.pending > 0} onClick={() => { void writer.current?.load() }}>{t('settingsReload')}</Button></div>}
    <section className="bs-settings-section" aria-label={t('settingsTabs')}>
      <div className="bs-settings-heading"><h2>{t('settingsTabs')} <small>{tabs.length}</small></h2><Button className="bs-settings-outline" variant="outline" onClick={() => setAdd('tab')}>{t('settingsAdd')}</Button></div>
      <div className="bs-settings-list">{tabs.map(item => row(item, 'tab'))}</div>
    </section>
    <section className="bs-settings-section" aria-label={t('settingsViewers')}>
      <div className="bs-settings-heading"><h2>{t('settingsViewers')} <small>{viewers.length}</small></h2><Button className="bs-settings-outline" variant="outline" onClick={() => setAdd('viewer')}>{t('settingsAdd')}</Button></div>
      <div className="bs-settings-list">{viewers.map(item => row(item, 'viewer'))}</div>
    </section>
    <section className="bs-settings-section" aria-label={t('settingsBehavior')}>
      <div className="bs-settings-heading"><h2>{t('settingsBehavior')}</h2></div>
      {behavior('agentOpenTools', t('settingsAgent'), t('settingsAgentHint'))}
      <h4>{t('settingsNarrow')}</h4>
      {behavior('mobileNoAutoOpen', upstreamT('settingsMobileNoAutoOpenTitle'), upstreamT('settingsMobileNoAutoOpenDesc'))}
      {behavior('mobileDefaultTree', upstreamT('settingsMobileTreeTitle'), upstreamT('settingsMobileTreeDesc'))}
    </section>
    <CssEditor value={prefs.customCss} store={store} write={write} disabled={!view.ready} t={t} />
    {feature && settingsFor && <SettingsDialog onClose={() => setSettingsFor(null)} title={title(feature)} description={t('settingsFeatureHint')}
      icon={settingsIcon(settingsFor.kind, feature.id)} closeLabel={upstreamT('close')} doneLabel={upstreamT('settingsDone')}
      feedback={t(view.error ? 'settingsSaveFailed' : view.pending ? 'settingsSaving' : 'settingsAutoSave')} error={Boolean(view.error)}>
      <SettingsBody editor={settingsFor.kind === 'tab' && feature.id === 'editor'} feature={feature} prefs={prefs} store={store} service={service}
        onToggle={(toggle, value) => pref(toggle.key, value)} onCommit={(toggle, raw) => commit(toggle, raw)} onSelectValue={(toggle, value) => pref(toggle.key, value)} onPatterns={(toggle, value) => pref(toggle.key, value)}
        onPluginToggle={(toggle, value) => pluginPref(toggle.key, value)} onPluginCommit={(toggle, raw) => commit(toggle, raw, true)} onPluginSelectValue={(toggle, value) => pluginPref(toggle.key, value)} onPluginPatterns={(toggle, value) => pluginPref(toggle.key, value)} onPluginWrite={pluginPref} onClose={() => setSettingsFor(null)} />
    </SettingsDialog>}
    {add && <SettingsDialog catalog onClose={() => setAdd(null)} title={upstreamT(add === 'tab' ? 'addPluginsTabCard' : 'addPluginsViewerCard')}
      description={t('settingsCatalogHint')} icon={<IconPlusOutlineRegular size={20} />} closeLabel={upstreamT('close')} doneLabel={upstreamT('settingsDone')}>
      <PluginListBody service={service} kind={add} />
    </SettingsDialog>}
  </div>
}
