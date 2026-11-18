/** Source-only framing inspection retains the first observation and every preserved entity requirement. */
import { z } from 'zod'
import { wallpaperRoleObservationOutputSchema, type WallpaperFramingObservation } from './wallpaper.ts'
import { wallpaperSourceFramingMaxDetails } from './wallpaper-source-intent.ts'

type Observation = WallpaperFramingObservation
const rect = z.strictObject({ x: z.number().finite().min(0).max(1), y: z.number().finite().min(0).max(1), width: z.number().finite().positive().max(1), height: z.number().finite().positive().max(1) }).refine(value => value.x + value.width <= 1 && value.y + value.height <= 1, 'Coordinates must remain inside the complete original.')
const finding = z.strictObject({ entityId: z.string(), rect, sourceEdges: z.array(z.enum(['left','top','right','bottom'])).max(4), layoutFocus: rect.optional(), evidenceImageVersionIds: z.array(z.string()).min(1).max(wallpaperSourceFramingMaxDetails), reason: z.string().trim().min(1).max(1000) })

/** Apply only inspected geometry while retaining original roles, media and preservation requirements.
 * @param observation Saved original facts.
 * @param findings Validated source-only findings for every protected entity.
 * @returns Corrected source observation; no target placement or editing authorization is added.
 */
export function applyWallpaperFramingInspection(observation: Observation, findings: readonly z.infer<typeof finding>[]): Observation {
  const byId = new Map(findings.map(finding => [finding.entityId, finding]))
  const objectRoles = observation.objectRoles.map(object => {
    const correction = byId.get(object.entityId)
    if (!correction) return object
    const sourceIntent = object.sourceIntent
    return { ...object, rect: correction.rect, sourceEdges: correction.sourceEdges, sourceIntent: sourceIntent.framing === 'whole' || sourceIntent.framing === 'uncertain' ? sourceIntent : { ...sourceIntent, ...(correction.layoutFocus ? { layoutFocus: correction.layoutFocus } : {}) } }
  })
  return { ...observation, objectRoles, regions: objectRoles.filter(object => object.role !== 'supporting').map(object => ({ name: object.name, entityId: object.entityId, role: object.role === 'primary' ? 'subject' : 'critical', rect: object.rect, ...(object.safetyClass ? { safetyClass: object.safetyClass } : {}) })) }
}

/** Bind one source-only reread to saved entities and actual crop identities.
 * @param observation Original observation; roles, preservation and relationships cannot change.
 * @param detailIds Actual native crops admitted to this request.
 * @returns Complete-source corrections citing native crops. The complete original is already bound to imageVersionId.
 */
export function wallpaperFramingInspectionSchema(observation: Observation, detailIds: readonly string[]) {
  const objects = observation.objectRoles.filter(object => object.role !== 'supporting')
  // Keep the published crop-only response schema so interrupted inspections can match existing request receipts.
  const evidenceImageVersionIds = z.preprocess(value => Array.isArray(value) && value.length <= wallpaperSourceFramingMaxDetails + 1 ? value.filter(id => id !== observation.imageVersionId) : value,
    z.array(z.enum([...detailIds])).min(1).max(wallpaperSourceFramingMaxDetails))
  return z.strictObject({
    version: z.literal('wallpaper-source-framing-v1'), imageVersionId: z.literal(observation.imageVersionId), result: z.enum(['confirmed', 'corrected', 'uncertain']), reason: z.string().trim().min(1).max(1000),
    findings: z.array(finding.extend({ entityId: z.enum(objects.map(object => object.entityId)), evidenceImageVersionIds })).length(objects.length),
  }).superRefine((value, ctx) => {
    if (new Set(value.findings.map(finding => finding.entityId)).size !== objects.length) ctx.addIssue({ code: 'custom', path: ['findings'], message: 'Inspect every original protected entity exactly once.' })
    for (const [index, finding] of value.findings.entries()) {
      const object = objects.find(object => object.entityId === finding.entityId)
      const focus = finding.layoutFocus
      if (focus && (object?.sourceIntent.framing === 'whole' || object?.sourceIntent.framing === 'uncertain') && (focus.x !== finding.rect.x || focus.y !== finding.rect.y || focus.width !== finding.rect.width || focus.height !== finding.rect.height)) ctx.addIssue({ code: 'custom', path: ['findings',index,'layoutFocus'], message: 'Only an existing partial or close-up view can have a separate layout focus.' })
      if (!finding.layoutFocus && (object?.sourceIntent.framing === 'partial' || object?.sourceIntent.framing === 'close-up') && object.role === 'primary' && object.safetyClass !== 'automobile') ctx.addIssue({ code: 'custom', path: ['findings',index,'layoutFocus'], message: 'Reread the complete meaningful focus of this partial subject.' })
    }
    const checked = wallpaperRoleObservationOutputSchema(undefined, false, true, true, observation.sourceMedium).safeParse(applyWallpaperFramingInspection(observation, value.findings))
    if (!checked.success) for (const issue of checked.error.issues) ctx.addIssue({ code: 'custom', path: ['findings'], message: issue.message })
  })
}

/** Inspect half of each cropped entity adjoining its original frame, keeping the whole image as context.
 * @param observation Saved source entities and meaningful focus boxes.
 * @returns Bounded local crops in complete-original coordinates, without fabricated pixels.
 */
export function wallpaperFramingDetailRects(observation: Observation) {
  const objects = observation.objectRoles.filter(object => object.role !== 'supporting')
  const edges = objects.flatMap(object => object.sourceEdges.map(edge => {
    const box = object.rect
    if (edge === 'left') return { ...box, x: 0, width: box.x + box.width / 2 }
    if (edge === 'right') { const x = box.x + box.width / 2; return { ...box, x, width: 1 - x } }
    if (edge === 'top') return { ...box, y: 0, height: box.y + box.height / 2 }
    const y = box.y + box.height / 2; return { ...box, y, height: 1 - y }
  }))
  return [...edges, ...objects.map(object => object.sourceIntent?.layoutFocus ?? object.rect)].filter(box => box.width < 1 || box.height < 1)
}
