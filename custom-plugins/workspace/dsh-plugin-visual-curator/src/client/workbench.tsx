import { createImageGallery } from './image-gallery.tsx'
import { createReferenceStateHook } from './reference-state.ts'
import type { ReferenceState } from '../shared/reference-state.ts'
/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Image preparation workspace composed with the Host's React and DSH primitives. */
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CuratorSnapshot, ConfigurationView, StyleView } from './contract.ts'
import type { ClientState, CuratorStore } from './store.ts'
import { safeResourcePath } from './store.ts'
import { importPickedReferences, type ImportRow } from './local-import.ts'
import { archiveCollections, dimensions, filterReferences, resultId } from './workbench-actions.ts'
import { createStyleProfileDialog } from './style-profile-dialog.tsx'
import { createGallerySettings } from './gallery-settings.tsx'
import { createGalleryReferenceDialog } from './gallery-reference-dialog.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { createSearchBatchResults, createSearchBatchSkeleton } from './search-batch-results.tsx'
import type { SearchBatchesState, SearchBatchesStore } from './search-batches-store.ts'
import { galleryTaskActive, galleryTaskProgress, type GalleryTaskView } from '../shared/gallery-task.ts'
import { createGalleryTaskStatus } from './gallery-task-status.tsx'
import type { DatasetClientState, DatasetStore } from './dataset-store.ts'
import { createDatasetProgress, datasetNotice } from './dataset-progress.tsx'
import { createDatasetWorkspace } from './dataset-workspace.tsx'
import { createGalleryMedia } from './gallery-media.tsx'
import { createReferencePreview } from './reference-preview.tsx'
import { analysisActive } from '../shared/analysis-process.ts'
import { analysisPhaseLabel, createAnalysisDialog } from './analysis-dialog.tsx'
import { createTaskDialog } from './task-dialog.tsx'
import { createSearchLaunchUI } from './search-launch-dialog.tsx'
import type { SearchLaunchState, SearchLaunchStore } from './search-launch-store.ts'
import { createSelectField } from './select-field.tsx'
import { createTaskHistory } from './task-history.tsx'
import { createWorkbenchSelector } from './workbench-state.ts'
import referenceEmptyArtwork from '../../assets/reference-collection-empty-v1.webp'
import analysisAnimation from '../../assets/analysis-status-animation-v2.webp'
import analysisPoster from '../../assets/analysis-status-poster-v2.webp'
import profileTabHighlight from '../../assets/profile-dimension-highlight-v1.webp'
import { managedVision, visionModelKey, type VisionModelState } from './vision-models.ts'

/** Narrow callbacks and an injected read hook keep Cordis outside the component tree. */
export interface WorkbenchProps extends PropsRenderFactories {
  useWorkbench<T>(select: (state: ClientState) => T): T
  useVisionModels<T>(select: (state: VisionModelState) => T): T
  useDatasets<T>(select: (state: DatasetClientState) => T): T
  useLaunches<T>(select: (state: SearchLaunchState) => T): T
  useSearchBatches?<T>(select: (state: SearchBatchesState) => T): T
  t: WorkbenchText
  welcomeImage: string
  logoImage: string
  actions: Pick<CuratorStore, 'selectWorkspace' | 'openSession' | 'closeSession' | 'prepareTask' | 'execute' | 'reload' | 'getSnapshot' | 'selectStyle' | 'selectRun' | 'loadMoreImages' | 'loadRun' | 'loadReferences' | 'startGalleryReferences' | 'stopGalleryReferences' | 'startAnalysis' | 'referenceState' | 'stopAnalysis' | 'pauseAnalysis' | 'resumeAnalysis' | 'openAnalysis' | 'closeAnalysis' | 'refreshAnalysisDetail' | 'loadAnalysisInput' | 'saveConfiguration'> & {
    datasets: Pick<DatasetStore, 'start' | 'refresh' | 'loadMore' | 'filter' | 'open' | 'moreSamples' | 'closeDetail' | 'dismiss'>
    batches?: Pick<SearchBatchesStore, 'watch' | 'select' | 'refresh' | 'more' | 'moreImages' | 'remove'>
    launches: Pick<SearchLaunchStore, 'start' | 'retry' | 'stop' | 'refresh' | 'loadOptions' | 'loadDatasets' | 'openSession'>
    publish(style: StyleView): Promise<string>
    saveCredential(ref: string, value: string): Promise<void>
    loadVisionModels(): Promise<void>
    reloadVisionModels(): void
    openModelSettings(): void
    pickLocalReferences(kind: 'file' | 'folder' | 'references', signal: AbortSignal): Promise<unknown>
    listLocalReferences(path: string, kind: 'file' | 'folder', signal: AbortSignal): Promise<unknown>
    galleryRead(operation: string, args: import('./contract.ts').ActionArgs, signal: AbortSignal, options?: { refresh?: boolean }): Promise<unknown>
  }
}

/** Create stable components once per module factory, sharing the shell's React instance.
 * @param React Shell React runtime. @param ui Existing DSH primitive library. @returns Slot-ready workspace component.
 */
export function createWorkbench(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Input, TextArea, Tag, Pill, StateDot, Modal, Menu, SegmentedTabs, DisclosureRow, AnimatedCollapse, Checkbox } = ui
  const id = () => crypto.randomUUID()
  const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean)
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : '' }
  const GallerySettings = createGallerySettings(React, ui)
  const GalleryTaskStatus = createGalleryTaskStatus(React, ui)
  const DatasetProgress = createDatasetProgress(React, ui)
  const DatasetWorkspace = createDatasetWorkspace(React, ui)
  function DatasetBackground({ useDatasets, style, actions, t, onOpen, onView }: Pick<WorkbenchProps, 'useDatasets' | 'actions' | 't'> & { style: StyleView; onOpen(): void; onView(): void }) {
    const state = useDatasets(value => value), notice = datasetNotice(state, style.styleId)
    return <DatasetProgress {...notice} t={t} readError={state.error} onRefresh={() => { void actions.datasets.refresh() }} onOpen={onOpen} onView={onView} onRetry={() => { if (notice.submission) void actions.datasets.start({ id: notice.submission.profileId, styleId: style.styleId }) }} onDismiss={() => { if (notice.entry) actions.datasets.dismiss(notice.entry.id) }} />
  }
  const ReferencePreview = createReferencePreview(React, ui), ImageGallery = createImageGallery(React, ui)
  const { GalleryLoadMore, GallerySkeleton } = createGalleryMedia(React, ui)
  const AnalysisDialog = createAnalysisDialog(React, ui)
  function AnalysisDialogRegion({ useWorkbench, actions, t, renderFactorySlot, onReanalyze }: Pick<WorkbenchProps, 'useWorkbench' | 'actions' | 't' | 'renderFactorySlot'> & { onReanalyze(styleId: string): void }) {
    const state = useWorkbench(value => value)
    const styleId = state.analysisDetail?.task.styleId ?? state.analysisTasks.find(task => task.runId === state.analysisRunId)?.styleId
    const style = state.snapshot?.styles.find(item => item.styleId === styleId && !item.archived)
    const reanalysisDisabled = !style?.referenceIds.length || !state.snapshot?.configuration.visionConfigured || state.pending.includes(`analysis:${styleId}`) || state.analysisTasks.some(task => task.styleId === styleId && (analysisActive(task.status) || ['paused', 'interrupted'].includes(task.status))) || state.galleryTasks.some(task => task.styleId === styleId && galleryTaskActive(task.status))
    return <AnalysisDialog state={state} t={t} renderFactorySlot={renderFactorySlot} onReadInput={requestId => void actions.loadAnalysisInput(requestId)} onClose={actions.closeAnalysis} onStop={runId => void actions.stopAnalysis(runId)} onPause={runId => void actions.pauseAnalysis(runId)} onResume={runId => void actions.resumeAnalysis(runId)} onReanalyze={onReanalyze} reanalysisDisabled={reanalysisDisabled} onRetry={() => void actions.refreshAnalysisDetail()} />
  }
  const TaskHistory = createTaskHistory(React, ui)
  const SearchBatchResults = createSearchBatchResults(React, ui), BatchSkeleton = createSearchBatchSkeleton(React)
  const TaskDialog = createTaskDialog(React, ui)
  const SearchLaunch = createSearchLaunchUI(React, ui)

  const SelectField = createSelectField(React, ui)

  function CreateCollection({ name, onName, onSubmit, busy, error, t }: { name: string; onName(value: string): void; onSubmit(): void; busy: boolean; error: string; t: WorkbenchText }) {
    return <form className="vc-create-form" aria-busy={busy || undefined} onSubmit={event => { event.preventDefault(); if (!busy && name.trim()) onSubmit() }}>
      <label>{t('name')}<Input required data-modal-autofocus placeholder={t('nameHint')} value={name} disabled={busy} onChange={event => onName(event.target.value)} /></label>
      <p>{t('collectionHint')}</p>
      {error && <p role="alert">{error}</p>}
      <Button variant="primary" className="vc-primary-action" type="submit" aria-busy={busy || undefined} disabled={!name.trim() || busy}>{busy ? <StateDot state="ongoing" /> : <ui.IconPlusOutlineRegular size={16} />}<span role={busy ? 'status' : undefined}>{t(busy ? 'creatingCollection' : 'createCollectionAction')}</span></Button>
    </form>
  }

  function Configuration({ config, actions, t, report, styles, selectedStyleId, openWorkbench, initialPanel, saving, saveError, useVisionModels }: { config: ConfigurationView; actions: WorkbenchProps['actions']; t: WorkbenchText; report(work: () => Promise<unknown>): void; styles: StyleView[]; selectedStyleId: string; openWorkbench(styleId: string): void; initialPanel: 'vision' | 'source'; saving: boolean; saveError: ClientState['configError']; useVisionModels: WorkbenchProps['useVisionModels'] }) {
    const [vision, setVision] = React.useState(config.vision)
    const catalog = useVisionModels(state => state)
    const selectedKey = visionModelKey({ provider: vision.provider ?? '', id: vision.model })
    const selectedModel = catalog.value?.models.find(model => visionModelKey(model) === selectedKey)
    const savedModelAvailable = catalog.status === 'ready' && config.vision.backend === 'native' && catalog.value?.models.some(model => model.provider === config.vision.provider && model.id === config.vision.model)
    const [source, setSource] = React.useState(config.source)
    const [requestTimeoutMs, setRequestTimeoutMs] = React.useState(config.limits.requestTimeoutMs)
    const [maxRetryAttempts, setMaxRetryAttempts] = React.useState(config.limits.maxRetryAttempts)
    const [deadlineMs, setDeadlineMs] = React.useState(config.limits.deadlineMs)
    const [sourceKey, setSourceKey] = React.useState('')
    const [panel, setPanel] = React.useState<'vision' | 'source'>(initialPanel)
    const [connectionOpen, setConnectionOpen] = React.useState(false), [advancedOpen, setAdvancedOpen] = React.useState(false)
    const settingsId = React.useId()
    React.useEffect(() => { if (panel === 'vision' && catalog.status === 'idle') void actions.loadVisionModels() }, [panel, catalog.status, actions])
    React.useEffect(() => { setSource(config.source) }, [config.revision])
    const save = async (kind: 'vision' | 'source' = 'vision') => {
      try {
        if (kind === 'vision' && (catalog.status !== 'ready' || !catalog.value || !selectedModel)) return
        await actions.saveConfiguration({ revision: config.revision, vision: kind === 'vision' ? { ...managedVision(vision, selectedKey, catalog.value!) } : {}, source: kind === 'source' ? { ...source } : {}, limits: kind === 'vision' ? { requestTimeoutMs, maxRetryAttempts, deadlineMs } : {} }, async () => {
          if (kind === 'source' && sourceKey) { await actions.saveCredential(source.credentialRef, sourceKey); setSourceKey('') }
        })
        const saved = actions.getSnapshot().snapshot?.configuration; if (saved) { setVision(saved.vision); setSource(saved.source) }; if (kind === 'source') setAdvancedOpen(false)
      } catch (error) { /* 保存失败由共享配置状态显示，导航和其他任务继续可用。 */ }
    }
    return <><form className="vc-settings" onSubmit={event => { event.preventDefault(); save() }}>
      <SegmentedTabs className="vc-settings-tabs" label={t('settings')} value={panel} onChange={setPanel} items={[
        { value: 'vision', label: <span className="vc-settings-tab-label"><ui.IconSparkleRegular size={16} />{t('vision')}<StateDot state={savedModelAvailable ? 'done' : 'idle'} /></span>, id: `${settingsId}-vision-tab`, panelId: `${settingsId}-vision` },
        { value: 'source', label: <span className="vc-settings-tab-label"><ui.IconFolderOpenOutlineRegular size={16} />{t('gallery')}<StateDot state={config.sourceConfigured ? 'done' : 'idle'} /></span>, id: `${settingsId}-source-tab`, panelId: `${settingsId}-source` },
      ]} />
      {(['vision', 'source'] as const).map(value => <div key={value} id={`${settingsId}-${value}`} role="tabpanel" aria-labelledby={`${settingsId}-${value}-tab`} hidden={panel !== value}>{panel === value && <fieldset data-panel={value} className="vc-settings-panel vc-stack" disabled={saving}>
      {value === 'vision' ? <>
        <div className="vc-row"><h3>{t('vision')}</h3><Tag tone={savedModelAvailable ? 'success' : 'neutral'}>{t(savedModelAvailable ? 'configured' : 'unconfigured')}</Tag></div>
        <p>{t('managedModelsHint')}</p>
        <label>{t('configuredModel')}<SelectField label={t('configuredModel')} value={selectedKey} disabled={catalog.status !== 'ready' || !catalog.value?.models.length} options={(catalog.value?.models ?? []).map(model => ({ value: visionModelKey(model), label: `${model.name} · ${model.providerName}` }))} onChange={key => { const model = catalog.value?.models.find(item => visionModelKey(item) === key); if (model) setVision({ ...vision, backend: 'native', provider: model.provider, model: model.id }) }} /></label>
        <div className="vc-row"><small role="status">{catalog.status === 'loading' ? <StateDot state="ongoing" /> : catalog.status === 'error' ? t('modelsLoadError') : !catalog.value?.models.length ? t('modelsEmpty') : vision.model && !selectedModel ? t('modelUnavailable') : catalog.value.unavailable.length > 0 ? t('modelsPartial') : t('managedModelsShared')}</small><div className="vc-dataset-actions"><Button variant="ghost" disabled={catalog.status === 'loading'} onClick={actions.reloadVisionModels}>{t('refresh')}</Button><Button variant="outline" onClick={actions.openModelSettings}>{t('manageModels')}<ui.IconChevronRightOutlineRegular size={12} /></Button></div></div>
        <DisclosureRow className="vc-settings-advanced" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('visionOptions')} open={connectionOpen} expandable expandOnRowClick onToggle={() => setConnectionOpen(value => !value)}><div className="vc-settings-fields">
          <label>{t('requestTimeout')}<Input required type="number" min={1} step={1} value={requestTimeoutMs / 1000} onChange={event => setRequestTimeoutMs(Number(event.target.value) * 1000)} /></label>
          <label>{t('maxRetryAttempts')}<Input required type="number" min={0} max={5} step={1} value={maxRetryAttempts} onChange={event => setMaxRetryAttempts(Number(event.target.value))} /></label>
          <label>{t('analysisDeadline')}<Input required type="number" min={1} step={1} value={deadlineMs / 60_000} onChange={event => setDeadlineMs(Number(event.target.value) * 60_000)} /></label>
          <label>{t('modelContextWindow')}<Input readOnly value={selectedModel?.contextWindow?.toLocaleString() ?? t('providerDefault')} /></label>
          <label>{t('modelOutputDefault')}<Input readOnly value={selectedModel?.maxOutputTokens?.toLocaleString() ?? t('providerDefault')} /></label>
          <p>{t('requestLimitsHint')}</p>
        </div></DisclosureRow>
      </> : <>
        <GallerySettings config={{ ...config, source }} actions={actions} t={t} styles={styles} selectedStyleId={selectedStyleId} openWorkbench={openWorkbench} openAdvanced={() => setAdvancedOpen(true)} saveSource={async next => {
          await actions.saveConfiguration({ revision: config.revision, source: { ...next }, vision: {}, limits: {} })
          setSource(actions.getSnapshot().snapshot?.configuration.source ?? next)
        }} />

      </>}
      </fieldset>}</div>)}
      {saveError && <p role="alert">{t('error')} · {saveError.safeMessage || saveError.code}</p>}
      {panel === 'vision' && <footer className="vc-settings-footer"><small>{t('configHint')}</small><Button variant="primary" className="vc-primary-action" type="submit" disabled={saving || catalog.status !== 'ready' || !selectedModel} aria-busy={saving}>{saving && <StateDot state="ongoing" />}{t(saving ? 'busy' : 'saveConfig')}</Button></footer>}
    </form>
    <Modal open={advancedOpen} onClose={() => { if (!saving) { setAdvancedOpen(false); setSource(config.source); setSourceKey('') } }} title={t('galleryCustomSource')} closeLabel={t('close')} className="vc-custom-source-modal" contentClassName="vc-custom-source-scroll" footer={<div className="vc-dataset-actions"><Button variant="outline" disabled={saving} onClick={() => { setAdvancedOpen(false); setSource(config.source); setSourceKey('') }}>{t('cancel')}</Button><Button variant="primary" type="submit" form={settingsId + '-source-form'} disabled={saving}>{t(saving ? 'busy' : 'saveConfig')}</Button></div>}>
      <form id={settingsId + '-source-form'} onSubmit={event => { event.preventDefault(); save('source') }}><fieldset className="vc-settings-modal-fields" disabled={saving}><div className="vc-stack">
          <p>{t('galleryHint')}</p>
          <label>{t('endpoint')}<Input type="url" value={source.endpoint} onChange={event => setSource({ ...source, endpoint: event.target.value, provider: 'generic' })} /></label>
          <div className="vc-settings-fields">
            <label>{t('gallerySourceId')}<Input value={source.id} onChange={event => setSource({ ...source, id: event.target.value })} /></label>
            <label>{t('credentialRef')}<Input value={source.credentialRef} pattern="[A-Za-z_][A-Za-z0-9_]*|" onChange={event => setSource({ ...source, credentialRef: event.target.value })} /></label>
            <label>{t('apiKey')}<Input type="password" autoComplete="new-password" value={sourceKey} disabled={!source.credentialRef} placeholder={t('keyHint')} onChange={event => setSourceKey(event.target.value)} /><small>{t(config.sourceCredentialConfigured ? 'keySaved' : 'keyMissing')}</small></label>
            <label>{t('method')}<SelectField label={t('method')} value={source.method} disabled={saving} options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} onChange={value => setSource({ ...source, method: value as 'GET' | 'POST' })} /></label>
            {(['queryField', 'cursorField', 'pageSizeField', 'itemsPointer', 'idPointer', 'previewPointer', 'originalPointer', 'widthPointer', 'heightPointer', 'nextCursorPointer'] as const).map(key => <label key={key}>{t(key)}<Input value={source[key]} onChange={event => setSource({ ...source, [key]: event.target.value })} /></label>)}
            <label>{t('allowedOrigins')}<TextArea value={source.allowedMediaOrigins.join('\n')} onChange={event => setSource({ ...source, allowedMediaOrigins: lines(event.target.value) })} /></label>
          </div>
          <Button variant="outline" disabled={source.provider === 'generic'} onClick={() => setSource({ ...source, provider: 'generic' })}>{t('galleryUseCustom')}</Button>
        </div></fieldset></form>
    </Modal></>
  }

  const DatasetDialog = createStyleProfileDialog(React, ui)
  const GalleryReferenceDialog = createGalleryReferenceDialog(React, ui)

  function ProfileRules({ rules, expanded, onToggle, t }: { rules: StyleView['rules']; expanded: readonly string[]; onToggle(dimension: string): void; t: WorkbenchText }) {
    // 侧栏和窄屏弹窗同时保留状态，各自生成 ID，避免展开按钮指向隐藏容器。
    const contentId = React.useId()
    const groups = dimensions.map(dimension => ({ dimension, rows: rules.filter(rule => rule.dimension === dimension) })).filter(group => group.rows.length)
    return <section className="vc-profile-rules">
      <div className="vc-readonly-rule-summary"><h3>{t('enabledRules')}</h3><Tag tone="neutral">{rules.length}</Tag></div>
      {!rules.length && <p className="vc-rule-empty">{t('noRules')}</p>}
      {!!groups.length && <>
        <div className="vc-profile-rule-chips" role="group" aria-label={t('enabledRules')}>{groups.map(({ dimension, rows }) => <Pill key={dimension} className="vc-profile-rule-chip" active={expanded.includes(dimension)} aria-expanded={expanded.includes(dimension)} aria-controls={`${contentId}-${dimension}`} onClick={() => onToggle(dimension)}><img className="vc-profile-rule-highlight" src={profileTabHighlight} alt="" width={90} height={30} aria-hidden="true" /><span>{t(dimension)}</span><span className="vc-profile-rule-chip-count">{rows.length}</span></Pill>)}</div>
        <div className="vc-profile-rule-details">{groups.map(({ dimension, rows }) => <AnimatedCollapse key={dimension} id={`${contentId}-${dimension}`} open={expanded.includes(dimension)} className="vc-profile-rule-collapse"><section className="vc-profile-rule-detail" aria-label={t(dimension)}><h4>{t(dimension)}</h4>{rows.map(rule => <article key={rule.ruleId}><p>{rule.statement}</p>{rule.condition && <small>{rule.condition}</small>}</article>)}</section></AnimatedCollapse>)}</div>
      </>}
    </section>
  }

  const useReferenceState = createReferenceStateHook(React)

  function StyleEditor({ onSearch, canSearch, hasRecoverableRun, scopeSessionId, onCloseSession, searchTrigger, style, snapshot, actions, t, report, busy, query, onQuery, clearQuery, openGallerySettings, task, referencePage, pendingStart, analysisRequest, onAnalysisRequestHandled, previewRefresh, workspaceView, onViewChange, viewId, useDatasets }: { onSearch(): void; canSearch: boolean; hasRecoverableRun?: boolean | undefined; scopeSessionId?: string | undefined; onCloseSession?: (() => void) | undefined; searchTrigger: React.RefObject<HTMLButtonElement>; pendingStart: boolean; analysisRequest?: number | undefined; onAnalysisRequestHandled(): void; previewRefresh: number; style: StyleView; snapshot: CuratorSnapshot; actions: WorkbenchProps['actions']; t: WorkbenchText; report(work: () => Promise<unknown>): void; busy: boolean; query: string; onQuery(value: string): void; clearQuery(): void; openGallerySettings(): void; task: GalleryTaskView | undefined; referencePage: ClientState['referencePages'][string] | undefined; workspaceView: 'references' | 'execution' | 'datasets'; onViewChange(value: 'references' | 'execution' | 'datasets'): void; viewId: string; useDatasets: WorkbenchProps['useDatasets'] }) {
    const referencesView = workspaceView === 'references'
    const referencing = !!task && galleryTaskActive(task.status)
    const rules = style.modelProfile ? style.modelProfile.options.filter(option => option.enabled).map(option => option.rule) : style.rules
    const [role, setRole] = React.useState<'positive' | 'negative'>('positive')
    const [filter, setFilter] = React.useState<'all' | 'positive' | 'negative' | 'undecided'>('all')
    const [view, setView] = React.useState<'grid' | 'list'>('grid'), [dragging, setDragging] = React.useState(false)
    const [inspectorOpen, setInspectorOpen] = React.useState(true)
    const [inspectorModalOpen, setInspectorModalOpen] = React.useState(false)
    const [datasetOpen, setDatasetOpen] = React.useState(false)
    const [galleryOpen, setGalleryOpen] = React.useState(false)
    const [previewId, setPreviewId] = React.useState<string | null>(null)
    const closePreview = React.useCallback(() => setPreviewId(null), [])
    const [analysisStarting, setAnalysisStarting] = React.useState(false)
    const [analysisStartMode, setAnalysisStartMode] = React.useState<'planning' | 'pending' | 'all' | null>(null)
    const [analysisPreference, setAnalysisPreference] = React.useState<'pending' | 'all'>('pending')
    const [analysisPlan, setAnalysisPlan] = React.useState<ReferenceState | null>(null)
    const handledAnalysisRequest = React.useRef<number | undefined>(undefined)
    const referenceState = useReferenceState(actions.referenceState, style.styleId, style.revision, `${style.analysis?.runId ?? ''}:${style.analysis?.status ?? ''}:${style.analysis?.observed ?? 0}:${snapshot.configuration.revision}`, scopeSessionId, referencesView)
    const referenceStates = React.useMemo(() => new Map<string, ReferenceState['entries'][number]['state']>(referenceState.displayPlan?.entries.map(entry => [entry.imageVersionId, entry.state]) ?? []), [referenceState.displayPlan])
    const [expandedGroups, setExpandedGroups] = React.useState<string[]>([])
    const inspectorId = React.useId()
    const inspectorToggle = React.useRef<HTMLButtonElement>(null)
    const importTrigger = React.useRef<HTMLButtonElement>(null)
    const [imports, setImports] = React.useState<ImportRow[]>([]), [importMenuOpen, setImportMenuOpen] = React.useState(false), [importPage, setImportPage] = React.useState(0)
    const [pickerError, setPickerError] = React.useState('')
    const [pathOpen, setPathOpen] = React.useState(false), [sourcePath, setSourcePath] = React.useState(''), [pathKind, setPathKind] = React.useState<'file' | 'folder'>('folder'), [pathError, setPathError] = React.useState('')
    const importLifetime = React.useRef(new AbortController()), analysisPlanning = React.useRef<AbortController | null>(null)
    React.useEffect(() => () => { importLifetime.current.abort(); analysisPlanning.current?.abort() }, [])
    const refs = filterReferences(snapshot.images, style, '', 'all')
    const roleCount = (value: typeof filter) => referencePage?.counts[value] ?? (value === 'all' ? refs.length : refs.filter(image => (image.role ?? 'undecided') === value).length)
    const visibleRefs = filterReferences(snapshot.images, style, query, filter)
    const importing = snapshot.configuration.limits
    const analysisDisabled = busy || referencing || !style.referenceIds.length || !snapshot.configuration.visionConfigured || ['paused', 'interrupted'].includes(style.analysis?.status ?? '') || snapshot.runs.some(run => run.kind === 'analyze' && run.styleId === style.styleId && ['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling'].includes(run.status))
    const analysis = style.analysis
    const analysisPaused = analysis?.status === 'paused'
    const analysisRecoverable = !!analysis && ['paused', 'interrupted', 'failed'].includes(analysis.status) && (analysis.continuation?.allowed ?? analysis.status !== 'failed')
    const analyzing = !!analysis && ['created', 'running', 'pausing', 'cancelling'].includes(analysis.status)
    const analysisBusy = analysisStarting || pendingStart || analyzing
    const profileReady = !referencing && !analysisBusy && !analysisPaused && (!!style.modelProfile && !style.modelProfile.stale || !!analysis?.summary && analysis.status === 'completed' && !analysis.stale)
    const needsModel = !snapshot.configuration.visionConfigured && !profileReady
    const analysisState = analysisBusy ? 'ongoing' : needsModel || analysis?.stale ? 'warning' : analysis?.status === 'failed' ? 'error' : analysis?.summary ? 'done' : 'idle'
    const analysisTransition = analysis?.status === 'pausing' || analysis?.status === 'cancelling'
    const analysisLabel = analysisBusy ? analysisTransition ? t(analysis.status) : t(!analysisStarting && analysis && analysis.observed === analysis.total && analysis.total > 0 ? 'summarizingStyle' : 'analyzingImages') : needsModel ? t('modelNeeded') : analysis?.stale ? t('needsAnalysis')
      : analysis?.status === 'completed' && analysis.summary ? t('analysisFinished') : analysis ? t(analysis.outcome === 'budget-exhausted' ? 'budgetExhausted' : analysis.status) : refs.length ? t('analysisReady') : ''
    const launchAnalysis = async (plan: ReferenceState, analysisMode: 'pending' | 'all') => {
      analysisPlanning.current = null; setAnalysisStarting(true); setAnalysisStartMode(analysisMode); setPickerError('')
      try {
        const result = await actions.startAnalysis({ operationId: id(), styleId: style.styleId, buildDataset: true, analysisMode, planDigest: plan.digest })
        // 切换素材集后不回写旧界面，已启动的任务仍由 Host 管理。
        if (!importLifetime.current.signal.aborted) { setAnalysisPlan(null); setInspectorOpen(true); actions.selectRun(resultId(result, 'runId')) }
      } catch (error) { if (!importLifetime.current.signal.aborted) { setAnalysisPlan(null); setPickerError(t('analysisPlanChanged')); referenceState.retry() } }
      finally { if (!importLifetime.current.signal.aborted) { setAnalysisStarting(false); setAnalysisStartMode(null) } }
    }
    const startAnalysis = async (preference: 'pending' | 'all' = 'pending') => {
      const controller = new AbortController()
      analysisPlanning.current?.abort(); analysisPlanning.current = controller
      setAnalysisPreference(preference); setAnalysisStarting(true); setAnalysisStartMode('planning'); setPickerError('')
      try {
        const plan = await actions.referenceState(style.styleId, AbortSignal.any([importLifetime.current.signal, controller.signal]))
        if (controller.signal.aborted || importLifetime.current.signal.aborted) return
        if (plan.reusable || plan.changed || preference === 'all') setAnalysisPlan(plan)
        else await launchAnalysis(plan, 'pending')
      } catch (error) { if (!controller.signal.aborted && !importLifetime.current.signal.aborted) setPickerError(t('referenceStateError')) }
      finally { if (analysisPlanning.current === controller && !importLifetime.current.signal.aborted) { analysisPlanning.current = null; setAnalysisStarting(false); setAnalysisStartMode(null) } }
    }
    const cancelAnalysisStart = () => {
      // 只允许撤回范围预检；任务提交后的未知回执不通过关闭弹窗假装取消。
      if (analysisPlanning.current) { analysisPlanning.current.abort(); analysisPlanning.current = null; setAnalysisStarting(false); setAnalysisStartMode(null); setAnalysisPlan(null) }
      else if (!analysisStarting) setAnalysisPlan(null)
    }
    const analyze = (preference: 'pending' | 'all' = 'pending') => { if (!analysisDisabled && !analysisBusy) void startAnalysis(preference) }
    React.useEffect(() => {
      if (analysisRequest === undefined || handledAnalysisRequest.current === analysisRequest || !referencesView) return
      // 过程弹窗只传递一次操作意图；仍由当前素材集的范围预检确认是否重做。
      handledAnalysisRequest.current = analysisRequest; onAnalysisRequestHandled()
      if (!analysisDisabled && !analysisBusy) void startAnalysis('all')
      else setPickerError(t('analysisPlanChanged'))
    }, [analysisRequest, referencesView])
    const openPaths = () => report(async () => {
      setPickerError('')
      try { await importPickedReferences(actions, { styleId: style.styleId, role, limits: importing }, () => actions.pickLocalReferences('references', importLifetime.current.signal), rows => { setImports(rows); setImportPage(0) }, importLifetime.current.signal) }
      catch (error) { if (!importLifetime.current.signal.aborted) setPickerError(t('localPickerError')) }
    })
    const openGalleryFromMenu = () => {
      // 菜单项即将卸载；让弹窗保存稳定的返回焦点，关闭后回到“添加引用”。
      importTrigger.current?.focus({ preventScroll: true }); setGalleryOpen(true)
    }
    const addPath = (analyzeAfter: boolean) => report(async () => {
      const path = sourcePath.trim().replace(/^"|"$/g, '')
      if (!path) return
      setPathError(''); setPickerError('')
      let selectionRead = false
      try {
        const rows = await importPickedReferences(actions, { styleId: style.styleId, role, limits: importing }, () => actions.listLocalReferences(path, pathKind, importLifetime.current.signal), rows => { selectionRead = true; setImports(rows); setImportPage(0); setPathOpen(false) }, importLifetime.current.signal)
        if (analyzeAfter && !importLifetime.current.signal.aborted && rows.some(row => row.status === 'imported')) {
          await startAnalysis()
        }
      } catch (error) { if (!importLifetime.current.signal.aborted) { if (selectionRead) setPickerError(t('analysisStartError')); else setPathError(t('localPathError')) } }
    })
    const statusKeys = { queued: 'importQueued', processing: 'importProcessing', imported: 'imported', failed: 'failed', skipped: 'importSkipped', unconfirmed: 'importUnconfirmed' } as const
    const fileSize = (size: number) => size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`
    const importPages = Math.max(1, Math.ceil(imports.length / importing.pageSize)), currentImportPage = Math.min(importPage, importPages - 1)
    const summary = style.modelProfile?.summary ?? analysis?.summary
    const groups = style.modelProfile?.groups ?? summary?.organization?.groups ?? []
    const closeInspector = () => { setInspectorOpen(false); inspectorToggle.current?.focus() }
    // 两种容器共用同一份内容和展开状态；窄屏焦点与 Escape 由原生 Modal 管理。
    const profileContent = <>
      <div className="vc-profile-state" data-analyzing={analysisBusy} role="status" aria-live="polite">
        <div className="vc-profile-status-heading"><Tag tone={profileReady ? 'success' : analysisState === 'error' ? 'danger' : analysisState === 'warning' ? 'warning' : analysisBusy ? 'info' : 'neutral'}>{profileReady ? t('profileReady') : analysisLabel || t('noImages')}</Tag>{analysisBusy && analysis && <span className="vc-profile-status-count">{analysis.observed} / {analysis.total}</span>}</div>
        {analysisBusy && <picture className="vc-profile-analysis-art" aria-hidden="true"><source media="(prefers-reduced-motion: reduce)" srcSet={analysisPoster} /><img src={analysisTransition ? analysisPoster : analysisAnimation} alt="" width={120} height={120} decoding="async" /></picture>}
        {analysisBusy && analysis && analysis.total > 0 && <div className="vc-profile-analysis-track" role="progressbar" aria-label={t('analysisProgress')} aria-valuemin={0} aria-valuemax={analysis.total} aria-valuenow={analysis.observed}><span style={{ width: `${Math.min(100, analysis.observed / analysis.total * 100)}%` }} /></div>}
      </div>
      {summary && <section className="vc-profile-intro"><h3>{summary.name}</h3><p>{summary.summary}</p></section>}
      {style.modelProfile?.stale && <p className="vc-notice">{t('analysisStale')}</p>}
      <ProfileRules rules={rules} expanded={expandedGroups} onToggle={dimension => setExpandedGroups(current => current.includes(dimension) ? current.filter(value => value !== dimension) : [...current, dimension])} t={t} />
      {!!groups.length && <section className="vc-profile-groups"><div className="vc-readonly-rule-summary"><h3>{t('profileVariants')}</h3></div>{groups.map(group => <DisclosureRow key={group.groupId} className="vc-profile-variant" rowClassName="vc-profile-disclosure-row" contentClassName="vc-profile-disclosure-content" titleClassName="vc-profile-disclosure-title" icon={<ui.IconChevronDownOutlineRegular size={14} />} title={group.name} open={expandedGroups.includes(group.groupId)} expandable expandOnRowClick onToggle={() => setExpandedGroups(current => current.includes(group.groupId) ? current.filter(value => value !== group.groupId) : [...current, group.groupId])}><p className="vc-profile-variant-description">{group.description}</p></DisclosureRow>)}</section>}
      <footer className="vc-profile-actions">
        {task && !referencing && !analysisBusy && (task.status !== 'completed' || task.failed > 0) && <GalleryTaskStatus task={task} t={t} onStop={() => report(() => actions.stopGalleryReferences(task.id))} />}
        <div className="vc-profile-analysis-actions">
          {analysisRecoverable && analysis ? <Button variant="outline" disabled={busy || referencing || !snapshot.configuration.visionConfigured} aria-busy={busy || undefined} onClick={() => report(() => actions.resumeAnalysis(analysis.runId))}>{busy && <StateDot state="ongoing" />}{t('resumeAnalysis')}</Button> : <Button variant="outline" disabled={analysisDisabled || analysisBusy} aria-busy={analysisBusy || undefined} onClick={() => analyze()}>{analysisBusy ? <StateDot state="ongoing" /> : <ui.IconSparkleRegular size={16} />}{t(analysisBusy ? 'analysisBusy' : analysis || style.modelProfile || task && !referencing ? 'resumeAnalysis' : 'analyze')}</Button>}
          {(analysis || style.modelProfile) && <Button variant="outline" disabled={analysisDisabled || analysisBusy} onClick={() => analyze('all')}>{t('reanalyze')}</Button>}
        </div>
        <Button variant="outline" disabled={!summary} onClick={() => setDatasetOpen(true)}>{t('openProfile')}<ui.IconChevronRightOutlineRegular size={14} /></Button>
        <Button variant="ghost" disabled={!analysis} onClick={() => { if (analysis) actions.openAnalysis(analysis.runId) }}><ui.IconListPenOutlineRegular size={16} />{t('analysisProcess')}</Button>
      </footer>
    </>
    const secondaryCreate = workspaceView === 'execution' && !!hasRecoverableRun
    return <div className="vc-image-workspace" data-inspector-open={inspectorOpen && referencesView} data-view={workspaceView}>
      <div className="vc-execution-nav"><SegmentedTabs className="vc-workspace-tabs vc-execution-tabs" variant="underline" label={t('workbench')} value={workspaceView} onChange={onViewChange} items={[{ value: 'references', label: t('referencesView'), id: `${viewId}-references-tab`, panelId: `${viewId}-references` }, { value: 'execution', label: t('execution'), id: `${viewId}-execution-tab`, panelId: `${viewId}-execution` }, { value: 'datasets', label: t('datasets'), id: `${viewId}-datasets-tab`, panelId: `${viewId}-datasets` }]} />
        <div className="vc-reference-actions">{scopeSessionId && onCloseSession && <span className="vc-session-badge"><Tag tone="info">{t('taskSession')}</Tag><Button size="sm" variant="ghost" onClick={onCloseSession}>{t('taskLibrary')}</Button></span>}{referencesView && <>
          <Button ref={inspectorToggle} className="vc-profile-dock-toggle" variant="ghost" aria-label={t('profileInspector')} aria-expanded={inspectorOpen} aria-controls={inspectorId} onClick={() => setInspectorOpen(value => !value)}><ui.IconListPenOutlineRegular size={16} />{t('profileInspector')}{analysisBusy && !inspectorOpen && <Tag tone="info" aria-hidden="true">{t('analysisBusy')}</Tag>}</Button>
          <Button className="vc-profile-modal-toggle" variant="ghost" aria-label={t('profileInspector')} aria-haspopup="dialog" aria-expanded={inspectorModalOpen} onClick={() => setInspectorModalOpen(true)}><ui.IconListPenOutlineRegular size={16} />{t('profileInspector')}{analysisBusy && !inspectorModalOpen && <Tag tone="info" aria-hidden="true">{t('analysisBusy')}</Tag>}</Button>
          <Menu className="vc-import-picker" open={importMenuOpen} onClose={() => setImportMenuOpen(false)} portal compact autoFocus selectedId={`role:${role}`} items={[
            { type: 'label', id: 'import-role', text: t('role') },
            ...(['positive', 'negative'] as const).map(value => ({ id: `role:${value}`, label: t(value) })),
            { type: 'separator', id: 'role-separator' },
            { id: 'local', label: t('referenceLocal'), disabled: busy || referencing }, { id: 'gallery', label: t('galleryReference'), disabled: busy }, { id: 'path', label: t('referenceByPath'), disabled: busy || referencing },
          ]} onSelect={value => { if (value === 'role:positive' || value === 'role:negative') { setRole(value === 'role:positive' ? 'positive' : 'negative'); return }; setImportMenuOpen(false); if (value === 'path') { importTrigger.current?.focus({ preventScroll: true }); setPathError(''); setPathOpen(true) } else if (value === 'gallery') openGalleryFromMenu(); else if (value === 'local') openPaths() }}
            anchor={<Button ref={importTrigger} variant="outline" className="vc-add-reference" disabled={busy} aria-haspopup="menu" aria-expanded={importMenuOpen} onClick={() => setImportMenuOpen(value => !value)}><ui.IconPlusOutlineRegular size={16} />{t('importMaterials')}<ui.IconChevronDownOutlineRegular size={12} /></Button>} />
        </>}
          <Button ref={searchTrigger} variant={secondaryCreate ? 'outline' : 'primary'} className={secondaryCreate ? 'vc-find-action' : 'vc-primary-action vc-find-action'} disabled={!canSearch} onClick={onSearch}><ui.IconSearchOutlineRegular size={16} />{t('newTask')}</Button>
        </div>
      </div>
      <div className="vc-reference-panel" id={`${viewId}-references`} role="tabpanel" aria-labelledby={`${viewId}-references-tab`} hidden={!referencesView}><div className="vc-library-pane">
      <DatasetBackground useDatasets={useDatasets} actions={actions} style={style} t={t} onOpen={() => setDatasetOpen(true)} onView={() => onViewChange('datasets')} />
      {task && referencing && <GalleryTaskStatus task={task} t={t} onStop={() => report(() => actions.stopGalleryReferences(task.id))} />}
      <div className="vc-reference-toolbar"><h2>{t('references')} <span className="vc-count">{style.referenceIds.length}</span></h2>
        <div className="vc-reference-filter"><SelectField label={t('filterRole')} value={filter} options={(['all', 'positive', 'negative', 'undecided'] as const).filter(value => value !== 'undecided' || roleCount(value) || filter === value).map(value => ({ value, label: `${t(value === 'all' ? 'allReferenceTypes' : value)} · ${roleCount(value)}` }))} onChange={value => setFilter(value as typeof filter)} /></div>
        <div className="vc-library-search"><Input icon={<ui.IconSearchOutlineRegular size={16} />} className="vc-image-search" aria-label={t('filterImages')} placeholder={t('searchReferences')} value={query} onChange={event => onQuery(event.target.value)} /></div>
        <div className="vc-view-switch" role="group" aria-label={t('viewMode')}>{(['grid', 'list'] as const).map(value => <Button key={value} size="sm" variant="ghost" aria-pressed={view === value} onClick={() => setView(value)}>{t(value === 'grid' ? 'gridView' : 'listView')}</Button>)}</div>
        {(query || filter !== 'all') && <small className="vc-filter-result" role="status">{t('visibleImages')} {visibleRefs.length}</small>}
      </div>
      <section className="vc-library vc-stack" data-dragging={dragging && !busy}
        onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'none'; setDragging(true) } }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
        onDrop={event => {
          event.preventDefault(); setDragging(false)
          if (busy) return
          // 浏览器 File 不提供可靠的本机绝对路径，不能把文件名猜成路径或回退成复制上传。
          setImports([{ id: 0, name: t('droppedSelection'), size: 0, status: 'failed', reason: 'localPathRequired' }])
        }}>
        {dragging && !busy && <div className="vc-drop-indicator">{t('dropHint')}</div>}
        {visibleRefs.length ? <div className={`vc-image-grid vc-reference-grid${view === 'list' ? ' vc-image-list' : ''}`}>{visibleRefs.map(image => {
          const status = referenceStates.get(image.imageVersionId)
          return <figure key={image.referenceId} style={{ '--vc-image-ratio': image.width / image.height } as React.CSSProperties}>
            <div className="vc-reference-media"><ReferencePreview src={resource(image.thumbnailPath ?? image.previewPath)} href={resource(image.previewPath)} alt={image.name} width={image.width} height={image.height} refreshKey={previewRefresh} t={t} onPreview={() => setPreviewId(image.referenceId ?? image.imageVersionId)} />{status && <Tag className="vc-reference-status" tone={status === 'analyzed' ? 'success' : status === 'needs-update' ? 'warning' : 'neutral'}>{t(status === 'analyzed' ? 'referenceAnalyzed' : status === 'needs-update' ? 'referenceNeedsUpdate' : 'referencePending')}</Tag>}</div>
            <figcaption><span className="vc-image-name" title={image.localPath ?? image.name}>{image.source === 'provider' ? image.name : image.name.split(/[\\/]/).at(-1)}</span><small>{image.width} × {image.height}</small><Tag tone={image.role === 'positive' ? 'info' : image.role === 'negative' ? 'danger' : 'neutral'}>{t(image.role === 'positive' ? 'positive' : image.role === 'negative' ? 'negative' : 'undecided')}</Tag></figcaption>
          </figure>
        })}</div>
          : refs.length ? <div className="vc-empty vc-filter-empty"><ui.IconSearchOutlineRegular size={28} /><h3>{t('noMatches')}</h3><Button variant="outline" onClick={() => { clearQuery(); setFilter('all') }}>{t('resetFilters')}</Button></div>
          : referencing || referencePage?.loading || !referencePage && style.referenceIds.length > 0 ? null : <div className="vc-empty vc-import-empty"><img className="vc-reference-empty-art" src={referenceEmptyArtwork} alt="" width={168} height={126} decoding="async" /><div className="vc-reference-empty-copy"><h3>{t('referenceEmptyTitle')}</h3><p>{t('referenceEmptyHint')}</p><div className="vc-reference-empty-actions"><Button variant="primary" className="vc-primary-action" disabled={busy} onClick={() => setGalleryOpen(true)}><ui.IconFolderOpenOutlineRegular size={16} />{t('galleryReference')}</Button><Button variant="outline" disabled={busy || referencing} onClick={openPaths}><ui.IconPlusOutlineRegular size={16} />{t('referenceLocal')}</Button></div><small>{t('acceptedFormats')}</small></div></div>}
        {(referencing || referencePage?.loading || !referencePage && style.referenceIds.length > 0) && !refs.length && <GallerySkeleton referenceGrid kind="photos" count={Math.min(snapshot.configuration.limits.pageSize, referencing ? task.total : snapshot.configuration.limits.pageSize)} label={t('galleryLoading')} />}
        {snapshot.collectionPaging ? <>
          {(refs.length < (referencePage?.total ?? style.referenceIds.length) || referencePage?.loading) && <div className="vc-reference-loaded" role="status">{t('referenceLoaded')} {refs.length} / {referencePage?.total ?? style.referenceIds.length}</div>}
          {referencePage?.error && <div className="vc-notice" role="alert">{t('referenceLoadError')}<Button size="sm" onClick={() => { void actions.loadReferences(style.styleId, !!referencePage.nextPageToken) }}>{t('retry')}</Button></div>}
          <GalleryLoadMore showSkeleton={false} hasMore={!!referencePage?.nextPageToken} loading={!!referencePage?.loading && refs.length > 0} disabled={!!referencePage?.error} version={`${style.styleId}:${refs.length}:${referencePage?.nextPageToken ?? ''}`} kind="photos" label={t('galleryLoading')} onLoad={() => { void actions.loadMoreImages() }} />
        </> : snapshot.nextPageToken && <Button onClick={() => report(actions.loadMoreImages)}>{t('more')}</Button>}
        {pickerError && <p className="vc-notice" role="alert">{pickerError}</p>}
        {!!imports.length && <section className="vc-import-report" aria-label={t('importResults')}><div className="vc-row"><h3>{t('importResults')}</h3><span role="status" aria-live="polite">{t('imported')} {imports.filter(row => row.status === 'imported').length} / {imports.length}</span></div>
          {imports.some(row => row.status === 'failed' || row.status === 'unconfirmed') && <p role="alert">{t('partialImport')}</p>}
          <div className="vc-import-table-scroll" role="region" aria-label={t('importResults')} tabIndex={0}><table className="vc-import-table"><caption className="vc-sr-only">{t('importResults')}</caption><thead><tr><th scope="col">{t('fileName')}</th><th scope="col">{t('fileSize')}</th><th scope="col">{t('fileStatus')}</th><th scope="col">{t('fileDetails')}</th></tr></thead><tbody>{imports.slice(currentImportPage * importing.pageSize, (currentImportPage + 1) * importing.pageSize).map(row => <tr key={row.id}><th scope="row">{row.name}</th><td>{fileSize(row.size)}</td><td><Tag tone={row.status === 'imported' ? 'success' : row.status === 'failed' ? 'danger' : row.status === 'unconfirmed' ? 'warning' : 'neutral'}>{t(statusKeys[row.status])}</Tag></td><td>{row.reason ? <span>{t(row.reason)}{row.error && <code>{row.error.code}</code>}</span> : row.status === 'imported' ? t('importSaved') : t('importWaiting')}</td></tr>)}</tbody></table></div>
          {importPages > 1 && <div className="vc-import-pagination"><Button size="sm" variant="outline" disabled={!currentImportPage} onClick={() => setImportPage(value => value - 1)}>{t('previousPage')}</Button><span>{currentImportPage + 1} / {importPages}</span><Button size="sm" variant="outline" disabled={currentImportPage + 1 >= importPages} onClick={() => setImportPage(value => value + 1)}>{t('nextPage')}</Button></div>}
        </section>}
      </section>
      {!!refs.length && <p className="vc-reference-purpose"><ui.IconInfoOutlineRegular size={14} />{t('referencePurpose')}</p>}
      </div>
      </div>
      {workspaceView === 'datasets' && <div className="vc-datasets-panel" id={`${viewId}-datasets`} role="tabpanel" aria-labelledby={`${viewId}-datasets-tab`}><DatasetWorkspace useDatasets={useDatasets} actions={actions} t={t} canGenerate={!!style.modelProfile && !style.modelProfile.stale} onGenerate={() => setDatasetOpen(true)} /></div>}
      <aside id={inspectorId} className="vc-profile-dock" hidden={!inspectorOpen || !referencesView} aria-label={t('profileInspector')} onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeInspector() } }}>
        <header className="vc-profile-header"><h2>{t('profileInspector')}</h2><Button size="sm" variant="ghost" onClick={closeInspector}>{t('collapse')}<ui.IconChevronRightOutlineRegular size={14} /></Button></header>
        <div className="vc-profile-content">{profileContent}</div>
      </aside>
      <ImageGallery key={scopeSessionId ?? ''} images={visibleRefs.flatMap(image => { const path = resource(image.previewPath); return path ? [{ id: image.referenceId ?? image.imageVersionId, path, name: image.name }] : [] })} selectedId={referencesView ? previewId : null} onSelect={setPreviewId} onClose={closePreview} t={t} />
      <Modal open={inspectorModalOpen && referencesView} onClose={() => setInspectorModalOpen(false)} title={t('profileInspector')} closeLabel={t('close')} className="vc-profile-modal" contentClassName="vc-profile-modal-scroll"><div className="vc-profile-content">{profileContent}</div></Modal>
      <DatasetDialog useDatasets={useDatasets} onSearch={() => { setDatasetOpen(false); setInspectorModalOpen(false); onSearch() }} open={datasetOpen} onClose={() => setDatasetOpen(false)} onAnalyze={() => { setDatasetOpen(false); analyze() }} canAnalyze={!analysisDisabled && !analysisBusy} style={style} snapshot={snapshot} actions={actions} t={t} busy={busy} />
      <Modal open={!!analysisPlan || analysisStarting} onClose={cancelAnalysisStart} closeOnBackdropClick={false} title={t('analysisSelectionTitle')} closeLabel={t('close')} className="vc-create-modal vc-analysis-start-modal" footer={<div className="vc-task-footer"><Button variant="outline" disabled={analysisStarting && analysisStartMode !== 'planning'} onClick={cancelAnalysisStart}>{t('cancel')}</Button><Button variant={analysisPreference === 'all' ? 'primary' : 'outline'} disabled={!analysisPlan || analysisStarting || analysisDisabled} aria-busy={analysisStartMode === 'all' || undefined} onClick={() => { if (analysisPlan) void launchAnalysis(analysisPlan, 'all') }}>{analysisStartMode === 'all' && <StateDot state="ongoing" />}{t('analysisAllAgain')} {analysisPlan?.total}</Button><Button variant={analysisPreference === 'pending' ? 'primary' : 'outline'} disabled={!analysisPlan || analysisStarting || analysisDisabled} aria-busy={analysisStartMode === 'pending' || undefined} onClick={() => { if (analysisPlan) void launchAnalysis(analysisPlan, 'pending') }}>{analysisStartMode === 'pending' && <StateDot state="ongoing" />}{t(analysisPlan?.pending ? 'analysisPendingOnly' : 'analysisReuseSummary')} {!!analysisPlan?.pending && analysisPlan.pending}</Button></div>}>
        {!analysisPlan && analysisStarting && <div className="vc-analysis-plan-loading" role="status" aria-label={t('analysisPreparing')}><span className="vc-skeleton-fill vc-skeleton-title" /><span className="vc-skeleton-fill" /><span className="vc-skeleton-fill" /></div>}{analysisPlan && <div className="vc-create-form"><div className="vc-row"><Tag tone="success">{t('referenceAnalyzed')} {analysisPlan.reusable}</Tag><Tag tone="info">{t('referencePending')} {analysisPlan.pending - analysisPlan.changed}</Tag>{analysisPlan.changed > 0 && <Tag tone="warning">{t('referenceNeedsUpdate')} {analysisPlan.changed}</Tag>}</div><p>{t('analysisReuseHint')}</p>{analysisPlan.changed > 0 && <p>{t('analysisChangedHint')}</p>}</div>}
      </Modal>
      {galleryOpen && <GalleryReferenceDialog scopeSessionId={scopeSessionId} task={task} config={snapshot.configuration} style={style} role={role} actions={actions} t={t} onClose={() => setGalleryOpen(false)} onManageAccounts={() => { setGalleryOpen(false); openGallerySettings() }} />}
      <Modal open={pathOpen} onClose={() => { if (!busy) setPathOpen(false) }} title={t('referenceByPath')} closeLabel={t('close')} className="vc-create-modal vc-path-modal">
        <form className="vc-create-form" onSubmit={event => { event.preventDefault(); addPath(false) }}>
          <label>{t('pathKind')}<SelectField label={t('pathKind')} value={pathKind} disabled={busy} options={[{ value: 'folder', label: t('folderPath') }, { value: 'file', label: t('imagePath') }]} onChange={value => setPathKind(value as 'file' | 'folder')} /></label>
          <label>{t('originalPath')}<Input data-modal-autofocus value={sourcePath} placeholder={t('pathHint')} disabled={busy} onChange={event => setSourcePath(event.target.value)} /></label>
          <p>{t('localReferenceHint')}</p>{pathError && <p role="alert">{pathError}</p>}
          <div className="vc-row"><Button type="submit" variant="outline" disabled={busy || !sourcePath.trim()}>{t('addLocalReference')}</Button><Button type="button" variant="primary" disabled={busy || !sourcePath.trim() || !snapshot.configuration.visionConfigured} onClick={() => addPath(true)}>{t(busy ? 'busy' : 'referenceAndAnalyze')}</Button></div>
        </form>
      </Modal>
    </div>
  }

  function Workbench({ useWorkbench, useVisionModels, useDatasets, useLaunches, useSearchBatches, actions, t, welcomeImage, logoImage, renderFactorySlot }: WorkbenchProps) {
    const [previewRefresh, setPreviewRefresh] = React.useState(0)
    const selectWorkbench = React.useMemo(createWorkbenchSelector, [])
    const state = useWorkbench(selectWorkbench), snapshot = state.snapshot
    const executionView = state.workspace === 'tasks'
    const setExecutionView = (value: boolean) => actions.selectWorkspace(value ? 'tasks' : 'styles')
    const [libraryView, setLibraryView] = React.useState<'references' | 'datasets'>('references')
    const workspaceView = executionView ? 'execution' : libraryView
    const setWorkspaceView = (value: 'references' | 'execution' | 'datasets') => { if (value !== 'execution') setLibraryView(value); setExecutionView(value === 'execution') }
    const [taskForm, setTaskForm] = React.useState<{ serial: number; imageVersionId?: string; browsingDatasets?: boolean } | null>(null)
    const searchTrigger = React.useRef<HTMLButtonElement>(null)
    const [analysisRequest, setAnalysisRequest] = React.useState<{ styleId: string; serial: number } | null>(null)
    const [tab, setTab] = React.useState<'workbench' | 'settings'>('workbench')
    const [settingsPanel, setSettingsPanel] = React.useState<'vision' | 'source'>('vision')
    const [name, setName] = React.useState(''), [error, setError] = React.useState(''), [working, setWorking] = React.useState(false)
    const [createOpen, setCreateOpen] = React.useState(false)
    const [deleteTarget, setDeleteTarget] = React.useState<{ kind: 'single' | 'all'; targets: Pick<StyleView, 'styleId' | 'name' | 'revision'>[]; operationId: string } | null>(null)
    const [deleteError, setDeleteError] = React.useState('')
    const [deleteProgress, setDeleteProgress] = React.useState(0)
    const [collectionOpen, setCollectionOpen] = React.useState(false)
    const [tasksOpen, setTasksOpen] = React.useState(false)
    const [taskSelection, setTaskSelection] = React.useState({ styleId: state.styleId, runId: '' })
    const [batchDetail, setBatchDetail] = React.useState({ styleId: '', runId: '' })
    const [imageSearch, setImageSearch] = React.useState({ styleId: state.styleId, value: '' })
    // 顶部搜索归属当前素材集，切换时先屏蔽旧条件，再清空本地输入。
    const query = imageSearch.styleId === state.styleId ? imageSearch.value : ''
    React.useEffect(() => { setImageSearch({ styleId: state.styleId, value: '' }) }, [state.styleId])
    const viewId = React.useId()
    const report = (work: () => Promise<unknown>) => {
      if (working) return
      setWorking(true); setError('')
      void work().catch((failure: unknown) => {
        if (failure && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string') setError(`${t('error')} (${failure.code})`)
        else setError(failure instanceof Error && failure.message === 'import-limit' ? t('importLimit') : t('error'))
      }).finally(() => setWorking(false))
    }
    const style = snapshot?.styles.find(item => item.styleId === state.styleId && !item.archived)
    const styles = snapshot?.styles.filter(item => !item.archived) ?? []
    const collectionPreview = style && snapshot?.images.find(image => image.referenceId && style.referenceIds.includes(image.referenceId))
    const canSearch = !!style?.modelProfile && !style.modelProfile.stale && style.modelProfile.options.some(option => option.enabled)
    const referenceTask = state.galleryTasks.find(task => task.styleId === state.styleId)
    const referencing = !!referenceTask && galleryTaskActive(referenceTask.status)
    const headerAnalysis = state.analysisTasks.find(task => task.styleId === state.styleId && analysisActive(task.status)) ?? (style?.analysis && analysisActive(style.analysis.status) ? style.analysis : undefined)
    const headerAnalysisPhase = headerAnalysis && analysisPhaseLabel(t, headerAnalysis.phase)
    const currentAnalysisRun = snapshot?.runs.find(run => run.runId === style?.analysis?.runId)
    // 任务面板默认跟随当前素材集，手动选择仅在该素材集内保留。
    const selectedRun = executionView ? snapshot?.runs.find(run => run.runId === state.runId && (run.kind === 'search' || run.kind === 'crop')) : snapshot?.runs.find(run => run.runId === (taskSelection.styleId === state.styleId ? taskSelection.runId : '')) ?? currentAnalysisRun ?? snapshot?.runs.find(run => run.runId === state.runId && (run.kind !== 'analyze' || run.styleId === state.styleId))
    const historyRuns = snapshot?.runs.filter(run => run.kind !== 'analyze' || run.styleId === state.styleId || run.runId === style?.analysis?.runId).slice().reverse() ?? []
    const orderedRuns = currentAnalysisRun ? [currentAnalysisRun, ...historyRuns.filter(run => run.runId !== currentAnalysisRun.runId)] : historyRuns
    const displayedRuns = executionView ? orderedRuns.filter(run => (run.kind === 'search' || run.kind === 'crop') && (run.runId === state.runId || !run.styleId || run.styleId === state.styleId)) : orderedRuns
    const requestReanalysis = (styleId: string) => {
      actions.closeAnalysis(); if (state.scopeSessionId) actions.closeSession(); actions.selectStyle(styleId); actions.selectWorkspace('styles')
      setTab('workbench'); setWorkspaceView('references'); setAnalysisRequest({ styleId, serial: Date.now() })
    }
    const startSearch = () => { searchTrigger.current?.focus({ preventScroll: true }); setTaskForm(current => current?.browsingDatasets ? { ...current, browsingDatasets: false } : { serial: Date.now() }) }
    // 引导按钮会随页面切换卸载；先将焦点交回仍保留的参考标签。
    const showReferences = () => { document.getElementById(`${viewId}-references-tab`)?.focus({ preventScroll: true }); setWorkspaceView('references') }
    const loadedReferences = style && snapshot ? filterReferences(snapshot.images, style, '', 'all').length : 0
    const activeTasks = snapshot?.runs.filter(run => ['created', 'running', 'pausing', 'cancelling'].includes(run.status)).length ?? 0
    const createCollection = () => report(async () => {
      const result = await actions.execute('style-create', { operationId: id(), name: name.trim() })
      actions.selectStyle(resultId(result)); actions.selectWorkspace('styles'); setName(''); setTab('workbench'); setCreateOpen(false)
    })
    const deleteCollection = () => {
      if (!deleteTarget) return
      const target = deleteTarget
      report(async () => {
        setDeleteError(''); setDeleteProgress(0)
        const result = await archiveCollections(actions, target.targets, target.operationId, setDeleteProgress)
        if (result.status === 'completed') {
          setDeleteTarget(null); setDeleteError('')
        } else setDeleteError(`${result.failedName} · ${t(result.conflict ? 'deleteCollectionChanged' : 'deleteCollectionFailed')}`)
      })
    }
    return <div className="vc-page-frame"><section className="vc-workbench" data-welcome={!!snapshot && !style && tab !== 'settings'} aria-label={t('title')} aria-busy={working || state.loading}>
      <header className="vc-pagebar"><div className="vc-collection-context"><Menu className="vc-collection-picker" open={collectionOpen} onClose={() => setCollectionOpen(false)} portal compact autoFocus
        selectedId={style ? `style:${style.styleId}` : undefined}
        items={styles.map(item => { const task = state.galleryTasks.find(task => task.styleId === item.styleId && galleryTaskActive(task.status)); const analysis = state.analysisTasks.find(task => task.styleId === item.styleId && analysisActive(task.status)); return { id: `style:${item.styleId}`, label: <span className="vc-collection-task-label"><span>{item.name}</span>{(task || analysis) && <><StateDot state="ongoing" /><small>{task ? `${galleryTaskProgress(task).referenced} / ${task.total}` : `${analysis!.observed} / ${analysis!.total}`}</small></>}</span> } })}
        footer={[{ id: 'create-collection', label: t('create'), icon: <ui.IconPlusOutlineRegular size={14} />, disabled: working || !snapshot },
          ...(style ? [{ id: 'delete-collection', label: t('deleteCurrentCollection'), icon: <ui.IconTrashOutlineRegular size={14} />, danger: true, disabled: working || referencing || !!style.analysis && analysisActive(style.analysis.status) }] : []),
          { id: 'delete-all-collections', label: t('deleteAllCollections'), icon: <ui.IconTrashOutlineRegular size={14} />, danger: true, disabled: working || !styles.length || state.galleryTasks.some(task => galleryTaskActive(task.status)) || state.analysisTasks.some(task => analysisActive(task.status)) }]}
        onSelect={value => {
          setCollectionOpen(false)
          if (value === 'create-collection') { setError(''); setCreateOpen(true) }
          else if (value === 'delete-collection' && style) { setDeleteError(''); setDeleteProgress(0); setDeleteTarget({ kind: 'single', targets: [{ styleId: style.styleId, name: style.name, revision: style.revision }], operationId: id() }) }
          else if (value === 'delete-all-collections') { setDeleteError(''); setDeleteProgress(0); setDeleteTarget({ kind: 'all', targets: styles.map(item => ({ styleId: item.styleId, name: item.name, revision: item.revision })), operationId: id() }) }
          else { actions.selectStyle(value.slice('style:'.length)); setTab('workbench') }
        }}
        anchor={<Button className="vc-collection-trigger" variant="ghost" disabled={!snapshot} aria-label={t('chooseCollection')} aria-haspopup="menu" aria-expanded={collectionOpen}
          onClick={() => setCollectionOpen(value => !value)} onKeyDown={event => { if (!collectionOpen && event.key === 'ArrowDown') { event.preventDefault(); setCollectionOpen(true) } }}>
          <img className={collectionPreview ? 'vc-collection-preview' : 'vc-collection-logo'} src={collectionPreview ? resource(collectionPreview.thumbnailPath ?? collectionPreview.previewPath) : logoImage} onError={event => { if (event.currentTarget.src !== logoImage) event.currentTarget.src = logoImage }} alt="" width={32} height={32} draggable={false} /><span className="vc-collection-copy"><span className="vc-collection-name">{style?.name ?? t('styles')}</span>{style?.modelProfile && <span className="vc-collection-meta">v{style.modelProfile.revision}</span>}</span><ui.IconChevronDownOutlineRegular size={12} />
        </Button>} />
        {style?.releases.length ? <div className="vc-context-meta"><Tag>{style.releases.at(-1)?.label}</Tag></div> : null}
        {style && tab === 'workbench' && (headerAnalysis ? <Button size="sm" variant="ghost" className="vc-search-launch-trigger vc-analysis-header" aria-label={`${t('analysisProcess')} · ${headerAnalysisPhase} · ${headerAnalysis.observed} / ${headerAnalysis.total}`} onClick={() => actions.openAnalysis(headerAnalysis.runId)}><StateDot state="ongoing" /><span className="vc-search-launch-trigger-label">{t('analysisProcess')}</span><span className="vc-search-launch-trigger-state" aria-live="polite">{headerAnalysisPhase}</span><small>{headerAnalysis.observed} / {headerAnalysis.total}</small><ui.IconChevronRightOutlineRegular size={12} /></Button> : <SearchLaunch.Background inline useLaunches={useLaunches} actions={actions.launches} t={t} />)}</div>
        {snapshot && <><SegmentedTabs className="vc-primary-tabs" label={t('title')} value={tab} onChange={setTab}
          items={[{ value: 'workbench', label: t('workbench'), id: `${viewId}-workbench-tab`, panelId: `${viewId}-workbench` }, { value: 'settings', label: t('modelSettings'), id: `${viewId}-settings-tab`, panelId: `${viewId}-settings` }]} /><div className="vc-command-actions"><span className="vc-model-state"><StateDot state={snapshot.configuration.visionConfigured ? 'done' : 'idle'} />{t('vision')} · {t(snapshot.configuration.visionConfigured ? 'configured' : 'unconfigured')}</span><Button variant="ghost" disabled={working} onClick={() => { setPreviewRefresh(value => value + 1); report(actions.reload) }}><ui.IconRefreshOutlineRegular size={16} />{t('refresh')}</Button></div></>}
      </header>
      {state.scopeSessionId && (!style || tab !== 'workbench') && <div className="vc-execution-nav vc-session-scope"><span>{t('taskSession')}</span><Button size="sm" variant="outline" onClick={actions.closeSession}>{t('taskLibrary')}</Button></div>}
      <main className={`vc-main${style && tab === 'workbench' ? ' vc-main-workspace' : ''}`}>
        {(error || state.error) && <div className="vc-notice" role="alert">{error || `${t('error')} (${state.error?.code})`}<Button size="sm" onClick={() => report(actions.reload)}>{t('retry')}</Button></div>}
        {state.galleryTaskError && <div className="vc-notice" role="alert">{t('galleryConnectionError')}</div>}
        {!snapshot && (state.loading && executionView ? <div className="vc-search-batches" aria-busy="true"><div className="vc-search-batches-scroll"><BatchSkeleton label={t('taskBatchLoading')} /></div></div> : <div className="vc-empty">{state.loading ? <StateDot state="ongoing" /> : <Button onClick={() => report(actions.reload)}>{t('retry')}</Button>}</div>)}
        {/* 参考区保留草稿和筛选；任务折叠区按 Tab 重建，避免退出动画保留另一页内容。 */}
        {snapshot && <>
          <div className={style ? 'vc-workbench-panel' : undefined} id={`${viewId}-workbench`} role="tabpanel" aria-labelledby={`${viewId}-workbench-tab`} hidden={tab !== 'workbench'}>{style ? <StyleEditor useDatasets={useDatasets} onSearch={startSearch} canSearch={canSearch} hasRecoverableRun={!!selectedRun && ['created', 'running', 'pausing', 'paused', 'interrupted'].includes(selectedRun.status)} scopeSessionId={state.scopeSessionId} onCloseSession={actions.closeSession} searchTrigger={searchTrigger} pendingStart={state.pending.includes(`analysis:${style.styleId}`)} analysisRequest={analysisRequest?.styleId === style.styleId ? analysisRequest.serial : undefined} onAnalysisRequestHandled={() => setAnalysisRequest(null)} key={style.styleId} task={referenceTask} referencePage={state.referencePages[style.styleId]} previewRefresh={previewRefresh} style={style} snapshot={snapshot} actions={actions} t={t} report={report} busy={working} query={query} onQuery={value => setImageSearch({ styleId: state.styleId, value })} clearQuery={() => setImageSearch({ styleId: state.styleId, value: '' })} openGallerySettings={() => { setSettingsPanel('source'); setTab('settings') }} workspaceView={workspaceView} viewId={viewId} onViewChange={value => { setWorkspaceView(value); if (value === 'execution') { const run = orderedRuns.find(item => (item.kind === 'search' || item.kind === 'crop') && item.styleId === state.styleId); if (run) actions.selectRun(run.runId) } }} />
            : <section className="vc-welcome"><img className="vc-welcome-art" src={welcomeImage} alt="" width={558} height={242} decoding="async" /><h2>{t('welcomeTitle')}</h2><p>{t('welcomeHint')}</p><Button variant="primary" className="vc-primary-action vc-welcome-create" disabled={working} onClick={() => { setError(''); setCreateOpen(true) }}><ui.IconPlusOutlineRegular size={18} />{t('createCollectionAction')}</Button><small>{t('welcomeFormats')}</small></section>}
        {workspaceView !== 'datasets' && (snapshot.runs.length > 0 || !!style?.referenceIds.length || executionView) && (executionView
          ? <div className="vc-history-region" data-execution="true" id={`${viewId}-execution`} role="tabpanel" aria-labelledby={`${viewId}-execution-tab`}><div className="vc-task-panel vc-execution-panel">{useSearchBatches && actions.batches && style && !(batchDetail.styleId === style.styleId && batchDetail.runId) ? <SearchBatchResults styleId={style.styleId} t={t} useBatches={useSearchBatches} actions={actions.batches} onOpen={async (runId, sessionId) => { if (sessionId) await actions.openSession(sessionId); actions.selectRun(runId); setBatchDetail({ styleId: style.styleId, runId }) }} /> : <div className="vc-search-batch-detail">{useSearchBatches && <Button size="sm" variant="ghost" onClick={() => { setBatchDetail({ styleId: '', runId: '' }); actions.closeSession(); actions.batches?.select('') }}>{t('taskAllBatches')}</Button>}<TaskHistory onStart={canSearch ? startSearch : undefined} onReferences={showReferences} onCrop={imageVersionId => setTaskForm({ serial: Date.now(), imageVersionId })} runs={displayedRuns} selected={selectedRun} snapshot={snapshot} t={t} loading={state.runLoading} pending={state.pending} errorCode={state.runError?.code} actions={actions} onSelect={runId => { setTaskSelection({ styleId: state.styleId, runId }); actions.selectRun(runId) }} report={report} /></div>}</div></div>
          : <div className="vc-history-region" data-execution="false"><DisclosureRow key="history" className="vc-task-section" rowClassName="vc-task-toggle" leadingClassName="vc-task-chevron" previewChevron={false} icon={<ui.IconChevronDownOutlineRegular size={14} />} title={t('taskHistory')} open={tasksOpen} expandable expandOnRowClick onToggle={() => setTasksOpen(value => !value)} headerAccessory={<span className="vc-task-meta"><span className="vc-task-count">{displayedRuns.length}</span>{activeTasks > 0 && <small><StateDot state="ongoing" />{t('running')} · {activeTasks}</small>}</span>}><div className="vc-task-panel"><TaskHistory onCrop={imageVersionId => setTaskForm({ serial: Date.now(), imageVersionId })} runs={displayedRuns} selected={selectedRun} snapshot={snapshot} t={t} loading={state.runLoading} pending={state.pending} errorCode={state.runError?.code} actions={actions} onSelect={runId => { setTaskSelection({ styleId: state.styleId, runId }); actions.selectRun(runId) }} report={report} />{style && <div className="vc-task-notes" role="note"><div className="vc-library-caption"><span>{t('loadedImages')} {loadedReferences} / {style.referenceIds.length}</span><span>{t('previewHint')}</span></div><p className="vc-task-analysis-note"><ui.IconSparkleRegular size={14} />{t('modelNotes')}</p></div>}</div></DisclosureRow></div>)}
          </div>
          <div id={`${viewId}-settings`} role="tabpanel" aria-labelledby={`${viewId}-settings-tab`} hidden={tab !== 'settings'}>{tab === 'settings' && <Configuration useVisionModels={useVisionModels} saving={state.configSaving} saveError={state.configError} config={snapshot.configuration} actions={actions} t={t} report={report} styles={styles} selectedStyleId={state.styleId} initialPanel={settingsPanel} openWorkbench={styleId => { actions.selectStyle(styleId); setTab('workbench') }} />}</div>
        </>}
      </main>
      {taskForm && style && snapshot && (taskForm.imageVersionId ? <TaskDialog open={tab === 'workbench'} key={`${style.styleId}:${state.scopeSessionId}:${taskForm.serial}`} style={style} snapshot={snapshot} actions={actions} t={t} imageVersionId={taskForm.imageVersionId} onClose={() => setTaskForm(null)} onSettings={() => setTab('settings')} onStarted={runId => { setTaskForm(null); actions.selectRun(runId); setExecutionView(true) }} /> : <SearchLaunch.Dialog open={tab === 'workbench' && !taskForm.browsingDatasets} key={`${style.styleId}:${state.scopeSessionId}:${taskForm.serial}`} style={style} snapshot={snapshot} actions={actions.launches} useLaunches={useLaunches} t={t} onClose={() => setTaskForm(null)} onDatasets={datasetId => { setTaskForm(current => current ? { ...current, browsingDatasets: true } : null); setWorkspaceView('datasets'); if (datasetId) void actions.datasets.open(datasetId) }} />)}
      <AnalysisDialogRegion useWorkbench={useWorkbench} actions={actions} t={t} renderFactorySlot={renderFactorySlot} onReanalyze={requestReanalysis} />
      <Modal open={createOpen} onClose={() => { if (!working) setCreateOpen(false) }} title={t('create')} closeLabel={t('close')} className="vc-create-modal"><CreateCollection name={name} onName={setName} onSubmit={createCollection} busy={working} error={error} t={t} /></Modal>
      <Modal open={!!deleteTarget} onClose={() => { if (!working) setDeleteTarget(null) }} title={t(deleteTarget?.kind === 'all' ? 'deleteAllCollections' : 'deleteCollection')} closeLabel={t('close')} className="vc-delete-modal"
        footer={<div className="vc-dataset-actions"><Button variant="outline" disabled={working} onClick={() => setDeleteTarget(null)}>{t('cancel')}</Button><Button variant="primary" disabled={working || !deleteTarget?.targets.length} onClick={deleteCollection}>{working && <StateDot state="ongoing" />}{t(working ? 'busy' : deleteTarget?.kind === 'all' ? 'deleteAllCollections' : 'deleteCollection')}</Button></div>}>
        {deleteTarget?.kind === 'all' ? <><p>{t('deleteAllCollectionsHint')} <Tag>{deleteTarget.targets.length}</Tag></p><ul className="vc-delete-list">{deleteTarget.targets.map(item => <li key={item.styleId}>{item.name}</li>)}</ul></> : <p className="vc-delete-name">{deleteTarget?.targets[0]?.name}</p>}
        <p>{t('deleteCollectionHint')}</p>{!!deleteTarget && (working || deleteProgress > 0) && <p className="vc-delete-progress" role="status">{t('deleteCollectionsProgress')} {deleteProgress} / {deleteTarget.targets.length}</p>}{deleteError && <p className="vc-notice" role="alert">{deleteError}</p>}
      </Modal>
    </section></div>
  }
  return Workbench
}
