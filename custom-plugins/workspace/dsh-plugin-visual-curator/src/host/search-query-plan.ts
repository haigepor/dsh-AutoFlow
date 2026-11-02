/** Query scheduling derives quality from saved reviews and selections, never source captions. */
import type { Assessment, RecordOf } from '../shared/model.ts'

/** One resumable query's current page and committed candidate positions. */
export interface SearchQueryPage {
  index: number
  ids: readonly string[]
  done: readonly string[]
  /** A fetched page contained no previously unseen source identities. */
  empty: boolean
}

/**
 * Prefer proven matches while allowing unexplored directions to outrank low-yield pages.
 * @param input Available query pages, saved review evidence, and the next position for equal scores.
 * @returns The selected query index, or undefined when no query can make progress.
 */
export function chooseSearchQuery(input: {
  pages: readonly SearchQueryPage[]; nextQuery: number; queryCount: number
  imageId(providerAssetId: string): string | undefined
  assessments: readonly Assessment[]; selections: readonly RecordOf<'selection'>[]
}): number | undefined {
  const reviewed = new Set<string>(), relevant = new Set<string>(), irrelevant = new Set<string>()
  for (const assessment of input.assessments) {
    reviewed.add(assessment.imageVersionId)
    const data = assessment.data
    if (assessment.technicalStatus !== 'completed' || data === null || typeof data !== 'object' || Array.isArray(data)) continue
    if (data.subjectFocusVerdict !== undefined) {
      if (data.subjectFocusVerdict === 'matched' && data.taskRelevance === 'relevant') relevant.add(assessment.imageVersionId)
      else irrelevant.add(assessment.imageVersionId)
    } else {
      if (data.taskRelevance === 'relevant') relevant.add(assessment.imageVersionId)
      if (data.taskRelevance === 'irrelevant') irrelevant.add(assessment.imageVersionId)
    }
  }
  const selected = new Set(input.selections.filter(selection => selection.qualification === 'auto-qualified').map(selection => selection.imageVersionId))
  const scores = input.pages.map(page => {
    const done = new Set(page.done)
    let processed = page.empty ? 1 : 0, matched = 0, subjects = 0
    for (const id of new Set(page.ids)) {
      const imageId = input.imageId(id)
      if (!done.has(id) && (imageId === undefined || !reviewed.has(imageId))) continue
      processed++
      if (imageId !== undefined && selected.has(imageId)) matched++
      if (imageId !== undefined && relevant.has(imageId) && !irrelevant.has(imageId)) subjects++
    }
    // A uniform success/failure prior makes unseen directions neutral instead of immediately exhausted.
    return { index: page.index, processed, matched, subjects, distance: (page.index - input.nextQuery + input.queryCount) % input.queryCount }
  })
  scores.sort((a, b) => (b.matched + 1) * (a.processed + 2) - (a.matched + 1) * (b.processed + 2)
    || (b.subjects + 1) * (a.processed + 2) - (a.subjects + 1) * (b.processed + 2)
    || a.distance - b.distance)
  return scores[0]?.index
}
