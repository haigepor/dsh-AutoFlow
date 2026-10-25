/** Shared reference identity for analysis freshness and immutable dataset exports. */
import type { Reference } from '../shared/model.ts'
import { contentDigest } from './repository.ts'

/** Rule edits do not invalidate pixels; changed examples or human judgments do.
 * @param references Frozen examples including import intent. @param feedbackIds Effective human judgments.
 * @returns Stable reference identity independent of iteration order.
 */
export function analysisReferenceDigest(references: readonly Reference[], feedbackIds: readonly string[]): string {
  return contentDigest({ references: [...references].sort((a, b) => a.id.localeCompare(b.id, 'en')), feedbackIds: [...feedbackIds].sort() })
}
