/** Isolated workflow integration uses actual storage and deterministic byte-transfer gates. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WallpaperDownloads } from '../src/host/wallpaper-downloads.ts'
import { wallpaperDownloadProgress, wallpaperItemSchema, wallpaperStateSchema, wallpaperViewSchema } from '../src/shared/wallpaper.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { RunEngine, dataOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { WallpaperWorkflows } from '../src/host/wallpaper-workflow.ts'
import { importedRecords } from '../src/host/imports.ts'
import { sourceIdentity } from '../src/host/providers.ts'
import { sourceFaithfulWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { assetSchema, imageVersionSchema, runSchema } from '../src/shared/model.ts'
import { contentDigest } from '../src/domain/repository.ts'

test('live counters are isolated by task and image and released on abort, replacement and completion', () => {
  const downloads = new WallpaperDownloads(), first = new AbortController(), other = new AbortController(), newer = new AbortController()
  const initial = { phase: 'locating' as const, attempt: 0, receivedBytes: 0 }
  const one = downloads.begin('one', 'source', first.signal, initial), two = downloads.begin('two', 'source', other.signal, initial)
  one.update({ phase: 'downloading', attempt: 1, receivedBytes: 4, totalBytes: 8 })
  assert.equal(downloads.read('one', 'source')!.receivedBytes, 4); assert.equal(downloads.read('two', 'source')!.receivedBytes, 0)
  const replacement = downloads.begin('one', 'source', newer.signal, initial)
  one.update({ phase: 'downloading', attempt: 1, receivedBytes: 8, totalBytes: 8 }); one.close()
  assert.equal(downloads.read('one', 'source')!.receivedBytes, 0)
  replacement.update({ phase: 'retrying', attempt: 1, receivedBytes: 0 }); newer.abort()
  assert.equal(downloads.read('one', 'source'), undefined); assert(downloads.read('two', 'source'))
  two.close(); assert.equal(downloads.read('two', 'source'), undefined)
})

test('committed originals and download failures override stale counters and history gains no transfer fields', () => {
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', familyId: 'family', status: 'downloading' }), before = JSON.stringify(item)
  const live = { phase: 'downloading' as const, attempt: 1, receivedBytes: 4, totalBytes: 8 }
  assert.equal(wallpaperDownloadProgress(item, 'running', live).receivedBytes, 4)
  assert.equal(wallpaperDownloadProgress(item, 'paused', live).phase, 'paused'); assert.equal(wallpaperDownloadProgress(item, 'cancelled', live).phase, 'cancelled')
  assert.equal(wallpaperDownloadProgress({ ...item, originalId: 'saved' }, 'paused', live).phase, 'saved')
  assert.equal(wallpaperDownloadProgress({ ...item, originalId: 'saved', download: { attempts: 1, retrying: false, reused: true } }, 'completed', live).phase, 'reused')
  assert.equal(wallpaperDownloadProgress({ ...item, status: 'technical-failed', failedStep: 'downloading', errorCode: 'original-source-restricted' }, 'running', live).phase, 'restricted')
  assert.equal(wallpaperDownloadProgress({ ...item, status: 'technical-failed', failedStep: 'downloading' }, 'running', live).phase, 'failed')
  assert.equal(JSON.stringify(item), before)
})

for (const known of [true, false]) test('workflow reads share ' + (known ? 'known-size' : 'unknown-size') + ' counters and save no success before original storage completes', async () => {
  const f = await serviceFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), saving = Promise.withResolvers<void>(), saveRelease = Promise.withResolvers<void>()
  const engine = new RunEngine(f.repository, f.jobs)
  let runId = '', transfers = 0
  try {
    await f.service.initialize()
    const imported = importedRecords(f.profileId, f.actor, await f.files.importBytes(f.http.image, 'image/png'), { kind: 'provider', ...sourceIdentity(f.service.config), providerAssetId: 'progress-source', description: 'Isolated original', obtainedAt: new Date().toISOString() })
    const { originalBlob: _blob, ...withoutOriginal } = imported.asset
    const asset = assetSchema.parse(withoutOriginal), image = imageVersionSchema.parse({ ...imported.preview, id: 'progress-preview', parentImageVersionId: undefined })
    await f.repository.commit({ aggregateId: 'download-seed', expectedRevision: 0, operationId: 'download-seed', request: {}, records: [asset, image], state: {} })
    const importBytes = f.files.importBytes.bind(f.files)
    f.files.importBytes = async (...args) => { saving.resolve(); await saveRelease.promise; return importBytes(...args) }
    f.http.mode = 'bad-json'
    const workflows = new WallpaperWorkflows({ domain: f.domain, files: f.files, engine, config: () => f.service.config, source: async () => ({ config: {}, search: async () => ({ items: [], nextCursor: null }), lookup: async id => ({ providerAssetId: id, previewUrl: 'https://images.example.test/preview', originalUrl: 'https://images.example.test/original' }) }), media: () => ({ request: async (_url, input) => {
      transfers++
      input.onProgress?.({ receivedBytes: 4, ...(known ? { totalBytes: f.http.image.length } : {}) }); entered.resolve(); await release.promise
      input.onProgress?.({ receivedBytes: f.http.image.length, ...(known ? { totalBytes: f.http.image.length } : {}) })
      return { status: 200, headers: {}, bytes: f.http.image }
    } }), vision: config => f.providers.vision(config), skill: () => ({ id: 'fixture', content: 'Retain source pixels.' }) })
    runId = engine.operationRunId('progress-workflow', f.actor)
    const fixed = { wallpaper: toJson(f.service.config.wallpaper), prompts: toJson(sourceFaithfulWallpaperPrompts()), directPolicy: { version: 'source-faithful-v1' }, skill: { id: 'fixture', content: 'Retain source pixels.' } }
    const spec: ExecutionSpec = { kind: 'crop', config: f.service.config, input: { workflow: 'wallpaper-direct-v1', sourceRunId: runId, imageVersionIds: [image.id], taskBrief: 'Observe download state only.', targetCount: 1 }, fixed, specDigest: contentDigest(fixed) }
    await engine.create(spec, f.actor, workflows.worker(), 'progress-workflow')
    await Promise.race([entered.promise, f.jobs.drain().then(() => { throw new Error('The worker stopped before transfer: ' + JSON.stringify(dataOf(f.domain.require('run', runId)).error)) })])
    const checkpoint = contentDigest(dataOf(f.domain.require('run', runId)).checkpoint), first = wallpaperViewSchema.parse(workflows.read(runId, f.actor, 0, 1)), second = workflows.read(runId, f.actor, 0, 1)!
    assert.deepEqual(first.downloads, second.downloads)
    assert.deepEqual(first.downloads![image.id], { phase: 'downloading', attempt: 1, receivedBytes: 4, ...(known ? { totalBytes: f.http.image.length } : {}) })
    assert.equal(first.state.items[0]!.originalId, undefined); assert.equal(contentDigest(dataOf(f.domain.require('run', runId)).checkpoint), checkpoint)
    assert(!JSON.stringify(dataOf(f.domain.require('run', runId)).checkpoint).includes('receivedBytes'))
    release.resolve(); await saving.promise
    const pending = workflows.read(runId, f.actor, 0, 1)!
    assert.equal(pending.downloads![image.id]!.phase, 'saving'); assert.equal(pending.state.items[0]!.originalId, undefined)
    saveRelease.resolve(); await f.jobs.drain()
    const final = workflows.read(runId, f.actor, 0, 1)!, saved = wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper)
    assert.equal(final.downloads![image.id]!.phase, 'saved'); assert.equal(final.downloads![image.id]!.receivedBytes, f.http.image.length)
    assert(saved.items[0]!.originalId); assert(!JSON.stringify(saved).includes('receivedBytes'))
    if (known) {
      const parentId = 'isolated-original-retry-parent', retryImage = imageVersionSchema.parse({ ...image, id: 'retry-source' }), restrictedImage = imageVersionSchema.parse({ ...image, id: 'keep-restricted' })
      const heldItem = { ...saved.items[0]! }; heldItem.status = 'needs-review'; delete heldItem.failedStep; delete heldItem.errorCode
      const parentState = wallpaperStateSchema.parse({ ...saved, sourceRunId: parentId, items: [heldItem, { imageVersionId: retryImage.id, familyId: asset.familyId, status: 'technical-failed', failedStep: 'downloading', errorCode: 'remote-timeout', download: { attempts: 1, retrying: false } }, { imageVersionId: restrictedImage.id, familyId: asset.familyId, status: 'technical-failed', failedStep: 'downloading', errorCode: 'original-source-restricted' }] })
      const parentSpec = { ...spec, input: { ...spec.input, sourceRunId: parentId, imageVersionIds: parentState.items.map(item => item.imageVersionId), targetCount: 3 } }
      const parent = runSchema.parse({ ...f.domain.require('run', runId), id: parentId, revision: 1, status: 'completed', spec: toJson(parentSpec), data: { ...dataOf(f.domain.require('run', runId)), requestIds: [], resultIds: [], checkpoint: { wallpaper: toJson(parentState) } } })
      await f.repository.commit({ aggregateId: parentId, expectedRevision: 0, operationId: parentId, request: {}, records: [retryImage, restrictedImage, parent], state: {} })
      const digest = contentDigest(parent), input = { runId: parentId, operationId: 'explicit-original-retry', retryOriginal: { imageVersionId: retryImage.id } }
      const accepted = await workflows.continue(input, f.actor)
      assert.deepEqual(await workflows.continue(input, f.actor), accepted); await f.jobs.drain()
      const next = workflows.read(parentId, f.actor, 0, 3)!, nextItems = next.state.items
      assert(nextItems[1]!.originalId); assert.equal(transfers, 2, 'Only the selected failed original is downloaded again')
      assert.deepEqual(nextItems[0], parentState.items[0]); assert.deepEqual(nextItems[2], parentState.items[2]); assert.equal(contentDigest(f.domain.require('run', parentId)), digest)
      await assert.rejects(workflows.continue({ runId: parentId, operationId: 'cannot-retry-saved-original', retryOriginal: { imageVersionId: image.id } }, f.actor), { code: 'constraint-conflict' })
    }
  } finally { release.resolve(); saveRelease.resolve(); await engine.dispose(); await f.cleanup() }
})

test('direct images download in parallel and a fast image reaches observation while another original is still transferring', async () => {
  const f = await serviceFixture(), engine = new RunEngine(f.repository, f.jobs), slow = Promise.withResolvers<void>(), observed = Promise.withResolvers<void>()
  let inFlight = 0, peak = 0, watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    await f.service.initialize()
    const images = []
    for (const id of ['slow', 'fast', 'third']) {
      const imported = importedRecords(f.profileId, f.actor, await f.files.importBytes(f.http.image, 'image/png'), { kind: 'provider', ...sourceIdentity(f.service.config), providerAssetId: id, description: 'Isolated parallel original', obtainedAt: new Date().toISOString() })
      const { originalBlob: _blob, ...withoutOriginal } = imported.asset
      const image = imageVersionSchema.parse({ ...imported.preview, id: 'parallel-' + id, parentImageVersionId: undefined })
      await f.repository.commit({ aggregateId: 'parallel-seed-' + id, expectedRevision: 0, operationId: 'parallel-seed-' + id, request: {}, records: [assetSchema.parse(withoutOriginal), image], state: {} })
      images.push(image)
    }
    const workflows = new WallpaperWorkflows({ domain: f.domain, files: f.files, engine, config: () => f.service.config,
      source: async () => ({ config: {}, search: async () => ({ items: [], nextCursor: null }), lookup: async id => ({ providerAssetId: id, previewUrl: 'https://images.example.test/' + id, originalUrl: 'https://images.example.test/' + id }) }),
      media: () => ({ request: async url => { peak = Math.max(peak, ++inFlight); try { if (url.endsWith('/slow')) await slow.promise; return { status: 200, headers: {}, bytes: f.http.image } } finally { inFlight-- } } }),
      vision: async config => { const provider = await f.providers.vision(config); provider.wallpaper = async () => { observed.resolve(); throw new Error('Stop isolated processing after observation admission') }; return provider },
      skill: () => ({ id: 'fixture', content: 'Keep original pixels.' }) })
    const runId = engine.operationRunId('parallel-workflow', f.actor), fixed = { wallpaper: toJson({ ...f.service.config.wallpaper, concurrency: 2 }), prompts: toJson(sourceFaithfulWallpaperPrompts()), directPolicy: { version: 'source-faithful-v1' }, skill: { id: 'fixture', content: 'Keep original pixels.' } }
    const spec: ExecutionSpec = { kind: 'crop', config: f.service.config, input: { workflow: 'wallpaper-direct-v1', sourceRunId: runId, imageVersionIds: images.map(image => image.id), taskBrief: 'Observe independent parallel progress.', targetCount: 3 }, fixed, specDigest: contentDigest(fixed) }
    await engine.create(spec, f.actor, workflows.worker(), 'parallel-workflow')
    await Promise.race([observed.promise, new Promise<never>((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error('A slow first original blocked the fast image observation')), 5000) })])
    const state = wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper)
    assert.equal(state.items[0]!.originalId, undefined); assert(state.items[1]!.originalId)
    assert.equal(peak, 2); assert.equal(inFlight, 1)
    slow.resolve(); await f.jobs.drain()
    assert(wallpaperStateSchema.parse(dataOf(f.domain.require('run', runId)).checkpoint.wallpaper).items.every(item => item.originalId))
    assert.equal(dataOf(f.domain.require('run', runId)).budget.downloadBytes, f.http.image.length * 3)
  } finally { clearTimeout(watchdog); slow.resolve(); await f.jobs.drain(); await f.cleanup() }
})
