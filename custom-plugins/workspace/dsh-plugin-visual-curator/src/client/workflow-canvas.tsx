/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Batch summaries and independent image workflows reuse saved task evidence and existing actions. */
import { ReactFlow, Background, MiniMap, Handle, Position, Panel, NodeResizer, MarkerType, SelectionMode, useViewport, useReactFlow, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react'
import type { WorkbenchProps } from './workbench.tsx'
import type { ImageView, ReferencePageView, StyleView, StyleAnalysisView } from './contract.ts'
import type { AnalysisTask } from '../shared/analysis-process.ts'
import type { GalleryTaskView } from '../shared/gallery-task.ts'
import { galleryTaskActive } from '../shared/gallery-task.ts'
import { analysisActive } from '../shared/analysis-process.ts'
import type { DatasetClientState } from './dataset-store.ts'
import { datasetActive } from './dataset-store.ts'
import type { DatasetEntry } from '../shared/datasets.ts'
import type { SearchBatch } from '../shared/search-batches.ts'
import type { SearchBatchesState, SearchBatchesStore } from './search-batches-store.ts'
import type { SearchLaunchDraft } from './search-launch-store.ts'
import type { SearchLaunchView } from '../shared/search-launch.ts'
import type { WorkflowHistoryTarget } from '../shared/workflow-history.ts'
import { preferredWorkflowBatch, workflowWallpaperPhase, workflowBatchPhase, workflowReferencePhase } from './workflow-current-task.ts'
import { createWorkflowEdge, type WorkflowEdge } from './workflow-edge.tsx'
import { wallpaperStage, workflowPhase, workflowPhaseKeys, type WorkflowPhase, type WallpaperStep } from './workflow-node-state.ts'
import { createCanvasStyleSidebar } from './canvas-style-sidebar.tsx'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'
import { createImageGallery } from './image-gallery.tsx'
import { createReferencePreview } from './reference-preview.tsx'
import { createSelectField } from './select-field.tsx'
import { createWorkflowCanvasLayout, type WorkflowNodeKind } from './workflow-canvas-layout.ts'
import { createWallpaperCanvas, type WallpaperInvoke } from './wallpaper-canvas.tsx'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { fixedImageWorkflowNodeId, imageWorkflowStages, type ImageWorkflowStage, planningImageLane, imageWorkflowPhase } from './workflow-image-branches.ts'
type WallpaperController = ReturnType<ReturnType<typeof createWallpaperCanvas>['useWallpaper']>

/** Current collection and task actions; historical nodes use the task's frozen source metadata. */
export interface AutomaticWorkflowContext {
  style: StyleView; referenceImages: ImageView[]; referencePage: Pick<ReferencePageView, 'total' | 'counts'> | undefined
  referenceTask: GalleryTaskView | undefined; analysis: AnalysisTask | StyleAnalysisView | undefined
  busy: boolean; canSearch: boolean; useDatasets: WorkbenchProps['useDatasets']
  onReferences(): void; onAnalyze(): void; onAnalysis(runId: string): void
  onDatasets(id?: string): void; onRefreshDatasets(): void; onGenerateDataset(): void; onOrganize(): void; onSearch(notes?: string): void
  onCrop(batch: SearchBatch, imageId: string): Promise<void>
  wallpaper?: WallpaperInvoke; onWallpaperSearch?(notes?: string): void; pollIntervalMs?: number
  useLaunches: WorkbenchProps['useLaunches']; launches: WorkbenchProps['actions']['launches']
  profileActions: Pick<WorkbenchProps['actions'], 'execute' | 'reconcileProfile'>; onProfile(): void
}

/** Narrow result observation remains independent of the selected task Session. */
export interface AutomaticWorkflowProps {
  styleId: string; pageSize?: number; t: WorkbenchText; workflow: AutomaticWorkflowContext
  useBatches<T>(select: (state: SearchBatchesState) => T): T
  actions: Pick<SearchBatchesStore, 'watch' | 'select' | 'refresh' | 'more' | 'moreImages' | 'remove' | 'removeWorkflow'>
  onOpen(runId: string, sessionId?: string): Promise<void>
}

const preparedSession = (launch: LaunchCard) => launch.sessionReady === false || ['preparing', 'creating-session', 'unknown', 'rejected'].includes(launch.stage) ? undefined : launch.sessionId
type LaunchCard = { id: string; input: SearchLaunchDraft; stage: SearchLaunchView['stage'] | 'unknown' | 'rejected'; status: string; sessionId?: string; sessionReady?: boolean; stopping?: boolean; createdAt?: string; errorCode?: string }
type Lane = { id: string; batch?: SearchBatch; launch?: LaunchCard }
type Removal = { target: WorkflowHistoryTarget; label: string; active: boolean; operationId: string }
type NodeData = {
  image?: { id: string; index: number; stage: ImageWorkflowStage }
  processing?: boolean; finals?: boolean
  kind: WorkflowNodeKind; phase: WorkflowPhase; size: { width: number; height?: number | undefined }; resize(value: { width: number; height: number }): void; beginResize(): void; endResize(): void; resetSize(): void; laneId: string; label: string; launch: LaunchCard | undefined; focused: boolean; collapsed: boolean; collapse(): void; focus(): void; settings(): void; context: AutomaticWorkflowContext; t: WorkbenchText; dataset: DatasetEntry | undefined
  datasets: DatasetClientState; batch: SearchBatch | undefined; loading: boolean; opening: boolean; refreshKey: number; pageSize: number
  preview(imageId: string): void; resume(): void; open(): void; crop(imageId: string): void; remove(): void; moreImages(): Promise<void>
  deleting: boolean; hasInput: boolean; hasOutput: boolean; wallpaper: WallpaperController
  appearances: Set<string>
  receiving: boolean
}
type FlowNode = Node<NodeData, 'workflow'>

const activeTask = (status: string) => ['created', 'running', 'pausing', 'cancelling'].includes(status)
const removable = (status: string) => ['completed', 'failed', 'cancelled'].includes(status)
const stoppableLaunch = (launch: LaunchCard) => !launch.stopping && ['working', 'accepted'].includes(launch.status)
function nodePhase(data: Pick<NodeData, 'kind' | 'context' | 'batch' | 'dataset' | 'launch' | 'focused' | 'wallpaper'>): WorkflowPhase {
  const { kind, batch, context, dataset, launch } = data
  if (kind === 'downloading' || kind === 'planning' || kind === 'rendering' || kind === 'reviewing') {
    const detail = data.focused ? data.wallpaper.value : null, summary = batch?.wallpaper
    if (detail) return wallpaperStage(kind, detail.status, detail.total, detail.counts).phase
    if (summary) return wallpaperStage(kind, summary.status, summary.total, summary.counts ?? { planned: summary.planned, rendered: summary.rendered, reviewed: summary.reviewed, passed: summary.passed }).phase
    if (batch?.postProcessingError) return kind === 'downloading' ? 'failed' : 'blocked'
    if (batch?.status === 'cancelled') return 'cancelled'
    if (batch?.status === 'failed' || batch?.status === 'completed' && !batch.matched) return 'blocked'
    return 'queued'
  }
  if (kind === 'results') return batch ? workflowPhase(batch.status) : launch?.status === 'working' ? 'running' : launch?.status === 'accepted' ? 'queued' : launch?.status === 'unknown' ? 'attention' : launch?.status === 'rejected' ? 'failed' : workflowPhase(launch?.status)
  if (kind === 'dataset') {
    if (launch?.stage === 'preparing-dataset' && launch.status === 'working') return 'running'
    if (!batch && !launch) {
      if (context.analysis && analysisActive(context.analysis.status)) return activeTask(context.analysis.status) && context.analysis.total > 0 && context.analysis.observed >= context.analysis.total ? 'running' : 'queued'
      if (context.referenceTask && galleryTaskActive(context.referenceTask.status)) return 'queued'
      if (!dataset && context.analysis?.status === 'failed') return 'blocked'
    }
    return dataset ? workflowPhase(dataset.status) : 'queued'
  }
  if (batch?.workflowSource) return 'completed'
  const current = context.referenceTask && galleryTaskActive(context.referenceTask.status) ? 'running' : workflowPhase(context.analysis?.status)
  return workflowReferencePhase(current, launch?.input.modelProfileId, context.style.modelProfile?.id, dataset)
}
function connection(id: string, source: string, target: string, phase: WorkflowPhase, rework = false, label?: string, waitingForInput = false, motionPaused = false): WorkflowEdge {
  const flowing = phase === 'running' || waitingForInput
  return { id, source, target, type: 'workflow', data: { phase, rework, flowing, motionPaused }, ...(label ? { label } : {}), ...(flowing ? { markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, markerUnits: 'userSpaceOnUse', color: 'var(--dsw-alias-link)' } } : {}) }
}

/** @param React Shared application runtime. @param ui Existing controls and preview primitives. @returns Automatic workflow canvas with local-only geometry and existing business actions. */
export function createAutomaticWorkflowCanvas(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Tag, StateDot, ZoomControls, AnimatedCollapse, Modal } = ui
  const ReferencePreview = createReferencePreview(React, ui), ImageGallery = createImageGallery(React, ui), SelectField = createSelectField(React, ui)
  const useLayout = createWorkflowCanvasLayout(React), StyleSidebar = createCanvasStyleSidebar(React, ui)
  const { useWallpaper, ImageNavigator, ImageStepCard, Dialogs: WallpaperDialogs } = createWallpaperCanvas(React, ui)
  const resource = (path: string) => { const safe = safeResourcePath(path); return safe ? new URL(safe.slice(1), document.baseURI).href : undefined }

  function ReferencesNode({ data }: { data: NodeData }) {
    const strip = React.useRef<HTMLDivElement>(null)
    const scroll = (direction: number) => { const element = strip.current; if (element) element.scrollBy({ left: direction * element.clientWidth, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }) }
    const { context, batch, t } = data, frozen = batch?.workflowSource
    const preparingOlderProfile = !!data.launch && data.launch.input.modelProfileId !== context.style.modelProfile?.id
    const counts = frozen ?? (preparingOlderProfile && data.dataset ? data.dataset.counts : { references: context.referencePage?.total ?? context.style.referenceIds.length, ...(context.referencePage?.counts ?? { positive: 0, negative: 0, undecided: 0 }) })
    const analysis = !preparingOlderProfile && (!frozen || frozen.analysisRunId === context.analysis?.runId) ? context.analysis : undefined
    const analysisRunId = frozen?.analysisRunId ?? analysis?.runId
    const importing = context.referenceTask && galleryTaskActive(context.referenceTask.status)
    const previews = !preparingOlderProfile && (!frozen || frozen.modelProfileId === context.style.modelProfile?.id && !context.style.modelProfile?.stale) ? context.referenceImages.slice(0, 4) : []
    const rolesKnown = preparingOlderProfile ? !!data.dataset : !!frozen || !!context.referencePage
    return <div className="vc-flow-node-body nodrag nopan nowheel">
      <div className="vc-flow-metrics"><strong>{preparingOlderProfile && !data.dataset ? '—' : counts.references}</strong><span>{t('datasetImagesUnit')}</span>{rolesKnown && <><span>{t('datasetPositiveLabel')} <b>{counts.positive}</b></span><span>{t('datasetNegativeLabel')} <b>{counts.negative}</b></span></>}</div>
      <p className="vc-flow-muted">{t(frozen || preparingOlderProfile ? 'workflowFrozenReferences' : 'workflowCurrentReferences')}{frozen ? ` · v${frozen.revision}` : preparingOlderProfile && data.dataset ? ` · v${data.dataset.profileRevision}` : ''}</p>
      {!!previews.length && <><div className="vc-flow-reference-controls"><Button size="sm" variant="ghost" aria-label={t('imagePrevious')} onClick={() => scroll(-1)}><ui.IconChevronLeftOutlineRegular size={14} /></Button><Button size="sm" variant="ghost" onClick={context.onReferences}>{t('workflowViewAllReferences').replace('{count}', String(counts.references))}</Button><Button size="sm" variant="ghost" aria-label={t('imageNext')} onClick={() => scroll(1)}><ui.IconChevronRightOutlineRegular size={14} /></Button></div><div ref={strip} className="vc-flow-reference-previews" tabIndex={0} role="group" aria-label={t('workflowCurrentReferences')} onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); event.stopPropagation(); scroll(event.key === 'ArrowLeft' ? -1 : 1) } }}>{previews.map(image => { const path = resource(image.previewPath); return path ? <ReferencePreview key={image.imageVersionId} src={path} href={path} alt={image.name} width={image.width} height={image.height} refreshKey={data.refreshKey} t={t} /> : null })}</div></>}
      {analysis ? <div className="vc-flow-progress"><StateDot state={analysisActive(analysis.status) ? 'ongoing' : analysis.status === 'completed' ? 'done' : 'warning'} /><span>{t(analysis.status)}</span><small>{analysis.observed} / {analysis.total}</small></div> : <p className="vc-flow-muted">{t(importing ? 'workflowImporting' : frozen ? 'workflowSnapshot' : 'workflowWaitingAnalysis')}</p>}
      <div className="vc-flow-node-actions"><Button size="sm" variant="outline" onClick={context.onReferences}>{t(frozen ? 'workflowCurrentReferences' : 'workflowImport')}</Button>
        {analysisRunId && <Button size="sm" variant="ghost" onClick={() => context.onAnalysis(analysisRunId)}>{t('workflowAnalysisDetails')}</Button>}
        <Button size="sm" variant="outline" disabled={context.busy || !!importing || !!context.analysis && analysisActive(context.analysis.status)} onClick={context.onAnalyze}>{t(frozen ? 'workflowAnalyzeAgain' : 'workflowAnalyze')}</Button>
      </div>
    </div>
  }

  function DatasetNode({ data }: { data: NodeData }) {
    const { dataset, context, batch, datasets, t } = data
    const frozen = batch?.workflowSource
    const current = !batch && (!data.launch || data.launch.input.modelProfileId === context.style.modelProfile?.id) && (!frozen || frozen.modelProfileId === context.style.modelProfile?.id && frozen.analysisRunId === context.analysis?.runId && !context.style.modelProfile?.stale)
    const analyzing = current && !!context.analysis && analysisActive(context.analysis.status)
    const generating = !!dataset && datasetActive(dataset.status) || current && datasets.submissions.some(item => item.styleId === context.style.styleId)
    return <div className="vc-flow-node-body nodrag nopan nowheel">
      {datasets.error && <div className="vc-notice" role="alert">{t('datasetLoadError')}<Button size="sm" variant="ghost" onClick={context.onRefreshDatasets}>{t('retry')}</Button></div>}
      {!dataset && frozen && <div className="vc-flow-node-badges"><Tag>v{frozen.revision}</Tag><span className="vc-flow-muted">{t('workflowSnapshot')}</span></div>}
      {dataset && !analyzing ? <><div className="vc-flow-node-badges"><Tag>v{dataset.profileRevision}</Tag><Tag tone={dataset.sampleScope === 'all' ? 'info' : 'neutral'}>{t(dataset.sampleScope === 'all' ? 'datasetStylePackage' : 'datasetObservationPackage')}</Tag><Tag tone={dataset.status === 'completed' ? 'success' : 'neutral'}>{t(dataset.status)}</Tag></div>
        <div className="vc-flow-metrics"><strong>{dataset.counts.references}</strong><span>{t('datasetImagesUnit')}</span></div>
        <div className="vc-flow-facts"><span>{t('datasetPositiveLabel')} <b>{dataset.counts.positive}</b></span><span>{t('datasetNegativeLabel')} <b>{dataset.counts.negative}</b></span><span>{t('datasetMatchingRules')} <b>{dataset.counts.rules} / {dataset.counts.candidates}</b></span></div>
      </> : <p className="vc-flow-muted" role="status">{t(generating ? 'workflowGeneratingDataset' : analyzing ? 'workflowWaitingDatasetInput' : frozen ? 'workflowDatasetUnavailable' : 'workflowWaitingDataset')}</p>}
      {generating && <div className="vc-flow-progress"><StateDot state="ongoing" /><span>{t('workflowGeneratingDataset')}</span></div>}
      <div className="vc-flow-node-actions">
        {dataset || !frozen ? <Button size="sm" variant="outline" onClick={() => context.onDatasets(dataset?.id)}>{t('workflowDatasetDetails')}</Button> : <Button size="sm" variant="outline" disabled={data.opening} onClick={data.open}>{t('taskRunInformation')}</Button>}
        {current && !dataset && context.style.modelProfile && <Button size="sm" variant="outline" disabled={generating || analyzing || context.busy || context.style.modelProfile.stale} onClick={context.onGenerateDataset}>{t('workflowCreateDataset')}</Button>}
        {current && <Button size="sm" variant="ghost" disabled={generating || analyzing || context.busy} onClick={context.onOrganize}>{t('workflowOrganizeAgain')}</Button>}

      </div>
    </div>
  }

  function ResultsNode({ data }: { data: NodeData }) {
    const { batch, t } = data
    const [page, setPage] = React.useState({ runId: batch?.runId, index: 0 })
    if (!batch) return <PreparationNode data={data} />
    const count = Math.max(1, Math.min(4, data.pageSize || 4)), index = page.runId === batch.runId ? Math.min(page.index, Math.max(0, Math.ceil(batch.images.length / count) - 1)) : 0
    const visible = batch.images.slice(index * count, (index + 1) * count)
    const next = async () => {
      const nextIndex = index + 1
      if (nextIndex * count >= batch.images.length) await data.moreImages()
      setPage({ runId: batch.runId, index: nextIndex })
    }
    return <div className="vc-flow-node-body vc-flow-results-body nodrag nopan nowheel">
      <div className="vc-flow-result-heading"><div className="vc-flow-node-badges"><Tag tone="info">{t(batch.kind === 'crop' ? 'cropKind' : 'searchKind')}</Tag><Tag tone={batch.status === 'failed' ? 'danger' : batch.status === 'completed' ? 'success' : 'neutral'}>{t(batch.status)}</Tag></div><time dateTime={batch.createdAt}>{new Date(batch.createdAt).toLocaleString()}</time></div>
      {batch.taskBrief && <p className="vc-flow-task-brief">{batch.taskBrief}</p>}
      <div className="vc-flow-metrics"><strong>{batch.matched}</strong>{batch.targetCount && <span>/ {batch.targetCount}</span>}<span>{t(batch.previewOnly ? 'taskPreviewMatched' : 'workflowMatchedResult')}</span></div>
      {batch.status === 'completed' && batch.targetCount && batch.matched < batch.targetCount && <Tag tone="warning">{t('workflowTargetUnmet')}</Tag>}
      {(batch.errorCode || batch.postProcessingError && !batch.wallpaper) && <div className="vc-notice" role="alert">{t(batch.postProcessingError ? 'workflowHandoffFailed' : 'wallpaperTechnicalFailure')} <code>{batch.postProcessingError ?? batch.errorCode}</code></div>}
      {batch.status === 'completed' && !batch.wallpaperRequested && !batch.wallpaper && batch.kind === 'search' && <p className="vc-flow-muted">{t('workflowPreviewOnly')}</p>}
      {batch.wallpaperRequested && activeTask(batch.status) && <p className="vc-flow-muted">{t('workflowAfterSearch')}</p>}
      {!batch.workflowSource && <p className="vc-flow-muted">{t('workflowHistoricalLink')}</p>}
      {batch.unavailable ? <p className="vc-flow-empty">{t('taskBatchUnavailable')}</p> : !visible.length ? <p className="vc-flow-empty">{t('taskBatchNoMatches')}</p> : <div className="vc-flow-result-grid">{visible.map(image => {
        const path = resource(image.previewPath)
        return <figure className="vc-flow-result-image" key={image.imageVersionId}>{path && <ReferencePreview src={resource(image.thumbnailPath ?? '') ?? path} href={path} alt={image.name} width={image.width} height={image.height} refreshKey={data.refreshKey} t={t} onPreview={() => data.preview(image.imageVersionId)} />}
          <figcaption><small>{image.width} × {image.height}</small></figcaption>
        </figure>
      })}</div>}
      {!batch.unavailable && (index > 0 || (index + 1) * count < batch.images.length || batch.nextImagePageToken) && <div className="vc-flow-image-pager"><Button size="sm" variant="outline" disabled={!index || data.loading} onClick={() => setPage({ runId: batch.runId, index: index - 1 })}>{t('workflowPreviousImages')}</Button><small>{index * count + 1}–{Math.min((index + 1) * count, batch.images.length)} / {batch.matched}</small><Button size="sm" variant="outline" disabled={data.loading || (index + 1) * count >= batch.images.length && !batch.nextImagePageToken} onClick={() => { void next() }}>{t('workflowNextImages')}</Button></div>}
      <div className="vc-flow-node-actions">{batch.continuation?.allowed && batch.launchId && <Button size="sm" variant="primary" disabled={data.opening} onClick={data.resume}>{t('resume')}</Button>}{batch.kind === 'search' && data.wallpaper.enabled && <Button size="sm" variant="primary" disabled={data.wallpaper.busy || batch.status !== 'completed' || !batch.matched} onClick={data.settings}>{t('wallpaperStartBatch')}</Button>}<Button size="sm" variant="outline" disabled={data.opening} onClick={data.open}>{data.opening && <StateDot state="ongoing" />}{t('taskRunInformation')}</Button>
        <ui.Tooltip portal label={t('workflowDeleteScope')}><Button size="sm" variant="ghost" className="vc-search-batch-delete" disabled={data.deleting} onClick={data.remove}><ui.IconTrashOutlineRegular size={14} />{t('workflowDeleteBatch')}</Button></ui.Tooltip>
      </div>
    </div>
  }

  function PreparationNode({ data }: { data: NodeData }) {
    const { launch, t, context } = data
    if (!launch) return null
    const failure = ['failed', 'rejected', 'unknown'].includes(launch.status), sessionId = preparedSession(launch)
    const stage = { preparing: 'searchLaunchBadgePreparing', 'creating-session': 'searchLaunchBadgePreparing', 'preparing-dataset': 'workflowGeneratingDataset', attaching: 'workflowAttaching', submitting: 'workflowSubmitting', accepted: 'workflowAwaitingRun', stopped: 'searchLaunchBadgeStopped', unknown: 'searchLaunchBadgeUnknown', rejected: 'failed' } as const
    return <div className="vc-flow-node-body nodrag nopan nowheel">
      <div className="vc-flow-node-badges"><Tag tone={failure ? 'warning' : 'info'}>{t(stage[launch.stage])}</Tag><span className="vc-flow-muted">{t('targetCountLabel')} {launch.input.targetCount}</span></div>
      <p className="vc-flow-task-brief">{launch.input.taskBrief}</p><p className="vc-flow-muted" role={launch.status === 'accepted' ? 'status' : undefined}>{t(launch.status === 'accepted' ? 'workflowAwaitingRunHint' : 'workflowPreparationHint')}</p>
      {launch.errorCode && <div className="vc-notice" role="alert">{t('searchLaunchTaskAttention')} <code>{launch.errorCode}</code></div>}
      <div className="vc-flow-node-actions">{sessionId && <Button size="sm" variant="outline" onClick={() => { context.launches.openSession(sessionId) }}>{t('workflowOpenSearchSession')}</Button>}{failure && <Button size="sm" variant="outline" onClick={() => { void context.launches.refresh() }}>{t('refresh')}</Button>}{['failed', 'unknown'].includes(launch.status) && <Button size="sm" variant="outline" disabled={launch.stopping} onClick={() => { void context.launches.start(launch.input) }}>{t('retry')}</Button>}{stoppableLaunch(launch) && <Button size="sm" variant="ghost" disabled={launch.stopping} onClick={() => { void context.launches.stop(launch.id) }}>{t(launch.stopping ? 'searchLaunchBadgeStopping' : 'searchLaunchStop')}</Button>}<Button size="sm" variant="ghost" className="vc-search-batch-delete" disabled={data.deleting} onClick={data.remove}><ui.IconTrashOutlineRegular size={14} />{t('workflowDeleteBatch')}</Button></div>
    </div>
  }

  function BatchResults({ data }: { data: NodeData }) {
    const { batch, t } = data
    if (!batch) return <ResultsNode data={data} />
    return <div className="vc-flow-node-body nodrag nopan nowheel"><div className="vc-flow-metrics"><strong>{batch.matched}</strong><span>/ {batch.targetCount ?? batch.matched}</span><Tag tone={data.phase === 'completed' ? 'success' : 'neutral'}>{t(batch.previewOnly ? 'taskPreviewMatched' : 'workflowMatchedResult')}</Tag></div><p className="vc-planning-image-subject">{batch.taskBrief}</p><div className="vc-flow-node-actions"><Button size="sm" variant="outline" disabled={data.opening} onClick={data.open}>{t('taskRunInformation')}</Button>{batch.status === 'completed' && batch.matched > 0 && !batch.wallpaper && data.wallpaper.enabled && <Button size="sm" variant="outline" onClick={data.settings}>{t('wallpaperStartBatch')}</Button>}</div></div>
  }

  function DownstreamSummary({ data }: { data: NodeData }) {
    const { batch, t, kind } = data, detail = data.focused ? data.wallpaper.value : null
    const summary = detail ? { ...batch?.wallpaper, status: detail.status, total: detail.total, planned: detail.counts.planned ?? 0, rendered: detail.counts.rendered ?? 0, reviewed: detail.counts.reviewed ?? 0, passed: detail.counts.passed ?? 0, counts: detail.counts, attention: (detail.counts['needs-review'] ?? 0) + (detail.counts['technical-failed'] ?? 0) + (detail.counts.rejected ?? 0), budgetStopped: detail.state.budgetStopped, errorCode: detail.errorCode } : batch?.wallpaper
    const done = summary ? data.processing ? summary.rendered : data.finals ? summary.passed : kind === 'downloading' ? summary.counts?.downloaded ?? 0 : summary.reviewed : 0
    const ownsHandoff = kind === 'downloading' && !!batch?.postProcessingError
    const reason = !data.context.wallpaper ? 'wallpaperMissingCapability' : batch?.postProcessingError ? ownsHandoff ? 'workflowHandoffFailed' : 'workflowStepBlocked' : batch?.status === 'cancelled' ? 'workflowSearchCancelled' : batch?.outcome === 'budget-exhausted' ? 'taskBudgetExhausted' : !batch?.matched ? 'workflowNoQualified' : 'workflowAwaitingWallpaper'
    return <div className="vc-flow-node-body nodrag nopan nowheel">
      {summary ? <><div className="vc-flow-metrics"><strong>{done}</strong><span>/ {summary.total}</span><Tag tone={summary.status === 'failed' ? 'danger' : summary.attention > 0 ? 'warning' : 'neutral'}>{t(workflowPhaseKeys[data.phase])}</Tag></div><div className="vc-flow-facts"><span>{t('wallpaperFinalCount')} {summary.passed}</span><span>{t('wallpaperAttention')} {summary.attention}</span></div>{summary.budgetStopped && <p className="vc-notice">{t('wallpaperBudget')}</p>}{summary.errorCode && <p className="vc-notice" role="alert"><code>{summary.errorCode}</code></p>}<Button size="sm" variant="outline" onClick={data.focus}>{t('wallpaperOpenImageFlow')}</Button></> : <><p className={ownsHandoff ? 'vc-notice' : 'vc-flow-muted'} role={ownsHandoff ? 'alert' : undefined}>{t(reason)}</p>{ownsHandoff && <code>{batch?.postProcessingError}</code>}{kind === 'downloading' && batch?.status === 'completed' && batch.matched > 0 && data.wallpaper.enabled && <Button size="sm" variant="outline" onClick={data.settings}>{t('wallpaperStartBatch')}</Button>}</>}
      {data.processing && detail && <div className="vc-flow-node-actions">{activeTask(detail.status) ? <><Button size="sm" variant="outline" disabled={data.wallpaper.busy} onClick={() => data.wallpaper.control('pause')}>{t('wallpaperPause')}</Button><Button size="sm" variant="ghost" disabled={data.wallpaper.busy} onClick={() => data.wallpaper.control('cancel')}>{t('wallpaperCancel')}</Button></> : ['paused', 'interrupted'].includes(detail.status) ? <Button size="sm" variant="outline" disabled={data.wallpaper.busy} onClick={() => data.wallpaper.control('resume')}>{t('wallpaperResume')}</Button> : (detail.counts.queued ?? 0) + (detail.counts['technical-failed'] ?? 0) > 0 && <Button size="sm" variant="outline" disabled={data.wallpaper.busy} onClick={data.wallpaper.continue}>{t('wallpaperContinue')}</Button>}</div>}
    </div>
  }

  function WorkflowNode({ data, selected }: NodeProps<FlowNode>) {
    const titles = { references: 'workflowReferences', dataset: 'workflowDataset', results: 'workflowResults', downloading: 'wallpaperDownloading', planning: 'wallpaperPlanning', rendering: 'wallpaperRendering', reviewing: 'wallpaperReviewing' } as const
    const contentId = React.useId()
    const identity = data.image ? fixedImageWorkflowNodeId(data.laneId, data.image.stage) : `${data.laneId}:${data.kind}`, [entering, setEntering] = React.useState(() => !data.appearances.has(identity))
    React.useEffect(() => { data.appearances.add(identity) }, [data.appearances, identity])
    const dot = data.phase === 'running' ? 'ongoing' : data.phase === 'completed' ? 'done' : data.phase === 'failed' ? 'error' : ['attention', 'paused'].includes(data.phase) ? 'warning' : 'idle'
    return <article className="vc-flow-node" data-entering={entering || undefined} data-kind={data.kind} data-image-stage={data.image?.stage} data-selected={selected || undefined} data-phase={data.phase} data-image-id={data.image?.id} data-current-image={data.image && data.image.index === data.wallpaper.offset || undefined} data-search-batch={data.kind === 'results' ? data.batch?.runId : undefined} data-collapsed={data.collapsed} style={{ '--vc-node-body-height': data.size.height ? `${Math.max(90, data.size.height - (data.image ? 64 : 90))}px` : undefined } as import('react').CSSProperties} onAnimationEnd={event => { if (event.target === event.currentTarget && event.animationName === 'vc-workflow-enter') setEntering(false) }}>
      <NodeResizer isVisible={selected} minWidth={data.kind === 'results' ? 360 : 280} maxWidth={1200} minHeight={data.collapsed ? data.image ? 64 : 62 : 180} maxHeight={data.collapsed ? data.image ? 64 : 62 : 1200} handleClassName="vc-node-resize-handle" lineClassName="vc-node-resize-line" onResizeStart={data.beginResize} onResize={(_event, value) => data.resize(value)} onResizeEnd={data.endResize} />
      {data.hasInput && <Handle type="target" position={Position.Left} isConnectable={false} data-arrow-active={data.receiving || undefined} />}
      <header className="vc-flow-node-titlebar"><StateDot state={dot} /><div><strong>{data.image ? data.t(imageWorkflowStages.find(step => step.stage === data.image!.stage)!.title) : data.t(data.processing ? 'wallpaperProcessingGroup' : data.finals ? 'wallpaperFinalResults' : titles[data.kind])}</strong><small>{data.image ? data.t(workflowPhaseKeys[data.phase]) : data.label}</small></div><span className="vc-flow-step-number">{data.image ? String(imageWorkflowStages.findIndex(step => step.stage === data.image!.stage) + 1).padStart(2, '0') : String(['references', 'dataset', 'results', 'downloading', 'planning', 'rendering', 'reviewing'].indexOf(data.kind) + 1).padStart(2, '0')}</span>
        <ui.Tooltip portal label={data.t('workflowResetSize')}><Button className="nodrag nopan vc-flow-reset" size="sm" variant="ghost" aria-label={data.t('workflowResetSize')} onPointerDown={event => event.stopPropagation()} onClick={data.resetSize}><ui.IconRefreshOutlineRegular size={13} /></Button></ui.Tooltip>
        <ui.Tooltip portal label={data.t(data.collapsed ? 'taskExpand' : 'taskCollapse')}><Button className="nodrag nopan vc-flow-collapse" size="sm" variant="ghost" aria-expanded={!data.collapsed} aria-controls={contentId} aria-label={data.t(data.collapsed ? 'taskExpand' : 'taskCollapse')} onPointerDown={event => event.stopPropagation()} onClick={data.collapse}><ui.IconChevronDownOutlineRegular size={14} /></Button></ui.Tooltip>
      </header>
      <AnimatedCollapse id={contentId} open={!data.collapsed} className="vc-flow-collapse-region">
        {!data.image && <div className="vc-flow-status-strip" data-phase={data.phase}><span>{data.t(workflowPhaseKeys[data.phase])}</span><small>{data.kind === 'references' && data.batch?.workflowSource ? `${data.batch.workflowSource.references} ${data.t('datasetImagesUnit')} · v${data.batch.workflowSource.revision}` : data.kind === 'dataset' && data.dataset ? `v${data.dataset.profileRevision}` : ''}</small></div>}
        {data.image ? <ImageStepCard stage={data.image.stage} kind={data.kind as WallpaperStep} control={data.wallpaper} t={data.t} /> : data.kind === 'references' ? <ReferencesNode data={data} /> : data.kind === 'dataset' ? <DatasetNode data={data} /> : data.kind === 'results' ? <BatchResults data={data} /> : <DownstreamSummary data={data} />}
      </AnimatedCollapse>
      {data.hasOutput && <Handle type="source" position={Position.Right} isConnectable={false} />}
    </article>
  }

  const nodeTypes = { workflow: WorkflowNode }, edgeTypes = { workflow: createWorkflowEdge(React) }
  function Navigation({ t, fit, focus, navigate, focusLabel }: { t: WorkbenchText; fit(): void; focus(): void; navigate(): void; focusLabel?: string }) {
    const { zoom } = useViewport(), flow = useReactFlow<FlowNode, WorkflowEdge>()
    return <Panel position="bottom-left" className="vc-workflow-navigation"><ZoomControls visible zoom={zoom} labels={{ controls: t('workflowZoom'), menu: t('workflowZoomMenu'), out: t('workflowZoomOut'), into: t('workflowZoomIn'), value: percent => t('workflowZoomValue').replace('{percent}', String(percent)) }} fit={{ label: t('workflowFit'), selected: false, onSelect: fit }} onZoom={value => { navigate(); void flow.zoomTo(value) }} onActiveChange={() => {}} /><Button size="sm" variant="outline" onClick={focus}>{focusLabel ?? t('workflowFocusBatch')}</Button></Panel>
  }

  function ImageFlow({ base }: { base: NodeData }) {
    const control = base.wallpaper, t = base.t, imageId = control.item?.imageVersionId ?? control.itemIndex?.[control.offset]?.imageVersionId ?? String(control.offset)
    const layout = useLayout(`${base.context.style.styleId}:fixed-image-flow:${control.sourceId}`)
    const [instance, setInstance] = React.useState<ReactFlowInstance<FlowNode, WorkflowEdge> | null>(null), [selected, setSelected] = React.useState(''), [interacting, setInteracting] = React.useState(false)
    const [menu, setMenu] = React.useState<{ x: number; y: number; kind: WallpaperStep } | null>(null)
    const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
    const container = React.useRef<HTMLDivElement>(null), cameraEpoch = React.useRef(0)
    const navigated = React.useRef(!!layout.initialViewport), steps = imageWorkflowStages
    const navigate = () => { navigated.current = true; cameraEpoch.current++ }
    const nodes: FlowNode[] = steps.map(({ kind, stage }, index) => {
      const id = fixedImageWorkflowNodeId(base.laneId, stage), position = layout.position(id, kind, base.laneId, { x: index * 400, y: 0 })
      const observedPhase = control.value && control.item ? imageWorkflowPhase(kind, control.item, control.value.status, control.attempt) : 'queued'
      const phase = stage === 'final' && observedPhase === 'completed' && (control.item?.status !== 'passed' || !control.attempt?.outputId || control.attempt !== control.item.attempts.at(-1)) ? 'blocked' : observedPhase
      const size = layout.sizes[id] ?? { width: 330 }, measured = layout.measuredDimensions(id)
      return { id, type: 'workflow', position, ...(measured ? { measured } : {}), selected: selected === id, style: { width: size.width }, dragHandle: '.vc-flow-node-titlebar', data: {
        ...base, kind, image: { id: imageId, index: control.offset, stage }, processing: false, finals: false, phase, size, collapsed: collapsed[id] ?? false, receiving: phase === 'running', hasInput: index > 0, hasOutput: index < steps.length - 1,
        collapse: () => setCollapsed(value => ({ ...value, [id]: !value[id] })), focus: () => control.setDetails(kind),
        resize: size => layout.resize(id, size, collapsed[id]), resetSize: () => layout.resetSize(id), beginResize: () => { navigate(); setInteracting(true) }, endResize: () => { setInteracting(false); layout.save(instance?.getViewport()) },
      } }
    })
    const edges = nodes.slice(1).map((node, index) => connection(`${node.id}:input`, nodes[index]!.id, node.id, node.data.phase, false, undefined, false, interacting))
    const latest = control.item?.attempts.at(-1)
    if (latest?.retryFrom && latest.retryTarget && control.item?.status === latest.retryTarget && control.value && activeTask(control.value.status)) {
      const from = nodes.find(node => node.data.kind === latest.retryFrom), to = nodes.find(node => node.data.kind === latest.retryTarget)
      if (from && to) edges.push(connection(`${base.laneId}:rework`, from.id, to.id, 'running', true, `${t('wallpaperRound')} ${latest.revision}`, false, interacting))
    }
    const fit = () => { navigate(); void instance?.fitView({ padding: 0.12, maxZoom: 1 }) }
    const focusNodes = () => {
      const count = (container.current?.clientWidth ?? 1600) >= 1100 ? 3 : (container.current?.clientWidth ?? 1600) >= 700 ? 2 : 1
      const active = nodes.findIndex(node => ['running', 'failed', 'attention', 'paused'].includes(node.data.phase))
      const start = Math.min(Math.max(0, active - 1), nodes.length - count)
      return nodes.slice(start, start + count)
    }
    const focus = () => { navigate(); void instance?.fitView({ nodes: focusNodes(), padding: 0.12, maxZoom: 1 }) }
    React.useEffect(() => {
      if (!instance || navigated.current || !nodes.every(node => layout.measuredDimensions(node.id))) return
      let second = 0, cancelled = false
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
        if (navigated.current) return
        navigated.current = true
        const epoch = cameraEpoch.current, targets = focusNodes()
        void instance.fitView({ nodes: targets, padding: 0.12, maxZoom: 1 }).then(() => {
          if (cancelled || cameraEpoch.current !== epoch) return
          const at = instance.getViewport(), top = Math.min(...targets.map(node => node.position.y))
          void instance.setViewport({ ...at, y: 88 - top * at.zoom })
        })
      }) })
      return () => { cancelled = true; cancelAnimationFrame(first); cancelAnimationFrame(second) }
    }, [instance, layout.geometryRevision])
    React.useEffect(() => setMenu(null), [imageId])
    return <div ref={container} className="vc-single-image-scope"><ReactFlow<FlowNode, WorkflowEdge> className="vc-single-image-canvas" nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setInstance} {...(layout.initialViewport ? { defaultViewport: layout.initialViewport } : {})} proOptions={{ hideAttribution: true }} onlyRenderVisibleElements minZoom={0.15} maxZoom={2} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} zoomOnDoubleClick={false} panOnDrag={[0, 1]} panActivationKeyCode="Space"
      onNodesChange={changes => { for (const change of changes) { if (change.type === 'position' && change.position) layout.move(change.id, change.position); if (change.type === 'dimensions' && change.dimensions) layout.measure(change.id, change.dimensions) } }}
      onNodeClick={(_event, node) => setSelected(node.id)} onNodeDoubleClick={(_event, node) => { navigate(); void instance?.fitView({ nodes: [{ id: node.id }], padding: 0.2, maxZoom: 1 }) }}
      onNodeContextMenu={(event, node) => { event.preventDefault(); setSelected(node.id); setMenu({ x: event.clientX, y: event.clientY, kind: node.data.kind as WallpaperStep }) }} onPaneClick={() => { setSelected(''); setMenu(null) }}
      onNodeDragStart={() => { navigate(); setInteracting(true); setMenu(null) }} onNodeDragStop={() => { setInteracting(false); layout.reconcile(instance?.getViewport()) }}
      onMoveStart={event => { setInteracting(true); if (event) navigate() }} onMoveEnd={(event, at) => { setInteracting(false); if (event || navigated.current) layout.save(at) }}
      ariaLabelConfig={{ 'node.a11yDescription.default': t('workflowHelp'), 'edge.a11yDescription.default': t('workflowAutomatic'), 'minimap.ariaLabel': t('workflowMinimap') }}>
      <Background gap={24} size={1} /><Panel position="top-left" className="vc-image-stage-shortcuts">{nodes.map(node => <Button key={node.id} size="sm" variant={selected === node.id ? 'outline' : 'ghost'} onClick={() => { navigate(); setSelected(node.id); void instance?.fitView({ nodes: [{ id: node.id }], padding: 0.12, maxZoom: 1 }) }}>{`${imageWorkflowStages.findIndex(step => step.stage === node.data.image!.stage) + 1} · ${t(imageWorkflowStages.find(step => step.stage === node.data.image!.stage)!.title)}`}</Button>)}<Button size="sm" variant="ghost" onClick={fit}>{t('workflowFit')}</Button></Panel><Navigation t={t} fit={fit} focus={focus} focusLabel={t('wallpaperFitImage')} navigate={navigate} />
    </ReactFlow><ui.Menu listClassName="vc-menu" open={!!menu} anchor={null} portal autoFocus contextual getAnchorRect={() => menu ? new DOMRect(menu.x, menu.y, 0, 0) : null} items={[{ id: 'details', label: t('wallpaperStepDetails') }, { id: 'fit', label: t('wallpaperFitImage') }]} onClose={() => setMenu(null)} onSelect={id => { if (id === 'details' && menu) control.setDetails(menu.kind); else focus(); setMenu(null) }} /></div>
  }

  function Canvas({ styleId, pageSize = 0, t, workflow: context, useBatches, actions, onOpen }: AutomaticWorkflowProps) {
    const state = useBatches(value => value), datasets = context.useDatasets(value => value), launches = context.useLaunches(value => value), layout = useLayout(styleId)
    const navigated = React.useRef(false), rows = React.useRef(new Map<string, number>())
    const [instance, setInstance] = React.useState<ReactFlowInstance<FlowNode, WorkflowEdge> | null>(null), [interacting, setInteracting] = React.useState(false)
    const [preview, setPreview] = React.useState<{ batchId: string; imageId: string } | null>(null), [refreshKey, setRefreshKey] = React.useState(0)
    const [opening, setOpening] = React.useState(false), [openError, setOpenError] = React.useState(false), [notice, setNotice] = React.useState<{ id: number; success: boolean } | null>(null)
    const [focused, setFocused] = React.useState(''), [selected, setSelected] = React.useState<Set<string>>(() => new Set()), [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
    const [overview, setOverview] = React.useState(false), [imageFlowSource, setImageFlowSource] = React.useState('')
    const [contextMenu, setContextMenu] = React.useState<{ x: number; y: number; ids: string[]; origin: HTMLElement | null } | null>(null)
    const [pendingSettings, setPendingSettings] = React.useState(''), [styleOpen, setStyleOpen] = React.useState(false), [notes, setNotes] = React.useState(() => { try { return window.localStorage.getItem(`visual-curator:canvas-brief:${styleId}`) ?? '' } catch (error) { return '' } })
    const [notesSaved, setNotesSaved] = React.useState(true), styleToggle = React.useRef<HTMLButtonElement>(null)
    const alive = React.useRef(true), noticeId = React.useRef(0)
    const appearances = React.useRef(new Set<string>())
    const canvasRef = React.useRef<HTMLElement>(null), deletingRef = React.useRef(false), preparations = React.useRef(new Set<string>())
    const [deleteTargets, setDeleteTargets] = React.useState<Removal[] | null>(null), [deleting, setDeleting] = React.useState(false)
    const [deleteProgress, setDeleteProgress] = React.useState({ completed: 0, total: 0 }), [deleteErrors, setDeleteErrors] = React.useState<{ label: string; code: string }[]>([])
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    React.useLayoutEffect(() => actions.watch(styleId), [actions, styleId])
    const launchProgress = launches.entries.map(entry => `${entry.id}:${entry.status}:${entry.runStatus ?? ''}:${entry.qualified}:${entry.runIds.join(',')}`).join('|')
    React.useEffect(() => { if (launchProgress) actions.refresh() }, [launchProgress, actions])
    const page = state.styleId === styleId ? state.page : null
    const batches = page?.batches ?? []
    const activeBatch = preferredWorkflowBatch(batches, pendingSettings || focused || state.batchId)
    const preparingLaunch = launches.submission?.input.operationId ?? launches.entries.find(entry => entry.status === 'working')?.id
    React.useEffect(() => { if (preparingLaunch) { setFocused(preparingLaunch); setOverview(false); navigated.current = false } }, [preparingLaunch])
    const wallpaper = useWallpaper(activeBatch, context.wallpaper, context.pollIntervalMs ?? 2000, pageSize || 20, refreshKey)
    React.useEffect(() => { if (wallpaper.value?.runId) actions.refresh() }, [wallpaper.value?.runId, wallpaper.value?.status, actions])
    React.useEffect(() => { if (pendingSettings && wallpaper.sourceId === pendingSettings) { setPendingSettings(''); wallpaper.openSettings() } }, [pendingSettings, wallpaper.sourceId])
    for (const batch of batches) if (batch.launchId) preparations.current.delete(batch.launchId)
    const pending: LaunchCard[] = state.batchId ? [] : launches.entries.filter(entry => !batches.some(batch => batch.launchId === entry.id || entry.runIds.includes(batch.runId)) && (preparations.current.has(entry.id) || entry.status !== 'accepted' || !entry.runIds.length || !!entry.runStatus && activeTask(entry.runStatus))).map(entry => ({ id: entry.id, input: entry.input, stage: entry.stage, status: entry.status, sessionId: entry.sessionId, ...(entry.stopping ? { stopping: true } : {}), createdAt: entry.createdAt, ...(entry.error ? { errorCode: entry.error.code } : {}) }))
    if (!state.batchId && launches.submission && !batches.some(batch => batch.launchId === launches.submission!.input.operationId) && !pending.some(entry => entry.id === launches.submission!.input.operationId)) pending.push({ id: launches.submission.input.operationId, input: launches.submission.input, stage: launches.submission.status === 'submitting' ? 'preparing' : launches.submission.status, status: launches.submission.status === 'submitting' ? 'working' : launches.submission.status, ...(launches.submission.error ? { errorCode: launches.submission.error } : {}) })
    for (const launch of pending) preparations.current.add(launch.id)
    const seen = new Set<string>()
    const lanes: Lane[] = batches.map(batch => { const id = layout.lane(batch.launchId, batch.runId, launches.entries.find(entry => entry.id === batch.launchId)?.runIds ?? []); seen.add(id); return { id, batch } })
    for (const launch of pending) if (!seen.has(launch.id)) lanes.push({ id: launch.id, launch })
    if (!lanes.length) lanes.push({ id: 'current' })
    const allLanes = [...lanes]
    const currentLane = lanes.find(lane => lane.batch?.runId === focused || lane.launch?.id === focused) ?? lanes.find(lane => lane.launch?.status === 'working') ?? lanes.find(lane => lane.batch?.runId === activeBatch?.runId) ?? lanes[0]!
    const currentPhase = currentLane.batch ? workflowBatchPhase(currentLane.batch) : 'idle'
    if (!overview) lanes.splice(0, lanes.length, currentLane)
    const nodes: FlowNode[] = [], edges: WorkflowEdge[] = [], arrangement: { id: string; kind: WorkflowNodeKind; row: number; imageSlot?: number }[] = []
    const imageView = !!wallpaper.sourceId && imageFlowSource === wallpaper.sourceId
    const runAction = async (work: () => Promise<void>) => {
      if (opening) return
      setOpening(true); setOpenError(false)
      try { await work() } catch (error) { if (alive.current) setOpenError(true) } finally { if (alive.current) setOpening(false) }
    }
    const removalTargets = (targets: FlowNode[]): Omit<Removal, 'operationId'>[] => {
      const unique = new Map<string, Omit<Removal, 'operationId'>>()
      for (const node of targets) {
        const { batch, launch } = node.data
        const target: WorkflowHistoryTarget | undefined = batch?.launchId ? { kind: 'launch', id: batch.launchId } : batch ? { kind: 'run', id: batch.runId } : launch ? { kind: 'launch', id: launch.id } : undefined
        if (!target) continue
        const key = `${target.kind}:${target.id}`, prior = unique.get(key)
        const active = batch ? !removable(batch.status) || !!batch.wallpaper && !removable(batch.wallpaper.status) : launch?.status !== 'stopped'
        unique.set(key, { target, label: prior?.label ?? node.data.label, active: !!prior?.active || active })
      }
      return [...unique.values()]
    }
    const requestDelete = (targets: FlowNode[]) => {
      if (deletingRef.current || state.deleting.length) return
      const selection = removalTargets(targets)
      if (!selection.length) return
      setContextMenu(null); setDeleteErrors([]); setDeleteProgress({ completed: 0, total: selection.length })
      setDeleteTargets(selection.map(target => ({ ...target, operationId: crypto.randomUUID() })))
    }
    const closeDelete = () => { setDeleteTargets(null); if (!deletingRef.current) setDeleteErrors([]); canvasRef.current?.focus({ preventScroll: true }) }
    const confirmDelete = async () => {
      if (!deleteTargets?.length || deletingRef.current) return
      deletingRef.current = true; setDeleting(true)
      const targets = deleteTargets, failed: Removal[] = [], errors: { label: string; code: string }[] = []
      setDeleteErrors([]); setDeleteProgress({ completed: 0, total: targets.length })
      try {
        for (let index = 0; index < targets.length; index++) {
          if (!alive.current) break
          const item = targets[index]!
          try {
            const receipt = await actions.removeWorkflow({ styleId, target: item.target, operationId: item.operationId, stopActive: true })
            if (!alive.current) break
            context.launches.forget(receipt.launchIds)
            const removed = new Set<string>([...receipt.runIds, ...receipt.launchIds]), keepNode = (id: string) => !removed.has(planningImageLane(id) ?? id.slice(0, id.lastIndexOf(':')))
            layout.forget([...removed])
            for (const id of removed) { rows.current.delete(id); preparations.current.delete(id) }
            setSelected(current => new Set([...current].filter(keepNode))); setCollapsed(current => Object.fromEntries(Object.entries(current).filter(([id]) => keepNode(id))))
            setFocused(current => removed.has(current) ? '' : current); setPendingSettings(current => removed.has(current) ? '' : current)
            setPreview(current => current && removed.has(current.batchId) ? null : current)
          } catch (error) {
            failed.push(item)
            errors.push({ label: item.label, code: error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'workflow-delete-failed' })
          }
          if (alive.current) setDeleteProgress({ completed: index + 1, total: targets.length })
        }
        if (alive.current) {
          setDeleteTargets(failed.length ? failed : null); setDeleteErrors(errors)
          setNotice({ id: ++noticeId.current, success: !failed.length })
          if (!failed.length) canvasRef.current?.focus({ preventScroll: true })
        }
      } finally { deletingRef.current = false; if (alive.current) setDeleting(false) }
    }
    for (const lane of lanes) {
      if (lane.id !== 'current' && !rows.current.has(lane.id)) rows.current.set(lane.id, rows.current.size)
      const row = rows.current.get(lane.id) ?? 0, batch = lane.batch
      const profileId = batch?.workflowSource?.modelProfileId ?? lane.launch?.input.modelProfileId ?? context.style.modelProfile?.id
      const entries = datasets.entries.filter(entry => entry.styleId === styleId && (batch?.datasetId ? entry.exportId === batch.datasetId || entry.duplicateExports?.some(copy => copy.exportId === batch.datasetId) : entry.modelProfileId === profileId))
      const dataset = entries.find(entry => entry.sampleScope === 'all' && entry.status === 'completed') ?? entries.find(entry => entry.status === 'completed') ?? entries[0]
      const showDataset = !!dataset || !!batch?.workflowSource || !!lane.launch || !!context.style.modelProfile || !!context.analysis || context.style.referenceIds.length > 0 || !!context.referenceTask && galleryTaskActive(context.referenceTask.status) || datasets.submissions.some(item => item.styleId === styleId)
      const detailed = !!batch && batch.runId === wallpaper.sourceId
      const hasWallpaper = !!batch?.wallpaper || detailed && !!wallpaper.value
      const downstream = hasWallpaper || !!batch?.wallpaperRequested && !activeTask(batch.status)

      const kinds: WorkflowNodeKind[] = ['references', ...(showDataset ? ['dataset' as const] : []), ...(batch || lane.launch ? ['results' as const] : []), ...(downstream ? ['downloading', 'planning', 'reviewing'] as const : [])]
      const label = batch || lane.launch ? `${t('workflowBatch')} ${lane.id.slice(0, 8)} · ${batch?.createdAt || lane.launch?.createdAt ? new Date(batch?.createdAt ?? lane.launch!.createdAt!).toLocaleString() : t('searchLaunchBadgePreparing')}` : t('workflowCurrent')
      const nodeId = (kind: WorkflowNodeKind) => `${lane.id}:${kind}`
      for (const kind of kinds) {
        const id = nodeId(kind), at = layout.position(id, kind, lane.id)
        const folded = collapsed[id] ?? (!!batch && (kind === 'references' || kind === 'dataset'))
        const phase = kind === 'planning' && batch?.wallpaper ? workflowWallpaperPhase(batch.wallpaper) : nodePhase({ kind, batch, context, dataset, launch: lane.launch, focused: detailed, wallpaper }), size = layout.sizes[id] ?? { width: kind === 'results' ? 560 : ['downloading', 'planning', 'rendering', 'reviewing'].includes(kind) ? 380 : 340 }
        arrangement.push({ id, kind, row })
        // Controlled replacements must retain observed dimensions so ReactFlow keeps measured handles visible.
        const measured = layout.measuredDimensions(id)
        nodes.push({ id, type: 'workflow', position: at, ...(measured ? { measured } : {}), selected: selected.has(id), style: { width: size.width }, dragHandle: '.vc-flow-node-titlebar', data: {
          kind, processing: kind === 'planning', finals: kind === 'reviewing', phase, size, resize: value => layout.resize(id, value, folded), beginResize: () => { navigated.current = true; setInteracting(true) }, endResize: () => { setInteracting(false); layout.save(instance?.getViewport()) }, resetSize: () => layout.resetSize(id), laneId: lane.id, label, launch: lane.launch, focused: detailed, collapsed: folded, collapse: () => setCollapsed(value => ({ ...value, [id]: !folded })), focus: () => { if (batch) { setFocused(batch.runId); setImageFlowSource(batch.runId); setSelected(new Set()); setContextMenu(null) } }, settings: () => { if (batch) { setFocused(batch.runId); setPendingSettings(batch.runId) } }, context: { ...context, onSearch: () => context.onSearch(notes) }, t, dataset, datasets, batch, wallpaper,
          loading: state.loading, opening, refreshKey, pageSize: pageSize || 8, deleting: deleting || state.deleting.length > 0, appearances: appearances.current, receiving: false, hasInput: kind !== 'references', hasOutput: kind !== kinds.at(-1),
          resume: () => { if (batch?.launchId) void runAction(async () => { await context.launches.retry(batch.launchId!); await actions.refresh() }) },
          preview: imageId => { if (batch) setPreview({ batchId: batch.runId, imageId }) }, open: () => { if (batch) void runAction(() => onOpen(batch.runId, batch.sessionId)) }, crop: imageId => { if (batch) void runAction(() => context.onCrop(batch, imageId)) },
          remove: () => requestDelete(nodes.filter(node => node.data.laneId === lane.id)), moreImages: () => batch ? actions.moreImages(batch.runId) : Promise.resolve(),
        } })
      }
      const laneNodes = new Map(nodes.filter(node => node.data.laneId === lane.id).map(node => [node.id, node]))
      for (let i = 1; i < kinds.length; i++) {
        const source = kinds[i - 1]!, target = kinds[i]!
        const destination = laneNodes.get(nodeId(target))!
        const origin = laneNodes.get(nodeId(source))!
        const waitingForInput = origin.data.phase === 'running' && ['queued', 'idle'].includes(destination.data.phase)
        destination.data.receiving = waitingForInput || destination.data.phase === 'running'
        edges.push(connection(`${lane.id}:${source}-${target}`, nodeId(source), nodeId(target), destination.data.phase, false, undefined, waitingForInput, interacting))
      }

    }
    const focusNodes = (laneId: string) => {
      const laneNodes = nodes.filter(node => node.data.laneId === laneId)
      const target = laneNodes.findIndex(node => ['failed', 'attention', 'running', 'paused'].includes(node.data.phase))
      const delivery = laneNodes.findIndex(node => node.data.kind === 'reviewing')
      const index = target >= 0 ? target : delivery >= 0 ? delivery : Math.max(0, laneNodes.findIndex(node => node.data.kind === 'results'))
      return laneNodes.slice(Math.max(0, index - 1), index + 1)
    }
    const topology = nodes.map(node => node.id).join('|')
    const focusTarget = focusNodes(currentLane.id).map(node => node.id).join('|')
    const reconciledGeometry = React.useRef(''), geometryKey = `${topology}#${layout.geometryRevision}`
    React.useLayoutEffect(() => {
      if (interacting || reconciledGeometry.current === geometryKey) return
      reconciledGeometry.current = geometryKey
      layout.reconcile(instance?.getViewport())
    }, [geometryKey, interacting])
    const followedLaunches = React.useRef(new Set<string>())
    const preparingId = launches.submission?.input.operationId ?? launches.entries.find(entry => entry.status === 'working')?.id
    React.useEffect(() => {
      if (!instance || navigated.current) return
      let second = 0
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
        if (navigated.current) return
        if (preparingId && !followedLaunches.current.has(preparingId) && lanes.some(lane => lane.id === preparingId)) {
          followedLaunches.current.add(preparingId); setSelected(new Set([`${preparingId}:results`]))
        }
        void instance.fitView({ nodes: overview ? nodes : focusNodes(currentLane.id), padding: 0.15, maxZoom: 1 })
      }) })
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
    }, [instance, preparingId, topology, focusTarget, overview])
    const previewBatch = batches.find(item => item.runId === preview?.batchId)
    const selectedTargets = removalTargets(nodes.filter(node => selected.has(node.id)))
    const fit = (laneId?: string) => { navigated.current = true; void instance?.fitView({ ...(laneId ? { nodes: nodes.filter(node => node.data.laneId === laneId) } : {}), padding: 0.15, maxZoom: 1 }) }
    const selectedLane = nodes.find(node => selected.has(node.id))?.data.laneId
    const focusBatch = () => { const lane = lanes.find(item => item.id === selectedLane) ?? lanes.find(item => item.batch?.runId === activeBatch?.runId) ?? lanes.at(-1); if (lane) fit(lane.id) }
    const editNotes = (value: string) => { setNotes(value); try { window.localStorage.setItem(`visual-curator:canvas-brief:${styleId}`, value); setNotesSaved(true) } catch (error) { setNotesSaved(false) } }
    const closeStyle = () => { setStyleOpen(false); styleToggle.current?.focus({ preventScroll: true }) }
    const openMenu = (event: import('react').MouseEvent, targets: FlowNode[]) => {
      if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable="true"]')) return
      event.preventDefault(); event.stopPropagation()
      const first = targets[0]
      if (!first) return
      const ids = targets.length > 1 ? targets.map(node => node.id) : selected.has(first.id) ? nodes.filter(node => selected.has(node.id)).map(node => node.id) : [first.id]
      const origin = event.target instanceof Element ? event.target.closest<HTMLElement>('.react-flow__node') : null
      const rect = origin?.getBoundingClientRect()
      setSelected(new Set(ids)); setContextMenu({ x: event.clientX || rect?.left || 0, y: event.clientY || rect?.top || 0, ids, origin })
      if (first.data.batch) setFocused(first.data.batch.runId)
    }
    const menuNodes = contextMenu ? nodes.filter(node => contextMenu.ids.includes(node.id)) : []
    const menuEntries: MenuEntry[] = [], menuActions = new Map<string, () => void>()
    const addMenuAction = (id: string, label: string, action: () => void, disabled = false) => { menuEntries.push({ id, label, disabled }); if (!disabled) menuActions.set(id, action) }
    if (menuNodes.length) {
      const ids = menuNodes.map(node => node.id), first = menuNodes[0]!
      menuEntries.push({ type: 'label', id: 'heading', text: ids.length > 1 ? t('workflowSelectionMenu').replace('{count}', String(ids.length)) : t('workflowNodeMenu') })
      addMenuAction('focus', t('workflowFocusSelection'), () => { navigated.current = true; void instance?.fitView({ nodes: menuNodes, padding: 0.2, maxZoom: 1 }) })
      addMenuAction('batch', t('workflowFocusBatch'), () => fit(first.data.laneId))
      addMenuAction('collapse', t('workflowCollapseSelection'), () => setCollapsed(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, true])) })))
      addMenuAction('expand', t('workflowExpandSelection'), () => setCollapsed(current => ({ ...current, ...Object.fromEntries(ids.map(id => [id, false])) })))
      addMenuAction('size', t('workflowResetSelection'), () => { for (const id of ids) layout.resetSize(id) })
      const removals = removalTargets(menuNodes)
      if (removals.length) addMenuAction('delete-workflows', t('workflowDeleteSelected').replace('{count}', String(removals.length)), () => requestDelete(menuNodes), deleting || state.deleting.length > 0)
      if (ids.length === 1) {
        const data = first.data, batch = data.batch
        menuEntries.push({ type: 'separator', id: 'operations' })
        if (data.kind === 'references') {
          addMenuAction('references', t('workflowCurrentReferences'), data.context.onReferences)
          const runId = batch?.workflowSource ? batch.workflowSource.analysisRunId : data.context.analysis?.runId
          if (runId) addMenuAction('analysis', t('workflowAnalysisDetails'), () => data.context.onAnalysis(runId))
        } else if (data.kind === 'dataset' && (data.dataset || !batch?.workflowSource)) addMenuAction('dataset', t('workflowDatasetDetails'), () => data.context.onDatasets(data.dataset?.id))
        if (batch?.continuation?.allowed && batch.launchId) addMenuAction('resume-search', t('resume'), data.resume, data.opening)
        if (batch) addMenuAction('details', t('taskRunInformation'), data.open, data.opening)
        const launch = data.launch
        if (data.kind === 'results' && launch) {
          const sessionId = preparedSession(launch)
          if (sessionId) addMenuAction('search-session', t('workflowOpenSearchSession'), () => { data.context.launches.openSession(sessionId) })
          if (stoppableLaunch(launch)) addMenuAction('stop-search', t('searchLaunchStop'), () => { void runAction(async () => { await data.context.launches.stop(launch.id); await actions.refresh() }) }, data.opening || launch.stopping)
        }
        if (data.kind === 'results' && batch?.kind === 'search') addMenuAction('wallpapers', t('wallpaperStartBatch'), data.settings, !data.wallpaper.enabled || data.wallpaper.busy || batch.status !== 'completed' || !batch.matched)
        const current = data.wallpaper.value
        if (['downloading', 'planning', 'rendering', 'reviewing'].includes(data.kind) && current?.sourceRunId === batch?.runId && current) {
          const unfinished = ['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'technical-failed'].some(status => (current.counts[status] ?? 0) > 0)
          if (activeTask(current.status)) addMenuAction('pause', t('wallpaperPause'), () => data.wallpaper.control('pause'), data.wallpaper.busy)
          else if (['paused', 'interrupted'].includes(current.status)) addMenuAction('resume', t('wallpaperResume'), () => data.wallpaper.control('resume'), data.wallpaper.busy)
          else if (unfinished) addMenuAction('continue', t('wallpaperContinue'), data.wallpaper.continue, data.wallpaper.busy)
          const imageId = data.image?.id, plan = imageId ? current.state.items.find(item => item.imageVersionId === imageId)?.attempts.at(-1) : data.wallpaper.attempt
          if (data.kind === 'planning' && plan) addMenuAction('plan', t('wallpaperEditPlan'), imageId ? () => data.wallpaper.editImagePlan(imageId) : data.wallpaper.editPlan, data.wallpaper.busy || activeTask(current.status))
          if (!removable(current.status)) addMenuAction('cancel', t('wallpaperCancel'), () => data.wallpaper.control('cancel'), data.wallpaper.busy)
        }
      }
      menuEntries.push({ type: 'separator', id: 'selection' })
      addMenuAction('clear', t('workflowClearSelection'), () => setSelected(new Set()))
    }
    return <section ref={canvasRef} tabIndex={-1} className="vc-workflow-canvas vc-search-batches" aria-label={t('workflowCanvas')} data-interacting={interacting || undefined} onKeyDown={event => {
      if (imageView) return
      const target = event.target
      if (!(target instanceof Element) || !event.currentTarget.contains(target) || target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="textbox"], [role="dialog"], [role="menu"], .vc-canvas-style-sidebar')) return
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (event.repeat || deleteTargets || deletingRef.current || !selectedTargets.length) return
        event.preventDefault(); event.stopPropagation(); requestDelete(nodes.filter(node => selected.has(node.id))); return
      }
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      const element = target.closest<HTMLElement>('.react-flow__node') ?? canvasRef.current
      const node = nodes.find(row => row.id === element?.dataset.id) ?? nodes.find(row => selected.has(row.id))
      if (!element || !node) return
      event.preventDefault(); const rect = element.getBoundingClientRect(), ids = selected.has(node.id) ? nodes.filter(row => selected.has(row.id)).map(row => row.id) : [node.id]
      setSelected(new Set(ids)); setContextMenu({ x: rect.left + Math.min(32, rect.width / 2), y: rect.top + 32, ids, origin: element }); if (node.data.batch) setFocused(node.data.batch.runId)
    }}>
      <header className="vc-workflow-toolbar" data-level={imageView ? 'image' : 'batch'}><Button size="sm" variant={imageView ? 'ghost' : 'outline'} onClick={() => { setImageFlowSource(''); setSelected(new Set()); navigated.current = false }}>{t('wallpaperBatchOverview')}</Button>{imageView && <span className="vc-flow-muted">/ {t('wallpaperImageFlow')} · {t('wallpaperImage')} {wallpaper.offset + 1}</span>}<div className="vc-workflow-heading">{!imageView && <strong>{t('workflowCanvas')}</strong>}<span>{allLanes.length} {t('workflowBatchUnit')}</span>{!overview && currentLane.batch && <><Tag tone={currentPhase === 'failed' ? 'danger' : currentPhase === 'completed' ? 'success' : ['attention', 'paused'].includes(currentPhase) ? 'warning' : ['running', 'queued'].includes(currentPhase) ? 'info' : 'neutral'}>{t(currentPhase === 'failed' ? 'failed' : workflowPhaseKeys[currentPhase])}</Tag><small>{t(currentLane.batch.previewOnly ? 'taskPreviewMatched' : 'workflowMatchedResult')} {currentLane.batch.matched} / {currentLane.batch.targetCount ?? currentLane.batch.matched}{currentLane.batch.wallpaper ? ` · ${t('wallpaperFinalCount')} ${currentLane.batch.wallpaper.passed} / ${currentLane.batch.wallpaper.total} · ${t(workflowPhaseKeys[workflowWallpaperPhase(currentLane.batch.wallpaper)])}` : ''}</small></>}</div><div className="vc-workflow-actions">
        <SelectField label={t('taskBatchFilter')} value={overview ? '__all' : currentLane.batch?.runId ?? currentLane.launch?.id ?? ''} options={[{ value: '__all', label: t('taskAllBatches') }, ...allLanes.filter(lane => lane.batch || lane.launch).map(lane => ({ value: lane.batch?.runId ?? lane.launch!.id, label: `${t('workflowBatch')} ${lane.id.slice(0, 8)} · ${lane.batch?.createdAt || lane.launch?.createdAt ? new Date(lane.batch?.createdAt ?? lane.launch!.createdAt!).toLocaleString() : t('searchLaunchBadgePreparing')}` }))]} disabled={state.deleting.length > 0} onChange={value => { setPreview(null); setSelected(new Set()); setOverview(value === '__all'); setImageFlowSource(''); if (value !== '__all') setFocused(value); navigated.current = false }} />
        {page?.nextPageToken && <Button size="sm" variant="ghost" disabled={state.loading} onClick={() => { void actions.more() }}>{t('taskMoreBatches')}</Button>}
        {context.onWallpaperSearch && <Button size="sm" variant="primary" disabled={!context.canSearch || context.busy} onClick={() => context.onWallpaperSearch?.(notes)}>{t('workflowNewSearch')}</Button>}
        {!imageView && selectedTargets.length > 0 && <ui.Tooltip portal label={t('workflowDeleteKeyHint')}><Button size="sm" variant="ghost" className="vc-search-batch-delete" disabled={deleting || state.deleting.length > 0} onClick={() => requestDelete(nodes.filter(node => selected.has(node.id)))}><ui.IconTrashOutlineRegular size={14} />{t('workflowDeleteSelected').replace('{count}', String(selectedTargets.length))}</Button></ui.Tooltip>}
        <Button ref={styleToggle} size="sm" variant={styleOpen ? 'outline' : 'ghost'} aria-expanded={styleOpen} onClick={() => setStyleOpen(value => !value)}>{t('workflowStylePanel')}</Button>
        {wallpaper.enabled && <Button size="sm" variant="ghost" disabled={wallpaper.busy} onClick={wallpaper.showExperience}>{t('wallpaperExperience')}</Button>}
        {!imageView && <Button size="sm" variant="ghost" onClick={() => { rows.current = new Map(lanes.map((lane, index) => [lane.id, index])); layout.arrange(arrangement.map(node => ({ ...node, row: rows.current.get(node.id.slice(0, node.id.lastIndexOf(':'))) ?? node.row }))); requestAnimationFrame(() => fit()) }}>{t('workflowArrange')}</Button>}
        <Button size="sm" variant="ghost" disabled={state.loading || state.deleting.length > 0} onClick={() => { setRefreshKey(value => value + 1); actions.refresh(); void context.launches.refresh() }}><ui.IconRefreshOutlineRegular size={14} />{t('refresh')}</Button>
      </div></header>
      {wallpaper.error && <div className="vc-notice" role="alert">{t('wallpaperFailed')}<Button size="sm" variant="ghost" onClick={() => { setFocused(activeBatch?.runId ?? ''); actions.refresh() }}>{t('refresh')}</Button></div>}
      {(state.error || openError || launches.error) && <div className="vc-notice" role="alert">{t(openError ? 'taskScopeFailed' : 'taskBatchReadFailed')}{!openError && (state.failure || launches.error) && <code>{state.failure?.stage ?? launches.failure?.stage} {state.failure?.code ?? launches.error}</code>}<Button size="sm" variant="ghost" onClick={() => { setOpenError(false); actions.refresh(); void context.launches.refresh() }}>{t('retry')}</Button></div>}
      <div className="vc-workflow-content" data-level={imageView ? 'image' : 'batch'}>
        {imageView && <ImageNavigator control={wallpaper} t={t} onSelect={() => setSelected(new Set())} />}<div className="vc-workflow-stage" data-workflow-node-count={imageView ? imageWorkflowStages.length : nodes.length}>
        {imageView && nodes.find(node => node.data.kind === 'planning' && node.data.batch?.runId === wallpaper.sourceId) ? <ImageFlow key={wallpaper.sourceId} base={nodes.find(node => node.data.kind === 'planning' && node.data.batch?.runId === wallpaper.sourceId)!.data} /> : <ReactFlow<FlowNode, WorkflowEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={setInstance} {...(layout.initialViewport ? { defaultViewport: layout.initialViewport } : {})} proOptions={{ hideAttribution: true }} onlyRenderVisibleElements minZoom={0.15} maxZoom={2} panOnDrag={[0, 1]} panActivationKeyCode="Space" selectionKeyCode={['Control', 'Meta', 'Shift']} multiSelectionKeyCode={['Control', 'Meta']} selectionMode={SelectionMode.Partial} nodeDragThreshold={6} nodeClickDistance={6} paneClickDistance={6} zoomOnDoubleClick={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
          onNodesChange={changes => {
            for (const change of changes) if (change.type === 'position' && change.position) layout.move(change.id, change.position)
            for (const change of changes) if (change.type === 'dimensions' && change.dimensions) layout.measure(change.id, change.dimensions)
            const selections = changes.filter(change => change.type === 'select')
            if (selections.length) setSelected(current => { const next = new Set(current); for (const change of selections) { if (change.selected) next.add(change.id); else next.delete(change.id) } return next })
          }}
          onNodeClick={(event, node) => { if (node.data.batch) setFocused(node.data.batch.runId); if (!(event.target instanceof Element) || !event.target.closest('button, input, textarea, a, select, [contenteditable="true"]')) { if (node.data.image) node.data.wallpaper.page(node.data.image.index); if (!event.ctrlKey && !event.metaKey && !event.shiftKey) setSelected(new Set([node.id])); canvasRef.current?.focus({ preventScroll: true }) } }} onNodeDoubleClick={(event, node) => { if (!(event.target instanceof Element) || !event.target.closest('button, input, textarea, a, select')) fit(node.data.laneId) }} onPaneClick={() => { setSelected(new Set()); setContextMenu(null) }}
          onNodeContextMenu={(event, node) => openMenu(event, [node])} onSelectionContextMenu={openMenu}
          onSelectionStart={() => { setContextMenu(null); navigated.current = true; setInteracting(true) }} onSelectionEnd={() => { setInteracting(false); canvasRef.current?.focus({ preventScroll: true }) }} onSelectionDragStart={() => { setContextMenu(null); navigated.current = true; setInteracting(true) }} onSelectionDragStop={() => { setInteracting(false); layout.reconcile(instance?.getViewport()); canvasRef.current?.focus({ preventScroll: true }) }}
          onNodeDragStart={() => { setContextMenu(null); navigated.current = true; setInteracting(true) }} onNodeDragStop={() => { setInteracting(false); layout.reconcile(instance?.getViewport()); canvasRef.current?.focus({ preventScroll: true }) }} onMoveStart={event => { setInteracting(true); if (event) { setContextMenu(null); navigated.current = true } }} onMoveEnd={(event, at) => { setInteracting(false); if (event || navigated.current) layout.save(at) }}
          ariaLabelConfig={{ 'node.a11yDescription.default': t('workflowHelp'), 'node.a11yDescription.keyboardDisabled': t('workflowHelp'), 'edge.a11yDescription.default': t('workflowAutomatic'), 'handle.ariaLabel': t('workflowAutomatic'), 'minimap.ariaLabel': t('workflowMinimap') }}>
          <Background gap={24} size={1} /><MiniMap pannable zoomable nodeClassName="vc-workflow-minimap-node" />
          <Navigation t={t} fit={() => fit()} focus={focusBatch} navigate={() => { navigated.current = true }} />
        </ReactFlow>}<div className="vc-workflow-help"><span>{t('workflowHelp')}</span></div>
      </div><StyleSidebar open={styleOpen} style={context.style} actions={context.profileActions} t={t} notes={notes} onNotes={editNotes} onClose={closeStyle} onProfile={() => { closeStyle(); context.onProfile() }} onReferences={context.onReferences} onSearch={value => context.onSearch(value)} /></div>
      {!notesSaved && <p className="vc-notice" role="status">{t('workflowNotesUnsaved')}</p>}
      <ui.Menu listClassName="vc-menu" open={!!contextMenu && menuNodes.length > 0} anchor={null} portal autoFocus contextual returnFocus={() => contextMenu?.origin?.isConnected ? contextMenu.origin : null} getAnchorRect={() => contextMenu ? new DOMRect(contextMenu.x, contextMenu.y, 0, 0) : null} items={menuEntries} onClose={() => setContextMenu(null)} onSelect={id => { const action = menuActions.get(id); setContextMenu(null); action?.() }} />
      <WallpaperDialogs control={wallpaper} t={t} />
      {notice && <ui.Toast key={notice.id} text={t(notice.success ? 'taskBatchDeleted' : 'taskBatchDeleteFailed')} {...(notice.success ? { tone: 'success' as const } : {})} onDone={() => setNotice(null)} />}
      <Modal open={!!deleteTargets} onClose={closeDelete} title={t('workflowDeleteTitle')} closeLabel={t('close')} className="vc-delete-modal"
        footer={<div className="vc-flow-node-actions"><Button variant="outline" onClick={closeDelete}>{t(deleting ? 'close' : 'cancel')}</Button><Button variant="outline" className="vc-search-batch-delete" disabled={deleting || !deleteTargets?.length} onClick={() => { void confirmDelete() }}>{deleting ? <StateDot state="ongoing" /> : <ui.IconTrashOutlineRegular size={16} />}{t(deleting ? 'workflowDeleting' : deleteErrors.length ? 'retry' : deleteTargets?.some(item => item.active) ? 'workflowDeleteStoppingConfirm' : 'workflowDeleteConfirm')}</Button></div>}>
        <p>{t('workflowDeleteCount').replace('{count}', String(deleteTargets?.length ?? 0))}</p><p>{t('workflowDeleteScope')}</p><p>{t('workflowDeletePreserve')}</p><p>{t('workflowDeleteStopHint')}</p>
        <ul>{deleteTargets?.map(item => <li key={`${item.target.kind}:${item.target.id}`}>{item.label}{item.active && <Tag tone="warning">{t('workflowDeleteActive')}</Tag>}</li>)}</ul>
        {(deleting || deleteProgress.completed > 0) && <p role="status" aria-live="polite">{t('workflowDeleteProgress').replace('{completed}', String(deleteProgress.completed)).replace('{total}', String(deleteProgress.total))}</p>}
        {deleting && <p className="vc-muted" role="status">{t('workflowDeleteWaiting')}</p>}
        {deleteErrors.length > 0 && <div className="vc-notice" role="alert"><p>{t('workflowDeleteFailed')}</p><ul>{deleteErrors.map((item, index) => <li key={index}>{item.label} <code>{item.code}</code></li>)}</ul></div>}
      </Modal>
      <ImageGallery images={previewBatch?.images.flatMap(image => { const path = resource(image.previewPath); return path ? [{ id: image.imageVersionId, path, name: image.name }] : [] }) ?? []} selectedId={preview?.imageId ?? null} onSelect={imageId => { if (preview) setPreview({ ...preview, imageId }) }} onClose={() => setPreview(null)} t={t} />
    </section>
  }
  return function AutomaticWorkflowCanvas(props: AutomaticWorkflowProps) { return <Canvas key={props.styleId} {...props} /> }
}
