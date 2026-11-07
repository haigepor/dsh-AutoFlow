/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Workspace launch requirements; execution belongs to the Host and native Session. */
import type { CuratorSnapshot, StyleView } from './contract.ts'
import type { SearchLaunchState, SearchLaunchStore } from './search-launch-store.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { createSelectField } from './select-field.tsx'
import { visionModelKey } from './vision-models.ts'

type LaunchActions = Pick<SearchLaunchStore, 'start' | 'retry' | 'stop' | 'refresh' | 'loadOptions' | 'openSession'>
type LaunchFormActions = LaunchActions & Pick<SearchLaunchStore, 'loadDatasets'>
type LaunchHook = <T>(select: (state: SearchLaunchState) => T) => T

/** @param React Shell React. @param ui Native form, modal and progress primitives. @returns Launch form, inline header entry and complete task summary. */
export function createSearchLaunchUI(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui)
  function failureHint(code: string | undefined, stage: string | undefined, t: WorkbenchText) {
    if (code === 'reference-unavailable' && stage === 'search-launch') return t('searchLaunchWorkspaceUnavailable')
    if (code === 'launch-update-required') return t('searchLaunchUpdateHint')
    if (code === 'preview-source-unsupported') return t('searchLaunchPreviewUnsupported')
    if (stage === 'search-launch-dataset') return t('searchLaunchDatasetRejected')
    if (stage === 'search-launch-negatives') return t('searchLaunchNegativesFailed')
    if (stage === 'search-launch-model') return t('searchLaunchModelUnavailable')
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
    const canStop = !!entry && (entry.status === 'working' || !!entry.stopping || [entry.runStatus, entry.wallpaper?.status].some(status => ['created', 'running', 'pausing', 'cancelling'].includes(status ?? '')))
    const stopped = entry?.status === 'stopped', unknown = state.submission?.status === 'unknown'
    const wallpaper = entry?.input.wallpaper ? entry.wallpaper : undefined
    const wallpaperPending = !!entry?.input.wallpaper && entry.runStatus === 'completed' && entry.qualified > 0 && !wallpaper
    const executionStatus = wallpaper?.status ?? entry?.runStatus
    const launchFailed = entry?.status === 'failed' || state.submission?.status === 'rejected', runNeedsAttention = !stopped && !launchFailed && !!entry?.runStatus && ['failed', 'interrupted', 'paused'].includes(executionStatus ?? '')
    const failed = launchFailed || runNeedsAttention
    const preparing = !failed && !stopped && !unknown && (!entry || entry.status === 'working')
    const active = preparing || !failed && !stopped && (wallpaperPending || !!executionStatus && ['created', 'running', 'pausing', 'cancelling'].includes(executionStatus))
    const progress = entry?.runIds.length ? { completed: wallpaper?.passed ?? (entry.input.wallpaper ? 0 : entry.qualified), total: wallpaper?.total ?? entry.input.targetCount } : undefined
    const target = entry?.input.targetCount ?? state.submission?.input.targetCount
    const success = !stopped && !failed && !wallpaperPending && executionStatus === 'completed' && (wallpaper ? wallpaper.passed === wallpaper.total && wallpaper.total > 0 : !!entry && !entry.input.wallpaper && entry.qualified >= entry.input.targetCount)
    const partial = !stopped && !wallpaperPending && executionStatus === 'completed' && !success
    const error = !stopped && (launchFailed || executionStatus === 'failed' || !!entry?.stopping && failed)
    const attention = unknown || runNeedsAttention || partial
    const badgeKey = entry?.stopping ? failed ? 'searchLaunchBadgeStopFailed' : 'searchLaunchBadgeStopping'
      : launchFailed ? 'failed' : runNeedsAttention && executionStatus ? executionStatus
        : stopped ? 'searchLaunchBadgeStopped' : unknown ? 'searchLaunchBadgeUnknown' : preparing ? 'searchLaunchBadgePreparing'
          : wallpaperPending ? 'running' : executionStatus === 'completed' ? partial ? 'searchLaunchBadgePartial' : 'completed' : entry?.runIds.length ? executionStatus ?? 'searchLaunchBadgePlanning' : 'searchLaunchBadgePlanning'
    const errorCode = state.error || entry?.error?.code || state.submission?.error
    const failure = state.error ? state.failure : entry?.error ?? state.submission?.failure
    const hint = unknown ? t('searchLaunchUnknownHint') : launchFailed || state.error ? failureHint(errorCode, failure?.stage, t) : runNeedsAttention ? t('searchLaunchTaskAttention') : preparing ? t('searchLaunchBackground') : !progress && !stopped ? t('searchLaunchPlanning') : undefined
    const dotState = error ? 'error' : active ? 'ongoing' : success ? 'done' : attention ? 'warning' : 'idle'
    const count = target === undefined ? '' : progress ? `${progress.completed} / ${progress.total}` : `${target}`
    const summary = <section className="vc-search-launch-status" data-task-status={entry?.status ?? state.submission?.status} data-active={active} role="status" aria-live="polite">
      <div className="vc-search-launch-overview">
        <span className="vc-search-launch-icon" aria-hidden="true"><ui.IconSearchOutlineRegular size={18} /></span>
        <div className="vc-search-launch-copy">
          <div className="vc-search-launch-heading"><strong>{t(entry?.input.wallpaper ? 'wallpaperWorkflow' : 'searchKind')}</strong><ui.Tag className="vc-search-launch-badge" tone={error ? 'danger' : success ? 'success' : attention ? 'warning' : active ? 'info' : 'neutral'}><ui.StateDot state={dotState} />{t(badgeKey)}</ui.Tag></div>
          {hint && <p className="vc-search-launch-notice">{hint}{errorCode && <code>{errorCode}</code>}</p>}
          {!stopped && failure && <FailureDetails failure={failure} t={t} />}
          {entry?.directory && (inline ? <div className="vc-search-launch-output"><span>{t('taskDeliveryReady')}</span><small className="vc-search-launch-directory">{entry.directory}</small></div> : <details className="vc-search-launch-output"><summary>{t('taskDeliveryReady')}</summary><small className="vc-search-launch-directory">{entry.directory}</small></details>)}
        </div>
      </div>
      {target !== undefined && <div className="vc-search-launch-metric">
        <div><span>{t(progress ? entry?.input.wallpaper ? 'wallpaperPassed' : entry?.input.output.kind === 'preview' ? 'taskPreviewMatched' : 'searchLaunchQualified' : 'targetCountLabel')}</span><strong>{progress ? progress.completed : target}{progress && <small> / {progress.total}</small>}</strong></div>
        {progress && active && <div className="vc-search-launch-progress" role="progressbar" aria-label={t('searchLaunchProgress')} aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={Math.min(progress.completed, progress.total)}><span style={{ width: `${Math.min(100, progress.completed / progress.total * 100)}%` }} /></div>}
      </div>}
      <div className="vc-search-launch-card-actions">
        {entry && entry.sessionReady !== false && entry.stage !== 'preparing' && entry.stage !== 'creating-session' && <ui.Button size="sm" variant="outline" role={inline ? 'menuitem' : undefined} onClick={() => { setMenuOpen(false); actions.openSession(entry.sessionId) }}>{t('searchLaunchOpen')}</ui.Button>}
        {(unknown || !entry?.runIds.length && launchFailed || entry?.continuation?.allowed) && <ui.Button size="sm" variant="outline" role={inline ? 'menuitem' : undefined} onClick={() => { setMenuOpen(false); if (entry) void actions.retry(entry.id); else if (state.submission) void actions.start(state.submission.input) }}>{t('searchLaunchContinue')}</ui.Button>}
        {entry && canStop && <ui.Button size="sm" variant="ghost" role={inline ? 'menuitem' : undefined} disabled={entry.stopping} onClick={() => { setMenuOpen(false); void actions.stop(entry.id) }}>{t('searchLaunchStop')}</ui.Button>}
      </div>
    </section>
    if (!inline) return summary
    return <ui.Menu className="vc-search-launch-inline" listClassName="vc-menu vc-search-launch-menu" portal autoFocus open={menuOpen} onClose={() => setMenuOpen(false)}
      anchor={<ui.Button size="sm" variant="ghost" className="vc-search-launch-trigger" aria-haspopup="menu" aria-expanded={menuOpen}
        aria-label={[t('searchKind'), t(badgeKey), count && `${t(progress ? entry?.input.wallpaper ? 'wallpaperPassed' : entry?.input.output.kind === 'preview' ? 'taskPreviewMatched' : 'searchLaunchQualified' : 'targetCountLabel')} ${count}`].filter(Boolean).join(' · ')}
        onClick={() => setMenuOpen(value => !value)} onKeyDown={event => { if (!menuOpen && event.key === 'ArrowDown') { event.preventDefault(); setMenuOpen(true) } }}>
        <ui.StateDot state={dotState} /><span className="vc-search-launch-trigger-label">{t(entry?.input.wallpaper ? 'wallpaperWorkflow' : 'searchKind')}</span><span className="vc-search-launch-trigger-state" aria-live="polite">{t(badgeKey)}</span>{count && <small>{count}</small>}<ui.IconChevronDownOutlineRegular size={12} />
      </ui.Button>}>{summary}</ui.Menu>
  }
  function Dialog({ fresh = false, stayOnCanvas = false, briefSupplement = '', wallpaperInitial = false, open, onClose, onDatasets, style, snapshot, useLaunches, actions, t }: { fresh?: boolean; stayOnCanvas?: boolean; briefSupplement?: string | undefined; wallpaperInitial?: boolean; open: boolean; onClose(): void; onDatasets?(id?: string): void; style: StyleView; snapshot: CuratorSnapshot; useLaunches: LaunchHook; actions: LaunchFormActions; t: WorkbenchText }) {
    const state = useLaunches(value => value), retainedEntry = fresh ? undefined : state.entries.find(item => item.status === 'working' || item.status === 'failed'), saved = state.submission?.input ?? retainedEntry?.input, retained = saved && !!saved.wallpaper === wallpaperInitial ? saved : undefined
    const [workspaceId, setWorkspace] = React.useState(retained?.workspaceId ?? ''), [brief, setBrief] = React.useState(retained?.taskBrief ?? [t('searchLaunchDefaultBrief').replace('{name}', style.name), briefSupplement.trim()].filter(Boolean).join('\n\n'))
    const [datasetId, setDataset] = React.useState<string>(retained?.datasetId ?? (state.submission ? '' : retainedEntry?.datasetId) ?? '')
    const formId = React.useId()
    const [modelKey, setModelKey] = React.useState(retained?.visionModel ? visionModelKey({ provider: retained.visionModel.provider, id: retained.visionModel.model }) : snapshot.configuration.visionConfigured ? 'configured' : '')
    const modelOptions = state.options?.visionModels ?? []
    const model = modelOptions.find(item => visionModelKey(item) === modelKey)
    const routeOptions = [...(snapshot.configuration.visionConfigured ? [{ value: 'configured', label: t('searchLaunchModelConfigured').replace('{model}', snapshot.configuration.vision.model) }] : []), ...modelOptions.map(item => ({ value: visionModelKey(item), label: `${item.providerName} / ${item.name}` }))]
    const [wallpaper, setWallpaper] = React.useState(retained?.wallpaper ?? wallpaperInitial)
    const [quantity, setQuantity] = React.useState(retained?.targetCount ?? Math.min(10, snapshot.configuration.limits.maxCandidates)), [output, setOutput] = React.useState<string>(retained?.output.kind ?? 'preview'), [usageId, setUsage] = React.useState(retained?.output.kind === 'usage' ? retained.output.usageRevisionId : snapshot.usages[0]?.usageRevisionId ?? '')
    const operationId = React.useRef(retained?.operationId ?? crypto.randomUUID()), opened = React.useRef(false), navigateAfterStart = React.useRef(false)
    const usages = state.options?.usages ?? snapshot.usages
    const selected = state.entries.find(item => item.id === operationId.current), pending = state.submission?.input.operationId === operationId.current ? state.submission : null
    const locked = !!pending && pending.status !== 'rejected' || !!selected && selected.status !== 'stopped'
    const frozenVision = locked ? selected?.input.visionModel ?? pending?.input.visionModel : undefined
    if (frozenVision && !routeOptions.some(item => item.value === modelKey)) routeOptions.push({ value: modelKey, label: `${frozenVision.provider} / ${frozenVision.model}` })
    const profileId = locked ? selected?.input.modelProfileId ?? pending?.input.modelProfileId ?? '' : style.modelProfile?.id ?? ''
    const datasetOptions = state.datasetOptions?.modelProfileId === profileId ? state.datasetOptions : undefined
    const frozenDatasetId = selected?.datasetId ?? selected?.input.datasetId ?? pending?.input.datasetId
    const dataset = datasetOptions?.entries.find(item => item.exportId === (locked ? frozenDatasetId ?? datasetId : datasetId))
    const automaticDataset = !locked && !datasetId ? datasetOptions?.entries.find(item => item.modelProfileId === profileId && !item.stale) : undefined
    const displayedDataset = dataset ?? automaticDataset
    const datasetLoading = !!profileId && (!datasetOptions || datasetOptions.loading)
    React.useEffect(() => { void actions.loadOptions(); void actions.refresh() }, [actions])
    React.useEffect(() => { if (open && profileId) void actions.loadDatasets(profileId) }, [actions, open, profileId])
    React.useEffect(() => { if (!workspaceId && state.options?.workspaces.length) setWorkspace(state.options.workspaces[0]!.id) }, [state.options, workspaceId])
    React.useEffect(() => { if (!usageId && usages.length) setUsage(usages[0]!.usageRevisionId) }, [usages, usageId])
    React.useEffect(() => {
      const ready = selected && (selected.status === 'working' || selected.status === 'accepted') && (stayOnCanvas || selected.sessionReady !== false && (selected.stage === 'preparing-dataset' || selected.stage === 'attaching' || selected.stage === 'submitting' || selected.stage === 'accepted'))
      if (ready && navigateAfterStart.current && !opened.current && (stayOnCanvas || actions.openSession(selected.sessionId))) { opened.current = true; onClose() }
    }, [selected?.status, selected?.stage, selected?.sessionId, selected?.sessionReady, stayOnCanvas, actions, onClose])
    const start = () => {
      if (pending && pending.status !== 'rejected') { navigateAfterStart.current = true; void actions.start(pending.input); return }
      if (selected && selected.status !== 'stopped') { navigateAfterStart.current = true; void actions.retry(selected.id); return }
      if (!style.modelProfile || datasetId && !dataset?.exportId || datasetLoading || datasetOptions?.error) return
      const configured = snapshot.configuration.vision
      const conversationModel = model ? { provider: model.provider, model: model.id } : configured.backend === 'native' && configured.provider ? { provider: configured.provider, model: configured.model } : undefined
      navigateAfterStart.current = true
      if (pending?.status === 'rejected' || selected?.status === 'stopped') operationId.current = crypto.randomUUID()
      void actions.start({ operationId: operationId.current, workspaceId, modelProfileId: dataset?.modelProfileId ?? style.modelProfile.id, ...(dataset?.exportId ? { datasetId: dataset.exportId } : { autoPrepareDataset: true }), includeNegativeDatasets: true, ...(wallpaper ? { wallpaper: true } : {}), executionMode: 'conversation', ...(conversationModel ? { conversationModel } : {}), ...(model ? { visionModel: { provider: model.provider, model: model.id } } : {}), taskBrief: brief, targetCount: quantity, output: wallpaper && state.options?.previewSearch === false ? { kind: 'original' } : output === 'preview' ? { kind: 'preview' } : output === 'original' ? { kind: 'original' } : { kind: 'usage', usageRevisionId: usageId } })
    }
    const workspace = state.options?.workspaces.find(item => item.id === workspaceId), usage = usages.find(item => item.usageRevisionId === usageId)
    const negativeReferences = locked ? selected?.negativeReferences : datasetOptions?.negativeReferences
    const incompatible = !!state.options && (state.options.datasetSelection !== 'required' && (!locked || !!(selected?.input.datasetId ?? pending?.input.datasetId)) || output === 'preview' && state.options.previewSearch === undefined || state.options.conversationModelSelection !== true && !locked || (!locked && !datasetId || retained?.autoPrepareDataset) && state.options.automaticDatasetPreparation !== true || (!locked || retained?.includeNegativeDatasets) && state.options.negativeReferenceDatasets !== true)
    const previewUnsupported = !wallpaper && output === 'preview' && state.options?.previewSearch === false
    const failure = pending?.error ? pending.failure : selected?.status === 'failed' ? selected.error : state.failure
    const errorCode = incompatible ? 'launch-update-required' : previewUnsupported ? 'preview-source-unsupported' : pending?.error || (selected?.status === 'failed' ? selected.error?.code : undefined) || state.error
    const unknown = pending?.status === 'unknown', preparing = pending?.status === 'submitting' || selected?.status === 'working'
    const failed = !!errorCode || selected?.status === 'failed', feedback = failed || unknown || preparing
    const refresh = () => { void actions.loadOptions(); void actions.refresh(); if (profileId) void actions.loadDatasets(profileId) }
    const workspaceUnavailable = errorCode === 'reference-unavailable' && failure?.stage === 'search-launch'
    const canStop = !!selected && (selected.status === 'working' || !!selected.stopping || [selected.runStatus, selected.wallpaper?.status].some(status => ['created', 'running', 'pausing', 'cancelling'].includes(status ?? '')))
    const chooseWorkspace = () => { operationId.current = crypto.randomUUID(); setWorkspace(''); refresh() }
    const blocked = !locked && (state.optionsLoading || !state.options || !style.modelProfile || !datasetId && style.modelProfile.stale || !!datasetId && !dataset?.exportId || datasetLoading || !!datasetOptions?.error)
    return <ui.Modal open={open} onClose={onClose} title={t('searchLaunchTitle')} closeLabel={t('close')} className="vc-search-launch-modal" contentClassName="vc-search-launch-content" footer={<div className="vc-search-launch-footer"><p className="vc-search-launch-hint">{t('searchLaunchAutoHint')}</p><div className="vc-task-footer"><ui.Button variant="outline" onClick={onClose}>{t('close')}</ui.Button><ui.Button variant="primary" type="submit" form={formId} disabled={preparing || blocked || incompatible || previewUnsupported}>{preparing && <ui.StateDot state="ongoing" />}{t(unknown || selected?.status === 'failed' ? 'searchLaunchContinue' : 'startTask')}</ui.Button></div></div>}>
      <form id={formId} className="vc-search-launch-form" noValidate={locked} onSubmit={event => { event.preventDefault(); if (!locked && modelKey !== 'configured' && !model) return; start() }}><div className="vc-search-launch-summary"><div className="vc-search-launch-intro"><div className="vc-search-launch-identity"><ui.IconSparkleRegular size={16} /><strong>{style.name}</strong>{dataset ? <ui.Tag>v{dataset.profileRevision}</ui.Tag> : !locked && style.modelProfile ? <ui.Tag>v{style.modelProfile.revision}</ui.Tag> : null}</div><p className="vc-search-launch-hint">{t('searchLaunchDatasetAuto')}</p></div><span className="vc-search-launch-artwork" aria-hidden="true" /></div>
      {feedback && <section className="vc-search-launch-feedback" role={failed ? 'alert' : 'status'}>
        <div className="vc-search-launch-feedback-heading"><ui.StateDot state={failed ? 'error' : unknown ? 'warning' : 'ongoing'} /><strong>{t(errorCode === 'launch-update-required' ? 'searchLaunchUpdateRequired' : unknown ? 'searchLaunchBadgeUnknown' : failed ? 'searchLaunchFailureTitle' : selected?.stopping ? 'searchLaunchBadgeStopping' : 'searchLaunchBadgePreparing')}</strong></div>
        <p>{errorCode === 'launch-update-required' ? t('searchLaunchUpdateHint') : unknown ? t('searchLaunchUnknownHint') : failed ? failureHint(errorCode, failure?.stage, t) : t('searchLaunchBackground')}</p>
        {errorCode !== 'launch-update-required' && <FailureDetails failure={failure} t={t} />}
        <div className="vc-search-launch-feedback-actions"><ui.Button size="sm" variant="ghost" disabled={state.optionsLoading || state.loading} onClick={refresh}><ui.IconRefreshOutlineRegular size={14} />{t('searchLaunchReadAgain')}</ui.Button>{selected && selected.sessionReady !== false && selected.stage !== 'preparing' && selected.stage !== 'creating-session' && <ui.Button size="sm" variant="outline" onClick={() => { if (actions.openSession(selected.sessionId)) onClose() }}>{t('searchLaunchOpen')}</ui.Button>}{workspaceUnavailable && <ui.Button size="sm" variant="outline" onClick={chooseWorkspace}>{t('searchLaunchChooseWorkspace')}</ui.Button>}{selected && canStop && <ui.Button size="sm" variant="ghost" disabled={selected.stopping} onClick={() => { void actions.stop(selected.id) }}>{t('searchLaunchStop')}</ui.Button>}</div>
      </section>}
      <section className="vc-search-launch-section" aria-label={t('searchLaunchSource')}><h3>{t('searchLaunchSource')}</h3>
      <div className="vc-search-launch-field vc-search-launch-dataset">
        <div className="vc-search-launch-field-heading"><span>{t('searchLaunchDataset')}</span>{!locked && <ui.Button size="sm" variant="ghost" disabled={datasetLoading} onClick={() => { void actions.loadDatasets(profileId) }}><ui.IconRefreshOutlineRegular size={14} />{t('refresh')}</ui.Button>}</div>
        {locked ? <div className="vc-search-launch-fixed"><ui.StateDot state={frozenDatasetId ? 'done' : 'ongoing'} /><div><span>{t('searchLaunchDatasetFixed')}</span>{frozenDatasetId && <small>{frozenDatasetId}</small>}</div></div>
          : datasetLoading && !datasetOptions?.entries.length ? <span className="vc-skeleton-fill vc-search-launch-skeleton" aria-busy="true" />
            : <SelectField label={t('searchLaunchDatasetRequired')} value={datasetId} options={[{ value: '', label: t('searchLaunchDatasetAutomatic') }, ...(datasetOptions?.entries ?? []).map(item => ({ value: item.exportId!, label: `${item.name} · v${item.profileRevision} · ${new Date(item.createdAt).toLocaleString()}` }))]} disabled={datasetLoading} onChange={setDataset} />}
        {datasetOptions?.error && <small role="alert">{t('searchLaunchDatasetLoadFailed')}</small>}
        {!locked && (displayedDataset || !datasetLoading && !datasetOptions?.error) && <div className="vc-search-launch-dataset-preview" data-ready={!!displayedDataset} aria-busy={datasetLoading || undefined}>
          <div className="vc-search-launch-dataset-identity"><ui.StateDot state={displayedDataset ? 'done' : 'idle'} /><strong>{displayedDataset?.name ?? t('searchLaunchDatasetPrepareTitle')}</strong>{displayedDataset && <ui.Tag>v{displayedDataset.profileRevision}</ui.Tag>}<small>{t(automaticDataset ? 'searchLaunchDatasetAutoSelected' : displayedDataset ? 'searchLaunchDatasetReady' : 'searchLaunchDatasetPrepareTitle')}</small></div>
          {displayedDataset ? <><div className="vc-search-launch-dataset-stats"><span>{t('searchLaunchDatasetSummary').replace('{references}', String(displayedDataset.counts.references)).replace('{rules}', String(displayedDataset.counts.rules))}</span><span>{t('searchLaunchDatasetRoles').replace('{positive}', String(displayedDataset.counts.positive)).replace('{negative}', String(displayedDataset.counts.negative))}</span></div><small>{t('searchLaunchDatasetUpdated').replace('{date}', new Date(displayedDataset.createdAt).toLocaleString())}</small></> : <small>{style.modelProfile?.stale ? t('searchLaunchSavedDatasetHint') : datasetOptions?.total === 0 ? t('searchLaunchDatasetMissing').replace('{version}', String(style.modelProfile?.revision)) : t('searchLaunchDatasetPrepareHint')}</small>}
        </div>}
        {!locked && <small className="vc-search-launch-selection-hint">{t(datasetId ? 'searchLaunchDatasetHint' : 'searchLaunchDatasetAutomaticHint')}</small>}
        <div className="vc-search-launch-dataset-meta"><div className="vc-search-launch-dataset-actions">
          {datasetOptions?.pageToken && datasetOptions.entries.length < datasetOptions.total && <ui.Button size="sm" variant="ghost" disabled={datasetLoading} onClick={() => { void actions.loadDatasets(profileId, true) }}>{t('searchLaunchDatasetMore')}</ui.Button>}
          {displayedDataset && <ui.Button size="sm" variant="outline" disabled={!onDatasets} onClick={() => onDatasets?.(displayedDataset.id)}>{t('searchLaunchDatasetView')}</ui.Button>}
          {!locked && <ui.Button size="sm" variant="ghost" disabled={!onDatasets} onClick={() => onDatasets?.()}>{t('searchLaunchDatasetGenerate')}</ui.Button>}
        </div></div>
      </div>
      {(!locked || negativeReferences) && <details className="vc-search-launch-field vc-search-launch-negatives"><summary><strong>{t('searchLaunchNegativesAutomatic')}</strong><small>{datasetLoading && !locked ? t('galleryLoading') : t('searchLaunchNegativesSummary').replace('{datasets}', String(negativeReferences?.datasets ?? 0)).replace('{references}', String(negativeReferences?.references ?? 0))}</small><ui.IconChevronDownOutlineRegular size={14} /></summary><small>{t('searchLaunchNegativesHint')}</small></details>}
      </section><section className="vc-search-launch-section" aria-label={t('searchLaunchRequirements')}><h3>{t('searchLaunchRequirements')}</h3>
      {wallpaper && <p className="vc-flow-muted">{t('wallpaperAllResults')}</p>}
      <label className="vc-search-launch-field"><span>{t('taskBriefLabel')}<span className="vc-required" aria-hidden="true"> *</span></span><ui.TextArea required name="taskBrief" data-modal-autofocus rows={4} maxLength={4000} value={brief} disabled={locked} onChange={event => { event.target.setCustomValidity(event.target.value.trim() ? '' : t('searchLaunchRequired').replace('{field}', t('taskBriefLabel'))); setBrief(event.target.value) }} /></label>
      <div className="vc-search-launch-grid"><label className="vc-search-launch-field"><span>{t('targetCountLabel')}<span className="vc-required" aria-hidden="true"> *</span></span><ui.Input required name="targetCount" step={1} type="number" min={1} max={state.options?.maxTargetCount ?? snapshot.configuration.limits.maxCandidates} value={quantity || ''} disabled={locked} onChange={event => setQuantity(Number(event.target.value))} /></label><label className="vc-search-launch-field"><span>{t('searchLaunchOutput')}</span><SelectField required validationMessage={t('searchLaunchRequired').replace('{field}', t('searchLaunchOutput'))} label={t('searchLaunchOutput')} value={wallpaper ? 'wallpaper' : output} disabled={locked} options={[{ value: 'preview', label: t('searchLaunchOnlySearch') }, { value: 'wallpaper', label: t('searchLaunchWallpaper') }, { value: 'original', label: t('searchLaunchOriginal') }, { value: 'usage', label: t('searchLaunchSized') }]} onChange={value => { setWallpaper(value === 'wallpaper'); setOutput(value === 'wallpaper' ? 'preview' : value) }} /></label></div>
      {output === 'usage' && <div className="vc-search-launch-field"><span>{t('usageLabel')}</span><SelectField required validationMessage={t('searchLaunchRequired').replace('{field}', t('usageLabel'))} label={t('usageLabel')} value={usageId} disabled={locked || !usages.length} options={usages.map(item => ({ value: item.usageRevisionId, label: `${item.name} · ${item.targetWidth} × ${item.targetHeight}` }))} onChange={setUsage} />{state.options?.usagePageToken && <ui.Button size="sm" disabled={state.optionsLoading} onClick={() => { void actions.loadOptions(true) }}>{t('more')}</ui.Button>}{!usage && <small>{t('taskUsageRequired')}</small>}</div>}
      <p className="vc-search-launch-policy">{t(wallpaper ? 'wallpaperAllResults' : output === 'preview' ? 'searchLaunchPreviewHint' : 'searchLaunchAutoHint')}</p>
      </section>
      <section className="vc-search-launch-section vc-search-launch-environment" aria-label={t('searchLaunchEnvironment')}><h3>{t('searchLaunchEnvironment')}</h3>
      <label className="vc-search-launch-field"><span>{t('searchLaunchWorkspace')}<span className="vc-required" aria-hidden="true"> *</span></span>{state.optionsLoading && !state.options ? <span className="vc-skeleton-fill vc-search-launch-skeleton" aria-busy="true" /> : <SelectField required validationMessage={t('searchLaunchRequired').replace('{field}', t('searchLaunchWorkspace'))} label={t('searchLaunchWorkspace')} value={workspaceId} options={(state.options?.workspaces ?? []).map(item => ({ value: item.id, label: item.title }))} disabled={locked || state.optionsLoading} onChange={setWorkspace} />}<small>{workspace?.path ?? t('searchLaunchNoWorkspace')}</small></label>
      <div className="vc-search-launch-field"><span>{t('searchLaunchModel')}<span className="vc-required" aria-hidden="true"> *</span></span><SelectField required validationMessage={t('searchLaunchRequired').replace('{field}', t('searchLaunchModel'))} label={t('searchLaunchModelPlaceholder')} value={modelKey} options={routeOptions} disabled={locked || state.optionsLoading} onChange={setModelKey} /><small>{t('searchLaunchWorkflowModel')}</small></div>
      </section></form>
    </ui.Modal>
  }
  return { Dialog, Background }
}
