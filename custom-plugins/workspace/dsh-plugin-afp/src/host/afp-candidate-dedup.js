/** Read fresh candidate memberships only for versioned private collections.
 * @param {object} options Authenticated client, signal, mutable reserved set, page size and full-scan reader.
 * Optional version returns a local-write generation and writesPending identifies in-flight writes;
 * absent means the caller owns write exclusion.
 * @returns {Promise<object>} Reader whose update must finish before any candidate reaches visual work.
 * Shared/unversioned directories and incomplete wire results switch to a fresh full scan for this run.
 * API failures propagate; an unknown or failed membership is never accepted as an empty membership.
 */
export async function createCandidateDedup({ client, signal, reserved, pageSize, readAll, version = () => null, writesPending = () => false }) {
  let full = false
  const directory = async () => {
    signal.throwIfAborted()
    const rows = await client.listSelections()
    signal.throwIfAborted()
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !row.id)) throw new Error('Invalid AFP collection list')
    const named = rows.filter(row => String(row.name ?? '').trim())
    return { rows, named, fingerprint: JSON.stringify(rows.map(row => [row.id, row.name ?? '', row.isPrivate,
      row.docsCount ?? row.count ?? null, row.lastContentUpdate ?? null]).sort((a, b) => a[0].localeCompare(b[0]))) }
  }
  const supported = ({ named }) => named.every(row => row.isPrivate === true
    && Number.isSafeInteger(row.docsCount ?? row.count) && (row.docsCount ?? row.count) >= 0
    && typeof row.lastContentUpdate === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(row.lastContentUpdate)
    && Number.isFinite(Date.parse(row.lastContentUpdate)))
  const fallback = async () => {
    // 不把候选反查的部分结果混入全量检查点；首次回退必须绕过成员缓存。
    const all = await readAll({ fresh: true })
    signal.throwIfAborted()
    reserved.clear()
    for (const id of all) reserved.add(id)
    full = true
  }
  if (typeof client.photoSelectionsByIds !== 'function' || writesPending() || !supported(await directory())) await fallback()
  return {
    get mode() { return full ? 'full' : 'candidate' },
    /** Refresh one batch without caching membership across batches or runs.
     * @param {Array<object>} candidates Canonical candidate ids to verify.
     * @returns {Promise<void>} Settles only after complete verification or a complete full-scan fallback.
     */
    async update(candidates) {
      signal.throwIfAborted()
      if (full || !candidates.length) return
      const generation = version(), before = await directory()
      if (writesPending() || !supported(before)) { await fallback(); return }
      const known = new Set(before.rows.map(row => row.id)), named = new Set(before.named.map(row => row.id))
      const ids = [...new Set(candidates.map(photo => photo.id))], memberships = new Map()
      for (let offset = 0; offset < ids.length; offset += pageSize) {
        signal.throwIfAborted()
        const batch = ids.slice(offset, offset + pageSize), requested = new Set(batch)
        const docs = await client.photoSelectionsByIds(batch)
        signal.throwIfAborted()
        if (!Array.isArray(docs) || docs.length !== batch.length) { await fallback(); return }
        for (const doc of docs) {
          if (!doc || !requested.delete(doc.id) || !Array.isArray(doc.selections)) { await fallback(); return }
          let collected = false
          for (const item of doc.selections) {
            const id = item?.id
            if (typeof id !== 'string' || !id || !known.has(id)) { await fallback(); return }
            if (named.has(id)) collected = true
          }
          memberships.set(doc.id, collected)
        }
        if (requested.size) { await fallback(); return }
      }
      const after = await directory()
      if (writesPending() || before.fingerprint !== after.fingerprint || generation !== version()) { await fallback(); return }
      signal.throwIfAborted()
      for (const [id, collected] of memberships) {
        if (collected) reserved.add(id)
        else reserved.delete(id)
      }
    },
  }
}
