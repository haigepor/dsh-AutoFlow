/** Actual file import, full review, request ledger and repository; only external sources are scripted. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { RunEngine, dataOf, toJson, type ExecutionSpec } from '../src/host/runtime.ts'
import { recoverWallpaperSources } from '../src/host/wallpaper-source-recovery.ts'
import { runSchema } from '../src/shared/model.ts'
import { wallpaperStateSchema } from '../src/shared/wallpaper.ts'
import type { ImageSourceProvider } from '../src/media/index.ts'
import { WallpaperWorkflows } from '../src/host/wallpaper-workflow.ts'
import { imageVersionSchema } from '../src/shared/model.ts'
import { remoteReferenceBlob } from '../src/media/remote-reference.ts'
import { importedRecords } from '../src/host/imports.ts'
import { sourceIdentity } from '../src/host/providers.ts'
import { assessmentSchema } from '../src/shared/model.ts'

test('replacement search pages past restricted and rejected sources, preserves successful slots, and reuses the saved result', async () => {
  const f = await serviceFixture(undefined, { maxSearchPages: 4 })
  const engine = new RunEngine(f.repository, f.jobs)
  try {
    await f.service.initialize()
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'Source recovery' }))
    await f.action('reference-import', { operationId: 'refs', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'analysis', styleId: style.id, buildDataset: true }); await f.jobs.drain()
    const profile = f.repository.list('modelProfile')[0]!, image = f.repository.list('imageVersion').find(i => i.versionKind === 'normalized')!
    const state = wallpaperStateSchema.parse({ version: 1, sourceRunId: 'source-search', skillVersion: 'skill', items: [{ imageVersionId: image.id, originalId: image.id, familyId: 'saved-family', status: 'passed', edits: 2, attempts: [] }, { imageVersionId: image.id, familyId: 'restricted-family', status: 'technical-failed', failedStep: 'downloading', errorCode: 'original-source-restricted', reason: 'Original unavailable' }] })
    const savedSlot = structuredClone(state.items[0])
    const spec: ExecutionSpec = { kind: 'crop', config: f.service.config, input: { taskBrief: 'Use muted green colors.' }, fixed: { release: toJson(profile), executionRecipe: toJson({ ...profile.recipe, styleMatching: { version: 2, minSatisfiedRatio: 1 } }) }, specDigest: 'recovery' }
    const parent = runSchema.parse({ schemaVersion: 1, profileId: f.profileId, id: 'source-search', createdAt: '2026-11-09T00:00:00.000Z', kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'completed', stage: 'finalizing', spec: toJson({ ...spec, kind: 'search', input: { queries: ['green outdoor'], taskBrief: spec.input.taskBrief }, fixed: { ...spec.fixed, output: { kind: 'preview' } } }), data: { attemptId: 'parent', attempts: 1, budget: { vision: 0, search: 0, downloadBytes: 0, deadlineAt: Date.now() + 600000 }, checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] } })
    const prior = importedRecords(f.profileId, f.actor, await f.files.importBytes(f.referenceImage, 'image/png'), { kind: 'provider', ...sourceIdentity(f.service.config), providerAssetId: 'prior-rejected', description: 'Previously rejected source', obtainedAt: parent.createdAt })
    const rejected = assessmentSchema.parse({ schemaVersion: 1, profileId: f.profileId, createdAt: parent.createdAt, kind: 'assessment', id: 'prior-rejection', runId: parent.id, imageVersionId: prior.image.id, stage: 'final', technicalStatus: 'completed', verdict: 'reject', standard: { kind: profile.kind, id: profile.id, contentDigest: profile.contentDigest }, recipeId: profile.recipe.id, reviewBundleId: 'prior-review', ruleResults: [], preferenceScores: {}, cropPotential: 'unknown', data: {} })
    await f.repository.commit({ aggregateId: 'recovery-parent', expectedRevision: 0, operationId: 'parent', request: {}, records: [parent, ...prior.records, rejected], state: {} })
    const pages: (string | null)[] = [], lookups: string[] = [], downloads: string[] = []
    const source: ImageSourceProvider = { config: {}, async search(_query, cursor) { pages.push(cursor); return { items: (cursor === null ? ['restricted', 'prior-rejected', 'rejected'] : ['accessible']).map(providerAssetId => ({ providerAssetId, previewUrl: 'https://images.example.test/preview', ...(providerAssetId === 'accessible' ? { originalUrl: 'https://images.example.test/accessible' } : {}) })), nextCursor: cursor === null ? 'page-2' : 'page-3' } }, async lookup(id) { lookups.push(id); return { providerAssetId: id, previewUrl: 'https://images.example.test/preview', ...(id === 'restricted' ? { originalUnavailable: 'restricted' as const } : { originalUrl: `https://images.example.test/${id}` }) } } }
    const bytes = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#247f35' } }).png().toBuffer()
    let calls = 0
    const run = await engine.create(spec, f.actor, async ctx => {
      const save = async (records = [] as import('../src/shared/model.ts').CuratorRecord[]) => ctx.save('retrieving', { checkpoint: { ...dataOf(ctx.current()).checkpoint, wallpaper: toJson(state) } }, records)
      const deps = { domain: f.domain, files: f.files, source, media: { async request(url: string) { downloads.push(url); f.http.mode = url.endsWith('/rejected') ? 'reject-final' : 'pass'; return { status: 200, headers: { 'content-type': 'image/png' }, bytes } } }, vision: () => f.providers.vision(f.service.config) }
      const replacements = await recoverWallpaperSources(deps, ctx, state, f.actor, save)
      calls = replacements.length
      state.items.push({ imageVersionId: image.id, familyId: 'another-unavailable-source', status: 'technical-failed', failedStep: 'downloading', errorCode: 'original-source-restricted', edits: 0, attempts: [] })
      assert.equal((await recoverWallpaperSources(deps, ctx, state, f.actor, save)).length, 0)
      return 'target-met'
    }, 'recover')
    await f.jobs.drain()
    assert.equal(f.domain.require('run', run.id).status, 'completed')
    assert.equal(calls, 1); assert.deepEqual(pages, [null, 'page-2']); assert.deepEqual(lookups, ['restricted', 'rejected']); assert.equal(downloads.length, 2)
    assert.equal(state.budgetStopped, true, 'another unavailable slot stops at the existing search budget without another request')
    assert.equal(state.items[1]!.status, 'queued', 'a qualified downloaded replacement remains ready for processing after search admission stops')
    assert.equal(dataOf(f.domain.require('run', run.id)).budget.search, 4, 'an original URL already present in a page consumes no lookup request')
    assert.deepEqual(state.items[0], savedSlot)
    assert.equal(state.items[1]!.replacementOf!.errorCode, 'original-source-restricted')
    assert.ok(state.items[1]!.originalId)
    const assessment = f.repository.list('assessment').find(row => row.runId === run.id && row.imageVersionId === state.items[1]!.originalId)
    assert.equal(assessment?.verdict, 'pass'); assert.equal(assessment?.stage, 'final')
    assert.ok(f.repository.list('assessment').some(row => row.runId === run.id && row.verdict !== 'pass'))
    const reviewRequests = f.repository.list('request').filter(row => row.runId === run.id && row.state === 'committed').flatMap(row => {
      const saved = z.object({ bundle: z.object({ inputText: z.string() }) }).safeParse(row.data)
      return saved.success ? [JSON.parse(saved.data.bundle.inputText)] : []
    })
    assert.ok(reviewRequests.some(request => request.input?.usage?.imageRepresentations?.some((view: { sourceWidth: number; viewWidth: number }) => view.sourceWidth === 800 && view.viewWidth <= f.service.config.limits.previewMaxDimension)), 'model-view source and reduced dimensions are retained in the actual request receipt')
    const original = f.domain.require('imageVersion', state.items[1]!.originalId!)
    assert.equal(f.domain.require('asset', original.assetId).source.kind, 'provider')
    assert.ok(f.repository.list('imageVersion').some(i => i.parentImageVersionId === original.id && i.versionKind === 'preview'))
    const remote = imageVersionSchema.parse({ ...image, id: 'old-remote', versionKind: 'remote-reference', blob: remoteReferenceBlob({ providerId: 'unsplash', photoId: 'old-photo', accountId: 'account', url: 'https://images.unsplash.com/old', thumbnailUrl: 'https://images.unsplash.com/old-small' }) })
    const legacyOriginal = imageVersionSchema.parse({ ...image, id: 'legacy-original-without-preview', parentImageVersionId: remote.id })
    const legacyState = wallpaperStateSchema.parse({ ...state, items: [{ ...state.items[0], imageVersionId: remote.id, originalId: legacyOriginal.id }, { ...state.items[1], imageVersionId: remote.id, originalId: undefined }] })
    const child = runSchema.parse({ ...parent, id: 'legacy-wallpaper', spec: toJson({ ...spec, input: { workflow: 'wallpaper-v1', sourceRunId: parent.id }, fixed: { ...spec.fixed, wallpaper: f.service.config.wallpaper } }), data: { ...dataOf(parent), checkpoint: { wallpaper: toJson(legacyState) } } })
    await f.repository.commit({ aggregateId: 'legacy-thumbnails', expectedRevision: 0, operationId: 'legacy-thumbnails', request: {}, records: [remote, legacyOriginal, child], state: {} })
    const workflows = new WallpaperWorkflows({ domain: f.domain, files: f.files, engine, config: () => f.service.config, source: async () => source, media: () => f.http, vision: () => f.providers.vision(f.service.config), skill: () => ({ id: 'skill', content: 'Keep the source.' }) })
    const view = workflows.read(parent.id, f.actor, 0, 1)!
    assert.equal(view.itemIndex!.length, 2)
    assert.ok(view.itemIndex!.every(item => item.previewPath?.includes('imageVersionId=old-remote') && item.previewPath.includes('preview=thumbnail')))
    assert.equal(view.state.items[0]!.originalId, legacyOriginal.id, 'reading thumbnails leaves the historical original intact')
  } finally { await engine.dispose(); await f.cleanup() }
})
