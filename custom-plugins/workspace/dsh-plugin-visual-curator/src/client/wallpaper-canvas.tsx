/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Bounded live wallpaper reads and download, planning, rendering and review nodes use native controls. */
import { z } from 'zod'
import { wallpaperCanCancel, wallpaperImageWorkStatus, wallpaperPendingDecision, wallpaperExperienceSchema, wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperViewSchema, wallpaperFailedStep, wallpaperVerdict, wallpaperBackgroundReview, wallpaperDownloadProgress, type WallpaperDownloadProgress, type WallpaperExperience, type WallpaperView, type WallpaperPlan } from '../shared/wallpaper.ts'
import { backgroundResolutionSettingsSchema } from '../shared/background-resolution.ts'
import type { SearchBatch } from '../shared/search-batches.ts'
import type { Json } from './contract.ts'
import { jsonSchema } from '../shared/model.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'
import { wallpaperStage, workflowPhaseKeys, type WallpaperStep } from './workflow-node-state.ts'
import { createSelectField } from './select-field.tsx'
import { wallpaperRecovery, wallpaperCanDecide } from './wallpaper-recovery.ts'
import { createWallpaperPlanEditor } from './wallpaper-plan-editor.tsx'
import { wallpaperImageHistory } from './wallpaper-history.ts'
import { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'
import { imageWorkflowDetail, imageWorkflowPreviousReview, imageWorkflowClarity, imageWorkflowArtifact, imageWorkflowStageReached, imageWorkflowPresentationStages, imageWorkflowDecisionRecord, planningWindowStart, planningImagePhase, imageNavigationPageSize, imageWorkflowPhase, imageWorkflowStagePhase, type ImageWorkflowStage } from './workflow-image-branches.ts'

/** Narrow operations used by canvas observation and explicit owner actions. */
export type WallpaperOperation = 'local-reference-pick' | 'direct-crop-replace' | 'wallpaper-read' | 'wallpaper-start' | 'wallpaper-options' | 'wallpaper-control' | 'wallpaper-continue' | 'wallpaper-plan-update' | 'wallpaper-experience' | 'wallpaper-experience-action' | 'wallpaper-case'
/** Native transport retains the current authenticated profile and never accepts caller-supplied actors. */
export type WallpaperInvoke = (operation: WallpaperOperation, args: Record<string, Json>, signal?: AbortSignal) => Promise<unknown>

const active = (status: string) => ['created', 'running', 'pausing', 'cancelling'].includes(status)
const isGeneratedCanvasMode = (mode: string | undefined) => mode === 'generated-canvas-v1' || mode === 'generated-canvas-protected-v2'
const modeKeys = { single: 'wallpaperSingle', group: 'wallpaperGroup', scene: 'wallpaperScene', abstract: 'wallpaperAbstract', uncertain: 'wallpaperUncertain' } as const
const checkKeys = { subject: 'wallpaperSubjectCheck', protection: 'wallpaperProtectionCheck', clock: 'wallpaperClockCheck', readability: 'wallpaperReadabilityCheck', composition: 'wallpaperCompositionCheck', background: 'wallpaperBackgroundCheck', style: 'wallpaperStyleCheck', clarity: 'wallpaperClarityCheck' } as const
const stepKeys = { downloading: 'wallpaperDownloading', planning: 'wallpaperPlanning', rendering: 'wallpaperRendering', reviewing: 'wallpaperReviewing', detail: 'directCropReinspect', decision: 'wallpaperDecision' } as const
const decisionActions = { continue_current_plan: 'wallpaperDecisionContinue', inspect_region: 'wallpaperDecisionInspect', replan: 'wallpaperDecisionReplan', retry_reference_preparation: 'wallpaperDecisionReference', query_saved_generation: 'wallpaperDecisionReceipt', recompose_saved_background: 'wallpaperDecisionRecompose', reconstruct_saved_background: 'wallpaperDecisionReconstruct', retry_saved_review: 'wallpaperDecisionReview', skip_image: 'wallpaperDecisionSkip', manual_review: 'wallpaperDecisionHuman' } as const
const decisionStatuses = { running: 'wallpaperDecisionRunning', applied: 'wallpaperDecisionApplied', manual: 'wallpaperDecisionManual', skipped: 'wallpaperDecisionSkipped', failed: 'wallpaperDecisionFailed' } as const
const decisionScopes = { subject: 'wallpaperDecisionSubject', critical: 'wallpaperDecisionCritical', background: 'wallpaperDecisionBackground', technical: 'wallpaperDecisionTechnical' } as const
const decisionClassifications = { 'frame-truncation': 'wallpaperDecisionTruncation', 'normal-occlusion': 'wallpaperDecisionOcclusion', 'background-crop': 'wallpaperDecisionBackgroundCrop', 'observation-limit': 'wallpaperDecisionObservation', 'technical-failure': 'wallpaperDecisionTechnicalFailure', resolved: 'wallpaperDecisionResolved', unknown: 'wallpaperDecisionUnknown', 'edge-continuation': 'wallpaperDecisionEdgeContinuation', 'unseen-detail': 'wallpaperDecisionUnseenDetail' } as const
const versionKeys = { candidate: 'wallpaperCandidate', 'pending-evidence': 'wallpaperPendingEvidence', verified: 'wallpaperVerified', active: 'wallpaperActive', retired: 'wallpaperRetired' } as const
const settingsReply = z.object({ settings: wallpaperSettingsSchema, models: z.array(z.object({ id: z.string(), name: z.string() })) })
const caseReply = z.object({ caseId: z.string(), sourcePath: z.string(), outputPath: z.string().optional() })
const downloadKeys = { waiting: 'wallpaperOriginalWaiting', locating: 'wallpaperOriginalLocating', downloading: 'wallpaperOriginalDownloading', retrying: 'wallpaperOriginalRetrying', saving: 'wallpaperOriginalSaving', saved: 'workflowDownloadSaved', reused: 'wallpaperOriginalReused', restricted: 'wallpaperOriginalRestricted', failed: 'wallpaperOriginalFailed', paused: 'paused', cancelled: 'cancelled' } as const
const downloadMoving = (phase: WallpaperDownloadProgress['phase']) => ['locating', 'downloading', 'retrying', 'saving'].includes(phase)
const downloadPercent = (progress: WallpaperDownloadProgress) => progress.phase === 'downloading' && progress.totalBytes !== undefined && progress.totalBytes > 0 ? Math.min(100, Math.floor(progress.receivedBytes / progress.totalBytes * 100)) : undefined
const downloadBytes = (bytes: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(bytes / (bytes >= 1_000_000 ? 1_000_000 : 1_000)) + (bytes >= 1_000_000 ? ' MB' : ' KB')

function planValidationMessage(plan: WallpaperPlan, view: WallpaperView, originalId: string | undefined) {
  if (originalId && plan.imageVersionId !== originalId) return 'wallpaperInvalidPlan' as const
  const source = view.sourceImages[plan.imageVersionId]
  if (!source) return undefined
  try {
    const { checks } = wallpaperGeometry(source, plan, view.settings)
    if (checks.some(check => check !== 'uncertain-subject' && check !== 'missing-protected-regions')) return 'wallpaperGeometryFailed' as const
    return checks.length ? 'wallpaperUncertainReason' as const : undefined
  } catch (error) { return 'wallpaperGeometryFailed' as const }
}

/**
 * @param React Shared native React.
 * @param ui Native components.
 * @returns Wallpaper observation, nodes and dialogs with scoped lifetimes.
 */
export function createWallpaperCanvas(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const SelectField = createSelectField(React, ui)
  const PlanEditor = createWallpaperPlanEditor(React, ui)
  const resource = (path: string | undefined) => path && safeResourcePath(path) ? new URL(path.slice(1), document.baseURI).href : undefined
  function useWallpaper(batch: SearchBatch | undefined, invoke: WallpaperInvoke | undefined, pollMs: number, pageSize: number, refreshKey = 0, windowSize = 1, pinnedRunId?: string) {
    const sourceId = batch && (batch.kind === 'search' || 'directCrop' in batch && batch.directCrop === true) ? batch.runId : '', enabled = !!invoke, latest = React.useRef(invoke); latest.current = invoke
    const current = React.useRef(sourceId); current.current = sourceId
    const [task, setTask] = React.useState<WallpaperView | null>(null), [page, setPage] = React.useState({ sourceId, offset: 0 }), [revision, refresh] = React.useState(0)
    const [resolvedPage, setResolvedPage] = React.useState<{ sourceId: string; runId: string | undefined; offset: number }>()
    const offset = page.sourceId === sourceId ? page.offset : 0
    const windowStart = planningWindowStart(offset, windowSize)
    const [actionNotice, setActionNotice] = React.useState('')
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(false), [settingsOpen, setSettingsOpen] = React.useState(false)
    const [settings, setSettings] = React.useState(() => wallpaperSettingsSchema.parse({})), [models, setModels] = React.useState<{ id: string; name: string }[]>([])
    const [preview, setPreview] = React.useState<string | null>(null), [planText, setPlanText] = React.useState<string | null>(null)
    const [details, setDetails] = React.useState<WallpaperStep | 'clarity' | 'detail' | 'decision' | null>(null), [historyOpen, setHistoryOpen] = React.useState(false)
    const [detailVersion, setDetailVersion] = React.useState<{ image: string; revision: number } | undefined>()
    const [experience, setExperience] = React.useState<WallpaperExperience | null>(null), [experienceOpen, setExperienceOpen] = React.useState(false)
    const [sample, setSample] = React.useState<z.infer<typeof caseReply> | null>(null), [viewed, setViewed] = React.useState(false)
    const alive = React.useRef(true)
    const working = React.useRef(false), operation = React.useRef({ sourceId, id: crypto.randomUUID() }), mutation = React.useRef({ key: '', id: '' })
    const [selectedRevision, setRevision] = React.useState({ image: '', revision: 0 })
    React.useEffect(() => { setDetails(null); setHistoryOpen(false) }, [sourceId, offset])
    const mutationId = (key: string) => { if (mutation.current.key !== key) mutation.current = { key, id: crypto.randomUUID() }; return mutation.current.id }
    React.useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
    // Settled tasks read again only for owner/shared updates, visibility or an expiring Session resource grant.
    React.useEffect(() => {
      if (!sourceId || !latest.current) { setTask(null); return }
      const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, reading = false, refreshQueued = false, renewedExpiry: number | undefined
      const read = async () => {
        if (controller.signal.aborted || document.hidden || reading) return
        clearTimeout(timer); timer = undefined; reading = true
        let poll = true, expiresAt: number | undefined
        try {
          const raw = await latest.current!('wallpaper-read', { sourceRunId: sourceId, ...(pinnedRunId ? { runId: pinnedRunId } : {}), offset: windowStart, limit: windowSize }, controller.signal)
          if (!controller.signal.aborted) {
            const value = raw === null ? null : wallpaperViewSchema.parse(raw)
            if (value && (value.sourceRunId !== sourceId || !!pinnedRunId && value.runId !== pinnedRunId || value.offset !== windowStart || value.state.items.some((item, index) => value.itemIndex?.[windowStart + index] && value.itemIndex[windowStart + index]!.imageVersionId !== item.imageVersionId))) throw new Error('Wallpaper response does not match the requested image window')
            setTask(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setError(false)
            expiresAt = value?.resourceExpiresAt
            setPreview(previous => {
              if (!previous || !value) return previous
              const imageId = new URL(previous).searchParams.get('imageVersionId')
              if (!imageId) return previous
              const paths = [...Object.values(value.resources), ...Object.values(value.previewResources), ...Object.values(value.sourceImages).map(image => image.previewPath)]
              const updated = paths.find(path => new URL(path, document.baseURI).searchParams.get('imageVersionId') === imageId)
              return resource(updated) ?? previous
            })
            poll = value ? active(value.status) || Object.values(value.serverTransfers ?? {}).some(transfer => transfer.status === 'uploading' || transfer.status === 'waiting' && transfer.current === true) : active(batch?.wallpaper?.status ?? '') || !!batch?.wallpaperRequested && !batch.postProcessingError && (active(batch.status) || batch.status === 'completed' && batch.matched > 0)
          }
        }
        catch (error) { if (!controller.signal.aborted) { setError(true); if (renewedExpiry !== undefined) poll = false } }
        finally {
          reading = false
          if (!controller.signal.aborted) setResolvedPage(previous => previous?.sourceId === sourceId && previous.runId === pinnedRunId && previous.offset === windowStart ? previous : { sourceId, runId: pinnedRunId, offset: windowStart })
          if (!controller.signal.aborted && !document.hidden) {
            if (refreshQueued) { refreshQueued = false; void read() }
            else if (poll) timer = setTimeout(() => { void read() }, pollMs)
            // The Host reuses unexpired grants; wait until expiry, then attempt each expiry only once.
            else if (expiresAt !== undefined && expiresAt > (renewedExpiry ?? 0)) timer = setTimeout(() => { renewedExpiry = expiresAt; void read() }, Math.max(1, expiresAt - Date.now() + 1))
          }
        }
      }
      const visibility = () => {
        clearTimeout(timer); timer = undefined
        if (!document.hidden) { if (reading) refreshQueued = true; else void read() }
      }
      document.addEventListener('visibilitychange', visibility)
      void read()
      return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility) }
    }, [sourceId, pinnedRunId, windowStart, windowSize, revision, pollMs, refreshKey, enabled, batch?.status, batch?.matched, batch?.wallpaperRequested, batch?.wallpaper?.runId, batch?.wallpaper?.status, batch?.postProcessingError])
    React.useEffect(() => { setBusy(false); setError(false); setSettingsOpen(false); setPlanText(null); setPreview(null); setExperienceOpen(false); setSample(null) }, [sourceId])
    const work = async (callback: (call: WallpaperInvoke) => Promise<void>) => {
      if (!latest.current || working.current) return
      working.current = true
      const scope = sourceId; setBusy(true); setError(false); setActionNotice('')
      try { await callback(latest.current); if (alive.current && current.current === scope) refresh(value => value + 1) }
      catch (error) { if (alive.current && current.current === scope) setError(true) }
      finally { working.current = false; if (alive.current && current.current === scope) setBusy(false) }
    }
    const value = task?.sourceRunId === sourceId && (!pinnedRunId || task.runId === pinnedRunId) && task.offset === windowStart ? task : null
    const item = value?.state.items[offset - windowStart]
    const attempt = (selectedRevision.image === item?.imageVersionId ? item?.attempts.find(row => row.revision === selectedRevision.revision) : undefined) ?? item?.attempts.at(-1)
    const detailAttempt = detailVersion?.image === item?.imageVersionId ? item?.attempts.find(row => row.revision === detailVersion?.revision) ?? attempt : attempt
    return { loading: !!sourceId && enabled && (resolvedPage?.sourceId !== sourceId || resolvedPage?.runId !== pinnedRunId || resolvedPage?.offset !== windowStart), value, item, attempt, detailAttempt, setRevision: (value: { image: string; revision: number }) => setRevision(value), setDetailRevision: (value: { image: string; revision: number }) => setDetailVersion(value), sourceId, downloads: task?.sourceRunId === sourceId && (!pinnedRunId || task.runId === pinnedRunId) ? task.downloads ?? {} : {}, itemIndex: task?.sourceRunId === sourceId ? task.itemIndex : undefined, total: task?.sourceRunId === sourceId ? task.total : batch?.matched ?? 0, sourceCount: batch?.matched ?? 0, pageSize: Math.max(1, pageSize), windowStart, windowSize, enabled: !!invoke, busy, error, actionNotice, offset, settings, models, settingsOpen, setSettingsOpen, setSettings, preview, setPreview, planText, setPlanText, details, historyOpen, setHistoryOpen, experience, experienceOpen, setExperienceOpen, sample, setSample, viewed, setViewed,
      setDetails(kind: WallpaperStep | 'clarity' | 'detail' | 'decision' | null, revision?: number) { setDetailVersion(kind && revision !== undefined && item ? { image: item.imageVersionId, revision } : undefined); setDetails(kind) },
      page(at: number) { const next = Math.max(0, at); if (next !== offset) { setPlanText(null); setDetails(null); setPreview(null) } setPage({ sourceId, offset: next }) },
      openSettings() { void work(async call => { const result = settingsReply.parse(await call('wallpaper-options', {})); if (current.current === sourceId) { operation.current = { sourceId, id: crypto.randomUUID() }; setSettings(result.settings); setModels(result.models); setSettingsOpen(true) } }) },
      start() { const parsed = wallpaperSettingsSchema.safeParse(settings); if (!parsed.success) { setError(true); return } void work(async call => { await call('wallpaper-start', { operationId: operation.current.id, sourceRunId: sourceId, settings: jsonSchema.parse(parsed.data) }); if (current.current === sourceId) setSettingsOpen(false) }) },
      control(command: 'pause' | 'resume' | 'cancel') { if (value) void work(async call => { await call('wallpaper-control', { runId: value.runId, command }) }) },
      replaceImage(title: string, oneImageMessage: string) {
        if (!value || !item || active(value.status) || value.status === 'cancelled' || value.state.version !== 2) return
        const runId = value.runId, imageVersionId = item.imageVersionId
        void work(async call => {
          const picked = z.object({ cancelled: z.boolean().optional(), files: z.array(z.object({ path: z.string(), name: z.string() })) }).parse(await call('local-reference-pick', { kind: 'file', title }))
          if (picked.cancelled || !picked.files.length) return
          if (picked.files.length !== 1) { setActionNotice(oneImageMessage); return }
          const file = picked.files[0]!
          await call('direct-crop-replace', { runId, imageVersionId, operationId: mutationId(`replace:${runId}:${imageVersionId}:${file.path}`), file })
          if (alive.current && current.current === sourceId) { setRevision({ image: '', revision: 0 }); setDetailVersion(undefined); setDetails(null) }
        })
      },
      cancelImage() { if (value && item && !active(value.status) && value.status !== 'cancelled' && item.status !== 'passed' && item.status !== 'cancelled') void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`cancel-image:${value.runId}:${item.imageVersionId}`), imageAction: { action: 'cancel', imageVersionId: item.imageVersionId } }) }) },
      retryCurrent() {
        if (!value || !item || active(value.status) || value.status === 'cancelled') return
        const saved = item.attempts.at(-1), recovery = wallpaperRecovery(value, item, saved)
        void work(async call => {
          const args = { runId: value.runId, operationId: mutationId(`retry-current:${value.runId}:${item.imageVersionId}:${saved?.revision ?? 0}`) }
          if (recovery.kind === 'rework' && saved?.outputId) await call('wallpaper-continue', { ...args, rework: { imageVersionId: item.imageVersionId, revision: saved.revision, outputId: saved.outputId } })
          else if (recovery.kind === 'download') await call('wallpaper-continue', { ...args, retryOriginal: { imageVersionId: item.imageVersionId } })
          else if (recovery.kind === 'review' && saved?.outputId) await call('wallpaper-continue', { ...args, review: { outputId: saved.outputId } })
          else if (recovery.kind === 'reinspect') await call('wallpaper-continue', { ...args, reinspect: { imageVersionId: item.imageVersionId } })
          else if (recovery.kind === 'retry' || recovery.kind === 'receipt') await call('wallpaper-continue', { ...args, retryImage: { imageVersionId: item.imageVersionId, ...(saved ? { revision: saved.revision } : {}), step: recovery.kind === 'retry' ? recovery.step : 'rendering' } })
          else return
          if (alive.current && current.current === sourceId) { setRevision({ image: '', revision: 0 }); setDetailVersion(undefined); setDetails(null) }
        })
      },
      continue() { if (value && value.status !== 'cancelled') void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`continue:${value.runId}`) }) }) },
      decide() { if (value && value.status !== 'cancelled' && item && !active(value.status) && wallpaperCanDecide(item, attempt, value.status) && (!!wallpaperPendingDecision(item, attempt) || item.reason !== 'decision-round-limit' && (value.settings.decision === undefined || (item.decisions?.at(-1)?.round ?? 0) < value.settings.decision.maxRoundsPerImage))) void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`decision:${value.runId}:${item.imageVersionId}:${attempt?.revision}:${item.decisions?.at(-1)?.id ?? ''}`), decision: { imageVersionId: item.imageVersionId } }) }) },
      retryImage(step: 'planning' | 'rendering' | 'reviewing') { if (value && item && attempt === item.attempts.at(-1)) void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId('image:' + value.runId + ':' + item.imageVersionId + ':' + (attempt?.revision ?? 0) + ':' + step), retryImage: { imageVersionId: item.imageVersionId, ...(attempt ? { revision: attempt.revision } : {}), step } }) }) },
      retryOriginal() { if (value && item) void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId('original:' + value.runId + ':' + item.imageVersionId), retryOriginal: { imageVersionId: item.imageVersionId } }) }) },
      rework() {
        if (!value || !item || !attempt?.outputId || attempt !== item.attempts.at(-1)) return
        void work(async call => {
          await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`rework:${value.runId}:${item.imageVersionId}:${attempt.revision}:${attempt.outputId}`), rework: { imageVersionId: item.imageVersionId, revision: attempt.revision, outputId: attempt.outputId! } })
          if (alive.current && current.current === sourceId) { setRevision({ image: '', revision: 0 }); setDetailVersion(undefined); setDetails(null) }
        })
      },
      reinspect() {
        if (!value || !item) return
        void work(async call => {
          await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`detail:${value.runId}:${item.imageVersionId}`), reinspect: { imageVersionId: item.imageVersionId } })
          if (alive.current && current.current === sourceId) {
            setRevision({ image: '', revision: 0 }); setDetailVersion(undefined); setDetails(null)
          }
        })
      },
      reviewCurrent() { if (value && attempt?.outputId) void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`review:${value.runId}:${attempt.outputId}`), review: { outputId: attempt.outputId! } }) }) },
      reviewGeneratedCanvas() { if (value && item && attempt?.generation && attempt === item.attempts.at(-1)) void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`generated-canvas:${value.runId}:${item.imageVersionId}:${attempt.revision}`), recompose: { imageVersionId: item.imageVersionId, revision: attempt.revision, mode: 'generated-canvas-v1', reviewPolicy: 'current', backgroundResolution: 'current' } }) }) },
      reconstructBackground() { if (value && item && attempt?.generation && attempt === item.attempts.at(-1)) void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`background-resolution:${value.runId}:${item.imageVersionId}:${attempt.revision}`), recompose: { imageVersionId: item.imageVersionId, revision: attempt.revision, mode: 'protected-context-v2', backgroundResolution: 'current' } }) }) },
      editPlan() { if (attempt) setPlanText(JSON.stringify(attempt.plan, null, 2)) },
      editImagePlan(imageId: string) {
        const index = value?.state.items.findIndex(row => row.imageVersionId === imageId) ?? -1
        const saved = index >= 0 ? value?.state.items[index]?.attempts.at(-1) : undefined
        if (!value || !saved) return
        setPage({ sourceId, offset: value.offset + index }); setRevision({ image: imageId, revision: saved.revision }); setPlanText(JSON.stringify(saved.plan, null, 2))
      },
      applyPlan() { if (!value || !item || planText === null) return; let parsed; try { parsed = wallpaperPlanSchema.safeParse(JSON.parse(planText)) } catch (error) { setError(true); return } if (!parsed.success) { setError(true); return } const plan = parsed.data; if (planValidationMessage(plan, value, item.originalId)) { setError(true); return } void work(async call => { await call('wallpaper-plan-update', { runId: value.runId, imageVersionId: item.imageVersionId, plan: jsonSchema.parse(plan), operationId: mutationId(`replan:${value.runId}:${item.imageVersionId}:${JSON.stringify(plan)}`) }); if (current.current === sourceId) setPlanText(null) }) },
      showExperience() { void work(async call => { const [saved, options] = await Promise.all([call('wallpaper-experience', {}), call('wallpaper-options', {})]); const catalog = wallpaperExperienceSchema.parse(saved), policy = settingsReply.parse(options); if (current.current === sourceId) { setExperience(catalog); setSettings(policy.settings); setExperienceOpen(true) } }) },
      experienceAction(args: Record<string, Json>) { void work(async call => { const catalog = wallpaperExperienceSchema.parse(await call('wallpaper-experience-action', args)); if (current.current === sourceId) { setExperience(catalog); setSample(null); setViewed(false) } }) },
      inspectCase(caseId: string) { void work(async call => { const entry = caseReply.parse(await call('wallpaper-case', { caseId })); if (current.current === sourceId) { setSample(entry); setViewed(false) } }) },
    }
  }
  type Controller = ReturnType<typeof useWallpaper>

  function DownloadProgress({ progress, t }: { progress: WallpaperDownloadProgress; t: WorkbenchText }) {
    const percent = downloadPercent(progress), moving = downloadMoving(progress.phase), label = t(downloadKeys[progress.phase])
    return <div className="vc-original-progress" data-download-phase={progress.phase}>
      <div><span>{label}</span>{percent !== undefined && <strong>{percent}%</strong>}</div>
      {moving && <div className="vc-original-progress-track" role="progressbar" aria-label={t('wallpaperOriginalProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={label + (percent === undefined ? '' : ' ' + percent + '%')} data-indeterminate={percent === undefined || undefined}><span style={percent === undefined ? undefined : { width: percent + '%' }} /></div>}
      {(progress.phase === 'downloading' || progress.phase === 'saving' || progress.phase === 'saved' || progress.phase === 'reused') && progress.receivedBytes > 0 && <small>{progress.phase === 'saved' || progress.phase === 'reused' ? t('wallpaperOriginalFileSize').replace('{size}', downloadBytes(progress.receivedBytes)) : t(progress.totalBytes === undefined ? 'wallpaperOriginalReceived' : 'wallpaperOriginalReceivedTotal').replace('{received}', downloadBytes(progress.receivedBytes)).replace('{total}', downloadBytes(progress.totalBytes ?? 0))}</small>}
    </div>
  }

  function ImageNavigator({ control, t, onSelect }: { control: Controller; t: WorkbenchText; onSelect(): void }) {
    const total = control.total
    const panel = React.useRef<HTMLElement>(null), drag = React.useRef<{ pointer: number; x: number; width: number; max: number } | null>(null)
    const widthKey = 'visual-curator:image-navigation-width:v1'
    const [width, setWidth] = React.useState(() => {
      try { const saved = Number(window.localStorage.getItem(widthKey)); return Number.isFinite(saved) && saved >= 112 && saved <= 360 ? saved : 124 }
      catch (error) { return 124 }
    })
    const maxWidth = () => Math.max(112, Math.min(360, (panel.current?.parentElement?.clientWidth ?? 1200) * 0.35))
    const clamp = (next: number, max = maxWidth()) => Math.round(Math.max(112, Math.min(max, next)))
    const saveWidth = (next: number) => { setWidth(next); try { window.localStorage.setItem(widthKey, String(next)) } catch (error) { /* Local preferences are optional when browser storage is unavailable. */ } }
    const finishResize = (event: import('react').PointerEvent<HTMLDivElement>, cancel = false) => {
      const current = drag.current
      if (!current || event.pointerId !== current.pointer) return
      drag.current = null
      if (cancel) setWidth(current.width); else saveWidth(clamp(current.width + event.clientX - current.x, current.max))
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const [directory, setDirectory] = React.useState({ sourceId: control.sourceId, start: planningWindowStart(control.offset, imageNavigationPageSize) })
    React.useEffect(() => setDirectory({ sourceId: control.sourceId, start: planningWindowStart(control.offset, imageNavigationPageSize) }), [control.sourceId, control.offset])
    const start = directory.sourceId === control.sourceId ? directory.start : 0
    const entries = control.itemIndex ?? []
    const select = (index: number) => { control.page(index); onSelect() }
    return <nav ref={panel} className="vc-image-navigator" data-compact={width < 192 || undefined} style={{ '--vc-image-rail-width': `${width}px` } as import('react').CSSProperties} aria-label={t('wallpaperImageNavigation')}>
      <div className="vc-image-navigation-heading">
        <div className="vc-image-navigation-picker"><ui.Button size="sm" variant="outline" aria-label={t('wallpaperPrevious')} disabled={!control.offset || control.busy} onClick={() => select(control.offset - 1)}><ui.IconChevronLeftOutlineRegular size={16} /></ui.Button>
          <SelectField menuClassName="vc-image-picker-menu" matchAnchorWidth={false} label={t('wallpaperJumpImage')} value={String(control.offset)} options={Array.from({ length: total }, (_, index) => { const entry = entries[index], progress = entry ? control.downloads[entry.imageVersionId] : undefined; const state = control.value?.status === 'cancelled' && entry?.status !== 'passed' ? t(workflowPhaseKeys.cancelled) : progress && !['saved', 'reused', 'waiting'].includes(progress.phase) ? t(downloadKeys[progress.phase]) : entry && ['needs-review', 'rejected', 'technical-failed'].includes(entry.status) ? t('wallpaperAttention') : ''; return { value: String(index), label: t('wallpaperImage') + ' ' + (index + 1) + ' / ' + total + (state ? ' · ' + state : '') } })} disabled={control.busy || !total} onChange={value => select(Number(value))} />
          <ui.Button size="sm" variant="outline" aria-label={t('wallpaperNext')} disabled={control.offset + 1 >= total || control.busy} onClick={() => select(control.offset + 1)}><ui.IconChevronRightOutlineRegular size={16} /></ui.Button></div>
        {total > imageNavigationPageSize && <div className="vc-image-directory-pagination"><ui.Button size="sm" variant="ghost" aria-label={t('wallpaperPreviousThumbnails')} disabled={!start} onClick={() => setDirectory({ sourceId: control.sourceId, start: Math.max(0, start - imageNavigationPageSize) })}><ui.IconChevronLeftOutlineRegular size={16} /></ui.Button><ui.Button size="sm" variant="ghost" aria-label={t('wallpaperNextThumbnails')} disabled={start + imageNavigationPageSize >= total} onClick={() => setDirectory({ sourceId: control.sourceId, start: start + imageNavigationPageSize })}><ui.IconChevronRightOutlineRegular size={16} /></ui.Button></div>}
      </div>
      <div className="vc-image-thumbnail-strip" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault(); select(Math.max(0, Math.min(total - 1, control.offset + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1))))
      }}>
        {Array.from({ length: Math.min(imageNavigationPageSize, Math.max(0, total - start)) }, (_, slot) => {
          const index = start + slot, entry = entries[index], path = resource(entry?.previewPath), progress = entry ? control.downloads[entry.imageVersionId] : undefined, percent = progress ? downloadPercent(progress) : undefined
          const downloadLabel = progress ? t(downloadKeys[progress.phase]) : ''
          const cancelled = control.value?.status === 'cancelled' && entry?.status !== 'passed'
          const stepLabel = cancelled ? t(workflowPhaseKeys.cancelled) : entry ? t(entry.status === 'planning' ? 'wallpaperImagePlanning' : entry.status === 'rendering' ? 'wallpaperImageRendering' : entry.status === 'reviewing' ? 'wallpaperImageReviewing' : entry.status === 'passed' ? 'wallpaperImagePassed' : entry.status === 'rejected' ? 'wallpaperImageRejected' : entry.status === 'technical-failed' || entry.status === 'needs-review' ? 'wallpaperImageAttention' : 'wallpaperImageQueued') : ''
          const shortLabel = cancelled ? stepLabel : progress && (progress.phase === 'saved' || progress.phase === 'reused') ? stepLabel : percent !== undefined ? percent + '%' : progress?.phase === 'locating' ? t('wallpaperOriginalConnectingShort') : progress?.phase === 'saving' ? t('wallpaperOriginalSavingShort') : progress?.phase === 'downloading' ? t('wallpaperOriginalDownloadingShort') : downloadLabel
          return <button key={entry?.imageVersionId ?? index} type="button" className="vc-image-thumbnail" data-image-index={index} data-status={cancelled ? 'cancelled' : entry?.status} aria-current={index === control.offset ? 'true' : undefined} aria-label={`${t('wallpaperImage')} ${index + 1}` + (shortLabel ? ' · ' + shortLabel : '')} disabled={control.busy} onClick={() => select(index)}>
            {path ? <img src={path} alt="" loading="lazy" decoding="async" draggable={false} /> : <ui.IconBrowseOutlineRegular size={20} />}<span className="vc-image-thumbnail-number"><span>{index + 1}</span>{progress && <small data-download-phase={progress.phase}>{shortLabel}</small>}</span>
            {progress && downloadMoving(progress.phase) && <span className="vc-original-thumbnail-progress vc-original-progress-track" aria-hidden="true" data-indeterminate={percent === undefined || undefined}><span style={percent === undefined ? undefined : { width: percent + '%' }} /></span>}
          </button>
        })}
      </div>
      <div className="vc-image-navigation-resize" role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t('wallpaperResizeNavigation')} aria-valuemin={112} aria-valuemax={maxWidth()} aria-valuenow={clamp(width)}
        onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); drag.current = { pointer: event.pointerId, x: event.clientX, width: panel.current?.getBoundingClientRect().width ?? width, max: maxWidth() }; event.currentTarget.setPointerCapture(event.pointerId) }}
        onPointerMove={event => { const current = drag.current; if (current?.pointer === event.pointerId) setWidth(clamp(current.width + event.clientX - current.x, current.max)) }}
        onPointerUp={event => finishResize(event)} onPointerCancel={event => finishResize(event, true)} onLostPointerCapture={event => finishResize(event, true)}
        onDoubleClick={() => saveWidth(124)} onKeyDown={event => {
          if (event.key === 'Escape' && drag.current) { const current = drag.current; drag.current = null; setWidth(current.width); event.preventDefault(); if (event.currentTarget.hasPointerCapture(current.pointer)) event.currentTarget.releasePointerCapture(current.pointer); return }
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
          event.preventDefault(); saveWidth(event.key === 'Home' ? 112 : event.key === 'End' ? clamp(maxWidth()) : clamp(width + (event.key === 'ArrowRight' ? 16 : -16)))
        }} />
    </nav>
  }

  function ImageStepPreview({ preview, full, label, waiting, generating = false, enhancing = false, progress, moving, control, t }: { preview: string | undefined; full: string | undefined; label: string; waiting: boolean; generating?: boolean; enhancing?: boolean; progress?: { completed: number; total: number; unit: 'tiles' | 'percent' } | undefined; moving: boolean; control: Controller; t: WorkbenchText }) {
    const [loaded, setLoaded] = React.useState(''), [failed, setFailed] = React.useState(''), [aspect, setAspect] = React.useState({ width: 9, height: 16 })
    const ready = !!preview && loaded === preview, error = !!preview && failed === preview
    const pending = !error && (!enhancing && waiting && control.value?.status !== 'cancelled' || !!preview && !ready)
    const processing = !moving ? t(workflowPhaseKeys.paused) : !progress?.total ? t('wallpaperResolutionWaiting') : progress.completed === progress.total ? t('wallpaperResolutionFinalizing') : progress.unit === 'percent' ? t('wallpaperResolutionPercent').replace('{percent}', String(Math.floor(progress.completed / progress.total * 100))) : t('wallpaperResolutionTiles').replace('{completed}', String(progress.completed)).replace('{total}', String(progress.total))
    return <button type="button" className="vc-image-step-preview" data-generating={generating && !enhancing || undefined} data-enhancing={enhancing || undefined} disabled={!full && !error} aria-label={error ? t('wallpaperEditorRetryImage') : label} aria-busy={pending || enhancing || undefined} onClick={() => { if (error) { setLoaded(''); setFailed('') } else if (full) control.setPreview(full) }}>
      {pending && (generating ? <ui.ImageGenerationSkeleton active={moving} className="vc-generation-landscape" /> : <span className="vc-skeleton-fill vc-image-preview-skeleton" aria-hidden="true" />)}
      {preview && !error ? <img key={preview} data-loaded={ready || undefined} onLoad={event => { setLoaded(preview); setAspect({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }) }} onError={() => setFailed(preview)} src={preview} alt="" loading="lazy" decoding="async" draggable={false} /> : !pending && (error ? <span className="vc-flow-muted">{t('wallpaperEditorRetryImage')}</span> : <ui.IconBrowseOutlineRegular size={24} />)}
      {enhancing && preview && !error && <><svg className="vc-resolution-overlay" viewBox={`0 0 ${aspect.width} ${aspect.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true" data-moving={moving || undefined}><g className="vc-resolution-scan"><rect x="0" y="-32" width="100%" height="64" fill="currentColor" opacity=".12" /><line x1="0" x2="100%" y1="0" y2="0" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" /></g></svg><span className="vc-resolution-badge" role="status" aria-live="polite">{processing}</span></>}
    </button>
  }
  function GenerationBriefDetails({ control, t, detailed = false }: { control: Controller; t: WorkbenchText; detailed?: boolean }) {
    const brief = (detailed ? control.detailAttempt : control.attempt)?.generationBrief
    if (!brief) return null
    return <section className="vc-generation-brief"><strong>{t(brief.status === 'saved' ? 'wallpaperGenerationPromptSaved' : 'wallpaperPreparingGenerationPrompt')}</strong><small className="vc-flow-muted">{t('wallpaperPromptEffort')} · {brief.reasoningEffort}</small>{detailed && brief.status === 'saved' && <><strong>{t('wallpaperStyleAnchors')}</strong><ul>{brief.result.styleAnchors.map((anchor, index) => <li key={index}>{anchor}</li>)}</ul><strong>{t('wallpaperDetailAnchors')}</strong><ul>{brief.result.detailAnchors.map((anchor, index) => <li key={index}>{anchor}</li>)}</ul><details><summary>{t('wallpaperAuthoredPrompt')}</summary><p className="vc-generation-prompt-text">{brief.result.generationPrompt}</p></details></>}</section>
  }
  function issueMessage(item: Controller['item'], t: WorkbenchText): string {
    const failureMessage = (code: string | undefined) => code === 'vision-invalid-output' || code === 'vision-output-truncated' ? t('wallpaperStructuredFailure') : code === 'remote-timeout' || code === 'remote-idle-timeout' ? t('wallpaperFailureTimeout') : code === 'source-protocol-error' ? t('wallpaperFailureProtocol') : code === 'image-resolution-insufficient' ? t('wallpaperFailureResolution') : code && ['IMAGE_TOO_LARGE', 'IMAGES_TOO_LARGE', 'IMAGE_TOO_MANY_PIXELS', 'IMAGE_DIMENSION_TOO_LARGE'].includes(code) ? t('wallpaperFailureReference') : code === 'image-operation-failed' ? t('wallpaperFailureGeneration') : code === 'original-source-restricted' ? t('workflowSourceRestricted') : code === 'original-account-mismatch' ? t('workflowSourceAccount') : code === 'vision-image-too-large' ? t('workflowVisionTooLarge') : code === 'vision-image-digest-mismatch' ? t('workflowVisionDigest') : code?.startsWith('original-download-http-') ? t('workflowDownloadNetwork') : code === 'reference-unavailable' || code === 'original-source-unavailable' ? t('workflowSourceUnavailable') : undefined
    const explanation = (text: string | undefined) => !text ? '' : text === 'image-operation-failed' ? t('wallpaperFailureGeneration') : text === 'IMAGE_CREDITS_DISABLED' ? t('wallpaperCreditsDisabled') : text === 'image-operation-pruned' ? t('wallpaperReceiptPruned') : text === 'rework-limit' ? t('wallpaperReworkLimit') : text === 'edit-limit' ? t('wallpaperEditLimit') : text === 'image-capability-unavailable' ? t('wallpaperMissingCapability') : text === 'outcome-unknown' || text === 'image-outcome-unknown' || text === 'interrupted-after-send' ? t('wallpaperUnknown') : text === 'uncertain-subject' ? t('wallpaperUncertainReason') : text === 'vision-detail-unavailable' ? t('directCropDetailUnavailable') : text === 'unchanged-review-evidence' ? t('directCropUnchangedReview') : text
    return failureMessage(item?.errorCode) || explanation(item?.reason) || t('wallpaperGeometryFailed')
  }
  function ImageRecoveryAction({ control, t, pauseControl = false }: { control: Controller; t: WorkbenchText; pauseControl?: boolean }) {
    if (!control.value) return null
    const recovery = wallpaperRecovery(control.value, control.item, control.attempt), running = active(control.value.status)
    if (recovery.kind === 'none') return null
    if (recovery.kind === 'history') return <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => { if (control.item?.attempts.at(-1)) control.setRevision({ image: control.item.imageVersionId, revision: control.item.attempts.at(-1)!.revision }) }}>{t('wallpaperRecoveryLatest')}</ui.Button>
    const reconstruct = control.item?.errorCode === 'image-resolution-insufficient' && !!control.attempt?.generationInput && control.attempt.compositionMode === 'protected-context-v2'
    const label = recovery.kind === 'canvas' ? 'wallpaperGeneratedCanvasAction' : recovery.kind === 'rework' ? 'wallpaperRecoveryRework' : recovery.kind === 'download' ? control.item?.errorCode === 'original-source-restricted' || control.item?.errorCode === 'source-protocol-error' ? 'wallpaperOriginalRecheck' : 'wallpaperOriginalRetry' : recovery.kind === 'receipt' ? 'wallpaperRecoveryReceipt' : recovery.kind === 'reinspect' ? 'directCropReinspect' : recovery.kind === 'edit' ? 'wallpaperEditPlan' : recovery.kind === 'review' ? 'wallpaperReviewCurrent' : control.item?.status === 'technical-failed' ? 'wallpaperRecoveryRetry' : 'wallpaperRecoveryContinue'
    return <React.Fragment><ui.Button size="sm" variant="primary" title={running ? t('wallpaperRecoveryPauseFirst') : undefined} disabled={control.busy || running} onClick={() => {
      if (recovery.kind === 'canvas') control.reviewGeneratedCanvas()
      else if (recovery.kind === 'rework') control.rework()
      else if (reconstruct) control.reconstructBackground()
      else if (recovery.kind === 'download') control.retryOriginal()
      else if (recovery.kind === 'receipt') control.retryImage('rendering')
      else if (recovery.kind === 'reinspect') control.reinspect()
      else if (recovery.kind === 'edit') control.editPlan()
      else if (recovery.kind === 'review') control.reviewCurrent()
      else if (recovery.kind === 'retry') control.retryImage(recovery.step)
    }}>{t(reconstruct ? 'wallpaperBackgroundResolutionAction' : label)}</ui.Button>{running && pauseControl && <><ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('pause')}>{t('wallpaperPause')}</ui.Button><small className="vc-flow-muted vc-recovery-pause-hint">{t('wallpaperRecoveryPauseFirst')}</small></>}</React.Fragment>
  }
  function BatchActions({ control, t }: { control: Controller; t: WorkbenchText }) {
    const [open, setOpen] = React.useState(false)
    if (!control.value) return null
    const live = active(control.value.status), unfinished = ['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'technical-failed']
    const pending = control.value.itemIndex?.some(item => unfinished.includes(item.status)) ?? unfinished.some(key => (control.value!.counts[key] ?? 0) > 0)
    return <ui.Menu open={open} onClose={() => setOpen(false)} portal autoFocus listClassName="vc-menu" items={[
      { id: 'continue', label: t('wallpaperContinue'), disabled: control.busy || live || control.value.status === 'cancelled' || !pending },
      { id: 'experience', label: t('wallpaperExperience'), disabled: control.busy },
      { id: 'cancel', label: t('wallpaperCancelAllImages'), disabled: control.busy || !wallpaperCanCancel(control.value.status, control.value.total, (control.value.counts.passed ?? 0) + (control.value.counts.cancelled ?? 0)) },
    ]} onSelect={id => { setOpen(false); if (id === 'continue') control.continue(); else if (id === 'experience') control.showExperience(); else if (id === 'cancel') control.control('cancel') }} anchor={<ui.Button size="sm" variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(current => !current)}>{t('wallpaperBatchActions')}<ui.IconChevronDownOutlineRegular size={12} /></ui.Button>} />
  }
  function TaskStatus({ control, t }: { control: Controller; t: WorkbenchText }) {
    const { value, item } = control
    if (!value) return <section className="vc-direct-task-status" aria-label={t('directCropStatus')} aria-busy="true"><div className="vc-direct-status-summary"><ui.StateDot state="ongoing" /><span>{t('wallpaperLoadingImage')}</span></div></section>
    const live = active(value.status), paused = ['paused', 'interrupted'].includes(value.status)
    const passed = value.counts.passed ?? 0, attention = value.status === 'cancelled' ? 0 : value.counts.attention ?? (value.counts['needs-review'] ?? 0) + (value.counts.rejected ?? 0) + (value.counts['technical-failed'] ?? 0)
    const processing = live ? ['downloading', 'planning', 'rendering', 'reviewing'].reduce((sum, key) => sum + (value.counts[key] ?? 0), 0) : 0
    const saved = Object.values(control.downloads).filter(row => row.phase === 'saved' || row.phase === 'reused').length
    const phase = live ? 'running' : paused ? 'paused' : value.status === 'cancelled' ? 'cancelled' : value.status === 'failed' ? 'failed' : value.total > 0 && passed + (value.counts.cancelled ?? 0) === value.total ? 'completed' : attention ? 'attention' : 'blocked'
    const issue = item && ['needs-review', 'rejected', 'technical-failed'].includes(item.status)
    return <React.Fragment><section className="vc-direct-task-status" aria-label={t('directCropStatus')} data-phase={phase}>
      <div className="vc-direct-status-summary" role="status"><ui.Tag tone={phase === 'completed' ? 'success' : phase === 'attention' || phase === 'failed' ? 'warning' : 'neutral'}>{t(workflowPhaseKeys[phase])}</ui.Tag><strong>{t('directCropQuality')} {passed}/{value.total}</strong><span>{t('wallpaperBatchSaved').replace('{saved}', String(saved)).replace('{total}', String(value.total))}</span>{(value.counts.cancelled ?? 0) > 0 && <span>{t('wallpaperBatchCancelled').replace('{count}', String(value.counts.cancelled))}</span>}{processing > 0 && <span>{t('wallpaperBatchActive').replace('{count}', String(processing))}</span>}{(value.counts.queued ?? 0) > 0 && <span>{t('wallpaperBatchWaiting').replace('{count}', String(value.counts.queued))}</span>}{value.status === 'cancelled' && passed < value.total ? <span>{t('wallpaperBatchUnfinished').replace('{count}', String(value.total - passed))}</span> : attention > 0 && <span>{t('wallpaperBatchAttention').replace('{count}', String(attention))}</span>}</div>
      <div className="vc-direct-task-actions">
        {issue && <ui.Button size="sm" variant="ghost" onClick={() => control.setDetails(wallpaperFailedStep(item) ?? (!item.originalId ? 'downloading' : !item.attempts.length || item.attempts.at(-1)!.checks.length || item.attempts.at(-1)!.plan.mode === 'uncertain' ? 'planning' : !item.attempts.at(-1)!.outputId ? 'rendering' : 'reviewing'))}>{t('directCropInspect')}</ui.Button>}
        <ui.Button size="sm" variant="outline" disabled={control.busy || live || value.status === 'cancelled' || !item || value.state.version !== 2} title={live ? t('wallpaperImageActionPause') : undefined} onClick={() => control.replaceImage(t('wallpaperReplaceImage'), t('wallpaperReplaceOne'))}>{t('wallpaperReplaceImage')}</ui.Button>
        <ui.Button size="sm" variant="outline" disabled={control.busy || live || value.status === 'cancelled' || !item || item.status === 'passed' || item.status === 'cancelled'} title={live ? t('wallpaperImageActionPause') : undefined} onClick={control.cancelImage}>{t('wallpaperCancelImage')}</ui.Button>
        <ui.Button size="sm" variant="primary" disabled={control.busy || live || !item || !['download', 'receipt', 'rework', 'review', 'retry', 'reinspect'].includes(wallpaperRecovery(value, item, item.attempts.at(-1)).kind)} title={live ? t('wallpaperImageActionPause') : t('wallpaperRetrySavedHint')} onClick={control.retryCurrent}>{t('wallpaperRetryImageFlow')}</ui.Button>
        {live ? <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('pause')}>{t('wallpaperPause')}</ui.Button> : paused && <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('resume')}>{t('wallpaperResume')}</ui.Button>}
        <BatchActions control={control} t={t} />
      </div>
    </section>{control.actionNotice && <p role="alert" className="vc-notice">{control.actionNotice}</p>}{control.error && <p role="alert" className="vc-notice">{t('wallpaperFailed')}</p>}</React.Fragment>
  }
  function UpcomingStepCard({ control, t, waitingLabel }: { control: Controller; t: WorkbenchText; waitingLabel?: string | undefined }) {
    return <div className="vc-flow-node-body vc-upcoming-step nodrag nopan"><ui.IconChevronRightOutlineRegular size={28} /><strong>{waitingLabel ?? t('wallpaperNextWaiting')}</strong><p>{t('wallpaperNextInput')}</p><small className="vc-flow-muted">{control.value ? t('wallpaperSize') : t('wallpaperLoadingImage')}</small></div>
  }
  function DecisionAction({ control, t, recoveryVisible = false }: { control: Controller; t: WorkbenchText; recoveryVisible?: boolean }) {
    if (!control.value || !wallpaperCanDecide(control.item, control.attempt, control.value.status)) return null
    const detail = control.attempt?.detailAnalysis
    if (detail?.outcome === 'violated' && (detail.version === 'wallpaper-plan-detail-v1' || detail.version === 'wallpaper-plan-detail-v2') && wallpaperRecovery(control.value, control.item, control.attempt).kind === 'reinspect') {
      return recoveryVisible ? null : <ImageRecoveryAction control={control} t={t} />
    }
    const pending = wallpaperPendingDecision(control.item, control.attempt), running = active(control.value.status), limit = control.value.settings.decision?.maxRoundsPerImage, limited = !pending && (control.item?.reason === 'decision-round-limit' || limit !== undefined && (control.item?.decisions?.at(-1)?.round ?? 0) >= limit)
    return <><ui.Button size="sm" variant="primary" disabled={control.busy || running || limited} title={limited ? t('wallpaperDecisionLimit') : running ? t('wallpaperRecoveryPauseFirst') : undefined} onClick={control.decide}>{t(pending ? 'wallpaperDecisionResume' : 'wallpaperDecisionStart')}</ui.Button>{limited && <small className="vc-flow-muted">{t('wallpaperDecisionLimit')}</small>}{running && <><ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('pause')}>{t('wallpaperPause')}</ui.Button><small className="vc-flow-muted">{t('wallpaperRecoveryPauseFirst')}</small></>}</>
  }
  function DecisionCard({ control, t, detailed = false }: { control: Controller; t: WorkbenchText; detailed?: boolean }) {
    const { value, item } = control, attempt = detailed ? control.detailAttempt : control.attempt
    if (!value || !item) return null
    const latest = imageWorkflowDecisionRecord(item, attempt), records = detailed ? item.decisions?.filter(record => record.planRevision === attempt?.revision || record.targetRevision === attempt?.revision) ?? [] : latest ? [latest] : []
    const cancelled = value.status === 'cancelled', working = active(wallpaperImageWorkStatus(value, item.imageVersionId)), policy = value.settings.decision, decisionStopped = attempt === item.attempts.at(-1) && item.reason === 'decision-round-limit' && !(latest && imageWorkflowDetail(item, attempt)?.decisionId === latest.id)
    return <section className="vc-flow-node-body vc-decision-card nodrag nopan nowheel" data-detailed={detailed || undefined} data-decision-status={cancelled ? 'cancelled' : decisionStopped ? 'limited' : latest?.status ?? 'pending'} aria-busy={!decisionStopped && latest?.status === 'running' && working}>
      {decisionStopped && <section className="vc-stage-issue" role="status"><ui.Tag tone="warning">{t('wallpaperDecisionLimit')}</ui.Tag><p>{t('wallpaperDecisionLimitHint')}</p></section>}
      {!records.length && <p>{t('wallpaperDecisionPending')}</p>}
      {decisionStopped && records.length > 0 && <strong>{t('wallpaperDecisionHistory')}</strong>}
      {records.map(record => <section key={record.id} className="vc-decision-record" data-decision-id={record.id}>
        <div className="vc-flow-node-badges"><ui.StateDot state={cancelled && record.status !== 'applied' ? 'idle' : record.status === 'running' ? working ? 'ongoing' : 'idle' : record.status === 'applied' ? 'done' : 'error'} /><ui.Tag tone={!cancelled && (record.status === 'failed' || record.status === 'manual') ? 'warning' : 'neutral'}>{t(cancelled && record.status !== 'applied' ? workflowPhaseKeys.cancelled : record.status === 'running' && !working ? 'wallpaperDecisionPaused' : decisionStatuses[record.status])}</ui.Tag><small>{t('wallpaperDecisionRound')} {record.round}{policy ? ` / ${policy.maxRoundsPerImage}` : ''}</small></div>
        {record.response && <strong>{t(decisionActions[record.response.action.kind])}</strong>}<p>{record.reason}</p>{detailed && record.response && <><p>{record.response.reason}</p><div className="vc-flow-facts"><span>{t('wallpaperDecisionExtent')}</span><p>{record.response.sourceExtent.reason}</p></div>{record.response.action.kind === 'replan' && <p>{record.response.action.guidance}</p>}{record.detailRect && <small className="vc-flow-muted">{record.detailRect.x}, {record.detailRect.y} · {record.detailRect.width} × {record.detailRect.height}</small>}</>}
        {record.response && record.targetStage && !decisionStopped && !cancelled && <div className="vc-flow-facts"><span>{t('wallpaperDecisionNext')}</span><strong>{t(stepKeys[record.targetStage])}{record.targetRevision ? ` · ${t('wallpaperAttempt')} ${record.targetRevision}` : ''}</strong></div>}
        <ul className="vc-decision-findings">{record.response?.findings.slice(0, detailed ? undefined : 3).map(finding => <li key={finding.concernId}><div><ui.Tag tone={finding.blocking ? 'warning' : 'neutral'}>{t(finding.blocking ? 'wallpaperDecisionBlocking' : 'wallpaperDecisionNonblocking')}</ui.Tag><small>{t(decisionScopes[finding.scope])} · {t(decisionClassifications[finding.classification])}</small></div><p>{finding.reason}</p>{detailed && <small className="vc-flow-muted">{finding.evidenceImageVersionIds.join(' · ')}</small>}</li>)}</ul>
        {record.errorCode && <small className="vc-flow-muted">{record.errorCode}</small>}
      </section>)}
      <p className="vc-flow-muted">{t(cancelled ? 'wallpaperCancelledHint' : latest?.status === 'running' && !working ? 'wallpaperDecisionResumeHint' : 'wallpaperDecisionHint')}</p>
      {policy && !cancelled && <div className="vc-flow-facts"><span>{t('wallpaperDecisionRemaining')}</span><strong>{Math.max(0, policy.maxRoundsPerImage - (item.decisions?.at(-1)?.round ?? 0))}</strong><span>{t('wallpaperDecisionDetailLimit')} {policy.maxDetailRequests}</span></div>}
      <div className="vc-flow-node-actions"><DecisionAction control={control} t={t} />{!detailed && records.length > 0 && <ui.Button size="sm" variant="outline" onClick={() => control.setDetails('decision')}>{t('wallpaperStepDetails')}</ui.Button>}</div>
    </section>
  }
  function StepHistory({ control, t, value, onChange }: { control: Controller; t: WorkbenchText; value: ImageWorkflowStage | undefined; onChange(stage: ImageWorkflowStage | undefined): void }) {
    const options = [{ value: 'auto', label: t('wallpaperStageCurrent') }, ...imageWorkflowPresentationStages.filter(step => imageWorkflowStageReached(step.stage, control.item, control.attempt)).map(step => ({ value: step.stage, label: t(step.title) }))]
    return <SelectField label={t('wallpaperStageHistory')} value={value ?? 'auto'} options={options} onChange={next => onChange(next === 'auto' ? undefined : imageWorkflowPresentationStages.find(step => step.stage === next)!.stage)} />
  }
  function DetailInspectionCard({ control, t, detailed = false }: { control: Controller; t: WorkbenchText; detailed?: boolean }) {
    const { item, attempt, value } = control
    const inspection = imageWorkflowDetail(item, attempt)
    if (!inspection || !item || !value) return null
    const phase = imageWorkflowStagePhase('detail', item, wallpaperImageWorkStatus(value, item.imageVersionId), attempt)
    const origin = { manual: 'directCropDetailManual', decision: 'directCropDetailDecision', planning: 'directCropDetailAutomatic' } as const
    const outcomes = { resolved: 'directCropDetailResolved', 'ready-for-edit': 'directCropDetailReady', unresolved: 'directCropDetailUnresolved', violated: 'directCropDetailViolated', unavailable: 'directCropDetailUnavailable', failed: 'directCropDetailFailed', queued: 'workflowPhaseQueued', running: 'directCropDetailRunning' } as const
    const rect = inspection.rect
    const reason = inspection.errorCode === 'vision-invalid-output' || inspection.errorCode === 'vision-output-truncated' ? t('directCropDetailInvalidOutput') : inspection.reason
    return <section className="vc-flow-node-body vc-decision-card nodrag nopan nowheel" data-detailed={detailed || undefined} aria-busy={phase === 'running'}>
      <div className="vc-flow-node-badges"><ui.Tag>{t(origin[inspection.origin])}</ui.Tag><small>{t('wallpaperAttempt')} {inspection.planRevision}</small></div>
      <strong>{t(phase === 'paused' || phase === 'cancelled' ? workflowPhaseKeys[phase] : outcomes[inspection.status])}</strong>
      {reason && <p>{reason}</p>}
      {!!attempt?.detailAnalysis?.retainedUncertainties?.length && <div className="vc-flow-facts"><span>{t('directCropRetainedUnknowns')}</span><ul>{attempt.detailAnalysis.retainedUncertainties.map(entry => <li key={entry.text}>{entry.text}</li>)}</ul></div>}
      {detailed && rect && <div className="vc-flow-facts"><span>{t('directCropDetailRegion')}</span><strong>{[rect.x, rect.y, rect.width, rect.height].map(value => (value * 100).toFixed(1) + '%').join(' · ')}</strong></div>}
      {inspection.errorCode && <small className="vc-flow-muted">{inspection.errorCode}</small>}
      {!detailed && <div className="vc-flow-node-actions"><ui.Button size="sm" variant="outline" onClick={() => control.setDetails('detail')}>{t('wallpaperStepDetails')}</ui.Button>{['failed', 'attention'].includes(phase) && wallpaperRecovery(value, item, attempt).kind === 'reinspect' && <ImageRecoveryAction control={control} t={t} pauseControl />}</div>}
    </section>
  }
  function ImageStepCard({ kind, stage, control, t }: { kind: WallpaperStep; stage: ImageWorkflowStage; control: Controller; t: WorkbenchText }) {
    const { value, item, attempt } = control
    if (!value || !item) return <div className="vc-flow-node-body vc-image-step-card vc-image-step-loading" role="status" aria-busy="true"><ui.StateDot state="ongoing" /><span>{t('wallpaperLoadingImage')}</span></div>
    if (stage === 'detail') return <DetailInspectionCard control={control} t={t} />
    const qualified = item.status === 'passed' && attempt === item.attempts.at(-1) && !!attempt?.outputId && !!attempt.review && wallpaperVerdict(attempt.review) === 'pass'
    const id = stage === 'final' && !qualified ? undefined : imageWorkflowArtifact(stage, item, attempt)
    const originalPreview = item.originalId ? resource(value.sourceImages[item.originalId]?.previewPath) : undefined
    const sourcePreview = kind === 'downloading' && !item.originalId ? resource(value.itemIndex?.find(row => row.imageVersionId === item.imageVersionId)?.previewPath) : undefined
    const preview = resource(id ? value.previewResources[id] : undefined) ?? ((stage === 'original' || stage === 'planning') && originalPreview && new URL(originalPreview).searchParams.get('imageVersionId') !== item.originalId ? originalPreview : undefined) ?? sourcePreview
    const progress = value.downloads?.[item.imageVersionId] ?? wallpaperDownloadProgress(item, value.status)
    const full = resource(id ? value.resources[id] : undefined)
    const phase = imageWorkflowStagePhase(stage, item, wallpaperImageWorkStatus(value, item.imageVersionId), attempt), checks = attempt?.review ? Object.entries(attempt.review.checks) : []
    const clarity = imageWorkflowClarity(attempt)
    const passed = checks.filter(([, check]) => check.result === 'satisfied').length
    const reviewPassed = checks.length > 0 && passed === checks.length
    const reviewing = kind === 'reviewing' && stage !== 'final'
    const moving = active(value.status)
    const live = value.enhancements?.[item.imageVersionId]
    const resolutionProgress = live && live.revision === attempt?.revision ? live.progress : undefined
    const enhancing = (stage === 'rendering' || stage === 'clarity') && attempt === item.attempts.at(-1) && ['running', 'pausing', 'paused', 'interrupted'].includes(wallpaperImageWorkStatus(value, item.imageVersionId)) && (attempt?.backgroundResolution?.status === 'enhancing' || attempt?.clarity?.status === 'enhancing')
    const reviewAnalysis = attempt?.outputId && attempt.simulationId ? attempt.analysisId : undefined
    const analysisFull = resource(reviewAnalysis ? value.resources[reviewAnalysis] : undefined)
    const analysisPreview = resource(reviewAnalysis ? value.previewResources[reviewAnalysis] : undefined)
    const ownIssue = ['failed', 'attention'].includes(phase) && !['geometry', 'final', 'clarity'].includes(stage)
    const previousReview = stage === 'rendering' ? imageWorkflowPreviousReview(item, attempt) : undefined
    const previewLabel = t(stage === 'final' ? 'wallpaperClean' : kind === 'downloading' ? 'wallpaperSource' : kind === 'planning' ? 'wallpaperAnalysis' : kind === 'rendering' ? 'wallpaperClean' : 'wallpaperSimulation')
    return <div className="vc-flow-node-body vc-image-step-card nodrag nopan nowheel" data-step={stage}>
      {reviewing ? <div className="vc-image-review-previews" data-passed={reviewPassed || undefined}>
        <figure><ImageStepPreview preview={analysisPreview} full={analysisFull} label={t('wallpaperReviewAnalysis')} waiting={phase === 'running' && !analysisPreview} moving={moving} control={control} t={t} /><figcaption>{t('wallpaperReviewAnalysis')}</figcaption></figure>
        {reviewPassed && <figure><ImageStepPreview preview={preview} full={full} label={t('wallpaperSimulation')} waiting={false} moving={moving} control={control} t={t} /><figcaption>{t('wallpaperSimulation')}</figcaption></figure>}
      </div> : <ImageStepPreview preview={preview} full={full} label={previewLabel} waiting={kind === 'rendering' && !attempt?.outputId && item.status === 'rendering' && ['running', 'pausing', 'paused', 'interrupted'].includes(value.status)} generating={kind === 'rendering' && !!attempt?.needsOutpaint && !!attempt.generation && !id && item.status === 'rendering'} enhancing={enhancing} progress={resolutionProgress} moving={moving} control={control} t={t} />}
      {sourcePreview && <small className="vc-flow-muted">{t('wallpaperOriginalPreview')}</small>}
      {stage === 'planning' && attempt?.detailAnalysis && <small className="vc-flow-muted">{t(attempt.detailAnalysis.outcome === 'ready-for-edit' ? 'directCropDetailReady' : attempt.detailAnalysis.outcome === 'resolved' ? 'directCropDetailResolved' : attempt.detailAnalysis.outcome === 'violated' ? 'directCropDetailViolated' : 'directCropDetailUnresolved')}</small>}
      {ownIssue && <section className="vc-stage-issue" role="alert"><strong>{t('workflowStageFailure')}</strong><p>{stage === 'reviewing' && attempt?.review ? attempt.review.issues.map(issue => issue.reason).join('；') || issueMessage(item, t) : issueMessage(item, t)}</p></section>}
      {stage === 'rendering' && ownIssue && item.edits >= value.settings.maxEditsPerImage && <p className="vc-flow-muted">{t('wallpaperEditLimit')}</p>}
      {previousReview?.review && <section className="vc-stage-issue"><strong>{t('directCropPreviousReview')} · {t('wallpaperAttempt')} {previousReview.revision}</strong><p>{previousReview.review.issues.map(issue => issue.reason).join('；')}</p></section>}
      <div key={item.imageVersionId} className="vc-image-step-meta">
        {stage === 'clarity' ? <><strong>{t(!clarity ? 'wallpaperClarityHistorical' : clarity!.status === 'not-needed' ? 'wallpaperClarityNotNeeded' : clarity!.status === 'enhancing' ? 'wallpaperClarityEnhancing' : clarity!.status === 'reviewing' ? 'wallpaperClarityReviewing' : clarity!.status === 'passed' ? attempt?.preResolutionReview ? 'wallpaperClarityPostReviewPassed' : 'wallpaperClarityPassed' : clarity!.status === 'pending' ? 'wallpaperClarityPending' : 'wallpaperClarityAttention')}</strong><small>{attempt?.preResolutionReview && clarity?.status === 'passed' ? t('wallpaperClarityPostReviewHint') : clarity?.reason || t('wallpaperClarityHint')}</small></> : stage === 'geometry' ? <><div className="vc-flow-facts"><span>{t('wallpaperGeometryTarget')}</span><strong>{value.settings.width} × {value.settings.height}</strong></div>{attempt && <><div className="vc-flow-facts"><span>{t('wallpaperGeometryScale')}</span><strong>{attempt.plan.placement.scale}</strong></div><div className="vc-flow-facts"><span>{t('wallpaperGeometryOffset')}</span><strong>{attempt.plan.placement.left}, {attempt.plan.placement.top}</strong></div><small>{t(attempt.compositionMode === 'generated-canvas-v1' ? 'wallpaperGeneratedCanvasLabel' : attempt.needsOutpaint ? 'wallpaperOutpaint' : 'wallpaperCropOnly')}</small></>}</> : stage === 'final' ? <><strong>{t(qualified ? 'wallpaperPassed' : 'wallpaperAttention')}</strong><small>{qualified ? t('wallpaperSize') : t('wallpaperFinalBlocked')}</small></> : kind === 'downloading' ? <><DownloadProgress progress={progress} t={t} />{item.originalId && value.sourceImages[item.originalId] && <div className="vc-flow-facts"><span>{t('wallpaperOriginalDimensions')}</span><strong>{value.sourceImages[item.originalId]!.width} × {value.sourceImages[item.originalId]!.height}</strong></div>}</> : kind === 'planning' ? <><p className="vc-planning-image-subject">{attempt?.plan.subject ?? t('wallpaperIdle')}</p>{attempt && <small>{t('wallpaperRound')} {attempt.revision} · {t('wallpaperPlanningRegions').replace('{count}', String(attempt.plan.regions.length))}</small>}</> : kind === 'rendering' ? <><strong>{attempt ? t(attempt.layoutCorrection ? 'wallpaperCandidatePlacement' : attempt.compositionMode === 'generated-canvas-v1' ? 'wallpaperGeneratedCanvasLabel' : attempt.needsOutpaint ? 'wallpaperOutpaint' : 'wallpaperCropOnly') : t('wallpaperIdle')}</strong><small>{t('wallpaperEditCount')} {item.edits} / {value.settings.maxEditsPerImage}</small></> : <><strong>{checks.length ? t('wallpaperReviewSummary').replace('{passed}', String(passed)).replace('{total}', String(checks.length)) : t('wallpaperReviewPending')}</strong><div className="vc-image-check-summary">{checks.filter(([, check]) => check.result !== 'satisfied').map(([key, check]) => <ui.Tag key={key} tone={check.result === 'violated' ? 'warning' : 'neutral'}>{t(key === 'style' && value.state.version === 2 ? 'directCropFaithful' : checkKeys[key as keyof typeof checkKeys])} · {t(check.result === 'violated' ? 'wallpaperViolated' : 'wallpaperUnknownCheck')}</ui.Tag>)}</div></>}
        {kind !== 'downloading' && ['failed', 'attention', 'blocked'].includes(phase) && <small className="vc-flow-muted">{t(phase === 'blocked' ? 'workflowStepBlocked' : 'wallpaperAttention')}</small>}
      </div>
      {stage === 'rendering' && <GenerationBriefDetails control={control} t={t} />}
      {stage === 'rendering' && <BackgroundResolutionDetails control={control} t={t} />}
       <div className="vc-flow-node-actions"><ui.Button size="sm" variant="outline" onClick={() => control.setDetails(stage === 'clarity' ? 'clarity' : kind)}>{t('wallpaperStepDetails')}</ui.Button>{stage === 'rendering' && <ui.Button size="sm" variant="outline" onClick={() => control.setHistoryOpen(true)}>{t('wallpaperHistoryTitle')}</ui.Button>}{ownIssue ? <><ImageRecoveryAction control={control} t={t} pauseControl />{kind === 'planning' && wallpaperRecovery(value, item, attempt).kind !== 'edit' && <ui.Button size="sm" variant="outline" disabled={control.busy || active(value.status) || attempt !== item.attempts.at(-1)} onClick={control.editPlan}>{t('wallpaperEditPlan')}</ui.Button>}</> : kind === 'planning' && stage !== 'geometry' && attempt && <ui.Button size="sm" variant="outline" disabled={control.busy || active(value.status) || attempt !== item.attempts.at(-1)} onClick={control.editPlan}>{t('wallpaperEditPlan')}</ui.Button>}{stage === 'final' && qualified && full && <a className="vc-wallpaper-download" href={full} download="wallpaper-1845x3280.png">{t('wallpaperDownload')}</a>}</div>
    </div>
  }

  function ClarityDetails({ control, t }: { control: Controller; t: WorkbenchText }) {
    const clarity = imageWorkflowClarity(control.attempt), value = control.value
    if (!clarity || !value) return <p>{t('wallpaperClarityHistorical')}</p>
    return <section className="vc-clarity-details"><p>{control.attempt?.preResolutionReview && clarity.status === 'passed' ? t('wallpaperClarityPostReviewPassed') : clarity.reason === 'clarity-no-visible-change' ? t('wallpaperClarityNoChange') : clarity.reason || t('wallpaperClarityPending')}</p><small className="vc-flow-muted">{t(control.attempt?.preResolutionReview ? 'wallpaperClarityPostReviewHint' : 'wallpaperClarityHint')}</small>
      <div className="vc-image-review-previews"><Artifact path={clarity.originalOutputId ? value.resources[clarity.originalOutputId] : undefined} label={t('wallpaperClarityBaseline')} control={control} /><Artifact path={clarity.enhancedOutputId ? value.resources[clarity.enhancedOutputId] : undefined} label={t('wallpaperClarityEnhanced')} control={control} /></div>
      {clarity.durationMs !== undefined && <div className="vc-flow-facts"><span>{t('wallpaperClarityTime')}</span><strong>{(clarity.durationMs / 1000).toFixed(2)} s</strong></div>}{clarity.pixels !== undefined && <div className="vc-flow-facts"><span>{t('wallpaperClarityPixels')}</span><strong>{clarity.pixels.toLocaleString()}</strong></div>}
    </section>
  }
  function Artifact({ path, label, control }: { path: string | undefined; label: string; control: Controller }) {
    const src = resource(path)
    const id = path && Object.keys(control.value?.resources ?? {}).find(key => control.value?.resources[key] === path)
    const preview = id ? resource(control.value?.previewResources[id]) : undefined
    return src ? <button className="vc-wallpaper-artifact" onClick={() => control.setPreview(src)}><img src={preview ?? src} alt={label} loading="lazy" decoding="async" draggable={false} /><span>{label}</span></button> : null
  }
  function DownloadDetails({ control, t, single = false }: { control: Controller; t: WorkbenchText; single?: boolean }) {
    const { value, item } = control
    if (!value) return null
    const saved = item?.originalId ? resource(value.resources[item.originalId]) : undefined
    return <section className="vc-download-details">
      <p className="vc-flow-muted">{t('workflowDownloadHint')}</p>
      {!single && <ol className="vc-download-queue" aria-label={t('wallpaperDownloading')}>
        {value.state.items.map((row, index) => {
          const failed = wallpaperFailedStep(row) === 'downloading', running = row.status === 'downloading' && active(value.status)
          const label = failed ? row.errorCode === 'original-source-restricted' ? 'workflowDownloadRestricted' : 'workflowDownloadFailed' : row.originalId ? 'workflowDownloadSaved' : running ? row.download?.retrying ? 'workflowDownloadRetrying' : 'workflowDownloadActive' : 'workflowDownloadQueued'
          return <li key={row.imageVersionId}><ui.Button size="sm" variant="ghost" className="vc-download-row" data-current={row === item || undefined} aria-current={row === item ? 'true' : undefined} onClick={() => control.page(value.offset + index)}>
            <span><ui.StateDot state={failed ? 'error' : row.originalId ? 'done' : running ? 'ongoing' : 'idle'} />{t('wallpaperImage')} {value.offset + index + 1}</span><ui.Tag tone={failed ? 'danger' : row.originalId ? 'success' : running ? 'info' : 'neutral'}>{t(label)}</ui.Tag>
          </ui.Button></li>
        })}
      </ol>}
      {item?.download && <div className="vc-flow-facts"><span>{t('workflowDownloadAttempts')} <b>{item.download.attempts}</b></span>{item.download.byteLength !== undefined && <span>{t('workflowDownloadBytes')} <b>{(item.download.byteLength / 1048576).toFixed(2)} MiB</b></span>}</div>}
      {saved && <div className="vc-flow-node-actions"><ui.Button size="sm" variant="outline" onClick={() => control.setPreview(saved)}>{t('workflowDownloadPreview')}</ui.Button><a className="vc-wallpaper-download" href={saved} download={`source-${control.offset + 1}.png`}>{t('workflowDownloadFile')}</a></div>}
    </section>
  }
  function PlanningImageCard({ imageId, index, control, t, onSelect }: { imageId: string; index: number; control: Controller; t: WorkbenchText; onSelect?(): void }) {
    const value = control.value, item = value?.state.items.find(row => row.imageVersionId === imageId), attempt = item?.attempts.at(-1)
    if (!value || !item) return null
    const annotated = undefined
    const source = item.originalId ? resource(value.sourceImages[item.originalId]?.previewPath) : undefined
    // A missing derivative never auto-decodes an old full-resolution original in every card.
    const preview = annotated ?? (source && new URL(source).searchParams.get('imageVersionId') !== item.originalId ? source : undefined)
    const full = resource(item.originalId ? value.resources[item.originalId] : undefined)
    const phase = planningImagePhase(item, wallpaperImageWorkStatus(value, item.imageVersionId))
    return <div className="vc-flow-node-body vc-planning-image-card nodrag nopan nowheel">
      {preview && full && <button className="vc-planning-image-preview" aria-label={t('workflowDownloadPreview')} onClick={() => control.setPreview(full)}><img src={preview} alt={attempt?.plan.subject ?? `${t('wallpaperImage')} ${index + 1}`} loading="lazy" decoding="async" draggable={false} /></button>}
      {attempt ? <><p className="vc-planning-image-subject">{attempt.plan.subject}</p><div className="vc-flow-node-badges"><ui.Tag tone={phase === 'attention' || phase === 'failed' ? 'warning' : 'neutral'}>{t(modeKeys[attempt.plan.mode])}</ui.Tag><span>{t('wallpaperRound')} {attempt.revision}</span></div><small className="vc-flow-muted">{t('wallpaperPlanningRegions').replace('{count}', String(attempt.plan.regions.length))}</small></> : <p className="vc-flow-muted">{t('wallpaperIdle')}</p>}
      {(attempt?.checks.length || wallpaperFailedStep(item) === 'planning') ? <p className="vc-notice">{t('wallpaperGeometryFailed')}</p> : null}
      <div className="vc-planning-image-actions"><ui.Button size="sm" variant={control.offset === index ? 'outline' : 'ghost'} disabled={control.busy} aria-pressed={control.offset === index} onClick={() => { control.page(index); onSelect?.() }}>{t('wallpaperPlanningSelect')}</ui.Button>{attempt && <ui.Button size="sm" variant="outline" disabled={control.busy || active(value.status)} onClick={() => control.editImagePlan(imageId)}>{t('wallpaperEditPlan')}</ui.Button>}</div>
    </div>
  }

  function PlanningGroup({ control, t }: { control: Controller; t: WorkbenchText }) {
    const value = control.value
    if (!value) return null
    const groups = Array.from({ length: Math.ceil(value.total / control.windowSize) }, (_, group) => {
      const start = group * control.windowSize, end = Math.min(value.total, start + control.windowSize)
      const attention = value.itemIndex?.slice(start, end).filter(item => ['rejected', 'needs-review', 'technical-failed'].includes(item.status)).length ?? 0
      const range = t('wallpaperPlanningRange').replace('{from}', String(start + 1)).replace('{to}', String(end)).replace('{total}', String(value.total))
      return { value: String(start), label: attention ? `${range} · ${t('wallpaperPlanningIssues').replace('{count}', String(attention))}` : range }
    })
    return <div className="vc-flow-node-body vc-planning-group nodrag nopan nowheel"><div className="vc-stage-metrics"><div><span>{t('wallpaperTotal')}</span><strong>{value.total}</strong></div><div><span>{t('wallpaperPlannedCount')}</span><strong>{value.counts.planned ?? 0}</strong></div><div><span>{t('wallpaperStepFailures')}</span><strong>{value.counts.planningFailed ?? 0}</strong></div></div><SelectField label={t('wallpaperPlanningGroup')} value={String(control.windowStart)} options={groups} disabled={control.busy} onChange={value => control.page(Number(value))} /><p className="vc-flow-muted">{t('wallpaperPlanningPageHint').replace('{count}', String(control.windowSize))}</p></div>
  }

  function WallpaperNode({ kind, control, t, grouped = false, single = false }: { kind: WallpaperStep; control: Controller; t: WorkbenchText; grouped?: boolean; single?: boolean }) {
    const { value, item, attempt } = control
    const [diagnostics, setDiagnostics] = React.useState(false)
    React.useEffect(() => setDiagnostics(false), [item?.imageVersionId, item?.errorCode])
    if (!value) return null
    if (kind === 'planning' && grouped) return <PlanningGroup control={control} t={t} />
    const path = (id: string | undefined) => id ? value.resources[id] : undefined
    const stage = wallpaperStage(kind, value.status, value.total, value.counts)
    const planned = !!attempt && !attempt.checks.length && attempt.plan.mode !== 'uncertain'
    const blocked = kind === 'planning' ? !item?.originalId || wallpaperFailedStep(item) === 'downloading' : kind === 'rendering' ? !planned : kind === 'reviewing' ? !attempt?.outputId : false
    const ownIssue = !!item && (wallpaperFailedStep(item) === kind || kind === 'planning' && !!attempt?.checks.length || item.status === 'needs-review' && kind !== 'downloading' && (kind === 'planning' ? !planned : kind === 'rendering' ? planned && !attempt?.outputId : !!attempt?.outputId))
    const pending = (value.counts.queued ?? 0) + (value.counts.downloading ?? 0) + (value.counts.planning ?? 0) + (value.counts.rendering ?? 0) + (value.counts.reviewing ?? 0) + (value.counts['technical-failed'] ?? 0)
    return <div className="vc-flow-node-body vc-wallpaper-node nodrag nopan nowheel">
      {!single && <div className="vc-stage-metrics"><div><span>{t('wallpaperTotal')}</span><strong>{value.total}</strong></div><div><span>{t(kind === 'downloading' ? 'wallpaperDownloadedCount' : kind === 'planning' ? 'wallpaperPlannedCount' : kind === 'rendering' ? 'wallpaperRenderedCount' : 'wallpaperReviewedCount')}</span><strong>{stage.done}</strong></div><div data-failed={stage.failed > 0 || undefined}><span>{t('wallpaperStepFailures')}</span><strong>{stage.failed}</strong></div>{stage.blocked > 0 && <div><span>{t('workflowStageBlockedCount')}</span><strong>{stage.blocked}</strong></div>}{kind === 'reviewing' && <div><span>{t('wallpaperFinalCount')}</span><strong>{value.counts.passed ?? 0}</strong></div>}</div>}
      {value.state.budgetStopped && <p className="vc-notice">{t('wallpaperBudget')}</p>}
      {value.warnings.includes('image-cancel-unconfirmed') && <p role="alert" className="vc-notice">{t('wallpaperCancelUnconfirmed')}</p>}
      {!single && <div className="vc-flow-image-pager"><ui.Button size="sm" variant="ghost" disabled={!control.offset || control.busy} onClick={() => control.page(control.offset - 1)}>{t('wallpaperPrevious')}</ui.Button><small>{t('wallpaperImage')} {control.offset + 1} / {value.total}</small><ui.Button size="sm" variant="ghost" disabled={control.offset + 1 >= value.total || control.busy} onClick={() => control.page(control.offset + 1)}>{t('wallpaperNext')}</ui.Button></div>}
      {!single && kind !== 'downloading' && item && item.attempts.length > 1 && <SelectField label={t('wallpaperAttempt')} value={String(attempt?.revision)} options={item.attempts.map(row => ({ value: String(row.revision), label: `${t('wallpaperAttempt')} ${row.revision}` }))} onChange={revision => control.setRevision({ image: item.imageVersionId, revision: Number(revision) })} />}
      {ownIssue ? <section className="vc-stage-issue" role="alert"><div><ui.StateDot state={item?.errorCode ? 'error' : 'warning'} /><strong>{t('workflowStageFailure')}</strong></div><p>{issueMessage(item, t)}</p>{item?.errorCode && <code>{item.errorCode}</code>}{item?.errorCode && item.reason && <ui.DisclosureRow icon={<ui.IconInfoOutlineRegular size={14} />} title={t('workflowStageDiagnostics')} open={diagnostics} expandable expandOnRowClick onToggle={() => setDiagnostics(current => !current)}><p className="vc-flow-muted">{item.reason}</p></ui.DisclosureRow>}</section> : blocked ? <div className="vc-stage-waiting"><ui.IconInfoOutlineRegular size={16} /><p>{t(stage.blocked > 0 ? 'workflowStepBlocked' : 'workflowStepWaiting')}</p></div> : null}
      {kind === 'downloading' ? <DownloadDetails control={control} t={t} single={single} /> : kind === 'planning' ? <>{attempt ? <><div className="vc-flow-node-badges"><ui.Tag tone="info">{t(modeKeys[attempt.plan.mode])}</ui.Tag></div><strong>{attempt.plan.subject}</strong><p>{attempt.plan.evidence}</p><small className="vc-flow-muted">{t('wallpaperInferred')}</small><Artifact path={path(item ? imageWorkflowArtifact('geometry', item, attempt) : undefined)} label={t('wallpaperAnalysis')} control={control} /><ui.Button size="sm" variant="outline" disabled={control.busy || active(value.status) || attempt !== item?.attempts.at(-1)} onClick={control.editPlan}>{t('wallpaperEditPlan')}</ui.Button></> : !ownIssue && <p className="vc-flow-muted">{t('wallpaperIdle')}</p>}</> : kind === 'rendering' ? <>{planned && attempt && <><div className="vc-flow-node-badges"><ui.Tag tone={attempt.needsOutpaint ? 'info' : 'neutral'}>{t(attempt.compositionMode === 'generated-canvas-v1' ? 'wallpaperGeneratedCanvasLabel' : attempt.needsOutpaint ? 'wallpaperOutpaint' : 'wallpaperCropOnly')}</ui.Tag><span className="vc-flow-muted">{t('wallpaperRound')} {attempt.revision}</span></div><div className="vc-flow-facts"><span>{t('wallpaperEditCount')} {item?.edits ?? 0} / {value.settings.maxEditsPerImage}</span></div></>}<Artifact path={path(attempt?.outputId)} label={t('wallpaperClean')} control={control} />{item?.status === 'passed' && attempt === item.attempts.at(-1) && attempt?.review && wallpaperVerdict(attempt.review) === 'pass' && attempt.outputId && resource(path(attempt.outputId)) && <a className="vc-wallpaper-download" href={resource(path(attempt.outputId))} download="wallpaper-1845x3280.png">{t('wallpaperDownload')}</a>}</> : <><Artifact path={path(attempt?.simulationId)} label={t('wallpaperSimulation')} control={control} />{attempt?.review && <div className="vc-wallpaper-checks">{Object.entries(attempt.review.checks).map(([key, check]) => <div key={key}><ui.Tag tone={check.result === 'satisfied' ? 'success' : check.result === 'violated' ? 'warning' : 'neutral'}>{t(key === 'style' && value.state.version === 2 ? 'directCropFaithful' : checkKeys[key as keyof typeof checkKeys])} · {t(check.result === 'satisfied' ? 'wallpaperSatisfied' : check.result === 'violated' ? 'wallpaperViolated' : 'wallpaperUnknownCheck')}</ui.Tag><small>{check.reason}</small></div>)}</div>}</>}
      {value.errorCode && kind === 'downloading' && !ownIssue && <p role="alert" className="vc-notice">{t('wallpaperTechnicalFailure')} <code>{value.errorCode}</code></p>}
      {!single && (kind === 'downloading' || kind === 'reviewing' || ownIssue) && <div className="vc-flow-node-actions" aria-label={t('workflowStageControl')}>{active(value.status) ? <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('pause')}>{t('wallpaperPause')}</ui.Button> : ['paused', 'interrupted'].includes(value.status) ? <ui.Button size="sm" variant="primary" disabled={control.busy} onClick={() => control.control('resume')}>{t('wallpaperResume')}</ui.Button> : value.status !== 'cancelled' && pending > 0 && <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={control.continue}>{t('wallpaperContinue')}</ui.Button>}{!['completed', 'cancelled', 'failed'].includes(value.status) && <ui.Button size="sm" variant="ghost" disabled={control.busy} onClick={() => control.control('cancel')}>{t('wallpaperCancel')}</ui.Button>}<ui.Button size="sm" variant="ghost" disabled={control.busy} onClick={control.showExperience}>{t('wallpaperExperience')}</ui.Button></div>}
    </div>
  }

  function generatedCanvasReviewAvailable(control: Controller) {
    const { value, item, attempt } = control
    return value?.state.version === 2 && !!item && attempt === item.attempts.at(-1) && !!attempt?.generation && !!attempt.generatedImageId && (!attempt.outputId && ['misaligned-source', 'reframed-source'].includes(attempt.generationAlignment?.result ?? '') || isGeneratedCanvasMode(attempt.compositionMode))
  }

  function DetailsFooter({ control, t }: { control: Controller; t: WorkbenchText }) {
    const { value, item, attempt } = control
    if (!value) return null
    if (value.status === 'cancelled') return <div className="vc-image-details-footer"><ui.Button size="sm" variant="ghost" onClick={() => control.setDetails(null)}>{t('close')}</ui.Button></div>
    const running = active(value.status), paused = ['paused', 'interrupted'].includes(value.status)
    return <div className="vc-image-details-footer">
      <ui.Button size="sm" variant="ghost" disabled={control.busy} onClick={() => control.setDetails(null)}>{t('close')}</ui.Button>
      <div className="vc-image-details-primary">

        {running && <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('pause')}>{t('wallpaperPause')}</ui.Button>}
        {paused && <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('resume')}>{t('wallpaperResume')}</ui.Button>}
        {control.details === 'planning' && !running && attempt && wallpaperRecovery(value, item, attempt).kind !== 'edit' && <ui.Button size="sm" variant="outline" disabled={control.busy || running || attempt !== item?.attempts.at(-1)} onClick={control.editPlan}>{t('wallpaperEditPlan')}</ui.Button>}
        {control.details === 'reviewing' && !running && attempt?.outputId && wallpaperRecovery(value, item, attempt).kind !== 'review' && <ui.Button size="sm" variant="outline" disabled={control.busy || running || attempt !== item?.attempts.at(-1)} onClick={control.reviewCurrent}>{t('wallpaperReviewCurrent')}</ui.Button>}
        {control.details === 'rendering' && <GenerationBriefDetails control={control} t={t} detailed />}
        {control.details === 'rendering' && !running && generatedCanvasReviewAvailable(control) && <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={control.reviewGeneratedCanvas}>{t(control.attempt?.outputId ? 'wallpaperReconstructCurrentAction' : 'wallpaperGeneratedCanvasAction')}</ui.Button>}
        <ImageRecoveryAction control={control} t={t} />{control.details !== 'decision' && control.details !== 'detail' && <DecisionAction control={control} t={t} recoveryVisible />}
      </div>
    </div>
  }
  function FailureDetails({ control, t }: { control: Controller; t: WorkbenchText }) {
    const { value, item, attempt } = control
    const [expanded, setExpanded] = React.useState(false)
    if (!value || !item || !control.details) return null
    const input = attempt?.canvasId ?? item.originalId, preview = resource(input ? value.previewResources[input] ?? value.resources[input] : value.sourceImages[item.imageVersionId]?.previewPath ?? value.itemIndex?.find(row => row.imageVersionId === item.imageVersionId)?.previewPath)
    const history = attempt?.revision !== item.attempts.at(-1)?.revision
    return <div className="vc-image-failure-details">
      <div className="vc-image-failure-layout">
        {preview && <div className="vc-image-failure-preview"><Artifact path={preview} label={t('wallpaperFailureInput')} control={control} /></div>}
        <div className="vc-image-failure-summary"><div className="vc-image-detail-reason" role="status"><strong>{t('workflowStageFailure')}</strong><p>{issueMessage(item, t)}</p></div>
          <dl><div><dt>{t('wallpaperFailureStep')}</dt><dd>{t(control.details === 'clarity' ? 'wallpaperClarity' : stepKeys[control.details])}</dd></div>{attempt && <div><dt>{t('wallpaperFailureVersion')}</dt><dd>{attempt.revision} / {item.attempts.at(-1)?.revision}</dd></div>}<div><dt>{t('wallpaperEditCount')}</dt><dd>{item.edits} / {value.settings.maxEditsPerImage}</dd></div></dl>
          {control.details === 'downloading' && <DownloadProgress progress={wallpaperDownloadProgress(item, value.status, control.downloads[item.imageVersionId])} t={t} />}
          {history ? <p className="vc-flow-muted">{t('wallpaperRecoveryHistory')}</p> : attempt?.generation && <p className="vc-flow-muted">{t('wallpaperRecoveryReceiptHint')}</p>}
        </div>
      </div>
      <ui.DisclosureRow icon={<ui.IconInfoOutlineRegular size={14} />} title={t('workflowStageDiagnostics')} open={expanded} expandable expandOnRowClick onToggle={() => setExpanded(current => !current)}><div className="vc-image-failure-diagnostics">{item.errorCode && <code>{item.errorCode}</code>}{item.reason && <p>{item.reason}</p>}{attempt?.generation && <code>{attempt.generation.taskId}</code>}</div></ui.DisclosureRow>
    </div>
  }
  function PlanningDetails({ control, t }: { control: Controller; t: WorkbenchText }) {
    const { value, item, attempt } = control
    if (!value || !attempt) return <WallpaperNode kind="planning" control={control} t={t} single />
    const attention = !!item && attempt === item.attempts.at(-1) && ['needs-review', 'rejected', 'technical-failed'].includes(item.status)
    const original = item?.originalId, preview = resource(original ? value.sourceImages[original]?.previewPath : undefined), full = resource(original ? value.resources[original] : undefined)
    return <div className="vc-image-planning-details">
      {attention && <section className="vc-image-detail-reason" role="status"><strong>{t('workflowStageFailure')}</strong><p>{issueMessage(item, t)}</p></section>}
      <div className="vc-image-planning-grid" data-has-preview={!!preview}>
        {preview && <figure className="vc-image-planning-preview"><ImageStepPreview preview={preview} full={full} label={t('wallpaperSource')} waiting={false} moving={false} control={control} t={t} /></figure>}
        <div className="vc-image-planning-summary"><section><h3>{t('wallpaperDetailSubject')}</h3><p>{attempt.plan.subject}</p></section><section><h3>{t('wallpaperDetailEvidence')}</h3><p>{attempt.plan.evidence}</p></section>{attempt.plan.editPrompt && <section><h3>{t('wallpaperSceneEditPrompt')}</h3><p>{attempt.plan.editPrompt}</p></section>}<small className="vc-flow-muted">{t('wallpaperInferred')}</small></div>
      </div>
    </div>
  }
  function DetailContext({ control, t }: { control: Controller; t: WorkbenchText }) {
    const { item, attempt, value } = control
    if (!value || !item) return null
    const running = active(value.status), phase = control.details === 'clarity' || control.details === 'detail' || control.details === 'decision' ? imageWorkflowStagePhase(control.details, item, wallpaperImageWorkStatus(value, item.imageVersionId), attempt) : imageWorkflowPhase(control.details ?? 'planning', item, wallpaperImageWorkStatus(value, item.imageVersionId), attempt)
    return <div className="vc-image-detail-context"><ui.Tag tone={phase === 'failed' || phase === 'attention' ? 'warning' : phase === 'completed' ? 'success' : 'neutral'}>{t(workflowPhaseKeys[phase])}</ui.Tag>{(control.details === 'planning' || control.details === 'downloading') && <ui.Tag tone="neutral">{t('wallpaperSource')}</ui.Tag>}
      {item.attempts.length > 1 ? <SelectField label={t('wallpaperAttempt')} value={String(attempt?.revision)} options={item.attempts.map(row => ({ value: String(row.revision), label: t('wallpaperAttempt') + ' ' + row.revision }))} onChange={revision => control.setRevision({ image: item.imageVersionId, revision: Number(revision) })} /> : attempt && <span>{t('wallpaperAttempt')} {attempt.revision}</span>}
      {attempt && <><ui.Tag tone="neutral">{t(modeKeys[attempt.plan.mode])}</ui.Tag><span>{t('wallpaperEditorRegions')} {attempt.plan.regions.length}</span></>}{running && <ui.StateDot state="ongoing" />}
    </div>
  }
  function BackgroundResolutionDetails({ control, t }: { control: Controller; t: WorkbenchText }) {
    const saved = control.attempt?.backgroundResolution
    const resolution = saved && control.attempt?.review && !control.attempt.preResolutionReview ? { ...saved, ...wallpaperBackgroundReview(control.attempt.review) } : saved
    if (!resolution) return null
    return <section role="status" aria-busy={resolution.status === 'enhancing' || resolution.status === 'reviewing'}>
      <strong>{control.attempt?.preResolutionReview ? t(resolution.status === 'enhancing' ? 'wallpaperPostReviewEnhancing' : resolution.status === 'passed' ? 'wallpaperPostReviewCompleted' : 'wallpaperPostReviewChecking') : t(resolution.status === 'enhancing' ? 'wallpaperBackgroundEnhancing' : resolution.status === 'reviewing' ? 'wallpaperBackgroundReviewing' : resolution.status === 'passed' ? 'wallpaperBackgroundPassed' : 'wallpaperBackgroundAttention')}</strong>
      <div className="vc-flow-facts"><span>{t('wallpaperBackgroundNativeSize')}</span><b>{control.attempt?.generationCanvasCrop?.sourceWidth ?? resolution.input.width} × {control.attempt?.generationCanvasCrop?.sourceHeight ?? resolution.input.height}</b></div>
      {resolution.output && <div className="vc-flow-facts"><span>{t('wallpaperBackgroundResolvedSize')}</span><b>{resolution.output.width} × {resolution.output.height}</b></div>}
    </section>
  }
  function RenderingDetails({ control, t }: { control: Controller; t: WorkbenchText }) {
    const { value, item, attempt } = control
    if (!value || !item || !attempt) return <WallpaperNode kind="rendering" control={control} t={t} single />
    const live = value.enhancements?.[item.imageVersionId]
    const enhancing = attempt === item.attempts.at(-1) && ['running', 'pausing', 'paused', 'interrupted'].includes(wallpaperImageWorkStatus(value, item.imageVersionId)) && (attempt.backgroundResolution?.status === 'enhancing' || attempt.clarity?.status === 'enhancing')
    const id = imageWorkflowArtifact('rendering', item, attempt), preview = resource(id ? value.previewResources[id] : undefined), full = resource(id ? value.resources[id] : undefined), waiting = item.status === 'rendering' && !id
    return <div className="vc-image-result-grid"><figure className="vc-image-result-preview"><ImageStepPreview preview={preview} full={full} label={t('wallpaperClean')} waiting={waiting} generating={waiting && !!attempt.needsOutpaint && !!attempt.generation} enhancing={enhancing} progress={live?.revision === attempt.revision ? live.progress : undefined} moving={active(value.status)} control={control} t={t} /><figcaption>{t(id ? 'wallpaperClean' : 'wallpaperEditingWait')}</figcaption></figure><div className="vc-image-result-summary"><strong>{t(attempt.layoutCorrection ? 'wallpaperCandidatePlacement' : attempt.compositionMode === 'generated-canvas-v1' ? 'wallpaperGeneratedCanvasLabel' : attempt.needsOutpaint ? 'wallpaperOutpaint' : 'wallpaperCropOnly')}</strong><dl><div><dt>{t('wallpaperEditCount')}</dt><dd>{item.edits} / {value.settings.maxEditsPerImage}</dd></div><div><dt>{t('wallpaperOutputSpec')}</dt><dd>{value.settings.width} × {value.settings.height}</dd></div></dl><BackgroundResolutionDetails control={control} t={t} />{attempt.backgroundResolution && <p className="vc-flow-muted">{t(attempt.generationBrief || attempt.preResolutionReview ? attempt.layoutCorrection ? 'wallpaperCandidatePlacementPreReviewHint' : 'wallpaperGeneratedCanvasPreReviewHint' : attempt.layoutCorrection ? 'wallpaperCandidatePlacementHint' : isGeneratedCanvasMode(attempt.compositionMode) ? 'wallpaperGeneratedCanvasHint' : 'wallpaperBackgroundResolutionHint')}</p>}{attempt.generation && <p className="vc-flow-muted">{t('wallpaperRecoveryReceiptHint')}</p>}</div></div>
  }
  function ReviewDetails({ control, t }: { control: Controller; t: WorkbenchText }) {
    const { value, item, attempt } = control
    if (!value || !item || !attempt) return <WallpaperNode kind="reviewing" control={control} t={t} single />
    const checks = attempt.review ? Object.entries(attempt.review.checks) : [], passed = checks.filter(([, check]) => check.result === 'satisfied').length
    const id = attempt.analysisId, preview = resource(id ? value.previewResources[id] : undefined), full = resource(id ? value.resources[id] : undefined)
    return <div className="vc-image-review-detail"><div className="vc-image-result-grid">{preview && <figure className="vc-image-result-preview"><ImageStepPreview preview={preview} full={full} label={t('wallpaperReviewAnalysis')} waiting={false} moving={false} control={control} t={t} /><figcaption>{t('wallpaperReviewAnalysis')}</figcaption></figure>}<div className="vc-image-result-summary"><strong>{checks.length ? t('wallpaperReviewSummary').replace('{passed}', String(passed)).replace('{total}', String(checks.length)) : t('wallpaperReviewPending')}</strong>{attempt.review?.issues.map((issue, index) => <p key={index}>{issue.reason}</p>)}{attempt.review && 'layoutWarnings' in attempt.review && attempt.review.layoutWarnings.map((warning, index) => <p key={index} className='vc-flow-muted'>{t('wallpaperPeripheralWarning').replace('{name}', warning.slice('peripheral-outside:'.length))}</p>)}{!checks.length && <p className="vc-flow-muted">{active(value.status) ? t('wallpaperClarityPending') : issueMessage(item, t)}</p>}</div></div>{checks.length > 0 && <div className="vc-image-review-detail-checks">{checks.map(([key, check]) => <section key={key}><ui.Tag tone={check.result === 'satisfied' ? 'success' : check.result === 'violated' ? 'warning' : 'neutral'}>{t(key === 'style' && value.state.version === 2 ? 'directCropFaithful' : checkKeys[key as keyof typeof checkKeys])} · {t(check.result === 'satisfied' ? 'wallpaperSatisfied' : check.result === 'violated' ? 'wallpaperViolated' : 'wallpaperUnknownCheck')}</ui.Tag><p>{check.reason}</p></section>)}</div>}{attempt.review && 'reviewVersion' in attempt.review && (attempt.review.reviewVersion === 'wallpaper-review-source-v3' || attempt.review.reviewVersion === 'wallpaper-review-source-v4') && <section className="vc-clarity-details"><strong>{t('wallpaperActualRegions')}</strong><p>{t('wallpaperActualRegionsHint')}</p><dl>{attempt.review.actualLayout.regions.map((region, index) => <div key={index}><dt>{region.name}</dt><dd>{Math.round(region.rect.x * value.settings.width)}, {Math.round(region.rect.y * value.settings.height)} · {Math.round(region.rect.width * value.settings.width)} × {Math.round(region.rect.height * value.settings.height)}</dd></div>)}</dl><strong>{t('wallpaperSourceCorrespondence')}</strong><p>{attempt.review.sourceCorrespondence.reason}</p></section>}</div>
  }

  function ImageHistory({ control, t }: { control: Controller; t: WorkbenchText }) {
    const item = control.item, value = control.value
    if (!item || !value) return <p className="vc-flow-muted">{t('wallpaperHistoryNoRecords')}</p>
    const entries = wallpaperImageHistory(item, value.artifactTimes)
    const labels = { original: 'wallpaperStageOriginal', plan: 'wallpaperHistoryPlan', image: 'wallpaperHistoryImage', review: 'wallpaperHistoryReview', resolution: 'wallpaperHistoryResolution', final: 'wallpaperHistoryFinal' } as const
    return entries.length ? <ol className="vc-image-history" aria-label={t('wallpaperHistoryTitle')}>
      {entries.map(entry => <li key={entry.id} data-kind={entry.kind}>
        <div className="vc-image-history-heading"><strong>{entry.kind === 'image' ? t(!entry.imageId ? 'wallpaperHistoryImagePending' : entry.reused ? 'wallpaperHistoryReused' : 'wallpaperHistoryImage') : t(labels[entry.kind])}</strong><time dateTime={entry.time}>{entry.time ? new Date(entry.time).toLocaleString() : t('wallpaperHistoryTimeUnknown')}</time></div>
        {entry.revision && <small className="vc-flow-muted">{t('wallpaperAttempt')} {entry.revision}</small>}
        {entry.verdict && <ui.Tag tone={entry.verdict === 'pass' ? 'success' : 'warning'}>{t(entry.verdict === 'pass' ? 'wallpaperPassed' : entry.verdict === 'reject' ? 'wallpaperReviewRejected' : 'wallpaperAttention')}</ui.Tag>}
        {entry.reason && <p>{entry.reason}</p>}
        {entry.promptSaved && <small className="vc-flow-muted">{t('wallpaperHistoryPromptSaved')}</small>}
        {entry.model && <small className="vc-flow-muted">{t('wallpaperImageModel')} · {entry.model}</small>}
        {entry.imageId && <Artifact path={value.resources[entry.imageId]} label={t(labels[entry.kind])} control={control} />}
        {entry.kind === 'plan' && entry.revision !== undefined && <ui.Button size="sm" variant="outline" onClick={() => { if (entry.revision === undefined) return; control.setRevision({ image: item.imageVersionId, revision: entry.revision }); control.setHistoryOpen(false) }}>{t('wallpaperHistoryViewRevision')}</ui.Button>}
      </li>)}
    </ol> : <p className="vc-flow-muted">{t('wallpaperHistoryNoRecords')}</p>
  }
  function Dialogs({ control: baseControl, t }: { control: Controller; t: WorkbenchText }) {
    const control = { ...baseControl, attempt: baseControl.detailAttempt, setRevision: baseControl.setDetailRevision }
    const { experience, sample } = control
    let editorPlan: WallpaperPlan | undefined
    try { editorPlan = wallpaperPlanSchema.parse(JSON.parse(control.planText ?? 'null')) }
    catch (error) { /* Invalid JSON remains editable in the advanced fields. */ }
    const editorSource = editorPlan && control.value?.sourceImages[editorPlan.imageVersionId]
    const planMessage = editorPlan && control.value ? planValidationMessage(editorPlan, control.value, control.item?.originalId) : undefined
    const [casePage, setCasePage] = React.useState(0), [experienceTab, setExperienceTab] = React.useState<'versions' | 'cases'>('versions')
    const experienceId = React.useId()
    const [sections, setSections] = React.useState<string[]>([])
    const toggleSection = (id: string) => setSections(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
    const required = control.settings.minBenchmarks, interval = control.settings.learningInterval
    const families = new Set(experience?.cases.map(row => row.familyId)).size
    const benchmarks = new Set(experience?.cases.filter(row => row.benchmark).map(row => row.familyId)).size
    const newFamilies = new Set(experience?.cases.filter(row => row.learningEligible && !experience.distilledFamilyIds.includes(row.familyId)).map(row => row.familyId)).size
    React.useEffect(() => { setCasePage(0) }, [control.sourceId, control.experienceOpen])
    const numberFields = [['topBuffer', 'wallpaperTopBuffer', 0, 256], ['sideOverflow', 'wallpaperSideOverflow', 0, 258], ['bottomOverflow', 'wallpaperBottomOverflow', 0, 562], ['maxReworks', 'wallpaperReworks', 0, 5], ['maxEditsPerImage', 'wallpaperMaxEdits', 0, 5]] as const
    const field = ([key, label, min, max]: (typeof numberFields)[number]) => <label key={key}><span>{t(label)}</span><input type="number" inputMode="numeric" step={1} min={min} max={max} value={control.settings[key]} onChange={event => control.setSettings({ ...control.settings, [key]: Number(event.currentTarget.value) })} /></label>
    const versionReason = (reason: string) => t(reason === 'benchmark-overlap' ? 'wallpaperOverlap' : reason === 'requires-new-generation' ? 'wallpaperNeedsGeneration' : reason === 'no-demonstrated-improvement' ? 'wallpaperNoImprovement' : reason === 'fixed-benchmarks-improved' ? 'wallpaperImproved' : 'wallpaperAwaitingBenchmarks')
    return <>
      <ui.Modal open={control.historyOpen} onClose={() => control.setHistoryOpen(false)} title={`${t('wallpaperImage')} ${control.offset + 1} · ${t('wallpaperHistoryTitle')}`} closeLabel={t('close')} className="vc-wallpaper-modal vc-image-history-modal" contentClassName="vc-image-history-shell" footer={<ui.Button variant="outline" onClick={() => control.setHistoryOpen(false)}>{t('close')}</ui.Button>}>
        <ImageHistory control={baseControl} t={t} />
      </ui.Modal>
      <ui.Modal open={control.details !== null} onClose={() => control.setDetails(null)} title={control.details ? `${t('wallpaperImage')} ${control.offset + 1} · ${t(control.details === 'clarity' ? 'wallpaperClarity' : stepKeys[control.details])}` : ''} closeLabel={t('close')} className={"vc-wallpaper-modal vc-image-details-modal" + (control.item && ['needs-review', 'technical-failed'].includes(control.item.status) ? ' vc-image-details-failure-modal' : '')} contentClassName="vc-image-details-shell" footer={<DetailsFooter control={control} t={t} />}>
        <DetailContext control={control} t={t} />
        {control.details === 'decision' ? <DecisionCard control={control} t={t} detailed /> : control.details === 'detail' ? <DetailInspectionCard control={control} t={t} detailed /> : control.item && ['needs-review', 'technical-failed'].includes(control.item.status) && control.attempt === control.item.attempts.at(-1) && control.details !== 'planning' && control.details !== 'clarity' && control.details !== 'reviewing' && wallpaperFailedStep(control.item) === control.details ? <FailureDetails control={control} t={t} /> : control.details === 'planning' ? <PlanningDetails control={control} t={t} /> : control.details === 'rendering' ? <RenderingDetails control={control} t={t} /> : control.details === 'reviewing' ? <ReviewDetails control={control} t={t} /> : control.details === 'clarity' ? <ClarityDetails control={control} t={t} /> : control.details && <WallpaperNode kind={control.details} control={control} t={t} single />}
        {control.details === 'reviewing' && control.attempt?.outputId && <p className="vc-flow-muted">{t('wallpaperReviewCurrentHint')}</p>}
        {control.details === 'rendering' && !control.attempt?.backgroundResolution && (generatedCanvasReviewAvailable(control) || isGeneratedCanvasMode(control.attempt?.compositionMode)) && <p className="vc-flow-muted">{t(control.attempt?.generationBrief || control.attempt?.preResolutionReview ? 'wallpaperGeneratedCanvasPreReviewHint' : 'wallpaperGeneratedCanvasHint')}</p>}
      </ui.Modal>
      <ui.Modal open={control.settingsOpen} onClose={() => control.setSettingsOpen(false)} title={t('wallpaperSettings')} closeLabel={t('close')} className="vc-wallpaper-modal vc-wallpaper-settings-modal" contentClassName="vc-wallpaper-settings-shell" footer={<div className="vc-wallpaper-dialog-actions"><ui.Button variant="outline" onClick={() => control.setSettingsOpen(false)}>{t('close')}</ui.Button><ui.Button variant="primary" disabled={control.busy} onClick={control.start}>{t('wallpaperStartBatch')}</ui.Button></div>}>
        <div className="vc-wallpaper-settings-content">
          <div className="vc-wallpaper-output-summary"><div><span>{t('wallpaperOutputSpec')}</span><strong>{control.settings.width} × {control.settings.height}</strong></div><div><span>{t('wallpaperSafeSpec')}</span><strong>{control.settings.safe.width} × {control.settings.safe.height}</strong></div></div>
          <p className="vc-flow-muted">{t('wallpaperAllResults')} · {control.sourceCount}</p>
          <section className="vc-wallpaper-settings-section"><h3>{t('wallpaperSafeSection')}</h3><div className="vc-wallpaper-fields vc-wallpaper-safe-fields">{numberFields.slice(0, 3).map(field)}</div></section>
          <section className="vc-wallpaper-settings-section"><h3>{t('wallpaperRetrySection')}</h3><div className="vc-wallpaper-fields">{numberFields.slice(3).map(field)}</div></section>
          <section className="vc-wallpaper-settings-section"><h3>{t('wallpaperModelSection')}</h3><label className="vc-wallpaper-field"><span>{t('wallpaperImageModel')}</span><SelectField label={t('wallpaperImageModel')} value={control.settings.imageModel} options={[{ value: '', label: t('wallpaperAutomaticModel') }, ...control.models.map(model => ({ value: model.id, label: model.name }))]} onChange={imageModel => control.setSettings({ ...control.settings, imageModel })} /></label>{!control.models.length && <p className="vc-flow-muted">{t('wallpaperNoImageModel')}</p>}</section>
          <section className="vc-wallpaper-settings-section"><ui.Checkbox label={t('wallpaperBackgroundResolution')} checked={control.settings.backgroundResolution?.enabled ?? true} onChange={enabled => control.setSettings({ ...control.settings, backgroundResolution: backgroundResolutionSettingsSchema.parse({ ...control.settings.backgroundResolution, enabled }) })} /><p className="vc-flow-muted">{t('wallpaperBackgroundResolutionHint')}</p></section>
          {control.error && <p role="alert" className="vc-notice">{t('wallpaperInvalidSettings')}</p>}
        </div>
      </ui.Modal>
      <ui.Modal open={control.planText !== null} onClose={() => control.setPlanText(null)} title={t('wallpaperEditPlan')} closeLabel={t('close')} className="vc-wallpaper-modal vc-plan-modal" contentClassName="vc-plan-modal-shell" footer={<div className="vc-plan-modal-footer">
        <div className="vc-plan-modal-validation" role={planMessage || control.error || !editorPlan ? 'alert' : 'status'}><ui.StateDot state={planMessage || control.error || !editorPlan ? 'error' : 'idle'} /><span>{t(planMessage ?? (control.error || !editorPlan ? 'wallpaperInvalidPlan' : !editorSource ? 'wallpaperPlanUnchecked' : 'wallpaperEditorReady'))}</span></div>
        <div className="vc-plan-modal-actions"><ui.Button variant="outline" onClick={() => control.setPlanText(null)}>{t('close')}</ui.Button><ui.Button variant="primary" disabled={control.busy || !editorPlan || !!planMessage} onClick={control.applyPlan}>{t('wallpaperApplyPlan')}</ui.Button></div>
      </div>}>
        <div className="vc-plan-modal-context"><span>{t('wallpaperImage')} {control.offset + 1}</span><p>{t('wallpaperPlanHint')}</p></div>
        {editorPlan && editorSource && resource(editorSource.previewPath) && <PlanEditor key={`${control.value?.runId}:${editorPlan.imageVersionId}`} plan={editorPlan} settings={control.value!.settings} source={{ ...editorSource, previewPath: resource(editorSource.previewPath)! }} disabled={control.busy} onChange={plan => control.setPlanText(JSON.stringify(plan, null, 2))} t={t} />}
        <div className="vc-plan-modal-advanced">
        <ui.DisclosureRow icon={<ui.IconCodeOutlineRegular size={14} />} title={t('wallpaperPlanJson')} open={!editorSource || sections.includes('plan-json')} expandable expandOnRowClick onToggle={() => toggleSection('plan-json')}>
          <label className="vc-wallpaper-field"><span>{t('wallpaperPlanJson')}</span><textarea rows={8} value={control.planText ?? ''} onChange={event => control.setPlanText(event.currentTarget.value)} /></label>
        </ui.DisclosureRow>
        </div>
      </ui.Modal>
      <ui.Modal open={control.experienceOpen} onClose={() => control.setExperienceOpen(false)} title={t('wallpaperExperience')} description={t('wallpaperExperienceHint')} closeLabel={t('close')} className="vc-wallpaper-modal vc-experience-modal" contentClassName="vc-experience-content">
        {experience && <>
          <div className="vc-experience-summary"><div><small>{t('workflowExperienceCurrent')}</small><strong>{experience.active}</strong><small>{t('workflowExperienceActiveHint')}</small></div><div><small>{t('wallpaperCaseCount')}</small><strong>{families}</strong><small>{t('workflowExperienceCasesHint')}</small></div><div><small>{t('wallpaperBenchmarks')}</small><strong>{benchmarks}<span> / {required}</span></strong><small>{t('workflowExperienceBenchmarksHint')}</small></div></div>
          <section className="vc-experience-guidance"><div className="vc-experience-policy-heading"><ui.IconSparkleRegular size={16} /><h3>{t('workflowExperiencePolicy')}</h3></div><p className="vc-flow-muted">{t('workflowExperiencePolicyHint')}</p><ui.Checkbox className="vc-experience-auto" label={t('wallpaperAutoPromote')} checked={experience.autoPromote} disabled={control.busy} onChange={enabled => control.experienceAction({ kind: 'auto', enabled })} /><ui.DisclosureRow icon={<ui.IconInfoOutlineRegular size={14} />} title={t('workflowExperienceEvidence')} open={sections.includes('policy')} expandable expandOnRowClick onToggle={() => toggleSection('policy')}><div className="vc-experience-policy-detail"><p>{t('workflowExperienceReadiness').replace('{count}', String(required))}</p><div className="vc-experience-learning-progress"><span>{t('workflowExperienceCollected')}</span><strong>{Math.min(interval, newFamilies)} / {interval}</strong></div><div className="vc-experience-progress-track" role="progressbar" aria-label={t('workflowExperienceCollected')} aria-valuemin={0} aria-valuemax={interval} aria-valuenow={Math.min(interval, newFamilies)}><span style={{ width: `${Math.min(100, newFamilies / interval * 100)}%` }} /></div><small>{t('workflowExperienceRemaining')} · {Math.max(0, interval - newFamilies)}</small></div></ui.DisclosureRow></section>
          <ui.SegmentedTabs className="vc-experience-tabs" variant="underline" label={t('wallpaperExperience')} value={experienceTab} onChange={setExperienceTab} items={[{ value: 'versions', label: t('workflowExperienceVersions'), id: `${experienceId}-versions-tab`, panelId: `${experienceId}-versions` }, { value: 'cases', label: t('workflowExperienceCases'), id: `${experienceId}-cases-tab`, panelId: `${experienceId}-cases` }]} />
          <section id={`${experienceId}-versions`} role="tabpanel" aria-labelledby={`${experienceId}-versions-tab`} hidden={experienceTab !== 'versions'} className="vc-wallpaper-versions">
            {experience.versions.slice().reverse().map(version => <article className="vc-experience-version" key={version.id}>
              <header><div><ui.Tag tone={version.status === 'active' ? 'success' : version.status === 'pending-evidence' ? 'warning' : 'neutral'}>{t(versionKeys[version.status])}</ui.Tag><code title={version.id}>{version.id}</code></div><time dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleDateString()}</time></header>
              <p className="vc-flow-muted">{versionReason(version.reason)}</p>
              {version.parentId && <small className="vc-flow-muted">{t('wallpaperBaseline')} {version.parentId.slice(0, 12)}</small>}
              {version.evaluation && <div className="vc-experience-evaluation"><div><small>{t('wallpaperCorrect')}</small><strong>{version.evaluation.baselinePass} → {version.evaluation.candidatePass} / {version.evaluation.compared}</strong></div><div><small>{t('wallpaperFalseAccepts')}</small><strong>{version.evaluation.falseAccepts}</strong></div><div><small>{t('wallpaperReviewRounds')}</small><strong>{version.evaluation.baselineRounds} → {version.evaluation.candidateRounds}</strong></div></div>}
              {version.changes && <ui.DisclosureRow icon={<ui.IconListPenOutlineRegular size={14} />} title={t('wallpaperChanges')} open={sections.includes(`changes:${version.id}`)} expandable expandOnRowClick onToggle={() => toggleSection(`changes:${version.id}`)}><pre>{[...version.changes.removed.map(line => `− ${line}`), ...version.changes.added.map(line => `+ ${line}`)].join('\n')}</pre></ui.DisclosureRow>}
              <ui.DisclosureRow icon={<ui.IconCodeOutlineRegular size={14} />} title={t('workflowExperienceContent')} open={sections.includes(`content:${version.id}`)} expandable expandOnRowClick onToggle={() => toggleSection(`content:${version.id}`)}><pre>{version.content}</pre></ui.DisclosureRow>
              {!!version.caseIds.length && <ui.DisclosureRow icon={<ui.IconFolderOpenOutlineRegular size={14} />} title={`${t('wallpaperEvidenceCases')} · ${version.caseIds.length}`} open={sections.includes(`cases:${version.id}`)} expandable expandOnRowClick onToggle={() => toggleSection(`cases:${version.id}`)}><div className="vc-flow-node-actions">{version.caseIds.map(id => <ui.Button key={id} size="sm" variant="ghost" disabled={control.busy} onClick={() => { setExperienceTab('cases'); control.inspectCase(id) }}>{id.slice(0, 12)}</ui.Button>)}</div></ui.DisclosureRow>}
              {['verified', 'retired'].includes(version.status) && <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.experienceAction({ kind: 'activate', versionId: version.id })}>{t('wallpaperRollback')}</ui.Button>}
            </article>)}
          </section>
          <section id={`${experienceId}-cases`} role="tabpanel" aria-labelledby={`${experienceId}-cases-tab`} hidden={experienceTab !== 'cases'}>
            {sample ? <section className="vc-wallpaper-case"><ui.Button size="sm" variant="ghost" onClick={() => control.setSample(null)}>{t('workflowBackToCases')}</ui.Button><p className="vc-flow-muted">{t('workflowExperienceEvidenceHint')}</p><div className="vc-wallpaper-case-images"><img src={resource(sample.sourcePath)} alt={t('wallpaperSource')} draggable={false} onLoad={() => control.setViewed(true)} />{sample.outputPath && <img src={resource(sample.outputPath)} alt={t('wallpaperClean')} draggable={false} />}</div><div className="vc-flow-node-actions"><ui.Button variant="outline" disabled={!control.viewed || control.busy} onClick={() => control.experienceAction({ kind: 'benchmark', caseId: sample.caseId, expectedPass: true })}>{t('wallpaperBenchmarkYes')}</ui.Button><ui.Button variant="outline" disabled={!control.viewed || control.busy} onClick={() => control.experienceAction({ kind: 'benchmark', caseId: sample.caseId, expectedPass: false })}>{t('wallpaperBenchmarkNo')}</ui.Button></div>{!control.viewed && <small>{t('wallpaperReadBeforeConfirm')}</small>}</section> : <div className="vc-wallpaper-cases">{!experience.cases.length && <div className="vc-flow-empty">{t('wallpaperNoCases')}</div>}{experience.cases.slice().reverse().slice(casePage * control.pageSize, (casePage + 1) * control.pageSize).map(row => <div key={row.id}><ui.Tag>{t(modeKeys[row.mode])}</ui.Tag><small>{t(row.passed ? 'wallpaperPassed' : 'wallpaperAttention')}{row.benchmark ? ` · ${t('wallpaperBenchmarks')}` : ''}</small><ui.Button size="sm" variant="ghost" disabled={control.busy} onClick={() => control.inspectCase(row.id)}>{t('wallpaperCaseDetails')}</ui.Button></div>)}</div>}
            {!sample && experience.cases.length > control.pageSize && <div className="vc-flow-image-pager"><ui.Button size="sm" variant="ghost" disabled={!casePage} onClick={() => setCasePage(value => value - 1)}>{t('wallpaperPrevious')}</ui.Button><span>{casePage + 1} / {Math.ceil(experience.cases.length / control.pageSize)}</span><ui.Button size="sm" variant="ghost" disabled={(casePage + 1) * control.pageSize >= experience.cases.length} onClick={() => setCasePage(value => value + 1)}>{t('wallpaperNext')}</ui.Button></div>}
          </section>
        </>}
        {control.error && <p role="alert" className="vc-notice">{t('wallpaperFailed')}</p>}
      </ui.Modal>
      {control.preview && <ui.ImageLightbox src={control.preview} alt={t('wallpaperWorkflow')} labels={{ dialog: t('wallpaperWorkflow'), close: t('close') }} loadingLabels={{ loading: t('galleryPreviewLoading'), error: t('galleryPreviewError'), retry: t('retry') }} onClose={() => control.setPreview(null)} />}
    </>
  }
  return { useWallpaper, WallpaperNode, PlanningImageCard, ImageNavigator, ImageStepCard, DecisionCard, UpcomingStepCard, StepHistory, DownloadProgress, TaskStatus, Dialogs }
}
