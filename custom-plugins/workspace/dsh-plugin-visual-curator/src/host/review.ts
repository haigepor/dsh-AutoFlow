/** Required-rule decisions are computed locally from measured and inferred checks. */
import { z } from 'zod'
import { assessmentSchema, jsonSchema, type Assessment, type ImageVersion, type Rule, type StyleRelease, type StyleCandidate, type DomainActor } from '../shared/model.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import { visionReviewSchema } from '../media/index.ts'
import type { AssetFiles, CompatibleVisionProvider, VisionImage, VisionReview } from '../media/index.ts'
import { decideAssessment, toJson, type WorkContext } from './runtime.ts'
import { requestBounds } from './providers.ts'

/** @param domain Authorized records. @param files Private verified files. @param release Frozen reference strategy. @param actor Task owner. @param signal Task cancellation. @returns Stable ordered, actual reference pixels. */
export async function referenceImages(domain: CuratorDomain, files: AssetFiles, release: Pick<StyleRelease, 'references' | 'recipe'>, actor: DomainActor, signal: AbortSignal): Promise<VisionImage[]> {
  const selected = [...release.references].sort((a, b) => a.reference.id.localeCompare(b.reference.id, 'en')).slice(0, release.recipe.referenceStrategy.maxImages)
  const result: VisionImage[] = []; let bytes = 0
  for (const snapshot of selected) {
    const { image } = domain.authorizedImage(snapshot.reference.imageVersionId, actor)
    if (image.blob.digest !== snapshot.imageDigest) throw new Error('Fixed reference digest is unavailable')
    const data = await files.read(image.blob, signal)
    bytes += data.length
    if (bytes > release.recipe.referenceStrategy.maxBytes) throw new Error('Fixed references exceed the saved recipe byte limit')
    result.push({ imageVersionId: image.id, digest: image.blob.digest, mime: image.blob.mime, bytes: data, role: JSON.stringify({ role: snapshot.reference.role, intent: snapshot.reference.intent, context: snapshot.reference.context, judgments: snapshot.judgments }) })
  }
  return result
}

/** @param ctx Durable task. @returns Actor reconstructed from the trusted saved owner. */
export function runActor(ctx: WorkContext): DomainActor {
  const run = ctx.current()
  return { kind: run.owner.kind === 'session' ? 'agent' : 'human', id: 'workflow', profileId: run.profileId, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) }
}

/** @param rule Measured rule. @param image Actual normalized or derived geometry. @returns Program result, or unknown when not a measurable rule. */
export function measuredRule(rule: Rule, image: ImageVersion): Assessment['ruleResults'][number] {
  if (rule.check.kind !== 'measured') return { ruleId: rule.ruleId, result: 'unknown', basis: 'inferred', reason: 'Visual review is required.' }
  const value = rule.check.field === 'width' ? image.geometry.width : rule.check.field === 'height' ? image.geometry.height : rule.check.field === 'aspect' ? image.geometry.width / image.geometry.height : image.blob.byteLength
  const accepted = (rule.check.min === undefined || value + rule.check.tolerance >= rule.check.min) && (rule.check.max === undefined || value - rule.check.tolerance <= rule.check.max)
  return { ruleId: rule.ruleId, result: accepted ? 'satisfied' : 'violated', basis: 'measured', reason: `${rule.check.field}=${value} ${rule.check.unit}; tolerance=${rule.check.tolerance}` }
}

/** @param dependencies Domain, private files and resolved vision adapter. @param ctx Current run. @param image Authorized target. @param release Frozen release. @param stage Rule stage. @returns Persistable assessment and fixed preference score. */
export async function reviewImage(dependencies: { domain: CuratorDomain; files: AssetFiles; vision: CompatibleVisionProvider }, ctx: WorkContext, image: ImageVersion, release: StyleRelease | StyleCandidate, stage: 'source' | 'final'): Promise<{ assessment: Assessment; score: number }> {
  const actor = runActor(ctx), refs = await referenceImages(dependencies.domain, dependencies.files, release, actor, ctx.signal)
  const subject = { imageVersionId: image.id, digest: image.blob.digest, mime: image.blob.mime, bytes: await dependencies.files.read(image.blob, ctx.signal), role: 'subject' }
  const images = [subject, ...refs.filter(ref => ref.imageVersionId !== image.id)]
  const rules = release.rules.filter(rule => rule.stage === stage)
  const identity = contentDigest({ runId: ctx.runId, imageVersionId: image.id, standardDigest: release.contentDigest, stage }).slice(10)
  const requestId = `review-${identity}`, input = { requestId, taskBrief: typeof ctx.spec.input.taskBrief === 'string' ? ctx.spec.input.taskBrief : 'Review supplied image against the frozen visual standard.', rules: rules.filter(rule => rule.check.kind === 'visual'), stage, images, ...(ctx.spec.fixed.usage ? { usage: ctx.spec.fixed.usage } : {}) }
  const descriptor = dependencies.vision.describeRequest(input, 'review')
  const bundle = toJson(descriptor), requestDigest = contentDigest(bundle)
  const saved = dependencies.domain.repository.list('request').find(request => request.runId === ctx.runId && request.state === 'committed' && request.requestDigest === requestDigest)
  let output: VisionReview
  if (saved === undefined) output = await ctx.request('vision', bundle, signal => dependencies.vision.review(input, { ...requestBounds(ctx.spec.config, ctx), signal }))
  else {
    const replay = z.object({ bundle: jsonSchema, output: visionReviewSchema }).safeParse(saved.data)
    if (!replay.success || contentDigest(replay.data.bundle) !== requestDigest) throw new CuratorError('reference-unavailable', 'reviewing', 'The committed visual response is missing or does not match its saved request.')
    // 已提交响应与完整描述摘要匹配时直接重放，避免检查点前退出导致重复计费。
    output = replay.data.output
  }
  const results = rules.map(rule => {
    if (rule.check.kind === 'measured') return measuredRule(rule, image)
    const inferred = output.ruleResults.find(item => item.ruleId === rule.ruleId)!
    return { ruleId: rule.ruleId, result: inferred.status === 'not-applicable' ? 'unknown' as const : inferred.status, basis: 'inferred' as const, reason: inferred.reason, ...(inferred.region ? { region: inferred.region } : {}) }
  })
  let verdict = decideAssessment(results.map(result => ({ strength: rules.find(rule => rule.ruleId === result.ruleId)!.strength, result: result.result })))
  if (output.taskRelevance === 'irrelevant') verdict = 'reject'
  if (output.taskRelevance === 'unknown' && verdict === 'pass') verdict = 'needs-review'
  if (Object.entries(release.recipe.preferenceScale.weights).some(([dimension, weight]) => weight > 0 && !output.preferenceScores.some(score => score.dimension === dimension)) && verdict === 'pass') verdict = 'needs-review'
  const weights = release.recipe.preferenceScale.weights, scores = Object.fromEntries(Object.keys(weights).map(key => [key, output.preferenceScores.find(score => score.dimension === key)?.score ?? 0]))
  const score = Object.entries(weights).reduce((sum, [key, weight]) => sum + weight * (scores[key] ?? 0), 0)
  const sampled = Number.parseInt(image.blob.digest.slice(0, 8), 16) / 0xffffffff < ctx.spec.config.limits.reviewSampleRate
  const assessment = assessmentSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: `assessment-${identity}`, createdAt: new Date().toISOString(), kind: 'assessment', imageVersionId: image.id, runId: ctx.runId, stage, ...(release.kind === 'release' ? { releaseId: release.id } : {}), standard: { kind: release.kind, id: release.id, contentDigest: release.contentDigest }, recipeId: release.recipe.id, reviewBundleId: requestId, technicalStatus: 'completed', verdict, ruleResults: results, cropPotential: output.cropPotential, preferenceScores: scores, data: toJson({ descriptor, taskRelevance: output.taskRelevance, score, reviewQueueReasons: [...(verdict === 'needs-review' ? ['unknown'] : []), ...(sampled ? ['random-sample'] : [])] }) })
  return { assessment, score }
}
