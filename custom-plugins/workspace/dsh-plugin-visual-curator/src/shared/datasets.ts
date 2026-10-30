/** Validated UI messages for immutable profile-reference packages and their owning runs. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { dimensionSchema, modelProfileSchema, profileExportSchema, runSchema } from './model.ts'

/** One list row keeps its identity when a run gains a completed export. */
export type DatasetId = Branded<'VisualCurator.DatasetId'>
/** Opaque collection/filter-bound page continuation. */
export type DatasetPageToken = Branded<'VisualCurator.DatasetPageToken'>
const identity = z.string().min(1).transform(value => brandString<DatasetId>(value))
const pageToken = z.string().min(1).transform(value => brandString<DatasetPageToken>(value))
const count = z.number().int().nonnegative()
/** A zero total means the current phase has no determinate work count. */
export const datasetProgressSchema = z.strictObject({ phase: z.enum(['verifying', 'samples', 'files', 'saving']), completed: count, total: count, unit: z.enum(['references', 'samples', 'files', 'items']) }).refine(value => value.total === 0 ? value.completed === 0 : value.completed <= value.total, 'Progress exceeds its reported total')
/** Progress persisted inside the existing extensible run checkpoint JSON. */
export type DatasetProgress = z.infer<typeof datasetProgressSchema>
/** Lightweight task/artifact summary; no prompts, images or raw file contents. */
export const datasetEntrySchema = z.strictObject({
  id: identity, runId: runSchema.shape.id.optional(), exportId: profileExportSchema.shape.id.optional(),
  styleId: z.string(), name: z.string(), modelProfileId: modelProfileSchema.shape.id, profileRevision: count, model: z.string(), contentDigest: z.string(),
  createdAt: z.string(), status: runSchema.shape.status, progress: datasetProgressSchema.optional(),
  counts: z.strictObject({ references: count, rules: count, candidates: count, groups: count, enabledGroups: count, files: count }),
  byteLength: count.optional(), downloadPath: z.string().optional(),
  error: z.object({ code: z.string(), safeMessage: z.string(), suggestedAction: z.string() }).optional(),
})
/** One owner-authorized dataset task or completed package. */
export type DatasetEntry = z.infer<typeof datasetEntrySchema>
/** Authorized, ordered list page including the unfiltered collection count. */
export const datasetListSchema = z.strictObject({ styleId: z.string(), total: count, allTotal: count, entries: z.array(datasetEntrySchema), nextPageToken: pageToken.optional() })
/** Dataset list page consumed independently of image workspace snapshots. */
export type DatasetList = z.infer<typeof datasetListSchema>
/** Exact-profile and reusable-package filters are validated before projection and pagination. */
export const datasetListInputSchema = z.object({ styleId: z.string().min(1), query: z.string().max(200).default(''), status: z.enum(['all', 'active', 'completed', 'failed']).default('all'), pageToken: pageToken.optional(), modelProfileId: modelProfileSchema.shape.id.optional(), reusableOnly: z.boolean().default(false) })
/** File previews are optional and bounded by the Host's existing preview limit. */
export const datasetFileSchema = z.strictObject({ name: z.string(), bytes: count, checksum: z.string(), verified: z.boolean(), preview: z.string(), truncated: z.boolean() })
/** Frozen observations retain missing fields and uncertainty without fabricated measurements. */
export const datasetSampleSchema = z.strictObject({ imageVersionId: z.string(), referenceId: z.string(), role: z.enum(['positive', 'negative', 'undecided']), previewPath: z.string().optional(), previewSize: z.strictObject({ width: count.positive(), height: count.positive() }).optional(), unavailable: z.boolean(), measuredCount: count, observations: z.array(z.strictObject({ field: z.string(), value: z.json(), uncertain: z.boolean() })) })
/** Read-only projections of the selected export's files, never its current replacement profile. */
export const datasetDetailSchema = z.strictObject({
  entry: datasetEntrySchema, summary: z.string(), matchingPrompt: z.string(),
  rules: z.array(z.strictObject({ id: z.string(), dimension: dimensionSchema, statement: z.string(), enabled: z.boolean(), groupId: z.string().nullable(), strength: z.string(), confirmed: z.boolean(), source: z.string(), supportCount: count })),
  groups: z.array(z.strictObject({ id: z.string(), name: z.string(), imageCount: count, enabledRules: count })),
  samples: z.array(datasetSampleSchema), sampleTotal: count, nextSamplePageToken: pageToken.optional(), files: z.array(datasetFileSchema),
  resources: z.strictObject({ remote: count, total: count, pixelDigests: count, humanAccepts: count }),
})
/** Frozen detail with bounded file previews and a sample window. */
export type DatasetDetail = z.infer<typeof datasetDetailSchema>
/** Detail identity and optional frozen-sample continuation. */
export const datasetDetailInputSchema = z.object({ id: identity, pageToken: pageToken.optional() })
