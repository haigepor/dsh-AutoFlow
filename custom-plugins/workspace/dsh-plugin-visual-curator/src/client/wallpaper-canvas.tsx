/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Bounded live wallpaper reads and download, planning, rendering and review nodes use native controls. */
import { z } from 'zod'
import { wallpaperExperienceSchema, wallpaperPlanSchema, wallpaperSettingsSchema, wallpaperViewSchema, wallpaperFailedStep, type WallpaperExperience, type WallpaperView, type WallpaperPlan } from '../shared/wallpaper.ts'
import type { SearchBatch } from '../shared/search-batches.ts'
import type { Json } from './contract.ts'
import type { WorkbenchText } from './workbench-locale.ts'
import { safeResourcePath } from './store.ts'
import { wallpaperStage, type WallpaperStep } from './workflow-node-state.ts'
import { createSelectField } from './select-field.tsx'
import { createWallpaperPlanEditor } from './wallpaper-plan-editor.tsx'
import { wallpaperGeometry } from '../shared/wallpaper-geometry.ts'
import { planningWindowStart, planningImagePhase, imageNavigationPageSize, imageWorkflowPhase, type ImageWorkflowStage } from './workflow-image-branches.ts'

/** Narrow operations used by canvas observation and explicit owner actions. */
export type WallpaperOperation = 'wallpaper-read' | 'wallpaper-start' | 'wallpaper-options' | 'wallpaper-control' | 'wallpaper-continue' | 'wallpaper-plan-update' | 'wallpaper-experience' | 'wallpaper-experience-action' | 'wallpaper-case'
/** Native transport retains the current authenticated profile and never accepts caller-supplied actors. */
export type WallpaperInvoke = (operation: WallpaperOperation, args: Record<string, Json>, signal?: AbortSignal) => Promise<unknown>

const active = (status: string) => ['created', 'running', 'pausing', 'cancelling'].includes(status)
const modeKeys = { single: 'wallpaperSingle', group: 'wallpaperGroup', scene: 'wallpaperScene', abstract: 'wallpaperAbstract', uncertain: 'wallpaperUncertain' } as const
const checkKeys = { subject: 'wallpaperSubjectCheck', protection: 'wallpaperProtectionCheck', clock: 'wallpaperClockCheck', readability: 'wallpaperReadabilityCheck', composition: 'wallpaperCompositionCheck', background: 'wallpaperBackgroundCheck', style: 'wallpaperStyleCheck' } as const
const stepKeys = { downloading: 'wallpaperDownloading', planning: 'wallpaperPlanning', rendering: 'wallpaperRendering', reviewing: 'wallpaperReviewing' } as const
const versionKeys = { candidate: 'wallpaperCandidate', 'pending-evidence': 'wallpaperPendingEvidence', verified: 'wallpaperVerified', active: 'wallpaperActive', retired: 'wallpaperRetired' } as const
const settingsReply = z.object({ settings: wallpaperSettingsSchema, models: z.array(z.object({ id: z.string(), name: z.string() })) })
const caseReply = z.object({ caseId: z.string(), sourcePath: z.string(), outputPath: z.string().optional() })

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
  function useWallpaper(batch: SearchBatch | undefined, invoke: WallpaperInvoke | undefined, pollMs: number, pageSize: number, refreshKey = 0, windowSize = 1) {
    const sourceId = batch?.kind === 'search' ? batch.runId : '', enabled = !!invoke, latest = React.useRef(invoke); latest.current = invoke
    const current = React.useRef(sourceId); current.current = sourceId
    const [task, setTask] = React.useState<WallpaperView | null>(null), [page, setPage] = React.useState({ sourceId, offset: 0 }), [revision, refresh] = React.useState(0)
    const offset = page.sourceId === sourceId ? page.offset : 0
    const windowStart = planningWindowStart(offset, windowSize)
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(false), [settingsOpen, setSettingsOpen] = React.useState(false)
    const [settings, setSettings] = React.useState(() => wallpaperSettingsSchema.parse({})), [models, setModels] = React.useState<{ id: string; name: string }[]>([])
    const [preview, setPreview] = React.useState<string | null>(null), [planText, setPlanText] = React.useState<string | null>(null)
    const [details, setDetails] = React.useState<WallpaperStep | null>(null)
    const [experience, setExperience] = React.useState<WallpaperExperience | null>(null), [experienceOpen, setExperienceOpen] = React.useState(false)
    const [sample, setSample] = React.useState<z.infer<typeof caseReply> | null>(null), [viewed, setViewed] = React.useState(false)
    const alive = React.useRef(true)
    const working = React.useRef(false), operation = React.useRef({ sourceId, id: crypto.randomUUID() }), mutation = React.useRef({ key: '', id: '' })
    const [selectedRevision, setRevision] = React.useState({ image: '', revision: 0 })
    React.useEffect(() => setDetails(null), [sourceId, offset])
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
          const raw = await latest.current!('wallpaper-read', { sourceRunId: sourceId, offset: windowStart, limit: windowSize }, controller.signal)
          if (!controller.signal.aborted) {
            const value = raw === null ? null : wallpaperViewSchema.parse(raw)
            if (value && (value.sourceRunId !== sourceId || value.offset !== windowStart || value.state.items.some((item, index) => value.itemIndex?.[windowStart + index] && value.itemIndex[windowStart + index]!.imageVersionId !== item.imageVersionId))) throw new Error('Wallpaper response does not match the requested image window')
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
            poll = value ? active(value.status) : active(batch?.wallpaper?.status ?? '') || !!batch?.wallpaperRequested && !batch.postProcessingError && (active(batch.status) || batch.status === 'completed' && batch.matched > 0)
          }
        }
        catch (error) { if (!controller.signal.aborted) { setError(true); if (renewedExpiry !== undefined) poll = false } }
        finally {
          reading = false
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
    }, [sourceId, windowStart, windowSize, revision, pollMs, refreshKey, enabled, batch?.status, batch?.matched, batch?.wallpaperRequested, batch?.wallpaper, batch?.postProcessingError])
    React.useEffect(() => { setBusy(false); setError(false); setSettingsOpen(false); setPlanText(null); setPreview(null); setExperienceOpen(false); setSample(null) }, [sourceId])
    const work = async (callback: (call: WallpaperInvoke) => Promise<void>) => {
      if (!latest.current || working.current) return
      working.current = true
      const scope = sourceId; setBusy(true); setError(false)
      try { await callback(latest.current); if (alive.current && current.current === scope) refresh(value => value + 1) }
      catch (error) { if (alive.current && current.current === scope) setError(true) }
      finally { working.current = false; if (alive.current && current.current === scope) setBusy(false) }
    }
    const value = task?.sourceRunId === sourceId && task.offset === windowStart ? task : null
    const item = value?.state.items[offset - windowStart]
    const attempt = (selectedRevision.image === item?.imageVersionId ? item?.attempts.find(row => row.revision === selectedRevision.revision) : undefined) ?? item?.attempts.at(-1)
    return { value, item, attempt, setRevision, sourceId, itemIndex: task?.sourceRunId === sourceId ? task.itemIndex : undefined, total: task?.sourceRunId === sourceId ? task.total : batch?.matched ?? 0, sourceCount: batch?.matched ?? 0, pageSize: Math.max(1, pageSize), windowStart, windowSize, enabled: !!invoke, busy, error, offset, settings, models, settingsOpen, setSettingsOpen, setSettings, preview, setPreview, planText, setPlanText, details, setDetails, experience, experienceOpen, setExperienceOpen, sample, setSample, viewed, setViewed,
      page(at: number) { const next = Math.max(0, at); if (next !== offset) { setPlanText(null); setDetails(null); setPreview(null) } setPage({ sourceId, offset: next }) },
      openSettings() { void work(async call => { const result = settingsReply.parse(await call('wallpaper-options', {})); if (current.current === sourceId) { operation.current = { sourceId, id: crypto.randomUUID() }; setSettings(result.settings); setModels(result.models); setSettingsOpen(true) } }) },
      start() { const parsed = wallpaperSettingsSchema.safeParse(settings); if (!parsed.success) { setError(true); return } void work(async call => { await call('wallpaper-start', { operationId: operation.current.id, sourceRunId: sourceId, settings: parsed.data }); if (current.current === sourceId) setSettingsOpen(false) }) },
      control(command: 'pause' | 'resume' | 'cancel') { if (value) void work(async call => { await call('wallpaper-control', { runId: value.runId, command }) }) },
      continue() { if (value) void work(async call => { await call('wallpaper-continue', { runId: value.runId, operationId: mutationId(`continue:${value.runId}`) }) }) },
      editPlan() { if (attempt) setPlanText(JSON.stringify(attempt.plan, null, 2)) },
      editImagePlan(imageId: string) {
        const index = value?.state.items.findIndex(row => row.imageVersionId === imageId) ?? -1
        const saved = index >= 0 ? value?.state.items[index]?.attempts.at(-1) : undefined
        if (!value || !saved) return
        setPage({ sourceId, offset: value.offset + index }); setRevision({ image: imageId, revision: saved.revision }); setPlanText(JSON.stringify(saved.plan, null, 2))
      },
      applyPlan() { if (!value || !item || planText === null) return; let parsed; try { parsed = wallpaperPlanSchema.safeParse(JSON.parse(planText)) } catch (error) { setError(true); return } if (!parsed.success) { setError(true); return } const plan = parsed.data; if (planValidationMessage(plan, value, item.originalId)) { setError(true); return } void work(async call => { await call('wallpaper-plan-update', { runId: value.runId, imageVersionId: item.imageVersionId, plan, operationId: mutationId(`replan:${value.runId}:${item.imageVersionId}:${JSON.stringify(plan)}`) }); if (current.current === sourceId) setPlanText(null) }) },
      showExperience() { void work(async call => { const [saved, options] = await Promise.all([call('wallpaper-experience', {}), call('wallpaper-options', {})]); const catalog = wallpaperExperienceSchema.parse(saved), policy = settingsReply.parse(options); if (current.current === sourceId) { setExperience(catalog); setSettings(policy.settings); setExperienceOpen(true) } }) },
      experienceAction(args: Record<string, Json>) { void work(async call => { const catalog = wallpaperExperienceSchema.parse(await call('wallpaper-experience-action', args)); if (current.current === sourceId) { setExperience(catalog); setSample(null); setViewed(false) } }) },
      inspectCase(caseId: string) { void work(async call => { const entry = caseReply.parse(await call('wallpaper-case', { caseId })); if (current.current === sourceId) { setSample(entry); setViewed(false) } }) },
    }
  }
  type Controller = ReturnType<typeof useWallpaper>

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
    return <nav ref={panel} className="vc-image-navigator" style={{ '--vc-image-rail-width': `${width}px` } as import('react').CSSProperties} aria-label={t('wallpaperImageNavigation')}>
      <div className="vc-image-navigation-heading"><strong>{t('wallpaperImageFlow')}</strong><span>{t('wallpaperImage')} {control.offset + 1} / {total}</span>
        <SelectField menuClassName="vc-image-picker-menu" matchAnchorWidth={false} label={t('wallpaperJumpImage')} value={String(control.offset)} options={Array.from({ length: total }, (_, index) => ({ value: String(index), label: `${t('wallpaperImage')} ${index + 1}${entries[index] && ['needs-review', 'rejected', 'technical-failed'].includes(entries[index]!.status) ? ` · ${t('wallpaperAttention')}` : ''}` }))} disabled={control.busy || !total} onChange={value => select(Number(value))} />
        <ui.Button size="sm" variant="ghost" aria-label={t('wallpaperPreviousThumbnails')} disabled={!start} onClick={() => setDirectory({ sourceId: control.sourceId, start: Math.max(0, start - imageNavigationPageSize) })}><ui.IconChevronLeftOutlineRegular size={16} /></ui.Button>
        <ui.Button size="sm" variant="ghost" aria-label={t('wallpaperNextThumbnails')} disabled={start + imageNavigationPageSize >= total} onClick={() => setDirectory({ sourceId: control.sourceId, start: start + imageNavigationPageSize })}><ui.IconChevronRightOutlineRegular size={16} /></ui.Button>
      </div>
      <div className="vc-image-thumbnail-strip" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault(); select(Math.max(0, Math.min(total - 1, control.offset + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1))))
      }}>
        {Array.from({ length: Math.min(imageNavigationPageSize, Math.max(0, total - start)) }, (_, slot) => {
          const index = start + slot, entry = entries[index], path = resource(entry?.previewPath)
          return <button key={entry?.imageVersionId ?? index} type="button" className="vc-image-thumbnail" data-image-index={index} data-status={entry?.status} aria-current={index === control.offset ? 'true' : undefined} aria-label={`${t('wallpaperImage')} ${index + 1}`} disabled={control.busy} onClick={() => select(index)}>
            {path ? <img src={path} alt="" loading="lazy" decoding="async" draggable={false} /> : <ui.IconBrowseOutlineRegular size={20} />}<span className="vc-image-thumbnail-number">{index + 1}</span>
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

  function ImageStepCard({ kind, stage, control, t }: { kind: WallpaperStep; stage: ImageWorkflowStage; control: Controller; t: WorkbenchText }) {
    const { value, item, attempt } = control
    if (!value || !item) return <div className="vc-flow-node-body vc-image-step-card vc-image-step-loading" role="status" aria-busy="true"><ui.StateDot state="ongoing" /><span>{t('wallpaperLoadingImage')}</span></div>
    const qualified = item.status === 'passed' && attempt === item.attempts.at(-1) && !!attempt?.outputId && !!attempt.review && Object.values(attempt.review.checks).every(check => check.result === 'satisfied')
    const id = stage === 'final' ? qualified ? attempt?.outputId : undefined : kind === 'downloading' ? item.originalId : kind === 'planning' ? attempt?.analysisId : kind === 'rendering' ? attempt?.outputId : attempt?.simulationId
    const originalPreview = item.originalId ? resource(value.sourceImages[item.originalId]?.previewPath) : undefined
    const preview = resource(id ? value.previewResources[id] : undefined) ?? (kind === 'downloading' && originalPreview && new URL(originalPreview).searchParams.get('imageVersionId') !== item.originalId ? originalPreview : undefined)
    const full = resource(id ? value.resources[id] : undefined)
    const phase = imageWorkflowPhase(kind, item, value.status, attempt), checks = attempt?.review ? Object.entries(attempt.review.checks) : []
    const passed = checks.filter(([, check]) => check.result === 'satisfied').length
    return <div className="vc-flow-node-body vc-image-step-card nodrag nopan nowheel">
      <button type="button" className="vc-image-step-preview" disabled={!full} aria-label={t(stage === 'final' ? 'wallpaperClean' : kind === 'downloading' ? 'wallpaperSource' : kind === 'planning' ? 'wallpaperAnalysis' : kind === 'rendering' ? 'wallpaperClean' : 'wallpaperSimulation')} onClick={() => full && control.setPreview(full)}>{preview ? <img key={preview} onLoad={event => { event.currentTarget.dataset.loaded = 'true' }} src={preview} alt="" loading="lazy" decoding="async" draggable={false} /> : <ui.IconBrowseOutlineRegular size={24} />}</button>
      <div key={item.imageVersionId} className="vc-image-step-meta">
        {stage === 'geometry' ? <><div className="vc-flow-facts"><span>{t('wallpaperGeometryTarget')}</span><strong>{value.settings.width} × {value.settings.height}</strong></div>{attempt && <><div className="vc-flow-facts"><span>{t('wallpaperGeometryScale')}</span><strong>{attempt.plan.placement.scale}</strong></div><div className="vc-flow-facts"><span>{t('wallpaperGeometryOffset')}</span><strong>{attempt.plan.placement.left}, {attempt.plan.placement.top}</strong></div><small>{t(attempt.needsOutpaint ? 'wallpaperOutpaint' : 'wallpaperCropOnly')}</small></>}</> : stage === 'final' ? <><strong>{t(qualified ? 'wallpaperPassed' : 'wallpaperAttention')}</strong><small>{qualified ? t('wallpaperSize') : t('wallpaperFinalBlocked')}</small></> : kind === 'downloading' ? <div className="vc-flow-facts"><span>{item.originalId ? t('workflowDownloadSaved') : t('wallpaperIdle')}</span>{item.originalId && value.sourceImages[item.originalId] && <strong>{value.sourceImages[item.originalId]!.width} × {value.sourceImages[item.originalId]!.height}</strong>}</div> : kind === 'planning' ? <><p className="vc-planning-image-subject">{attempt?.plan.subject ?? t('wallpaperIdle')}</p>{attempt && <small>{t('wallpaperRound')} {attempt.revision} · {t('wallpaperPlanningRegions').replace('{count}', String(attempt.plan.regions.length))}</small>}</> : kind === 'rendering' ? <><strong>{attempt ? t(attempt.needsOutpaint ? 'wallpaperOutpaint' : 'wallpaperCropOnly') : t('wallpaperIdle')}</strong><small>{t('wallpaperEditCount')} {item.edits} / {value.settings.maxEditsPerImage}</small></> : <><strong>{t('wallpaperReviewSummary').replace('{passed}', String(passed)).replace('{total}', String(checks.length))}</strong><div className="vc-image-check-summary">{checks.filter(([, check]) => check.result !== 'satisfied').map(([key, check]) => <ui.Tag key={key} tone={check.result === 'violated' ? 'warning' : 'neutral'}>{t(checkKeys[key as keyof typeof checkKeys])} · {t(check.result === 'violated' ? 'wallpaperViolated' : 'wallpaperUnknownCheck')}</ui.Tag>)}</div></>}
        {['failed', 'attention', 'blocked'].includes(phase) && <small className="vc-flow-muted">{t(phase === 'blocked' ? 'workflowStepBlocked' : 'wallpaperAttention')}</small>}
      </div>
      <div className="vc-flow-node-actions"><ui.Button size="sm" variant="outline" onClick={() => control.setDetails(kind)}>{t('wallpaperStepDetails')}</ui.Button>{kind === 'planning' && stage !== 'geometry' && attempt && <ui.Button size="sm" variant="outline" disabled={control.busy || active(value.status) || attempt !== item.attempts.at(-1)} onClick={control.editPlan}>{t('wallpaperEditPlan')}</ui.Button>}{stage === 'final' && qualified && full && <a className="vc-wallpaper-download" href={full} download="wallpaper-1845x3280.png">{t('wallpaperDownload')}</a>}</div>
    </div>
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
    const annotated = attempt?.analysisId ? resource(value.previewResources[attempt.analysisId]) : undefined
    const source = item.originalId ? resource(value.sourceImages[item.originalId]?.previewPath) : undefined
    // A missing derivative never auto-decodes an old full-resolution original in every card.
    const preview = annotated ?? (source && new URL(source).searchParams.get('imageVersionId') !== item.originalId ? source : undefined)
    const full = resource(attempt?.analysisId ? value.resources[attempt.analysisId] : item.originalId ? value.resources[item.originalId] : undefined)
    const phase = planningImagePhase(item, value.status)
    return <div className="vc-flow-node-body vc-planning-image-card nodrag nopan nowheel">
      {preview && full && <button className="vc-planning-image-preview" aria-label={t(attempt?.analysisId ? 'wallpaperAnalysis' : 'workflowDownloadPreview')} onClick={() => control.setPreview(full)}><img src={preview} alt={attempt?.plan.subject ?? `${t('wallpaperImage')} ${index + 1}`} loading="lazy" decoding="async" draggable={false} /></button>}
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
    const failureMessage = (code: string | undefined) => code === 'original-source-restricted' ? t('workflowSourceRestricted') : code === 'original-account-mismatch' ? t('workflowSourceAccount') : code === 'vision-image-too-large' ? t('workflowVisionTooLarge') : code === 'vision-image-digest-mismatch' ? t('workflowVisionDigest') : code?.startsWith('original-download-http-') ? t('workflowDownloadNetwork') : code === 'reference-unavailable' || code === 'original-source-unavailable' ? t('workflowSourceUnavailable') : undefined
    const explanation = (text: string | undefined) => !text ? '' : text === 'IMAGE_CREDITS_DISABLED' ? t('wallpaperCreditsDisabled') : text === 'image-operation-pruned' ? t('wallpaperReceiptPruned') : text === 'rework-limit' ? t('wallpaperReworkLimit') : text === 'edit-limit' ? t('wallpaperEditLimit') : text === 'image-capability-unavailable' ? t('wallpaperMissingCapability') : text === 'outcome-unknown' || text === 'interrupted-after-send' ? t('wallpaperUnknown') : text === 'uncertain-subject' ? t('wallpaperUncertainReason') : text
    const pending = (value.counts.queued ?? 0) + (value.counts.downloading ?? 0) + (value.counts.planning ?? 0) + (value.counts.rendering ?? 0) + (value.counts.reviewing ?? 0) + (value.counts['technical-failed'] ?? 0)
    return <div className="vc-flow-node-body vc-wallpaper-node nodrag nopan nowheel">
      {!single && <div className="vc-stage-metrics"><div><span>{t('wallpaperTotal')}</span><strong>{value.total}</strong></div><div><span>{t(kind === 'downloading' ? 'wallpaperDownloadedCount' : kind === 'planning' ? 'wallpaperPlannedCount' : kind === 'rendering' ? 'wallpaperRenderedCount' : 'wallpaperReviewedCount')}</span><strong>{stage.done}</strong></div><div data-failed={stage.failed > 0 || undefined}><span>{t('wallpaperStepFailures')}</span><strong>{stage.failed}</strong></div>{stage.blocked > 0 && <div><span>{t('workflowStageBlockedCount')}</span><strong>{stage.blocked}</strong></div>}{kind === 'reviewing' && <div><span>{t('wallpaperFinalCount')}</span><strong>{value.counts.passed ?? 0}</strong></div>}</div>}
      {value.state.budgetStopped && <p className="vc-notice">{t('wallpaperBudget')}</p>}
      {value.warnings.includes('image-cancel-unconfirmed') && <p role="alert" className="vc-notice">{t('wallpaperCancelUnconfirmed')}</p>}
      {!single && <div className="vc-flow-image-pager"><ui.Button size="sm" variant="ghost" disabled={!control.offset || control.busy} onClick={() => control.page(control.offset - 1)}>{t('wallpaperPrevious')}</ui.Button><small>{t('wallpaperImage')} {control.offset + 1} / {value.total}</small><ui.Button size="sm" variant="ghost" disabled={control.offset + 1 >= value.total || control.busy} onClick={() => control.page(control.offset + 1)}>{t('wallpaperNext')}</ui.Button></div>}
      {kind !== 'downloading' && item && item.attempts.length > 1 && <SelectField label={t('wallpaperAttempt')} value={String(attempt?.revision)} options={item.attempts.map(row => ({ value: String(row.revision), label: `${t('wallpaperAttempt')} ${row.revision}` }))} onChange={revision => control.setRevision({ image: item.imageVersionId, revision: Number(revision) })} />}
      {ownIssue ? <section className="vc-stage-issue" role="alert"><div><ui.StateDot state={item?.errorCode ? 'error' : 'warning'} /><strong>{t('workflowStageFailure')}</strong></div><p>{failureMessage(item?.errorCode) || explanation(item?.reason) || t('wallpaperGeometryFailed')}</p>{item?.errorCode && <code>{item.errorCode}</code>}{item?.errorCode && item.reason && <ui.DisclosureRow icon={<ui.IconInfoOutlineRegular size={14} />} title={t('workflowStageDiagnostics')} open={diagnostics} expandable expandOnRowClick onToggle={() => setDiagnostics(current => !current)}><p className="vc-flow-muted">{item.reason}</p></ui.DisclosureRow>}</section> : blocked ? <div className="vc-stage-waiting"><ui.IconInfoOutlineRegular size={16} /><p>{t(stage.blocked > 0 ? 'workflowStepBlocked' : 'workflowStepWaiting')}</p></div> : null}
      {kind === 'downloading' ? <DownloadDetails control={control} t={t} single={single} /> : kind === 'planning' ? <>{attempt ? <><div className="vc-flow-node-badges"><ui.Tag tone="info">{t(modeKeys[attempt.plan.mode])}</ui.Tag></div><strong>{attempt.plan.subject}</strong><p>{attempt.plan.evidence}</p><small className="vc-flow-muted">{t('wallpaperInferred')}</small><Artifact path={path(attempt.analysisId)} label={t('wallpaperAnalysis')} control={control} /><ui.Button size="sm" variant="outline" disabled={control.busy || active(value.status) || attempt !== item?.attempts.at(-1)} onClick={control.editPlan}>{t('wallpaperEditPlan')}</ui.Button></> : !ownIssue && <p className="vc-flow-muted">{t('wallpaperIdle')}</p>}</> : kind === 'rendering' ? <>{planned && attempt && <><div className="vc-flow-node-badges"><ui.Tag tone={attempt.needsOutpaint ? 'info' : 'neutral'}>{t(attempt.needsOutpaint ? 'wallpaperOutpaint' : 'wallpaperCropOnly')}</ui.Tag><span className="vc-flow-muted">{t('wallpaperRound')} {attempt.revision}</span></div><div className="vc-flow-facts"><span>{t('wallpaperEditCount')} {item?.edits ?? 0} / {value.settings.maxEditsPerImage}</span></div></>}<Artifact path={path(attempt?.outputId)} label={t('wallpaperClean')} control={control} />{item?.status === 'passed' && attempt === item.attempts.at(-1) && attempt?.outputId && resource(path(attempt.outputId)) && <a className="vc-wallpaper-download" href={resource(path(attempt.outputId))} download="wallpaper-1845x3280.png">{t('wallpaperDownload')}</a>}</> : <><Artifact path={path(attempt?.simulationId)} label={t('wallpaperSimulation')} control={control} />{attempt?.review && <div className="vc-wallpaper-checks">{Object.entries(attempt.review.checks).map(([key, check]) => <div key={key}><ui.Tag tone={check.result === 'satisfied' ? 'success' : check.result === 'violated' ? 'warning' : 'neutral'}>{t(checkKeys[key as keyof typeof checkKeys])} · {t(check.result === 'satisfied' ? 'wallpaperSatisfied' : check.result === 'violated' ? 'wallpaperViolated' : 'wallpaperUnknownCheck')}</ui.Tag><small>{check.reason}</small></div>)}</div>}</>}
      {value.errorCode && kind === 'downloading' && !ownIssue && <p role="alert" className="vc-notice">{t('wallpaperTechnicalFailure')} <code>{value.errorCode}</code></p>}
      {(kind === 'downloading' || kind === 'reviewing' || ownIssue) && <div className="vc-flow-node-actions" aria-label={t('workflowStageControl')}>{active(value.status) ? <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={() => control.control('pause')}>{t('wallpaperPause')}</ui.Button> : ['paused', 'interrupted'].includes(value.status) ? <ui.Button size="sm" variant="primary" disabled={control.busy} onClick={() => control.control('resume')}>{t('wallpaperResume')}</ui.Button> : pending > 0 && <ui.Button size="sm" variant="outline" disabled={control.busy} onClick={control.continue}>{t('wallpaperContinue')}</ui.Button>}{!['completed', 'cancelled', 'failed'].includes(value.status) && <ui.Button size="sm" variant="ghost" disabled={control.busy} onClick={() => control.control('cancel')}>{t('wallpaperCancel')}</ui.Button>}<ui.Button size="sm" variant="ghost" disabled={control.busy} onClick={control.showExperience}>{t('wallpaperExperience')}</ui.Button></div>}
    </div>
  }

  function Dialogs({ control, t }: { control: Controller; t: WorkbenchText }) {
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
    const numberFields = [['topBuffer', 'wallpaperTopBuffer', 0, 256], ['sideOverflow', 'wallpaperSideOverflow', 0, 258], ['bottomOverflow', 'wallpaperBottomOverflow', 0, 562], ['maxReworks', 'wallpaperReworks', 0, 2], ['maxEditsPerImage', 'wallpaperMaxEdits', 0, 2]] as const
    const versionReason = (reason: string) => t(reason === 'benchmark-overlap' ? 'wallpaperOverlap' : reason === 'requires-new-generation' ? 'wallpaperNeedsGeneration' : reason === 'no-demonstrated-improvement' ? 'wallpaperNoImprovement' : reason === 'fixed-benchmarks-improved' ? 'wallpaperImproved' : 'wallpaperAwaitingBenchmarks')
    return <>
      <ui.Modal open={control.details !== null} onClose={() => control.setDetails(null)} title={control.details ? `${t('wallpaperImage')} ${control.offset + 1} · ${t(stepKeys[control.details])}` : ''} closeLabel={t('close')} className="vc-wallpaper-modal vc-image-details-modal">{control.details && <WallpaperNode kind={control.details} control={control} t={t} single />}</ui.Modal>
      <ui.Modal open={control.settingsOpen} onClose={() => control.setSettingsOpen(false)} title={t('wallpaperSettings')} closeLabel={t('close')} className="vc-wallpaper-modal"><p>{t('wallpaperSize')}</p><p className="vc-flow-muted">{t('wallpaperAllResults')} · {control.sourceCount}</p><div className="vc-wallpaper-fields">{numberFields.map(([key, label, min, max]) => <label key={key}><span>{t(label)}</span><input type="number" min={min} max={max} value={control.settings[key]} onChange={event => control.setSettings({ ...control.settings, [key]: Number(event.currentTarget.value) })} /></label>)}</div><label className="vc-wallpaper-field"><span>{t('wallpaperImageModel')}</span><SelectField label={t('wallpaperImageModel')} value={control.settings.imageModel} options={[{ value: '', label: t('wallpaperAutomaticModel') }, ...control.models.map(model => ({ value: model.id, label: model.name }))]} onChange={imageModel => control.setSettings({ ...control.settings, imageModel })} /></label>{!control.models.length && <p className="vc-flow-muted">{t('wallpaperNoImageModel')}</p>}{control.error && <p role="alert" className="vc-notice">{t('wallpaperInvalidSettings')}</p>}<div className="vc-wallpaper-dialog-actions"><ui.Button variant="outline" onClick={() => control.setSettingsOpen(false)}>{t('close')}</ui.Button><ui.Button variant="primary" disabled={control.busy} onClick={control.start}>{t('wallpaperStartBatch')}</ui.Button></div></ui.Modal>
      <ui.Modal open={control.planText !== null} onClose={() => control.setPlanText(null)} title={t('wallpaperEditPlan')} closeLabel={t('close')} className="vc-wallpaper-modal">
        <p>{t('wallpaperPlanHint')}</p>
        {editorPlan && editorSource && resource(editorSource.previewPath) && <PlanEditor key={`${control.value?.runId}:${editorPlan.imageVersionId}`} plan={editorPlan} settings={control.value!.settings} source={{ ...editorSource, previewPath: resource(editorSource.previewPath)! }} disabled={control.busy} onChange={plan => control.setPlanText(JSON.stringify(plan, null, 2))} t={t} />}
        <ui.DisclosureRow icon={<ui.IconCodeOutlineRegular size={14} />} title={t('wallpaperPlanJson')} open={!editorSource || sections.includes('plan-json')} expandable expandOnRowClick onToggle={() => toggleSection('plan-json')}>
          <label className="vc-wallpaper-field"><span>{t('wallpaperPlanJson')}</span><textarea rows={18} value={control.planText ?? ''} onChange={event => control.setPlanText(event.currentTarget.value)} /></label>
        </ui.DisclosureRow>
        {(planMessage || control.error) && <p role="alert" className="vc-notice">{t(planMessage ?? 'wallpaperInvalidPlan')}</p>}
        {editorPlan && !editorSource && !planMessage && <p role="status" className="vc-flow-muted">{t('wallpaperPlanUnchecked')}</p>}
        <div className="vc-wallpaper-dialog-actions"><ui.Button variant="outline" onClick={() => control.setPlanText(null)}>{t('close')}</ui.Button><ui.Button variant="primary" disabled={control.busy || !editorPlan || !!planMessage} onClick={control.applyPlan}>{t('wallpaperApplyPlan')}</ui.Button></div>
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
  return { useWallpaper, WallpaperNode, PlanningImageCard, ImageNavigator, ImageStepCard, Dialogs }
}
