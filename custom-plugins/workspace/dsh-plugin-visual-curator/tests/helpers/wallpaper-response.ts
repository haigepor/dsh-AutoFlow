/** Scripted pixel findings keep their meaning while matching the explicitly requested wallpaper wire version. */
import { z } from 'zod'

/** @param descriptor Actual compatible-vision request text. @param output Independently scripted fixture findings. @returns The same findings with required current protocol metadata. */
function fixtureResponse(descriptor: unknown, output: unknown): unknown {
  const schema = z.object({ outputSchema: z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional(), $defs: z.record(z.string(), z.unknown()).optional() }) }).parse(descriptor).outputSchema
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => {
    const reference = z.object({ $ref: z.string().startsWith('#/$defs/') }).safeParse(value)
    return [name, reference.success ? schema.$defs?.[reference.data.$ref.slice('#/$defs/'.length)] : value]
  }))
  const row = z.record(z.string(), z.unknown()).parse(output)
  if (properties.editPrompt && properties.reason && properties.imageVersionId && !properties.objectRoles && !properties.regions) return z.object({ imageVersionId: z.string(), editPrompt: z.string(), reason: z.string() }).parse(row)
  if (schema.required?.includes('sourceMedium')) {
    const observed = z.object({ objectRoles: z.array(z.object({ name: z.string(), evidence: z.string() }).passthrough()) }).parse(row)
    return { ...row, sourceMedium: row.sourceMedium ?? 'photograph', ...(schema.required.includes('actionPartIds') ? { actionPartIds: row.actionPartIds ?? [] } : {}),
      objectRoles: observed.objectRoles.map(object => ({ ...object, sourceIntent: object.sourceIntent ?? { framing: 'whole', visibility: 'visible', preserve: [object.evidence], relationships: [] } })) }
  }
  if (z.object({ const: z.string().optional() }).safeParse(properties.protocol).data?.const === 'practical-v2' && row.protocol === 'practical-v1') {
    const usage = z.object({ input: z.object({ usage: z.object({ objectPolicy: z.object({ objectRoles: z.array(z.object({ entityId: z.string(), role: z.string() })) }) }) }) }).parse(descriptor).input.usage
    const satisfied = { result: 'satisfied', reason: 'The independently scripted fixture retains this original property.' }
    return { ...row, protocol: 'practical-v2', sourcePreservation: usage.objectPolicy.objectRoles.filter(object => object.role !== 'supporting').map(object => ({ entityId: object.entityId, framing: satisfied, appearance: satisfied, relationships: satisfied })), sourceStyle: satisfied }
  }
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

/** @param descriptor Actual vision schema and object identities. @param output Scripted pixel findings. @returns Versioned findings with required object counts. */
export function wallpaperFixtureResponse(descriptor: unknown, output: unknown): unknown {
  const result = fixtureResponse(descriptor, output)
  const schema = z.object({ outputSchema: z.object({ required: z.array(z.string()).optional() }), input: z.object({ usage: z.unknown().optional() }) }).parse(descriptor)
  if (!schema.outputSchema.required?.includes('inventory')) return result
  const row = z.record(z.string(), z.unknown()).parse(result)
  const usage = z.object({ objectPolicy: z.object({ objectRoles: z.array(z.object({ entityId: z.string(), role: z.string(), rect: z.unknown() })) }) }).parse(schema.input.usage)
  return { ...row, inventory: usage.objectPolicy.objectRoles.filter(object => object.role !== 'critical-part').map(object => ({ entityId: object.entityId, status: 'retained', sourceInstances: [object.rect], instances: [object.rect], reason: 'The scripted fixture contains one instance.' })), newForeground: [] }
}
