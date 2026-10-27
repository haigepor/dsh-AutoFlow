/** Redacted MCP JSON viewing, editing, and merge import in the existing modal material. */
import { useState } from 'react'
import { Button, CodeEditor, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpSettingsProps } from './contract.ts'
import { configurationJson, type McpJsonSnapshot, type McpJsonSaveResult } from './configuration-json.ts'
import { McpSkeleton } from './McpSkeleton.tsx'
import css from './McpSettings.module.css'

type Props = Pick<McpSettingsProps, 't' | 'useResource' | 'useStore' | 'saveJson'> & { onClose: () => void }

function JsonForm({ snapshot, t, busy, saveJson, onClose, onReload }: Pick<Props, 't' | 'saveJson' | 'onClose'> & {
  snapshot: McpJsonSnapshot
  busy: boolean
  onReload: () => void
}) {
  const [original] = useState(snapshot)
  const [source, setSource] = useState(() => configurationJson(snapshot))
  const [error, setError] = useState<Extract<McpJsonSaveResult, { ok: false }> | null>(null)
  const format = (): void => {
    try {
      const value: unknown = JSON.parse(source)
      setSource(JSON.stringify(value, null, 2)); setError(null)
    } catch (_invalidJson) { setError({ ok: false, error: 'invalid-json', partial: false }) }
  }
  return <form className={css.jsonForm} onSubmit={(event) => {
    event.preventDefault()
    void saveJson(source, original).then((result) => { if (result.ok) onClose(); else setError(result) })
  }}>
    <p className={css.help}>{t('jsonHint')}</p>
    <div className={css.jsonToolbar}><span>{t('jsonLanguage')}</span><div>
      <Button size="sm" variant="outline" disabled={busy} onClick={onReload}>{t('reloadEditor')}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={format}>{t('jsonFormat')}</Button>
    </div></div>
    <CodeEditor language="json" value={source} label={t('jsonEditor')} disabled={busy} onChange={setSource} />
    {error === null ? null : <p className={css.error} role="alert">
      {error.partial ? `${t('jsonPartial')} ` : ''}{t(error.error === 'invalid-json' ? 'jsonInvalid' : `error.${error.error}`)}
    </p>}
    <div className={css.formActions}><Button variant="outline" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
      <Button variant="primary" type="submit" disabled={busy} aria-busy={busy}>{t(busy ? 'saving' : 'save')}</Button></div>
  </form>
}

/**
 * Present JSON configuration without replacing an active edit on resource refresh.
 * @param props - resource and mutation shares plus close intent.
 * @returns the JSON dialog with stable editor-open revisions.
 */
export function McpJsonDialog({ t, useResource, useStore, saveJson, onClose }: Props) {
  const [readCycle, setReadCycle] = useState(false)
  // Alternate two addresses so explicit reload waits for fresh data without accumulating cache records.
  const configuration = useResource<'mcp-configuration'>(`dsh-resource://mcp-configuration/profile?read=${readCycle ? 1 : 0}`)
  const busy = useStore(state => state.busy) !== null
  return <Modal open title={t('jsonTitle')} description={t('jsonDescription')} closeLabel={t('close')}
    className={`${css.jsonDialog}`} closeOnBackdropClick={false} onClose={() => { if (!busy) onClose() }}>
    {configuration.status === 'failed' ? <p className={css.error} role="alert">{t('loadFailed')}
      <Button size="sm" onClick={() => { setReadCycle(value => !value) }}>{t('retry')}</Button></p> : null}
    {configuration.value !== undefined ? <JsonForm key={readCycle ? '1' : '0'} snapshot={configuration.value} t={t} busy={busy}
      saveJson={saveJson} onClose={onClose} onReload={() => { setReadCycle(value => !value) }} />
      : configuration.status !== 'failed' ? <div role="status" aria-label={t('loading')}><McpSkeleton detail /></div> : null}
  </Modal>
}
