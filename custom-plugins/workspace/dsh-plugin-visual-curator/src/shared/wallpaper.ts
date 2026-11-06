/** Versioned wallpaper settings, inferred scene evidence and resumable per-image progress. */
import { z } from 'zod'
import { blobRefSchema } from './model.ts'

const text = z.string().trim().min(1).max(4096)
const id = z.string().min(1).max(256)
/** Prompt content and identifiers are frozen with each task, independently of future plugin edits. */
export const wallpaperPromptBundleSchema = z.strictObject({
  plan: z.strictObject({ version: z.literal('wallpaper-plan-v1'), text: z.string().min(1) }),
  review: z.strictObject({ version: z.literal('wallpaper-review-v1'), text: z.string().min(1) }),
  outpaint: z.strictObject({ version: z.literal('wallpaper-outpaint-v1'), text: z.string().min(1) }),
  distill: z.strictObject({ version: z.literal('wallpaper-distill-v1'), text: z.string().min(1) }),
})
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(r => r.x + r.width <= 1 && r.y + r.height <= 1)
/** Deployment defaults are frozen when a wallpaper task is accepted. */
export const wallpaperSettingsSchema = z.strictObject({
  version: z.literal(1).default(1), width: z.literal(1845).default(1845), height: z.literal(3280).default(3280),
  safe: z.strictObject({ left: z.literal(258).default(258), top: z.literal(1032).default(1032), width: z.literal(1329).default(1329), height: z.literal(1686).default(1686) }).default({ left: 258, top: 1032, width: 1329, height: 1686 }),
  topBuffer: z.number().int().min(0).max(256).default(32), sideOverflow: z.number().int().min(0).max(258).default(66), bottomOverflow: z.number().int().min(0).max(562).default(84),
  concurrency: z.number().int().min(1).max(8).default(2), maxReworks: z.number().int().min(0).max(2).default(2), maxEditsPerImage: z.number().int().min(0).max(2).default(2),
  imageProvider: z.string().min(1).default('autoflow-codex'), imageModel: z.string().default(''), imageSize: z.string().min(1).default('1872x3328'), imageQuality: z.enum(['auto', 'low', 'medium', 'high']).default('high'),
  learningEnabled: z.boolean().default(true), autoPromote: z.boolean().default(true), learningInterval: z.number().int().positive().default(20), minBenchmarks: z.number().int().min(12).default(12), maxEvalVisionCalls: z.number().int().positive().max(48).default(48), maxSkillChars: z.number().int().min(1000).max(16000).default(4000),
})
/** Frozen wallpaper processing policy. */
export type WallpaperSettings = z.infer<typeof wallpaperSettingsSchema>
/** Modes describe visual organization rather than a closed list of object classes. */
export const wallpaperModeSchema = z.enum(['single', 'group', 'scene', 'abstract', 'uncertain'])
/** Inferred regions on the EXIF-oriented source; they are not measured segmentation masks. */
export const wallpaperPlanSchema = z.strictObject({
  version: z.literal(1), imageVersionId: id, mode: wallpaperModeSchema, subject: text, evidence: text,
  priorities: z.array(text).max(16), anchors: z.array(text).max(16), truncations: z.array(text).max(16), uncertainties: z.array(text).max(16),
  regions: z.array(z.strictObject({ name: text, role: z.enum(['subject', 'critical', 'anchor']), rect })).max(32),
  placement: z.strictObject({ scale: z.number().finite().positive().max(1), left: z.number().int(), top: z.number().int() }),
  reason: text,
})
/** Source-grounded layout, including an isotropic transform that never enlarges the original. */
export type WallpaperPlan = z.infer<typeof wallpaperPlanSchema>
/** Every visual acceptance dimension must be reported independently. */
export const wallpaperReviewKeys = ['subject', 'protection', 'clock', 'readability', 'composition', 'background', 'style'] as const
const check = z.strictObject({ result: z.enum(['satisfied', 'violated', 'unknown']), reason: text })
/** An independent reviewer sees actual final pixels, not the planner's expected verdict. */
export const wallpaperReviewSchema = z.strictObject({
  subject: text, checks: z.record(z.enum(wallpaperReviewKeys), check),
  issues: z.array(z.strictObject({ kind: z.enum(['layout', 'preservation', 'background', 'readability', 'style', 'unknown']), reason: text })).max(32),
})
/** Structured visual review; the Host computes the final verdict. */
export type WallpaperReview = z.infer<typeof wallpaperReviewSchema>
const generation = z.strictObject({ id, provider: id, model: id, taskId: id })
/** Each round preserves its plan, artifacts and actual review; revising a plan does not erase history. */
export const wallpaperAttemptSchema = z.strictObject({
  revision: z.number().int().positive(), plan: wallpaperPlanSchema,
  checks: z.array(z.string()), needsOutpaint: z.boolean(),
  canvasId: id.optional(), maskId: id.optional(), analysisId: id.optional(), simulationId: id.optional(), outputId: id.optional(),
  generation: generation.optional(), generationOperation: id.optional(), editReserved: z.boolean().optional(), review: wallpaperReviewSchema.optional(),
  retryFrom: z.enum(['planning', 'reviewing']).optional(), retryTarget: z.enum(['planning', 'rendering']).optional(),
})
/** Saved progress for one qualified source. */
export const wallpaperItemSchema = z.strictObject({
  imageVersionId: id, originalId: id.optional(), familyId: id, status: z.enum(['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'passed', 'rejected', 'needs-review', 'technical-failed']),
  download: z.strictObject({ attempts: z.number().int().nonnegative(), retrying: z.boolean(), originalBlob: blobRefSchema.optional(), byteLength: z.number().int().nonnegative().optional(), savedAt: z.iso.datetime().optional(), reused: z.boolean().optional(), lastErrorCode: z.string().optional() }).optional(),
  edits: z.number().int().nonnegative().default(0), attempts: z.array(wallpaperAttemptSchema).default([]),
  reason: z.string().optional(), errorCode: z.string().optional(),
  failedStep: z.enum(['downloading', 'planning', 'rendering', 'reviewing']).optional(),
})
/** Recoverable per-source state. */
export type WallpaperItem = z.infer<typeof wallpaperItemSchema>
/** One immutable input queue with mutable checkpoint progress owned by its Run. */
export const wallpaperStateSchema = z.strictObject({ version: z.literal(1), sourceRunId: id, skillVersion: id, items: z.array(wallpaperItemSchema), budgetStopped: z.boolean().default(false) })
/** Parsed checkpoint used by Host execution and Client projections. */
export type WallpaperState = z.infer<typeof wallpaperStateSchema>
/** Locate legacy original failures without modifying the saved checkpoint.
 * @param item Saved source and its execution evidence.
 * @returns Owning failed step, including pre-download-node records.
 */
export function wallpaperFailedStep(item: WallpaperItem): WallpaperItem['failedStep'] {
  return !item.originalId && !item.attempts.length && item.failedStep === 'planning' ? 'downloading' : item.failedStep
}
/** Summarize committed per-image stages without projecting the whole Run as an active node.
 * @param state Saved queue and its latest attempts.
 * @returns Stage activity, completed artifacts, failures and images blocked by upstream steps.
 */
export function wallpaperProgress(state: WallpaperState): Record<string, number> {
  const count = (matches: (item: WallpaperItem) => boolean) => state.items.filter(matches).length
  const stopped = (item: WallpaperItem) => ['rejected', 'needs-review', 'technical-failed'].includes(item.status)
  const planned = (item: WallpaperItem) => !!item.attempts.at(-1) && !item.attempts.at(-1)!.checks.length && item.attempts.at(-1)!.plan.mode !== 'uncertain'
  return {
    ...Object.fromEntries(['queued', 'downloading', 'planning', 'rendering', 'reviewing', 'passed', 'rejected', 'needs-review', 'technical-failed'].map(status => [status, count(item => item.status === status)])),
    downloaded: count(item => !!item.originalId && wallpaperFailedStep(item) !== 'downloading'), downloadingFailed: count(item => wallpaperFailedStep(item) === 'downloading'),
    downloadingRetrying: count(item => item.status === 'downloading' && item.download?.retrying === true),
    planned: count(planned), rendered: count(item => !!item.attempts.at(-1)?.outputId), reviewed: count(item => !!item.attempts.at(-1)?.review),
    planningFailed: count(item => wallpaperFailedStep(item) === 'planning' || !!item.attempts.at(-1)?.checks.length),
    renderingFailed: count(item => item.failedStep === 'rendering'),
    reviewingFailed: count(item => item.failedStep === 'reviewing' || !!item.attempts.at(-1)?.review && wallpaperVerdict(item.attempts.at(-1)!.review!) !== 'pass'),
    planningAttention: count(item => item.status === 'needs-review' && (!planned(item) || item.attempts.at(-1)?.plan.mode === 'uncertain')),
    renderingAttention: count(item => item.status === 'needs-review' && planned(item) && item.attempts.at(-1)?.plan.mode !== 'uncertain' && !item.attempts.at(-1)?.outputId),
    planningBlocked: count(item => stopped(item) && (!item.originalId || wallpaperFailedStep(item) === 'downloading')),
    renderingBlocked: count(item => stopped(item) && (wallpaperFailedStep(item) === 'planning' || !planned(item) || item.attempts.at(-1)?.plan.mode === 'uncertain')),
    reviewingBlocked: count(item => stopped(item) && !item.attempts.at(-1)?.outputId),
  }
}
/** Read-only authorized canvas state, with image resources resolved by the existing resource endpoint. */
export const wallpaperViewSchema = z.object({
  runId: id, sourceRunId: id, status: z.string(), settings: wallpaperSettingsSchema, state: wallpaperStateSchema,
  resources: z.record(z.string(), z.string()),
  total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), counts: z.record(z.string(), z.number().int().nonnegative()),
  warnings: z.array(z.string()), errorCode: z.string().optional(),
})
/** Canvas task state. */
export type WallpaperView = z.infer<typeof wallpaperViewSchema>
/** Start identity pins the complete source batch; no Client-supplied image list can add unqualified inputs. */
export const wallpaperStartSchema = z.strictObject({ operationId: id, sourceRunId: id, settings: wallpaperSettingsSchema.optional() })
/** Scoped experience evidence remains distinct from human feedback and model weights. */
export const wallpaperExperienceSchema = z.strictObject({
  version: z.literal(1), cases: z.array(z.strictObject({ id, familyId: id, runId: id, imageVersionId: id, mode: wallpaperModeSchema, passed: z.boolean(), rounds: z.number().int().nonnegative(), needsGeneration: z.boolean(), reason: z.string(), learningEligible: z.boolean().default(false), benchmark: z.boolean().default(false), expectedPass: z.boolean().optional(), confirmedBy: z.string().min(1).optional(), confirmedAt: z.string().optional() }).refine(row => !row.benchmark || row.expectedPass !== undefined && row.confirmedBy !== undefined, 'Benchmark labels require an explicit human author and expected result')),
  active: id, autoPromote: z.boolean(), lastDistilledCount: z.number().int().nonnegative(), distilledFamilyIds: z.array(id).default([]),
  versions: z.array(z.strictObject({ id, content: z.string(), createdAt: z.string(), status: z.enum(['candidate', 'pending-evidence', 'verified', 'active', 'retired']), reason: z.string(), caseIds: z.array(id), parentId: id.optional(), changes: z.strictObject({ added: z.array(z.string()), removed: z.array(z.string()) }).optional(), evaluation: z.strictObject({ compared: z.number().int().nonnegative(), baselinePass: z.number().int().nonnegative(), candidatePass: z.number().int().nonnegative(), baselineRounds: z.number(), candidateRounds: z.number(), falseAccepts: z.number().int().nonnegative() }).optional() })),
}).refine(state => state.versions.filter(row => row.id === state.active && row.status === 'active').length === 1 && state.versions.filter(row => row.status === 'active').length === 1, 'The active Skill must identify exactly one saved active revision')
/** Profile-private experience catalog. */
export type WallpaperExperience = z.infer<typeof wallpaperExperienceSchema>
/** Distillation may cite only supplied cases and cannot redefine task constraints. */
export const wallpaperDistillationSchema = z.strictObject({ guidance: text, evidenceCaseIds: z.array(id).min(1), requiresNewGeneration: z.boolean() })

/** Compute a Host verdict without interpreting model confidence as probability.
 * @param review Actual-pixel review.
 * @returns Required-first acceptance result.
 */
export function wallpaperVerdict(review: WallpaperReview): 'pass' | 'reject' | 'needs-review' {
  const checks = wallpaperReviewKeys.map(key => review.checks[key].result)
  return checks.includes('violated') ? 'reject' : checks.includes('unknown') ? 'needs-review' : 'pass'
}
