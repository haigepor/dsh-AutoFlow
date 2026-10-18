/** Safe article nodes and local edit state derived from persisted workflow records. */
const SCENE_FIELDS = ['purpose', 'rationale', 'subject', 'action', 'environment', 'composition', 'lighting', 'colors', 'style', 'details', 'avoid', 'ratio', 'blockIds', 'assetIds', 'afterBlockId', 'informationGoal', 'visualMode']
const ACTIVE_STATUSES = new Set(['queued', 'running'])
const RESUMABLE_STATUSES = new Set(['interrupted', 'failed', 'cancelled', 'waiting-config'])

/** Build an authenticated asset route from opaque identifiers. @param {string} snapshotId Snapshot identity. @param {string} assetId Asset identity. @returns {string} Relative same-origin route, or empty when invalid. */
export function assetUrl(snapshotId, assetId) {
  return /^[a-f0-9]{32}$/.test(snapshotId) && /^[a-f0-9]{32}$/.test(assetId) ? `api/article-image/asset?snapshot=${snapshotId}&asset=${assetId}` : ''
}

/** Render structured source content without interpreting source HTML. @param {object} React React runtime. @returns {Function} Rich article component. */
export function createRichArticle(React) {
  const h = React.createElement
  const sourceHref = value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '' }
    catch (error) { return '' }
  }
  const inline = values => (values ?? []).map((part, index) => {
    let value = part.text
    if (part.bold) value = h('strong', null, value)
    if (part.italic) value = h('em', null, value)
    const href = sourceHref(part.href)
    return href ? h('a', { key: index, href, target: '_blank', rel: 'noopener noreferrer' }, value) : h('span', { key: index }, value)
  })
  const list = (value, props) => h(value.ordered ? 'ol' : 'ul', props, ...value.items.map((item, index) => h('li', { key: index }, ...inline(item.inline), ...item.children.map((child, offset) => list(child, { key: offset })))))
  return function RichArticle({ snapshot, t, onInspectAsset }) {
    const assets = new Map(snapshot.assets.map(asset => [asset.id, asset]))
    return h('div', { className: 'ai-rich-article' }, ...snapshot.blocks.map(block => {
      const props = { key: block.id, id: `article-image-block-${block.id}`, tabIndex: -1, className: 'ai-source-block', 'data-block-id': block.id }
      const marker = h('span', { className: 'ai-paragraph-id', 'aria-hidden': true }, block.id)
      if (block.type === 'heading') return h(`h${block.level}`, props, marker, ...inline(block.inline))
      if (block.type === 'paragraph') return h('p', props, marker, ...inline(block.inline))
      if (block.type === 'quote') return h('blockquote', props, marker, ...inline(block.inline))
      if (block.type === 'list') return h('div', props, marker, list(block))
      if (block.type === 'table') {
        const rows = block.rows.map((row, index) => h('tr', { key: index }, ...row.cells.map((cell, offset) => h(cell.header ? 'th' : 'td', { key: offset, rowSpan: cell.rowSpan, colSpan: cell.colSpan, ...(cell.header ? { scope: 'col' } : {}) }, ...inline(cell.inline)))))
        return h('div', { ...props, className: 'ai-source-block ai-table-scroll', role: 'region', 'aria-label': t('sourceTable'), tabIndex: 0 }, marker, h('table', null, h('tbody', null, ...rows)))
      }
      if (block.type === 'figure') {
        const asset = assets.get(block.assetId), src = asset?.status === 'ready' ? assetUrl(snapshot.id, block.assetId) : ''
        const image = src ? h('img', { src, alt: block.alt || asset.alt || '', loading: 'lazy', width: asset.width ?? undefined, height: asset.height ?? undefined }) : h('div', { className: 'ai-asset-missing', role: 'status' }, t('assetUnavailable'), block.alt ? h('p', null, block.alt) : null)
        return h('figure', props, marker, src && onInspectAsset ? h('button', { type: 'button', className: 'ai-original-button', 'aria-label': t('inspectOriginal'), onClick: () => onInspectAsset({ ...asset, alt: block.alt || asset.alt, src }) }, image) : image,
          block.caption || block.credit ? h('figcaption', null, block.caption, block.credit ? h('span', { className: 'ai-image-credit' }, block.credit) : null) : null,
          asset?.error ? h('p', { className: 'ai-subtle' }, t(`error_${asset.error}`) || t('assetUnavailable')) : null)
      }
      return null
    }))
  }
}

/** Expose recorded activity and elapsed time without estimating semantic completion. @param {object|null} run Persisted workflow run. @param {number} currentTime Current epoch milliseconds for active work. @returns {object} Progress presentation. */
export function runPresentation(run, currentTime = Date.now()) {
  if (!run) return { active: false, indeterminate: false, canStop: false, canResume: false, counts: {}, elapsedMs: null }
  const active = ACTIVE_STATUSES.has(run.status)
  const started = Date.parse(run.startedAt), ended = active ? currentTime : Date.parse(run.updatedAt ?? run.startedAt)
  const elapsedMs = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null
  return { active, indeterminate: active, canStop: active, canResume: RESUMABLE_STATUSES.has(run.status), stage: run.stage, status: run.status, counts: run.counts ?? {}, startedAt: run.startedAt, elapsedMs, error: run.error }
}

/** Compare editable scene values; evidence and wording edits are checked separately. @param {object} before Saved shot. @param {object} after Edited shot. @returns {boolean} Whether the scene changed. */
export function sceneChanged(before, after) { return !before || SCENE_FIELDS.some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])) }

/** Update a shot without mutating a polled or previously saved plan. @param {object} plan Current draft. @param {number} index Shot offset. @param {string} key Field name. @param {unknown} value New field value. @returns {object} New draft. */
export function updatePlanShot(plan, index, key, value) { return { ...plan, shots: plan.shots.map((shot, offset) => offset === index ? { ...shot, [key]: value } : shot) } }

/** Identify prompts requiring explicit synchronization before review. @param {object} draft Edited plan. @param {object|null} saved Saved plan at edit start. @param {number[]} synchronized Confirmed shot offsets. @returns {number[]} Unsynchronized shot offsets. */
export function promptSyncState(draft, saved, synchronized) {
  const understandingChanged = saved && JSON.stringify(draft.brief) !== JSON.stringify(saved.brief)
  return draft.shots.flatMap((shot, index) => {
    const changed = saved ? sceneChanged(saved.shots[index], shot) : false
    const stale = shot.sceneHash && shot.sceneHash !== shot.promptSceneHash
    return (changed || stale || understandingChanged) && !synchronized.includes(index) ? [index] : []
  })
}
