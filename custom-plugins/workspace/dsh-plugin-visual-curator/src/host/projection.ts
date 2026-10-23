/** Safe browser projections derive permissions and feedback context from committed records. */
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { DomainActor, HumanFeedback, ImageVersion, Reference, RunRecord, Rule } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import type { ConfigurationView, CuratorSnapshot, FeedbackView, ImageView, RuleView, RunView, StyleView } from '../client/contract.ts'
import { configRevision, type CuratorConfig } from './config.ts'
import { dataOf, specOf, type RunEngine } from './runtime.ts'

function ruleView(rule: Rule): RuleView {
  return { ruleId: rule.ruleId, dimension: rule.dimension, statement: rule.statement, strength: rule.strength,
    stage: rule.stage, confirmed: rule.confirmation.status === 'confirmed', condition: rule.condition.subjects?.join(', ') ?? '',
    exceptions: rule.exceptions.map(condition => condition.subjects?.join(', ') ?? condition.usageRevisionIds?.join(', ') ?? ''),
    supportRefs: rule.supportRefs, counterRefs: rule.counterRefs }
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

function imageView(domain: CuratorDomain, image: ImageVersion, actor: DomainActor, reference?: Reference, run?: RunRecord): ImageView {
  const { asset } = domain.authorizedImage(image.id, actor)
  const spec = run ? specOf(run) : undefined
  const fixedRelease = spec?.fixed.release
  const releaseId = fixedRelease && typeof fixedRelease === 'object' && !Array.isArray(fixedRelease) && typeof fixedRelease.id === 'string' ? fixedRelease.id : undefined
  const fixedUsage = spec?.fixed.usage
  const usageId = fixedUsage && typeof fixedUsage === 'object' && !Array.isArray(fixedUsage) && typeof fixedUsage.id === 'string' ? fixedUsage.id : undefined
  const release = releaseId ? domain.require('release', releaseId) : undefined
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
  const groupingConfirmed = domain.isFamilyConfirmed(asset.familyId)
  if (run && !groupingConfirmed && !release?.references.some(item => domain.familyOf(item.familyId) === asset.familyId)) reviewQueueReasons.push('new-source-group')
  // 固定像素摘要的分值让刷新与恢复使用相同抽检结果；部署修改不影响已固定任务的比例。
  const sample = Number.parseInt(contentDigest(image.blob.digest).slice(10, 18), 16) / 0x1_0000_0000
  if (spec && assessment?.technicalStatus === 'completed' && (assessment.verdict === 'pass' || assessment.verdict === 'reject') && sample < spec.config.limits.reviewSampleRate) reviewQueueReasons.push('ordinary-sample')
  const parameters = new URLSearchParams({ imageVersionId: image.id })
  return { imageVersionId: image.id, assetId: asset.id, familyId: asset.familyId,
    width: image.geometry.width, height: image.geometry.height, kind: image.versionKind,
    previewPath: `/api/visual-curator/resource?${parameters}`, name: asset.source.description || asset.id, source: asset.source.kind,
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
 * @returns Safe run fields and authorized media references.
 */
export function projectRun(domain: CuratorDomain, run: RunRecord, actor: DomainActor): RunView {
  if (!canReadRun(domain, run, actor)) throw new CuratorError('owner-denied', 'run-read', 'This task belongs to another owner.')
  const spec = specOf(run), data = dataOf(run)
  const imageIds = new Set(domain.repository.list('assessment').filter(assessment => assessment.runId === run.id).map(assessment => assessment.imageVersionId))
  for (const crop of domain.repository.list('cropCandidate').filter(item => item.runId === run.id)) {
    imageIds.add(crop.parentImageVersionId)
    if (crop.derivedImageVersionId) imageIds.add(crop.derivedImageVersionId)
  }
  for (const selection of domain.repository.list('selection').filter(item => item.runId === run.id)) imageIds.add(selection.imageVersionId)
  const fixedRelease = spec.fixed.release, fixedUsage = spec.fixed.usage
  const releaseId = fixedRelease && typeof fixedRelease === 'object' && !Array.isArray(fixedRelease) && typeof fixedRelease.id === 'string' ? fixedRelease.id : undefined
  const usageRevisionId = fixedUsage && typeof fixedUsage === 'object' && !Array.isArray(fixedUsage) && typeof fixedUsage.id === 'string' ? fixedUsage.id : undefined
  return { runId: run.id, kind: spec.kind, status: run.status, ...(data.jobId ? { jobId: data.jobId } : {}), ...(run.stage ? { stage: run.stage } : {}),
    ...(run.outcome ? { outcome: run.outcome } : {}), ...(releaseId ? { releaseId } : {}), ...(usageRevisionId ? { usageRevisionId } : {}),
    taskBrief: typeof spec.input.taskBrief === 'string' ? spec.input.taskBrief : '', counts: data.counts, warnings: data.warnings,
    results: [...imageIds].map(id => domain.require('imageVersion', id)).filter(image => readableImage(domain, image, actor)).map(image => imageView(domain, image, actor, undefined, run)),
    ...(data.error ? { error: data.error } : {}) }
}

/** Build all four workspaces using authorized records; no storage references or external media URLs leave the Host.
 * @param domain Profile's business service.
 * @param engine Durable task engine.
 * @param config Resolved non-secret deployment configuration.
 * @param actor Host-created identity.
 * @param credentialStatus Credential presence only.
 * @returns Complete browser projection while viewing selections remain Client-owned.
 */
export function projectSnapshot(domain: CuratorDomain, engine: RunEngine, config: CuratorConfig, actor: DomainActor, credentialStatus: { source: boolean; vision: boolean }): CuratorSnapshot {
  const base = domain.snapshot(actor)
  const runs = domain.repository.list('run').filter(run => canReadRun(domain, run, actor))
  const views = [base]
  const unique = <T extends { id: string }>(values: T[]) => [...new Map(values.map(item => [item.id, item])).values()]
  const feedback = unique(views.flatMap(view => view.feedback)), exports = unique(views.flatMap(view => view.exports)), suggestions = unique(views.flatMap(view => view.suggestions)), evaluations = unique(views.flatMap(view => view.evaluations))
  const styles: StyleView[] = base.styles.map(style => {
    const draft = base.drafts.find(item => item.id === style.draftId) ?? domain.require('draft', style.draftId)
    return { styleId: style.id, name: style.name, revision: style.revision, draftId: draft.id, draftRevision: draft.revision,
      archived: style.archived, ...(style.defaultReleaseId ? { defaultReleaseId: style.defaultReleaseId } : {}),
      rules: draft.rules.map(ruleView), conflicts: draft.conflicts.filter(item => !item.resolved).map(item => item.reason), referenceIds: draft.referenceIds, feedbackIds: draft.feedbackIds,
      releases: base.releases.filter(item => item.styleId === style.id && style.committedReleaseIds.includes(item.id)).map(item => ({ id: item.id, label: `v${item.releaseNumber}`, contentDigest: item.contentDigest, validation: item.validation.status, evaluationIds: item.validation.evaluationIds, rules: item.rules.map(ruleView) })),
      candidates: base.candidates.filter(item => item.styleId === style.id).map(item => ({ id: item.id, label: item.id, contentDigest: item.contentDigest, rules: item.rules.map(ruleView) })),
    }
  })
  const configuration: ConfigurationView = { revision: configRevision(config), sourceConfigured: !!config.source.endpoint && (!config.source.credentialRef || credentialStatus.source),
    visionConfigured: !!config.vision.endpoint && !!config.vision.model && config.vision.supportsMultipleImages && config.vision.supportsJson && (!config.vision.credentialRef || credentialStatus.vision),
    sourceCredentialConfigured: credentialStatus.source, visionCredentialConfigured: credentialStatus.vision, source: config.source, vision: config.vision, limits: config.limits }
  const references = unique(views.flatMap(view => view.references))
  const referenced = new Set(references.map(reference => reference.imageVersionId))
  const images = references.map(reference => imageView(domain, domain.require('imageVersion', reference.imageVersionId), actor, reference))
  for (const image of domain.repository.list('imageVersion')) {
    if (referenced.has(image.id) || image.versionKind === 'preview' || !readableImage(domain, image, actor)) continue
    const asset = domain.require('asset', image.assetId)
    if (asset.access.kind === 'profile-library') images.push(imageView(domain, image, actor))
  }
  // Invocation through engine.get enforces the same task ownership used by control and tool reads.
  const runViews = runs.map(run => projectRun(domain, engine.get(run.id, actor), actor))
  return { styles, images, usages: base.usages.map(usage => ({ usageRevisionId: usage.id, name: usage.name, ...usage.output,
    protectedContent: usage.protectedContent, safeRegions: usage.safeRegions.map(region => ({ ...region.rect, strength: region.strength, description: region.interference })) })),
    runs: runViews, splits: base.splits.map(split => ({ splitId: split.id, label: split.id, assignments: split.assignments })),
    evaluations: evaluations.map(report => ({ reportId: report.id, leftId: report.left.id, rightId: report.right.id, splitId: report.splitId,
      metrics: Object.entries(report.metrics).map(([name, metric]) => ({ name, numerator: metric.numerator, denominator: metric.denominator, value: metric.status === 'available' ? metric.value : null })),
      counts: { items: report.items.length, calls: report.items.reduce((sum, item) => sum + item.calls, 0) }, warnings: report.notes,
      items: report.items.map(item => ({ imageVersionId: item.imageVersionId, left: item.left, right: item.right })) })),
    exports: exports.map(record => ({ exportId: record.id, kind: record.exportKind, status: 'completed',
      downloadPath: `/api/visual-curator/resource?exportId=${encodeURIComponent(record.id)}`,
      checksum: contentDigest(record.files.map(file => ({ name: file.name, checksum: file.checksum }))),
      preview: record.files.map(file => `${file.name}\n${file.content}`).join('\n'), exclusions: Object.entries(record.exclusions).map(([reason, count]) => ({ reason, count })) })),
    suggestions: suggestions.map(suggestion => ({ suggestionId: suggestion.id, text: suggestion.text, status: suggestion.status })), configuration }
}
