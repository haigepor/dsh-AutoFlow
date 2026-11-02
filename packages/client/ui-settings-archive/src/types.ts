/** Browser-safe values resolved from the archive plugin's Config schema. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Session bookmarks survive archiving and restoration. */
export interface ArchivePreferences {
  readonly favoriteSessionIds: readonly SessionId[]
}
