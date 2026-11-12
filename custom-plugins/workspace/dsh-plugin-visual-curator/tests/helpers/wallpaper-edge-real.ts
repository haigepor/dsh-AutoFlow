/** Saved Desktop model responses contain no image bytes, credentials or mutable task records. */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { wallpaperPlanSchema } from '../../src/shared/wallpaper.ts'
import { wallpaperPlanConcerns, wallpaperPlanDetailOutputSchema } from '../../src/shared/wallpaper-detail.ts'
import { wallpaperSourceRegionSchema, type WallpaperNativeDetail } from '../../src/shared/wallpaper-evidence.ts'

/** The actual mixed response retains cut-off source extent, three unresolved concerns and three observation limits. */
export const realWallpaperEdgeEvidence = z.object({
  source: z.object({ runId: z.string(), imageVersionId: z.string(), detailRequestId: z.string(), decisionRequestId: z.string() }),
  plan: wallpaperPlanSchema, detail: z.json(), decision: z.json(), decisionIssues: z.array(z.string()), malformedDecision: z.string(),
  nativeDetails: z.array(z.object({ imageVersionId: z.string(), sourceRect: wallpaperSourceRegionSchema })),
  decisionInput: z.object({ concerns: z.array(z.object({ id: z.string(), text: z.string(), scope: z.enum(['subject', 'critical', 'background', 'technical']).optional() })), context: z.object({ mode: wallpaperPlanSchema.shape.mode, hasProtectedSubject: z.boolean() }), images: z.array(z.string()) }),
}).parse(JSON.parse(await readFile(new URL('../fixtures/wallpaper-edge-real-response.json', import.meta.url), 'utf8')))

/** Explicit V5 annotations of the saved facts; this is an isolated fixture, never a runtime conversion of legacy evidence.
 * @param sourceId Isolated source identity; omission preserves the saved identity.
 * @param nativeDetails Actual request crops; omission uses saved measured crop coordinates.
 * @returns The same observations with edit-readiness classifications and a left-only protected-subject repair target.
 */
export function realWallpaperEdgeDetail(sourceId = realWallpaperEdgeEvidence.source.imageVersionId, nativeDetails: readonly WallpaperNativeDetail[] = realWallpaperEdgeEvidence.nativeDetails) {
  const saved = wallpaperPlanDetailOutputSchema(realWallpaperEdgeEvidence.source.imageVersionId, wallpaperPlanConcerns(realWallpaperEdgeEvidence.plan), realWallpaperEdgeEvidence.nativeDetails.map(view => view.imageVersionId), 'wallpaper-plan-detail-v4').parse(realWallpaperEdgeEvidence.detail)
  if (saved.version !== 'wallpaper-plan-detail-v4') throw new Error('The saved response must retain its V4 protocol.')
  const left = { x: 0, y: 0.69, width: 0.24, height: 0.21 }, occluded = { x: 0.52, y: 0.335, width: 0.36, height: 0.115 }
  const evidenceFor = (region = left) => {
    const view = nativeDetails.find(view => {
      const crop = view.sourceRect
      return crop && crop.x <= region.x && crop.y <= region.y && crop.x + crop.width >= region.x + region.width && crop.y + crop.height >= region.y + region.height
    }) ?? nativeDetails[0]
    return view ? [view.imageVersionId] : []
  }
  const editPrompt = '保持夕照天空、云层与远山的单一透视，向外衔接浅粉与灰白碎石坡。仅在左缘原图外沿现有蓝灰生石花叶瓣做最小延续，使实心叶瓣自然闭合，保留蓝灰底色、深色斑纹与哑光质感；不新增叶瓣、花朵或植株，不用半透明、淡出或阴影吞没轮廓。珊瑚色植株的遮挡背面、右缘无法辨认的块状物与干花茎种类保持未知，不补造结构。'
  return {
    ...saved, version: 'wallpaper-plan-detail-v5' as const, imageVersionId: sourceId,
    protectedSubjectExtent: { ...saved.protectedSubjectExtent, evidenceImageVersionIds: evidenceFor() },
    edgeRepair: { ...saved.edgeRepair, edges: ['left'] as const, concernIds: ['source-extent'], sourceRegion: left, evidenceImageVersionIds: evidenceFor(), instruction: editPrompt },
    findings: [
      ...saved.findings.map(finding => {
        const occlusion = finding.concernId === 'uncertainty:1', background = finding.concernId === 'uncertainty:2', repair = finding.concernId === 'source-extent'
        const sourceRegion = background ? undefined : occlusion ? occluded : left
        return { ...finding, scope: background ? 'background' as const : 'critical' as const, classification: repair ? 'edge-continuation' as const : occlusion ? 'normal-occlusion' as const : 'unseen-detail' as const, blocking: false, evidenceImageVersionIds: evidenceFor(sourceRegion), ...(sourceRegion ? { sourceRegion } : {}) }
      }),
      { concernId: 'observation:1', result: 'unresolved' as const, scope: 'background' as const, classification: 'unseen-detail' as const, blocking: false, reason: saved.observation.uncertainties[1]!, evidenceImageVersionIds: evidenceFor() },
    ],
    retainedUncertainties: saved.observation.uncertainties.map((text, index) => ({ text, concernId: index === 0 ? 'uncertainty:1' : index === 1 ? 'observation:1' : 'uncertainty:2' })),
    observation: { ...saved.observation, imageVersionId: sourceId, editPrompt },
  }
}
