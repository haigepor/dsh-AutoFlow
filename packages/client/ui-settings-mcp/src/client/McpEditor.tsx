/** Local form draft; saved credentials use explicit keep markers instead of returned values. */
import { useId, useRef, useState } from 'react'
import { AnimatedCollapse, Button, Input, Menu, Switch, TextArea, IconChevronRightOutlineRegular, IconPlusOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpServerDraft } from '../types.ts'
import type { McpSettingsProps } from './contract.ts'
import css from './McpSettings.module.css'

type Translate = McpSettingsProps['t']
interface SecretRow { id: number; name: string; value: string | null }

/** @param props - one private editor's initial values, operation state, and callbacks. @returns the server form. */
export function McpEditor({ initial, revision, busy, readOnly, creating, onSave, onCancel, t }: {
  initial: McpServerDraft
  revision: string
  busy: boolean
  readOnly: boolean
  creating: boolean
  onSave: (draft: McpServerDraft, enabled: boolean, revision: string) => Promise<boolean>
  onCancel: () => void
  t: Translate
}) {
  const [draft, setDraft] = useState(() => structuredClone(initial))
  const [expectedRevision] = useState(revision)
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState(false)
  const [transportOpen, setTransportOpen] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const advancedId = useId()
  const counter = useRef(0)
  const editedFields = useRef(new Set<string>())
  const rows = (values: Record<string, string | null>): SecretRow[] =>
    Object.entries(values).map(([name, value]) => ({ id: ++counter.current, name, value }))
  const [env, setEnv] = useState(() => rows(initial.env))
  const [headers, setHeaders] = useState(() => rows(initial.headers))
  const locked = busy || readOnly
  const change = <K extends keyof McpServerDraft>(key: K, value: McpServerDraft[K]): void => {
    editedFields.current.add(key)
    setDraft(current => ({ ...current, [key]: value }))
  }
  const secrets = draft.transport === 'stdio' ? env : headers
  const setSecrets = draft.transport === 'stdio' ? setEnv : setHeaders
  const submit = async (): Promise<void> => {
    const names = secrets.map(row => row.name)
    if (names.some(name => !name) || new Set(names).size !== names.length) { setError(true); return }
    setError(false)
    await onSave({
      ...draft, editedFields: [...editedFields.current],
      env: Object.fromEntries(env.map(row => [row.name, row.value])),
      headers: Object.fromEntries(headers.map(row => [row.name, row.value])),
    }, enabled, expectedRevision)
  }
  return <form className={css.editor} onSubmit={(event) => { event.preventDefault(); void submit() }}>
    {readOnly ? <p className={css.notice}>{t('readOnly')}</p> : null}
    <fieldset disabled={locked} className={css.fields}>
      <label className={css.field}>{t('name')}<Input required pattern={'[A-Za-z0-9_\\-]{1,32}'} maxLength={32} value={draft.serverName} onChange={(event) => { change('serverName', event.target.value) }} />
        <span className={css.help}>{t('nameHint')}</span></label>
      <div className={css.field}><span>{t('transport')}</span>
        <Menu open={transportOpen && !locked} onClose={() => { setTransportOpen(false) }} portal autoFocus minWidthFromAnchor
          className={css.selectWrapper} selectedId={draft.transport}
          items={[{ id: 'stdio', label: t('stdio') }, { id: 'streamable-http', label: t('http') }]}
          onSelect={(id) => {
            if (id === 'stdio' || id === 'streamable-http') change('transport', id)
            setTransportOpen(false)
          }} anchor={<Button variant="outline" className={css.transportButton} disabled={locked}
            aria-label={t('transport')} aria-haspopup="menu" aria-expanded={transportOpen && !locked}
            onClick={() => { setTransportOpen(value => !value) }} onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setTransportOpen(true) }
            }}>
            <span>{t(draft.transport === 'stdio' ? 'stdio' : 'http')}</span><IconChevronRightOutlineRegular className={css.transportChevron} size={16} />
          </Button>} />
      </div>
      {draft.transport === 'stdio' ? <>
        <label className={css.field}>{t('command')}<Input required value={draft.command} onChange={(event) => { change('command', event.target.value) }} /></label>
        <label className={css.field}>{t('args')}<TextArea rows={3} spellCheck={false} value={draft.args.join('\n')} onChange={(event) => { change('args', event.target.value === '' ? [] : event.target.value.split('\n')) }} /></label>
        <label className={css.field}>{t('cwd')}<Input value={draft.cwd} onChange={(event) => { change('cwd', event.target.value) }} /></label>
      </> : <label className={css.field}>{t('url')}<Input required type="url" value={draft.url} onChange={(event) => { change('url', event.target.value) }} /></label>}
      <div className={css.secretSection}>
        <h3>{t(draft.transport === 'stdio' ? 'env' : 'headers')}</h3>
        <p className={css.help}>{t('secretHint')}</p>
        {secrets.map(row => <div className={css.secretRow} key={row.id}>
          <Input aria-label={t('key')} value={row.name} onChange={(event) => { setSecrets(current => current.map(item => item.id === row.id ? { ...item, name: event.target.value } : item)) }} />
          <Input aria-label={t('value')} type="password" autoComplete="new-password" value={row.value ?? ''} placeholder={row.value === null ? t('savedSecret') : ''}
            onChange={(event) => {
              setSecrets(current => current.map(item => item.id === row.id ? { ...item, value: event.target.value } : item))
            }} />
          <Button aria-label={t('removeEntry', { name: row.name || t('key') })} onClick={() => { setSecrets(current => current.filter(item => item.id !== row.id)) }}><IconCloseOutlineRegular size={14} /></Button>
        </div>)}
        <Button size="sm" variant="outline" icon={<IconPlusOutlineRegular />} onClick={() => {
          setSecrets(current => [...current, { id: ++counter.current, name: '', value: '' }])
        }}>{t('addEntry')}</Button>
      </div>
    </fieldset>
    <div className={css.advanced}>
      <button type="button" className={css.advancedToggle} aria-expanded={advancedOpen} aria-controls={advancedId}
        disabled={busy} onClick={() => { setAdvancedOpen(value => !value) }}>
        <IconChevronRightOutlineRegular size={16} /><span>{t('advanced')}</span>
      </button>
      <AnimatedCollapse open={advancedOpen} id={advancedId}>
        <fieldset disabled={locked || !advancedOpen} className={`${css.fields} ${css.advancedBody}`}>
          <label className={css.field}>{t('timeout')}<Input type="number" required min={1} max={2147483647} value={draft.toolCallTimeoutMs} onChange={(event) => { change('toolCallTimeoutMs', Number(event.target.value)) }} /></label>
          <div className={css.switchRow}><span>{t('reconnect')}</span><Switch label={t('reconnect')} checked={draft.reconnect.enabled} disabled={locked} onChange={(value) => { change('reconnect', { ...draft.reconnect, enabled: value }) }} /></div>
          {(['initialDelayMs', 'maxDelayMs', 'maxAttempts'] as const).map((key, index) => <label className={css.field} key={key}>{t((['initialDelay', 'maxDelay', 'maxAttempts'] as const)[index] ?? 'maxAttempts')}
            <Input type="number" required min={1} value={draft.reconnect[key]} onChange={(event) => { change('reconnect', { ...draft.reconnect, [key]: Number(event.target.value) }) }} /></label>)}
        </fieldset>
      </AnimatedCollapse>
    </div>
    {creating ? <div className={css.switchRow}><span>{t('startAfterSave')}</span><Switch label={t('startAfterSave')} checked={enabled} disabled={locked} onChange={setEnabled} /></div> : null}
    {error ? <p className={css.error} role="alert">{t('error.invalid-config')}</p> : null}
    <div className={css.formActions}><Button variant="outline" disabled={busy} onClick={onCancel}>{t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={locked} aria-busy={busy}>{t(busy ? 'saving' : 'save')}</Button></div>
  </form>
}
