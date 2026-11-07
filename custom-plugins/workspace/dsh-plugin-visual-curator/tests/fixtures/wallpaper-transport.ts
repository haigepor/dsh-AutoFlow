/** Keyless full-sized wallpaper projections exercise the bounded-action regression. */
import { wallpaperExperienceSchema, wallpaperSettingsSchema, wallpaperViewSchema, wallpaperReviewKeys } from '../../src/shared/wallpaper.ts'

/** @returns A valid completed view with three retained layout/review rounds and preview resources. */
export function largeWallpaperView() {
  const attempts = Array.from({ length: 3 }, (_, index) => ({ revision: index + 1, needsOutpaint: true, checks: [], canvasId: `canvas-${index}`, analysisId: `analysis-${index}`, simulationId: `simulation-${index}`, outputId: `output-${index}`,
    plan: { version: 1, imageVersionId: 'source', mode: 'single', subject: 'A clearly visible subject in its environment.', evidence: 'Visible source composition and lighting. '.repeat(80), priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Subject protection', role: 'subject', rect: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 } }], placement: { scale: 0.8, left: 258, top: 1032 }, reason: 'Keep the source subject readable inside the fixed template. '.repeat(30) },
    review: { subject: 'The original subject is visible.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: 'satisfied', reason: `Observed ${key} evidence in the final pixels. `.repeat(20) }])), issues: [] },
  }))
  return wallpaperViewSchema.parse({ runId: 'wallpaper', sourceRunId: 'search', status: 'completed', settings: wallpaperSettingsSchema.parse({}), state: { version: 1, sourceRunId: 'search', skillVersion: 'saved-skill', budgetStopped: false, items: [{ imageVersionId: 'source', originalId: 'original', familyId: 'source-family', status: 'passed', edits: 2, attempts }] },
    resources: Object.fromEntries(['original', ...attempts.flatMap(attempt => [attempt.canvasId, attempt.analysisId, attempt.simulationId, attempt.outputId])].map(id => [id, `/api/visual-curator/resource?imageVersionId=${id}`])),
    previewResources: Object.fromEntries(attempts.map(attempt => [attempt.outputId, `/api/visual-curator/resource?imageVersionId=${attempt.outputId}&preview=thumbnail`])),
    sourceImages: { source: { width: 2000, height: 3000, previewPath: '/api/visual-curator/resource?imageVersionId=original&preview=thumbnail' } }, total: 1, offset: 0, counts: { passed: 1 }, warnings: [] })
}

/** @returns An accumulated experience catalog whose bounded individual revisions exceed the action limit together. */
export function largeWallpaperExperience() {
  return wallpaperExperienceSchema.parse({ version: 1, cases: [], active: 'skill-7', autoPromote: false, lastDistilledCount: 0, distilledFamilyIds: [], versions: Array.from({ length: 8 }, (_, index) => ({ id: `skill-${index}`, content: 'Inspect the actual source and final pixels. '.repeat(90), createdAt: '2026-11-06T00:00:00.000Z', status: index === 7 ? 'active' : 'retired', reason: 'Saved evidence-backed revision.', caseIds: [] })) })
}
