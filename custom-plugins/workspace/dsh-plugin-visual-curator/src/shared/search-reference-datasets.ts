/** Frozen negative observations supplement a complete style package without changing its rules. */
import { z } from 'zod'
import { datasetListSchema } from './datasets.ts'
import { referenceSchema, referenceSnapshotSchema, imageVersionSchema, observationSchema, profileExportSchema } from './model.ts'

/** Only current negative references may enter an accepted search's supplemental observations. */
export const searchNegativeReferencesSchema = z.strictObject({
  version: z.literal(1),
  datasets: z.array(z.strictObject({ exportId: profileExportSchema.shape.id, imageVersionIds: z.array(imageVersionSchema.shape.id) })),
  samples: z.array(z.strictObject({ reference: referenceSchema.extend({ role: z.literal('negative') }), imageDigest: z.string(), feedbackIds: referenceSnapshotSchema.shape.feedbackIds, judgments: referenceSnapshotSchema.shape.judgments.unwrap(), measured: observationSchema.shape.measured, inferred: observationSchema.shape.inferred })),
})
/** Immutable supplement; repeated dataset exports share one current observation per image. */
export type SearchNegativeReferences = z.infer<typeof searchNegativeReferencesSchema>
/** Counts shown before submission and again from the admitted snapshot. */
export const searchNegativeSummarySchema = z.strictObject({ datasets: z.number().int().nonnegative(), references: z.number().int().nonnegative() })
/** Completed main-package choices and the current collection's eligible negative supplement. */
export const searchLaunchDatasetsSchema = datasetListSchema.extend({ negativeReferences: searchNegativeSummarySchema })
