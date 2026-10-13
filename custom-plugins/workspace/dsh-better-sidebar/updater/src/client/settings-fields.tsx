/** Companion-owned controls consume the live descriptor data without depending on upstream CSS hashes. */
import { useState, type ComponentProps, type ReactNode } from 'react'
import { Button, Input, Menu, Switch, IconChevronDownOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsBody as UpstreamBody } from '../../../src/client/SideCardSection.tsx'
import type { SidebarSettingToggle } from '../../../src/client/service.ts'
import { t } from '../../../src/client/locales.ts'
import { OpenWithSettings } from './open-with-settings.tsx'
import css from './settings-fields.module.css'

const text = (value: string | (() => string) | undefined) => typeof value === 'function' ? value() : value ?? ''
const icon = (value: ReactNode | ((size: number) => ReactNode), size: number) => typeof value === 'function' ? value(size) : value
type BodyProps = ComponentProps<typeof UpstreamBody>

function Row({ title, description, children, stack = false }: { title: string; description?: string; children: ReactNode; stack?: boolean }) {
  return <div className={stack ? css.stack : css.row}>
    <div className={css.copy}><span className={css.title}>{title}</span>{description && <span className={css.description}>{description}</span>}</div>
    {children}
  </div>
}

/** Render single and multiple selections through the shared keyboard-accessible Menu. */
export function SettingsSelect({ toggle, value, onChange }: { toggle: SidebarSettingToggle; value: unknown; onChange: (value: unknown) => void }) {
  const [open, setOpen] = useState(false)
  const options = toggle.options ?? []
  const picked = toggle.multi ? Array.isArray(value) ? value : [] : [value]
  const selected = options.filter(option => picked.includes(option.value))
  return <Menu open={open} portal autoFocus listClassName={css.menu}
    anchor={<Button variant="outline" aria-label={text(toggle.title)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {!toggle.multi && selected[0]?.icon && icon(selected[0].icon, 14)}
      <span className={css.selection}>{selected.map(option => text(option.title)).join(', ') || toggle.placeholder || '—'}</span>
      <IconChevronDownOutlineRegular size={12} />
    </Button>}
    items={options.map((option, index) => ({ id: String(index), icon: icon(option.icon, 14), label: <span className={css.option}>
      <span>{text(option.title)}</span>{option.desc && <span className={css.description}>{text(option.desc)}</span>}
    </span> }))}
    selectedId={!toggle.multi && selected[0] ? String(options.indexOf(selected[0])) : undefined}
    selectedIds={toggle.multi ? selected.map(option => String(options.indexOf(option))) : undefined}
    onClose={() => setOpen(false)} onSelect={id => {
      const option = options[Number(id)]
      if (!option) return
      if (!toggle.multi) { onChange(option.value); setOpen(false); return }
      const next = picked.includes(option.value) ? picked.filter(item => item !== option.value) : [...picked, option.value]
      onChange(options.filter(item => next.includes(item.value)).map(item => item.value))
    }} />
}

function TypedField({ toggle, value, onCommit }: { toggle: SidebarSettingToggle; value: string; onCommit: BodyProps['onCommit'] }) {
  const [draft, setDraft] = useState(value)
  return <span className={css.control}><Input className={toggle.type === 'number' ? css.number : css.input}
    type={toggle.type === 'number' ? 'number' : 'text'} value={draft} aria-label={text(toggle.title)}
    min={toggle.min} max={toggle.max} step={1} placeholder={toggle.placeholder}
    onChange={event => setDraft(event.currentTarget.value)} onBlur={() => setDraft(onCommit(toggle, draft))}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} />
    {toggle.unit && <span className={css.description}>{toggle.unit}</span>}
  </span>
}

function Patterns({ toggle, value, onChange }: { toggle: SidebarSettingToggle; value: unknown; onChange: (value: string[]) => void }) {
  const [draft, setDraft] = useState('')
  const patterns = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const add = () => { const next = draft.trim(); if (next && !patterns.includes(next)) onChange([...patterns, next]); setDraft('') }
  return <><div className={css.chips}>{patterns.map((pattern, index) => <span className={css.chip} key={`${index}:${pattern}`}>
    <span>{pattern}</span><Button variant="ghost" size="sm" aria-label={`${t('explorerExcludeRemove')} ${pattern}`} onClick={() => onChange(patterns.filter((_, at) => at !== index))}><IconCloseOutlineRegular size={12} /></Button>
  </span>)}</div><div className={css.control}><Input className={css.grow} value={draft} aria-label={text(toggle.title)}
    placeholder={toggle.patternsPlaceholder ?? toggle.placeholder} spellCheck={false} onChange={event => setDraft(event.currentTarget.value)}
    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add() } }} />
    <Button variant="outline" onClick={add}>{t('explorerExcludeAdd')}</Button></div></>
}

/** Keep arbitrary extension renderers; only the built-in editor has a local form adapter. */
export function SettingsBody(props: BodyProps & { editor?: boolean }) {
  const { feature, prefs } = props
  const pluginSettings = prefs.pluginSettings[feature.id] ?? {}
  const rows = (toggles: readonly SidebarSettingToggle[], plugin: boolean) => toggles.map(toggle => {
    const value: unknown = plugin ? pluginSettings[toggle.key] : Reflect.get(prefs, toggle.key)
    const select = plugin ? props.onPluginSelectValue : props.onSelectValue
    const commit = plugin ? props.onPluginCommit : props.onCommit
    const title = text(toggle.title)
    let control: ReactNode
    if (toggle.type === 'select') control = <SettingsSelect toggle={toggle} value={value} onChange={next => select(toggle, next)} />
    else if (toggle.type === 'patterns') control = <Patterns toggle={toggle} value={value} onChange={next => (plugin ? props.onPluginPatterns : props.onPatterns)(toggle, next)} />
    else if (toggle.type === 'text' || toggle.type === 'number') control = <TypedField key={`${toggle.key}:${String(value)}`} toggle={toggle} value={String(value ?? '')} onCommit={commit} />
    else control = <Switch label={title} checked={value === true} onChange={next => (plugin ? props.onPluginToggle : props.onToggle)(toggle, next)} />
    return <Row key={toggle.key} title={title} description={text(toggle.desc)} stack={toggle.type === 'patterns'}>{control}</Row>
  })
  let custom: ReactNode
  if (props.editor && feature.settings?.render) custom = <OpenWithSettings pluginSettings={pluginSettings} updatePluginSetting={props.onPluginWrite} />
  else if (feature.settings?.render) {
    try { custom = feature.settings.render({ store: props.store, service: props.service, prefs, pluginSettings, updatePluginSetting: props.onPluginWrite, close: props.onClose }) }
    catch (error) { custom = <div role="alert">{t('settingsSaveFailed')} {error instanceof Error ? error.message : String(error)}</div> }
  }
  return <div className={css.fields}>{rows(feature.settings?.toggles ?? [], false)}{rows(feature.settings?.pluginToggles ?? [], true)}{custom}</div>
}
