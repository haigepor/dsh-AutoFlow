/** Static learning replay cannot substitute for a source-intent generation workflow. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WallpaperWorkflows } from '../src/host/wallpaper-workflow.ts'
import { RunEngine, dataOf, toJson } from '../src/host/runtime.ts'
import { wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('static replay rejects source-intent generation tasks before reading pixels or calling a provider', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const engine = new RunEngine(f.repository, f.jobs)
    const workflows = new WallpaperWorkflows({ domain: f.domain, files: f.files, engine, config: () => f.service.config, vision: f.providers.vision, source: f.providers.source, media: f.providers.media, skill: () => ({ id: 'isolated-skill', content: 'Keep the original source view.' }) })
    const settings = wallpaperSettingsSchema.parse({ sourceIntentPolicy: { version: 'source-intent-v1' } })
    const previous = await engine.create({ kind: 'crop', config: f.service.config, input: {}, fixed: { wallpaper: toJson(settings) }, specDigest: 'source-intent-source' }, f.actor, async () => 'target-met')
    await f.jobs.drain()
    const sample = { id: 'sample', familyId: 'family', runId: previous.id, imageVersionId: 'unread-source', mode: 'single' as const, passed: true, rounds: 1, needsGeneration: true, reason: 'Generation must run through the real task.', learningEligible: false, benchmark: false }
    const evaluation = await engine.create({ kind: 'evaluate', config: f.service.config, input: {}, fixed: {}, specDigest: 'source-intent-static-replay' }, f.actor, async ctx => { await workflows.evaluate(ctx, sample, 'Candidate guidance.', 1); return 'target-met' })
    await f.jobs.drain()
    const failed = engine.get(evaluation.id, f.actor)
    assert.equal(failed.status, 'failed')
    const error = dataOf(failed).error
    assert.ok(error)
    assert.equal(error.code, 'constraint-conflict')
    assert.equal(error.stage, 'wallpaper-evaluation')
    assert.match(error.safeMessage, /Static replay cannot evaluate source-intent background generation/)
    assert.match(error.safeMessage, /direct image-processing task/)
    assert.deepEqual(f.http.operations, [])
    assert.equal(f.repository.list('request').length, 0)
    assert.equal(f.repository.list('imageVersion').length, 0)
  } finally { await f.cleanup() }
})
