/** Client composition of existing authenticated actions; no new persistence or model protocol. */
import type { ActionArgs, CuratorSnapshot, Dimension, ImageView, RuleView, StyleView } from './contract.ts'
import type { CuratorStore } from './store.ts'

export const dimensions: Dimension[] = ['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth']

/**
 * Archive only the confirmed revisions, stopping on failure and preserving earlier confirmed commits.
 * @param store Authenticated commands with normal pending, refresh and toast handling.
 * @param targets Fixed collection list shown in the confirmation dialog.
 * @param operationId Stable batch identity; each collection derives an idempotent operation ID.
 * @param onProgress Receives each confirmed count; omission emits no local progress callback.
 * @returns Completed count, or the failed collection and confirmed count so partial work stays visible.
 */
export async function archiveCollections(store: Pick<CuratorStore, 'execute'>, targets: readonly Pick<StyleView, 'styleId' | 'name' | 'revision'>[], operationId: string, onProgress: (removed: number) => void = () => {}): Promise<{ status: 'completed'; removed: number } | { status: 'failed'; removed: number; failedName: string; conflict: boolean }> {
  let removed = 0
  for (const target of targets) {
    try {
      const result = await store.execute('style-archive', { operationId: `${operationId}:${target.styleId}`, styleId: target.styleId, expectedRevision: target.revision })
      if (resultId(result) !== target.styleId || !result || typeof result !== 'object' || !('archived' in result) || result.archived !== true) throw new Error('unconfirmed-removal')
    }
    catch (error) { return { status: 'failed', removed, failedName: target.name, conflict: !!error && typeof error === 'object' && 'code' in error && error.code === 'revision-conflict' } }
    onProgress(++removed)
  }
  return { status: 'completed', removed }
}

/** Filter loaded references without changing the collection or analysis input.
 * @param images Loaded, authorized images. @param style Selected collection. @param query Filename query.
 * @param role Reference role, or all roles. @returns Matching references in their saved order.
 */
export function filterReferences(images: ImageView[], style: Pick<StyleView, 'styleId' | 'referenceIds'>, query: string, role: 'all' | 'positive' | 'negative' | 'undecided'): ImageView[] {
  const needle = query.trim().toLowerCase()
  return images.filter(image => image.styleId === style.styleId && image.referenceId && style.referenceIds.includes(image.referenceId)
    && (role === 'all' || (image.role ?? 'undecided') === role) && image.name.toLowerCase().includes(needle))
}

/** Read a returned record identity without trusting a wire cast.
 * @param value Host action result. @param key Identity field. @returns Nonempty identifier.
 */
export function resultId(value: unknown, key = 'id'): string {
  if (value && typeof value === 'object' && key in value) {
    const id = Reflect.get(value, key)
    if (typeof id === 'string' && id) return id
  }
  throw new Error('invalid-action-result')
}

/** Decode only suggestions for the current draft revision and resolve image evidence to references.
 * @param snapshot Current authorized projection. @param style Selected draft. @returns Unconfirmed, editable rules.
 */
export function suggestedRules(snapshot: CuratorSnapshot, style: StyleView): RuleView[] {
  return snapshot.suggestions.flatMap(suggestion => {
    if (suggestion.status !== 'pending') return []
    let value: unknown
    try { value = JSON.parse(suggestion.text) } catch (error) { return [] /* Freeform suggestions are not structured rules. */ }
    if (!value || typeof value !== 'object') return []
    const field = (name: string): unknown => Reflect.get(value, name)
    const dimension = field('dimension'), strength = field('strength'), stage = field('stage')
    const statement = field('statement'), condition = field('condition'), exceptions = field('exceptions')
    if (field('draftId') !== style.draftId || field('draftRevision') !== style.draftRevision
      || typeof dimension !== 'string' || !dimensions.includes(dimension as Dimension)
      || !['required', 'preferred', 'reference-only'].includes(String(strength)) || !['source', 'final'].includes(String(stage))
      || typeof statement !== 'string' || !statement.trim() || typeof condition !== 'string'
      || !Array.isArray(exceptions) || !exceptions.every((entry: unknown) => typeof entry === 'string')) return []
    const evidence = (name: string): string[] | undefined => {
      const ids = field(name)
      if (!Array.isArray(ids) || !ids.every((id: unknown) => typeof id === 'string')) return undefined
      const refs = ids.map(id => snapshot.images.find(image => image.imageVersionId === id && image.styleId === style.styleId && image.referenceId && style.referenceIds.includes(image.referenceId))?.referenceId
        ?? style.analysis?.samples.find(sample => sample.imageVersionId === id && style.referenceIds.includes(sample.referenceId))?.referenceId)
      return refs.every((id): id is string => !!id) ? refs : undefined
    }
    const supportRefs = evidence('supportImageVersionIds'), counterRefs = evidence('counterImageVersionIds')
    if (!supportRefs || !counterRefs) return []
    return [{ ruleId: suggestion.suggestionId, dimension: dimension as Dimension, statement,
      strength: strength as RuleView['strength'], stage: stage as RuleView['stage'], confirmed: false,
      condition, exceptions, supportRefs, counterRefs }]
  })
}

/** Publish only the explicitly selected draft, using each returned revision after a commit.
 * @param store Authenticated workspace commands. @param style Human-reviewed current draft. @returns Published release ID.
 */
export async function publishStyle(store: CuratorStore, style: StyleView): Promise<string> {
  const candidate = resultId(await store.execute('candidate-create', { operationId: crypto.randomUUID(), styleId: style.styleId, expectedRevision: style.revision }))
  const current = store.getSnapshot().snapshot?.styles.find(item => item.styleId === style.styleId)
  if (!current || current.draftRevision !== style.draftRevision) throw new Error('revision-conflict')
  return resultId(await store.execute('style-publish', { operationId: crypto.randomUUID(), styleId: style.styleId, expectedRevision: current.revision, candidateId: candidate }))
}

/** Export API observations only after explicit rule publication and family confirmation.
 * @param actions Authenticated commands. @param style Current collection with a complete profile.
 * @param splitId Existing compatible split, or empty to create one. @param groupingConfirmed Human grouping consent.
 * @returns Accepted background export Run identity.
 */
export async function exportStyleDataset(actions: Pick<CuratorStore, 'execute'>, style: StyleView, splitId: string, groupingConfirmed: boolean): Promise<string> {
  const analysis = style.analysis, release = style.releases.filter(item => item.draftRevision === style.draftRevision).at(-1)
  if (!analysis?.summary || analysis.status !== 'completed' || analysis.stale || !release || !style.rules.length || style.rules.some(rule => !rule.confirmed)) throw new Error('dataset-not-ready')
  if (!splitId) {
    if (!groupingConfirmed) throw new Error('grouping-required')
    splitId = resultId(await actions.execute('split-create', { operationId: crypto.randomUUID(), assignments: [...new Set(analysis.samples.map(sample => sample.familyId))].map(familyId => ({ familyId, split: 'learning', groupingConfirmed: true })) }))
  }
  return resultId(await actions.execute('export-start', { operationId: crypto.randomUUID(), kind: 'style', purpose: 'reference', releaseId: release.id, splitId, analysisRunId: analysis.runId, mode: 'references-only' }), 'runId')
}

/** Build the draft update while retaining evidence, feedback and unresolved conflicts.
 * @param style Saved style at the start of editing. @param rules Explicitly confirmed rules. @returns Existing draft-save arguments.
 */
export function draftArgs(style: StyleView, rules: RuleView[]): ActionArgs {
  return { operationId: crypto.randomUUID(), styleId: style.styleId, expectedRevision: style.revision,
    rules: rules.map(rule => ({ ...rule, confirmed: true })), referenceIds: style.referenceIds,
    feedbackIds: style.feedbackIds ?? [], conflicts: style.conflicts }
}

/** Keep source retrieval and frozen visual review explicit in a search request.
 * @param input Form values and committed identities. @returns Existing search-start arguments.
 */
export function searchArgs(input: { releaseId: string; usageRevisionId: string; sourceId: string; taskBrief: string; queries: string; targetCount: number }): ActionArgs {
  const queries = input.queries.split('\n').map(line => line.trim()).filter(Boolean)
  if (!queries.length || !input.taskBrief.trim() || !input.releaseId || !Number.isInteger(input.targetCount) || input.targetCount < 1) throw new Error('invalid-input')
  return { operationId: crypto.randomUUID(), ...input, queries }
}
