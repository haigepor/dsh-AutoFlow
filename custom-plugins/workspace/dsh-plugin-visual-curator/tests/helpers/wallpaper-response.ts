/** Scripted pixel findings keep their meaning while matching the explicitly requested wallpaper wire version. */
import { z } from 'zod'

/** @param descriptor Actual compatible-vision request text. @param output Independently scripted fixture findings. @returns The same findings with required current protocol metadata. */
export function wallpaperFixtureResponse(descriptor: unknown, output: unknown): unknown {
  const properties = z.object({ outputSchema: z.object({ properties: z.record(z.string(), z.unknown()) }) }).parse(descriptor).outputSchema.properties
  const row = z.record(z.string(), z.unknown()).parse(output)
  if (z.object({ const: z.string().optional() }).safeParse(properties.version).data?.const === 'wallpaper-generation-brief-v1') {
    const input = z.object({ input: z.object({ images: z.array(z.object({ imageVersionId: z.string() })) }) }).parse(descriptor).input
    return { version: 'wallpaper-generation-brief-v1', sourceImageVersionId: input.images[0]!.imageVersionId, canvasImageVersionId: input.images[1]!.imageVersionId,
      styleAnchors: ['Scripted original pigment grain.', 'Scripted broken dry-brush edges.', 'Scripted warm/cool tonal relationships.'], detailAnchors: ['Scripted subject silhouette.', 'Scripted material ridges.', 'Scripted original overlap relationships.'], preserveInstructions: 'Retain healthy source details.', extensionInstructions: 'Extend the same scene with natural layered background.', repairInstructions: 'Repair only the recorded defect.', negativeInstructions: ['No clock or date in the actual wallpaper.'], clockText: { evidence: 'absent', action: 'background-only', reason: 'Isolated fixture has no text.' },
      generationPrompt: 'Keep the positioned canvas as the geometry master. Preserve original pigment grain, broken dry-brush edges, original material ridges and overlap relationships. Extend only the missing natural scene and keep a clean clock-free background.' }
  }
  const requestedReview = z.object({ const: z.string().optional() }).safeParse(properties.reviewVersion).data?.const
  if (['wallpaper-review-source-v3', 'wallpaper-review-source-v4'].includes(requestedReview ?? '') && ['wallpaper-review-source-v1', 'wallpaper-review-source-v2', 'wallpaper-review-source-v3'].includes(String(row.reviewVersion))) {
    const final = z.object({ subjectIntegrity: z.object({ output: z.object({ imageVersionId: z.string() }) }) }).parse(row).subjectIntegrity.output
    const base = { ...row, reviewVersion: 'wallpaper-review-source-v3', sourceRepair: row.sourceRepair ?? { result: 'satisfied', reason: 'No source-edge completion is requested by this scripted fixture.' },
      sourceCorrespondence: row.sourceCorrespondence ?? { result: 'satisfied', reason: 'Scripted original and output retain the same subject.' },
      actualLayout: row.actualLayout ?? { imageVersionId: final.imageVersionId, regions: [{ name: 'Scripted visible subject', role: 'subject', rect: { x: 0.35, y: 0.5, width: 0.3, height: 0.2 } }, { name: 'Scripted identity', role: 'critical', rect: { x: 0.45, y: 0.56, width: 0.05, height: 0.04 } }] } }
    if (requestedReview === 'wallpaper-review-source-v3') return base
    const layout = z.object({ imageVersionId: z.string(), regions: z.array(z.object({ name: z.string(), role: z.string(), rect: z.unknown() })) }).parse(base.actualLayout)
    const issues = z.array(z.object({ kind: z.string(), reason: z.string() }).passthrough()).parse(row.issues)
    return { ...base, reviewVersion: 'wallpaper-review-source-v4', actualLayout: { ...layout, regions: layout.regions.map(region => ({ ...region, scope: 'core' })) },
      issues: issues.map(issue => ({ ...issue, check: issue.kind === 'layout' ? 'protection' : issue.kind === 'readability' ? 'readability' : issue.kind === 'background' ? 'background' : issue.kind === 'style' ? 'style' : 'subject', code: 'other' })) }
  }
  if (z.object({ const: z.string().optional() }).safeParse(properties.reviewVersion).data?.const === 'wallpaper-review-source-v2' && row.reviewVersion === 'wallpaper-review-source-v1') {
    return { ...row, reviewVersion: 'wallpaper-review-source-v2', sourceRepair: { result: 'satisfied', reason: 'No source-edge completion is requested by this scripted fixture.' } }
  }
  if (z.object({ const: z.string().optional() }).safeParse(properties.version).data?.const === 'wallpaper-plan-detail-v4' && row.version === 'wallpaper-plan-detail-v3') {
    const cut = z.object({ extent: z.string() }).parse(row.protectedSubjectExtent).extent === 'cut-off'
    return { ...row, version: 'wallpaper-plan-detail-v4', edgeRepair: { classification: cut ? 'identity-critical' : 'not-needed', edges: [], reason: cut ? 'The legacy scenario lacks affirmative evidence for an authorized edge continuation.' : 'This scenario does not need source-edge reconstruction.', instruction: 'Preserve the existing source evidence.' } }
  }
  if (z.object({ const: z.string().optional() }).safeParse(properties.version).data?.const === 'wallpaper-plan-detail-v5' && row.version === 'wallpaper-plan-detail-v3') {
    const cut = z.object({ extent: z.string() }).parse(row.protectedSubjectExtent).extent === 'cut-off'
    return { ...row, version: 'wallpaper-plan-detail-v5', edgeRepair: { classification: cut ? 'identity-critical' : 'not-needed', edges: [], reason: cut ? 'The legacy scenario lacks affirmative evidence for an authorized edge continuation.' : 'This scenario does not need source-edge reconstruction.', instruction: 'Preserve the existing source evidence.' }, retainedUncertainties: [],
      findings: z.array(z.object({ concernId: z.string(), result: z.string() }).passthrough()).parse(row.findings).map(finding => ({ ...finding, scope: 'subject', classification: finding.result === 'resolved' ? 'resolved' : 'observation-limit', blocking: finding.result !== 'resolved' })) }
  }
  return output
}
