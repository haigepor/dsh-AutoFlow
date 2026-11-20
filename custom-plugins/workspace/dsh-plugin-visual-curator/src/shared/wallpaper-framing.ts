/** Source-only framing inspection retains the first observation and every preserved entity requirement. */
import { z } from 'zod'
import { wallpaperAdaptedSourceEdgeSchema, wallpaperRoleObservationOutputSchema, type WallpaperFramingObservation } from './wallpaper.ts'
import { wallpaperSourceFramingMaxDetails, type WallpaperPeripheralFrameAdaptation } from './wallpaper-source-intent.ts'

type Observation = WallpaperFramingObservation
type SourceObject = Observation['objectRoles'][number]
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1, 'Coordinates must remain inside the complete original.')
const finding = z.strictObject({ entityId: z.string(), rect, sourceEdges: z.array(z.enum(['left','top','right','bottom'])).max(4), layoutFocus: rect.optional(), evidenceImageVersionIds: z.array(z.string()).min(1).max(wallpaperSourceFramingMaxDetails), reason: z.string().trim().min(1).max(1000) })
const peripheralEdge = wallpaperAdaptedSourceEdgeSchema.omit({ entityId: true }).extend({ cropImageVersionId: z.string() })
const retainedEdge = z.strictObject({ edge: peripheralEdge.shape.edge, kind: z.enum(['keep-contact', 'uncertain']) })
const classifiedPeripheralEdge = peripheralEdge.extend({ kind: z.literal('peripheral') })
type EdgeAssessment = z.infer<typeof retainedEdge> | z.infer<typeof classifiedPeripheralEdge>
type Finding = z.infer<typeof finding> & { peripheralEdges?: z.infer<typeof peripheralEdge>[]; frameEdgeAssessments?: EdgeAssessment[] }
type FrameEdge = z.infer<typeof peripheralEdge>['edge']
type Rect = z.infer<typeof rect>
type Crop = { imageVersionId: string; sourceRect?: Rect | undefined }

/** Apply only inspected geometry while retaining original roles, media and preservation requirements.
 * @param observation Saved original facts.
 * @param findings Validated source-only findings for every protected entity.
 * @param peripheralFraming Frozen source-framing policy.
 * @param crops Native views actually included in the inspection.
 * @returns Corrected source observation; no target placement or editing authorization is added.
 */
export function applyWallpaperFramingInspection(observation: Observation, findings: readonly Finding[], peripheralFraming?: WallpaperPeripheralFrameAdaptation, crops: readonly Crop[] = []): Observation {
  const byId = new Map(findings.map(finding => [finding.entityId, finding]))
  const objectRoles = observation.objectRoles.map(object => {
    const correction = byId.get(object.entityId)
    if (!correction) return object
    const sourceIntent = object.sourceIntent
    if ((peripheralFraming === 'verified-v3' || peripheralFraming === 'verified-v4') && correction.layoutFocus && croppedWholeViewCanRefine(object, correction, crops, correction.layoutFocus)) {
      return { ...object, rect: correction.rect, sourceEdges: correction.sourceEdges, sourceIntent: { ...sourceIntent, framing: 'partial' as const, layoutFocus: correction.layoutFocus } }
    }
    return { ...object, rect: correction.rect, sourceEdges: correction.sourceEdges, sourceIntent: sourceIntent.framing === 'whole' || sourceIntent.framing === 'uncertain' ? sourceIntent : { ...sourceIntent, ...(correction.layoutFocus ? { layoutFocus: correction.layoutFocus } : {}) } }
  })
  return { ...observation, objectRoles, regions: objectRoles.filter(object => object.role !== 'supporting').map(object => ({ name: object.name, entityId: object.entityId, role: object.role === 'primary' ? 'subject' : 'critical', rect: object.rect, ...(object.safetyClass ? { safetyClass: object.safetyClass } : {}) })) }
}

/** Bind one source-only reread to saved entities and actual crop identities.
 * @param observation Original observation; roles, preservation and relationships cannot change.
 * @param detailIds Actual native crops admitted to this request.
 * @param peripheralFraming Frozen response protocol for inspecting outer nonessential contacts.
 * @param crops Native views and their complete-source coordinates, required to refine an initially whole view.
 * @returns Complete-source corrections citing native crops. The complete original is already bound to imageVersionId.
 */
export function wallpaperFramingInspectionSchema(observation: Observation, detailIds: readonly string[], peripheralFraming?: WallpaperPeripheralFrameAdaptation, crops: readonly Crop[] = []) {
  const objects = observation.objectRoles.filter(object => object.role !== 'supporting')
  // Keep the published crop-only response schema so interrupted inspections can match existing request receipts.
  const evidenceImageVersionIds = z.preprocess(value => Array.isArray(value) && value.length <= wallpaperSourceFramingMaxDetails + 1 ? value.filter(id => id !== observation.imageVersionId) : value,
    z.array(z.enum([...detailIds])).min(1).max(wallpaperSourceFramingMaxDetails))
  const matchingFinding = finding.extend({ entityId: z.enum(objects.map(object => object.entityId)), evidenceImageVersionIds })
  const edgeAssessments = z.array(peripheralEdge.extend({ cropImageVersionId: z.enum([...detailIds]) })).max(4)
  const classifiedEdges = z.array(z.discriminatedUnion('kind', [retainedEdge, classifiedPeripheralEdge.extend({ cropImageVersionId: z.enum([...detailIds]) })])).max(4)
  const byContact = peripheralFraming === 'verified-v4'
  const refineWhole = peripheralFraming === 'verified-v3' || byContact
  const findingSchema = byContact ? matchingFinding.extend({ frameEdgeAssessments: classifiedEdges }).superRefine((finding, ctx) => {
    const reported = new Set(finding.frameEdgeAssessments.map(assessment => assessment.edge))
    if (reported.size !== finding.frameEdgeAssessments.length || reported.size !== finding.sourceEdges.length || !finding.sourceEdges.every(edge => reported.has(edge))) {
      ctx.addIssue({ code: 'custom', path: ['frameEdgeAssessments'], message: 'Classify every true source-frame cut exactly once; omit any edge with no cut.' })
    }
    const object = objects.find(object => object.entityId === finding.entityId)
    const verified = new Set(verifiedPeripheralFindings(finding, finding.sourceEdges, crops, finding.layoutFocus).map(row => row.edge))
    for (const [index, assessment] of finding.frameEdgeAssessments.entries()) {
      if (assessment.kind !== 'peripheral') continue
      if (object?.role !== 'primary' || object.safetyClass !== 'general' || object.sourceIntent.visibility !== 'frame-cropped' || !verified.has(assessment.edge)) {
        ctx.addIssue({ code: 'custom', path: ['frameEdgeAssessments', index], message: 'Only a nonessential contact of an ordinary primary can be released, with a cited original crop that covers its true edge and the focus span parallel to that edge. Keep the contact or mark it uncertain if the evidence does not support peripheral.' })
      }
    }
  })
    : peripheralFraming ? matchingFinding.extend({ peripheralEdges: peripheralFraming === 'verified-v1' ? edgeAssessments.optional() : edgeAssessments })
    : matchingFinding
  return z.strictObject({
    version: z.literal('wallpaper-source-framing-v1'), imageVersionId: z.literal(observation.imageVersionId), result: z.enum(['confirmed', 'corrected', 'uncertain']), reason: z.string().trim().min(1).max(1000),
    findings: z.array(findingSchema).length(objects.length),
  }).superRefine((value, ctx) => {
    if (new Set(value.findings.map(finding => finding.entityId)).size !== objects.length) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Inspect every original protected entity exactly once.' })
    const corrected = applyWallpaperFramingInspection(observation, value.findings, peripheralFraming, crops)
    for (const [index, finding] of value.findings.entries()) {
      const object = objects.find(object => object.entityId === finding.entityId)
      const focus = finding.layoutFocus
      const isRefined = object?.sourceIntent.framing === 'whole' && corrected.objectRoles.find(row => row.entityId === finding.entityId)?.sourceIntent.framing === 'partial'
      if (refineWhole && value.result !== 'uncertain' && object && !isRefined && croppedWholeViewCanRefine(object, finding, crops)) {
        ctx.addIssue({ code: 'custom', path: ['findings',index,'layoutFocus'], message: 'Measure the separate visible core inside the complete entity, between its locally verified cropped outer edges.' })
      } else if (focus && !isRefined && (object?.sourceIntent.framing === 'whole' || object?.sourceIntent.framing === 'uncertain') && (focus.x !== finding.rect.x || focus.y !== finding.rect.y || focus.width !== finding.rect.width || focus.height !== finding.rect.height)) ctx.addIssue({ code: 'custom', path: ['findings',index,'layoutFocus'], message: refineWhole ? 'A separate focus requires a partial or close-up view, or native evidence for every cropped peripheral edge of the whole view.' : 'Only an existing partial or close-up view can have a separate layout focus.' })
      if (!finding.layoutFocus && (object?.sourceIntent.framing === 'partial' || object?.sourceIntent.framing === 'close-up') && object.role === 'primary' && object.safetyClass !== 'automobile') ctx.addIssue({ code: 'custom', path: ['findings',index,'layoutFocus'], message: 'Reread the complete meaningful focus of this partial subject.' })
    }
    const checked = wallpaperRoleObservationOutputSchema(undefined, false, true, true, observation.sourceMedium, false, false, peripheralFraming === 'verified-v2' || refineWhole).safeParse(corrected)
    if (!checked.success) for (const issue of checked.error.issues) ctx.addIssue({ code: 'custom', path: ['findings'], message: issue.message })
  })
}

function frameGap(box: Rect, edge: FrameEdge) {
  return { left: box.x, top: box.y, right: 1 - box.x - box.width, bottom: 1 - box.y - box.height }[edge]
}

function containsFrameEdge(box: Rect, edge: FrameEdge): boolean {
  return Math.abs(frameGap(box, edge)) <= 8 * Number.EPSILON
}

function verifiedPeripheralFindings(finding: Finding, sourceEdges: readonly FrameEdge[], crops: readonly Crop[], focus?: Rect) {
  const peripheral = finding.frameEdgeAssessments ? finding.frameEdgeAssessments.filter(assessment => assessment.kind === 'peripheral') : finding.peripheralEdges ?? []
  return peripheral.filter(({ edge, cropImageVersionId }) => {
    if (!sourceEdges.includes(edge) || !finding.evidenceImageVersionIds.includes(cropImageVersionId)) return false
    const crop = crops.find(view => view.imageVersionId === cropImageVersionId)?.sourceRect
    if (!crop || !containsFrameEdge(crop, edge)) return false
    if (!focus) return true
    if (frameGap(focus, edge) <= 0) return false
    return edge === 'left' || edge === 'right'
      ? crop.y <= focus.y && crop.y + crop.height >= focus.y + focus.height
      : crop.x <= focus.x && crop.x + crop.width >= focus.x + focus.width
  })
}

function croppedWholeViewCanRefine(object: SourceObject, finding: Finding, crops: readonly Crop[], focus?: Rect) {
  if (object.role !== 'primary' || object.safetyClass !== 'general' || object.sourceIntent.framing !== 'whole' || object.sourceIntent.visibility !== 'frame-cropped' || !finding.sourceEdges.length) return false
  const verified = new Set(verifiedPeripheralFindings(finding, finding.sourceEdges, crops, focus).map(({ edge }) => edge))
  return finding.sourceEdges.every(edge => containsFrameEdge(finding.rect, edge) && verified.has(edge))
}

/** @param crops Actual native views of the original source. @returns Source coordinates and original frame edges contained by each view. */
export function wallpaperFramingCropCoverage(crops: readonly Crop[]) {
  return crops.flatMap(({ imageVersionId, sourceRect }) => sourceRect ? [{
    imageVersionId, sourceRect, frameEdges: (['left', 'top', 'right', 'bottom'] as const).filter(edge => containsFrameEdge(sourceRect, edge)),
  }] : [])
}

/** Identify outer framing contacts that have local pixel evidence and leave the meaningful core untouched.
 * @param observation Source geometry after the inspection reread.
 * @param findings Committed source-only findings.
 * @param crops Native details and their complete-source rectangles from the admitted request.
 * @returns Only cited peripheral contacts a layout can release without changing core preservation or adding anatomy.
 */
export function wallpaperVerifiedPeripheralEdges(observation: Observation, findings: readonly Finding[], crops: readonly Crop[]) {
  return observation.objectRoles.flatMap(object => {
    const focus = object.sourceIntent.layoutFocus
    if (object.role !== 'primary' || object.safetyClass !== 'general' || object.sourceIntent.visibility !== 'frame-cropped' || !focus) return []
    const finding = findings.find(row => row.entityId === object.entityId)
    return finding ? verifiedPeripheralFindings(finding, object.sourceEdges, crops, focus).map(({ edge, detail }) => ({ entityId: object.entityId, edge, detail })) : []
  })
}

/** @param observation Fresh or saved source observation. @param source Full original dimensions. @param marginPixels Maximum unreported gap worth a source detail check. @returns Unreported edges near an already frame-cropped close-up. */
export function wallpaperUnverifiedFramingEdges(observation: Observation, source: { width: number; height: number }, marginPixels: number) {
  return observation.objectRoles.flatMap(object => {
    if (object.role !== 'primary' || object.sourceIntent.framing !== 'close-up' || object.sourceIntent.visibility !== 'frame-cropped') return []
    const { x, y, width, height } = object.rect
    const gaps = { left: x * source.width, right: (1 - x - width) * source.width, top: y * source.height, bottom: (1 - y - height) * source.height }
    return (['left', 'right', 'top', 'bottom'] as const).filter(edge => !object.sourceEdges.includes(edge) && gaps[edge] <= marginPixels)
      .map(edge => ({ entityId: object.entityId, edge, rect: object.rect }))
  })
}

/** Inspect half of each cropped entity adjoining its original frame, keeping the whole image as context.
 * @param observation Saved source entities and meaningful focus boxes. @param suspectEdges Additional nearby edges requiring verification first.
 * @returns Bounded local crops in complete-original coordinates, without fabricated pixels.
 */
export function wallpaperFramingDetailRects(observation: Observation, suspectEdges: ReturnType<typeof wallpaperUnverifiedFramingEdges> = []) {
  const objects = observation.objectRoles.filter(object => object.role !== 'supporting')
  const cuts = [...suspectEdges, ...objects.flatMap(object => object.sourceEdges.map(edge => ({ entityId: object.entityId, edge, rect: object.rect })))]
  const edges = cuts.map(({ rect: box, edge }) => {
    if (edge === 'left') return { ...box, x: 0, width: box.x + box.width / 2 }
    if (edge === 'right') { const x = box.x + box.width / 2; return { ...box, x, width: 1 - x } }
    if (edge === 'top') return { ...box, y: 0, height: box.y + box.height / 2 }
    const y = box.y + box.height / 2; return { ...box, y, height: 1 - y }
  })
  return [...edges, ...objects.map(object => object.sourceIntent?.layoutFocus ?? object.rect)].filter(box => box.width < 1 || box.height < 1)
}
