/** Crop execution commits actual derivatives before final review and resumes saved per-image steps. */
import { z } from 'zod'
import { contentDigest } from '../domain/repository.ts'
import type { CuratorDomain } from '../domain/curator.ts'
import { AssetFiles, CompatibleVisionProvider, parseRect, resolveCrop, visionCropProposalSchema, visionReviewSchema } from '../media/index.ts'
import type { VisionImage, VisionInput, VisionRule } from '../media/index.ts'
import { CuratorError } from '../shared/errors.ts'
import { assessmentSchema, cropCandidateSchema, dimensionSchema, humanActorSchema, imageVersionSchema, jsonSchema, styleStandardSchema, selectionSchema, usageSchema } from '../shared/model.ts'
import type { Assessment, CuratorRecord, DomainActor, ImageVersion, Json, Rule, StyleStandard, UsageRevision } from '../shared/model.ts'
import type { CuratorConfig } from './config.ts'
import { dataOf, decideAssessment, rankedSelections, safeFailure, toJson } from './runtime.ts'
import type { WorkContext, Worker } from './runtime.ts'
import { styleReviewBrief, visionImageInput } from './review.ts'

const progressSchema = z.strictObject({
  sourceAssessmentId: z.string().optional(), proposal: visionCropProposalSchema.optional(),
  nextCandidate: z.number().int().nonnegative().default(0), effectiveRegions: z.array(z.string()).default([]),
  candidateIds: z.array(z.string()).default([]),
  generatedCandidates: z.array(cropCandidateSchema).default([]),
  technicalFailures: z.number().int().nonnegative().default(0),
  status: z.enum(['pending', 'passed', 'rejected', 'needs-review', 'technical-failed']).default('pending'),
})
const checkpointSchema = z.object({ cropDoneImageIds: z.array(z.string()).default([]), cropProgress: z.record(z.string(), progressSchema).default({}) })

/** Dependencies share the same authorized domain and immutable blob store as other Host operations. */
export interface CropWorkerDependencies { domain: CuratorDomain; files: AssetFiles; vision: (config: CuratorConfig) => Promise<CompatibleVisionProvider> }

function actorOf(ctx: WorkContext): DomainActor {
  const run = ctx.current()
  return { kind: run.owner.kind === 'session' ? 'agent' : 'human', id: 'visual-curator-run', profileId: run.profileId, ...(run.owner.kind === 'session' ? { sessionId: run.owner.sessionId } : {}) }
}

function recordBase(ctx: WorkContext, prefix: string, identity: unknown) {
  return { schemaVersion: 1 as const, profileId: ctx.current().profileId, id: `${prefix}-${contentDigest({ runId: ctx.runId, identity }).slice(10, 50)}`, createdAt: new Date().toISOString() }
}

function measured(rule: Rule, image: ImageVersion, usage: UsageRevision): Assessment['ruleResults'][number] {
  if (rule.check.kind !== 'measured') throw new Error('Expected a measured rule')
  let result: Assessment['ruleResults'][number]['result']
  if (rule.condition.usageRevisionIds !== undefined && !rule.condition.usageRevisionIds.includes(usage.id)
    || rule.exceptions.some(exception => exception.usageRevisionIds?.includes(usage.id) && !exception.subjects?.length)) result = 'not-applicable'
  else if (rule.condition.subjects?.length || rule.exceptions.some(exception => exception.subjects?.length)) result = 'unknown'
  else {
    const value = rule.check.field === 'width' ? image.geometry.width : rule.check.field === 'height' ? image.geometry.height : rule.check.field === 'aspect' ? image.geometry.width / image.geometry.height : image.blob.byteLength
    result = (rule.check.min !== undefined && value < rule.check.min - rule.check.tolerance) || (rule.check.max !== undefined && value > rule.check.max + rule.check.tolerance) ? 'violated' : 'satisfied'
  }
  return { ruleId: rule.ruleId, result, basis: 'measured', reason: result === 'unknown' ? 'The rule requires subject applicability that pixel geometry cannot determine.' : 'Checked against the stored image bytes and oriented dimensions.' }
}

function usageRules(usage: UsageRevision): VisionRule[] {
  return [
    ...usage.protectedContent.map((statement, index): VisionRule => ({ ruleId: `usage:${usage.id}:protected:${index}`, dimension: 'subject', statement: `Preserve this content in the actual final image: ${statement}`, strength: 'required', stage: 'final' })),
    ...usage.safeRegions.map((region, index): VisionRule => ({ ruleId: `usage:${usage.id}:safe:${index}`, dimension: 'composition', statement: `In final normalized rectangle ${JSON.stringify(region.rect)}, respect this interference constraint: ${region.interference}`, strength: region.strength, stage: 'final' })),
  ]
}

async function pixels(files: AssetFiles, image: ImageVersion, role: string, signal: AbortSignal): Promise<VisionImage> {
  return { imageVersionId: image.id, digest: image.blob.digest, mime: image.blob.mime, bytes: await files.read(image.blob, signal), role }
}

async function referencePixels(deps: CropWorkerDependencies, ctx: WorkContext, release: StyleStandard): Promise<VisionImage[]> {
  const references: VisionImage[] = []
  const maxImages = Math.min(release.recipe.referenceStrategy.maxImages, ctx.spec.config.limits.maxReferenceImages)
  const maxBytes = Math.min(release.recipe.referenceStrategy.maxBytes, ctx.spec.config.limits.maxReferenceBytes)
  let bytes = 0
  for (const snapshot of [...release.references].sort((a, b) => a.reference.id.localeCompare(b.reference.id, 'en'))) {
    const { image } = deps.domain.authorizedImage(snapshot.reference.imageVersionId, actorOf(ctx))
    if (image.blob.digest !== snapshot.imageDigest) throw new CuratorError('reference-unavailable', 'cropping', 'A fixed style reference no longer matches its saved digest.')
    if (references.length >= maxImages || bytes + image.blob.byteLength > maxBytes) continue
    references.push(await visionImageInput(image, deps.files, JSON.stringify({ role: snapshot.reference.role, intent: snapshot.reference.intent, context: snapshot.reference.context, judgments: snapshot.judgments ?? [] }), ctx.signal))
    bytes += image.blob.byteLength
  }
  return references
}

function uniqueImages(images: readonly VisionImage[]): VisionImage[] {
  const seen = new Set<string>()
  return images.filter(image => { if (seen.has(image.imageVersionId)) return false; seen.add(image.imageVersionId); return true })
}

function committedOutput(deps: CropWorkerDependencies, ctx: WorkContext, descriptor: Json): Json | undefined {
  const digest = contentDigest(descriptor)
  const saved = deps.domain.repository.list('request').find(request => request.runId === ctx.runId && request.state === 'committed' && request.requestDigest === digest)
  if (saved === undefined) return undefined
  const envelope = z.object({ output: jsonSchema }).safeParse(saved.data)
  if (!envelope.success) throw new CuratorError('reference-unavailable', 'cropping', 'A committed visual response cannot be reconstructed.')
  return envelope.data.output
}

/** Build a bounded crop worker; only its owning Run commits progress or publishes selections.
 * @param deps Domain, immutable image processing and fixed-config vision factory.
 * @returns A resumable worker that distinguishes visual rejection, uncertainty and technical failure.
 */
export function createCropWorker(deps: CropWorkerDependencies): Worker {
  return async ctx => {
    const release = styleStandardSchema.parse(ctx.spec.fixed.release)
    const usage = usageSchema.parse(ctx.spec.fixed.usage)
    const ids = z.array(z.string().min(1)).min(1).parse(ctx.spec.input.imageVersionIds)
    const taskBrief = styleReviewBrief(release, z.string().min(1).parse(ctx.spec.input.taskBrief))
    const manualRect = ctx.spec.input.manualRect === undefined ? undefined : parseRect(ctx.spec.input.manualRect)
    const allowWarning = ctx.spec.input.allowWarning === true
    const includeInLearning = ctx.spec.input.includeInLearning === true
    if (manualRect !== undefined && (ctx.spec.kind !== 'crop' || !humanActorSchema.safeParse(ctx.spec.fixed.humanConfirmation).success || ids.length !== 1)) throw new CuratorError('owner-denied', 'cropping', 'Manual completion requires a Host-confirmed human action for one image.')
    if (new Set(ids).size !== ids.length || ids.length > ctx.spec.config.limits.maxCandidates) throw new CuratorError('invalid-input', 'cropping', 'Crop inputs must be distinct and within the candidate budget.')
    if (manualRect !== undefined) resolveCrop(manualRect, deps.domain.authorizedImage(ids[0]!, actorOf(ctx)).image.geometry, usage.output)
    const checkpoint = checkpointSchema.parse(dataOf(ctx.current()).checkpoint)
    if (ctx.spec.kind === 'crop' && dataOf(ctx.current()).checkpoint.cropDoneImageIds === undefined) checkpoint.cropDoneImageIds = z.array(z.string()).parse(dataOf(ctx.current()).checkpoint.doneImageIds ?? [])
    const provider = await deps.vision(ctx.spec.config)
    const references = await referencePixels(deps, ctx, release)
    const finalRules: VisionRule[] = [...release.rules.filter(rule => rule.stage === 'final' && rule.check.kind === 'visual'), ...usageRules(usage)]
    const sourceRules = release.rules.filter(rule => rule.stage === 'source' && rule.check.kind === 'visual')
    const warnings = new Set(dataOf(ctx.current()).warnings)
    const allSelections = () => deps.domain.repository.list('selection').filter(selection => selection.runId === ctx.runId)

    const save = async (records: CuratorRecord[] = [], stage: 'cropping' | 'reviewing' | 'finalizing' = 'cropping') => {
      const progress = Object.values(checkpoint.cropProgress)
      const counts = { ...dataOf(ctx.current()).counts,
        ...(ctx.spec.kind === 'crop' ? { retrievedUnique: ids.length, sourceReviewed: progress.filter(p => p.sourceAssessmentId !== undefined).length,
          rejected: progress.filter(p => p.status === 'rejected').length,
          needsReview: progress.filter(p => p.status === 'needs-review').length,
          technicalFailed: progress.filter(p => p.status === 'technical-failed').length,
          pending: ids.length - checkpoint.cropDoneImageIds.length } : {}),
        cropGenerated: progress.reduce((sum, item) => sum + item.generatedCandidates.length, 0),
        finalPassed: allSelections().filter(selection => selection.qualification === 'auto-qualified').length + records.filter(record => record.kind === 'selection' && record.qualification === 'auto-qualified' && !allSelections().some(saved => saved.id === record.id)).length,
        humanSelected: allSelections().filter(selection => selection.qualification === 'human-selected').length + records.filter(record => record.kind === 'selection' && record.qualification === 'human-selected' && !allSelections().some(saved => saved.id === record.id)).length,
      }
      await ctx.save(stage, { checkpoint: z.record(z.string(), jsonSchema).parse(toJson({ ...dataOf(ctx.current()).checkpoint, ...checkpoint, ...(ctx.spec.kind === 'crop' ? { doneImageIds: checkpoint.cropDoneImageIds } : {}) })), counts, warnings: [...warnings], resultIds: [...new Set([...dataOf(ctx.current()).resultIds, ...records.filter(record => record.kind === 'selection').map(record => record.id)])] }, records)
    }

    const review = async (image: ImageVersion, images: VisionImage[], stage: 'source' | 'final', rules: VisionRule[], parentId?: string): Promise<Assessment> => {
      const identity = recordBase(ctx, 'assessment', { imageId: image.id, stage })
      const input: VisionInput = { requestId: identity.id, taskBrief, stage, rules, images: uniqueImages(images), usage: toJson({ ...usage, evaluationRecipe: release.recipe }), protectedContent: usage.protectedContent }
      const descriptor = provider.describeRequest(input, 'review')
      const bundle = toJson(descriptor), replay = committedOutput(deps, ctx, bundle)
      const output = replay === undefined ? await ctx.request('vision', bundle, signal => provider.review(input, { maxBytes: ctx.spec.config.limits.maxResponseBytes, maxRedirects: ctx.spec.config.limits.maxRedirects, timeoutMs: ctx.spec.config.limits.requestTimeoutMs, signal })) : visionReviewSchema.parse(replay)
      const results: Assessment['ruleResults'] = [
        ...output.ruleResults.map(result => {
          const rule = release.rules.find(rule => rule.ruleId === result.ruleId)
          const conditional = rule !== undefined && (rule.condition.subjects?.length || rule.condition.usageRevisionIds?.some(id => id !== usage.id) || rule.exceptions.length > 0)
          return { ruleId: result.ruleId, result: result.status === 'not-applicable' && !conditional ? 'unknown' as const : result.status, basis: 'inferred' as const, reason: result.reason, ...(result.region === undefined ? {} : { region: result.region }) }
        }),
        ...release.rules.filter(rule => rule.stage === stage && rule.check.kind === 'measured').map(rule => measured(rule, image, usage)),
      ]
      const strengths = new Map([...release.rules, ...usageRules(usage)].map(rule => [rule.ruleId, rule.strength]))
      let verdict = decideAssessment(results.map(result => ({ result: result.result, strength: strengths.get(result.ruleId) ?? 'required' })))
      if (output.taskRelevance === 'irrelevant') verdict = 'reject'
      else if (output.taskRelevance === 'unknown' && verdict === 'pass') verdict = 'needs-review'
      const scores: Partial<Record<z.infer<typeof dimensionSchema>, number>> = {}
      for (const score of output.preferenceScores) {
        const dimension = dimensionSchema.safeParse(score.dimension)
        if (!dimension.success) throw new CuratorError('vision-invalid-output', 'reviewing', 'The visual result contains an unsupported scoring dimension.')
        scores[dimension.data] = release.recipe.preferenceScale.min + score.score * (release.recipe.preferenceScale.max - release.recipe.preferenceScale.min)
      }
      if (stage === 'final' && Object.entries(release.recipe.preferenceScale.weights).some(([dimension, weight]) => weight > 0 && !Object.hasOwn(scores, dimension)) && verdict === 'pass') verdict = 'needs-review'
      return assessmentSchema.parse({ ...identity, kind: 'assessment', imageVersionId: image.id, runId: ctx.runId, stage, releaseId: release.id, recipeId: release.recipe.id, reviewBundleId: identity.id, technicalStatus: 'completed', verdict, ruleResults: results, cropPotential: output.cropPotential, preferenceScores: scores, data: toJson({ requestId: descriptor.requestId, taskRelevance: output.taskRelevance, ...(parentId === undefined ? {} : { parentImageVersionId: parentId }) }) })
    }

    for (const imageId of ids) {
      if (checkpoint.cropDoneImageIds.includes(imageId)) continue
      ctx.signal.throwIfAborted()
      const state = checkpoint.cropProgress[imageId] ?? progressSchema.parse({})
      checkpoint.cropProgress[imageId] = state
      const parent = deps.domain.authorizedImage(imageId, actorOf(ctx)).image
      if (parent.versionKind === 'preview') throw new CuratorError('constraint-conflict', 'cropping', 'An analysis preview cannot establish the original pixels required for a final crop.')
      const parentPixels = await pixels(deps.files, parent, 'original', ctx.signal)
      try {
        let sourceAssessment = state.sourceAssessmentId === undefined ? undefined : deps.domain.require('assessment', state.sourceAssessmentId)
        // 搜索已经审核同一原图及固定标准；裁图沿用这条已提交源审，终审仍检查实际裁后像素。
        if (sourceAssessment === undefined && ctx.spec.kind === 'search') {
          sourceAssessment = deps.domain.repository.list('assessment').find(item => item.runId === ctx.runId && item.imageVersionId === imageId && item.stage === 'source'
            && item.technicalStatus === 'completed' && item.recipeId === release.recipe.id && item.standard?.id === release.id && item.standard.contentDigest === release.contentDigest)
          if (sourceAssessment) { state.sourceAssessmentId = sourceAssessment.id; await save([], 'reviewing') }
        }
        if (sourceAssessment === undefined) {
          sourceAssessment = await review(parent, [parentPixels, ...references], 'source', sourceRules)
          state.sourceAssessmentId = sourceAssessment.id
          await save([sourceAssessment], 'reviewing')
        }
        if (sourceAssessment.verdict === 'reject' && manualRect === undefined) {
          state.status = 'rejected'; checkpoint.cropDoneImageIds.push(imageId); await save(); continue
        }
        if (state.proposal === undefined) {
          if (manualRect !== undefined) {
            resolveCrop(manualRect, parent.geometry, usage.output)
            state.proposal = { feasibility: 'feasible', reason: 'The human explicitly completed this requested region; visual preservation still requires review.', candidates: [{ requestedRect: manualRect, reason: 'Explicit manual crop completion.', protectedContent: 'unknown' }] }
          } else {
            const identity = recordBase(ctx, 'proposal', imageId)
            const input: VisionInput = { requestId: identity.id, taskBrief, rules: release.rules, images: uniqueImages([parentPixels, ...references]), usage: toJson({ ...usage, evaluationRecipe: release.recipe }), protectedContent: usage.protectedContent, maxCropCandidates: ctx.spec.config.limits.maxCropCandidatesPerImage }
            const descriptor = provider.describeRequest(input, 'propose-crop')
            const bundle = toJson(descriptor), replay = committedOutput(deps, ctx, bundle)
            state.proposal = replay === undefined ? await ctx.request('vision', bundle, signal => provider.proposeCrop(input, { maxBytes: ctx.spec.config.limits.maxResponseBytes, maxRedirects: ctx.spec.config.limits.maxRedirects, timeoutMs: ctx.spec.config.limits.requestTimeoutMs, signal })) : visionCropProposalSchema.parse(replay)
          }
          await save()
        }
        for (; state.nextCandidate < state.proposal.candidates.length;) {
          ctx.signal.throwIfAborted()
          const index = state.nextCandidate
          const proposed = state.proposal.candidates[index]
          if (proposed === undefined) throw new Error('Missing parsed crop candidate')
          const candidateBase = recordBase(ctx, 'crop', { imageId, index })
          let candidate = deps.domain.repository.get('cropCandidate', candidateBase.id) ?? state.generatedCandidates.find(saved => saved.id === candidateBase.id)
          let derivative: ImageVersion | undefined
          try {
            if (candidate?.derivedImageVersionId !== undefined) derivative = deps.domain.require('imageVersion', candidate.derivedImageVersionId)
            else {
              let geometry: ReturnType<typeof resolveCrop>
              try { geometry = resolveCrop(proposed.requestedRect, parent.geometry, usage.output) } catch (error) {
                const failure = safeFailure(error)
                candidate = cropCandidateSchema.parse({ ...candidateBase, kind: 'cropCandidate', parentImageVersionId: imageId, runId: ctx.runId, releaseId: release.id, usageRevisionId: usage.id, recipeId: release.recipe.id, requestedRect: proposed.requestedRect, geometryResult: 'failed', origin: manualRect === undefined ? 'model' : 'human', data: toJson({ error: failure, reason: proposed.reason }) })
                state.nextCandidate++; state.candidateIds.push(candidate.id); await save([candidate]); continue
              }
              const effectiveKey = JSON.stringify(geometry.effectivePixelRect)
              if (state.effectiveRegions.includes(effectiveKey)) { state.nextCandidate++; await save(); continue }
              const cropped = await deps.files.crop(parent.blob, parent.geometry, proposed.requestedRect, usage.output, ctx.signal)
              const effectivePixelRect = { x: cropped.effectivePixelRect.left, y: cropped.effectivePixelRect.top, width: cropped.effectivePixelRect.width, height: cropped.effectivePixelRect.height }
              derivative = imageVersionSchema.parse({ ...recordBase(ctx, 'image', candidateBase.id), kind: 'imageVersion', assetId: parent.assetId, versionKind: 'crop', parentImageVersionId: imageId, blob: cropped.blob, geometry: { width: cropped.width, height: cropped.height, colorSpace: cropped.colorSpace, sourceOrientation: 1, processorVersion: cropped.processorVersion }, processing: { recipeDigest: cropped.processing.recipeDigest, processorVersion: cropped.processorVersion, sourceDigest: parent.blob.digest, requestedRect: cropped.requestedRect, effectivePixelRect, encoding: cropped.blob.mime, outputWidth: cropped.width, outputHeight: cropped.height } })
              candidate = cropCandidateSchema.parse({ ...candidateBase, kind: 'cropCandidate', parentImageVersionId: imageId, runId: ctx.runId, releaseId: release.id, usageRevisionId: usage.id, recipeId: release.recipe.id, requestedRect: proposed.requestedRect, effectivePixelRect, geometryResult: 'pass', origin: manualRect === undefined ? 'model' : 'human', derivedImageVersionId: derivative.id, data: toJson({ reason: proposed.reason, proposedProtectedContent: proposed.protectedContent, feasibility: state.proposal.feasibility, algorithm: cropped.processing.algorithm, ...(manualRect === undefined ? {} : { humanConfirmation: ctx.spec.fixed.humanConfirmation, includeInLearningRequested: includeInLearning, learningConfirmation: 'pending-actual-image-view' }) }) })
              state.effectiveRegions.push(effectiveKey); state.generatedCandidates.push(candidate)
              await save([derivative])
            }
            if (candidate === undefined || derivative === undefined) throw new Error('Crop generation did not produce records')
            if (candidate.finalAssessmentId === undefined) {
              const result = await review(derivative, [await pixels(deps.files, derivative, 'actual-final-crop', ctx.signal), parentPixels, ...references], 'final', finalRules, imageId)
              candidate = { ...candidate, finalAssessmentId: result.id }
              state.candidateIds.push(candidate.id)
              await save([result, candidate], 'reviewing')
            }
          } catch (error) {
            if (ctx.signal.aborted) throw error
            const failure = safeFailure(error)
            if (failure.code === 'budget-exhausted') throw error
            state.technicalFailures++
            warnings.add(`Crop candidate ${candidateBase.id} could not complete: ${failure.code}.`)
            const assessment = assessmentSchema.parse({ ...recordBase(ctx, 'assessment-failed', { imageId, index }), kind: 'assessment', imageVersionId: derivative?.id ?? imageId, runId: ctx.runId, stage: 'final', releaseId: release.id, recipeId: release.recipe.id, reviewBundleId: candidateBase.id, technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: toJson({ error: failure }) })
            if (candidate !== undefined && candidate.geometryResult === 'pass') { candidate = { ...candidate, finalAssessmentId: assessment.id }; state.candidateIds.push(candidate.id) }
            await save(candidate === undefined ? [assessment] : [assessment, candidate], 'reviewing')
          }
          state.nextCandidate++; await save()
        }
        const assessed = state.candidateIds.flatMap(id => {
          const candidate = deps.domain.require('cropCandidate', id)
          if (candidate.finalAssessmentId === undefined || candidate.derivedImageVersionId === undefined) return []
          return [{ candidate, assessment: deps.domain.require('assessment', candidate.finalAssessmentId), imageVersionId: candidate.derivedImageVersionId }]
        })
        const qualified = assessed.filter(item => item.assessment.technicalStatus === 'completed' && (manualRect !== undefined && allowWarning || item.assessment.verdict === 'pass' && sourceAssessment.verdict === 'pass' && state.proposal?.feasibility === 'feasible'))
        const ranked = rankedSelections(qualified.map(item => ({ ...item, id: item.imageVersionId, score: Object.entries(release.recipe.preferenceScale.weights).reduce((sum, [dimension, weight]) => sum + (item.assessment.preferenceScores[dimensionSchema.parse(dimension)] ?? 0) * weight, 0) })))
        const best = ranked[0]
        if (best !== undefined) {
          const selectionWarnings = manualRect === undefined ? [] : [
            ...(sourceAssessment.verdict === 'pass' ? [] : [`The source image requires attention: ${sourceAssessment.verdict ?? sourceAssessment.technicalStatus}.`]),
            ...(best.assessment.verdict === 'pass' ? [] : [`The actual manual crop requires attention: ${best.assessment.verdict ?? best.assessment.technicalStatus}.`]),
            ...(includeInLearning ? ['Learning confirmation is pending display and explicit confirmation of the actual derived image.'] : []),
          ]
          const selection = selectionSchema.parse({ ...recordBase(ctx, 'selection', imageId), kind: 'selection', runId: ctx.runId, imageVersionId: best.imageVersionId, assessmentId: best.assessment.id, qualification: manualRect === undefined ? 'auto-qualified' : 'human-selected', rank: allSelections().length, warnings: selectionWarnings })
          state.status = 'passed'; checkpoint.cropDoneImageIds.push(imageId); await save([selection], 'finalizing')
        } else {
          state.status = sourceAssessment.verdict === 'needs-review' || state.proposal.feasibility === 'needs-review' || assessed.some(item => item.assessment.verdict === 'needs-review') ? 'needs-review' : state.technicalFailures > 0 && assessed.length === 0 ? 'technical-failed' : 'rejected'
          checkpoint.cropDoneImageIds.push(imageId); await save()
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error
        const failure = safeFailure(error)
        if (failure.code === 'budget-exhausted') { warnings.add('The fixed crop budget ended before all inputs completed.'); await save([], 'finalizing'); return 'budget-exhausted' }
        state.status = 'technical-failed'
        warnings.add(`Image ${imageId} could not complete: ${failure.code}.`)
        const assessment = assessmentSchema.parse({ ...recordBase(ctx, 'source-failed', imageId), kind: 'assessment', imageVersionId: imageId, runId: ctx.runId, stage: 'source', releaseId: release.id, recipeId: release.recipe.id, reviewBundleId: ctx.runId, technicalStatus: 'failed', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: toJson({ error: failure }) })
        checkpoint.cropDoneImageIds.push(imageId); await save([assessment])
      }
    }
    await save([], 'finalizing')
    if (allSelections().length >= ids.length) return 'target-met'
    return Object.values(checkpoint.cropProgress).some(progress => progress.status === 'technical-failed') ? 'partial-failure' : 'source-exhausted'
  }
}

/** Reuse crop execution inside search with its original Run, quota ledger and saved release.
 * @param deps Shared domain/media/vision dependencies.
 * @returns Per-image processor; budget exhaustion remains an explicit outcome for the search owner.
 */
export function createCropProcessor(deps: CropWorkerDependencies): (ctx: WorkContext, imageVersionId: string, release: StyleStandard, usage: UsageRevision) => Promise<'target-met' | 'source-exhausted' | 'budget-exhausted' | 'partial-failure'> {
  const worker = createCropWorker(deps)
  return async (ctx, imageVersionId, release, usage) => await worker({ ...ctx, spec: { ...ctx.spec, input: { ...ctx.spec.input, imageVersionIds: [imageVersionId] }, fixed: { ...ctx.spec.fixed, release: toJson(release), usage: toJson(usage) } } })
}
