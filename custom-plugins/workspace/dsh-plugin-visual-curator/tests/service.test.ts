import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { specOf, dataOf } from '../src/host/runtime.ts'

test('real service imports references, publishes explicitly, searches/crops, revises feedback and exports immutable supervision', async () => {
  const f = await serviceFixture()
  await f.service.initialize()
  try {
    const style = z.object({ id: z.string(), revision: z.number() }).parse(await f.action('style-create', { name: 'Muted green', operationId: 'create' }))
    const imported = await f.action('reference-import', { operationId: 'import', styleId: style.id, expectedRevision: 1, bytesAllowed: true, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    assert.equal(z.object({ results: z.array(z.object({ ok: z.boolean() })) }).parse(imported).results[0]?.ok, true)
    assert.deepEqual(await f.action('reference-import', { operationId: 'import', styleId: style.id, expectedRevision: 1, bytesAllowed: true, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] }), imported)
    await f.action('reference-analyze', { styleId: style.id, operationId: 'analysis' }); await f.jobs.drain()
    assert.equal(f.repository.list('suggestion').length, 1)
    assert.equal(f.repository.list('feedback').length, 1)
    const candidate = z.object({ id: z.string() }).parse(await f.action('candidate-create', { operationId: 'candidate', styleId: style.id, expectedRevision: 2 }))
    const release = z.object({ id: z.string() }).parse(await f.action('release-publish', { operationId: 'publish', styleId: style.id, expectedRevision: 3, candidateId: candidate.id }))
    assert.equal(f.domain.require('style', style.id).defaultReleaseId, null)
    await f.action('default-set', { operationId: 'default', styleId: style.id, expectedRevision: 4, releaseId: release.id })
    const usage = z.object({ id: z.string() }).parse(await f.action('usage-create', { operationId: 'usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: ['visible subject'] }))
    const started = z.object({ runId: z.string(), jobId: z.string() }).parse(await f.action('search-start', { operationId: 'search', releaseId: release.id, usageRevisionId: usage.id, taskBrief: 'Muted green image', sourceId: 'images', targetCount: 1 }))
    await f.jobs.drain()
    const run = f.domain.require('run', started.runId)
    assert.equal(run.status, 'completed', JSON.stringify(dataOf(run)))
    assert.equal(run.outcome, 'target-met', JSON.stringify(dataOf(run)))
    assert.equal(f.repository.list('selection').length, 1)
    assert.equal(specOf(run).fixed.release && z.object({ id: z.string() }).parse(specOf(run).fixed.release).id, release.id)
    const current = await f.action('run-get', { runId: run.id })
    assert.ok(JSON.stringify(current).includes('/api/visual-curator/resource'))
    assert.ok(!JSON.stringify(current).includes('https://images.example.test'))
    assert.ok(!JSON.stringify(f.repository.list('request')).includes('https://images.example.test'))
    const image = f.repository.list('imageVersion').find(item => item.versionKind === 'normalized')!
    const resource = await f.service.resource(new Request(`https://owner.example/api/visual-curator/resource?imageVersionId=${image.id}`))
    assert.equal(resource.status, 200)
    assert.equal(resource.headers.get('content-type'), 'image/png')
    await assert.rejects(f.service.action({ operation: 'release-publish', args: {} }, { kind: 'agent', id: 'agent', profileId: f.profileId, sessionId: 's' }, new AbortController().signal), { code: 'owner-denied' })
  } finally { await f.cleanup() }
})

test('mixed batch failure preserves good pixels; bad model output is technical failure, not a style reject', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { name: 'Mixed', operationId: 'create' }))
    const response = z.object({ results: z.array(z.object({ ok: z.boolean() })) }).parse(await f.action('reference-import', { operationId: 'mixed', styleId: style.id, expectedRevision: 1, files: [{ name: 'valid.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }, { name: 'bad.png', mime: 'image/png', base64: 'YmFk', role: 'positive', intent: 'overall', dimensions: [] }] }))
    assert.deepEqual(response.results.map(item => item.ok), [true, false])
    f.http.mode = 'bad-json'
    const handle = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { styleId: style.id, operationId: 'bad-analysis' }))
    await f.jobs.drain()
    const run = f.domain.require('run', handle.runId)
    assert.equal(run.status, 'failed'); assert.equal(dataOf(run).error?.code, 'vision-invalid-output')
    assert.equal(f.repository.list('suggestion').length, 0)
  } finally { await f.cleanup() }
})
