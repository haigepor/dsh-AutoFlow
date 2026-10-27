/** Safe browser projections derive permissions and feedback context from committed records. */
import type { CuratorDomain } from '../domain/curator.ts'
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import { analysisReferenceDigest } from '../domain/style-analysis.ts'
import { styleAnalysisOf, type StyleAnalysis } from '../shared/style-analysis.ts'
import { ModelProfiles } from '../domain/model-profile.ts'
import { dimensionSchema, styleStandardSchema, type DomainActor, type HumanFeedback, type ImageVersion, type Reference, type RunRecord, type Rule } from '../shared/model.ts'
import { executionStandard } from './style-execution.ts'
import { styleMatchSchema } from '../shared/style-matching.ts'
import { CuratorError } from '../shared/errors.ts'
import type { ConfigurationView, CuratorSnapshot, FeedbackView, ImageView, RuleView, RunView, StyleView, StyleAnalysisView } from '../client/contract.ts'
import { configRevision, type CuratorConfig } from './config.ts'
import { dataOf, rankedSelections, specOf, type RunEngine } from './runtime.ts'
import type { AnalysisTask } from '../shared/analysis-process.ts'

/** @param config Current defaults. @param credentialStatus Presence only, never secret values. @returns Lightweight settings projection. */
export function projectConfiguration(config: CuratorConfig, credentialStatus: { source: boolean; vision: boolean }): ConfigurationView {
  const { reasoningEffort, ...vision } = config.vision
  return { revision: configRevision(config), sourceConfigured: config.source.provider === 'unsplash' ? credentialStatus.source : !!config.source.endpoint && (!config.source.credentialRef || credentialStatus.source),
    visionConfigured: !!config.vision.model && config.vision.supportsMultipleImages && config.vision.supportsJson && (config.vision.backend === 'native' || config.vision.provider && config.vision.backend !== 'compatible' ? !!config.vision.provider : !!config.vision.endpoint && (!config.vision.credentialRef || credentialStatus.vision)),
    sourceCredentialConfigured: credentialStatus.source, visionCredentialConfigured: credentialStatus.vision, source: config.source, vision: { ...vision, ...(reasoningEffort ? { reasoningEffort } : {}) }, limits: config.limits }
}

/** @param domain Saved collections. @param engine Task owner. @param actor Authenticated reader. @returns Authorized task summaries without image projection. */
export function projectAnalysisTasks(domain: CuratorDomain, engine: RunEngine, actor: DomainActor): AnalysisTask[] {
  return domain.repository.list('run').filter(run => canReadRun(domain, run, actor) && specOf(run).kind === 'analyze').map(run => {
    const spec = specOf(run), data = dataOf(run), styleId = String(spec.input.styleId), process = engine.process(run)
    return { runId: run.id, styleId, name: domain.require('style', styleId).name, status: run.status, observed: data.counts.observed ?? 0,
      total: Array.isArray(spec.fixed.references) ? spec.fixed.references.length : 0, model: spec.config.vision.model, reasoningEffort: spec.config.vision.reasoningEffort ?? null,
      attempts: data.attempts, startedAt: run.createdAt, phase: process?.phase ?? (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status) ? run.status as 'completed' | 'failed' | 'cancelled' | 'interrupted' : 'queued'), autoResume: data.autoResume === true, ...(run.outcome ? { outcome: run.outcome } : {}), ...(data.error ? { error: data.error } : {}) }
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

function ruleView(rule: Rule): RuleView {
  return { ruleId: rule.ruleId, dimension: rule.dimension, statement: rule.statement, strength: rule.strength,
    stage: rule.stage, confirmed: rule.confirmation.status === 'confirmed', condition: rule.condition.subjects?.join(', ') ?? '',
    exceptions: rule.exceptions.map(condition => condition.subjects?.join(', ') ?? condition.usageRevisionIds?.join(', ') ?? ''),
    supportRefs: rule.supportRefs, counterRefs: rule.counterRefs }
}

function sampleViews(domain: CuratorDomain, analysis: StyleAnalysis, actor: DomainActor, familyStatuses: ReadonlyMap<string, boolean>): StyleAnalysisView['samples'] {
  return analysis.samples.map(sample => {
    const { asset } = domain.authorizedImage(sample.reference.imageVersionId, actor), observation = domain.require('observation', sample.observationId)
    return { referenceId: sample.reference.id, imageVersionId: sample.reference.imageVersionId, familyId: asset.familyId, digest: sample.imageDigest, role: sample.reference.role,
      intent: sample.reference.intent.kind, dimensions: sample.reference.intent.kind === 'dimensions' ? sample.reference.intent.dimensions : [],
      image: imageView(domain, domain.require('imageVersion', sample.reference.imageVersionId), actor, sample.reference, undefined, familyStatuses),
      observations: observation.inferred.map(row => ({ dimension: row.field, description: typeof row.value === 'string' ? row.value : JSON.stringify(row.value), uncertain: row.uncertain, requestId: row.requestId })) }
  })
}

function canReadRun(domain: CuratorDomain, run: RunRecord, actor: DomainActor): boolean {
  if (run.profileId !== actor.profileId) return false
  return run.owner.kind === 'profile' ? actor.kind === 'human' : run.owner.sessionId === actor.sessionId
}

function readableImage(domain: CuratorDomain, image: ImageVersion, actor: DomainActor): boolean {
  try { domain.authorizedImage(image.id, actor); return true }
  catch (error) { if (error instanceof CuratorError && error.code === 'owner-denied') return false; throw error }
}

function feedbackValue(feedback: HumanFeedback): string {
  switch (feedback.judgment.kind) {
    case 'observation-correction': return String(feedback.judgment.correctedValue)
    case 'rule-suggestion': return feedback.judgment.proposedRule.statement
    default: return feedback.judgment.value
  }
}
function feedbackView(feedback: HumanFeedback): FeedbackView {
  return { feedbackId: feedback.id, kind: feedback.judgment.kind, value: feedbackValue(feedback), scope: feedback.scope,
    dimensions: feedback.judgment.kind === 'dimension-verdict' ? [feedback.judgment.dimension] : [], comment: feedback.comment ?? '', createdAt: feedback.createdAt }
}

function imageView(domain: CuratorDomain, image: ImageVersion, actor: DomainActor, reference?: Reference, run?: RunRecord, familyStatuses?: ReadonlyMap<string, boolean>): ImageView {
  const { asset } = domain.authorizedImage(image.id, actor)
  const spec = run ? specOf(run) : undefined
  const fixedRelease = spec?.fixed.release
  const releaseId = fixedRelease && typeof fixedRelease === 'object' && !Array.isArray(fixedRelease) && typeof fixedRelease.id === 'string' ? fixedRelease.id : undefined
  const fixedUsage = spec?.fixed.usage
  const usageId = fixedUsage && typeof fixedUsage === 'object' && !Array.isArray(fixedUsage) && typeof fixedUsage.id === 'string' ? fixedUsage.id : undefined
  const release = releaseId ? domain.repository.get('modelProfile', releaseId) ?? domain.require('release', releaseId) : undefined
  const style = reference ? domain.require('style', reference.styleId) : release ? domain.require('style', release.styleId) : undefined
  const draft = style ? domain.require('draft', style.draftId) : undefined
  const context = style && draft ? {
    styleId: style.id, standard: release ? { kind: 'release' as const, releaseId: release.id } : { kind: 'draft' as const, draftId: draft.id, draftRevision: draft.revision },
    usage: usageId ? { kind: 'revision' as const, usageRevisionId: usageId } : { kind: 'none' as const },
    ...(run ? { runId: run.id } : {}), taskBriefDigest: contentDigest(spec?.input.taskBrief ?? ''),
  } : undefined
  const feedback = domain.repository.list('feedback').filter(item => {
    const subject = item.subject
    const ownsImage = subject.kind === 'pair' ? subject.leftImageVersionId === image.id || subject.rightImageVersionId === image.id : subject.imageVersionId === image.id
    return ownsImage && (!context || contentDigest(item.context) === contentDigest(context))
  })
  const heads = new Set(domain.repository.list('feedbackThread').map(thread => thread.headFeedbackId))
  const current = feedback.filter(item => heads.has(item.id))
  const assessments = run ? domain.repository.list('assessment').filter(item => item.runId === run.id && item.imageVersionId === image.id) : []
  const assessment = assessments.findLast(item => item.stage === 'final') ?? assessments.at(-1)
  const crop = run ? domain.repository.list('cropCandidate').findLast(item => item.runId === run.id && item.derivedImageVersionId === image.id) : undefined
  const match = z.object({ styleMatch: styleMatchSchema }).safeParse(assessment?.data)
  const selection = run ? domain.repository.list('selection').find(item => item.runId === run.id && item.imageVersionId === image.id) : undefined
  const reviewQueueReasons: NonNullable<ImageView['reviewQueueReasons']> = []
  if (assessment?.technicalStatus === 'failed') reviewQueueReasons.push('technical-failed')
  else if (assessment?.verdict === 'needs-review' || assessment?.ruleResults.some(result => result.result === 'unknown')) reviewQueueReasons.push('unknown')
  if (assessment && current.some(feedback => {
    const judgment = feedback.judgment
    if (judgment.kind === 'style-verdict') return (judgment.value === 'accept' && assessment.verdict === 'reject') || (judgment.value === 'reject' && assessment.verdict === 'pass')
    if (judgment.kind !== 'dimension-verdict' || judgment.value === 'unknown') return false
    const rules = release?.rules ?? draft?.rules ?? []
    return assessment.ruleResults.some(result => rules.some(rule => rule.ruleId === result.ruleId && rule.dimension === judgment.dimension)
      && ((judgment.value === 'accept' && result.result === 'violated') || (judgment.value === 'reject' && result.result === 'satisfied')))
  })) reviewQueueReasons.push('human-model-disagreement')
  const groupingConfirmed = familyStatuses ? familyStatuses.get(asset.familyId) === true : domain.isFamilyConfirmed(asset.familyId)
  if (run && !groupingConfirmed && !release?.references.some(item => domain.familyOf(item.familyId) === asset.familyId)) reviewQueueReasons.push('new-source-group')
  // 固定像素摘要的分值让刷新与恢复使用相同抽检结果；部署修改不影响已固定任务的比例。
  const sample = Number.parseInt(contentDigest(image.blob.digest).slice(10, 18), 16) / 0x1_0000_0000
  if (spec && assessment?.technicalStatus === 'completed' && (assessment.verdict === 'pass' || assessment.verdict === 'reject') && sample < spec.config.limits.reviewSampleRate) reviewQueueReasons.push('ordinary-sample')
  const parameters = new URLSearchParams({ imageVersionId: image.id })
  return { imageVersionId: image.id, assetId: asset.id, familyId: asset.familyId,
    ...(match.success ? { styleMatch: match.data.styleMatch } : {}),
    selection: selection ? { kind: 'selected', selectionId: selection.id, qualification: selection.qualification, rank: selection.rank, rankScore: 0, warnings: selection.warnings } : { kind: 'not-selected' },
    ...(assessment ? { reviewStage: assessment.stage } : {}),
    ...(image.parentImageVersionId ? { sourcePreviewPath: `/api/visual-curator/resource?imageVersionId=${encodeURIComponent(image.parentImageVersionId)}` } : {}),
    width: image.geometry.width, height: image.geometry.height, kind: image.versionKind,
    previewPath: `/api/visual-curator/resource?${parameters}`, name: asset.source.description || asset.id, source: asset.source.kind,
    ...(image.blob.remoteSource ? { thumbnailPath: `/api/visual-curator/resource?${parameters}&preview=thumbnail` } : {}),
    ...(actor.kind === 'human' && image.blob.localSource ? { localPath: image.blob.localSource.path } : {}),
    exportPermission: asset.exportPermission, groupingStatus: groupingConfirmed ? 'confirmed' : 'unreviewed', reviewQueueReasons,
    ...(reference ? { referenceId: reference.id, styleId: reference.styleId, role: reference.role, intent: reference.intent.kind,
      dimensions: reference.intent.kind === 'dimensions' ? reference.intent.dimensions : [] } : style ? { styleId: style.id } : {}),
    ...(run ? { runId: run.id } : {}), ...(releaseId ? { releaseId } : {}), ...(usageId ? { usageRevisionId: usageId } : {}),
    ...(image.parentImageVersionId ? { parentImageVersionId: image.parentImageVersionId } : {}),
    ...(crop?.effectivePixelRect ? { candidateId: crop.id, effectivePixelRect: crop.effectivePixelRect } : {}),
    ...(assessment?.verdict ? { verdict: assessment.verdict } : {}),
    ...(assessment?.technicalStatus === 'failed' ? { technicalFailure: 'vision-invalid-output' } : {}),
    ...(assessment ? { reason: assessment.ruleResults.map(item => item.reason).filter(Boolean).join(' · ') } : {}),
    ...(context ? { feedbackContext: context } : {}),
    feedbackHeads: Object.fromEntries(current.map(item => [item.judgment.kind + (item.judgment.kind === 'dimension-verdict' ? `:${item.judgment.dimension}` : ''), item.id])),
    feedbackHistory: feedback.map(feedbackView),
  }
}

/** Project one already-authorized durable run, including rejected and failed image results.
 * @param domain Profile's committed record service.
 * @param run Saved run.
 * @param actor Host-created caller identity.
 * @param familyStatuses Confirmation statuses reused within one synchronous workspace projection.
 * @param includeResults Whether this read needs per-image result cards; summaries retain their full counts.
 * @returns Safe run fields and authorized media references.
 */
export function projectRun(domain: CuratorDomain, run: RunRecord, actor: DomainActor, familyStatuses = domain.familyConfirmationStatuses(), includeResults = true): RunView {
  if (!canReadRun(domain, run, actor)) throw new CuratorError('owner-denied', 'run-read', 'This task belongs to another owner.')
  const spec = specOf(run), data = dataOf(run)
  const assessments = domain.repository.list('assessment').filter(assessment => assessment.runId === run.id)
  const imageIds = new Set(assessments.map(assessment => assessment.imageVersionId))
  for (const crop of domain.repository.list('cropCandidate').filter(item => item.runId === run.id)) {
    imageIds.add(crop.parentImageVersionId)
    if (crop.derivedImageVersionId) imageIds.add(crop.derivedImageVersionId)
  }
  const selections = domain.repository.list('selection').filter(item => item.runId === run.id)
  for (const selection of selections) imageIds.add(selection.imageVersionId)
  const fixedRelease = spec.fixed.release, fixedUsage = spec.fixed.usage
  // 排序从已保存终审推导；已提交的选择记录保留原样，刷新不写入或调用模型。
  const standard = fixedRelease === undefined ? undefined : executionStandard(styleStandardSchema.parse(fixedRelease), spec.fixed.executionRecipe)
  const selected = rankedSelections(selections.map(selection => {
    const assessment = assessments.find(item => item.id === selection.assessmentId)
    const score = Object.entries(standard?.recipe.preferenceScale.weights ?? {}).reduce((sum, [dimension, weight]) => sum + (assessment?.preferenceScores[dimensionSchema.parse(dimension)] ?? 0) * weight, 0)
    return { id: selection.imageVersionId, score }
  }))
  const selectedIds = new Set(selected.map(item => item.id))
  const orderedIds = [...selectedIds, ...[...imageIds].filter(id => !selectedIds.has(id))]
  const releaseId = fixedRelease && typeof fixedRelease === 'object' && !Array.isArray(fixedRelease) && typeof fixedRelease.id === 'string' ? fixedRelease.id : undefined
  const usageRevisionId = fixedUsage && typeof fixedUsage === 'object' && !Array.isArray(fixedUsage) && typeof fixedUsage.id === 'string' ? fixedUsage.id : undefined
  return { runId: run.id, owner: run.owner, kind: spec.kind, status: run.status, ...(standard ? { styleId: standard.styleId } : typeof spec.input.styleId === 'string' ? { styleId: spec.input.styleId } : {}), resultSummary: { selected: selections.length, needsReview: new Set(assessments.filter(item => item.verdict === 'needs-review').map(item => item.imageVersionId)).size, candidates: orderedIds.length, target: typeof spec.input.targetCount === 'number' ? spec.input.targetCount : null }, ...(data.jobId ? { jobId: data.jobId } : {}), ...(run.stage ? { stage: run.stage } : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}), ...(releaseId ? { releaseId } : {}), ...(usageRevisionId ? { usageRevisionId } : {}),
    taskBrief: typeof spec.input.taskBrief === 'string' ? spec.input.taskBrief : '', counts: data.counts, warnings: data.warnings,
    results: includeResults ? orderedIds.map(id => domain.require('imageVersion', id)).filter(image => readableImage(domain, image, actor)).map(image => {
      const view = imageView(domain, image, actor, undefined, run, familyStatuses), rank = selected.findIndex(item => item.id === image.id)
      if (view.selection?.kind === 'selected' && rank >= 0) view.selection = { ...view.selection, rank, rankScore: selected[rank]!.score }
      return view
    }) : [],
    ...(data.error ? { error: data.error } : {}) }
}

/** Select a validated image window before building cards, independently of full task-detail reads. */
export interface SnapshotProjection {
  /** @param ids Authorized image identities in stable page order. @returns Requested offset and page size. */
  imageWindow?(ids: string[]): { offset: number; size: number }
  /** False for workspace summaries whose task results load separately. */
  includeRunResults?: boolean
}

/** Build all four workspaces using authorized records; no storage references or external media URLs leave the Host.
 * @param domain Profile's business service.
 * @param engine Durable task engine.
 * @param config Resolved non-secret deployment configuration.
 * @param actor Host-created identity.
 * @param credentialStatus Credential presence only.
 * @param projection Optional validated page selection and task-summary mode; omitted for full domain consumers.
 * @returns Complete browser projection while viewing selections remain Client-owned.
 */
export function projectSnapshot(domain: CuratorDomain, engine: RunEngine, config: CuratorConfig, actor: DomainActor, credentialStatus: { source: boolean; vision: boolean }, projection: SnapshotProjection = {}): CuratorSnapshot {
  return domain.repository.readSnapshot(() => snapshotNow(domain, engine, config, actor, credentialStatus, projection))
}

/** @param domain Saved collection service. @param styleId Requested collection. @param actor Authenticated reader. @returns Current collection fields without projecting unrelated image cards or task results. */
export function projectStyle(domain: CuratorDomain, styleId: string, actor: DomainActor): StyleView {
  return domain.repository.readSnapshot(() => {
    const base = domain.snapshot(actor)
    base.styles = base.styles.filter(style => style.id === styleId)
    if (!base.styles.length) throw new CuratorError('reference-unavailable', 'style-read', 'The requested style is unavailable.')
    return styleViews(domain, base, actor, domain.familyConfirmationStatuses(), domain.repository.list('run').filter(run => canReadRun(domain, run, actor)))[0]!
  })
}

function styleViews(domain: CuratorDomain, base: ReturnType<CuratorDomain['snapshot']>, actor: DomainActor, familyStatuses: ReadonlyMap<string, boolean>, runs: RunRecord[]): StyleView[] {
  return base.styles.map(style => {
    const draft = base.drafts.find(item => item.id === style.draftId) ?? domain.require('draft', style.draftId)
    const run = runs.filter(run => { const spec = specOf(run); return spec.kind === 'analyze' && spec.input.buildDataset === true && spec.input.styleId === style.id }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0)
    let analysis: StyleAnalysisView | undefined
    if (run) {
      const result = styleAnalysisOf(run), data = dataOf(run)
      const references = draft.referenceIds.map(id => domain.require('reference', id))
      const threads = new Set(references.flatMap(ref => ref.feedbackThreadIds))
      const feedbackIds = base.feedback.filter(item => item.context.styleId === style.id && item.scope === 'style-candidate' && (threads.has(item.threadId) || draft.feedbackIds.includes(item.id))).map(item => item.id)
      analysis = { runId: run.id, status: run.status, stage: run.stage, observed: data.counts.observed ?? 0, total: references.length, model: specOf(run).config.vision.model,
        ...(run.outcome ? { outcome: run.outcome } : {}),
        stale: result ? result.referenceDigest !== analysisReferenceDigest(references, feedbackIds) : false,
        ...(result ? { summary: result.summary } : {}), ...(data.error ? { error: data.error } : {}),
        samples: result ? sampleViews(domain, result, actor, familyStatuses) : [] }
    }
    const profile = new ModelProfiles(domain).current(style.id, actor)
    const visibleProfile = profile && (profile.access.kind !== 'session-run' || profile.access.sessionId === actor.sessionId) && profile.references.every(ref => readableImage(domain, domain.require('imageVersion', ref.reference.imageVersionId), actor)) ? profile : undefined
    const profileAnalysis = visibleProfile ? styleAnalysisOf(domain.require('run', visibleProfile.analysisRunId)) : undefined
    return { styleId: style.id, name: style.name, revision: style.revision, draftId: draft.id, draftRevision: draft.revision,
      archived: style.archived, ...(style.defaultReleaseId ? { defaultReleaseId: style.defaultReleaseId } : {}),
      ...(analysis ? { analysis } : {}),
      ...(visibleProfile && profileAnalysis ? { modelProfile: { id: visibleProfile.id, revision: visibleProfile.revision, analysisRunId: visibleProfile.analysisRunId, model: visibleProfile.model, stale: !new ModelProfiles(domain).isFresh(visibleProfile, actor), summary: profileAnalysis.summary, samples: sampleViews(domain, profileAnalysis, actor, familyStatuses), groups: visibleProfile.groups, options: visibleProfile.options.map(option => ({ ...option, rule: ruleView(option.rule) })) } } : {}),
      rules: draft.rules.map(ruleView), conflicts: draft.conflicts.filter(item => !item.resolved).map(item => item.reason), referenceIds: draft.referenceIds, feedbackIds: draft.feedbackIds,
      releases: base.releases.filter(item => item.styleId === style.id && style.committedReleaseIds.includes(item.id)).map(item => ({ id: item.id, label: `v${item.releaseNumber}`, contentDigest: item.contentDigest, draftRevision: item.draftRevision, validation: item.validation.status, evaluationIds: item.validation.evaluationIds, rules: item.rules.map(ruleView) })),
      candidates: base.candidates.filter(item => item.styleId === style.id).map(item => ({ id: item.id, label: item.id, contentDigest: item.contentDigest, rules: item.rules.map(ruleView) })),
    }
  })
}

function snapshotNow(domain: CuratorDomain, engine: RunEngine, config: CuratorConfig, actor: DomainActor, credentialStatus: { source: boolean; vision: boolean }, projection: SnapshotProjection): CuratorSnapshot {
  const base = domain.snapshot(actor)
  const familyStatuses = domain.familyConfirmationStatuses()
  const runs = domain.repository.list('run').filter(run => canReadRun(domain, run, actor))
  const modelExports = domain.repository.list('profileExport').filter(record => (record.access.kind !== 'session-run' || record.access.sessionId === actor.sessionId) && record.resources.every(resource => readableImage(domain, domain.require('imageVersion', resource.imageVersionId), actor)))
  const views = [base]
  const unique = <T extends { id: string }>(values: T[]) => [...new Map(values.map(item => [item.id, item])).values()]
  const feedback = unique(views.flatMap(view => view.feedback)), exports = unique(views.flatMap(view => view.exports)), suggestions = unique(views.flatMap(view => view.suggestions)), evaluations = unique(views.flatMap(view => view.evaluations))
  const styles = styleViews(domain, base, actor, familyStatuses, runs)
  const configuration = projectConfiguration(config, credentialStatus)
  const references = unique(views.flatMap(view => view.references))
  const referenced = new Set(references.map(reference => reference.imageVersionId))
  const entries: { image: ImageVersion; reference?: Reference }[] = references.map(reference => ({ image: domain.require('imageVersion', reference.imageVersionId), reference }))
  for (const image of domain.repository.list('imageVersion')) {
    if (referenced.has(image.id) || image.versionKind === 'preview' || !readableImage(domain, image, actor)) continue
    const asset = domain.require('asset', image.assetId)
    if (asset.access.kind === 'profile-library') entries.push({ image })
  }
  // 游标先在授权后的完整顺序中校验，仅对当前页构建反馈和图片字段。
  const window = projection.imageWindow?.(entries.map(entry => entry.image.id))
  const visible = window ? entries.slice(window.offset, window.offset + window.size) : entries
  const images = visible.map(({ image, reference }) => imageView(domain, image, actor, reference, undefined, familyStatuses))
  // Invocation through engine.get enforces the same task ownership used by control and tool reads.
  const runViews = runs.map(run => projectRun(domain, engine.get(run.id, actor), actor, familyStatuses, projection.includeRunResults))
  const latestUsages = [...new Map(base.usages.sort((left, right) => left.revision - right.revision).map(usage => [usage.presetId, usage])).values()]
  return { styles, images, usages: latestUsages.map(usage => ({ usageRevisionId: usage.id, presetId: usage.presetId, revision: usage.revision, name: usage.name, ...usage.output,
    protectedContent: usage.protectedContent, safeRegions: usage.safeRegions.map(region => ({ ...region.rect, strength: region.strength, description: region.interference })) })),
    runs: runViews, splits: base.splits.map(split => ({ splitId: split.id, label: split.id, assignments: split.assignments })),
    evaluations: evaluations.map(report => ({ reportId: report.id, leftId: report.left.id, rightId: report.right.id, splitId: report.splitId,
      metrics: Object.entries(report.metrics).map(([name, metric]) => ({ name, numerator: metric.numerator, denominator: metric.denominator, value: metric.status === 'available' ? metric.value : null })),
      counts: { items: report.items.length, calls: report.items.reduce((sum, item) => sum + item.calls, 0) }, warnings: report.notes,
      items: report.items.map(item => ({ imageVersionId: item.imageVersionId, left: item.left, right: item.right })) })),
    exports: [...exports.map(record => ({ exportId: record.id, kind: record.exportKind, status: 'completed', releaseId: record.releaseId,
      ...runs.filter(run => specOf(run).kind === 'export' && dataOf(run).resultIds.includes(record.id)).flatMap(run => typeof specOf(run).input.analysisRunId === 'string' ? [{ analysisRunId: String(specOf(run).input.analysisRunId) }] : []).at(0),
      downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(record.id)}`,
      checksum: contentDigest(record.files.map(file => ({ name: file.name, checksum: file.checksum }))),
      preview: record.files.map(file => `${file.name}\n${file.content}`).join('\n'), exclusions: Object.entries(record.exclusions).map(([reason, count]) => ({ reason, count })) })),
      ...modelExports.map(record => ({ exportId: record.id, kind: 'style', status: 'completed', modelProfileId: record.modelProfileId, analysisRunId: record.analysisRunId, downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(record.id)}`, checksum: contentDigest(record.files), exclusions: [] }))],
    suggestions: suggestions.map(suggestion => ({ suggestionId: suggestion.id, text: suggestion.text, status: suggestion.status })), configuration }
}
