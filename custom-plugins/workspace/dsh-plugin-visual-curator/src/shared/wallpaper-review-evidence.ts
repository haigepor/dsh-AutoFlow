/** Bind blocking review findings to frozen entities and visible content defects. */
import type { z } from 'zod'
import type { WallpaperObjectRole, wallpaperSourceReviewV4Schema } from './wallpaper.ts'

/** Validate model evidence before it can become a quality verdict or authorize another generation.
 * @param review Parsed full-frame model response.
 * @param objects Frozen source identities and roles.
 * @param finalId Complete actual output identity.
 * @returns Unsupported conclusions with their field paths; callers either reject the response or hold saved-image rework.
 */
export function wallpaperReviewEvidenceIssues(review: z.infer<typeof wallpaperSourceReviewV4Schema>, objects: readonly WallpaperObjectRole[], finalId: string): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = []
  const expected = new Map(objects.map(object => [object.entityId, object]))
  const permits = {
    subject: ['frame-truncation', 'missing-structure', 'distorted-structure', 'identity-change'],
    protection: ['safe-area-overflow'], composition: ['relative-layout', 'distorted-structure'],
    sourceCorrespondence: ['frame-truncation', 'missing-structure', 'distorted-structure', 'relative-layout', 'identity-change', 'detail-loss', 'style-change'],
    sourceRepair: ['frame-truncation', 'missing-structure', 'distorted-structure', 'identity-change', 'detail-loss', 'background-artifact'],
    background: ['background-artifact'], style: ['style-change'], clarity: ['detail-loss'], clock: ['background-artifact'], readability: ['background-artifact'],
  }
  for (const [index, issue] of review.issues.entries()) {
    if (!issue.evidence) continue
    const fact = issue.evidence
    if ((fact.kind === 'safe-area-overflow') !== (issue.kind === 'layout')) issues.push({ path: ['issues', index, 'kind'], message: 'Only safe-area overflow is a layout-only issue; content defects must retain their independent content category.' })
    if (fact.kind === 'frame-truncation' && fact.outputRect.x > 0 && fact.outputRect.y > 0 && fact.outputRect.x + fact.outputRect.width < 1 && fact.outputRect.y + fact.outputRect.height < 1) issues.push({ path: ['issues', index, 'evidence', 'outputRect'], message: 'A frame-truncated object must meet the actual image frame, not only an inner safety guide.' })
    if (fact.imageVersionId !== finalId || !permits[issue.check].includes(fact.kind)) issues.push({ path: ['issues', index, 'evidence'], message: 'Defect evidence must use the complete output identity and a cause allowed for this check. Safety overflow only belongs to protection.' })
    if (new Set(fact.entityIds).size !== fact.entityIds.length || fact.entityIds.some(entityId => !expected.has(entityId))) issues.push({ path: ['issues', index, 'evidence', 'entityIds'], message: 'Defect evidence must identify distinct frozen source entities.' })
    if (['subject', 'protection'].includes(issue.check) && (!fact.entityIds.length || fact.entityIds.some(entityId => expected.get(entityId)?.role === 'supporting'))) issues.push({ path: ['issues', index, 'evidence', 'entityIds'], message: 'Subject integrity and safety failures require frozen primary or critical entities; companion safety overflow is nonblocking.' })
    if (!fact.entityIds.length && !['background', 'style', 'clarity', 'clock', 'readability'].includes(issue.check)) issues.push({ path: ['issues', index, 'evidence', 'entityIds'], message: 'Object, layout and fidelity defects require affected frozen entity identities.' })
    if (['sourceRepair', 'sourceCorrespondence'].includes(issue.check) && !fact.sourceRect) issues.push({ path: ['issues', index, 'evidence', 'sourceRect'], message: 'Fidelity and repair defects require corresponding original and output regions.' })
  }
  for (const key of ['subject', 'protection', 'clock', 'readability', 'composition', 'background', 'style', 'clarity', 'sourceRepair', 'sourceCorrespondence'] as const) {
    const check = key === 'sourceRepair' || key === 'sourceCorrespondence' ? review[key] : review.checks[key]
    if (check.result === 'violated' && !review.issues.some(issue => issue.check === key && issue.evidence)) issues.push({ path: key === 'sourceRepair' || key === 'sourceCorrespondence' ? [key] : ['checks', key], message: 'A blocking check requires an issue with entity-grounded defect evidence; otherwise report unknown.' })
  }
  if (review.subjectIntegrity.task.result === 'violated' && !review.issues.some(issue => issue.check === 'subject' && issue.evidence)) issues.push({ path: ['subjectIntegrity', 'task'], message: 'Task integrity failure requires visible subject content damage or identity change, not safe-area position.' })
  if (review.subjectIntegrity.output.extent === 'cut-off' && !review.issues.some(issue => issue.check === 'subject' && issue.evidence?.kind === 'frame-truncation')) issues.push({ path: ['subjectIntegrity', 'output'], message: 'Cut-off means a protected subject is cut by the actual image frame; inner safety overflow is not truncation.' })
  return issues
}
