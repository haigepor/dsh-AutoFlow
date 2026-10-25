/** Analyze, compare and export immutable task inputs without promoting machine output to human labels. */
import { z } from 'zod'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import { analysisReferenceDigest } from '../domain/style-analysis.ts'
import { ModelProfiles } from '../domain/model-profile.ts'
import { styleAnalysisSchema, styleSummarySchema } from '../shared/style-analysis.ts'
import {
  candidateSchema, releaseSchema, draftSchema, referenceSchema, recipeSchema, usageSchema, splitSchema, evaluationSchema,
  imageVersionSchema, feedbackSchema, observationSchema, suggestionSchema, assessmentSchema,
  evaluationItemSchema, type DomainActor, type ImageVersion, type StyleCandidate, type StyleRelease,
  type EvaluationReport, type Assessment, type CuratorRecord, type Json,
} from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { visionAnalysisSchema, visionReviewSchema } from '../media/index.ts'
import type { AssetFiles, CompatibleVisionProvider, VisionImage, VisionInput } from '../media/index.ts'
import type { CuratorConfig } from './config.ts'
import { dataOf, specOf, decideAssessment, safeFailure, toJson, type Worker, type WorkContext } from './runtime.ts'
import { measuredRule, runActor, visionImageInput } from './review.ts'
import { requestBounds } from './providers.ts'

/** All I/O remains owned by the current Run and its shared budget. */
export interface DataWorkerDependencies { domain: CuratorDomain; files: AssetFiles; vision: (config: CuratorConfig) => Promise<CompatibleVisionProvider> }
const actorSchema = z.strictObject({ kind: z.enum(['human', 'agent']), id: z.string().min(1), profileId: z.string().min(1), sessionId: z.string().optional() })
const standardSchema = z.union([releaseSchema, candidateSchema])
const checkpointSchema = z.object({ analysisDoneImageIds: z.array(z.string()).default([]), analysisResultIds: z.array(z.string()).default([]), evaluationItems: z.array(z.string()).default([]) })
const exportArgsSchema = z.strictObject({ operationId: z.string(), exportKind: z.enum(['style', 'classification', 'preference', 'crop', 'skill']), purpose: z.enum(['training', 'development', 'holdout', 'reference']), releaseId: z.string(), splitId: z.string(), mode: z.enum(['references-only', 'with-bytes']).optional(), usageRevisionId: z.string().optional(), analysisRunId: z.string().optional() })

function recordBase(ctx: WorkContext, kind: string, identity: unknown) { return { schemaVersion: 1 as const, profileId: ctx.current().profileId, id: `${kind}-${contentDigest({ runId: ctx.runId, identity }).slice(10, 50)}`, createdAt: new Date().toISOString() } }
function fixedActor(ctx: WorkContext, key: 'actor' | 'humanActor'): DomainActor {
  const actor = actorSchema.parse(ctx.spec.fixed[key])
  const owner = ctx.current().owner
  if (actor.profileId !== ctx.current().profileId || (owner.kind === 'session' ? actor.sessionId !== owner.sessionId : actor.kind !== 'human' || actor.sessionId !== undefined)) throw new CuratorError('owner-denied', 'data-workflow', 'The saved data operation belongs to another owner.')
  return { kind: actor.kind, id: actor.id, profileId: actor.profileId, ...(actor.sessionId === undefined ? {} : { sessionId: actor.sessionId }) }
}
async function imagePixels(deps: DataWorkerDependencies, image: ImageVersion, role: string, ctx: WorkContext): Promise<VisionImage> {
  const stored = deps.domain.authorizedImage(image.id, runActor(ctx)).image
  if (contentDigest(stored) !== contentDigest(image)) throw new CuratorError('reference-unavailable', 'data-workflow', 'A frozen image record changed.')
  return await visionImageInput(image, deps.files, role, ctx.signal)
}
/** A committed auxiliary response is replayed after a crash before the owner checkpoint. */
function savedResponse(deps: DataWorkerDependencies, ctx: WorkContext, requestId: string): { output: Json; descriptor: Json } | undefined {
  for (const request of deps.domain.repository.list('request')) {
    if (request.runId !== ctx.runId || request.state !== 'committed') continue
    const data = z.object({ bundle: z.object({ requestId: z.string() }).passthrough(), output: z.json() }).safeParse(request.data)
    if (data.success && data.data.bundle.requestId === requestId) return { output: data.data.output, descriptor: toJson(data.data.bundle) }
  }
  return undefined
}

async function analyze(deps: DataWorkerDependencies, ctx: WorkContext): Promise<void> {
  ctx.report({ phase: 'preparing' })
  const draft = draftSchema.parse(ctx.spec.fixed.draft)
  const references = z.array(referenceSchema).parse(ctx.spec.fixed.references)
  const feedback = z.array(feedbackSchema).parse(ctx.spec.fixed.feedback)
  const recipe = recipeSchema.parse(ctx.spec.fixed.recipe)
  if (draft.styleId !== ctx.spec.input.styleId || references.some(r => r.styleId !== draft.styleId)
    || contentDigest([...draft.referenceIds].sort()) !== contentDigest(references.map(r => r.id).sort())) throw new CuratorError('constraint-conflict', 'analyze', 'The fixed references do not match the requested draft.')
  for (const item of feedback) if (item.context.styleId !== draft.styleId || item.scope !== 'style-candidate' || contentDigest(deps.domain.require('feedback', item.id)) !== contentDigest(item)) throw new CuratorError('reference-unavailable', 'analyze', 'Fixed feedback is unavailable or outside this style.')
  const split = ctx.spec.fixed.split === undefined ? undefined : splitSchema.parse(ctx.spec.fixed.split)
  for (const item of feedback) {
    const ids = item.subject.kind === 'pair' ? [item.subject.leftImageVersionId, item.subject.rightImageVersionId] : [item.subject.imageVersionId]
    for (const id of ids) {
      const { asset } = deps.domain.authorizedImage(id, runActor(ctx))
      deps.domain.assertLearningFamily(asset.familyId)
      if (split?.assignments.some(assignment => deps.domain.familyOf(assignment.familyId) === asset.familyId && assignment.split === 'holdout')) throw new CuratorError('constraint-conflict', 'analyze', 'Holdout feedback cannot be used for rule induction.')
    }
  }
  let checkpoint = checkpointSchema.parse(dataOf(ctx.current()).checkpoint)
  if (ctx.spec.fixed.reuseAnalysis && !checkpoint.analysisDoneImageIds.length) {
    const reuse = z.object({ runId: z.string() }).parse(ctx.spec.fixed.reuseAnalysis), source = deps.domain.require('run', reuse.runId), fixed = specOf(source)
    if (source.status !== 'failed' || contentDigest(source.owner) !== contentDigest(ctx.current().owner) || fixed.kind !== 'analyze' || fixed.input.buildDataset !== true
      || contentDigest(fixed.fixed.references) !== contentDigest(references) || contentDigest(fixed.fixed.feedback) !== contentDigest(feedback)
      || recipeSchema.parse(fixed.fixed.recipe).visionRevision !== recipe.visionRevision) throw new CuratorError('reference-unavailable', 'analyze', 'The reusable observation snapshot does not match this analysis.')
    const ids = checkpointSchema.parse(dataOf(source).checkpoint).analysisResultIds.filter(id => deps.domain.repository.get('observation', id))
    const observations = ids.map(id => deps.domain.require('observation', id))
    if (observations.length !== references.length || references.some(ref => observations.filter(row => row.imageVersionId === ref.imageVersionId).length !== 1)) throw new CuratorError('reference-unavailable', 'analyze', 'The saved analysis does not cover every current reference.')
    for (const reference of references) await deps.files.verifyReference(deps.domain.authorizedImage(reference.imageVersionId, runActor(ctx)).image.blob, ctx.signal)
    checkpoint = { ...checkpoint, analysisDoneImageIds: references.map(ref => ref.imageVersionId), analysisResultIds: ids }
    await ctx.save('reviewing', { checkpoint: { ...dataOf(ctx.current()).checkpoint, ...checkpoint }, counts: { observed: references.length, suggestions: 0 }, warnings: ['Reused committed observations from matching references; only cross-image organization is repeated.'] })
  }
  const provider = await deps.vision(ctx.spec.config)
  const maxImages = Math.min(recipe.referenceStrategy.maxImages, ctx.spec.config.limits.maxReferenceImages)
  const maxBytes = Math.min(recipe.referenceStrategy.maxBytes, ctx.spec.config.limits.maxReferenceBytes)
  const pending: { image: ImageVersion; role: string }[] = []
  for (const reference of [...references].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    if (checkpoint.analysisDoneImageIds.includes(reference.imageVersionId) || pending.some(p => p.image.id === reference.imageVersionId)) continue
    const { image, asset } = deps.domain.authorizedImage(reference.imageVersionId, runActor(ctx))
    deps.domain.assertLearningFamily(asset.familyId)
    if (split?.assignments.some(a => deps.domain.familyOf(a.familyId) === asset.familyId && a.split === 'holdout')) throw new CuratorError('constraint-conflict', 'analyze', 'Holdout families cannot be used for rule induction.')
    if (image.blob.byteLength > maxBytes) throw new CuratorError('constraint-conflict', 'analyze', 'A reference image exceeds the fixed review bundle byte limit.')
    const judgments = feedback.filter(item => reference.feedbackThreadIds.includes(item.threadId)).map(item => ({ feedbackId: item.id, judgment: item.judgment, context: item.context }))
    pending.push({ image, role: JSON.stringify({ originalIntent: { role: reference.role, intent: reference.intent }, context: reference.context, judgments }) })
  }
  if (!references.length) throw new CuratorError('invalid-input', 'analyze', 'Choose at least one learning reference before analysis.')
  while (pending.length) {
    const batch: { image: ImageVersion; pixels: VisionImage }[] = []
    let bytes = 0
    while (pending.length && batch.length < maxImages && bytes + pending[0]!.image.blob.byteLength <= maxBytes) {
      // 每批才读取本地原图，取消时不预读后续图片，也不同时保留整集 Buffer。
      ctx.signal.throwIfAborted()
      const item = pending.shift()!
      batch.push({ image: item.image, pixels: await imagePixels(deps, item.image, item.role, ctx) }); bytes += item.image.blob.byteLength
    }
    const requestId = `analysis-${contentDigest({ runId: ctx.runId, imageIds: batch.map(i => i.image.id), recipe: recipe.id }).slice(10, 50)}`
    const input: VisionInput = { requestId, taskBrief: JSON.stringify({ instruction: 'Analyze only the selected reference dimensions. Describe color palette and saturation, light direction and contrast, material and grain, composition and negative space, density and depth. Separate subject content from style unless subject is selected. Record uncertainty, never infer hidden facts. Use the fixed human judgments; original import intent is historical context and does not override revised judgments. Return observations and unconfirmed rule suggestions. Write descriptions in Simplified Chinese.', styleId: draft.styleId, draftRevision: draft.revision, applicableFeedback: feedback }), rules: draft.rules, images: batch.map(i => i.pixels) }
    const cached = savedResponse(deps, ctx, requestId)
    const descriptor = cached?.descriptor ?? toJson(provider.describeRequest(input, 'analyze'))
    ctx.report({ phase: 'analyzing', imageIds: batch.map(item => item.image.id), batch: Math.floor(checkpoint.analysisDoneImageIds.length / maxImages) + 1, resetOutput: true })
    const output = cached ? visionAnalysisSchema.parse(cached.output) : await ctx.request('vision', descriptor, signal => provider.analyze(input, { ...requestBounds(ctx.spec.config, ctx), signal, onOutput: delta => ctx.report({ phase: 'receiving', ...delta }) }))
    ctx.report({ phase: 'validating' })
    const records: CuratorRecord[] = []
    for (const observation of output.observations) {
      const item = batch.find(p => p.image.id === observation.imageVersionId)
      if (!item) throw new CuratorError('vision-invalid-output', 'analyze', 'The analysis refers to an image outside the saved bundle.')
      records.push(observationSchema.parse({ ...recordBase(ctx, 'observation', item.image.id), kind: 'observation', imageVersionId: item.image.id,
        measured: item.image.blob.remoteSource ? [] : [{ field: 'width', value: item.image.geometry.width, method: 'decoded-oriented-pixels', version: item.image.geometry.processorVersion }, { field: 'height', value: item.image.geometry.height, method: 'decoded-oriented-pixels', version: item.image.geometry.processorVersion }, { field: 'byteLength', value: item.image.blob.byteLength, method: 'saved-bytes', version: '1' }],
        inferred: observation.dimensions.map(d => ({ field: d.dimension, value: d.observation, uncertain: d.uncertain, requestId, imageVersionId: item.image.id, ...(d.region ? { region: d.region } : {}) })), corrections: [] }))
    }
    if (ctx.spec.input.buildDataset !== true) for (const [index, rule] of output.suggestedRules.entries()) records.push(suggestionSchema.parse({ ...recordBase(ctx, 'suggestion', { requestId, index }), kind: 'suggestion', status: 'pending', access: ctx.current().owner.kind === 'session' ? { kind: 'session-run', sessionId: runActor(ctx).sessionId } : { kind: 'profile-library' }, author: { kind: 'model', sourceId: recipe.model }, text: JSON.stringify({ ...rule, requestId, draftId: draft.id, draftRevision: draft.revision, recipeId: recipe.id }), feedbackIds: feedback.map(item => item.id) }))
    checkpoint.analysisDoneImageIds.push(...batch.map(p => p.image.id))
    checkpoint.analysisResultIds.push(...records.map(r => r.id))
    await ctx.save('reviewing', { checkpoint: { ...dataOf(ctx.current()).checkpoint, ...checkpoint }, resultIds: checkpoint.analysisResultIds, counts: { observed: checkpoint.analysisDoneImageIds.length, suggestions: deps.domain.repository.list('suggestion').filter(s => checkpoint.analysisResultIds.includes(s.id)).length + records.filter(r => r.kind === 'suggestion').length } }, records)
  }
  if (ctx.spec.input.buildDataset !== true || dataOf(ctx.current()).checkpoint.styleAnalysis !== undefined) return
  const observations = checkpoint.analysisResultIds.flatMap(id => {
    const record = deps.domain.repository.get('observation', id)
    return record ? [record] : []
  })
  const samples = references.map(reference => {
    const { image } = deps.domain.authorizedImage(reference.imageVersionId, runActor(ctx))
    const observation = observations.find(item => item.imageVersionId === image.id)
    if (!observation) throw new CuratorError('vision-invalid-output', 'analyze', 'The analysis is missing an input image observation.')
    return { reference, imageDigest: image.blob.digest, observationId: observation.id, feedbackIds: feedback.filter(item => reference.feedbackThreadIds.includes(item.threadId)).map(item => item.id) }
  })
  // 交替取正反例作为像素复核；归纳输入仍包含所有批次，不能把最后一批当成整个素材集。
  const positive = references.filter(ref => ref.role === 'positive'), negative = references.filter(ref => ref.role === 'negative')
  const ordered = Array.from({ length: Math.max(positive.length, negative.length) }, (_, index) => [positive[index], negative[index]].filter(ref => ref !== undefined)).flat().concat(references.filter(ref => ref.role === 'undecided'))
  const representatives: VisionImage[] = []
  let totalBytes = 0
  for (const reference of ordered) {
    const { image } = deps.domain.authorizedImage(reference.imageVersionId, runActor(ctx))
    if (representatives.some(item => item.imageVersionId === image.id) || representatives.length >= maxImages || totalBytes + image.blob.byteLength > maxBytes) continue
    representatives.push(await imagePixels(deps, image, JSON.stringify({ role: reference.role, intent: reference.intent }), ctx)); totalBytes += image.blob.byteLength
  }
  const requestId = `summary-${contentDigest({ runId: ctx.runId, samples }).slice(10, 50)}`
  const input: VisionInput = { requestId, rules: draft.rules, images: representatives, taskBrief: JSON.stringify({
    instruction: 'Build one reusable style profile from ALL saved per-image observations and human judgments, not just the attached representative images. Positive examples indicate desired traits; negatives are counterexamples, never average them into the target. Undecided examples do not establish preferences. Respect dimension-only intent. Separate subject content from recurring style. Report conflicting substyles and insufficient evidence, cite exact imageVersionIds, and propose only evidence-backed candidate-photo criteria, not image-generation commands. Supply search hints and a matching prompt for a vision API to inspect actual candidate pixels. Also return organization: groups for distinct alternative styles, each with groupId, concise name, description and exact imageVersionIds; selections must contain exactly one entry per suggested rule with zero-based ruleIndex, enabled, nullable groupId and a reason. Use groupId null for shared rules. Enable clear transferable preferences by default; keep unsupported, conflicting or brand-specific content as disabled reference-only hints. Do not invent calibrated confidence scores or treat several angles of one scene as independent support. Groups are alternatives, not simultaneous requirements. Confirmed human rules override these model preferences. Write descriptions in Simplified Chinese.',
    styleId: draft.styleId, applicableFeedback: feedback,
    samples: samples.map(sample => ({ imageVersionId: sample.reference.imageVersionId, role: sample.reference.role, intent: sample.reference.intent, observation: observations.find(item => item.id === sample.observationId) })),
  }) }
  const cached = savedResponse(deps, ctx, requestId)
  ctx.report({ phase: 'summarizing', imageIds: representatives.map(image => image.imageVersionId), resetOutput: true })
  const summary = cached ? styleSummarySchema.parse(cached.output) : await ctx.request('vision', toJson(provider.describeRequest(input, 'summarize')), signal => provider.summarize(input, samples.map(sample => sample.reference.imageVersionId), { ...requestBounds(ctx.spec.config, ctx), signal, onOutput: delta => ctx.report({ phase: 'receiving', ...delta }) }))
  ctx.report({ phase: 'saving' })
  const analysis = styleAnalysisSchema.parse({ formatVersion: 1, runId: ctx.runId, styleId: draft.styleId, draftId: draft.id, draftRevision: draft.revision,
    referenceDigest: analysisReferenceDigest(references, feedback.map(item => item.id)), feedbackIds: feedback.map(item => item.id), recipeId: recipe.id, model: provider.config.model, declaredModelVersion: provider.config.declaredModelVersion ?? null,
    observationPromptVersion: 'visual-curator-v1', summaryPromptVersion: cached ? z.object({ promptVersion: z.enum(['visual-curator-summary-v1', 'visual-curator-summary-v2']) }).parse(cached.descriptor).promptVersion : 'visual-curator-summary-v2', summaryRequestId: requestId, samples, summary })
  const suggestions = summary.suggestedRules.map((rule, index) => suggestionSchema.parse({ ...recordBase(ctx, 'suggestion', { requestId, index }), kind: 'suggestion', status: 'pending', access: ctx.current().owner.kind === 'session' ? { kind: 'session-run', sessionId: runActor(ctx).sessionId } : { kind: 'profile-library' }, author: { kind: 'model', sourceId: recipe.model }, text: JSON.stringify({ ...rule, requestId, draftId: draft.id, draftRevision: draft.revision, recipeId: recipe.id }), feedbackIds: feedback.map(item => item.id) }))
  await ctx.save('finalizing', { checkpoint: { ...dataOf(ctx.current()).checkpoint, styleAnalysis: toJson(analysis) }, resultIds: [...checkpoint.analysisResultIds, ...suggestions.map(item => item.id)], counts: { observed: observations.length, suggestions: suggestions.length, summarized: samples.length } }, suggestions)
}

async function compareImage(deps: DataWorkerDependencies, ctx: WorkContext, provider: CompatibleVisionProvider, image: ImageVersion, standard: StyleRelease | StyleCandidate, side: 'left' | 'right'): Promise<{ verdict: EvaluationReport['items'][number]['left']; records: Assessment[]; budgetExhausted: boolean }> {
  const records: Assessment[] = []
  let verdict: EvaluationReport['items'][number]['left'] = 'pass'
  const usage = usageSchema.parse(ctx.spec.fixed.usage)
  for (const stage of ['source', 'final'] as const) {
    const rules = standard.rules.filter(r => r.stage === stage && (!r.condition.usageRevisionIds || r.condition.usageRevisionIds.includes(usage.id)) && !r.exceptions.some(exception => !exception.subjects?.length && exception.usageRevisionIds?.includes(usage.id)))
    const requestId = `comparison-${contentDigest({ runId: ctx.runId, imageId: image.id, side, stage }).slice(10, 50)}`
    const references: VisionImage[] = []
    let bytes = 0
    for (const snapshot of [...standard.references].sort((a, b) => a.reference.id < b.reference.id ? -1 : 1)) {
      const reference = deps.domain.authorizedImage(snapshot.reference.imageVersionId, runActor(ctx)).image
      if (reference.blob.digest !== snapshot.imageDigest) throw new CuratorError('reference-unavailable', 'evaluate', 'A frozen style reference digest changed.')
      if (reference.id === image.id || references.some(r => r.imageVersionId === reference.id) || references.length >= standard.recipe.referenceStrategy.maxImages || bytes + reference.blob.byteLength > standard.recipe.referenceStrategy.maxBytes) continue
      references.push(await imagePixels(deps, reference, JSON.stringify({ role: snapshot.reference.role, intent: snapshot.reference.intent, judgments: snapshot.judgments }), ctx)); bytes += reference.blob.byteLength
    }
    const input: VisionInput = { requestId, taskBrief: 'Compare the supplied image against this fixed standard and usage. Do not infer acceptance from captions or human labels.', rules: rules.filter(rule => rule.check.kind === 'visual'), stage, images: [await imagePixels(deps, image, 'subject', ctx), ...references], usage: ctx.spec.fixed.usage }
    try {
      const cached = savedResponse(deps, ctx, requestId)
      const descriptor = cached?.descriptor ?? toJson(provider.describeRequest(input, 'review'))
      const reviewed = cached ? visionReviewSchema.parse(cached.output) : await ctx.request('vision', descriptor, signal => provider.review(input, { ...requestBounds(ctx.spec.config, ctx), signal }))
      const results = rules.map(rule => {
        if (rule.check.kind === 'measured') return measuredRule(rule, image)
        const result = reviewed.ruleResults.find(r => r.ruleId === rule.ruleId)
        if (!result) throw new CuratorError('vision-invalid-output', 'evaluate', 'A required rule result is missing.')
        return { ruleId: rule.ruleId, result: result.status === 'not-applicable' ? 'unknown' as const : result.status, basis: 'inferred' as const, reason: result.reason, ...(result.region ? { region: result.region } : {}) }
      })
      let stageVerdict = decideAssessment(results.map(result => ({ strength: rules.find(r => r.ruleId === result.ruleId)!.strength, result: result.result })))
      const missingPreference = Object.entries(standard.recipe.preferenceScale.weights).some(([dimension, weight]) => weight > 0 && !reviewed.preferenceScores.some(score => score.dimension === dimension))
      if ((missingPreference || reviewed.taskRelevance === 'unknown') && stageVerdict === 'pass') stageVerdict = 'needs-review'
      if (reviewed.taskRelevance === 'irrelevant') stageVerdict = 'reject'
      if (stageVerdict === 'reject' || verdict === 'pass' && stageVerdict === 'needs-review') verdict = stageVerdict
      records.push(assessmentSchema.parse({ ...recordBase(ctx, 'assessment', { imageId: image.id, side, stage }), kind: 'assessment', imageVersionId: image.id, runId: ctx.runId, stage, ...(standard.kind === 'release' ? { releaseId: standard.id } : {}), standard: { kind: standard.kind, id: standard.id, contentDigest: standard.contentDigest }, recipeId: standard.recipe.id, reviewBundleId: requestId, technicalStatus: 'completed', verdict: stageVerdict, ruleResults: results, cropPotential: reviewed.cropPotential, preferenceScores: Object.fromEntries(reviewed.preferenceScores.map(s => [s.dimension, s.score])), data: toJson({ side, descriptor, missingPreference }) }))
    } catch (error) {
      ctx.signal.throwIfAborted()
      if (safeFailure(error).code === 'budget-exhausted') return { verdict: 'unprocessed', records, budgetExhausted: true }
      verdict = 'technical-failed'
      records.push(assessmentSchema.parse({ ...recordBase(ctx, 'assessment', { imageId: image.id, side, stage }), kind: 'assessment', imageVersionId: image.id, runId: ctx.runId, stage, ...(standard.kind === 'release' ? { releaseId: standard.id } : {}), standard: { kind: standard.kind, id: standard.id, contentDigest: standard.contentDigest }, recipeId: standard.recipe.id, reviewBundleId: requestId, technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: toJson({ side, error: safeFailure(error) }) }))
      break
    }
  }
  return { verdict, records, budgetExhausted: false }
}

async function evaluate(deps: DataWorkerDependencies, ctx: WorkContext): Promise<'target-met' | 'budget-exhausted'> {
  const left = standardSchema.parse(ctx.spec.fixed.left), right = standardSchema.parse(ctx.spec.fixed.right)
  const split = splitSchema.parse(ctx.spec.fixed.split), usage = usageSchema.parse(ctx.spec.fixed.usage)
  const images = z.array(imageVersionSchema).parse(ctx.spec.fixed.images)
  const fixedFeedback = z.array(feedbackSchema).parse(ctx.spec.fixed.feedback)
  const actor = fixedActor(ctx, 'humanActor')
  deps.domain.assertSplitUsable(split)
  if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'evaluate', 'Comparisons require an authenticated Client request.')
  if (left.id !== ctx.spec.input.leftId || right.id !== ctx.spec.input.rightId || split.id !== ctx.spec.input.splitId || usage.id !== ctx.spec.input.usageRevisionId) throw new CuratorError('constraint-conflict', 'evaluate', 'Comparison inputs do not match the frozen task.')
  for (const manifest of deps.domain.repository.manifests()) {
    const receipt = manifest.receipts[`${ctx.runId}:report`]
    if (!receipt) continue
    const state = receipt.state
    const report = state && !Array.isArray(state) && typeof state === 'object' ? evaluationSchema.safeParse(state.record) : undefined
    if (!report?.success || report.data.left.id !== left.id || report.data.right.id !== right.id || report.data.splitId !== split.id || report.data.usageRevisionId !== usage.id || report.data.budgetDigest !== contentDigest(ctx.spec.config.limits)) throw new CuratorError('constraint-conflict', 'evaluate', 'The committed evaluation does not match this task.')
    await ctx.save('finalizing', { resultIds: [report.data.id] })
    return report.data.executionOutcome === 'budget-exhausted' ? 'budget-exhausted' : 'target-met'
  }
  for (const feedback of fixedFeedback) if (contentDigest(deps.domain.require('feedback', feedback.id)) !== contentDigest(feedback)) throw new CuratorError('reference-unavailable', 'evaluate', 'Frozen feedback changed.')
  const checkpoint = checkpointSchema.parse(dataOf(ctx.current()).checkpoint)
  const provider = await deps.vision(ctx.spec.config)
  const storedRows = z.array(evaluationItemSchema).parse(dataOf(ctx.current()).checkpoint.comparisonRows ?? [])
  const items: EvaluationReport['items'] = images.map(image => {
    const previous = storedRows.find(row => row.imageVersionId === image.id)
    if (previous) return previous
    const labels = fixedFeedback.filter(f => f.subject.kind === 'image' && f.subject.imageVersionId === image.id && f.context.styleId === left.styleId && f.context.usage.kind === 'revision' && f.context.usage.usageRevisionId === usage.id && f.scope === 'style-candidate' && f.labelEligibility === 'confirmed-candidate' && f.judgment.kind === 'style-verdict')
    const values = new Set(labels.flatMap(f => f.judgment.kind === 'style-verdict' ? [f.judgment.value] : []))
    const humanLabel = values.size === 1 ? [...values][0] : undefined
    return { imageVersionId: image.id, ...(humanLabel ? { humanLabel } : {}), left: 'unprocessed', right: 'unprocessed', cropReviewed: false, calls: 0, elapsedMs: 0 }
  })
  let budgetExhausted = false
  for (const image of images) {
    if (checkpoint.evaluationItems.includes(image.id)) continue
    const { asset } = deps.domain.authorizedImage(image.id, actor)
    if (!split.assignments.some(a => deps.domain.familyOf(a.familyId) === asset.familyId && a.split !== 'learning')) throw new CuratorError('constraint-conflict', 'evaluate', 'Comparison images must belong to development or holdout.')
    const item = items.find(row => row.imageVersionId === image.id)!
    const before = ctx.ledger.snapshot().vision, start = performance.now()
    const a = await compareImage(deps, ctx, provider, image, left, 'left')
    const b = a.budgetExhausted ? { verdict: 'unprocessed' as const, records: [], budgetExhausted: true } : await compareImage(deps, ctx, provider, image, right, 'right')
    budgetExhausted = a.budgetExhausted || b.budgetExhausted
    item.left = a.verdict; item.right = b.verdict
    item.calls = ctx.ledger.snapshot().vision - before; item.elapsedMs = performance.now() - start
    checkpoint.evaluationItems.push(image.id)
    await ctx.save('reviewing', { checkpoint: { ...dataOf(ctx.current()).checkpoint, ...checkpoint, comparisonRows: toJson(items) }, counts: { compared: items.filter(i => i.left !== 'unprocessed' && i.right !== 'unprocessed').length, technicalFailed: items.filter(i => i.left === 'technical-failed' || i.right === 'technical-failed').length, unprocessed: items.filter(i => i.left === 'unprocessed' || i.right === 'unprocessed').length } }, [...a.records, ...b.records])
    if (budgetExhausted) break
  }
  const report = await deps.domain.evaluate({ operationId: `${ctx.runId}:report`, executionOutcome: budgetExhausted ? 'budget-exhausted' : 'completed', left: { kind: left.kind, id: left.id, contentDigest: left.contentDigest }, right: { kind: right.kind, id: right.id, contentDigest: right.contentDigest }, splitId: split.id, usageRevisionId: usage.id, recipeId: right.recipe.id, budgetDigest: contentDigest(ctx.spec.config.limits), items, notes: ['Crop generation and independent crop supervision were not part of this image comparison; crop metrics are unavailable.', ...(budgetExhausted ? ['The shared task budget stopped evaluation; every fixed input remains in the report and labeled denominators.'] : [])] }, actor)
  await ctx.save('finalizing', { resultIds: [report.id] })
  return budgetExhausted ? 'budget-exhausted' : 'target-met'
}

async function exportData(deps: DataWorkerDependencies, ctx: WorkContext): Promise<void> {
  if (typeof ctx.spec.input.modelProfileId === 'string') {
    const input = z.object({ operationId: z.string(), modelProfileId: z.string() }).parse(ctx.spec.input)
    const snapshot = await new ModelProfiles(deps.domain).export(deps.domain.require('modelProfile', input.modelProfileId), input.operationId, fixedActor(ctx, 'actor'))
    await ctx.save('finalizing', { resultIds: [snapshot.id], counts: { files: snapshot.files.length, resources: snapshot.resources.length } })
    return
  }
  const input = exportArgsSchema.parse(ctx.spec.input)
  const actor = fixedActor(ctx, 'actor')
  const feedbackIds = z.array(z.string()).parse(ctx.spec.fixed.feedbackHeads)
  const feedback = feedbackIds.map(id => deps.domain.require('feedback', id))
  const snapshot = await deps.domain.createExport({ ...input, feedbackIds }, actor, { feedback })
  await ctx.save('finalizing', { resultIds: [snapshot.id], counts: { files: snapshot.files.length, resources: snapshot.resources.length } })
}

/** @param deps Authorized domain, verified files and fixed-config vision factory. @returns A checkpointed worker for the three data tasks. */
export function createDataWorker(deps: DataWorkerDependencies): Worker {
  return async ctx => {
    switch (ctx.spec.kind) {
      case 'analyze': await analyze(deps, ctx); await new ModelProfiles(deps.domain).adopt(ctx.current(), runActor(ctx), true); break
      case 'evaluate': return await evaluate(deps, ctx)
      case 'export': await exportData(deps, ctx); break
      default: throw new CuratorError('invalid-input', 'data-workflow', 'This worker does not implement the task kind.')
    }
    return 'target-met'
  }
}
