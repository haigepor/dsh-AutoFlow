/** Query scheduling derives quality from saved reviews and selections, never source captions. */
import type { Assessment, RecordOf } from '../shared/model.ts'

/** @param queries Provider queries in preference order. @returns Distinct queries with the first spelling and normalized spacing. */
export function normalizeUnsplashQueries(queries: readonly string[]): string[] {
  const unique = new Map<string, string>()
  for (const query of queries) {
    const normalized = query.trim().replace(/\s+/g, ' '), key = normalized.toLocaleLowerCase('en')
    if (!unique.has(key)) unique.set(key, normalized)
  }
  return [...unique.values()]
}

/** One resumable query's current page and committed candidate positions. */
export interface SearchQueryPage {
  index: number
  ids: readonly string[]
  done: readonly string[]
  /** The legacy source-empty signal for Runs without measured page yield. */
  empty: boolean
  /** Yield after complete page consumption, counting only newly admitted source IDs. */
  sourceYield?: { examinedPages: number; eligibleCandidates: number; lastPageEligible: number }
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
    const sourceYield = page.sourceYield
    let processed = Number(sourceYield === undefined && page.empty), matched = 0, subjects = 0
    for (const id of new Set(page.ids)) {
      const imageId = input.imageId(id)
      if (!done.has(id) && (imageId === undefined || !reviewed.has(imageId))) continue
      processed++
      if (imageId !== undefined && selected.has(imageId)) matched++
      if (imageId !== undefined && relevant.has(imageId) && !irrelevant.has(imageId)) subjects++
    }
    const eligiblePerPage = sourceYield?.examinedPages ? sourceYield.eligibleCandidates / sourceYield.examinedPages : 0
    return { index: page.index, processed, matched, subjects, sourceYield, estimatedMatches: eligiblePerPage * (matched + 1) / (processed + 2),
      estimatedSubjects: eligiblePerPage * (subjects + 1) / (processed + 2), distance: (page.index - input.nextQuery + input.queryCount) % input.queryCount }
  })
  scores.sort((a, b) => {
    if (a.sourceYield && b.sourceYield) {
      return Number(b.sourceYield.examinedPages === 0) - Number(a.sourceYield.examinedPages === 0)
        || b.estimatedMatches - a.estimatedMatches || b.estimatedSubjects - a.estimatedSubjects
        || b.sourceYield.lastPageEligible - a.sourceYield.lastPageEligible || a.distance - b.distance
    }
    // A uniform success/failure prior makes unseen directions neutral instead of immediately exhausted.
    return (b.matched + 1) * (a.processed + 2) - (a.matched + 1) * (b.processed + 2)
      || (b.subjects + 1) * (a.processed + 2) - (a.subjects + 1) * (b.processed + 2)
      || a.distance - b.distance
  })
  return scores[0]?.index
}
