/** Host-owned style, feedback and dataset operations over manifest commits. */
import { z } from 'zod'
import {
  recordSchema, ruleSchema, recipeSchema, curatorId, feedbackContextSchema, subjectSchema, judgmentSchema, viewEvidenceSchema,
  usageOutputSchema, normalizedRectSchema, evaluationItemSchema, standardRefSchema,
  type DomainActor, type HumanActor, type CuratorRecord, type RecordKind, type RecordOf, type Json,
  type Style, type StyleDraft, type StyleCandidate, type StyleRelease, type ReferenceSnapshot, type HumanFeedback,
  type FeedbackThread, type UsageRevision, type Asset, type ImageVersion, type SplitManifest, type EvaluationReport,
  type ExportSnapshot, type EvaluationRecipe, type Reference,
} from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { DomainRepository, contentDigest, openCuratorRepository } from './repository.ts'
import { evaluationMetrics } from './evaluation.ts'
import { renderExportFiles, supervisionExclusion } from './export.ts'
import { styleAnalysisOf } from '../shared/style-analysis.ts'
import { ModelProfiles } from './model-profile.ts'
import type { StyleStandard } from '../shared/model.ts'

const op = { operationId: z.string().min(1).max(256) }
const styleMutation = { ...op, styleId: z.string().min(1), expectedRevision: z.number().int().positive() }
const styleCreateSchema = z.strictObject({ ...op, name: z.string().min(1) })
const draftSaveSchema = z.strictObject({ ...styleMutation, rules: z.array(ruleSchema), referenceIds: z.array(z.string()), feedbackIds: z.array(z.string()), conflicts: z.array(z.strictObject({ id: z.string(), ruleIds: z.array(z.string()), reason: z.string(), resolved: z.boolean() })), recipeId: z.string().optional(), recipe: recipeSchema.optional(), status: z.enum(['editing', 'ready']).optional() })
const candidateCreateSchema = z.strictObject({ ...styleMutation, recipeId: z.string().optional(), recipe: recipeSchema.optional() })
const publishSchema = z.strictObject({ ...styleMutation, candidateId: z.string(), evaluationIds: z.array(z.string()).optional(), changeSummary: z.string().optional() })
const defaultSchema = z.strictObject({ ...styleMutation, releaseId: z.string() })
const archiveSchema = z.strictObject(styleMutation)
const usageCreateSchema = z.strictObject({ ...op, presetId: z.string().optional(), name: z.string().min(1), output: usageOutputSchema, safeRegions: z.array(z.strictObject({ rect: normalizedRectSchema, interference: z.string(), strength: z.enum(['required', 'preferred']) })), protectedContent: z.array(z.string()) })
const feedbackInputSchema = z.strictObject({ ...op, subject: subjectSchema, context: feedbackContextSchema, judgment: judgmentSchema, viewEvidence: viewEvidenceSchema, scope: z.enum(['task-only', 'style-candidate']).optional(), reasonCodes: z.array(z.string()).optional(), comment: z.string().optional(), expectedHead: z.string().nullable() })
const suggestionInputSchema = z.strictObject({ ...op, text: z.string().min(1), feedbackIds: z.array(z.string()).optional(), context: feedbackContextSchema.optional() })
const referenceInputSchema = z.strictObject({ ...op, styleId: z.string(), imageVersionId: z.string(), role: z.enum(['positive', 'negative', 'undecided']), intent: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('overall') }), z.strictObject({ kind: z.literal('dimensions'), dimensions: z.array(z.enum(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'])).min(1) })]), context: z.strictObject({ subjects: z.array(z.string()).optional(), usageRevisionId: z.string().optional() }), viewEvidence: viewEvidenceSchema })
const splitInputSchema = z.strictObject({ ...op, assignments: z.array(z.strictObject({ familyId: z.string(), split: z.enum(['learning', 'development', 'holdout']), groupingConfirmed: z.literal(true) })), supersedesSplitId: z.string().optional(), uses: z.array(z.strictObject({ familyId: z.string(), purpose: z.enum(['revealed', 'evaluation', 'learning']), at: z.string().datetime({ offset: true }) })).optional() })
const familyInputSchema = z.strictObject({ ...op, familyIds: z.array(z.string()).min(1) })
const evaluationInputSchema = z.strictObject({ ...op, executionOutcome: z.enum(['completed', 'budget-exhausted']).optional(), left: standardRefSchema, right: standardRefSchema, splitId: z.string(), usageRevisionId: z.string(), recipeId: z.string(), budgetDigest: z.string(), items: z.array(evaluationItemSchema), assessment: z.enum(['unassessed', 'accepted', 'rejected']).optional(), notes: z.array(z.string()).optional() })
const exportInputSchema = z.strictObject({ ...op, exportKind: z.enum(['style', 'classification', 'preference', 'crop', 'skill']), purpose: z.enum(['training', 'development', 'holdout', 'reference']), releaseId: z.string(), usageRevisionId: z.string().optional(), splitId: z.string(), feedbackIds: z.array(z.string()).optional(), imageVersionIds: z.array(z.string()).optional(), mode: z.enum(['references-only', 'with-bytes']).optional(), analysisRunId: z.string().optional() })

/** All locally stored workspace data; Session resources are filtered by the supplied Host actor. */
export interface CuratorSnapshot {
  styles: Style[]; drafts: StyleDraft[]; references: Reference[]; usages: UsageRevision[]; feedback: HumanFeedback[]
  candidates: StyleCandidate[]; releases: StyleRelease[]; suggestions: RecordOf<'suggestion'>[]; splits: SplitManifest[]
  evaluations: EvaluationReport[]; exports: ExportSnapshot[]; recipes: EvaluationRecipe[]
}
/** Integrity is supplied by the media owner; absent verifier forbids claims about readability. */
export interface CuratorDomainOptions {
  now?: () => string
  verifyImage?: (image: ImageVersion) => Promise<void>
  close?: () => Promise<void>
}

/** One profile's domain service; Client actions and Agent suggestions share these operations. */
export class CuratorDomain {
  private readonly now: () => string
  /** @param profileId Owning profile. @param repository Manifest-backed store. @param options Clock, media integrity and lifecycle. */
  constructor(readonly profileId: string, readonly repository: DomainRepository, private readonly options: CuratorDomainOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString())
  }
  /** @param operation Closed operation name. @param args Untrusted Client/Agent JSON. @param actor Host-created identity. @returns A durable result or typed failure. */
  async action(operation: string, args: unknown, actor: DomainActor): Promise<Json> {
    this.assertActor(actor)
    try {
      switch (operation) {
        case 'style-create': return toJson(await this.createStyle(styleCreateSchema.parse(args), actor))
        case 'draft-save': return toJson(await this.saveDraft(draftSaveSchema.parse(args), actor))
        case 'candidate-create': return toJson(await this.createCandidate(candidateCreateSchema.parse(args), actor))
        case 'style-publish': case 'release-publish': return toJson(await this.publishStyle(publishSchema.parse(args), actor))
        case 'style-default': case 'default-set': return toJson(await this.setDefault(defaultSchema.parse(args), actor))
        case 'style-archive': return toJson(await this.archiveStyle(archiveSchema.parse(args), actor))
        case 'usage-save': case 'usage-create': return toJson(await this.createUsage(usageCreateSchema.parse(args), actor))
        case 'reference-confirm': return toJson(await this.confirmReference(referenceInputSchema.parse(args), actor))
        case 'feedback-confirm': return toJson(await this.confirmFeedback(feedbackInputSchema.parse(args), actor))
        case 'feedback-suggest': return toJson(await this.addSuggestion(suggestionInputSchema.parse(args), actor))
        case 'split-save': case 'split-create': return toJson(await this.createSplit(splitInputSchema.parse(args), actor))
        case 'family-confirm': return toJson(await this.confirmFamilies(familyInputSchema.parse(args), actor))
        case 'family-merge': return toJson(await this.mergeFamilies(familyInputSchema.parse(args), actor))
        case 'evaluate-report': return toJson(await this.evaluate(evaluationInputSchema.parse(args), actor))
        case 'export-create': case 'export-start': return toJson(await this.createExport(exportInputSchema.parse(args), actor))
        default: throw new CuratorError('invalid-input', 'domain-action', 'Unknown Visual Curator operation.')
      }
    } catch (error) {
      if (error instanceof z.ZodError) throw new CuratorError('invalid-input', operation, 'Input does not match the operation schema.', { cause: error })
      throw error
    }
  }
  /** @param actor Host-created identity. @returns Only authorized committed records. */
  snapshot(actor: DomainActor): CuratorSnapshot {
    this.assertActor(actor)
    const feedback = this.repository.list('feedbackThread').map(thread => this.require('feedback', thread.headFeedbackId)).filter(f => this.canReadFeedback(f, actor))
    return { styles: this.repository.list('style'), drafts: this.repository.list('draft'), references: this.repository.list('reference').filter(r => this.canReadImage(r.imageVersionId, actor)), usages: this.repository.list('usage'), feedback, candidates: this.repository.list('candidate'), releases: this.repository.list('release'), suggestions: this.repository.list('suggestion').filter(s => (s.access?.kind !== 'session-run' || s.access.sessionId === actor.sessionId) && (s.context?.runId === undefined || this.canReadRun(s.context.runId, actor))), splits: this.repository.list('split'), evaluations: this.repository.list('evaluation').filter(e => e.items.every(i => this.canReadImage(i.imageVersionId, actor))), exports: this.repository.list('export').filter(e => (e.access.kind !== 'session-run' || e.access.sessionId === actor.sessionId) && e.resources.every(r => this.canReadImage(r.imageVersionId, actor))), recipes: this.repository.list('recipe') }
  }
  /** @param kind Record tag. @param id Committed ID. @returns Record or a safe missing-reference error. */
  require<K extends RecordKind>(kind: K, id: string): RecordOf<K> {
    const record = this.repository.get(kind, id)
    if (!record) throw new CuratorError('reference-unavailable', 'reference-check', `The requested ${kind} is unavailable.`)
    return record
  }
  /** @param id Pixel version. @param actor Host-created identity. @returns Authorized image and asset. */
  authorizedImage(id: string, actor: DomainActor): { image: ImageVersion; asset: Asset } {
    this.assertActor(actor)
    const image = this.require('imageVersion', id)
    const asset = this.require('asset', image.assetId)
    if (asset.access.kind === 'session-run' && asset.access.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'authorization', 'This image belongs to another Session.')
    return { image, asset: { ...asset, familyId: this.familyOf(asset.familyId) } }
  }
  /** Resolve a committed standard once; an empty default never selects a draft. */
  resolveRelease(styleId: string, releaseId: string | undefined): StyleStandard {
    const style = this.require('style', styleId)
    if (style.archived) throw new CuratorError('constraint-conflict', 'resolve', 'Archived styles cannot start new tasks.')
    const selected = releaseId ?? style.defaultReleaseId ?? new ModelProfiles(this).current(styleId)?.id
    if (selected === null || selected === undefined) throw new CuratorError('invalid-input', 'resolve', 'Select a published release; this style has no default.')
    const profile = this.repository.get('modelProfile', selected)
    if (profile) {
      if (profile.styleId !== styleId) throw new CuratorError('owner-denied', 'resolve', 'The model profile belongs to another style.')
      return profile
    }
    const release = this.require('release', selected)
    if (release.styleId !== styleId || !style.committedReleaseIds.includes(release.id)) throw new CuratorError('owner-denied', 'resolve', 'The release belongs to another style.')
    return release
  }
  /** @param release Fixed standard. @param actor Host-created identity. @returns Completion after every reference byte is verified. */
  async verifyRelease(release: StyleStandard, actor: DomainActor): Promise<void> {
    if (release.kind === 'modelProfile') new ModelProfiles(this).assertFresh(release, actor)
    for (const ref of release.references) {
      const { image } = this.authorizedImage(ref.reference.imageVersionId, actor)
      if (image.blob.digest !== ref.imageDigest) throw new CuratorError('reference-unavailable', 'resolve', 'A fixed reference digest does not match.')
      await this.verifyImage(image)
    }
  }
  async createStyle(input: z.infer<typeof styleCreateSchema>, actor: DomainActor): Promise<Style> {
    this.human(actor)
    const replay = this.recover('style', input, actor)
    if (replay) return replay
    const id = this.id('style', input.operationId)
    const draftId = this.id('draft', input.operationId)
    const style: Style = { ...this.base('style', id), name: input.name, archived: false, draftId, revision: 1, committedReleaseIds: [], defaultReleaseId: null, nextReleaseNumber: 1 }
    const draft: StyleDraft = { ...this.base('draft', draftId), styleId: id, revision: 1, status: 'editing', rules: [], referenceIds: [], feedbackIds: [], conflicts: [] }
    await this.repository.commit({ aggregateId: `style:${id}`, expectedRevision: 0, operationId: input.operationId, request: input, records: [style, draft], state: { id, record: toJson(style) } })
    return this.require('style', id)
  }
  async saveDraft(input: z.infer<typeof draftSaveSchema>, actor: DomainActor): Promise<StyleDraft> {
    this.human(actor)
    const replay = this.recover('draft', input, actor)
    if (replay) return replay
    const style = this.require('style', input.styleId)
    const current = this.require('draft', style.draftId)
    for (const referenceId of input.referenceIds) {
      const reference = this.require('reference', referenceId)
      if (reference.styleId !== style.id) throw new CuratorError('owner-denied', 'draft-save', 'Reference belongs to another style.')
      this.authorizedImage(reference.imageVersionId, actor)
    }
    for (const feedbackId of input.feedbackIds) {
      const feedback = this.require('feedback', feedbackId)
      if (feedback.context.styleId !== style.id || feedback.scope !== 'style-candidate') throw new CuratorError('constraint-conflict', 'draft-save', 'Feedback has not been confirmed for this style.')
      if (!this.canReadFeedback(feedback, actor)) throw new CuratorError('owner-denied', 'draft-save', 'Feedback is outside this Session.')
    }
    const recipeId = input.recipe?.id ?? input.recipeId ?? current.recipeId
    if (recipeId && !input.recipe) this.require('recipe', recipeId)
    const draft: StyleDraft = { ...current, revision: current.revision + 1, rules: input.rules.map(rule => rule.confirmation.status === 'confirmed' ? { ...rule, confirmation: { status: 'confirmed', actor: this.human(actor) } } : rule), referenceIds: [...new Set(input.referenceIds)], feedbackIds: [...new Set(input.feedbackIds)], conflicts: input.conflicts, status: input.status ?? 'editing', ...(recipeId === undefined ? {} : { recipeId }) }
    await this.styleCommit(style, input, [draft, ...(input.recipe ? [input.recipe] : [])], { id: draft.id })
    return this.require('draft', draft.id)
  }
  async createCandidate(input: z.infer<typeof candidateCreateSchema>, actor: DomainActor): Promise<StyleCandidate> {
    this.human(actor)
    const replay = this.recover('candidate', input, actor)
    if (replay) return replay
    const style = this.require('style', input.styleId)
    const draft = this.require('draft', style.draftId)
    this.publishable(draft)
    const recipeId = input.recipe?.id ?? input.recipeId ?? draft.recipeId
    if (!recipeId) throw new CuratorError('configuration-required', 'candidate-create', 'Select an evaluation recipe before calibration.')
    const recipe = input.recipe ?? this.require('recipe', recipeId)
    this.repository.assertProfile(recipe.profileId)
    const references = await this.referenceSnapshots(draft, actor)
    const content = { styleId: style.id, draftId: draft.id, draftRevision: draft.revision, rules: draft.rules, references, recipe }
    const candidate: StyleCandidate = { ...this.base('candidate', this.id('candidate', input.operationId)), ...content, contentDigest: contentDigest(content) }
    await this.styleCommit(style, input, [candidate, ...(input.recipe ? [recipe] : [])], { id: candidate.id })
    return this.require('candidate', candidate.id)
  }
  async publishStyle(input: z.infer<typeof publishSchema>, actor: DomainActor): Promise<StyleRelease> {
    const confirmedBy = this.human(actor)
    const replay = this.recover('release', input, actor)
    if (replay) return replay
    const style = this.require('style', input.styleId)
    const draft = this.require('draft', style.draftId)
    const candidate = this.require('candidate', input.candidateId)
    this.publishable(draft)
    if (candidate.styleId !== style.id || candidate.draftId !== draft.id || candidate.draftRevision !== draft.revision) throw new CuratorError('revision-conflict', 'style-publish', 'The candidate is stale; create and evaluate a new candidate.')
    const references = await this.referenceSnapshots(draft, actor)
    const recipe = draft.recipeId ? this.require('recipe', draft.recipeId) : candidate.recipe
    const content = { styleId: style.id, draftId: draft.id, draftRevision: draft.revision, rules: draft.rules, references, recipe }
    if (contentDigest(content) !== candidate.contentDigest) throw new CuratorError('revision-conflict', 'style-publish', 'Candidate references or recipe changed after calibration.')
    const evaluationIds = input.evaluationIds ?? []
    for (const id of evaluationIds) {
      const evaluation = this.require('evaluation', id)
      if (![evaluation.left, evaluation.right].some(ref => ref.kind === 'candidate' && ref.id === candidate.id && ref.contentDigest === candidate.contentDigest)) throw new CuratorError('constraint-conflict', 'style-publish', 'Evaluation does not describe this exact candidate.')
    }
    const release: StyleRelease = { ...this.base('release', this.id('release', input.operationId)), ...content, contentDigest: candidate.contentDigest, candidateSnapshotId: candidate.id, releaseNumber: style.nextReleaseNumber, ...(draft.baseReleaseId ? { baseReleaseId: draft.baseReleaseId } : {}), changeSummary: input.changeSummary ?? '', confirmedBy, validation: { status: evaluationIds.length ? 'evaluated' : 'provisional', evaluationIds, sampleCount: references.length, limitations: references.length ? [] : ['No reference examples are included.'] } }
    await this.styleCommit({ ...style, nextReleaseNumber: style.nextReleaseNumber + 1, committedReleaseIds: [...style.committedReleaseIds, release.id] }, input, [release], { id: release.id })
    return this.require('release', release.id)
  }
  async setDefault(input: z.infer<typeof defaultSchema>, actor: DomainActor): Promise<Style> {
    this.human(actor)
    const replay = this.recover('style', input, actor)
    if (replay) return replay
    const style = this.require('style', input.styleId)
    const release = this.require('release', input.releaseId)
    if (release.styleId !== style.id || !style.committedReleaseIds.includes(release.id)) throw new CuratorError('owner-denied', 'style-default', 'Release does not belong to this style.')
    await this.styleCommit({ ...style, defaultReleaseId: release.id }, input, [], { id: style.id })
    return this.require('style', style.id)
  }
  async archiveStyle(input: z.infer<typeof archiveSchema>, actor: DomainActor): Promise<Style> {
    this.human(actor)
    const replay = this.recover('style', input, actor)
    if (replay) return replay
    const style = this.require('style', input.styleId)
    await this.styleCommit({ ...style, archived: true }, input, [], { id: style.id })
    return this.require('style', style.id)
  }
  async createUsage(input: z.infer<typeof usageCreateSchema>, actor: DomainActor): Promise<UsageRevision> {
    this.human(actor)
    const replay = this.recover('usage', input, actor)
    if (replay) return replay
    const presetId = input.presetId ?? this.id('preset', input.operationId)
    const aggregateId = `usage:${presetId}`
    const revision = (this.repository.manifest(aggregateId)?.revision ?? 0) + 1
    const usage: UsageRevision = { ...this.base('usage', this.id('usage', input.operationId)), presetId, name: input.name, revision, output: input.output, safeRegions: input.safeRegions, protectedContent: input.protectedContent }
    await this.repository.commit({ aggregateId, expectedRevision: revision - 1, operationId: input.operationId, request: input, records: [usage], state: { currentRevisionId: usage.id, record: toJson(usage) } })
    return this.require('usage', usage.id)
  }
  async confirmFeedback(input: z.infer<typeof feedbackInputSchema>, actor: DomainActor): Promise<HumanFeedback> {
    const human = this.human(actor)
    const replay = this.recover('feedback', input, actor)
    if (replay) return replay
    this.validateContext(input.context, actor, input.expectedHead !== null)
    const subjectIds = input.subject.kind === 'pair' ? [input.subject.leftImageVersionId, input.subject.rightImageVersionId] : input.subject.kind === 'crop' ? [input.subject.parentImageVersionId, input.subject.imageVersionId] : [input.subject.imageVersionId]
    for (const id of subjectIds) this.authorizedImage(id, actor)
    for (const evidence of input.viewEvidence) {
      const { image } = this.authorizedImage(evidence.imageVersionId, actor)
      if (image.versionKind !== evidence.versionKind || !subjectIds.includes(image.id)) throw new CuratorError('invalid-input', 'feedback-confirm', 'View evidence does not match the confirmed pixels.')
    }
    const judgedIds = input.subject.kind === 'pair' ? subjectIds : [input.subject.imageVersionId]
    if (judgedIds.some(id => !input.viewEvidence.some(v => v.imageVersionId === id))) throw new CuratorError('invalid-input', 'feedback-confirm', 'Every judged image must have been displayed.')
    if ((input.judgment.kind === 'pairwise-preference') !== (input.subject.kind === 'pair')) throw new CuratorError('invalid-input', 'feedback-confirm', 'Pairwise judgments require a pair subject.')
    if (input.judgment.kind === 'crop-confirmation') {
      if (input.subject.kind !== 'crop') throw new CuratorError('invalid-input', 'feedback-confirm', 'Crop confirmation requires a generated crop.')
      const crop = this.require('cropCandidate', input.subject.candidateId)
      if (crop.geometryResult !== 'pass' || crop.derivedImageVersionId !== input.subject.imageVersionId || crop.parentImageVersionId !== input.subject.parentImageVersionId || contentDigest(crop.effectivePixelRect) !== contentDigest(input.subject.effectivePixelRect)) throw new CuratorError('constraint-conflict', 'feedback-confirm', 'The confirmed crop has invalid or mismatched geometry.')
      if (input.context.standard.kind !== 'release' || input.context.standard.releaseId !== crop.releaseId || input.context.usage.kind !== 'revision' || input.context.usage.usageRevisionId !== crop.usageRevisionId || input.context.runId !== undefined && input.context.runId !== crop.runId) throw new CuratorError('constraint-conflict', 'feedback-confirm', 'Crop confirmation must retain its actual style, usage and task.')
      const derived = this.require('imageVersion', input.subject.imageVersionId)
      if (derived.versionKind !== 'crop' || derived.parentImageVersionId !== input.subject.parentImageVersionId) throw new CuratorError('constraint-conflict', 'feedback-confirm', 'The confirmed pixels are not this crop derivative.')
    }
    const dimension = input.judgment.kind === 'dimension-verdict' ? input.judgment.dimension : null
    const identityDigest = contentDigest({ subject: input.subject, context: input.context, kind: input.judgment.kind, dimension })
    const threadId = `thread-${identityDigest.slice(10)}`
    const thread = this.repository.get('feedbackThread', threadId)
    const aggregateId = `feedback:${threadId}`
    const receipt = this.repository.manifest(aggregateId)?.receipts[input.operationId]
    if (!receipt && (thread?.headFeedbackId ?? null) !== input.expectedHead) throw new CuratorError('revision-conflict', 'feedback-confirm', 'The judgment changed; refresh before revising it.', { retryable: true })
    if (input.expectedHead) {
      const old = this.require('feedback', input.expectedHead)
      if (old.threadId !== threadId) throw new CuratorError('constraint-conflict', 'feedback-confirm', 'Cannot replace feedback from another target or context.')
    }
    const scope = input.scope ?? 'task-only'
    const eligibleKind = input.judgment.kind === 'style-verdict' || input.judgment.kind === 'dimension-verdict' || input.judgment.kind === 'pairwise-preference' || (input.judgment.kind === 'crop-confirmation' && input.judgment.value === 'confirmed' && input.judgment.includeInLearning)
    const known = !('value' in input.judgment) || input.judgment.value !== 'unknown'
    const feedback: HumanFeedback = { ...this.base('feedback', this.id('feedback', input.operationId)), threadId, subject: input.subject, context: input.context, judgment: input.judgment, reasonCodes: input.reasonCodes ?? [], ...(input.comment === undefined ? {} : { comment: input.comment }), scope, labelEligibility: scope === 'style-candidate' && eligibleKind && known ? 'confirmed-candidate' : 'none', actor: human, viewEvidence: input.viewEvidence, supersedesFeedbackId: input.expectedHead, operationId: input.operationId }
    const nextThread: FeedbackThread = { ...this.base('feedbackThread', threadId), identityDigest, headFeedbackId: feedback.id, revision: (thread?.revision ?? 0) + 1 }
    await this.repository.commit({ aggregateId, expectedRevision: thread?.revision ?? 0, operationId: input.operationId, request: input, records: [feedback, nextThread], state: { id: feedback.id, threadId, record: toJson(feedback) } })
    return this.require('feedback', feedback.id)
  }
  async confirmReference(input: z.infer<typeof referenceInputSchema>, actor: DomainActor): Promise<Reference> {
    this.human(actor)
    const replay = this.recover('reference', input, actor)
    if (replay) return replay
    const style = this.require('style', input.styleId)
    const draft = this.require('draft', style.draftId)
    const { asset } = this.authorizedImage(input.imageVersionId, actor)
    if (asset.access.kind !== 'profile-library') throw new CuratorError('constraint-conflict', 'reference-confirm', 'Save the Session image to the library explicitly before confirming a reference.')
    const existingIntent = this.repository.get('feedback', this.id('feedback', `${input.operationId}:intent:0`))
    const context = existingIntent?.context ?? { styleId: style.id, standard: { kind: 'draft' as const, draftId: draft.id, draftRevision: draft.revision }, usage: input.context.usageRevisionId ? { kind: 'revision' as const, usageRevisionId: input.context.usageRevisionId } : { kind: 'none' as const }, taskBriefDigest: contentDigest(input.context.subjects ?? []) }
    const judgments = input.intent.kind === 'overall' ? [{ kind: 'style-verdict' as const, value: input.role === 'positive' ? 'accept' as const : input.role === 'negative' ? 'reject' as const : 'unknown' as const }] : input.intent.dimensions.map(dimension => ({ kind: 'dimension-verdict' as const, dimension, value: input.role === 'positive' ? 'accept' as const : input.role === 'negative' ? 'reject' as const : 'unknown' as const }))
    const threads: string[] = []
    for (const [index, judgment] of judgments.entries()) {
      const feedback = await this.confirmFeedback({ operationId: `${input.operationId}:intent:${index}`, subject: { kind: 'image', imageVersionId: input.imageVersionId }, context, judgment, viewEvidence: input.viewEvidence, scope: 'style-candidate', expectedHead: null }, actor)
      threads.push(feedback.threadId)
    }
    const reference: Reference = { ...this.base('reference', this.id('reference', input.operationId)), styleId: style.id, imageVersionId: input.imageVersionId, role: input.role, intent: input.intent, context: input.context, feedbackThreadIds: threads }
    await this.repository.commit({ aggregateId: `reference:${reference.id}`, expectedRevision: 0, operationId: input.operationId, request: input, records: [reference], state: { id: reference.id, record: toJson(reference) } })
    return this.require('reference', reference.id)
  }
  async addSuggestion(input: z.infer<typeof suggestionInputSchema>, actor: DomainActor): Promise<RecordOf<'suggestion'>> {
    this.assertActor(actor)
    const replay = this.recover('suggestion', input, actor)
    if (replay) return replay
    if (input.context) this.validateContext(input.context, actor)
    for (const feedbackId of input.feedbackIds ?? []) {
      if (!this.canReadFeedback(this.require('feedback', feedbackId), actor)) throw new CuratorError('owner-denied', 'feedback-suggest', 'Feedback belongs to another Session.')
    }
    const suggestion: RecordOf<'suggestion'> = { ...this.base('suggestion', this.id('suggestion', input.operationId)), status: 'pending', access: actor.sessionId ? { kind: 'session-run', sessionId: actor.sessionId } : { kind: 'profile-library' }, author: { kind: 'agent', sourceId: actor.id }, text: input.text, feedbackIds: input.feedbackIds ?? [], ...(input.context ? { context: input.context } : {}) }
    await this.repository.commit({ aggregateId: `suggestion:${suggestion.id}`, expectedRevision: 0, operationId: input.operationId, request: input, records: [suggestion], state: { id: suggestion.id, record: toJson(suggestion) } })
    return this.require('suggestion', suggestion.id)
  }
  async createSplit(input: z.infer<typeof splitInputSchema>, actor: DomainActor): Promise<SplitManifest> {
    const human = this.human(actor)
    const replay = this.recover('split', input, actor)
    if (replay) return replay
    const seen = new Map<string, string>()
    const assignments = input.assignments.map(a => ({ ...a, familyId: this.familyOf(a.familyId) }))
    const uses = (input.uses ?? []).map(use => ({ ...use, familyId: this.familyOf(use.familyId) }))
    for (const assignment of assignments) {
      if (seen.has(assignment.familyId)) throw new CuratorError('constraint-conflict', 'split-create', 'A family cannot be assigned more than once.')
      seen.set(assignment.familyId, assignment.split)
      const assets = this.familyAssets(assignment.familyId)
      if (!assets.length || !this.isFamilyConfirmed(assignment.familyId)) throw new CuratorError('constraint-conflict', 'split-create', 'Confirm the family grouping before using independent data splits.')
      for (const asset of assets) if (asset.access.kind === 'session-run' && asset.access.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'split-create', 'The family contains another Session’s resource.')
      if (assignment.split === 'holdout') this.assertIndependentFamily(assignment.familyId)
      if (assignment.split === 'learning' && !uses.some(use => use.familyId === assignment.familyId && use.purpose === 'revealed')) this.assertLearningFamily(assignment.familyId)
    }
    if (uses.some(use => use.purpose === 'learning' && seen.get(use.familyId) === 'holdout')) throw new CuratorError('constraint-conflict', 'split-create', 'Holdout data cannot be used for learning.')
    if (input.supersedesSplitId) {
      const previous = this.require('split', input.supersedesSplitId)
      for (const use of [...previous.uses, ...uses]) if ((use.purpose === 'revealed' || use.purpose === 'learning') && previous.assignments.some(a => this.familyOf(a.familyId) === this.familyOf(use.familyId) && a.split === 'holdout') && seen.get(this.familyOf(use.familyId)) === 'holdout') throw new CuratorError('constraint-conflict', 'split-create', 'Revealed holdout families must move to development in a new manifest.')
    }
    const split: SplitManifest = { ...this.base('split', this.id('split', input.operationId)), assignments, revisionDigest: contentDigest({ assignments, uses }), confirmedBy: human, ...(input.supersedesSplitId ? { supersedesSplitId: input.supersedesSplitId } : {}), uses }
    const aggregateId = 'split-index'
    await this.repository.commit({ aggregateId, expectedRevision: this.repository.manifest(aggregateId)?.revision ?? 0, operationId: input.operationId, request: input, records: [split], state: { currentSplitId: split.id, record: toJson(split) } })
    return this.require('split', split.id)
  }
  async evaluate(input: z.infer<typeof evaluationInputSchema>, actor: DomainActor): Promise<EvaluationReport> {
    this.human(actor)
    const replay = this.recover('evaluation', input, actor)
    if (replay) return replay
    for (const ref of [input.left, input.right]) {
      const standard = this.require(ref.kind, ref.id)
      if (standard.contentDigest !== ref.contentDigest) throw new CuratorError('constraint-conflict', 'evaluation', 'Evaluation standard digest changed.')
    }
    this.require('usage', input.usageRevisionId)
    this.require('recipe', input.recipeId)
    const split = this.require('split', input.splitId)
    this.assertSplitUsable(split)
    for (const item of input.items) {
      const { asset } = this.authorizedImage(item.imageVersionId, actor)
      if (!split.assignments.some(a => this.familyOf(a.familyId) === asset.familyId && a.split !== 'learning')) throw new CuratorError('constraint-conflict', 'evaluation', 'Evaluation requires fixed development or holdout families.')
    }
    const evaluation: EvaluationReport = { ...this.base('evaluation', this.id('evaluation', input.operationId)), executionOutcome: input.executionOutcome ?? 'completed', left: input.left, right: input.right, splitId: split.id, usageRevisionId: input.usageRevisionId, recipeId: input.recipeId, budgetDigest: input.budgetDigest, items: input.items, metrics: evaluationMetrics(input.items), cost: { status: 'unknown' }, assessment: input.assessment ?? 'unassessed', notes: input.notes ?? [] }
    await this.repository.commit({ aggregateId: `evaluation:${evaluation.id}`, expectedRevision: 0, operationId: input.operationId, request: input, records: [evaluation], state: { id: evaluation.id, record: toJson(evaluation) } })
    return this.require('evaluation', evaluation.id)
  }
  /** @param familyId Immutable family identity. @returns Whether all current members have explicit confirmation. */
  familyOf(familyId: string): string {
    const aliases = new Map(this.repository.list('familyGroup').flatMap(group => group.aliases.map(alias => [alias, group.familyId] as const)))
    const visited = new Set<string>()
    while (aliases.has(familyId)) {
      if (visited.has(familyId)) throw new CuratorError('constraint-conflict', 'family-group', 'Family aliases contain a cycle.')
      visited.add(familyId)
      familyId = aliases.get(familyId)!
    }
    return familyId
  }
  /** @param split Fixed manifest. Historical disclosure and merged-family collisions invalidate independent holdout use. */
  assertSplitUsable(split: SplitManifest): void {
    const assigned = new Map<string, string>()
    for (const assignment of split.assignments) {
      const familyId = this.familyOf(assignment.familyId)
      const prior = assigned.get(familyId)
      if (prior !== undefined && prior !== assignment.split) throw new CuratorError('constraint-conflict', 'split-use', 'Merged family members occupy different data splits; create a new manifest.')
      assigned.set(familyId, assignment.split)
      if (assignment.split === 'holdout') this.assertIndependentFamily(familyId)
    }
  }
  /** @param familyId Source or grouped family. Holdout protection survives manifests that omit the family. */
  assertLearningFamily(familyId: string): void {
    familyId = this.familyOf(familyId)
    const splits = this.repository.list('split')
    const protectedFamily = splits.some(s => s.assignments.some(a => this.familyOf(a.familyId) === familyId && a.split === 'holdout'))
    const disclosed = splits.some(s => s.uses.some(use => this.familyOf(use.familyId) === familyId && use.purpose === 'revealed'))
    if (protectedFamily && !disclosed) throw new CuratorError('constraint-conflict', 'calibration', 'Explicitly disclose the holdout family before using it for learning; earlier holdout manifests then lose independence.')
  }
  /** @param input Related source families. @param actor Authenticated human. @returns Immutable grouped membership and alias audit. */
  async mergeFamilies(input: z.infer<typeof familyInputSchema>, actor: DomainActor): Promise<RecordOf<'familyGroup'>> {
    const confirmedBy = this.human(actor)
    const replay = this.recover('familyGroup', input, actor)
    if (replay) return replay
    const aliases = [...new Set(input.familyIds.map(id => this.familyOf(id)))].sort()
    if (aliases.length < 2) throw new CuratorError('invalid-input', 'family-merge', 'Select at least two distinct related families.')
    const assets = aliases.flatMap(id => this.familyAssets(id))
    for (const familyId of aliases) if (!this.familyAssets(familyId).length) throw new CuratorError('reference-unavailable', 'family-merge', 'A selected family is unavailable.')
    for (const asset of assets) if (asset.access.kind === 'session-run' && asset.access.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'family-merge', 'A selected family belongs to another Session.')
    const group: RecordOf<'familyGroup'> = { ...this.base('familyGroup', this.id('familyGroup', input.operationId)), familyId: this.id('family', input.operationId), aliases, assetIds: assets.map(a => a.id).sort(), confirmedBy }
    const aggregateId = 'family-index'
    await this.repository.commit({ aggregateId, expectedRevision: this.repository.manifest(aggregateId)?.revision ?? 0, operationId: input.operationId, request: input, records: [group], state: { record: toJson(group) } })
    return this.require('familyGroup', group.id)
  }
  private familyAssets(familyId: string): Asset[] { return this.repository.list('asset').filter(asset => this.familyOf(asset.familyId) === this.familyOf(familyId)) }
  private assertIndependentFamily(familyId: string): void {
    familyId = this.familyOf(familyId)
    const used = this.repository.list('split').some(split => split.uses.some(use => this.familyOf(use.familyId) === familyId && (use.purpose === 'revealed' || use.purpose === 'learning')) || split.assignments.some(a => this.familyOf(a.familyId) === familyId && a.split === 'learning'))
    const calibrated = [...this.repository.list('candidate'), ...this.repository.list('release')].some(standard => standard.references.some(reference => this.familyOf(reference.familyId) === familyId))
    const observed = this.repository.list('observation').some(observation => this.familyOf(this.require('asset', this.require('imageVersion', observation.imageVersionId).assetId).familyId) === familyId)
    if (used || calibrated || observed) throw new CuratorError('constraint-conflict', 'split-use', 'This holdout family has been disclosed, analyzed, assigned to learning, or used for calibration; select new independent holdout data.')
  }
  /** @param familyId Immutable source family or merged alias. @returns Whether all current members have explicit confirmation. */
  isFamilyConfirmed(familyId: string): boolean {
    return this.familyConfirmationStatuses().get(this.familyOf(familyId)) ?? false
  }
  /** @returns Current confirmation status for each canonical family; callers may reuse it within one synchronous projection. */
  familyConfirmationStatuses(): ReadonlyMap<string, boolean> {
    const confirmed = new Map<string, Set<string>>()
    for (const item of [...this.repository.list('familyConfirmation'), ...this.repository.list('familyGroup')]) {
      const family = this.familyOf(item.familyId), members = confirmed.get(family) ?? new Set<string>()
      for (const id of item.assetIds) members.add(id)
      confirmed.set(family, members)
    }
    const statuses = new Map<string, boolean>()
    for (const asset of this.repository.list('asset')) {
      const family = this.familyOf(asset.familyId)
      statuses.set(family, (statuses.get(family) ?? true) && (asset.groupingStatus === 'confirmed' || confirmed.get(family)?.has(asset.id) === true))
    }
    return statuses
  }
  /** @param input Current families to confirm. @param actor Host-authenticated human. @returns Immutable membership audit records. */
  async confirmFamilies(input: z.infer<typeof familyInputSchema>, actor: DomainActor): Promise<RecordOf<'familyConfirmation'>[]> {
    const confirmedBy = this.human(actor)
    const records: RecordOf<'familyConfirmation'>[] = []
    for (const familyId of new Set(input.familyIds)) {
      const assets = this.familyAssets(familyId)
      if (!assets.length) throw new CuratorError('reference-unavailable', 'family-confirm', 'The requested family is unavailable.')
      for (const asset of assets) if (asset.access.kind === 'session-run' && actor.sessionId !== asset.access.sessionId) throw new CuratorError('owner-denied', 'family-confirm', 'The family contains another Session’s resource.')
      records.push({ ...this.base('familyConfirmation', this.id('familyConfirmation', `${input.operationId}:${familyId}`)), familyId, assetIds: assets.map(a => a.id).sort(), confirmedBy })
    }
    await this.repository.commit({ aggregateId: `family-confirm:${input.operationId}`, expectedRevision: 0, operationId: input.operationId, request: input, records, state: { familyIds: [...new Set(input.familyIds)] } })
    return records.map(r => this.require('familyConfirmation', r.id))
  }
  async createExport(input: z.infer<typeof exportInputSchema>, actor: DomainActor, selection?: { feedback: readonly HumanFeedback[] }): Promise<ExportSnapshot> {
    this.assertActor(actor)
    const replay = this.recover('export', input, actor)
    if (replay) { this.authorizeExport(replay, actor); return replay }
    if (selection && contentDigest(selection.feedback.map(f => f.id).sort()) !== contentDigest([...(input.feedbackIds ?? [])].sort())) throw new CuratorError('constraint-conflict', 'export', 'Frozen feedback IDs must match the saved export selection.')
    const exportActor: ExportSnapshot['actor'] = actor.kind === 'human' ? this.human(actor) : { kind: 'agent', id: actor.id, sessionId: actor.sessionId ?? '' }
    if (actor.kind === 'agent' && !actor.sessionId) throw new CuratorError('owner-denied', 'export', 'Agent export requires an owning Session.')
    const release = this.require('release', input.releaseId)
    const analysisRun = input.analysisRunId ? this.require('run', input.analysisRunId) : undefined
    if (analysisRun && !this.canReadRun(analysisRun.id, actor)) throw new CuratorError('owner-denied', 'export', 'The style analysis belongs to another owner.')
    const analysis = analysisRun ? styleAnalysisOf(analysisRun) : undefined
    if (analysisRun) {
      if (input.exportKind !== 'style' || input.purpose !== 'reference' || analysisRun.status !== 'completed' || analysisRun.outcome !== 'target-met' || !analysis || analysis.styleId !== release.styleId) throw new CuratorError('constraint-conflict', 'export', 'Choose a completed analysis and reference-style export for this release.')
      if (analysis.samples.length !== release.references.length || analysis.samples.some(sample => {
        const fixed = release.references.find(ref => ref.reference.id === sample.reference.id)
        return !fixed || fixed.imageDigest !== sample.imageDigest || fixed.reference.imageVersionId !== sample.reference.imageVersionId
          || contentDigest(fixed.reference.intent) !== contentDigest(sample.reference.intent) || contentDigest(fixed.reference.context) !== contentDigest(sample.reference.context)
          || contentDigest([...fixed.feedbackIds].sort()) !== contentDigest([...sample.feedbackIds].sort())
      })) throw new CuratorError('revision-conflict', 'export', 'The published examples or judgments differ from this analysis. Analyze and publish the current examples before exporting.')
    }
    const split = this.require('split', input.splitId)
    this.assertSplitUsable(split)
    if (input.usageRevisionId) this.require('usage', input.usageRevisionId)
    const heads = selection ? selection.feedback.map(feedback => ({ id: feedback.threadId, headFeedbackId: feedback.id })) : this.repository.list('feedbackThread')
    const wanted = input.feedbackIds ? new Set(input.feedbackIds) : undefined
    const exclusions: Record<string, number> = {}
    const suggestions = this.snapshot(actor).suggestions.filter(suggestion => suggestion.context?.styleId === release.styleId)
    if (suggestions.length) exclusions['agent-or-model-suggestion'] = suggestions.length
    const feedback: HumanFeedback[] = []
    for (const thread of heads) {
      const item = this.require('feedback', thread.headFeedbackId)
      if (selection && !selection.feedback.some(f => f.id === item.id && contentDigest(f) === contentDigest(item))) throw new CuratorError('reference-unavailable', 'export', 'Frozen feedback does not match its immutable record.')
      if (wanted && !wanted.has(item.id)) continue
      if (item.context.styleId !== release.styleId || !this.canReadFeedback(item, actor)) continue
      const exclude = supervisionExclusion(item, input.exportKind)
      if (exclude) { exclusions[exclude] = (exclusions[exclude] ?? 0) + 1; continue }
      if (item.context.standard.kind === 'release' && item.context.standard.releaseId !== release.id) { exclusions['different-standard'] = (exclusions['different-standard'] ?? 0) + 1; continue }
      if (item.context.standard.kind === 'draft' && !(item.context.standard.draftId === release.draftId && item.context.standard.draftRevision === release.draftRevision) && !release.references.some(reference => reference.feedbackIds.includes(item.id))) { exclusions['unpublished-draft-context'] = (exclusions['unpublished-draft-context'] ?? 0) + 1; continue }
      if (input.usageRevisionId && (item.context.usage.kind !== 'revision' || item.context.usage.usageRevisionId !== input.usageRevisionId)) { exclusions['different-usage'] = (exclusions['different-usage'] ?? 0) + 1; continue }
      feedback.push(item)
    }
    if (wanted && [...wanted].some(id => !heads.some(t => t.headFeedbackId === id))) throw new CuratorError('revision-conflict', 'export', 'Export selection contains an obsolete feedback head.')
    const ids = new Set(input.imageVersionIds ?? [])
    if (input.exportKind === 'style' || input.exportKind === 'skill') for (const ref of release.references) ids.add(ref.reference.imageVersionId)
    for (const f of feedback) {
      if (f.subject.kind === 'pair') { ids.add(f.subject.leftImageVersionId); ids.add(f.subject.rightImageVersionId) }
      else { ids.add(f.subject.imageVersionId); if (f.subject.kind === 'crop') ids.add(f.subject.parentImageVersionId) }
    }
    const resources: ExportSnapshot['resources'] = []
    const images: ImageVersion[] = []
    const permitted = input.purpose === 'training' ? 'learning' : input.purpose === 'reference' ? undefined : input.purpose
    for (const id of ids) {
      const { image, asset } = this.authorizedImage(id, actor)
      const assignment = split.assignments.find(a => this.familyOf(a.familyId) === asset.familyId)
      if (!assignment) throw new CuratorError('constraint-conflict', 'export', 'Every exported image needs a confirmed family split.')
      if (permitted && assignment.split !== permitted) { exclusions['wrong-split'] = (exclusions['wrong-split'] ?? 0) + 1; continue }
      if (input.mode === 'with-bytes') {
        if (asset.exportPermission !== 'bytes-allowed') throw new CuratorError('owner-denied', 'export', 'Image bytes have not been authorized for export.')
        await this.verifyImage(image)
      }
      resources.push({ assetId: asset.id, imageVersionId: image.id, digest: image.blob.digest, familyId: asset.familyId, split: assignment.split, ...(input.mode === 'with-bytes' ? { storageRef: image.blob.storageRef } : {}) })
      images.push(image)
    }
    const resourceIds = new Set(resources.map(r => r.imageVersionId))
    const includedFeedback = feedback.filter(f => f.subject.kind === 'pair' ? resourceIds.has(f.subject.leftImageVersionId) && resourceIds.has(f.subject.rightImageVersionId) : resourceIds.has(f.subject.imageVersionId))
    const observations = analysis?.samples.map(sample => {
      const observation = this.require('observation', sample.observationId)
      if (observation.imageVersionId !== sample.reference.imageVersionId) throw new CuratorError('reference-unavailable', 'export', 'The saved observation refers to different pixels.')
      return observation
    })
    const files = renderExportFiles({ release, split, resources, feedback: includedFeedback, exportKind: input.exportKind, images, ...(analysis && observations ? { analysis, observations } : {}) })
    const sessionResource = resources.some(resource => this.require('asset', resource.assetId).access.kind === 'session-run')
    const access: ExportSnapshot['access'] = actor.kind === 'agent' || sessionResource ? { kind: 'session-run', sessionId: actor.sessionId ?? '' } : { kind: 'profile-library' }
    const snapshot: ExportSnapshot = { ...this.base('export', this.id('export', input.operationId)), access, formatVersion: 1, exportKind: input.exportKind, purpose: input.purpose, releaseId: release.id, ...(input.usageRevisionId ? { usageRevisionId: input.usageRevisionId } : {}), splitId: split.id, feedbackIds: includedFeedback.map(f => f.id), feedbackHeads: Object.fromEntries(includedFeedback.map(f => [f.threadId, f.id])), resources, mode: input.mode ?? 'references-only', actor: exportActor, files, exclusions }
    await this.repository.commit({ aggregateId: `export:${snapshot.id}`, expectedRevision: 0, operationId: input.operationId, request: input, records: [snapshot], state: { id: snapshot.id, record: toJson(snapshot) } })
    return this.require('export', snapshot.id)
  }
  /** Projection has one label source: the committed feedback head. */
  referenceJudgments(reference: Reference): HumanFeedback[] { return reference.feedbackThreadIds.map(id => this.require('feedback', this.require('feedbackThread', id).headFeedbackId)) }
  async close(): Promise<void> { if (this.options.close) await this.options.close(); else await this.repository.close() }
  private async styleCommit(style: Style, input: { expectedRevision: number; operationId: string }, records: CuratorRecord[], state: Json): Promise<void> {
    const next = { ...style, revision: input.expectedRevision + 1 }
    const id = state && !Array.isArray(state) && typeof state === 'object' ? state.id : undefined
    const result = id === next.id ? next : records.find(r => r.id === id)
    await this.repository.commit({ aggregateId: `style:${style.id}`, expectedRevision: input.expectedRevision, operationId: input.operationId, request: input, records: [next, ...records], state: { id: typeof id === 'string' ? id : next.id, record: toJson(result ?? next) } })
  }
  private recover<K extends RecordKind>(kind: K, input: { operationId: string }, actor: DomainActor): RecordOf<K> | undefined {
    for (const manifest of this.repositoryManifests()) {
      const receipt = manifest.receipts[input.operationId]
      if (!receipt) continue
      if (receipt.requestDigest !== contentDigest(input)) throw new CuratorError('operation-conflict', 'domain-retry', 'Operation ID was already used for different input.')
      const state = receipt.state
      if (state && !Array.isArray(state) && typeof state === 'object' && 'record' in state) {
        const record = recordSchema.parse(state.record)
        if (record.kind === kind) {
          if (record.kind === 'export') this.authorizeExport(record, actor)
          if (record.kind === 'feedback' && !this.canReadFeedback(record, actor)) throw new CuratorError('owner-denied', 'domain-retry', 'Feedback belongs to another Session.')
          if (record.kind === 'suggestion' && record.access?.kind === 'session-run' && record.access.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'domain-retry', 'Suggestion belongs to another Session.')
          if (record.kind === 'evaluation') for (const item of record.items) this.authorizedImage(item.imageVersionId, actor)
          return record as RecordOf<K>
        }
      }
      throw new CuratorError('operation-conflict', 'domain-retry', 'Operation ID belongs to another operation.')
    }
    return undefined
  }
  private repositoryManifests() { return this.repository.manifests() }
  /** @param snapshot Saved export. @param actor Host-created identity. */
  authorizeExport(snapshot: ExportSnapshot, actor: DomainActor): void {
    this.assertActor(actor)
    if (snapshot.access.kind === 'session-run' && snapshot.access.sessionId !== actor.sessionId) throw new CuratorError('owner-denied', 'export', 'This export belongs to another Session.')
  }
  private publishable(draft: StyleDraft): void {
    if (draft.rules.some(r => r.strength === 'required' && r.confirmation.status !== 'confirmed') || draft.conflicts.some(c => !c.resolved && c.ruleIds.some(id => draft.rules.some(r => r.ruleId === id && r.strength === 'required')))) throw new CuratorError('constraint-conflict', 'candidate-create', 'Confirm required rules and resolve their conflicts before publication.')
  }
  private async referenceSnapshots(draft: StyleDraft, actor: DomainActor): Promise<ReferenceSnapshot[]> {
    const snapshots: ReferenceSnapshot[] = []
    for (const id of draft.referenceIds) {
      const reference = this.require('reference', id)
      const { image, asset } = this.authorizedImage(reference.imageVersionId, actor)
      this.assertLearningFamily(asset.familyId)
      await this.verifyImage(image)
      const feedback = this.referenceJudgments(reference)
      const judgments = feedback.flatMap(f => f.judgment.kind === 'style-verdict' ? [{ feedbackId: f.id, value: f.judgment.value }] : f.judgment.kind === 'dimension-verdict' ? [{ feedbackId: f.id, value: f.judgment.value, dimension: f.judgment.dimension }] : [])
      const values = new Set(judgments.map(j => j.value))
      const projectedRole = values.size === 1 ? values.has('accept') ? 'positive' as const : values.has('reject') ? 'negative' as const : 'undecided' as const : 'undecided' as const
      snapshots.push({ reference: { ...reference, role: projectedRole }, imageDigest: image.blob.digest, familyId: asset.familyId, feedbackIds: feedback.map(f => f.id), judgments })
    }
    return snapshots
  }
  private validateContext(context: z.infer<typeof feedbackContextSchema>, actor: DomainActor, allowHistoricalDraft = false): void {
    const style = this.require('style', context.styleId)
    if (context.standard.kind === 'release') {
      const standard = this.resolveRelease(style.id, context.standard.releaseId)
      if (standard.kind === 'modelProfile') new ModelProfiles(this).authorize(standard, actor)
      if (standard.styleId !== style.id) throw new CuratorError('owner-denied', 'feedback-confirm', 'Feedback standard belongs to another style.')
    } else {
      const draft = this.require('draft', context.standard.draftId)
      if (draft.styleId !== style.id || (allowHistoricalDraft ? draft.revision < context.standard.draftRevision : draft.revision !== context.standard.draftRevision)) throw new CuratorError('revision-conflict', 'feedback-confirm', 'Feedback draft context is stale.')
    }
    if (context.usage.kind === 'revision') this.require('usage', context.usage.usageRevisionId)
    if (context.runId && !this.canReadRun(context.runId, actor)) throw new CuratorError('owner-denied', 'feedback-confirm', 'Feedback run belongs to another Session.')
  }
  private human(actor: DomainActor): HumanActor {
    this.assertActor(actor)
    if (actor.kind !== 'human') throw new CuratorError('owner-denied', 'human-confirmation', 'Authenticated Client confirmation is required for this operation.')
    return { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'client-action', confirmedAt: this.now() }
  }
  private assertActor(actor: DomainActor): void { this.repository.assertProfile(actor.profileId) }
  private canReadRun(id: string, actor: DomainActor): boolean { const run = this.repository.get('run', id); return run !== undefined && (run.owner.kind === 'profile' ? actor.kind === 'human' : run.owner.sessionId === actor.sessionId) }
  private canReadImage(id: string, actor: DomainActor): boolean { try { this.authorizedImage(id, actor); return true } catch (error) { if (error instanceof CuratorError) return false; throw error } }
  private canReadFeedback(f: HumanFeedback, actor: DomainActor): boolean { return (!f.context.runId || this.canReadRun(f.context.runId, actor)) && (f.subject.kind === 'pair' ? this.canReadImage(f.subject.leftImageVersionId, actor) && this.canReadImage(f.subject.rightImageVersionId, actor) : this.canReadImage(f.subject.imageVersionId, actor)) }
  private async verifyImage(image: ImageVersion): Promise<void> { if (!this.options.verifyImage) throw new CuratorError('capability-unavailable', 'media-integrity', 'Media integrity verification is unavailable.'); await this.options.verifyImage(image) }
  private base<K extends RecordKind>(kind: K, id: string): { kind: K; id: RecordOf<K>['id']; schemaVersion: 1; profileId: string; createdAt: string } { return { kind, id: curatorId<RecordOf<K>['id']>(id), schemaVersion: 1, profileId: this.profileId, createdAt: this.now() } }
  private id(kind: string, operationId: string): string { return `${kind}-${contentDigest({ profileId: this.profileId, kind, operationId }).slice(10, 42)}` }
}
/** @param value Typed records. @returns Serialization-compatible operation output. */
function toJson(value: unknown): Json { return z.json().parse(JSON.parse(JSON.stringify(value))) }
/** @param options Writer/open and image-integrity dependencies. @returns Profile domain after exclusive writer acquisition. */
export async function openCuratorDomain(options: Parameters<typeof openCuratorRepository>[0] & Omit<CuratorDomainOptions, 'close'>): Promise<CuratorDomain> {
  const opened = await openCuratorRepository(options)
  return new CuratorDomain(options.profileId, opened.repository, { ...options, close: opened.close })
}
