/** Saved analysis versions describe original model requests without rewriting earlier checkpoints. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import sharp from 'sharp'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf, toJson } from '../src/host/runtime.ts'
import { styleAnalysisOf } from '../src/shared/style-analysis.ts'
import { observationPromptVersion } from '../src/host/observation-prompt-version.ts'

test('new observations record reference-v4 while historical v1 checkpoints retain their literal value', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'audit-style', name: 'Version audit' }))
    await f.action('reference-import', { operationId: 'audit-import', styleId, expectedRevision: 1, files: [{ name: 'reference.png', base64: f.http.image.toString('base64'), mime: 'image/png', role: 'positive', intent: 'overall', dimensions: [] }] })
    const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId: 'audit-analysis', styleId, buildDataset: true }))
    await f.jobs.drain()
    const run = f.domain.require('run', runId), analysis = styleAnalysisOf(run)!
    assert.equal(analysis.observationPromptVersion, 'visual-curator-reference-v4')
    const legacyData = toJson({ ...dataOf(run), checkpoint: { ...dataOf(run).checkpoint, styleAnalysis: { ...analysis, observationPromptVersion: 'visual-curator-v1' } } })
    const before = JSON.stringify(legacyData)
    assert.equal(styleAnalysisOf({ ...run, data: legacyData })!.observationPromptVersion, 'visual-curator-v1')
    assert.equal(JSON.stringify(legacyData), before)
    const observations = f.repository.list('observation'), requests = f.repository.list('request')
    assert.equal(observationPromptVersion(observations, requests), 'visual-curator-reference-v4')
    assert.equal(observationPromptVersion(observations, []), 'unknown')
    assert.equal(observationPromptVersion(observations, requests.map(request => ({ ...request, state: 'outcome-unknown' }))), 'unknown')
    const requestId = observations[0]!.inferred[0]!.requestId
    for (const bundle of [{ operation: 'analyze', requestId }, { operation: 'analyze', requestId, promptVersion: 'future-reference-version' }]) {
      assert.equal(observationPromptVersion(observations, [{ ...requests[0]!, state: 'committed', data: toJson({ bundle }) }]), 'unknown')
    }
    assert.deepEqual(f.domain.require('run', runId).data, run.data)
  } finally { await f.cleanup() }
})

test('incremental summaries identify mixed v1 and current reference requests without relabeling reused observations', async context => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const provider = await f.providers.vision(f.service.config), describe = provider.describeRequest.bind(provider)
    let legacy = true
    context.mock.method(provider, 'describeRequest', (...args: Parameters<typeof describe>) => {
      const descriptor = describe(...args)
      return legacy && descriptor.operation === 'analyze' ? { ...descriptor, promptVersion: 'visual-curator-v1' as const } : descriptor
    })
    context.mock.method(f.providers, 'vision', async () => provider)
    const { id: styleId } = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'mixed-style', name: 'Mixed version evidence' }))
    const add = async (color: string) => {
      const base64 = (await sharp({ create: { width: 16, height: 16, channels: 3, background: color } }).png().toBuffer()).toString('base64')
      await f.action('reference-import', { operationId: `add-${color}`, styleId, expectedRevision: f.domain.require('style', styleId).revision, files: [{ name: color + '.png', base64, mime: 'image/png', role: 'positive', intent: 'overall', dimensions: [] }] })
    }
    const analyze = async (operationId: string) => {
      const plan = z.object({ digest: z.string() }).parse(await f.action('reference-state', { styleId }))
      const { runId } = z.object({ runId: z.string() }).parse(await f.action('reference-analyze', { operationId, styleId, buildDataset: true, analysisMode: 'pending', planDigest: plan.digest }))
      await f.jobs.drain()
      const run = f.domain.require('run', runId)
      assert.equal(run.status, 'completed', JSON.stringify(dataOf(run).error))
      return run
    }
    await add('red')
    const first = await analyze('legacy-request'), oldAnalysis = styleAnalysisOf(first)!, oldObservation = f.domain.require('observation', oldAnalysis.samples[0]!.observationId)
    assert.equal(oldAnalysis.observationPromptVersion, 'visual-curator-v1')
    legacy = false
    await add('green')
    const before = f.http.operations.length, second = await analyze('current-request'), analysis = styleAnalysisOf(second)!
    assert.deepEqual(f.http.operations.slice(before), ['analyze:', 'summarize:'])
    assert.equal(analysis.observationPromptVersion, 'mixed')
    assert.equal(analysis.samples.length, 2)
    assert.deepEqual(f.domain.require('observation', oldObservation.id), oldObservation)
    assert.deepEqual(f.domain.require('run', first.id), first)
    assert.equal(styleAnalysisOf(f.domain.require('run', first.id))!.observationPromptVersion, 'visual-curator-v1')
    const reused = await analyze('reuse-mixed')
    assert.equal(styleAnalysisOf(reused)!.observationPromptVersion, 'mixed')
  } finally { await f.cleanup() }
})
