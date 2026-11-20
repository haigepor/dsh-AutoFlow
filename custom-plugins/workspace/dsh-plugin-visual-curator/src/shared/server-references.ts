/** Workbench data for explicitly selecting rated server images. */
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'

/** Host credential slot dedicated to the OPPO feedback service. */
export const serverReferenceCredential = 'VISUAL_CURATOR_OPPO_FEEDBACK_TOKEN'

/** One server image version, independent of its mutable rating. */
export type ServerReferenceKey = Branded<'VisualCurator.ServerReferenceKey'>
const imageKey = z.string().regex(/^[a-f0-9]{64}$/).transform(key => brandString<ServerReferenceKey>(key))

const serverReferenceImageSchema = z.object({
  key: imageKey,
  itemId: z.string().min(1),
  name: z.string().min(1),
  grade: z.string().min(1).nullable(),
  score: z.number().nullable(),
  previewPath: z.string().min(1),
})

/** A complete, deduplicated rating window and its authorized previews. */
export const serverReferenceCatalogSchema = z.object({
  snapshotId: z.uuid(),
  startDate: z.string(),
  endDate: z.string(),
  ignored: z.number().int().nonnegative(),
  items: z.array(serverReferenceImageSchema),
})
export type ServerReferenceCatalog = z.infer<typeof serverReferenceCatalogSchema>
export type ServerReferenceImage = z.infer<typeof serverReferenceImageSchema>

/** Import only explicit selections from one owner-bound listing. */
export const serverReferenceImportSchema = z.strictObject({
  operationId: z.uuid(),
  snapshotId: z.uuid(),
  styleId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  role: z.enum(['positive', 'negative']),
  keys: z.array(imageKey).min(1),
})

/** Committed outcomes for each requested image, in selection order. */
export const serverReferenceReceiptSchema = z.object({
  results: z.array(z.object({
    key: imageKey,
    status: z.enum(['added', 'skipped', 'failed']),
    code: z.string().optional(),
  })),
})
export type ServerReferenceReceipt = z.infer<typeof serverReferenceReceiptSchema>

/** @param images Deduplicated items from one visible rating window. @returns Grade groups with S first, unrated last and descending numeric scores within each group. */
export function groupServerReferences(images: readonly ServerReferenceImage[]) {
  const groups = new Map<string | null, ServerReferenceImage[]>()
  for (const image of images) {
    const group = groups.get(image.grade)
    if (group) group.push(image)
    else groups.set(image.grade, [image])
  }
  return Array.from(groups, ([grade, items]) => ({
    grade,
    items: items.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.itemId.localeCompare(b.itemId)),
  })).sort((a, b) => {
    if (a.grade === b.grade) return 0
    if (a.grade === 'S' || b.grade === null) return -1
    if (b.grade === 'S' || a.grade === null) return 1
    return a.grade.localeCompare(b.grade)
  })
}
