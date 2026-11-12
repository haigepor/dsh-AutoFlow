/** Source observations keep edit readiness separate from unseen facts and final quality acceptance. */
import { z } from 'zod'

const text = z.string().trim().min(1).max(4096)
const id = z.string().min(1).max(256)
/** Normalized coordinates always refer to the complete, oriented original frame. */
export const wallpaperSourceRegionSchema = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1)
/** Detail inspection and routing use the same distinction between visible damage and intentionally unseen facts. */
export const wallpaperFindingSchema = z.strictObject({
  concernId: id, scope: z.enum(['subject', 'critical', 'background', 'technical']),
  classification: z.enum(['frame-truncation', 'normal-occlusion', 'background-crop', 'observation-limit', 'technical-failure', 'resolved', 'unknown', 'edge-continuation', 'unseen-detail']),
  blocking: z.boolean(), reason: text, evidenceImageVersionIds: z.array(id).min(1).max(32), sourceRegion: wallpaperSourceRegionSchema.optional(),
})
/** An explicitly retained uncertainty remains in the evidence without becoming a request to invent unseen structure. */
export const wallpaperRetainedUncertaintySchema = z.strictObject({ concernId: id, text })
/** Only frame-edge continuation can be authorized; unseen identity-critical structure remains a hold. */
export const wallpaperEdgeRepairSchema = z.strictObject({ classification: z.enum(['edge-continuation', 'identity-critical', 'unknown', 'not-needed']), edges: z.array(z.enum(['left', 'top', 'right', 'bottom'])).max(4), reason: text, instruction: text })
/** Current repair evidence binds protected-subject edges to supplied native pixels; legacy records omit these fields. */
export const wallpaperEdgeRepairEvidenceSchema = wallpaperEdgeRepairSchema.extend({
  concernIds: z.array(id).min(1).max(19).optional(), sourceRegion: wallpaperSourceRegionSchema.optional(), evidenceImageVersionIds: z.array(id).min(1).max(8).optional(),
})
/** Native crop coordinates are measured by the Host, never supplied by a model. */
export interface WallpaperNativeDetail {
  imageVersionId: string
  sourceRect?: z.infer<typeof wallpaperSourceRegionSchema> | undefined
}
/** @param region Original-frame region to inspect. @param evidenceIds Images cited by the finding. @param views Host-measured native crops. @returns Whether a cited crop contains the whole region. */
export function wallpaperNativeDetailCovers(region: z.infer<typeof wallpaperSourceRegionSchema>, evidenceIds: readonly string[], views: readonly WallpaperNativeDetail[]): boolean {
  return views.some(view => {
    const crop = view.sourceRect
    return crop && evidenceIds.includes(view.imageVersionId) && crop.x <= region.x && crop.y <= region.y && crop.x + crop.width >= region.x + region.width && crop.y + crop.height >= region.y + region.height
  })
}
/** @param finding Validated source finding. @returns Whether editing still depends on missing visible or technical evidence. */
export function wallpaperFindingBlocksEditing(finding: z.infer<typeof wallpaperFindingSchema>): boolean {
  return finding.blocking || finding.classification === 'technical-failure' || (finding.scope === 'subject' || finding.scope === 'critical') && ['frame-truncation', 'observation-limit', 'unknown'].includes(finding.classification)
}
