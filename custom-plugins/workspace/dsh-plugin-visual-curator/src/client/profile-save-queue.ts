/** Pending rule edits keep the last requested value while immutable profile saves run serially. */

/** One human-selected rule value; omitted statements keep the saved text. */
export interface ProfileRuleChange { ruleId: string; enabled: boolean; statement?: string }
/** The current collection and analysis determine which immutable profile may receive edits. */
export interface ProfileSaveContext { styleId: string; analysisRunId: string; profileId: string }
/** An unchanged operation identity safely reconciles an acknowledgement lost in transit. */
export interface ProfileSaveInput { operationId: string; styleId: string; analysisRunId: string; expectedProfileId: string; changes: ProfileRuleChange[] }
/** Optimistic changes remain visible until their exact version is acknowledged. */
export interface ProfileSaveState { profileId: string; changes: ProfileRuleChange[]; saving: boolean; failed: boolean; error: unknown }

/**
 * Serialize profile revisions, coalesce edits made during a save, and retain failed envelopes for explicit retry.
 * @param dependencies Immutable save action, operation identity source and view-state receiver.
 * @returns A collection-scoped queue; disposal discards unsent edits and ignores late acknowledgements.
 */
export function createProfileSaveQueue(dependencies: { save(input: ProfileSaveInput): Promise<{ id: string }>; operationId?(): string; changed(state: ProfileSaveState): void }) {
  let context: ProfileSaveContext | undefined, generation = 0, sequence = 0, disposed = false
  let work: Promise<boolean> | undefined, failed = false, error: unknown
  const changes = new Map<string, { change: ProfileRuleChange; version: number }>()
  let batch: { input: ProfileSaveInput; versions: Map<string, number> } | undefined
  let state: ProfileSaveState = { profileId: '', changes: [], saving: false, failed: false, error: undefined }
  const publish = (saving: boolean) => {
    if (disposed) return
    state = { profileId: context?.profileId ?? '', changes: [...changes.values()].map(value => value.change), saving, failed, error }
    dependencies.changed(state)
  }
  const current = (captured: number) => !disposed && generation === captured

  function flush(): Promise<boolean> {
    if (work) return work
    if (!context || disposed) return Promise.resolve(false)
    if (!batch && !changes.size) return Promise.resolve(true)
    const captured = generation
    const pending = Promise.resolve().then(async () => {
      if (!current(captured)) return false
      failed = false; error = undefined; publish(true)
      while (current(captured) && (batch || changes.size)) {
        if (!batch) {
          const rows = [...changes.values()]
          batch = { input: { operationId: dependencies.operationId?.() ?? crypto.randomUUID(), styleId: context!.styleId, analysisRunId: context!.analysisRunId, expectedProfileId: context!.profileId, changes: rows.map(row => row.change) }, versions: new Map(rows.map(row => [row.change.ruleId, row.version])) }
        }
        const accepted = batch
        try {
          const receipt = await dependencies.save(accepted.input)
          if (!current(captured)) return false
          context = { ...context!, profileId: receipt.id }
          for (const [id, version] of accepted.versions) if (changes.get(id)?.version === version) changes.delete(id)
          batch = undefined
          publish(true)
        } catch (failure) {
          if (current(captured)) { failed = true; error = failure; publish(false) }
          return false
        }
      }
      if (!current(captured)) return false
      publish(false)
      return true
    })
    work = pending
    void pending.then(() => { if (work === pending) work = undefined })
    return pending
  }

  return {
    getSnapshot: () => state,
    sync(value: ProfileSaveContext) {
      if (!context || context.styleId !== value.styleId || context.analysisRunId !== value.analysisRunId) {
        ++generation; context = value; work = undefined; batch = undefined; changes.clear(); failed = false; error = undefined; publish(false)
      } else if (failed && error && typeof error === 'object' && 'code' in error && error.code === 'revision-conflict' && context.profileId !== value.profileId) {
        // A revision rejection did not commit; refreshed identity can receive the retained edits on explicit retry.
        context = value; batch = undefined; publish(false)
      } else if (!work && !changes.size && context.profileId !== value.profileId) { context = value; publish(false) }
    },
    change(change: ProfileRuleChange) {
      if (!context || disposed) return
      const previous = changes.get(change.ruleId)?.change
      changes.set(change.ruleId, { change: { ...previous, ...change }, version: ++sequence })
      publish(!!work)
      if (!failed) void flush()
    },
    flush,
    dispose() { disposed = true; ++generation; changes.clear(); batch = undefined; work = undefined },
  }
}
