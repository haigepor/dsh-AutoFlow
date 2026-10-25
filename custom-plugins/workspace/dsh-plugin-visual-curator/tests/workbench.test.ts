/** The workbench composes the real service; fixtures replace only upstream HTTP. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCuratorStore } from '../src/client/store.ts'
import { archiveCollections, draftArgs, filterReferences, publishStyle, resultId, searchArgs, suggestedRules } from '../src/client/workbench-actions.ts'
import type { ImageView } from '../src/client/contract.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('bulk removal uses the confirmed collection list and leaves later collections available', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    await store.execute('style-create', { operationId: 'bulk-one', name: 'First' })
    await store.execute('style-create', { operationId: 'bulk-two', name: 'Second' })
    const confirmed = store.getSnapshot().snapshot!.styles.filter(style => !style.archived)
    const later = resultId(await store.execute('style-create', { operationId: 'bulk-later', name: 'Created after confirmation' }))
    const progress: number[] = []
    assert.deepEqual(await archiveCollections(store, confirmed, 'bulk-confirmed', value => progress.push(value)), { status: 'completed', removed: 2 })
    assert.deepEqual(progress, [1, 2])
    assert.deepEqual(store.getSnapshot().snapshot!.styles.filter(style => !style.archived).map(style => style.styleId), [later])
  } finally { store.dispose(); await f.cleanup() }
})

test('bulk removal stops at a changed collection and retry does not commit earlier removals twice', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const first = resultId(await store.execute('style-create', { operationId: 'partial-first', name: 'First' }))
    const second = resultId(await store.execute('style-create', { operationId: 'partial-second', name: 'Second' }))
    const third = resultId(await store.execute('style-create', { operationId: 'partial-third', name: 'Third' }))
    const confirmed = [first, second, third].map(styleId => store.getSnapshot().snapshot!.styles.find(style => style.styleId === styleId)!)
    await store.execute('draft-save', draftArgs(confirmed.find(style => style.styleId === second)!, []))
    const partial = { status: 'failed', removed: 1, failedName: 'Second', conflict: true }
    assert.deepEqual(await archiveCollections(store, confirmed, 'partial-batch'), partial)
    const revision = store.getSnapshot().snapshot!.styles.find(style => style.styleId === first)!.revision
    assert.deepEqual(await archiveCollections(store, confirmed, 'partial-batch'), partial)
    assert.equal(store.getSnapshot().snapshot!.styles.find(style => style.styleId === first)?.revision, revision)
    const remaining = store.getSnapshot().snapshot!.styles.filter(style => !style.archived)
    assert.equal(remaining.length, 2)
    assert.deepEqual(await archiveCollections(store, remaining, 'reviewed-batch'), { status: 'completed', removed: 2 })
    assert.equal(store.getSnapshot().styleId, '')
  } finally { store.dispose(); await f.cleanup() }
})

test('bulk removal does not count a mutation refused by another in-flight archive', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const store = createCuratorStore({ invoke: async (operation, args) => { if (operation === 'style-archive') await gate; return f.action(operation, args) } })
  let pending: Promise<unknown> | undefined
  try {
    const first = resultId(await store.execute('style-create', { operationId: 'concurrent-first', name: 'First' }))
    const second = resultId(await store.execute('style-create', { operationId: 'concurrent-second', name: 'Second' }))
    const target = store.getSnapshot().snapshot!.styles.find(style => style.styleId === second)!
    pending = store.execute('style-archive', { operationId: 'other-view', styleId: first, expectedRevision: 1 })
    assert.deepEqual(await archiveCollections(store, [target], 'busy-batch'), { status: 'failed', removed: 0, failedName: 'Second', conflict: false })
    assert.equal(store.getSnapshot().snapshot!.styles.find(style => style.styleId === second)?.archived, false)
  } finally { release(); await pending; store.dispose(); await f.cleanup() }
})

test('removing image sets preserves their references, checks revisions and selects the remaining set', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const first = resultId(await store.execute('style-create', { operationId: 'remove-first', name: 'Remove first' }))
    const second = resultId(await store.execute('style-create', { operationId: 'keep-second', name: 'Keep second' }))
    store.selectStyle(first)
    await store.execute('reference-import', { operationId: 'retained-reference', styleId: first, expectedRevision: 1, files: [{ name: 'retained.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const before = store.getSnapshot().snapshot!.styles.find(style => style.styleId === first)!
    await assert.rejects(store.execute('style-archive', { operationId: 'stale-remove', styleId: first, expectedRevision: 1 }), { code: 'revision-conflict' })
    assert.equal(store.getSnapshot().snapshot!.styles.find(style => style.styleId === first)?.archived, false)
    const removal = { operationId: 'remove-current', styleId: first, expectedRevision: before.revision }
    await store.execute('style-archive', removal)
    const removed = store.getSnapshot().snapshot!.styles.find(style => style.styleId === first)!
    assert.equal(removed.archived, true)
    assert.deepEqual(removed.referenceIds, before.referenceIds)
    assert.equal(store.getSnapshot().styleId, second)
    await store.execute('style-archive', removal)
    assert.equal(store.getSnapshot().snapshot!.styles.find(style => style.styleId === first)?.revision, removed.revision)
    await store.execute('style-archive', { operationId: 'remove-last', styleId: second, expectedRevision: 1 })
    assert.equal(store.getSnapshot().styleId, '')
  } finally { store.dispose(); await f.cleanup() }
})

test('workbench recognizes references, confirms evidence, publishes and searches a fixed style, then exports its Skill', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  const store = createCuratorStore({ invoke: f.action })
  try {
    const styleId = resultId(await store.execute('style-create', { operationId: 'style', name: 'Quiet green' }))
    await store.execute('reference-import', { operationId: 'import', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await store.execute('reference-analyze', { operationId: 'analyze', styleId }); await f.jobs.drain(); await store.reload()
    const snapshot = store.getSnapshot().snapshot!
    const style = snapshot.styles.find(item => item.styleId === styleId)!
    const suggestions = suggestedRules(snapshot, style)
    assert.equal(style.rules.length, 0)
    assert.equal(suggestions.length, 1)
    assert.equal(suggestions[0]?.confirmed, false)
    assert.deepEqual(suggestions[0]?.supportRefs, style.referenceIds)
    assert.equal(suggestedRules({ ...snapshot, images: [] }, style).length, 0)
    assert.equal(suggestedRules(snapshot, { ...style, draftRevision: style.draftRevision + 1 }).length, 0)
    await store.execute('draft-save', draftArgs(style, suggestions))
    const confirmed = store.getSnapshot().snapshot!.styles.find(item => item.styleId === styleId)!
    assert.equal(confirmed.rules[0]?.confirmed, true)
    const releaseId = await publishStyle(store, confirmed)
    assert.equal(f.domain.require('style', styleId).defaultReleaseId, null)
    const usageRevisionId = resultId(await store.execute('usage-create', { operationId: 'usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const runId = resultId(await store.execute('search-start', searchArgs({ releaseId, usageRevisionId, sourceId: 'images', taskBrief: 'Quiet streets', queries: 'muted city\nsoft light', targetCount: 1 })), 'runId')
    await f.jobs.drain(); await store.reload(); store.selectRun(runId); await store.loadRun(runId)
    assert.equal(store.getSnapshot().snapshot!.runs.find(run => run.runId === runId)?.status, 'completed')
    const splitId = resultId(await store.execute('split-create', { operationId: 'split', assignments: [{ familyId: snapshot.images[0]!.familyId, split: 'learning', groupingConfirmed: true }] }))
    await store.execute('export-start', { operationId: 'export', kind: 'skill', purpose: 'reference', releaseId, splitId, mode: 'references-only' })
    await f.jobs.drain(); await store.reload()
    const exported = store.getSnapshot().snapshot!.exports[0]!
    assert.match(exported.preview!, /SKILL.md/)
    assert.match(exported.preview!, /Use muted green colors/)
    assert.match(exported.downloadPath!, /^\/api\/visual-curator\/resource\?exportId=/)
  } finally { store.dispose(); await f.cleanup() }
})

test('search requires explicit keywords while draft saves preserve reference and feedback identities', () => {
  assert.throws(() => searchArgs({ releaseId: 'r', usageRevisionId: 'u', sourceId: 's', taskBrief: 'cover', queries: ' \n ', targetCount: 1 }), /invalid-input/)
  assert.deepEqual(searchArgs({ releaseId: 'r', usageRevisionId: 'u', sourceId: 's', taskBrief: 'cover', queries: ' film \n\n soft light ', targetCount: 1 }).queries, ['film', 'soft light'])
})

test('image browsing combines filename and role filters without including other collections or changing analysis references', () => {
  const image = (referenceId: string, name: string, role: ImageView['role'], styleId = 'selected'): ImageView => ({
    referenceId, name, ...(role ? { role } : {}), styleId, imageVersionId: referenceId, assetId: referenceId, familyId: referenceId,
    width: 800, height: 400, kind: 'normalized', previewPath: '/api/visual-curator/resource?imageVersionId=' + referenceId,
    source: 'local', exportPermission: 'references-only', groupingStatus: 'unreviewed',
  })
  const images = [image('positive', '森林-FILM.png', 'positive'), image('negative', '森林-dark.png', 'negative'),
    image('undecided', '街道.png', 'undecided'), image('removed', 'removed.png', 'positive'),
    image('foreign', '森林.png', 'positive', 'other'), image('legacy', 'legacy.png', undefined)]
  const style = { styleId: 'selected', referenceIds: ['positive', 'negative', 'undecided', 'foreign', 'legacy'] }
  assert.deepEqual(filterReferences(images, style, '  森林-film  ', 'positive').map(item => item.referenceId), ['positive'])
  assert.deepEqual(filterReferences(images, style, '森林', 'negative').map(item => item.referenceId), ['negative'])
  assert.deepEqual(filterReferences(images, style, '', 'undecided').map(item => item.referenceId), ['undecided', 'legacy'])
  assert.deepEqual(filterReferences(images, style, 'missing', 'all'), [])
  assert.deepEqual(filterReferences(images, style, '', 'all').map(item => item.referenceId), ['positive', 'negative', 'undecided', 'legacy'])
  assert.equal(images.length, 6)
  assert.equal(style.referenceIds.length, 5)
})
