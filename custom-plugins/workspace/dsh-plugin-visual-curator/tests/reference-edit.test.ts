import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { referenceStateSchema } from '../src/shared/reference-state.ts'

test('dimension edits replace only the current association, preserve history and invalidate just the changed observation', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const styleId = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'style', name: 'Scoped references' })).id
    await f.action('reference-import', { operationId: 'import', styleId, expectedRevision: 1, files: [
      { name: 'first.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] },
      { name: 'second.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'negative', intent: 'overall', dimensions: [] },
    ] })
    const prior = structuredClone(f.repository.list('reference')[0]!), second = structuredClone(f.repository.list('reference')[1]!)
    await f.action('reference-analyze', { operationId: 'analysis', styleId }); await f.jobs.drain()
    const oldProfile = structuredClone(f.repository.list('modelProfile')[0]!), observations = structuredClone(f.repository.list('observation'))
    const style = f.domain.require('style', styleId), input = { operationId: 'edit', styleId, expectedRevision: style.revision, referenceId: prior.id, role: 'positive', intent: { kind: 'dimensions', dimensions: ['color', 'lighting'] }, comment: '只参考颜色与光线，不采用主体和构图。' }
    const receipt = z.object({ id: z.string(), revision: z.number() }).parse(await f.action('reference-edit', input))
    const changed = f.domain.require('draft', receipt.id)
    assert.equal(changed.referenceIds.length, 2)
    assert.equal(changed.referenceIds.includes(prior.id), false)
    assert.equal(changed.referenceIds.includes(second.id), true)
    assert.deepEqual(f.domain.require('reference', prior.id), prior)
    assert.deepEqual(f.domain.require('reference', second.id), second)
    assert.deepEqual(f.domain.require('modelProfile', oldProfile.id), oldProfile)
    assert.deepEqual(f.repository.list('observation'), observations)
    const next = f.domain.require('reference', changed.referenceIds.find(id => id !== second.id)!)
    assert.deepEqual(next.intent, { kind: 'dimensions', dimensions: ['color', 'lighting'] })
    assert.equal(next.imageVersionId, prior.imageVersionId)
    assert.ok(next.feedbackThreadIds.every(threadId => f.repository.list('feedback').some(row => row.threadId === threadId && row.comment === input.comment && row.judgment.kind === 'dimension-verdict')))
    assert.deepEqual(await f.action('reference-edit', input), await f.action('reference-edit', input))
    const plan = referenceStateSchema.parse(await f.action('reference-state', { styleId }))
    assert.equal(plan.reusable, 1); assert.equal(plan.changed, 1)
    await assert.rejects(f.action('reference-edit', { ...input, operationId: 'stale' }), { code: 'revision-conflict' })
    await assert.rejects(f.action('reference-edit', { ...input, operationId: 'empty-dimensions', expectedRevision: f.domain.require('style', styleId).revision, intent: { kind: 'dimensions', dimensions: [] } }), { code: 'invalid-input' })
    assert.equal(f.http.operations.length, 3, 'Reference editing does not run a model or generate images')
  } finally { await f.cleanup() }
})
