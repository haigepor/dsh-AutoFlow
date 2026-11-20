/** Independent source geometry for a layout confirmation that compares a complete output with its original. */
import { z } from 'zod'
import { normalizedRectSchema } from '../shared/model.ts'
import type { WallpaperPlan, WallpaperSettings, wallpaperSourceReviewV4Schema } from '../shared/wallpaper.ts'
import type { WallpaperSourceLayout } from '../shared/wallpaper-geometry.ts'

type SourceTarget = { entityId: string; name: string }
type Rect = z.infer<typeof normalizedRectSchema>
type ActualRegion = Pick<z.infer<typeof wallpaperSourceReviewV4Schema>['actualLayout']['regions'][number], 'entityId' | 'name' | 'role' | 'scope'>

/** @param plan Frozen source identities and framing. @param sourceLayout Positioned source expectations. @param layoutChecks Failed geometry checks from the final review. @param actualRegions Final-pixel regions bind reviewer labels to frozen entity IDs. @param allowMixedSubjectOverflow Whether the frozen prompt remeasures mixed ordinary overflow and source-relative failures together. @returns Complete, visible ordinary subjects and action parts implicated in a source-relative discrepancy. */
export function wallpaperSourceMeasurementTargets(plan: Pick<WallpaperPlan, 'objectRoles'>, sourceLayout: WallpaperSourceLayout | undefined, layoutChecks: readonly string[], actualRegions?: readonly ActualRegion[], allowMixedSubjectOverflow = false): SourceTarget[] {
  if (sourceLayout?.version !== 'source-intent-v2' || !sourceLayout.expectedSubjects) return []
  const pairChecks = ['subject-relative-scale:', 'subject-relative-position:']
  const relativeChecks = ['subject-too-small:', 'subject-center-drift:', 'subject-aspect-changed:', 'action-part-too-small:', ...pairChecks]
  const isRelative = (check: string) => relativeChecks.some(prefix => check.startsWith(prefix))
  const subjectOverflow = 'subject-overflow:'
  if (!layoutChecks.some(isRelative) || layoutChecks.some(check => !isRelative(check) && !(allowMixedSubjectOverflow && check.startsWith(subjectOverflow)))) return []
  const expected = new Set(sourceLayout.expectedSubjects.filter(subject => subject.wholeRect && !subject.focus).map(subject => subject.entityId))
  const actionParts = new Set(sourceLayout.expectedActionParts?.map(part => part.entityId))
  const eligible = (plan.objectRoles ?? []).flatMap(object =>
    object.sourceIntent?.framing === 'whole' && object.sourceIntent.visibility === 'visible' && !object.sourceIntent.layoutFocus &&
      (object.role === 'primary' && object.safetyClass === 'general' && expected.has(object.entityId) || object.role === 'critical-part' && actionParts.has(object.entityId))
      ? [{ entityId: object.entityId, name: object.name }] : [])
  const labels = actualRegions?.filter(region => region.scope === 'core').map(region => ({ ...region, isSubject: region.role === 'subject' }))
    ?? plan.objectRoles?.filter(object => object.role !== 'supporting').map(object => ({ ...object, isSubject: object.role === 'primary' })) ?? []
  const subjects = labels.filter(label => label.isSubject)
  const eligiblePrimaries = eligible.filter(subject => expected.has(subject.entityId))
  const eligibleIds = new Set(eligiblePrimaries.map(subject => subject.entityId))
  const attributed = new Set<string | undefined>()
  for (const check of layoutChecks) {
    if (check.startsWith('subject-center-drift:')) {
      if (eligiblePrimaries.length !== sourceLayout.expectedSubjects.length) continue
      for (const subject of eligiblePrimaries) attributed.add(subject.entityId)
      continue
    }
    const name = check.slice(check.indexOf(':') + 1)
    if (pairChecks.some(prefix => check.startsWith(prefix))) {
      const pairs = subjects.flatMap((left, index) => subjects.slice(index + 1).flatMap(right =>
        name === `${left.name} · ${right.name}` || name === `${right.name} · ${left.name}` ? [[left.entityId, right.entityId]] : []))
      const pair = pairs.length === 1 && pairs[0]?.every(id => id !== undefined && eligibleIds.has(id)) ? pairs[0] : undefined
      if (!pair) return []
      for (const id of pair) attributed.add(id)
      continue
    }
    const overflow = check.startsWith(subjectOverflow)
    const candidates = check.startsWith('action-part-too-small:') ? labels.filter(label => !label.isSubject)
      : overflow || check.startsWith('subject-too-small:') ? subjects : labels
    const matches = candidates.filter(region => region.name === name)
    if (overflow && (matches.length !== 1 || !matches[0]?.entityId || !eligibleIds.has(matches[0].entityId))) return []
    if (matches.length === 1) attributed.add(matches[0]?.entityId)
  }
  return eligible.filter(subject => attributed.has(subject.entityId))
}

/** @param sourceImageVersionId Unchanged original supplied for source measurement. @param targets Frozen identities selected for remeasurement. @returns Wire schema requiring one explicit source-only outcome per target. */
export function wallpaperSourceMeasurementSchema(sourceImageVersionId: string, targets: readonly SourceTarget[]) {
  const entityId = z.enum(targets.map(target => target.entityId)).describe(`Frozen original subjects: ${JSON.stringify(targets)}`)
  const fields = { entityId, reason: z.string().trim().min(1).max(1024) }
  return z.strictObject({ sourceImageVersionId: z.literal(sourceImageVersionId), measurements: z.array(z.discriminatedUnion('result', [
    z.strictObject({ ...fields, result: z.literal('measured'), rect: normalizedRectSchema.describe('Tight visible subject or action-part rectangle in the original image coordinates only.') }),
    z.strictObject({ ...fields, result: z.literal('unknown') }),
  ])).length(targets.length) }).superRefine(({ measurements }, ctx) => {
    if (new Set(measurements.map(row => row.entityId)).size !== measurements.length) ctx.addIssue({ code: 'custom', path: ['measurements'], message: 'Measure each selected original entity exactly once.' })
  })
}

function containsCenter(rect: Rect, other: Rect): boolean {
  const x = other.x + other.width / 2, y = other.y + other.height / 2
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

/** @param sourceLayout Frozen output expectations. @param evidence Validated original-image measurements. @param sourceGeometry Oriented original pixel dimensions. @param placement Existing source-to-canvas transform. @param settings Frozen output dimensions. @returns Corrected comparison boxes when every source measurement is usable, or the identical frozen layout when calibration remains unresolved. */
export function wallpaperMeasuredSourceLayout(sourceLayout: WallpaperSourceLayout | undefined, evidence: z.output<ReturnType<typeof wallpaperSourceMeasurementSchema>>, sourceGeometry: { width: number; height: number }, placement: WallpaperPlan['placement'], settings: Pick<WallpaperSettings, 'width' | 'height'>): WallpaperSourceLayout | undefined {
  if (!sourceLayout?.expectedSubjects || !evidence.measurements.length) return sourceLayout
  const width = Math.max(1, Math.round(sourceGeometry.width * placement.scale))
  const height = Math.max(1, Math.round(sourceGeometry.height * placement.scale))
  const corrected = new Map<string, Rect>()
  for (const row of evidence.measurements) {
    if (row.result !== 'measured') return sourceLayout
    const subject = sourceLayout.expectedSubjects.find(subject => subject.entityId === row.entityId)
    const part = sourceLayout.expectedActionParts?.find(part => part.entityId === row.entityId)
    const previous = subject?.focus ? undefined : subject?.wholeRect ?? part?.rect
    if (!previous) return sourceLayout
    const rect = {
      x: (placement.left + row.rect.x * width) / settings.width,
      y: (placement.top + row.rect.y * height) / settings.height,
      width: row.rect.width * width / settings.width,
      height: row.rect.height * height / settings.height,
    }
    // A source-only remeasurement must still identify the original entity at its planned location.
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 || rect.y + rect.height > 1 || !containsCenter(previous, rect) || !containsCenter(rect, previous)) return sourceLayout
    corrected.set(row.entityId, rect)
  }
  return {
    ...sourceLayout,
    expectedSubjects: sourceLayout.expectedSubjects.map(subject => {
      const rect = corrected.get(subject.entityId)
      return rect ? { ...subject, rect, wholeRect: rect } : subject
    }),
    ...(sourceLayout.expectedActionParts ? { expectedActionParts: sourceLayout.expectedActionParts.map(part => ({ ...part, rect: corrected.get(part.entityId) ?? part.rect })) } : {}),
  }
}
