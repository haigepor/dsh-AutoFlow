/** @jsxRuntime classic */
/** @jsx React.createElement */
/** A compact Workspace launch form; execution belongs to the Host and native Session. */
import type { CuratorSnapshot, StyleView } from './contract.ts'
import type { SearchLaunchState, SearchLaunchStore } from './search-launch-store.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createSelectField } from './select-field.tsx'

type LaunchActions = Pick<SearchLaunchStore, 'start' | 'retry' | 'stop' | 'refresh' | 'loadOptions' | 'openSession'>
type LaunchFormActions = LaunchActions & Pick<SearchLaunchStore, 'loadDatasets'>
type LaunchHook = <T>(select: (state: SearchLaunchState) => T) => T

/** @param React Shell React. @param ui Native form, modal and progress primitives. @returns Launch form, inline header entry and complete task summary. */
export function createSearchLaunchUI(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui)
  function failureHint(code: string | undefined, stage: string | undefined, t: WorkbenchText) {
    if (code === 'launch-update-required') return t('searchLaunchUpdateHint')
    if (code === 'preview-source-unsupported') return t('searchLaunchPreviewUnsupported')
    if (stage === 'search-launch-dataset') return t('searchLaunchDatasetRejected')
    if (code === 'invalid-input') return t('searchLaunchInputRejected')
    if (code === 'configuration-required' || code === 'capability-unavailable') return t('searchLaunchConfigHint')
    if (code === 'connection-unavailable') return t('searchLaunchReadFailed')
    return t('searchLaunchRecovery')
  }
  function FailureDetails({ failure, t }: { failure: SearchLaunchState['failure']; t: WorkbenchText }) {
    const [open, setOpen] = React.useState(false)
    if (!failure) return null
    return <ui.DisclosureRow className="vc-search-launch-diagnostics" icon={<ui.IconCodeOutlineRegular size={14} />} title={t('searchLaunchFailureDetails')} open={open} expandable expandOnRowClick onToggle={() => setOpen(value => !value)}>
      <dl><div><dt>{t('searchLaunchFailureStage')}</dt><dd><code>{[failure.stage, failure.code].filter(Boolean).join(' · ')}</code></dd></div><div><dt>{t('searchLaunchFailureDetails')}</dt><dd>{failure.safeMessage}</dd></div><div><dt>{t('searchLaunchFailureAction')}</dt><dd>{failure.suggestedAction}</dd></div></dl>
    </ui.DisclosureRow>
  }
  function Background({ useLaunches, actions, t, inline = false }: { useLaunches: LaunchHook; actions: LaunchActions; t: WorkbenchText; inline?: boolean }) {
    const [menuOpen, setMenuOpen] = React.useState(false)
    const state = useLaunches(value => value), entry = state.submission ? state.entries.find(item => item.id === state.submission!.input.operationId) : state.entries[0]
    if (!entry && !state.submission) return null
    const stopped = entry?.status === 'stopped', unknown = state.submission?.status === 'unknown'
    const launchFailed = entry?.status === 'failed' || state.submission?.status === 'rejected', runNeedsAttention = !stopped && !launchFailed && !!entry?.runStatus && ['failed', 'interrupted', 'paused'].includes(entry.runStatus)
    const failed = launchFailed || runNeedsAttention
    const preparing = !failed && !stopped && !unknown && (!entry || entry.status === 'working')
    const active = preparing || !stopped && !!entry?.runStatus && ['created', 'running', 'pausing', 'cancelling'].includes(entry.runStatus)
    const progress = entry?.runIds.length ? { completed: entry.qualified, total: entry.input.targetCount } : undefined
    const target = entry?.input.targetCount ?? state.submission?.input.targetCount
    const success = !stopped && !failed && entry?.runStatus === 'completed' && entry.qualified >= entry.input.targetCount
    const partial = !stopped && entry?.runStatus === 'completed' && entry.qualified < entry.input.targetCount
    const error = !stopped && (launchFailed || entry?.runStatus === 'failed' || !!entry?.stopping && failed)
    const attention = unknown || runNeedsAttention || partial
    const badgeKey = entry?.stopping ? failed ? 'searchLaunchBadgeStopFailed' : 'searchLaunchBadgeStopping'
      : launchFailed ? 'failed' : runNeedsAttention && entry?.runStatus ? entry.runStatus
        : stopped ? 'searchLaunchBadgeStopped' : unknown ? 'searchLaunchBadgeUnknown' : preparing ? 'searchLaunchBadgePreparing'
          : entry?.runStatus === 'completed' ? partial ? 'searchLaunchBadgePartial' : 'completed' : entry?.runIds.length ? entry.runStatus ?? 'searchLaunchBadgePlanning' : 'searchLaunchBadgePlanning'
    const errorCode = state.error || entry?.error?.code || state.submission?.error
    const failure = state.error ? state.failure : entry?.error ?? state.submission?.failure
    const hint = unknown ? t('searchLaunchUnknownHint') : launchFailed || state.error ? failureHint(errorCode, failure?.stage, t) : runNeedsAttention ? t('searchLaunchTaskAttention') : preparing ? t('searchLaunchBackground') : !progress && !stopped ? t('searchLaunchPlanning') : undefined
    const dotState = error ? 'error' : active ? 'ongoing' : success ? 'done' : attention ? 'warning' : 'idle'
    const count = target === undefined ? '' : progress ? `${progress.completed} / ${progress.total}` : `${target}`
    const summary = <section className="vc-search-launch-status" data-task-status={entry?.status ?? state.submission?.status} data-active={active} role="status" aria-live="polite">
      <div className="vc-search-launch-overview">
        <span className="vc-search-launch-icon" aria-hidden="true"><ui.IconSearchOutlineRegular size={18} /></span>
        <div className="vc-search-launch-copy">
          <div className="vc-search-launch-heading"><strong>{t('searchKind')}</strong><ui.Tag className="vc-search-launch-badge" tone={error ? 'danger' : success ? 'success' : attention ? 'warning' : active ? 'info' : 'neutral'}><ui.StateDot state={dotState} />{t(badgeKey)}</ui.Tag></div>
          {hint && <p className="vc-search-launch-notice">{hint}{errorCode && <code>{errorCode}</code>}</p>}
          {!stopped && failure && <FailureDetails failure={failure} t={t} />}
          {entry?.directory && (inline ? <div className="vc-search-launch-output"><span>{t('taskDeliveryReady')}</span><small className="vc-search-launch-directory">{entry.directory}</small></div> : <details className="vc-search-launch-output"><summary>{t('taskDeliveryReady')}</summary><small className="vc-search-launch-directory">{entry.directory}</small></details>)}
        </div>
      </div>
      {target !== undefined && <div className="vc-search-launch-metric">
        <div><span>{t(progress ? entry?.input.output.kind === 'preview' ? 'taskPreviewMatched' : 'searchLaunchQualified' : 'targetCountLabel')}</span><strong>{progress ? progress.completed : target}{progress && <small> / {progress.total}</small>}</strong></div>
        {progress && active && <div className="vc-search-launch-progress" role="progressbar" aria-label={t('searchLaunchProgress')} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={Math.min(progress.completed, progress.total)}><span style={{ width: `${Math.min(100, progress.completed / progress.total * 100)}%` }} /></div>}
      </div>}
      <div className="vc-search-launch-card-actions">
        {entry && entry.stage !== 'preparing' && entry.stage !== 'creating-session' && <ui.Button size="sm" variant="outline" role={inline ? 'menuitem' : undefined} onClick={() => { setMenuOpen(false); actions.openSession(entry.sessionId) }}>{t('searchLaunchOpen')}</ui.Button>}
        {(launchFailed || unknown) && <ui.Button size="sm" variant="outline" role={inline ? 'menuitem' : undefined} onClick={() => { setMenuOpen(false); if (entry) void actions.retry(entry.id); else if (state.submission) void actions.start(state.submission.input) }}>{t('searchLaunchContinue')}</ui.Button>}
        {entry && !stopped && <ui.Button size="sm" variant="ghost" role={inline ? 'menuitem' : undefined} disabled={entry.stopping} onClick={() => { setMenuOpen(false); void actions.stop(entry.id) }}>{t('searchLaunchStop')}</ui.Button>}
      </div>
    </section>
    if (!inline) return summary
    return <ui.Menu className="vc-search-launch-inline" listClassName="vc-search-launch-menu" portal compact autoFocus open={menuOpen} onClose={() => setMenuOpen(false)}
      anchor={<ui.Button size="sm" variant="ghost" className="vc-search-launch-trigger" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label={[t('searchKind'), t(badgeKey), count && `${t(progress ? entry?.input.output.kind === 'preview' ? 'taskPreviewMatched' : 'searchLaunchQualified' : 'targetCountLabel')} ${count}`].filter(Boolean).join(' · ')}
        onClick={() => setMenuOpen(value => !value)} onKeyDown={event => { if (!menuOpen && event.key === 'ArrowDown') { event.preventDefault(); setMenuOpen(true) } }}>
        <ui.StateDot state={dotState} /><span className="vc-search-launch-trigger-label">{t('searchKind')}</span><span className="vc-search-launch-trigger-state" aria-live="polite">{t(badgeKey)}</span>{count && <small>{count}</small>}<ui.IconChevronDownOutlineRegular size={12} />
      </ui.Button>}>{summary}</ui.Menu>
  }
  function Dialog({ open, onClose, onDatasets, style, snapshot, useLaunches, actions, t }: { open: boolean; onClose(): void; onDatasets?(id?: string): void; style: StyleView; snapshot: CuratorSnapshot; useLaunches: LaunchHook; actions: LaunchFormActions; t: WorkbenchText }) {
    const state = useLaunches(value => value), retainedEntry = state.entries.find(item => item.status === 'working' || item.status === 'failed'), retained = state.submission?.input ?? retainedEntry?.input
    const [workspaceId, setWorkspace] = React.useState(retained?.workspaceId ?? ''), [brief, setBrief] = React.useState(retained?.taskBrief ?? t('searchLaunchDefaultBrief').replace('{name}', style.name))
    const [datasetId, setDataset] = React.useState<string>(retained?.datasetId ?? (state.submission ? '' : retainedEntry?.datasetId) ?? '')
    const [quantity, setQuantity] = React.useState(retained?.targetCount ?? Math.min(10, snapshot.configuration.limits.maxCandidates)), [output, setOutput] = React.useState<string>(retained?.output.kind ?? 'preview'), [usageId, setUsage] = React.useState(retained?.output.kind === 'usage' ? retained.output.usageRevisionId : snapshot.usages[0]?.usageRevisionId ?? '')
    const operationId = React.useRef(retained?.operationId ?? crypto.randomUUID()), opened = React.useRef(false)
    const usages = state.options?.usages ?? snapshot.usages
    const selected = state.entries.find(item => item.id === operationId.current), pending = state.submission?.input.operationId === operationId.current ? state.submission : null
    const locked = !!pending && pending.status !== 'rejected' || !!selected && selected.status !== 'stopped'
    const profileId = locked ? selected?.input.modelProfileId ?? pending?.input.modelProfileId ?? '' : style.modelProfile?.id ?? ''
    const datasetOptions = state.datasetOptions?.modelProfileId === profileId ? state.datasetOptions : undefined
    const frozenDatasetId = selected?.datasetId ?? selected?.input.datasetId ?? pending?.input.datasetId
    const dataset = datasetOptions?.entries.find(item => item.exportId === (locked ? frozenDatasetId ?? datasetId : datasetId))
    const datasetLoading = !!profileId && (!datasetOptions || datasetOptions.loading)
    React.useEffect(() => { void actions.loadOptions(); void actions.refresh() }, [actions])
    React.useEffect(() => { if (open && profileId) void actions.loadDatasets(profileId) }, [actions, open, profileId])
    React.useEffect(() => { if (!workspaceId && state.options?.workspaces.length) setWorkspace(state.options.workspaces[0]!.id) }, [state.options, workspaceId])
    React.useEffect(() => { if (!usageId && usages.length) setUsage(usages[0]!.usageRevisionId) }, [usages, usageId])
    React.useEffect(() => { if (selected?.status === 'accepted' && !opened.current) { opened.current = true; if (actions.openSession(selected.sessionId)) onClose() } }, [selected?.status, selected?.sessionId, actions, onClose])
    const start = () => {
      if (pending && pending.status !== 'rejected') { void actions.start(pending.input); return }
      if (selected && selected.status !== 'stopped') { void actions.retry(selected.id); return }
      if (!style.modelProfile || !dataset?.exportId || datasetLoading || datasetOptions?.error) return
      if (pending?.status === 'rejected' || selected?.status === 'stopped') operationId.current = crypto.randomUUID()
      void actions.start({ operationId: operationId.current, workspaceId, modelProfileId: style.modelProfile.id, datasetId: dataset.exportId, taskBrief: brief, targetCount: quantity, output: output === 'preview' ? { kind: 'preview' } : output === 'original' ? { kind: 'original' } : { kind: 'usage', usageRevisionId: usageId } })
    }
    const workspace = state.options?.workspaces.find(item => item.id === workspaceId), usage = usages.find(item => item.usageRevisionId === usageId)
    const incompatible = !!state.options && (state.options.datasetSelection !== 'required' && (!locked || !!(selected?.input.datasetId ?? pending?.input.datasetId)) || output === 'preview' && state.options.previewSearch === undefined)
    const previewUnsupported = output === 'preview' && state.options?.previewSearch === false
    const failure = pending?.error ? pending.failure : selected?.status === 'failed' ? selected.error : state.failure
    const errorCode = incompatible ? 'launch-update-required' : previewUnsupported ? 'preview-source-unsupported' : pending?.error || (selected?.status === 'failed' ? selected.error?.code : undefined) || state.error
    const unknown = pending?.status === 'unknown', preparing = pending?.status === 'submitting' || selected?.status === 'working'
    const failed = !!errorCode || selected?.status === 'failed', feedback = failed || unknown || preparing
    const refresh = () => { void actions.loadOptions(); void actions.refresh(); if (profileId) void actions.loadDatasets(profileId) }
    const invalid = !locked && (!workspace || !brief.trim() || !Number.isInteger(quantity) || quantity < 1 || quantity > (state.options?.maxTargetCount ?? snapshot.configuration.limits.maxCandidates) || output === 'usage' && !usage || !style.modelProfile || style.modelProfile.stale || !dataset?.exportId || datasetLoading || !!datasetOptions?.error)
    return <ui.Modal open={open} onClose={onClose} title={t('searchLaunchTitle')} closeLabel={t('close')} className="vc-search-launch-modal" contentClassName="vc-search-launch-content" footer={<div className="vc-search-launch-footer"><p className="vc-search-launch-hint">{t(output === 'preview' ? 'searchLaunchPreviewHint' : 'searchLaunchAutoHint')}</p><div className="vc-task-footer"><ui.Button variant="outline" onClick={onClose}>{t('close')}</ui.Button><ui.Button variant="primary" disabled={preparing || incompatible || previewUnsupported || invalid} onClick={start}>{preparing && <ui.StateDot state="ongoing" />}{t(unknown || selected?.status === 'failed' ? 'searchLaunchContinue' : 'startTask')}</ui.Button></div></div>}>
      <div className="vc-search-launch-form"><div className="vc-search-launch-summary"><ui.IconSparkleRegular size={16} /><strong>{style.name}</strong>{dataset ? <ui.Tag>v{dataset.profileRevision}</ui.Tag> : !locked && style.modelProfile ? <ui.Tag>v{style.modelProfile.revision}</ui.Tag> : null}</div>
      {feedback && <section className="vc-search-launch-feedback" role={failed ? 'alert' : 'status'}>
        <div className="vc-search-launch-feedback-heading"><ui.StateDot state={failed ? 'error' : unknown ? 'warning' : 'ongoing'} /><strong>{t(errorCode === 'launch-update-required' ? 'searchLaunchUpdateRequired' : unknown ? 'searchLaunchBadgeUnknown' : failed ? 'searchLaunchFailureTitle' : selected?.stopping ? 'searchLaunchBadgeStopping' : 'searchLaunchBadgePreparing')}</strong></div>
        <p>{errorCode === 'launch-update-required' ? t('searchLaunchUpdateHint') : unknown ? t('searchLaunchUnknownHint') : failed ? failureHint(errorCode, failure?.stage, t) : t('searchLaunchBackground')}</p>
        {errorCode !== 'launch-update-required' && <FailureDetails failure={failure} t={t} />}
        <div className="vc-search-launch-feedback-actions"><ui.Button size="sm" variant="ghost" disabled={state.optionsLoading || state.loading} onClick={refresh}><ui.IconRefreshOutlineRegular size={14} />{t('searchLaunchReadAgain')}</ui.Button>{selected && selected.stage !== 'preparing' && selected.stage !== 'creating-session' && <ui.Button size="sm" variant="outline" onClick={() => { if (actions.openSession(selected.sessionId)) onClose() }}>{t('searchLaunchOpen')}</ui.Button>}{selected && selected.status !== 'stopped' && <ui.Button size="sm" variant="ghost" disabled={selected.stopping} onClick={() => { void actions.stop(selected.id) }}>{t('searchLaunchStop')}</ui.Button>}</div>
      </section>}
      <section className="vc-search-launch-section" aria-label={t('searchLaunchSource')}><h3>{t('searchLaunchSource')}</h3>
      <div className="vc-search-launch-field vc-search-launch-dataset">
        <div className="vc-search-launch-field-heading"><span>{t('searchLaunchDataset')} <span aria-hidden="true">*</span></span>{!locked && <ui.Button size="sm" variant="ghost" disabled={datasetLoading} onClick={() => { void actions.loadDatasets(profileId) }}><ui.IconRefreshOutlineRegular size={14} />{t('refresh')}</ui.Button>}</div>
        {locked ? <div className="vc-search-launch-fixed"><ui.StateDot state={frozenDatasetId ? 'done' : 'ongoing'} /><div><span>{t('searchLaunchDatasetFixed')}</span>{frozenDatasetId && <small>{frozenDatasetId}</small>}</div></div>
          : datasetLoading && !datasetOptions?.entries.length ? <span className="vc-skeleton-fill vc-search-launch-skeleton" aria-busy="true" />
            : <SelectField label={t('searchLaunchDatasetRequired')} value={datasetId} options={[{ value: '', label: t('searchLaunchDatasetChoose') }, ...(datasetOptions?.entries ?? []).map(item => ({ value: item.exportId!, label: `${item.name} · v${item.profileRevision} · ${new Date(item.createdAt).toLocaleString()}` }))]} disabled={datasetLoading || !datasetOptions?.entries.length} onChange={setDataset} />}
        {!locked && (!dataset || datasetOptions?.error) && <small role={datasetOptions?.error ? 'alert' : undefined}>{datasetOptions?.error ? t('searchLaunchDatasetLoadFailed') : !datasetLoading && !datasetOptions?.entries.length ? t('searchLaunchDatasetEmpty') : t('searchLaunchDatasetHint')}</small>}
        <div className="vc-search-launch-dataset-meta">{dataset && <small>{t('searchLaunchDatasetSummary').replace('{references}', String(dataset.counts.references)).replace('{rules}', String(dataset.counts.rules))}</small>}<div className="vc-search-launch-dataset-actions">
          {datasetOptions?.pageToken && datasetOptions.entries.length < datasetOptions.total && <ui.Button size="sm" variant="ghost" disabled={datasetLoading} onClick={() => { void actions.loadDatasets(profileId, true) }}>{t('searchLaunchDatasetMore')}</ui.Button>}
          {dataset && <ui.Button size="sm" variant="ghost" disabled={!onDatasets} onClick={() => onDatasets?.(dataset.id)}>{t('searchLaunchDatasetView')}</ui.Button>}
          {!locked && <ui.Button size="sm" variant="ghost" disabled={!onDatasets} onClick={() => onDatasets?.()}>{t('searchLaunchDatasetGenerate')}</ui.Button>}
        </div></div>
      </div>
      <label className="vc-search-launch-field"><span>{t('searchLaunchWorkspace')}</span>{state.optionsLoading && !state.options ? <span className="vc-skeleton-fill vc-search-launch-skeleton" aria-busy="true" /> : <SelectField label={t('searchLaunchWorkspace')} value={workspaceId} options={(state.options?.workspaces ?? []).map(item => ({ value: item.id, label: item.title }))} disabled={locked || !state.options?.workspaces.length} onChange={setWorkspace} />}<small>{workspace?.path ?? t('searchLaunchNoWorkspace')}</small></label>
      </section><section className="vc-search-launch-section" aria-label={t('searchLaunchRequirements')}><h3>{t('searchLaunchRequirements')}</h3>
      <label className="vc-search-launch-field"><span>{t('taskBriefLabel')}</span><ui.TextArea data-modal-autofocus rows={2} maxLength={4000} value={brief} disabled={locked} onChange={event => setBrief(event.target.value)} /></label>
      <div className="vc-search-launch-grid"><label className="vc-search-launch-field"><span>{t('targetCountLabel')}</span><ui.Input type="number" min={1} max={state.options?.maxTargetCount ?? snapshot.configuration.limits.maxCandidates} value={quantity} disabled={locked} onChange={event => setQuantity(Number(event.target.value))} /></label><label className="vc-search-launch-field"><span>{t('searchLaunchOutput')}</span><SelectField label={t('searchLaunchOutput')} value={output} disabled={locked} options={[{ value: 'preview', label: t('searchLaunchPreview') }, { value: 'original', label: t('searchLaunchOriginal') }, { value: 'usage', label: t('searchLaunchSized') }]} onChange={setOutput} /></label></div>
      {output === 'usage' && <div className="vc-search-launch-field"><span>{t('usageLabel')}</span><SelectField label={t('usageLabel')} value={usageId} disabled={locked || !usages.length} options={usages.map(item => ({ value: item.usageRevisionId, label: `${item.name} · ${item.targetWidth} × ${item.targetHeight}` }))} onChange={setUsage} />{state.options?.usagePageToken && <ui.Button size="sm" disabled={state.optionsLoading} onClick={() => { void actions.loadOptions(true) }}>{t('more')}</ui.Button>}{!usage && <small>{t('taskUsageRequired')}</small>}</div>}
      </section></div>
    </ui.Modal>
  }
  return { Dialog, Background }
}
