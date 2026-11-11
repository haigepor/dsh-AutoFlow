/** Required-rule decisions are computed locally from measured and inferred checks. */
import { z } from 'zod'
import { compileStyleInstructions, matchStyle } from './style-execution.ts'
import { assessmentSchema, jsonSchema, type Assessment, type ImageVersion, type Rule, type StyleStandard, type StyleCandidate, type DomainActor } from '../shared/model.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import { visionReviewSchema } from '../media/index.ts'
import type { AssetFiles, StructuredVisionProvider, VisionImage, VisionInput, VisionReview } from '../media/index.ts'
import { decideAssessment, toJson, type WorkContext } from './runtime.ts'
import { visionBounds } from './providers.ts'
import { remoteReferenceSource } from '../media/remote-reference.ts'
import { selectReviewReferences, effectiveReviewReferenceRole } from './review-references.ts'
import { subjectReviewResults, subjectFocusVerdict } from './subject-review.ts'
import { decodeVisionReview } from '../media/vision.ts'

/** @param image Authorized saved image. @param files Private byte reader. @param role Model-visible reference role. @param signal Request lifetime. @returns Exact pixels or an explicitly identified remote URL. */
export async function visionImageInput(image: ImageVersion, files: AssetFiles, role: string, signal: AbortSignal): Promise<VisionImage> {
  const remoteSource = remoteReferenceSource(image.blob)
  return { imageVersionId: image.id, digest: image.blob.digest, mime: image.blob.mime, role, ...(remoteSource ? { remoteSource } : { bytes: await files.read(image.blob, signal) }) }
}

/** @param domain Authorized records. @param files Private verified files. @param release Frozen reference strategy. @param actor Task owner. @param signal Task cancellation. @returns Stable ordered, actual reference pixels. */
export async function referenceImages(domain: CuratorDomain, files: AssetFiles, release: StyleStandard | StyleCandidate, actor: DomainActor, signal: AbortSignal): Promise<VisionImage[]> {
  const selected = release.recipe.promptVersion === 'visual-curator-rules-v3'
    ? selectReviewReferences(release, snapshot => domain.authorizedImage(snapshot.reference.imageVersionId, actor).image.blob.byteLength)
    : [...release.references].sort((a, b) => a.reference.id.localeCompare(b.reference.id, 'en')).slice(0, release.recipe.referenceStrategy.maxImages)
  const result: VisionImage[] = []; let bytes = 0
  for (const snapshot of selected) {
    const { image } = domain.authorizedImage(snapshot.reference.imageVersionId, actor)
    if (image.blob.digest !== snapshot.imageDigest) throw new Error('Fixed reference digest is unavailable')
    const input = await visionImageInput(image, files, JSON.stringify({ role: release.recipe.promptVersion === 'visual-curator-rules-v3' ? effectiveReviewReferenceRole(release, snapshot) : snapshot.reference.role, ...(release.recipe.promptVersion === 'visual-curator-rules-v3' ? { importedRole: snapshot.reference.role } : {}), intent: snapshot.reference.intent, context: snapshot.reference.context, judgments: snapshot.judgments }), signal)
    bytes += input.bytes?.length ?? 0
    if (bytes > release.recipe.referenceStrategy.maxBytes) throw new Error('Fixed references exceed the saved recipe byte limit')
    result.push(input)
  }
  return result
}

/** @param ctx Durable task. @returns Actor reconstructed from the trusted saved owner. */
export function runActor(ctx: WorkContext): DomainActor {
  const run = ctx.current()
  return { kind: run.owner.kind === 'session' ? 'agent' : 'human', id: 'workflow', profileId: run.profileId, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) }
}

/** @param standard Frozen style and its model-selected alternatives. @param brief Caller task. @param ruleIds Exact visual rules requested by a policy-scoped review; omission retains the frozen legacy brief. @returns Style context limited to the requested review, or complete context for planning and screening. */
export function styleReviewBrief(standard: StyleStandard | StyleCandidate, brief: string, ruleIds?: readonly string[]): string {
  if (ruleIds !== undefined) {
    const requested = new Set(ruleIds)
    const currentStyle = standard.kind === 'modelProfile' ? JSON.parse(compileStyleInstructions({ ...standard, rules: standard.rules.filter(rule => requested.has(rule.ruleId)), options: standard.options.filter(option => requested.has(option.rule.ruleId)) })) : undefined
    return JSON.stringify({ task: brief, ...(currentStyle ? { currentStyle } : {}), reviewScope: { ruleIds,
      instruction: 'Return exactly the rule IDs requested in input.rules, once each. Never create rule IDs from the task or reference text. subjectFocus covers only requested subject-dimension rules. When ruleIds is empty, return ruleResults=[] and subjectFocus=[]. Independently assess every explicit task requirement through taskRelevance, including subject completeness, exclusions and requested medium. A real-photography request excludes recognizable game screenshots, CGI, illustrations and simulated scenes even when their subject and style match. Inspect rendering, material, lighting and scene evidence rather than accepting photorealism or a matching object alone; report irrelevant for a visible contradiction and unknown for material ambiguity. Weighted style preferences cannot compensate for a task mismatch. Other stages are not part of this review.' } })
  }
  if (standard.kind === 'modelProfile' && standard.recipe.styleMatching) return JSON.stringify({ task: brief, currentStyle: JSON.parse(compileStyleInstructions(standard)) })
  return standard.kind === 'modelProfile' ? JSON.stringify({ task: brief, matchingPrompt: standard.matchingPrompt,
    instruction: 'Inspect the actual candidate and reference images. Shared rules apply globally; style groups are alternatives, so match one applicable group instead of requiring every group at once. Subject-only hints do not impose a required subject. Report irrelevant when no group matches, unknown when evidence is missing, and not-applicable for rules of another group.',
    groups: standard.groups, ruleGroups: standard.options.filter(option => option.enabled).map(option => ({ ruleId: option.rule.ruleId, groupId: option.groupId })) }) : brief
}

/** @param rule Measured rule. @param image Actual normalized or derived geometry. @returns Program result, or unknown when not a measurable rule. */
export function measuredRule(rule: Rule, image: ImageVersion): Assessment['ruleResults'][number] {
  if (rule.check.kind !== 'measured') return { ruleId: rule.ruleId, result: 'unknown', basis: 'inferred', reason: 'Visual review is required.' }
  if (image.blob.remoteSource) return { ruleId: rule.ruleId, result: 'unknown', basis: 'inferred', reason: 'Remote reference dimensions are provider metadata; local pixel measurements are unavailable.' }
  const value = rule.check.field === 'width' ? image.geometry.width : rule.check.field === 'height' ? image.geometry.height : rule.check.field === 'aspect' ? image.geometry.width / image.geometry.height : image.blob.byteLength
  const accepted = (rule.check.min === undefined || value + rule.check.tolerance >= rule.check.min) && (rule.check.max === undefined || value - rule.check.tolerance <= rule.check.max)
  return { ruleId: rule.ruleId, result: accepted ? 'satisfied' : 'violated', basis: 'measured', reason: `${rule.check.field}=${value} ${rule.check.unit}; tolerance=${rule.check.tolerance}` }
}

/** @param dependencies Domain, private files and resolved vision adapter. @param ctx Current run. @param image Authorized target. @param release Frozen release. @param stage Rule stage. @returns Persistable assessment and fixed preference score. */
export async function reviewImage(dependencies: { domain: CuratorDomain; files: AssetFiles; vision: StructuredVisionProvider; prepareInput?(input: VisionInput): Promise<VisionInput> }, ctx: WorkContext, image: ImageVersion, release: StyleStandard | StyleCandidate, stage: 'source' | 'final'): Promise<{ assessment: Assessment; score: number }> {
  const actor = runActor(ctx), refs = await referenceImages(dependencies.domain, dependencies.files, release, actor, ctx.signal)
  const subject = await visionImageInput(image, dependencies.files, 'subject', ctx.signal)
  const images = [subject, ...refs.filter(ref => ref.imageVersionId !== image.id)]
  const outputChoice = ctx.spec.fixed.output
  const preview = !!outputChoice && typeof outputChoice === 'object' && !Array.isArray(outputChoice) && outputChoice.kind === 'preview'
  const rules = release.rules.filter(rule => rule.stage === stage || stage === 'final' && (preview || release.recipe.styleMatching && rule.strength !== 'reference-only' && rule.check.kind === 'visual'))
  const identity = contentDigest({ runId: ctx.runId, imageVersionId: image.id, standardDigest: release.contentDigest, stage }).slice(10)
  const brief = typeof ctx.spec.input.taskBrief === 'string' ? ctx.spec.input.taskBrief : 'Review supplied image against the frozen visual standard.'
  const taskBrief = styleReviewBrief(release, brief, ctx.spec.fixed.cropReviewPolicy === 'candidate-focus-v1' ? rules.filter(rule => rule.check.kind === 'visual').map(rule => rule.ruleId) : undefined)
  const focused = release.recipe.promptVersion === 'visual-curator-rules-v3'
  const requestId = `review-${identity}`, canonical = { ...(focused ? { promptVersion: 'visual-curator-rules-v3' as const } : release.recipe.styleMatching ? { promptVersion: 'visual-curator-rules-v2' as const } : {}), requestId, taskBrief, rules: rules.filter(rule => rule.check.kind === 'visual').map(rule => ({ ...rule, stage })), stage, images, ...(ctx.spec.fixed.usage ? { usage: ctx.spec.fixed.usage } : {}) }
  // Optional saved model views change only model pixels; measured checks retain original geometry.
  const input = dependencies.prepareInput ? await dependencies.prepareInput(canonical) : canonical
  const descriptor = dependencies.vision.describeRequest(input, 'review')
  const bundle = toJson(descriptor), requestDigest = contentDigest(bundle)
  const saved = dependencies.domain.repository.list('request').find(request => request.runId === ctx.runId && request.state === 'committed' && request.requestDigest === requestDigest)
  let output: VisionReview
  if (saved === undefined) output = await ctx.request('vision', bundle, (signal, recordMetadata) => dependencies.vision.review(input, visionBounds(ctx.spec.config, ctx, signal, recordMetadata)))
  else {
    const replay = z.object({ bundle: jsonSchema, output: visionReviewSchema }).safeParse(saved.data)
    if (!replay.success || contentDigest(replay.data.bundle) !== requestDigest) throw new CuratorError('reference-unavailable', 'reviewing', 'The committed visual response is missing or does not match its saved request.')
    // 已提交响应与完整描述摘要匹配时直接重放，避免检查点前退出导致重复计费。
    output = replay.data.output
  }
  output = decodeVisionReview(output, input)
  const checked = focused ? subjectReviewResults(rules, output) : { ruleResults: output.ruleResults, focusRuleIds: [] }
  const results = rules.map(rule => {
    if (rule.check.kind === 'measured') return measuredRule(rule, image)
    const inferred = checked.ruleResults.find(item => item.ruleId === rule.ruleId)!
    return { ruleId: rule.ruleId, result: inferred.status === 'not-applicable' ? 'unknown' as const : inferred.status, basis: 'inferred' as const, reason: inferred.reason, ...(inferred.region ? { region: inferred.region } : {}) }
  })
  const alternativeRules = release.kind === 'modelProfile' && release.recipe.styleMatching ? new Set(release.options.filter(option => option.enabled && option.groupId !== null && option.rule.check.kind === 'visual').map(option => option.rule.ruleId)) : new Set<string>()
  let verdict = decideAssessment(results.filter(result => !alternativeRules.has(result.ruleId)).map(result => ({ strength: rules.find(rule => rule.ruleId === result.ruleId)!.strength, result: result.result })))
  if (output.taskRelevance === 'irrelevant') verdict = 'reject'
  if (output.taskRelevance === 'unknown' && verdict === 'pass') verdict = 'needs-review'
  if ((stage === 'final' || ctx.spec.fixed.cropReviewPolicy !== 'candidate-focus-v1') && Object.entries(release.recipe.preferenceScale.weights).some(([dimension, weight]) => weight > 0 && !output.preferenceScores.some(score => score.dimension === dimension)) && verdict === 'pass') verdict = 'needs-review'
  const focusVerdict = subjectFocusVerdict(release, results, checked.focusRuleIds)
  if (focusVerdict === 'not-matched') verdict = 'reject'
  else if (focusVerdict === 'unknown' && verdict === 'pass') verdict = 'needs-review'
  const styleMatch = stage === 'final' && release.kind === 'modelProfile' && release.recipe.styleMatching ? matchStyle(release, results, release.recipe.styleMatching.minSatisfiedRatio, checked.focusRuleIds) : undefined
  if (styleMatch?.verdict === 'not-matched') verdict = 'reject'
  else if (styleMatch?.verdict === 'unknown' && verdict === 'pass') verdict = 'needs-review'
  const weights = release.recipe.preferenceScale.weights, scores = Object.fromEntries(Object.keys(weights).map(key => [key, output.preferenceScores.find(score => score.dimension === key)?.score ?? 0]))
  const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * (scores[key] ?? 0), 0)
  const sampled = Number.parseInt(image.blob.digest.slice(0, 8), 16) / 0xffffffff < ctx.spec.config.limits.reviewSampleRate
  const assessment = assessmentSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: `assessment-${identity}`, createdAt: new Date().toISOString(), kind: 'assessment', imageVersionId: image.id, runId: ctx.runId, stage, ...(release.kind === 'release' ? { releaseId: release.id } : {}), standard: { kind: release.kind, id: release.id, contentDigest: release.contentDigest }, recipeId: release.recipe.id, reviewBundleId: requestId, technicalStatus: 'completed', verdict, ruleResults: results, cropPotential: output.cropPotential, preferenceScores: scores, data: toJson({ descriptor, ...(styleMatch ? { styleMatch } : {}), taskRelevance: output.taskRelevance, score, ...(focused ? { subjectFocus: output.subjectFocus, subjectFocusVerdict: focusVerdict } : {}), reviewQueueReasons: [...(verdict === 'needs-review' ? ['unknown'] : []), ...(sampled ? ['random-sample'] : [])] }) })
  return { assessment, score }
}
