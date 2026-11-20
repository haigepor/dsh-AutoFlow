/** Scripted pixel findings keep their meaning while matching the explicitly requested wallpaper wire version. */
import { z } from 'zod'

/** @param descriptor Actual compatible-vision request text. @param output Independently scripted fixture findings. @returns The same findings with required current protocol metadata. */
function fixtureResponse(descriptor: unknown, output: unknown): unknown {
  const request = z.object({ outputSchema: z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional(), $defs: z.record(z.string(), z.unknown()).optional() }), input: z.unknown().optional() }).parse(descriptor)
  const schema = request.outputSchema
  const properties = Object.fromEntries(Object.entries(schema.properties).map(([name, value]) => {
    const reference = z.object({ $ref: z.string().startsWith('#/$defs/') }).safeParse(value)
    return [name, reference.success ? schema.$defs?.[reference.data.$ref.slice('#/$defs/'.length)] : value]
  }))
  const row = z.record(z.string(), z.unknown()).parse(output)
  if (schema.required?.includes('boundaryCrops')) {
    const rect = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    const input = z.object({ images: z.array(z.object({ imageVersionId: z.string(), role: z.string().optional() })), usage: z.object({
      borderlineRegions: z.array(z.object({ entityId: z.string().optional(), name: z.string(), role: z.string(), edge: z.enum(['left', 'right', 'top', 'bottom']), outsideOnly: z.boolean().optional() })),
      imageRepresentations: z.array(z.object({ imageVersionId: z.string(), sourceRect: rect.optional() })),
    }) }).parse(request.input)
    const review = properties.review ? fixtureResponse({ input: request.input, outputSchema: { ...z.object({ properties: z.record(z.string(), z.unknown()), required: z.array(z.string()).optional() }).parse(properties.review), $defs: schema.$defs } }, output) : undefined
    const actual = z.object({ actualLayout: z.object({ regions: z.array(z.object({ entityId: z.string().optional(), name: z.string(), role: z.string(), rect })) }) }).parse(review ?? output).actualLayout.regions
    const crops = input.images.filter(image => image.role === 'actual-wallpaper-detail-only')
    return { ...(review === undefined ? {} : { review }), boundaryCrops: input.usage.borderlineRegions.map((target, index) => {
      const cropImageVersionId = crops[index]?.imageVersionId
      const source = input.usage.imageRepresentations.find(view => view.imageVersionId === cropImageVersionId)?.sourceRect
      const subject = actual.find(region => region.role === target.role && (target.entityId ? target.entityId === region.entityId : target.name === region.name))?.rect
      const base = { cropImageVersionId, edge: target.edge }
      if (!source || !subject) return { ...base, status: 'unknown' }
      const x = target.edge === 'left' ? subject.x : target.edge === 'right' ? subject.x + subject.width : subject.x + subject.width / 2
      const y = target.edge === 'top' ? subject.y : target.edge === 'bottom' ? subject.y + subject.height : subject.y + subject.height / 2
      if (target.outsideOnly && (target.edge === 'right' && x <= source.x || target.edge === 'left' && x >= source.x + source.width || target.edge === 'bottom' && y <= source.y || target.edge === 'top' && y >= source.y + source.height)) return { ...base, status: 'clear' }
      const point = { x: (x - source.x) / source.width, y: (y - source.y) / source.height }
      return [point.x, point.y].every(value => value >= 0 && value <= 1) ? { ...base, status: 'measured', point } : { ...base, status: 'unknown' }
    }) }
  }
  if (properties.editPrompt && properties.reason && properties.imageVersionId && !properties.objectRoles && !properties.regions) return z.object({ imageVersionId: z.string(), editPrompt: z.string(), reason: z.string() }).parse(row)
  if (schema.required?.includes('sourceMedium')) {
    const observed = z.object({ objectRoles: z.array(z.object({ entityId: z.string(), name: z.string(), role: z.string(), evidence: z.string() }).passthrough()) }).parse(row)
    return { ...row, sourceMedium: row.sourceMedium ?? 'photograph', ...(schema.required.includes('actionPartIds') ? { actionPartIds: row.actionPartIds ?? [] } : {}),
      ...(schema.required.includes('handAssessments') ? { handAssessments: row.handAssessments ?? observed.objectRoles.filter(object => object.role === 'primary').map(object => ({ entityId: object.entityId, kind: 'non-person' })) } : {}),
      ...(schema.required.includes('presentationAssessments') ? { presentationAssessments: row.presentationAssessments ?? observed.objectRoles.filter(object => object.role === 'primary').map(object => ({ entityId: object.entityId, kind: 'independent', evidence: object.evidence })) } : {}),
      objectRoles: observed.objectRoles.map(object => ({ ...object, sourceIntent: object.sourceIntent ?? { framing: 'whole', visibility: 'visible', preserve: [object.evidence], relationships: [] } })) }
  }
  if (JSON.stringify(schema).includes('"extrema"') && (row.protocol === 'practical-v1' || row.protocol === 'practical-v2')) {
    const layout = z.object({ regions: z.array(z.object({ name: z.string(), rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }) }).passthrough()) }).parse(row.actualLayout)
    row.actualLayout = { regions: layout.regions.map(region => ({ ...region, extrema: region.extrema ?? {
      left: { part: region.name, coordinate: region.rect.x }, right: { part: region.name, coordinate: region.rect.x + region.rect.width },
      top: { part: region.name, coordinate: region.rect.y }, bottom: { part: region.name, coordinate: region.rect.y + region.rect.height },
    } })) }
    if (row.protocol === 'practical-v2') return row
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
