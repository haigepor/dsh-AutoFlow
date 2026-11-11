/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Explicit server imports retain separate original, processing and transmission progress. */
import { z } from 'zod'
import { serverQueueSettingsSchema, serverQueueViewSchema, type ServerQueueView } from '../shared/server-queue.ts'
import type { DirectCropInvoke } from './direct-crop.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { createSelectField } from './select-field.tsx'

const manualCredentialPrefix = 'VISUAL_CURATOR_SERVER_MANUAL_'

/** @param React Host runtime. @param ui Existing controls. @returns Server connection and queue dialog. */
export function createServerQueue(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Modal, Input, TextArea, Checkbox, Tag, StateDot } = ui
  const SelectField = createSelectField(React, ui)
  function ServerPreview({ src, t }: { src?: string | undefined; t: WorkbenchText }) {
    const [status, setStatus] = React.useState<'loading' | 'loaded' | 'failed'>(src ? 'loading' : 'failed')
    return <span className="vc-server-preview-placeholder" aria-busy={status === 'loading'} title={status === 'failed' ? t('galleryPreviewError') : undefined}>
      {src && <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" data-loaded={status === 'loaded' || undefined} onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} />}
      {status === 'loading' ? <span className="vc-skeleton-fill" role="status" aria-label={t('galleryPreviewLoading')} /> : status === 'failed' ? <ui.IconBrowseOutlineRegular size={22} /> : null}
    </span>
  }
  return function ServerQueue({ ready, invoke, saveCredential, t, pollMs, limit, onClose, onStarted }: { ready: boolean; invoke: DirectCropInvoke; saveCredential(ref: string, value: string): Promise<void>; t: WorkbenchText; pollMs: number; limit: number; onClose(): void; onStarted(runId: string): void }) {
    const [view, setView] = React.useState<ServerQueueView>(), [settings, setSettings] = React.useState(() => serverQueueSettingsSchema.parse({})), [origins, setOrigins] = React.useState('')
    const [authSource, setAuthSource] = React.useState<'manual' | 'postman' | 'credential'>('credential'), [manualToken, setManualToken] = React.useState(''), [tokenWritten, setTokenWritten] = React.useState(false)
    const [postmanPath, setPostmanPath] = React.useState(''), [credentialName, setCredentialName] = React.useState('VISUAL_CURATOR_SERVER_TOKEN')
    const manualRef = React.useRef(manualCredentialPrefix + crypto.randomUUID().replaceAll('-', '_'))
    const keepManualToken = tokenWritten || view?.settings.auth.kind === 'credential' && view.settings.auth.ref === manualRef.current
    const [filter,setFilter]=React.useState('pending')
    const [selected, setSelected] = React.useState(new Set<string>()), [pending, setPending] = React.useState<string>(), [error, setError] = React.useState(''), [notice, setNotice] = React.useState(''), [settingsOpen, setSettingsOpen] = React.useState(false)
    const busy = pending !== undefined, tableLoading = pending === 'server-queue-pull' || (!view && !error)
    const lifetime = React.useRef(new AbortController()), loaded = React.useRef(false), admission = React.useRef<{ selection: string; operationId: string; name: string }>()
    const alive = React.useRef(true), version = React.useRef(0), id = React.useId()
    const restoreSettings = (value: ServerQueueView['settings']) => {
      setSettings(value); setOrigins(value.allowedMediaOrigins.join('\n')); setManualToken(''); setTokenWritten(false)
      if (value.auth.kind === 'postman') { setAuthSource('postman'); setPostmanPath(value.auth.path) }
      else if (value.auth.ref.startsWith(manualCredentialPrefix)) { manualRef.current = value.auth.ref; setAuthSource('manual') }
      else { setAuthSource('credential'); setCredentialName(value.auth.ref) }
    }
    const errorText = (failure: unknown) => { const issue = z.object({ code: z.string().optional(), stage: z.string().optional() }).safeParse(failure); return t(issue.success && issue.data.stage === 'server-auth' ? 'serverAuthError' : issue.success && issue.data.code === 'source-protocol-error' ? 'serverProtocolError' : 'serverError') }
    React.useEffect(() => {
      const controller = new AbortController(); lifetime.current = controller; alive.current = true
      let timer: ReturnType<typeof setTimeout> | undefined
      const read = async () => {
        const started = version.current
        try {
          if (document.hidden || controller.signal.aborted) return
          const value = serverQueueViewSchema.parse(await invoke('server-queue-read', {}, controller.signal))
          if (controller.signal.aborted || started !== version.current) return
          setView(value)
          if (!loaded.current) { restoreSettings(value.settings); setSettingsOpen(!value.settings.baseUrl); loaded.current = true }
        } catch (failure) { if (!controller.signal.aborted && started === version.current) setError(errorText(failure)) }
        finally { if (!controller.signal.aborted) timer = setTimeout(() => { void read() }, pollMs) }
      }
      void read()
      return () => { alive.current = false; controller.abort(); clearTimeout(timer) }
    }, [invoke, pollMs, t])
    const act = async (operation: string, args: Parameters<DirectCropInvoke>[1]) => {
      if (busy) return
      version.current++; setPending(operation); setError(''); setNotice('')
      try {
        if (operation === 'server-queue-configure' && authSource === 'manual' && manualToken.trim()) {
          try { await saveCredential(manualRef.current, manualToken.trim()) }
          catch (failure) { if (alive.current) setError(t('serverTokenSaveError')); return }
          if (!alive.current) return
          setManualToken(''); setTokenWritten(true)
        }
        const result = await invoke(operation, args, lifetime.current.signal)
        if (!alive.current) return
        if (operation === 'server-queue-start') onStarted(z.object({ runId: z.string() }).parse(result).runId)
        else { const value = serverQueueViewSchema.parse(result); setView(value); if (operation === 'server-queue-configure') { restoreSettings(value.settings); setSettingsOpen(false); setNotice(t('serverSavedNotice')) } else if (operation === 'server-queue-pull') { setSelected(new Set()); setNotice(t('serverPullNotice')) } else if (operation === 'server-queue-recheck') setNotice(t(value.items.find(item => item.id === args.id)?.transfer?.status === 'uploaded' ? 'serverReceiptConfirmed' : 'serverReceiptPending')) }
      } catch (failure) { if (alive.current) { setError(errorText(failure)) } }
      finally { if (alive.current) { version.current++; setPending(undefined) } }
    }
    const openSettings = () => {
      if (view) restoreSettings(view.settings)
      setError(''); setSettingsOpen(true)
    }
    const closeSettings = () => { if (!busy) { setSettingsOpen(false); setError(''); setManualToken('') } }
    const save = () => {
      if (authSource === 'manual' && (!manualToken.trim() && !keepManualToken || /[\r\n\0]/.test(manualToken))) { setError(t('serverTokenRequired')); return }
      const auth = authSource === 'postman' ? { kind: 'postman', path: postmanPath.trim() } : { kind: 'credential', ref: authSource === 'manual' ? manualRef.current : credentialName.trim() }
      const parsed = serverQueueSettingsSchema.safeParse({ ...settings, auth, allowedMediaOrigins: origins.split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean) })
      if (!parsed.success) { setError(t('serverError')); return }
      void act('server-queue-configure', parsed.data)
    }
    const start = () => {
      const ids = [...selected].filter(id=>eligible.some(item=>item.id===id)), value = JSON.stringify({ snapshotId: view?.snapshotId, ids })
      if (admission.current?.selection !== value) admission.current = { selection: value, operationId: 'server-crop:' + crypto.randomUUID(), name: t('serverNameDefault') + ' ' + new Date().toLocaleString() }
      void act('server-queue-start', { operationId: admission.current.operationId, snapshotId: view!.snapshotId, ids, name: admission.current.name })
    }
    const label = (phase: ServerQueueView['items'][number]['phase']) => t(({ waiting: 'serverWaiting', downloading: 'serverDownloading', saved: 'serverSaved', processing: 'serverActive', attention: 'serverAttention', approved: 'serverApproved' } as const)[phase])
    const transferLabel = (status: NonNullable<ServerQueueView['items'][number]['transfer']>['status']) => t(({ waiting: 'serverNoTransfer', uploading: 'serverUploading', uploaded: 'serverUploaded', failed: 'serverUploadFailed', unknown: 'serverUnknown' } as const)[status])
    const matches = (item: ServerQueueView['items'][number], value:string) => value==='all'||value==='pending'&&item.serverPending===true||value==='active'&&!!item.importRunId||value==='active'&&['processing','downloading'].includes(item.phase)||value==='approved'&&item.phase==='approved'||value==='uploaded'&&item.transfer?.status==='uploaded'||value==='unknown'&&item.transfer?.status==='unknown'
    const visible = view?.items.filter(item=>matches(item,filter))??[]
    const eligible = visible.filter(item=>item.serverPending===true&&!item.runId&&!item.importRunId&&item.transfer?.status!=='uploaded'&&item.transfer?.status!=='unknown')
    React.useEffect(()=>{setSelected(current=>{const ids=new Set<string>(eligible.map(item=>item.id)),next=new Set([...current].filter(id=>ids.has(id)));return next.size===current.size?current:next})},[view,filter])
    return <><Modal open onClose={onClose} title={t('serverQueue')} closeLabel={t('close')} className="vc-server-modal" contentClassName="vc-server-content" footer={<div className="vc-server-footer"><div role="status"><strong>{t('serverSelected').replace('{count}', String(selected.size))}</strong></div><div><Button variant="outline" onClick={onClose}>{t(busy ? 'cancel' : 'close')}</Button><Button variant="primary" disabled={busy || !ready || !selected.size || selected.size > limit || !view?.snapshotId} onClick={start}>{pending === 'server-queue-start' && <StateDot state="ongoing" />}{t('serverStart')}</Button></div></div>}>
      <div className="vc-server-main"><div className="vc-server-top"><div className="vc-server-connection"><StateDot state={view?.settings.baseUrl ? 'done' : 'idle'} /><div><strong>{t(view?.settings.baseUrl ? 'serverConnected' : 'serverNotConnected')}</strong><small title={view?.settings.baseUrl}>{view?.settings.baseUrl || t('serverConfigureHint')}</small></div></div><div className="vc-server-top-actions"><Button size="sm" variant="outline" disabled={busy} onClick={openSettings}>{t('serverSettings')}</Button><Button size="sm" variant="primary" disabled={busy || !view?.settings.baseUrl} onClick={() => { void act('server-queue-pull', {}) }}>{t('serverPull')}</Button><span>{view && t('serverTotal').replace('{loaded}', String(view.items.length)).replace('{total}', String(view.total))}</span></div></div>
      {!ready && <p className="vc-server-receipt-hint">{t('directCropModelRequired')}</p>}
      <div className="vc-server-metrics">{([{ label: 'serverPending', count: view?.total ?? 0 }, { label: 'serverActive', count: view?.items.filter(item => item.phase === 'processing' || item.phase === 'downloading').length ?? 0 }, { label: 'serverApproved', count: view?.items.filter(item => item.phase === 'approved').length ?? 0 }, { label: 'serverUploaded', count: view?.items.filter(item => item.transfer?.status === 'uploaded' && item.transfer.current !== false).length ?? 0 }] as const).map(metric => <div key={metric.label}><span>{t(metric.label)}</span><strong>{metric.count}</strong></div>)}</div>
      {notice && <div className="vc-server-notice" role="status"><StateDot state="done" />{notice}</div>}{error && !settingsOpen && <div className="vc-server-error" role="alert"><StateDot state="error" /><div><strong>{error}</strong><p>{t('serverErrorHint')}</p></div><Button size="sm" variant="outline" disabled={busy} onClick={openSettings}>{t('serverCheckConnection')}</Button></div>}
      <div className="vc-server-filters" role="group" aria-label={t('serverFilter')}>
      {([{id:'all',label:'serverFilterAll'},{id:'pending',label:'serverPending'},{id:'active',label:'serverActive'},{id:'approved',label:'serverApproved'},{id:'uploaded',label:'serverUploaded'},{id:'unknown',label:'serverUnknown'}] as const).map(option=><Button key={option.id} size="sm" variant={filter===option.id?'outline':'ghost'} aria-pressed={filter===option.id} onClick={()=>{setFilter(option.id);setSelected(new Set())}}>{t(option.label)} <small>{view?.items.filter(item=>matches(item,option.id)).length??0}</small></Button>)}</div>
      {filter==='pending'&&view&&!view.pendingKnown&&<p className="vc-server-receipt-hint">{t('serverPendingRefresh')}</p>}
      {!tableLoading && !visible.length ? <div className="vc-server-empty"><span><ui.IconFolderOpenOutlineRegular size={28} /></span><h3>{t('serverEmpty')}</h3><p>{t(view?.settings.baseUrl ? 'serverEmptyHint' : 'serverConfigureHint')}</p></div> : <div className="vc-server-table-scroll"><table className="vc-server-table" aria-busy={tableLoading || undefined} aria-label={t(tableLoading ? 'galleryLoading' : 'serverQueue')}><colgroup><col className="vc-server-col-check" /><col /><col className="vc-server-col-processing" /><col className="vc-server-col-transfer" /><col className="vc-server-col-actions" /></colgroup><thead><tr><th><Checkbox className="vc-direct-row-checkbox" label={t('serverSelectAll')} checked={eligible.length > 0 && eligible.every(item => selected.has(item.id))} disabled={busy || !eligible.length || eligible.length > limit} onChange={checked => setSelected(checked ? new Set(eligible.map(item => item.id)) : new Set())} /></th><th>{t('serverName')}</th><th>{t('serverProcessing')}</th><th>{t('serverTransmission')}</th><th className="vc-server-actions-heading">{t('serverActions')}</th></tr></thead><tbody>{tableLoading ? ['loading-a', 'loading-b', 'loading-c', 'loading-d', 'loading-e', 'loading-f'].map(key => <tr key={key} aria-hidden="true"><td><span className="vc-skeleton-fill vc-server-skeleton-check" /></td><td><div className="vc-server-file"><span className="vc-skeleton-fill vc-server-skeleton-preview" /><span className="vc-server-skeleton-meta"><span className="vc-skeleton-fill vc-skeleton-title" /><span className="vc-skeleton-fill vc-skeleton-short" /></span></div></td><td><span className="vc-skeleton-fill vc-skeleton-short" /></td><td><span className="vc-skeleton-fill vc-skeleton-title" /></td><td><span className="vc-skeleton-fill vc-server-skeleton-action" /></td></tr>) : visible.map(item => <tr key={item.id} data-selected={selected.has(item.id) || undefined}><td><Checkbox className="vc-direct-row-checkbox" label={t('serverSelect') + ' ' + item.id} checked={selected.has(item.id)} disabled={busy || !eligible.some(row=>row.id===item.id)} onChange={checked => setSelected(previous => { const next = new Set(previous); if (checked) next.add(item.id); else next.delete(item.id); return next })} /></td><td><div className="vc-server-file"><ServerPreview key={item.previewPath ?? item.id} src={item.previewPath} t={t} /><span title={item.name}>{item.name}<small>{item.id}</small>{item.warning && <small className="vc-server-record-warning">{t('serverRecordChanged')}</small>}</span></div></td><td><Tag tone={item.phase === 'attention' ? 'warning' : 'neutral'}>{label(item.phase)}</Tag>{item.phase === 'downloading' && <small>{Math.round((item.receivedBytes ?? 0) / 1024)} KiB{item.totalBytes ? ' / ' + Math.round(item.totalBytes / 1024) + ' KiB' : ''}</small>}{item.errorCode && <small role="alert">{item.errorCode}</small>}</td><td>{item.transfer ? <><Tag tone={item.transfer.status === 'unknown' || item.transfer.status === 'failed' ? 'warning' : 'neutral'}>{item.transfer.status === 'uploaded' && item.transfer.current === false ? t('serverOldUpload') : transferLabel(item.transfer.status)}</Tag></> : <span className="vc-flow-muted">{t('serverNoTransfer')}</span>}</td><td><div className="vc-server-row-actions">{(item.runId || item.importRunId) && <Button size="sm" variant="outline" disabled={busy} onClick={() => onStarted((item.runId || item.importRunId)!)}>{t('serverOpenFlow')}</Button>}{item.transfer?.status === 'failed' && item.runId && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act('server-queue-retry', { runId: item.runId!, id: item.id }) }}>{t('serverRetry')}</Button>}{item.transfer?.status === 'unknown' && item.runId && <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void act('server-queue-recheck', { runId: item.runId!, id: item.id }) }}>{t('serverRecheck')}</Button>}{!item.runId && !item.importRunId && <span className="vc-flow-muted">—</span>}</div></td></tr>)}</tbody></table></div>}
      {view?.items.some(item => item.transfer?.status === 'unknown') && <p className="vc-server-receipt-hint">{t('serverReceiptHint')}</p>}</div>
    </Modal><Modal open={settingsOpen} onClose={closeSettings} title={t('serverSettings')} closeLabel={t('close')} className="vc-server-settings-modal" contentClassName="vc-server-settings-content" footer={<><Button variant="outline" disabled={busy} onClick={closeSettings}>{t('cancel')}</Button><Button variant="primary" disabled={busy} onClick={save}>{pending === 'server-queue-configure' && <StateDot state="ongoing" />}{t('serverSave')}</Button></>}>
      <div className="vc-server-settings"><label htmlFor={id + '-origin'}>{t('serverOrigin')}<Input id={id + '-origin'} data-modal-autofocus disabled={busy} value={settings.baseUrl} onChange={event => { const baseUrl = event.currentTarget.value; setSettings(value => ({ ...value, baseUrl })) }} /></label><div className="vc-server-settings-field"><span>{t('serverAuth')}</span><SelectField label={t('serverAuth')} value={authSource} disabled={busy} matchAnchorWidth options={[{ value: 'manual', label: t('serverManualToken') }, { value: 'postman', label: t('serverPostman') }, { value: 'credential', label: t('serverCredential') }]} onChange={kind => { setAuthSource(kind === 'postman' ? 'postman' : kind === 'manual' ? 'manual' : 'credential'); setManualToken(''); setError('') }} /></div>
      {authSource === 'manual' ? <label className="vc-server-settings-wide" htmlFor={id + '-token'}>{t('serverToken')}<Input id={id + '-token'} type="password" autoComplete="new-password" spellCheck={false} disabled={busy} value={manualToken} placeholder={t(keepManualToken ? 'serverTokenKeep' : 'serverTokenPlaceholder')} onChange={event => setManualToken(event.currentTarget.value)} /><small>{t('serverTokenHint')}</small></label> : <label className="vc-server-settings-wide" htmlFor={id + '-auth-value'}>{t(authSource === 'postman' ? 'serverAuthPath' : 'serverAuthRef')}<Input id={id + '-auth-value'} disabled={busy} spellCheck={false} value={authSource === 'postman' ? postmanPath : credentialName} onChange={event => { const text = event.currentTarget.value; if (authSource === 'postman') setPostmanPath(text); else setCredentialName(text) }} />{authSource === 'postman' && <small>{t('serverPostmanPathHint')}</small>}</label>}<label className="vc-server-settings-wide" htmlFor={id + '-media'}>{t('serverMediaOrigins')}<TextArea id={id + '-media'} disabled={busy} rows={3} spellCheck={false} value={origins} onChange={event => setOrigins(event.currentTarget.value)} /></label><Checkbox className="vc-server-settings-wide vc-server-settings-checkbox" label={t('serverLocalApi')} checked={settings.allowPrivateApi} disabled={busy} onChange={checked => setSettings(value => ({ ...value, allowPrivateApi: checked }))} /></div>
      {error && <p className="vc-server-settings-error" role="alert">{error}</p>}
    </Modal></>
  }
}
