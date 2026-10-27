import { CATEGORY_PROFILES, candidateTitleKey, createCandidateManifest, createPhotoSearchSession } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { finalizeDecisionManifest, triageCandidates } from '../vendor/auto-afp-img/afp-visual-triage.mjs'
import { selectionDocIds } from '../vendor/auto-afp-img/afp-collection-run.mjs'
import { boundedWork } from '../vendor/auto-afp-img/bounded-work.mjs'
import { savedReadFailure } from '../vendor/auto-afp-img/read-failure.mjs'
import { resolveConfig } from '../../config-schema.js'

/** Supported curation categories; original policies stay in the upstream modules. */
export const categories = Object.freeze(CATEGORY_PROFILES.map(profile => profile.key))

/** @param {unknown} input Tool JSON. @returns {string[]} Unique supported categories. */
export function chooseCategories(input = categories) {
  if (!Array.isArray(input) || input.length < 1 || input.length > categories.length || input.some(key => !categories.includes(key))) throw new Error('Choose supported AFP categories')
  return [...new Set(input)]
}

/** Read every named collection before visual work, revalidating the directory on every call.
 * @param {object} client Authenticated collection reader.
 * @param {AbortSignal} signal Preparation lifetime.
 * @param {object} [options] Concurrency, run checkpoint, TTL and callbacks. Optional cachedCollections
 * supplies a completed same-account scan; absent means only this run's checkpoint can be reused.
 * Cross-task reuse requires an unchanged valid content timestamp and a matching member count.
 * Optional invalidatedAt excludes checkpoints read at or before a local membership write.
 * @returns {Promise<Set<string>>} Global membership; failures retain checkpoints and stop visual work.
 */
export async function reservedIds(client, signal, { concurrency = resolveConfig().collectionConcurrency, checkpoint = {}, ttlMs = 0,
  cachedCollections, invalidatedAt = null, onCheckpoint = async () => {}, onProgress = () => {}, measure = (_stage, operation) => operation() } = {}) {
  const selections = await measure('collection-list', () => client.listSelections())
  if (!Array.isArray(selections)) throw new Error('Invalid AFP collection list')
  const named = selections.filter(selection => String(selection.name ?? '').trim())
  if (named.some(selection => typeof selection.id !== 'string' || !selection.id)) throw new Error('AFP collection has no id')
  const previous = checkpoint.collections ?? {}
  checkpoint.collections = Object.create(null)
  const ids = new Set()
  let completed = 0, writes = Promise.resolve(), reused = false
  onProgress({ stage: 'collections', completed, total: named.length, reservedCount: 0 })
  await boundedWork(named, concurrency, async selection => {
    signal.throwIfAborted()
    const count = selection.docsCount ?? selection.count ?? null
    const fingerprint = JSON.stringify([selection.id, selection.name, count, selection.lastContentUpdate ?? null,
      selection.updatedAt ?? selection.modifiedAt ?? null, selection.isPrivate ?? null, selection.type ?? null])
    const fresh = saved => ttlMs > 0 && saved?.fingerprint === fingerprint && Number.isSafeInteger(saved.readAt)
      && (invalidatedAt === null || saved.readAt > invalidatedAt)
      && Date.now() >= saved.readAt && Date.now() - saved.readAt < ttlMs && Array.isArray(saved.ids)
      && saved.ids.every(id => typeof id === 'string')
    let saved = Object.hasOwn(previous, selection.id) ? previous[selection.id] : undefined
    if (!fresh(saved)) {
      const cached = cachedCollections && Object.hasOwn(cachedCollections, selection.id) ? cachedCollections[selection.id] : undefined
      // 跨任务复用必须有 AFP 的内容更新时间和完整成员数；缺失版本时仍逐个读取。
      const revision = selection.lastContentUpdate
      const versioned = typeof revision === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(revision) && Number.isFinite(Date.parse(revision))
      saved = versioned && Number.isSafeInteger(count) && count >= 0 && fresh(cached) && cached.ids.length === count ? cached : undefined
    }
    const reusable = fresh(saved)
    const contents = reusable ? null : await measure('collection-read', () => client.getSelection(selection.id))
    const values = reusable ? saved.ids : await measure('collection-parse', () => [...selectionDocIds(contents)])
    for (const value of values) ids.add(value)
    checkpoint.collections[selection.id] = { fingerprint, ids: [...values], readAt: reusable ? saved.readAt : Date.now() }
    completed++
    // 新获取的成员立即保存；复用项只在整次准备结束时合并保存，避免重复写入完整快照。
    if (reusable) reused = true
    else { writes = writes.then(() => onCheckpoint(checkpoint)); await writes }
    onProgress({ stage: 'collections', completed, total: named.length, reservedCount: ids.size })
  }, signal)
  if (reused) { signal.throwIfAborted(); await onCheckpoint(checkpoint) }
  signal.throwIfAborted()
  return ids
}

/** Reconstruct the apply inputs exclusively from persisted pixel-review results. */
export function manifests(run, config) {
  const profiles = CATEGORY_PROFILES.filter(profile => run.categories.includes(profile.key)).map(profile => ({ ...profile,
    selectionName: Object.hasOwn(run.bindings ?? {}, profile.key) ? run.bindings[profile.key]?.name ?? null : profile.selectionName }))
  const candidateManifest = createCandidateManifest(profiles.map(profile => ({ ...run.groups[profile.key]?.discovery, profile, candidates: run.groups[profile.key]?.candidates ?? [] })))
  return { candidateManifest, decisionManifest: finalizeDecisionManifest(candidateManifest, run.decisions, {
    threshold: config.threshold, limitPerCategory: config.targetPerCategory,
  }) }
}

/** Model-visible summary excludes raw media references, document ids and provider errors. */
export function summary(run) {
  return { runId: run.id, status: run.status, stage: run.stage ?? (run.status === 'running' ? 'visual' : run.status), categories: run.categories.map(category => ({
    category, selectionName: Object.hasOwn(run.bindings ?? {}, category) ? run.bindings[category]?.name ?? null
      : CATEGORY_PROFILES.find(profile => profile.key === category).selectionName,
    reviewed: run.decisions.filter(item => item.category === category && !requestFailed(item)).length,
    kept: run.decisions.filter(item => item.category === category && item.keep).length,
    target: run.settings.targetPerCategory, batches: run.groups[category]?.batches ?? 0,
    exhausted: run.groups[category]?.exhausted ?? false,
    requestFailures: run.decisions.filter(item => item.category === category && item.reason === 'preview or vision request failed').length,
    ...screeningCounts(run.decisions.filter(item => item.category === category)),
    ...(run.groups[category]?.discovery ? { search: {
      rawRecall: run.groups[category].discovery.rawCandidateCount,
      metadataRejected: run.groups[category].discovery.metadataRejectedCount,
      duplicateExcluded: run.groups[category].discovery.duplicateExclusionCount,
      pagesFetched: run.groups[category].discovery.pagination?.totalPagesFetched ?? 0,
      budgetReached: run.groups[category].budgetReached === true,
    } } : {}),
  })), pendingBatch: run.pending !== null, ...(run.failure ? { failure: savedReadFailure(run.failure) } : {}),
    ...(run.dedup ? { preparation: { completed: Object.keys(run.dedup.collections ?? {}).length } } : {}) }
}

/** Provider failures are unfinished work, including records saved before structured errors existed. */
function requestFailed(item) { return item.reason === 'preview or vision request failed' }

/** Fixed counts exclude request failures; arbitrary provider reasons never enter summaries. */
function screeningCounts(decisions) {
  const judged = decisions.filter(item => item.reason !== 'preview or vision request failed')
  const reasons = new Map()
  for (const item of judged.filter(item => !item.keep)) {
    const code = rejectionCode(item)
    reasons.set(code, (reasons.get(code) ?? 0) + 1)
  }
  return { pixelReviewed: judged.length, rejected: judged.filter(item => !item.keep).length,
    rejectionReasons: [...reasons].map(([code, count]) => ({ code, count })) }
}

function rejectionCode(item) {
  return /duplicate|limit|target reached/.test(item.reason ?? '') ? 'duplicate-or-limit'
    : item.predictedCategory !== undefined && item.predictedCategory !== item.category ? 'category'
      : item.confidence < item.appliedThreshold ? 'confidence' : 'visual-rule'
}

/** Project saved per-image outcomes for the authenticated UI, without provider reasons or media URLs.
 * @param {object} run Persisted run and its candidate metadata.
 * @returns {Array<object>} Known candidate identities with screening outcomes.
 */
export function reviewedPhotoResults(run) {
  const photos = new Map(Object.values(run.groups).flatMap(group => group.candidates.map(photo => [photo.id, photo])))
  return run.decisions.filter(item => photos.has(item.id)).map(item => {
    const photo = photos.get(item.id), requestFailed = item.reason === 'preview or vision request failed'
    return { id: item.id, ...(typeof photo.guid === 'string' && photo.guid.trim() && photo.guid.length <= 256 && !/[\u0000-\u001f\u007f]/.test(photo.guid) ? { guid: photo.guid } : {}),
      title: typeof photo.title === 'string' ? photo.title : item.id, category: item.category,
      keep: item.keep, requestFailed, reasonCode: !requestFailed && !item.keep ? rejectionCode(item) : null }
  })
}

/** Save each completed image and confirmation phase before admitting further work.
 * Search pages persist cursor and queued candidates together; resumes replace failures in place.
 * Optional readReserved refreshes candidate membership before queue consumption and restored visual work;
 * absent means reserved is the caller's complete account exclusion set.
 * approvedHistory contains other reports' completed approvals and remains independent of remote membership.
 */
export async function refreshRun({ run, store, config, client, previewClient, visionClient, signal,
  onProgress = () => {}, primitives = {}, reserved = new Set(), readReserved,
  approvedHistory = { ids: new Set(), guids: new Set() }, diagnostic }) {
  const measure = (stage, operation) => diagnostic ? diagnostic.measure(stage, operation) : operation()
  const profiles = CATEGORY_PROFILES.filter(profile => run.categories.includes(profile.key))
  run.reviews ??= []
  for (const item of run.decisions.filter(requestFailed)) if (!run.reviews.some(review => review.id === item.id)) {
    run.reviews.push({ id: item.id, category: item.category, attempts: 1, phase: 'failed' })
  }
  const historicalIds = new Set(approvedHistory.ids)
  const historyCandidates = values => {
    for (const photo of values) if (approvedHistory.guids.has(photo.guid)) historicalIds.add(photo.id)
    return values.filter(photo => !historicalIds.has(photo.id))
  }
  // 历史通过与远端归属分开维护；反查中的“未收藏”不能清除历史通过记录。
  const restored = historyCandidates([...(run.pending?.candidates ?? []), ...Object.values(run.groups).flatMap(group => group.candidates)])
  if (readReserved && restored.length) await readReserved(restored)
  const blocked = new Set()
  // 每批以实时归属和已完成决策重建排除集，移除收藏不会留下旧的归属阻断。
  const updateBlocked = () => {
    blocked.clear()
    for (const id of reserved) blocked.add(id)
    for (const id of historicalIds) blocked.add(id)
    for (const item of run.decisions) if (!requestFailed(item)) blocked.add(item.id)
  }
  updateBlocked()
  const titles = new Set(Object.values(run.groups).flatMap(group => group.candidates
    .filter(photo => run.decisions.some(item => item.id === photo.id && !requestFailed(item))).map(candidateTitleKey)).filter(Boolean))
  let saves = Promise.resolve()
  const save = operation => {
    const next = saves.then(async () => { operation?.(); await store.saveRun(run) })
    saves = next
    return next
  }
  const session = (diagnostic ? operation => diagnostic.sync('search-initialization', operation) : operation => operation())(() =>
    (primitives.session ?? createPhotoSearchSession)({ client, profiles, pageSize: config.pageSize,
    maxPages: config.maxPages, readRetries: 0, searchConcurrency: config.searchConcurrency,
    maxSearchRequests: config.maxSearchRequests, signal, searchState: run.searchState,
    onCandidates: async values => {
      const fresh = historyCandidates(values)
      if (readReserved && fresh.length) await readReserved(fresh)
      updateBlocked()
    },
    onStateChange: async (state, pending) => {
      await save(() => {
        run.searchState = state
        if (pending) run.pending = pending
        for (const category of run.categories) if (run.groups[category]) {
          const status = session.getStatus(category)
          run.groups[category].discovery = { rawCandidateCount: status.rawCandidateCount, metadataRejectedCount: status.metadataRejectedCount,
            duplicateExclusionCount: status.duplicateExclusionCount, pagination: status.pagination, sourceStats: status.sourceStats }
        }
      })
      onProgress({ stage: 'search', pagesFetched: Object.values(state.categories).reduce((sum, group) => sum + group.variants.reduce((count, variant) => count + variant.pagesFetched, 0), 0) })
    } }))
  run.status = 'running'
  delete run.failure
  await save()
  const accepted = category => run.decisions.filter(item => item.category === category && item.keep).length
  const judged = category => run.decisions.filter(item => item.category === category && !requestFailed(item)).length
  const reached = category => accepted(category) >= config.targetPerCategory && judged(category) >= config.minimumReviewedPerCategory
  try {
    const ordered = run.pending ? [...profiles.filter(profile => profile.key === run.pending.category), ...profiles.filter(profile => profile.key !== run.pending.category)] : profiles
    for (const profile of ordered) {
      const group = run.groups[profile.key] ??= { candidates: [], batches: 0, exhausted: false }
      let reviewedThisStart = 0
      const attemptedThisStart = new Set()
      while ((!reached(profile.key) || run.pending?.category === profile.key) && reviewedThisStart < config.maxBatches) {
        signal.throwIfAborted()
        if (!run.pending) {
          const failed = run.decisions.filter(item => item.category === profile.key && requestFailed(item)
            && !attemptedThisStart.has(item.id) && !blocked.has(item.id)
            && item.failure?.retryable !== false
            && (run.reviews.find(review => review.id === item.id)?.attempts ?? 1) < config.maxPhotoAttempts)
          const retryIds = new Set(failed.slice(0, config.batchSize).map(item => item.id))
          const retryCandidates = group.candidates.filter(photo => retryIds.has(photo.id))
          if (retryCandidates.length) run.pending = { category: profile.key, candidates: retryCandidates, exhausted: group.exhausted, retry: true }
          else {
            const batchSize = Math.min(config.batchSize, Math.max(1, config.targetPerCategory - accepted(profile.key),
              config.minimumReviewedPerCategory - judged(profile.key)))
            run.stage = 'search'
            await save()
            onProgress({ stage: 'search', category: profile.key, reviewed: judged(profile.key), kept: accepted(profile.key), target: config.targetPerCategory })
            const batch = await measure('search', () => session.nextBatch(profile.key, { batchSize, excludedIds: blocked, excludedTitleKeys: titles }))
            run.searchState = session.exportState()
            run.pending = { category: profile.key, candidates: batch.candidates, exhausted: batch.exhausted === true, budgetReached: batch.budgetReached === true }
            group.searchStats = batch.stats ?? group.searchStats
            if (session.getStatus) {
              const status = session.getStatus(profile.key)
              group.discovery = { rawCandidateCount: status.rawCandidateCount, metadataRejectedCount: status.metadataRejectedCount,
                duplicateExclusionCount: status.duplicateExclusionCount, pagination: status.pagination, sourceStats: status.sourceStats }
            }
          }
          await save()
        }
        signal.throwIfAborted()
        if (run.pending.category !== profile.key) throw new Error('AFP pending batch does not match its category')
        const pending = run.pending
        // 单张已完成结果不重放；失败图片只在新的 start/resume 中重试一次。
        const candidates = pending.candidates.filter(photo => {
          const review = run.reviews.find(item => item.id === photo.id)
          return !blocked.has(photo.id) && !(review?.phase === 'failed'
            && (review.attempts >= config.maxPhotoAttempts || review.failure?.retryable === false))
        })
        for (const photo of pending.candidates) if (!group.candidates.some(item => item.id === photo.id)) group.candidates.push(photo)
        await save()
        if (!candidates.length) {
          group.exhausted = pending.exhausted
          group.budgetReached = pending.budgetReached === true
          run.pending = null
          await save()
          // 恢复批次全部被新归属排除时继续补取候选；空检索及已耗尽预算仍停止。
          if (pending.candidates.length && !group.exhausted && !group.budgetReached) continue
          break
        }
        const candidateManifest = createCandidateManifest([{ profile, candidates }])
        const savedAttempts = new Map(run.reviews.map(review => [review.id, review.attempts]))
        const checkpointed = new Set()
        let previewed = 0
        const publish = event => {
          run.stage = event.stage ?? 'visual'
          previewed = Math.max(previewed, event.previewed ?? 0)
          const counts = screeningCounts(run.decisions)
          onProgress({ ...event, category: profile.key, total: run.decisions.length + candidates.filter(photo => !run.decisions.some(item => item.id === photo.id)).length,
            reviewed: counts.pixelReviewed, pixelReviewed: counts.pixelReviewed, requestFailures: run.decisions.length - counts.pixelReviewed,
            kept: accepted(profile.key), target: config.targetPerCategory, reviewedPhotos: reviewedPhotoResults(run) })
        }
        const commit = decision => save(() => {
          const existing = run.decisions.findIndex(item => item.id === decision.id)
          decision.visualKeep ??= decision.keep
          decision.visualReason ??= decision.reason
          if (existing < 0) run.decisions.push(decision)
          else run.decisions[existing] = decision
          // 按候选顺序确定数量上限，不让并发响应先后改变最终选图。
          const order = new Map(group.candidates.map((photo, index) => [photo.id, index]))
          let kept = 0
          for (const item of run.decisions.filter(item => item.category === profile.key).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))) {
            const visualKeep = item.visualKeep ?? item.keep
            item.keep = visualKeep && !reserved.has(item.id) && !historicalIds.has(item.id) && kept < config.targetPerCategory
            if (item.keep) kept++
            item.reason = visualKeep && !item.keep ? 'duplicate or category target reached' : item.visualReason ?? item.reason
          }
          if (!requestFailed(decision)) { blocked.add(decision.id); titles.add(candidateTitleKey(group.candidates.find(photo => photo.id === decision.id))) }
        })
        const decisions = await (primitives.triage ?? triageCandidates)({ candidateManifest, previewClient, visionClient,
          threshold: config.threshold, concurrency: config.concurrency, signal, reviewStates: run.reviews,
          onReviewState: review => save(() => {
            checkpointed.add(review.id)
            const index = run.reviews.findIndex(item => item.id === review.id)
            if (index < 0) run.reviews.push(review); else run.reviews[index] = review
          }), onResult: commit,
          measure, onStage: publish, onProgress: event => publish({ ...event, stage: 'visual' }) })
        // 注入的旧 triage adapter 不具备回调时，仍按单张结果保存。
        for (const decision of decisions) if (!run.decisions.some(item => item === decision)) await commit(decision)
        signal.throwIfAborted()
        for (const photo of candidates) {
          attemptedThisStart.add(photo.id)
          if (!checkpointed.has(photo.id)) {
            const previous = run.reviews.findIndex(item => item.id === photo.id)
            const review = { id: photo.id, category: profile.key, attempts: (savedAttempts.get(photo.id) ?? 0) + 1,
              phase: requestFailed(run.decisions.find(item => item.id === photo.id) ?? {}) ? 'failed' : 'done' }
            if (previous < 0) run.reviews.push(review); else run.reviews[previous] = review
          }
        }
        group.batches++
        reviewedThisStart++
        group.exhausted = pending.exhausted
        group.budgetReached = pending.budgetReached === true
        run.pending = null
        await save()
        publish({ stage: 'visual', previewed, reviewedPhotos: reviewedPhotoResults(run), batch: group.batches })
      }
    }
    run.status = run.categories.every(reached) ? 'ready' : 'paused'
    await save()
    return run
  } catch (error) {
    run.status = signal.aborted ? signal.reason?.name === 'AfpPause' ? 'paused' : 'cancelled' : 'failed'
    await save()
    throw error
  }
}
