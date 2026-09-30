import { CATEGORY_PROFILES, candidateTitleKey, createCandidateManifest, createPhotoSearchSession } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { finalizeDecisionManifest, triageCandidates } from '../vendor/auto-afp-img/afp-visual-triage.mjs'
import { selectionDocIds } from '../vendor/auto-afp-img/afp-collection-run.mjs'

/** Supported curation categories; original policies stay in the upstream modules. */
export const categories = Object.freeze(CATEGORY_PROFILES.map(profile => profile.key))

/** @param {unknown} input Tool JSON. @returns {string[]} Unique supported categories. */
export function chooseCategories(input = categories) {
  if (!Array.isArray(input) || input.length < 1 || input.length > categories.length || input.some(key => !categories.includes(key))) throw new Error('Choose supported AFP categories')
  return [...new Set(input)]
}

/** Read collection contents before visual work; existing pictures are excluded globally. */
export async function reservedIds(client, signal) {
  const selections = await client.listSelections()
  if (!Array.isArray(selections)) throw new Error('Invalid AFP collection list')
  const ids = new Set()
  for (const selection of selections) {
    signal.throwIfAborted()
    if (typeof selection.id !== 'string' || !selection.id) throw new Error('AFP collection has no id')
    for (const value of selectionDocIds(await client.getSelection(selection.id))) ids.add(value)
  }
  return ids
}

/** Reconstruct the apply inputs exclusively from persisted pixel-review results. */
export function manifests(run, config) {
  const profiles = CATEGORY_PROFILES.filter(profile => run.categories.includes(profile.key))
  const candidateManifest = createCandidateManifest(profiles.map(profile => ({ profile, candidates: run.groups[profile.key]?.candidates ?? [] })))
  return { candidateManifest, decisionManifest: finalizeDecisionManifest(candidateManifest, run.decisions, {
    threshold: config.threshold, limitPerCategory: config.targetPerCategory,
  }) }
}

/** Model-visible summary excludes raw media references, document ids and provider errors. */
export function summary(run) {
  return { runId: run.id, status: run.status, categories: run.categories.map(category => ({
    category, selectionName: CATEGORY_PROFILES.find(profile => profile.key === category).selectionName,
    reviewed: run.decisions.filter(item => item.category === category).length,
    kept: run.decisions.filter(item => item.category === category && item.keep).length,
    target: run.settings.targetPerCategory, batches: run.groups[category]?.batches ?? 0,
    exhausted: run.groups[category]?.exhausted ?? false,
    requestFailures: run.decisions.filter(item => item.category === category && item.reason === 'preview or vision request failed').length,
  })), pendingBatch: run.pending !== null }
}

/**
 * Checkpoint cursor and pending candidates together before downloading previews. Cancellation leaves
 * that batch available for replay; only a fully settled review commits its decisions.
 */
export async function refreshRun({ run, store, config, client, previewClient, visionClient, signal,
  onProgress = () => {}, primitives = {}, reserved = new Set() }) {
  const profiles = CATEGORY_PROFILES.filter(profile => run.categories.includes(profile.key))
  const blocked = new Set([...reserved, ...run.decisions.map(item => item.id)])
  const titles = new Set(Object.values(run.groups).flatMap(group => group.candidates.map(candidateTitleKey)).filter(Boolean))
  const session = (primitives.session ?? createPhotoSearchSession)({ client, profiles, pageSize: config.pageSize,
    maxPages: config.maxPages, readRetries: 0, searchState: run.searchState })
  run.status = 'running'
  await store.saveRun(run)
  try {
    const ordered = run.pending ? [...profiles.filter(profile => profile.key === run.pending.category), ...profiles.filter(profile => profile.key !== run.pending.category)] : profiles
    for (const profile of ordered) {
      const group = run.groups[profile.key] ??= { candidates: [], batches: 0, exhausted: false }
      // maxBatches is a per-start budget; accumulated decisions survive a resume.
      let reviewedThisStart = 0
      while (run.decisions.filter(item => item.category === profile.key && item.keep).length < config.targetPerCategory && reviewedThisStart < config.maxBatches) {
        signal.throwIfAborted()
        if (!run.pending) {
          const batch = await session.nextBatch(profile.key, { batchSize: config.batchSize, excludedIds: blocked, excludedTitleKeys: titles })
          signal.throwIfAborted()
          run.searchState = session.exportState()
          run.pending = { category: profile.key, candidates: batch.candidates, exhausted: batch.exhausted === true }
          await store.saveRun(run)
        }
        if (run.pending.category !== profile.key) throw new Error('AFP pending batch does not match its category')
        const pending = run.pending
        if (pending.candidates.length === 0) {
          group.exhausted = pending.exhausted
          run.pending = null
          await store.saveRun(run)
          break
        }
        const candidateManifest = createCandidateManifest([{ profile, candidates: pending.candidates }])
        const decisions = await (primitives.triage ?? triageCandidates)({ candidateManifest, previewClient, visionClient,
          threshold: config.threshold, concurrency: config.concurrency })
        signal.throwIfAborted()
        let kept = run.decisions.filter(item => item.category === profile.key && item.keep).length
        for (const decision of decisions) {
          if (decision.keep && (blocked.has(decision.id) || kept >= config.targetPerCategory)) {
            decision.keep = false
            decision.reason = 'duplicate or category target reached'
          }
          if (decision.keep) kept++
          blocked.add(decision.id)
        }
        group.candidates.push(...pending.candidates)
        for (const candidate of pending.candidates) titles.add(candidateTitleKey(candidate))
        run.decisions.push(...decisions)
        group.batches++
        reviewedThisStart++
        group.exhausted = pending.exhausted
        run.pending = null
        await store.saveRun(run)
        onProgress({ category: profile.key, kept, target: config.targetPerCategory, batch: group.batches })
      }
    }
    run.status = run.categories.every(category => run.decisions.filter(item => item.category === category && item.keep).length >= config.targetPerCategory) ? 'ready' : 'paused'
    await store.saveRun(run)
    return run
  } catch (error) {
    run.status = signal.aborted ? 'cancelled' : 'failed'
    // Preserve the pending batch even when a provider throws or a job is killed.
    await store.saveRun(run)
    throw error
  }
}
