/** Version-one Visual Curator records and strict durable/wire parsers. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { remoteImageSourceSchema } from './gallery.ts'

/** Opaque identifiers remain plain strings on the wire. */
export type ProfileId = Branded<'VisualCurator.ProfileId'>
export type StyleId = Branded<'VisualCurator.StyleId'>
export type DraftId = Branded<'VisualCurator.DraftId'>
export type CandidateId = Branded<'VisualCurator.CandidateId'>
export type ReleaseId = Branded<'VisualCurator.ReleaseId'>
export type AssetId = Branded<'VisualCurator.AssetId'>
export type ImageVersionId = Branded<'VisualCurator.ImageVersionId'>
export type FeedbackId = Branded<'VisualCurator.FeedbackId'>
export type RunId = Branded<'VisualCurator.RunId'>
export type UsageId = Branded<'VisualCurator.UsageId'>
export type SplitId = Branded<'VisualCurator.SplitId'>
export type ExportId = Branded<'VisualCurator.ExportId'>
export type ReferenceId = Branded<'VisualCurator.ReferenceId'>
export type RecipeId = Branded<'VisualCurator.RecipeId'>
export type FeedbackThreadId = Branded<'VisualCurator.FeedbackThreadId'>
export type SuggestionId = Branded<'VisualCurator.SuggestionId'>
export type ObservationId = Branded<'VisualCurator.ObservationId'>
export type FamilyConfirmationId = Branded<'VisualCurator.FamilyConfirmationId'>
export type FamilyGroupId = Branded<'VisualCurator.FamilyGroupId'>
export type EvaluationId = Branded<'VisualCurator.EvaluationId'>
export type AssessmentId = Branded<'VisualCurator.AssessmentId'>
export type RequestId = Branded<'VisualCurator.RequestId'>
export type CheckpointId = Branded<'VisualCurator.CheckpointId'>
export type CropCandidateId = Branded<'VisualCurator.CropCandidateId'>
export type SelectionId = Branded<'VisualCurator.SelectionId'>

/** @param value Validated opaque string. @returns Its nominal identifier. */
export function curatorId<T extends Branded<string>>(value: string): T { return brandString<T>(value) }
const opaque = z.string().min(1).max(256)
const brandedIdSchema = <B extends string>() => opaque.transform(value => brandString<Branded<B>>(value))
const timestamp = z.string().datetime({ offset: true })
/** JSON values accepted in extensible diagnostic/processor records. */
export const jsonSchema = z.json()
export type Json = z.infer<typeof jsonSchema>
/** Named visual dimensions; adding a key changes the persisted vocabulary. */
export const dimensionSchema = z.enum(['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'])
export type Dimension = z.infer<typeof dimensionSchema>
/** A versioned digest includes its canonicalization algorithm. */
export const digestSchema = z.string().regex(/^sha256-v1:[a-f0-9]{64}$/)
/** Stored media references never contain externally signed URLs. */
const localSourceSchema = z.strictObject({ path: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive(), mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), representation: z.enum(['original', 'normalized', 'preview']), maxDimension: z.number().int().positive(), processorVersion: z.string().min(1) })
export const blobRefSchema = z.strictObject({ digest: z.string().regex(/^(sha256-v1:|remote-url-v1:)?[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative(), mime: z.enum(['image/jpeg', 'image/png', 'image/webp']), storageRef: opaque, localSource: localSourceSchema.optional(), remoteSource: remoteImageSourceSchema.optional() }).refine(value => value.remoteSource ? value.digest.startsWith('remote-url-v1:') && value.byteLength === 0 && value.storageRef === `remote-links/${value.digest.slice(14)}` && !value.localSource : !value.digest.startsWith('remote-url-v1:'), 'Remote descriptors cannot claim local pixel bytes.')
export type BlobRef = z.infer<typeof blobRefSchema>
/** Strict normalized coordinates reject out-of-bounds proposals. */
export const normalizedRectSchema = z.strictObject({ x: z.number().finite().min(0), y: z.number().finite().min(0), width: z.number().finite().positive(), height: z.number().finite().positive() }).refine(r => r.x + r.width <= 1 && r.y + r.height <= 1, 'Rectangle extends outside the image')
export const pixelRectSchema = z.strictObject({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() })
export type NormalizedRect = z.infer<typeof normalizedRectSchema>
export type PixelRect = z.infer<typeof pixelRectSchema>
/** Every access check uses the saved owner, including derived resources. */
export const accessSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('profile-library') }), z.strictObject({ kind: z.literal('session-run'), sessionId: opaque })])
export type AssetAccess = z.infer<typeof accessSchema>
/** Host-created actor context; never parse this from the operation's args. */
export interface DomainActor { kind: 'human' | 'agent'; id: string; profileId: string; sessionId?: string }
export const humanActorSchema = z.strictObject({ kind: z.literal('authenticated-human'), id: opaque, confirmationMethod: z.enum(['client-action', 'import-confirmation']), confirmedAt: timestamp })
export type HumanActor = z.infer<typeof humanActorSchema>
const base = { schemaVersion: z.literal(1), profileId: opaque, id: opaque, createdAt: timestamp }
/** Domain-owned rules contain no executable conditions. */
export const conditionSchema = z.strictObject({ subjects: z.array(z.string()).optional(), usageRevisionIds: z.array(opaque).optional() })
export const ruleSchema = z.strictObject({
  ruleId: opaque, dimension: dimensionSchema, statement: z.string().min(1), condition: conditionSchema,
  strength: z.enum(['required', 'preferred', 'reference-only']), stage: z.enum(['source', 'final']),
  check: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('visual'), criterion: z.string().min(1) }), z.strictObject({ kind: z.literal('measured'), field: z.enum(['width', 'height', 'aspect', 'byteLength']), unit: z.enum(['pixels', 'ratio', 'bytes']), min: z.number().finite().optional(), max: z.number().finite().optional(), tolerance: z.number().finite().nonnegative() })]),
  exceptions: z.array(conditionSchema), supportRefs: z.array(opaque), counterRefs: z.array(opaque),
  confirmation: z.discriminatedUnion('status', [z.strictObject({ status: z.literal('suggested') }), z.strictObject({ status: z.literal('confirmed'), actor: humanActorSchema })]),
})
export type Rule = z.infer<typeof ruleSchema>
/** References preserve intent; effective dimension labels are projected from feedback. */
export const referenceSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.ReferenceId'>(), kind: z.literal('reference'), styleId: opaque, imageVersionId: opaque, role: z.enum(['positive', 'negative', 'undecided']), intent: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('overall') }), z.strictObject({ kind: z.literal('dimensions'), dimensions: z.array(dimensionSchema).min(1) })]), context: z.strictObject({ subjects: z.array(z.string()).optional(), usageRevisionId: opaque.optional() }), feedbackThreadIds: z.array(opaque) })
export type Reference = z.infer<typeof referenceSchema>
export const assetSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.AssetId'>(), kind: z.literal('asset'), familyId: opaque, source: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('local-import'), description: z.string() }), z.strictObject({ kind: z.literal('provider'), providerId: opaque, providerAssetId: opaque, accountIdentity: z.string(), description: z.string(), obtainedAt: timestamp })]), access: accessSchema, originalBlob: blobRefSchema.optional(), exportPermission: z.enum(['references-only', 'bytes-allowed']), exportConfirmedBy: humanActorSchema.optional(), groupingStatus: z.enum(['unreviewed', 'confirmed']) }).refine(r => r.exportPermission !== 'bytes-allowed' || r.exportConfirmedBy !== undefined, 'Bytes permission requires human confirmation')
export type Asset = z.infer<typeof assetSchema>
export const imageVersionSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.ImageVersionId'>(), kind: z.literal('imageVersion'), assetId: opaque, versionKind: z.enum(['normalized', 'preview', 'crop', 'remote-reference']), blob: blobRefSchema, parentImageVersionId: opaque.optional(), geometry: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), colorSpace: z.string(), sourceOrientation: z.number().int().min(1).max(8).optional(), processorVersion: z.string() }), processing: z.strictObject({ recipeDigest: z.string(), processorVersion: z.string(), sourceDigest: z.string().optional(), requestedRect: normalizedRectSchema.optional(), effectivePixelRect: pixelRectSchema.optional(), encoding: z.string(), outputWidth: z.number().int().positive(), outputHeight: z.number().int().positive() }).optional() }).refine(value => (value.versionKind === 'remote-reference') === !!value.blob.remoteSource, 'Remote image versions require a remote descriptor.')
export type ImageVersion = z.infer<typeof imageVersionSchema>
/** Draft snapshots and releases retain complete reference intent and pixel digests. */
export const referenceSnapshotSchema = z.strictObject({ reference: referenceSchema, imageDigest: z.string(), familyId: opaque, feedbackIds: z.array(opaque), judgments: z.array(z.strictObject({ feedbackId: opaque, dimension: dimensionSchema.optional(), value: z.enum(['accept', 'reject', 'unknown']) })).optional() })
export type ReferenceSnapshot = z.infer<typeof referenceSnapshotSchema>
export const recipeSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.RecipeId'>(), kind: z.literal('recipe'), visionRevision: opaque, model: z.string().min(1), vendorVersion: z.string().nullable(), promptVersion: opaque, outputSchemaVersion: opaque, preprocessingVersion: opaque, styleMatching: z.strictObject({ version: z.literal(2), minSatisfiedRatio: z.number().gt(0).max(1) }).optional(), referenceStrategy: z.strictObject({ maxImages: z.number().int().positive(), maxBytes: z.number().int().positive() }), preferenceScale: z.strictObject({ min: z.number().finite(), max: z.number().finite(), weights: z.partialRecord(dimensionSchema, z.number().finite().nonnegative()) }), unknownPolicy: z.literal('needs-review'), tieBreak: z.literal('stable-id') }).refine(r => r.preferenceScale.max > r.preferenceScale.min, 'Invalid preference scale')
export type EvaluationRecipe = z.infer<typeof recipeSchema>
export const styleSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.StyleId'>(), kind: z.literal('style'), name: z.string().min(1), archived: z.boolean(), draftId: opaque, revision: z.number().int().positive(), committedReleaseIds: z.array(opaque), defaultReleaseId: opaque.nullable(), nextReleaseNumber: z.number().int().positive() })
export type Style = z.infer<typeof styleSchema>
export const draftSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.DraftId'>(), kind: z.literal('draft'), styleId: opaque, baseReleaseId: opaque.optional(), revision: z.number().int().positive(), status: z.enum(['editing', 'ready']), rules: z.array(ruleSchema), referenceIds: z.array(opaque), feedbackIds: z.array(opaque), conflicts: z.array(z.strictObject({ id: opaque, ruleIds: z.array(opaque), reason: z.string(), resolved: z.boolean() })), recipeId: opaque.optional() })
export type StyleDraft = z.infer<typeof draftSchema>
const fixedStyle = { styleId: opaque, draftId: opaque, draftRevision: z.number().int().positive(), rules: z.array(ruleSchema), references: z.array(referenceSnapshotSchema), recipe: recipeSchema, contentDigest: digestSchema }
export const candidateSchema = z.strictObject({ ...base, ...fixedStyle, id: brandedIdSchema<'VisualCurator.CandidateId'>(), kind: z.literal('candidate') })
export type StyleCandidate = z.infer<typeof candidateSchema>
export const releaseSchema = z.strictObject({ ...base, ...fixedStyle, id: brandedIdSchema<'VisualCurator.ReleaseId'>(), kind: z.literal('release'), releaseNumber: z.number().int().positive(), candidateSnapshotId: opaque, baseReleaseId: opaque.optional(), changeSummary: z.string(), confirmedBy: humanActorSchema, validation: z.strictObject({ status: z.enum(['provisional', 'evaluated']), evaluationIds: z.array(opaque), sampleCount: z.number().int().nonnegative(), limitations: z.array(z.string()) }) })
export type StyleRelease = z.infer<typeof releaseSchema>
/** Automatically adopted references remain distinct from human-confirmed releases. */
export const modelProfileSchema = z.strictObject({ ...base, ...fixedStyle, id: brandedIdSchema<'VisualCurator.ModelProfileId'>(), kind: z.literal('modelProfile'), access: accessSchema,
  analysisRunId: opaque, referenceDigest: digestSchema, revision: z.number().int().positive(), model: z.string().min(1), matchingPrompt: z.string(), previousProfileId: opaque.optional(),
  groups: z.array(z.strictObject({ groupId: opaque, name: z.string(), description: z.string(), imageVersionIds: z.array(opaque) })),
  options: z.array(z.strictObject({ rule: ruleSchema, enabled: z.boolean(), groupId: opaque.nullable(), selectionSource: z.enum(['model', 'user', 'human-rule']), sourceStatement: z.string(), reason: z.enum(['consistent', 'conditional', 'reference-only', 'counter-evidence', 'no-evidence', 'subject-only', 'user-choice', 'evidence-changed']) })),
})
export type ModelProfile = z.infer<typeof modelProfileSchema>
/** Both standards freeze rules, references and a reviewer recipe without conflating authorship. */
export const styleStandardSchema = z.union([releaseSchema, modelProfileSchema])
export type StyleStandard = z.infer<typeof styleStandardSchema>
/** Version-two reference packages contain no training split or fabricated human confirmation. */
export const profileExportSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.ProfileExportId'>(), kind: z.literal('profileExport'), access: accessSchema, formatVersion: z.literal(2), modelProfileId: opaque, analysisRunId: opaque,
  resources: z.array(z.strictObject({ imageVersionId: opaque, digest: z.string(), familyId: opaque })), files: z.array(z.strictObject({ name: z.string(), content: z.string(), checksum: digestSchema })),
})
export type ProfileExport = z.infer<typeof profileExportSchema>
/** Output dimensions use exact reduced integer aspect ratios and no upscaling. */
export const usageOutputSchema = z.strictObject({ aspectP: z.number().int().positive(), aspectQ: z.number().int().positive(), targetWidth: z.number().int().positive(), targetHeight: z.number().int().positive(), acceptedFormats: z.array(z.enum(['jpeg', 'png', 'webp'])).min(1), allowUpscale: z.literal(false) }).refine(o => gcd(o.aspectP, o.aspectQ) === 1 && o.targetWidth * o.aspectQ === o.targetHeight * o.aspectP, 'Output pixels must match the reduced aspect ratio')
export const usageSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.UsageId'>(), kind: z.literal('usage'), presetId: opaque, name: z.string().min(1), revision: z.number().int().positive(), output: usageOutputSchema, safeRegions: z.array(z.strictObject({ rect: normalizedRectSchema, interference: z.string(), strength: z.enum(['required', 'preferred']) })), protectedContent: z.array(z.string()) })
export type UsageRevision = z.infer<typeof usageSchema>
/** Feedback identity includes complete context, not just the logical asset. */
export const feedbackContextSchema = z.strictObject({ styleId: opaque, standard: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('release'), releaseId: opaque }), z.strictObject({ kind: z.literal('draft'), draftId: opaque, draftRevision: z.number().int().positive() })]), usage: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('none') }), z.strictObject({ kind: z.literal('revision'), usageRevisionId: opaque })]), runId: opaque.optional(), assessmentId: opaque.optional(), taskBriefDigest: z.string() })
export const subjectSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('image'), imageVersionId: opaque }), z.strictObject({ kind: z.literal('pair'), leftImageVersionId: opaque, rightImageVersionId: opaque, comparisonSubject: z.string().min(1) }), z.strictObject({ kind: z.literal('crop'), parentImageVersionId: opaque, imageVersionId: opaque, candidateId: opaque, effectivePixelRect: pixelRectSchema })])
const verdict = z.enum(['accept', 'reject', 'unknown'])
export const judgmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('style-verdict'), value: verdict }),
  z.strictObject({ kind: z.literal('dimension-verdict'), value: verdict, dimension: dimensionSchema }),
  z.strictObject({ kind: z.literal('task-relevance'), value: z.enum(['relevant', 'irrelevant', 'not-needed', 'unknown']) }),
  z.strictObject({ kind: z.literal('usage-fit'), value: verdict }),
  z.strictObject({ kind: z.literal('pairwise-preference'), value: z.enum(['left', 'right', 'tie', 'neither', 'unknown']) }),
  z.strictObject({ kind: z.literal('crop-confirmation'), value: z.enum(['confirmed', 'not-confirmed']), includeInLearning: z.boolean() }),
  z.strictObject({ kind: z.literal('observation-correction'), field: z.string().min(1), correctedValue: jsonSchema }),
  z.strictObject({ kind: z.literal('rule-suggestion'), proposedRule: ruleSchema }),
])
export type FeedbackJudgment = z.infer<typeof judgmentSchema>
export const viewEvidenceSchema = z.array(z.strictObject({ imageVersionId: opaque, versionKind: z.enum(['normalized', 'preview', 'crop', 'remote-reference']) })).min(1)
export const feedbackSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.FeedbackId'>(), kind: z.literal('feedback'), threadId: opaque, subject: subjectSchema, context: feedbackContextSchema, judgment: judgmentSchema, reasonCodes: z.array(z.string()), comment: z.string().optional(), scope: z.enum(['task-only', 'style-candidate']), labelEligibility: z.enum(['none', 'confirmed-candidate']), actor: humanActorSchema, viewEvidence: viewEvidenceSchema, supersedesFeedbackId: opaque.nullable(), operationId: opaque })
export type HumanFeedback = z.infer<typeof feedbackSchema>
export const feedbackThreadSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.FeedbackThreadId'>(), kind: z.literal('feedbackThread'), identityDigest: digestSchema, headFeedbackId: opaque, revision: z.number().int().positive() })
export type FeedbackThread = z.infer<typeof feedbackThreadSchema>
export const suggestionSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.SuggestionId'>(), kind: z.literal('suggestion'), status: z.enum(['pending', 'accepted', 'dismissed']), access: accessSchema.optional(), author: z.strictObject({ kind: z.enum(['agent', 'model']), sourceId: opaque }), text: z.string().min(1), feedbackIds: z.array(opaque), context: feedbackContextSchema.optional(), acceptedFeedbackId: opaque.optional() })
export type Suggestion = z.infer<typeof suggestionSchema>
export const observationSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.ObservationId'>(), kind: z.literal('observation'), imageVersionId: opaque, measured: z.array(z.strictObject({ field: z.string(), value: jsonSchema, method: z.string(), version: z.string() })), inferred: z.array(z.strictObject({ field: z.string(), value: jsonSchema, uncertain: z.boolean(), requestId: opaque, imageVersionId: opaque, region: normalizedRectSchema.optional() })), corrections: z.array(opaque) })
export type Observation = z.infer<typeof observationSchema>
/** Explicit family membership confirmation leaves immutable asset source/ownership untouched. */
export const familyConfirmationSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.FamilyConfirmationId'>(), kind: z.literal('familyConfirmation'), familyId: opaque, assetIds: z.array(opaque).min(1), confirmedBy: humanActorSchema })
/** Human grouping aliases related sources without rewriting their immutable assets. */
export const familyGroupSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.FamilyGroupId'>(), kind: z.literal('familyGroup'), familyId: opaque, aliases: z.array(opaque).min(2), assetIds: z.array(opaque).min(2), confirmedBy: humanActorSchema })
/** Immutable family assignment; reveal history is recorded in successor manifests. */
export const splitSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.SplitId'>(), kind: z.literal('split'), revisionDigest: digestSchema, assignments: z.array(z.strictObject({ familyId: opaque, split: z.enum(['learning', 'development', 'holdout']), groupingConfirmed: z.literal(true) })), confirmedBy: humanActorSchema, supersedesSplitId: opaque.optional(), uses: z.array(z.strictObject({ familyId: opaque, purpose: z.enum(['revealed', 'evaluation', 'learning']), at: timestamp })) })
export type SplitManifest = z.infer<typeof splitSchema>
/** Rates retain numerator and denominator; a zero denominator is unavailable. */
export const metricSchema = z.discriminatedUnion('status', [z.strictObject({ status: z.literal('available'), numerator: z.number().nonnegative(), denominator: z.number().positive(), value: z.number().nonnegative() }), z.strictObject({ status: z.literal('unavailable'), numerator: z.literal(0), denominator: z.literal(0) })])
export type Metric = z.infer<typeof metricSchema>
export const standardRefSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('release'), id: opaque, contentDigest: digestSchema }), z.strictObject({ kind: z.literal('candidate'), id: opaque, contentDigest: digestSchema }), z.strictObject({ kind: z.literal('modelProfile'), id: opaque, contentDigest: digestSchema })])
export const evaluationItemSchema = z.strictObject({ imageVersionId: opaque, humanLabel: z.enum(['accept', 'reject', 'unknown']).optional(), left: z.enum(['pass', 'reject', 'needs-review', 'technical-failed', 'unprocessed']), right: z.enum(['pass', 'reject', 'needs-review', 'technical-failed', 'unprocessed']), cropReviewed: z.boolean(), leftCrop: z.enum(['accepted', 'damaged', 'unknown']).optional(), rightCrop: z.enum(['accepted', 'damaged', 'unknown']).optional(), calls: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative() })
export const evaluationSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.EvaluationId'>(), kind: z.literal('evaluation'), executionOutcome: z.enum(['completed', 'budget-exhausted']), left: standardRefSchema, right: standardRefSchema, splitId: opaque, usageRevisionId: opaque, recipeId: opaque, budgetDigest: digestSchema, items: z.array(evaluationItemSchema), metrics: z.record(z.string(), metricSchema), cost: z.discriminatedUnion('status', [z.strictObject({ status: z.literal('unknown') }), z.strictObject({ status: z.literal('estimated'), amount: z.number().nonnegative(), currency: z.string() })]), assessment: z.enum(['unassessed', 'accepted', 'rejected']), notes: z.array(z.string()) })
export type EvaluationReport = z.infer<typeof evaluationSchema>
export const exportSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.ExportId'>(), kind: z.literal('export'), access: accessSchema, formatVersion: z.literal(1), exportKind: z.enum(['style', 'classification', 'preference', 'crop', 'skill']), purpose: z.enum(['training', 'development', 'holdout', 'reference']), releaseId: opaque, usageRevisionId: opaque.optional(), splitId: opaque, feedbackIds: z.array(opaque), feedbackHeads: z.record(z.string(), opaque), resources: z.array(z.strictObject({ assetId: opaque, imageVersionId: opaque, digest: z.string(), familyId: opaque, split: z.enum(['learning', 'development', 'holdout']), storageRef: opaque.optional() })), mode: z.enum(['references-only', 'with-bytes']), actor: z.union([humanActorSchema, z.strictObject({ kind: z.literal('agent'), id: opaque, sessionId: opaque })]), files: z.array(z.strictObject({ name: z.string(), content: z.string(), checksum: digestSchema })), exclusions: z.record(z.string(), z.number().int().nonnegative()) })
export type ExportSnapshot = z.infer<typeof exportSchema>
/** Run persistence leaves stage data extensible while validating lifecycle tags. */
export const runSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.RunId'>(), kind: z.literal('run'), owner: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('profile') }), z.strictObject({ kind: z.literal('session'), sessionId: opaque })]), revision: z.number().int().positive(), status: z.enum(['created', 'running', 'pausing', 'paused', 'interrupted', 'cancelling', 'cancelled', 'completed', 'failed']), stage: z.enum(['planning', 'retrieving', 'screening', 'cropping', 'reviewing', 'finalizing']).nullable(), spec: jsonSchema, outcome: z.enum(['target-met', 'source-exhausted', 'budget-exhausted', 'partial-failure']).optional(), data: jsonSchema })
export type RunRecord = z.infer<typeof runSchema>
export const assessmentSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.AssessmentId'>(), kind: z.literal('assessment'), imageVersionId: opaque, runId: opaque, stage: z.enum(['source', 'final']), releaseId: opaque.optional(), standard: standardRefSchema.optional(), recipeId: opaque, reviewBundleId: opaque, technicalStatus: z.enum(['completed', 'failed']), verdict: z.enum(['pass', 'reject', 'needs-review']).optional(), ruleResults: z.array(z.strictObject({ ruleId: opaque, result: z.enum(['satisfied', 'violated', 'unknown', 'not-applicable']), basis: z.enum(['measured', 'inferred']), reason: z.string(), region: normalizedRectSchema.optional() })), cropPotential: z.enum(['direct', 'crop-candidate', 'infeasible', 'unknown']), preferenceScores: z.partialRecord(dimensionSchema, z.number().finite()), data: jsonSchema }).refine(r => r.technicalStatus !== 'failed' || r.verdict === undefined, 'Technical failure is not an aesthetic verdict').refine(r => r.releaseId !== undefined || r.standard !== undefined, 'An assessment requires a fixed standard')
export type Assessment = z.infer<typeof assessmentSchema>
export const requestSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.RequestId'>(), kind: z.literal('request'), runId: opaque, state: z.enum(['reserved', 'committed', 'outcome-unknown']), requestDigest: digestSchema, data: jsonSchema })
export const checkpointSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.CheckpointId'>(), kind: z.literal('checkpoint'), runId: opaque, runRevision: z.number().int().positive(), data: jsonSchema })
export const cropCandidateSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.CropCandidateId'>(), kind: z.literal('cropCandidate'), parentImageVersionId: opaque, runId: opaque, releaseId: opaque, usageRevisionId: opaque, recipeId: opaque, requestedRect: normalizedRectSchema, effectivePixelRect: pixelRectSchema.optional(), geometryResult: z.enum(['pass', 'failed']), origin: z.enum(['model', 'program', 'human']), derivedImageVersionId: opaque.optional(), finalAssessmentId: opaque.optional(), data: jsonSchema })
export const selectionSchema = z.strictObject({ ...base, id: brandedIdSchema<'VisualCurator.SelectionId'>(), kind: z.literal('selection'), runId: opaque, imageVersionId: opaque, assessmentId: opaque, qualification: z.enum(['auto-qualified', 'human-selected']), rank: z.number().int().nonnegative(), warnings: z.array(z.string()) })
/** Every durable record has a closed schema version and kind. */
export const recordSchema = z.discriminatedUnion('kind', [assetSchema, imageVersionSchema, referenceSchema, recipeSchema, styleSchema, draftSchema, candidateSchema, releaseSchema, modelProfileSchema, profileExportSchema, usageSchema, feedbackSchema, feedbackThreadSchema, suggestionSchema, observationSchema, familyConfirmationSchema, familyGroupSchema, splitSchema, evaluationSchema, exportSchema, runSchema, assessmentSchema, requestSchema, checkpointSchema, cropCandidateSchema, selectionSchema])
export type CuratorRecord = z.infer<typeof recordSchema>
export type RecordKind = CuratorRecord['kind']
export type RecordOf<K extends RecordKind> = Extract<CuratorRecord, { kind: K }>
/** @param a Positive integer. @param b Positive integer. @returns Greatest common divisor. */
function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b) }
