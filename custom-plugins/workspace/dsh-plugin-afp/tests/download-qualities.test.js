import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseDownloadRenditions, downloadQualityChoices } from '../src/client/afp-download-qualities.js'
import { createAfpClientStore } from '../src/client/afp-client-store.js'

const photos = [
  { id: 'a', renditions: [
    { id: 'a-mock', quality: 'Mockup', available: true, purchaseCost: 0, width: 600, height: 400 },
    { id: 'a-high', quality: 'HighRes · HighDef', available: true, purchaseCost: 2, width: 6000, height: 4000 },
    { id: 'a-mid', quality: 'MidRes', available: true, purchaseCost: 0, width: 1200, height: 800 },
    { id: 'a-blocked', quality: 'Restricted', available: false, purchaseCost: 0, width: 9000, height: 9000 },
  ] },
  { id: 'b', renditions: [
    { id: 'b-high', quality: 'HighRes · HighDef', available: true, purchaseCost: 0, width: 5000, height: 4000 },
    { id: 'b-mock', quality: 'Mockup', available: true, purchaseCost: 0, width: 700, height: 500 },
  ] },
  { id: 'c', errorCode: 'download-photo-unavailable', renditions: [] },
]

test('batch preferences rank each photo independently and exclude unavailable media', () => {
  assert.deepEqual(chooseDownloadRenditions(photos, { kind: 'free' }, true), { a: 'a-mid', b: 'b-high' })
  assert.deepEqual(chooseDownloadRenditions(photos, { kind: 'highest' }, true), { a: 'a-high', b: 'b-high' })
  assert.deepEqual(chooseDownloadRenditions(photos, { kind: 'highest' }, false), { a: 'a-mid', b: 'b-high' })
  assert.deepEqual(chooseDownloadRenditions(photos, { kind: 'quality', quality: 'HighRes · HighDef' }, true), { a: 'a-high', b: 'b-high' })
  assert.deepEqual(chooseDownloadRenditions(photos, { kind: 'quality', quality: 'HighRes · HighDef' }, false), { b: 'b-high' })
})

test('batch menu reports matching counts for exact AFP labels and retains blocked choices', () => {
  const choices = downloadQualityChoices(photos, false)
  const high = choices.find(choice => choice.preference.quality === 'HighRes · HighDef')
  assert.equal(high.matched, 1)
  assert.equal(high.total, 3)
  const blocked = choices.find(choice => choice.preference.quality === 'Restricted')
  assert.equal(blocked.matched, 0)
  assert.equal(blocked.disabled, true)
  assert.equal(choices.find(choice => choice.preference.kind === 'free').matched, 2)
})

test('batch quality publishes once, preserves unmatched choices and invalidates spend review', () => {
  const store = createAfpClientStore({})
  store.set({ selectedPhotos: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
    downloadOptions: { photos: [...photos, { id: 'foreign', renditions: photos[0].renditions }] },
    downloadSelected: { a: 'a-mock', b: 'b-mock', c: 'retained' }, status: { features: ['write'] },
    downloadPlan: { confirmation: 'old-receipt' }, downloadQuoteChanged: true })
  let changes = 0
  store.subscribe(() => changes++)
  assert.equal(store.applyDownloadQuality({ kind: 'quality', quality: 'MidRes' }), true)
  assert.equal(changes, 1)
  const state = store.getSnapshot()
  assert.deepEqual(state.downloadSelected, { a: 'a-mid', b: 'b-mock', c: 'retained' })
  assert.equal(state.downloadPlan, null)
  assert.equal(state.downloadQuoteChanged, false)
  assert.deepEqual(state.downloadBulkResult, { matched: 1, total: 3 })
  store.setDownloadRendition('a', 'a-mock')
  assert.equal(store.getSnapshot().downloadBulkResult, null)
  store.resetData()
  assert.equal(store.getSnapshot().downloadBulkResult, null)
  store.dispose()
})

test('batch changes wait for reads and submission, and do not invalidate review when nothing matches', () => {
  const store = createAfpClientStore({}), plan = { confirmation: 'receipt' }
  store.set({ selectedPhotos: { a: { id: 'a' } }, downloadOptions: { photos }, downloadSelected: { a: 'a-mock' },
    status: { features: ['read'] }, downloadPlan: plan })
  assert.equal(store.applyDownloadQuality({ kind: 'quality', quality: 'HighRes · HighDef' }), false)
  assert.equal(store.getSnapshot().downloadPlan, plan)
  for (const lock of [{ downloadOptionsLoading: true }, { downloadBusy: true }, { downloadErrorStage: 'options' }]) {
    store.set({ downloadOptionsLoading: false, downloadBusy: false, downloadErrorStage: '', ...lock })
    assert.equal(store.applyDownloadQuality({ kind: 'free' }), false)
    assert.deepEqual(store.getSnapshot().downloadSelected, { a: 'a-mock' })
  }
  store.dispose()
})
