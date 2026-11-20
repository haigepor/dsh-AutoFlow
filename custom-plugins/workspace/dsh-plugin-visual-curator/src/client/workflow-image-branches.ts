/** Planning cards share one bounded page; immutable image identities survive navigation and task continuation. */
import { wallpaperAttemptReview, wallpaperCanProcessNative, wallpaperFailedStep, wallpaperVerdict, type WallpaperItem } from '../shared/wallpaper.ts'
import type { WorkflowPhase } from './workflow-node-state.ts'
import type { WallpaperStep } from './workflow-node-state.ts'
import { wallpaperCanDecide } from './wallpaper-recovery.ts'

/** One column stays readable while the remaining images remain in paged groups. */
export const planningImagesPerPage = 4

/** The thumbnail directory is bounded independently from the single full-resolution plan read. */
export const imageNavigationPageSize = 12

/** Fixed presentation steps reuse saved processing evidence without creating additional work. */
export const imageWorkflowStages = [
  { stage: 'original', kind: 'downloading', title: 'wallpaperStageOriginal' },
  { stage: 'planning', kind: 'planning', title: 'wallpaperPlanning' },
  { stage: 'geometry', kind: 'planning', title: 'wallpaperStageGeometry' },
  { stage: 'rendering', kind: 'rendering', title: 'wallpaperStageRendering' },
  { stage: 'clarity', kind: 'rendering', title: 'wallpaperClarity' },
  { stage: 'reviewing', kind: 'reviewing', title: 'wallpaperStageReview' },
  { stage: 'final', kind: 'reviewing', title: 'wallpaperStageFinal' },
] as const

/** Native detail inspection and routing appear only when the current image needs them. */
export const imageWorkflowPresentationStages = [...imageWorkflowStages.slice(0, 3), { stage: 'detail', kind: 'planning', title: 'directCropReinspect' } as const, { stage: 'decision', kind: 'decision', title: 'wallpaperDecision' } as const, ...imageWorkflowStages.slice(3)]

/** New generated canvases review native pixels before optional reconstruction; earlier saved revisions retain their original display order. */
function presentationOrder(attempt: WallpaperItem['attempts'][number] | undefined) {
  if (!attempt?.generationBrief && !attempt?.preResolutionReview) return imageWorkflowPresentationStages
  const ordered = [...imageWorkflowPresentationStages]
  const clarity = ordered.findIndex(step => step.stage === 'clarity'), review = ordered.findIndex(step => step.stage === 'reviewing')
  ;[ordered[clarity], ordered[review]] = [ordered[review]!, ordered[clarity]!]
  return ordered
}

/** A presentation step can share processing evidence with another step. */
export type ImageWorkflowStage = typeof imageWorkflowPresentationStages[number]['stage']

/** @param item Selected image. @param attempt Displayed plan revision. @returns The native inspection submitted for this revision or its inherited, completed evidence. */
export function imageWorkflowDetail(item: WallpaperItem | undefined, attempt = item?.attempts.at(-1)): WallpaperItem['detailInspection'] {
  if (!item || !attempt) return undefined
  const inspection = item.detailInspection, detail = attempt.detailAnalysis
  if (inspection && (inspection.planRevision === attempt.revision || inspection.requestId === detail?.requestId)) return inspection
  if (detail) return { origin: 'planning', status: detail.outcome, planRevision: attempt.revision, requestId: detail.requestId }
  return undefined
}

/** @param item Selected source. @param attempt Displayed plan. @returns The last decision bound to this input or its resulting version, never a later revision's decision. */
export function imageWorkflowDecisionRecord(item: WallpaperItem | undefined, attempt = item?.attempts.at(-1)) {
  if (!attempt) return undefined
  const inspection = imageWorkflowDetail(item, attempt)
  return item?.decisions?.findLast(record => (record.planRevision === attempt.revision || record.targetRevision === attempt.revision || inspection?.decisionId === record.id) && (inspection?.origin !== 'manual' || record.round > (inspection.decisionRoundAtStart ?? 0)))
}

function decisionHoldsProcessing(item: WallpaperItem | undefined, attempt = item?.attempts.at(-1)) {
  const record = imageWorkflowDecisionRecord(item, attempt)
  return !!item && item.status !== 'passed' && (attempt === item.attempts.at(-1) && item.reason === 'decision-round-limit' || !!record && ['running', 'manual', 'failed', 'skipped'].includes(record.status))
}

/** Derive clarity only from saved enhancement work or this output's independent quality check.
 * @param attempt Displayed immutable output revision.
 * @returns Recorded clarity evidence; absent checks never imply completion.
 */
export function imageWorkflowClarity(attempt: WallpaperItem['attempts'][number] | undefined): WallpaperItem['attempts'][number]['clarity'] {
  if (attempt?.generationBrief && !attempt.preResolutionReview) return attempt.clarity
  if (attempt?.preResolutionReview) {
    const resolution = attempt.backgroundResolution
    return resolution ? { status: resolution.status === 'enhancing' ? 'enhancing' : resolution.status === 'passed' ? 'passed' : resolution.status === 'failed' ? 'failed' : 'reviewing', reason: resolution.reason } : attempt.preResolutionReview.finalId ? { status: 'not-needed', reason: '' } : { status: 'pending', reason: '' }
  }
  const check = attempt?.review && 'clarity' in attempt.review.checks ? attempt.review.checks.clarity : undefined
  if (check) return { ...attempt?.clarity, status: check.result === 'satisfied' ? attempt?.clarity?.enhancedOutputId || attempt?.backgroundResolution?.enhancedId ? 'passed' : 'not-needed' : 'needs-review', reason: check.reason }
  if (attempt?.clarity) return attempt.clarity
  const resolution = attempt?.backgroundResolution
  return resolution ? { status: resolution.status === 'enhancing' ? 'enhancing' : resolution.status === 'needs-review' ? 'needs-review' : 'reviewing', reason: resolution.reason } : undefined
}

/** @param stage Visible processing step. @param item Saved image evidence. @param status Owning lifecycle. @param attempt Selected plan revision. @returns Clarity stays unexecuted for history with no recorded check. */
export function imageWorkflowStagePhase(stage: ImageWorkflowStage, item: WallpaperItem, status: string, attempt = item.attempts.at(-1)): WorkflowPhase {
  if (item.status === 'cancelled' && attempt === item.attempts.at(-1)) status = 'cancelled'
  if (stage === 'detail') {
    const inspection = imageWorkflowDetail(item, attempt)
    if (!inspection) return 'idle'
    if (inspection.status === 'resolved' || inspection.status === 'ready-for-edit') return 'completed'
    if (inspection.status === 'failed') return 'failed'
    if (inspection.status !== 'queued' && inspection.status !== 'running') return 'attention'
    if (status === 'cancelled' || status === 'failed') return status
    if (status === 'paused' || status === 'interrupted') return 'paused'
    if (status === 'completed') return 'attention'
    return inspection.status
  }
  if (stage === 'decision') {
    const record = imageWorkflowDecisionRecord(item, attempt)
    if (status === 'cancelled' && record?.status !== 'applied') return 'cancelled'
    const routedInspection = !!record && imageWorkflowDetail(item, attempt)?.decisionId === record.id
    if (!routedInspection && attempt === item.attempts.at(-1) && item.reason === 'decision-round-limit') return 'attention'
    if (!record) return wallpaperCanDecide(item, attempt) ? 'attention' : 'queued'
    if (record.status === 'running') return ['paused', 'interrupted'].includes(status) ? 'paused' : ['created', 'running', 'pausing', 'cancelling'].includes(status) ? 'running' : 'attention'
    return record.status === 'applied' ? 'completed' : record.status === 'failed' ? 'failed' : 'attention'
  }
  if (stage !== 'clarity') {
    if (!imageWorkflowStageReached(stage, item, attempt)) return 'blocked'
    const inspection = imageWorkflowDetail(item, attempt)
    if ((stage === 'planning' || stage === 'geometry') && inspection && (inspection.status === 'running' || inspection.status === 'queued' || inspection.status === 'failed' && item.failedStep === 'planning')) return 'completed'
    if ((stage === 'planning' || stage === 'geometry') && decisionHoldsProcessing(item, attempt)) return planningImagePhase(item, status)
    if (stage === 'final') return item.status === 'passed' && attempt === item.attempts.at(-1) ? 'completed' : 'blocked'
    return imageWorkflowPhase(imageWorkflowStages.find(step => step.stage === stage)!.kind, item, status, attempt)
  }
  const clarity = imageWorkflowClarity(attempt)
  if (!clarity) return 'idle'
  if (clarity.status === 'not-needed' || clarity.status === 'passed') return 'completed'
  if (status === 'cancelled' && attempt === item.attempts.at(-1)) return 'cancelled'
  if (clarity.status === 'failed') return 'failed'
  if (clarity.status === 'needs-review') return 'attention'
  if (decisionHoldsProcessing(item, attempt)) return 'queued'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'paused' || status === 'interrupted') return 'paused'
  return ['running', 'pausing', 'cancelling'].includes(status) && (item.status === 'reviewing' || clarity.status === 'enhancing') ? 'running' : 'queued'
}

/** Show steps only after execution or saved evidence reaches them.
 * @param stage Presentation step. @param item Selected source. @param attempt Displayed saved revision.
 * @returns Whether this step has begun; failures remain visible and future steps stay absent.
 */
export function imageWorkflowStageReached(stage: ImageWorkflowStage, item: WallpaperItem | undefined, attempt = item?.attempts.at(-1)): boolean {
  if (stage === 'detail') return !!imageWorkflowDetail(item, attempt)
  if (stage === 'decision') return !!imageWorkflowDecisionRecord(item, attempt)
  if (stage === 'original') return true
  if (!item) return false
  const failed = wallpaperFailedStep(item)
  if (stage === 'planning') return !!attempt || item.status === 'planning' || failed === 'planning'
  if (stage === 'geometry') return !!attempt
  if (stage === 'rendering') return !!attempt && (!!attempt.canvasId || !!attempt.generation || !!attempt.outputId || !!attempt.nativeReviewCandidate || item.status === 'rendering' || failed === 'rendering')
  if (stage === 'clarity') return wallpaperCanProcessNative(attempt) || !!imageWorkflowClarity(attempt) && !attempt?.preResolutionReview
  if (stage === 'reviewing') return !!attempt && (!!attempt.review || !!attempt.simulationId || !!attempt.nativeReviewCandidate || item.status === 'reviewing' || failed === 'reviewing')
  const review = wallpaperAttemptReview(attempt)
  return !!attempt?.outputId && !!review && wallpaperVerdict(review) === 'pass' && (!attempt.preResolutionReview || attempt.preResolutionReview.finalId === attempt.outputId)
}

/** Stage images stay bound to their own inputs and outputs as later processing completes.
 * @param stage Displayed step. @param item Selected source. @param attempt Displayed revision.
 * @returns A saved image identity, independent of later review overlays.
 */
export function imageWorkflowArtifact(stage: ImageWorkflowStage, item: WallpaperItem, attempt = item.attempts.at(-1)): string | undefined {
  if (stage === 'decision' || stage === 'detail') return item.originalId
  if (stage === 'original' || stage === 'planning') return item.originalId
  if (stage === 'geometry') return attempt?.layoutAnalysisId ?? attempt?.canvasId ?? (!attempt?.outputId && !attempt?.generation ? attempt?.analysisId : undefined)
  if (stage === 'rendering') return attempt?.preResolutionReview?.nativeId ?? attempt?.nativeReviewCandidate?.nativeId ?? attempt?.clarity?.originalOutputId ?? attempt?.outputId ?? attempt?.backgroundResolution?.originalId ?? attempt?.generatedImageId
  if (stage === 'clarity') return attempt?.preResolutionReview ? attempt.backgroundResolution?.enhancedId ?? attempt.preResolutionReview.nativeId : attempt?.clarity?.enhancedOutputId ?? attempt?.clarity?.originalOutputId ?? attempt?.outputId ?? attempt?.backgroundResolution?.enhancedId ?? attempt?.backgroundResolution?.originalId ?? attempt?.generatedImageId
  if (stage === 'reviewing') return attempt?.simulationId
  return attempt?.outputId
}

/** Saved stage views retain their own revision and reviewed pixels, including stopped failures.
 * @param stage Displayed stage. @param item Source and version history. @param attempt Selected revision.
 * @param includeNative Include native and delivered images together in selected-version history.
 * @returns Ordered image slides; annotations never reuse coordinates from another candidate.
 */
export function imageWorkflowGallery(stage: ImageWorkflowStage, item: WallpaperItem, attempt = item.attempts.at(-1), includeNative = false) {
  const slides: { id: string; label: 'wallpaperFramingAnnotation' | 'wallpaperFramingOriginalAnnotation' | 'wallpaperFramingDetail' | 'wallpaperSource' | 'wallpaperAnalysis' | 'wallpaperReviewAnalysis' | 'wallpaperClean' | 'wallpaperSimulation' | 'wallpaperClarityBaseline' | 'wallpaperClarityEnhanced' | 'directCropPreviousReview' | 'wallpaperNativeCandidate' | 'wallpaperFinalOutput' | 'wallpaperNativeAnalysis' | 'wallpaperFinalAnalysis' | 'wallpaperNativeSimulation' | 'wallpaperFinalSimulation'; attempt: typeof attempt; annotated: boolean }[] = []
  const add = (id: string | undefined, label: typeof slides[number]['label'], row = attempt, annotated = false) => {
    if (id && !slides.some(slide => slide.id === id && slide.annotated === annotated)) slides.push({ id, label, attempt: label === 'wallpaperSource' ? undefined : row, annotated })
  }
  const review = (row: typeof attempt, previous = false) => {
    if (!row) return
    const final = row.postResolutionReview
    if (final) {
      add(final.imageVersionId, 'wallpaperFinalAnalysis', row, true)
      add(final.imageVersionId, 'wallpaperFinalOutput', row)
      add(final.simulationId, 'wallpaperFinalSimulation', row)
      if (!includeNative) return
    }
    const actual = row.review && 'actualLayout' in row.review ? row.review.actualLayout.imageVersionId : undefined
    const id = actual && [row.nativeReviewCandidate?.nativeId, row.preResolutionReview?.nativeId, row.outputId].includes(actual) ? actual : row.nativeReviewCandidate?.nativeId ?? row.preResolutionReview?.nativeId ?? row.outputId
    const annotatedId = !row.review || actual === id ? id : undefined
    const native = !!(row.nativeReviewCandidate || row.preResolutionReview)
    add(annotatedId ?? row.analysisId, previous ? 'directCropPreviousReview' : native ? 'wallpaperNativeAnalysis' : 'wallpaperReviewAnalysis', row, !!annotatedId)
    add(id, native ? 'wallpaperNativeCandidate' : 'wallpaperFinalOutput', row)
    add(row.simulationId ?? row.nativeReviewCandidate?.simulationId, native ? 'wallpaperNativeSimulation' : 'wallpaperSimulation', row)
    if (includeNative && row.preResolutionReview?.finalId === row.outputId) add(row.outputId, 'wallpaperFinalOutput', row)
  }
  if (stage === 'reviewing' || stage === 'decision') review(attempt)
  else if (stage === 'clarity') {
    add(attempt?.clarity?.originalOutputId ?? attempt?.backgroundResolution?.originalId ?? attempt?.preResolutionReview?.nativeId, 'wallpaperClarityBaseline')
    add(attempt?.clarity?.enhancedOutputId ?? attempt?.backgroundResolution?.enhancedId, 'wallpaperClarityEnhanced')
  } else add(imageWorkflowArtifact(stage, item, attempt), stage === 'original' || stage === 'planning' || stage === 'detail' ? 'wallpaperSource' : stage === 'geometry' ? 'wallpaperAnalysis' : stage === 'rendering' && !!(attempt?.nativeReviewCandidate || attempt?.preResolutionReview) ? 'wallpaperNativeCandidate' : 'wallpaperFinalOutput')
  if (stage === 'geometry' || stage === 'planning' || stage === 'detail') add(attempt?.layoutAnalysisId ?? attempt?.canvasId, 'wallpaperAnalysis')
  if (item.framingConflict && (!attempt && stage === 'planning' || stage === 'detail')) {
    add(item.framingConflict.inspection?.analysisId ?? item.framingConflict.analysisId, 'wallpaperFramingAnnotation')
    if (stage === 'detail') {
      if (item.framingConflict.inspection?.analysisId) add(item.framingConflict.analysisId, 'wallpaperFramingOriginalAnnotation')
      for (const id of item.framingConflict.inspection?.detailIds ?? []) add(id, 'wallpaperFramingDetail')
    }
  }
  if (stage === 'final' && includeNative) review(attempt)
  if (stage === 'decision' || stage === 'detail') add(item.originalId, 'wallpaperSource')
  return slides
}

/** Keep failed review evidence beside the version being repaired until its new review commits.
 * @param item Selected image. @param attempt Displayed current version.
 * @returns The preceding failed review, or absence for ordinary progression and explicit history.
 */
export function imageWorkflowPreviousReview(item: WallpaperItem | undefined, attempt = item?.attempts.at(-1)) {
  if (!item || !attempt || attempt !== item.attempts.at(-1) || wallpaperAttemptReview(attempt) || item.status === 'technical-failed' && wallpaperFailedStep(item) === 'reviewing') return undefined
  return item.attempts.findLast(prior => { const review = wallpaperAttemptReview(prior); return prior.revision < attempt.revision && review && wallpaperVerdict(review) !== 'pass' })
}

/** A return path represents a new accepted generation after review.
 * @param item Selected image evidence. @param status Owning task lifecycle. @param attempt Displayed version.
 * @returns Return-path stage, lifecycle and motion, or absence when this image has not entered rework.
 */
export function imageWorkflowRework(item: WallpaperItem | undefined, status: string, attempt = item?.attempts.at(-1)): { stage: 'rendering' | 'reviewing' | 'passed'; phase: WorkflowPhase; flowing: boolean } | undefined {
  if (!item || !attempt?.generation || attempt.retryTarget === 'reviewing') return undefined
  const preceding = item.attempts.filter(prior => prior.revision < attempt.revision)
  if (!preceding.length || preceding.some(prior => prior.generation?.id === attempt.generation?.id || !!attempt.outputId && prior.outputId === attempt.outputId)) return undefined
  const current = attempt === item.attempts.at(-1)
  const review = wallpaperAttemptReview(attempt), rejected = !!review && wallpaperVerdict(review) !== 'pass'
  const precedingRejection = preceding.some(prior => { const review = wallpaperAttemptReview(prior); return review && wallpaperVerdict(review) === 'reject' })
  if (!precedingRejection && attempt.retryFrom !== 'reviewing') return undefined
  if (review && wallpaperVerdict(review) === 'pass' && (!current || item.status === 'passed')) return { stage: 'passed', phase: 'completed', flowing: false }
  if ((status === 'cancelled' || item.status === 'cancelled') && current) return { stage: attempt.outputId ? 'reviewing' : 'rendering', phase: 'cancelled', flowing: false }
  const active = current && ['created', 'running', 'pausing', 'cancelling'].includes(status)
  if (current && item.status === 'reviewing' && attempt.boundaryReview?.status === 'pending') {
    const phase = imageWorkflowPhase('reviewing', item, status, attempt)
    return { stage: 'reviewing', phase, flowing: phase === 'running' }
  }
  if (rejected || !attempt.outputId || current && item.status === 'rendering') {
    const flowing = active && item.status === 'rendering'
    return { stage: 'rendering', phase: flowing ? 'running' : current && ['paused', 'interrupted'].includes(status) ? 'paused' : 'attention', flowing }
  }
  const phase = imageWorkflowPhase('reviewing', item, status, attempt)
  return { stage: 'reviewing', phase, flowing: phase === 'running' }
}

/** Retain reached stages and preview only the next consumer; repairs retain the preceding failed review.
 * @param item Selected source. @param attempt Displayed revision. @param inspected Explicit historical step.
 * @returns Progressive stage history plus the current step and its immediate successor.
 */
export function imageWorkflowWindow(item: WallpaperItem | undefined, attempt = item?.attempts.at(-1), inspected?: ImageWorkflowStage) {
  const boundaryPending = attempt?.boundaryReview?.status === 'pending'
  const review = wallpaperAttemptReview(attempt), failedReview = review && !boundaryPending && wallpaperVerdict(review) !== 'pass'
  const repairing = item && attempt === item.attempts.at(-1) && item.attempts.some(prior => { const review = wallpaperAttemptReview(prior); return prior.revision < (attempt?.revision ?? 0) && review && wallpaperVerdict(review) !== 'pass' }) && (['rendering', 'reviewing'].includes(item.status) || item.status === 'technical-failed' && wallpaperFailedStep(item) === 'reviewing')
  const repair = !inspected && !boundaryPending && (failedReview || repairing || imageWorkflowPreviousReview(item, attempt))
  const failed = item && wallpaperFailedStep(item)
  const newOrder = !!attempt?.generationBrief || !!attempt?.preResolutionReview
  const current: ImageWorkflowStage = !item?.originalId || failed === 'downloading' ? 'original'
    : failed === 'planning' || item.status === 'planning' || !attempt || attempt.checks.length || attempt.plan.mode === 'uncertain' ? 'planning'
    : item.status === 'reviewing' && boundaryPending || attempt.postResolutionReview && item.status !== 'passed' ? 'reviewing'
    : wallpaperCanProcessNative(attempt) && !attempt.preResolutionReview.finalId ? 'clarity'
    : attempt.clarity?.originalOutputId && !['not-needed', 'passed'].includes(attempt.clarity.status) ? 'clarity'
    : item.status === 'reviewing' && attempt.simulationId && !review ? 'reviewing'
    : failed === 'rendering' || item.status === 'rendering' && !attempt.preResolutionReview || !attempt.outputId && !attempt.preResolutionReview ? 'rendering'
    : !review || wallpaperVerdict(review) !== 'pass' ? 'reviewing' : 'final'
  const record = imageWorkflowDecisionRecord(item, attempt), limited = attempt === item?.attempts.at(-1) && item?.reason === 'decision-round-limit'
  const detail = imageWorkflowDetail(item, attempt)
  const inspecting = detail?.status === 'queued' || detail?.status === 'running'
  const manualDetail = detail?.origin === 'manual' && !record
  const deciding = !inspecting && !manualDetail && (decisionHoldsProcessing(item, attempt) || wallpaperCanDecide(item, attempt))
  const selected = inspected ?? (inspecting || manualDetail && detail.status !== 'resolved' && detail.status !== 'ready-for-edit' ? 'detail' : deciding ? 'decision' : repair ? 'rendering' : current)
  const ordered = newOrder ? presentationOrder(attempt).filter(step => !['detail', 'decision'].includes(step.stage)) : imageWorkflowStages
  const next = selected === 'decision' ? limited ? undefined : record?.targetStage : selected === 'detail' ? undefined : ordered[ordered.findIndex(step => step.stage === selected) + 1]?.stage
  const decision = !!record || !inspecting && !manualDetail && (wallpaperCanDecide(item, attempt) || limited)
  const stages = presentationOrder(attempt).filter(step => step.stage === 'decision' ? decision : imageWorkflowStageReached(step.stage, item, attempt) || step.stage === selected || step.stage === next || !!repair && step.stage === 'reviewing')
  if (detail?.origin === 'decision' && record && detail.decisionId === record.id) {
    const detailIndex = stages.findIndex(step => step.stage === 'detail'), decisionIndex = stages.findIndex(step => step.stage === 'decision')
    if (detailIndex >= 0 && decisionIndex > detailIndex) {
      const [node] = stages.splice(detailIndex, 1)
      stages.splice(decisionIndex, 0, node!)
    }
  }
  return stages
}

/** Connect the displayed stages through the actual decision destination.
 * @param stages Visible stages in layout order. @param item Selected image. @param attempt Displayed plan.
 * @returns Directed stage connections; a stopped decision has no outgoing connection.
 */
export function imageWorkflowConnections(stages: ImageWorkflowStage[], item: WallpaperItem | undefined, attempt = item?.attempts.at(-1)) {
  const record = imageWorkflowDecisionRecord(item, attempt)
  const connections: { source: ImageWorkflowStage; target: ImageWorkflowStage }[] = []
  for (let index = 1; index < stages.length; index++) {
    const source = stages[index - 1]!, target = stages[index]!
    if (source !== 'decision') connections.push({ source, target })
  }
  const inspection = imageWorkflowDetail(item, attempt)
  if (record && stages.includes('decision') && inspection?.origin === 'decision' && inspection.decisionId === record.id && stages.includes('detail')) {
    connections.push({ source: 'decision', target: 'detail' })
  } else {
    const target = record?.targetStage
    if (stages.includes('decision') && item?.reason !== 'decision-round-limit' && record?.status === 'applied' && (record.targetRevision === undefined || record.targetRevision === attempt?.revision) && target && target !== 'decision' && stages.includes(target)) connections.push({ source: 'decision', target })
  }
  return connections
}

/** @param lane Batch layout identity. @param stage Presentation step. @returns An identity independent of the selected image. */
export function fixedImageWorkflowNodeId(lane: string, stage: ImageWorkflowStage): string {
  const step = imageWorkflowPresentationStages.find(entry => entry.stage === stage)!
  return `${lane}:image-step:${stage}:${step.kind}`
}

/** @param lane Stable batch identity. @param imageId Immutable source identity. @param kind Image processing step. @returns A step identity that cannot collide with another image or stage. */
export function imageWorkflowNodeId(lane: string, imageId: string, kind: WallpaperStep): string {
  return `${planningImageNodeId(lane, imageId)}:${kind}`
}

/** @param kind Image processing step. @param item Saved image evidence. @param status Owning task lifecycle. @param attempt Selected saved revision; absence uses the latest. @returns This image's stage status without another image's aggregate progress. */
export function imageWorkflowPhase(kind: WallpaperStep, item: WallpaperItem, status: string, attempt = item.attempts.at(-1)): WorkflowPhase {
  if (item.status === 'cancelled' && attempt === item.attempts.at(-1)) {
    if (kind === 'downloading' && item.originalId || kind === 'planning' && attempt && !attempt.checks.length && attempt.plan.mode !== 'uncertain' || kind === 'rendering' && attempt?.outputId) return 'completed'
    return 'cancelled'
  }
  const latest = attempt === item.attempts.at(-1), failed = latest ? wallpaperFailedStep(item) : undefined
  if (status === 'cancelled' && latest && item.status !== 'passed' && (failed === kind || item.status === kind)) return 'cancelled'
  if (failed === kind) return item.errorCode ? 'failed' : 'attention'
  if (kind === 'downloading' && item.originalId) return 'completed'
  if (kind === 'planning') return planningImagePhase(latest ? item : { ...item, attempts: attempt ? [attempt] : [] }, latest ? status : 'completed')
  if (kind === 'rendering' && (attempt?.outputId || attempt?.preResolutionReview || attempt?.nativeReviewCandidate)) return 'completed'
  if (latest && kind === 'rendering' && item.status === 'needs-review' && attempt?.generation && !attempt.outputId) return 'attention'
  if (latest && kind === 'reviewing' && item.status === 'reviewing' && attempt?.boundaryReview?.status === 'pending') return ['paused', 'interrupted'].includes(status) ? 'paused' : ['created', 'running', 'pausing', 'cancelling'].includes(status) ? 'running' : status === 'cancelled' ? 'cancelled' : 'attention'
  if (kind === 'reviewing' && attempt?.postResolutionReview && !attempt.postResolutionReview.review) return latest && item.status === 'reviewing' && ['created', 'running', 'pausing', 'cancelling'].includes(status) ? 'running' : ['paused', 'interrupted'].includes(status) ? 'paused' : 'attention'
  const effectiveReview = wallpaperAttemptReview(attempt)
  if (kind === 'reviewing' && effectiveReview) return wallpaperVerdict(effectiveReview) === 'pass' ? 'completed' : 'attention'
  if (latest && kind === 'reviewing' && item.status === 'needs-review' && attempt?.nativeReviewCandidate) return 'attention'
  if (kind !== 'downloading' && !item.originalId || kind === 'rendering' && (!attempt || attempt.checks.length > 0 || attempt.plan.mode === 'uncertain') || kind === 'reviewing' && !attempt?.outputId && !attempt?.simulationId) return 'blocked'
  if (latest && item.status === kind) {
    if (['created', 'running', 'pausing', 'cancelling'].includes(status)) return 'running'
    if (['paused', 'interrupted'].includes(status)) return 'paused'
  }
  return status === 'cancelled' ? 'cancelled' : 'queued'
}

/** @param offset Selected absolute image index. @param pageSize Active page size. @returns First image index of the shared request window. */
export function planningWindowStart(offset: number, pageSize: number): number {
  return Math.floor(offset / pageSize) * pageSize
}

/** @param lane Stable batch identity. @param imageId Immutable source identity. @returns A node identity independent of its group or position. */
export function planningImageNodeId(lane: string, imageId: string): string {
  const bytes = new TextEncoder().encode(imageId), encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `${lane}:planning-image:${encoded}`
}

/** @param id Canvas node identity. @returns Its parent batch when this is an image card. */
export function planningImageLane(id: string): string | undefined {
  const at = id.lastIndexOf(':planning-image:')
  return at > 0 ? id.slice(0, at) : undefined
}

/** @param item Saved per-image evidence. @param status Owning task lifecycle. @returns Planning state, independent of later rendering or review failures. */
export function planningImagePhase(item: WallpaperItem, status: string): WorkflowPhase {
  if (item.status === 'cancelled') return 'cancelled'
  const attempt = item.attempts.at(-1)
  if (wallpaperFailedStep(item) === 'downloading') return 'blocked'
  if (decisionHoldsProcessing(item, attempt)) {
    const unresolved = attempt?.checks.length || attempt?.plan.mode === 'uncertain' || attempt?.plan.uncertainties.length
    return unresolved ? status === 'cancelled' ? 'cancelled' : 'attention' : attempt ? 'completed' : status === 'cancelled' ? 'cancelled' : 'queued'
  }
  if (status === 'cancelled' && (wallpaperFailedStep(item) === 'planning' || attempt?.checks.length || attempt?.plan.mode === 'uncertain')) return 'cancelled'
  if (item.status === 'planning' && ['created', 'running', 'pausing', 'cancelling'].includes(status)) return 'running'
  if (item.status === 'planning' && ['paused', 'interrupted'].includes(status)) return 'paused'
  if (wallpaperFailedStep(item) === 'planning') return item.errorCode ? 'failed' : 'attention'
  if (attempt?.checks.length || attempt?.plan.mode === 'uncertain') return 'attention'
  if (attempt) return 'completed'
  if (status === 'cancelled') return 'cancelled'
  return item.originalId ? 'queued' : 'blocked'
}
