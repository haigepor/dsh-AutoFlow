/** Source-intent routing evaluates the frozen focus without changing historical whole-subject decisions. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { importedRecords } from '../src/host/imports.ts'
import { executeWallpaperDecision } from '../src/host/wallpaper-decision.ts'
import { RunEngine, toJson } from '../src/host/runtime.ts'
import { wallpaperItemSchema, wallpaperPlanSchema, wallpaperSettingsSchema } from '../src/shared/wallpaper.ts'
import { resolveWallpaperProcessing } from '../src/shared/wallpaper-policy.ts'
import { imageVersionSchema } from '../src/shared/model.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

test('continuing a valid partial portrait uses focus safety while the same historical plan still requires another action', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const engine = new RunEngine(f.repository, f.jobs)
    const bytes = await sharp({ create: { width: 1845, height: 3280, channels: 3, background: '#1f8a6a' } }).png().toBuffer()
    const { image: source } = importedRecords(f.profileId, f.actor, await f.files.importBytes(bytes), { kind: 'local-import', description: 'Isolated partial portrait' })
    const rect = { x: 0.3, y: 0, width: 0.4, height: 1 }, layoutFocus = { x: 0.3, y: 0.4, width: 0.4, height: 0.3 }
    const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: source.id, mode: 'single', subject: 'Intentional partial portrait', evidence: 'Visible torso behind a lectern.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ entityId: 'person', name: 'Person', role: 'subject', rect }], objectRoles: [{ entityId: 'person', name: 'Person', role: 'primary', evidence: 'Original partial view', rect, sourceEdges: ['top', 'bottom'], sourceIntent: { framing: 'partial', visibility: 'occluded', preserve: ['Keep the visible torso.'], relationships: ['The lectern hides the lower body.'], layoutFocus } }], placement: { scale: 1, left: 0, top: 0 }, reason: 'Keep the original view.' })
    for (const current of [false, true]) {
      const settings = wallpaperSettingsSchema.parse({ repairPolicy: {}, processing: resolveWallpaperProcessing(), maxReworks: 0, decision: { enabled: true }, ...(current ? { sourceIntentPolicy: { version: 'source-intent-v1' } } : {}) })
      const item = wallpaperItemSchema.parse({ imageVersionId: source.id, originalId: source.id, familyId: 'family', status: 'needs-review', attempts: [{ revision: 1, plan, checks: [], needsOutpaint: false }] })
      const offered: string[][] = []
      const run = await engine.create({ kind: 'crop', config: f.service.config, input: {}, fixed: {}, specDigest: `portrait-decision-${current}` }, f.actor, async ctx => {
        const resumed = await executeWallpaperDecision({ item, source, original: { imageVersionId: source.id, digest: source.blob.digest, mime: source.blob.mime, bytes, role: 'wallpaper-original' }, settings, prompt: { version: 'wallpaper-decision-v1', text: 'Choose an available routing action.' }, taskBrief: 'Keep the original partial portrait.', rules: [], supportsDetail: false, maxImages: 1, ctx, domain: f.domain, files: f.files,
          commit: async (input, schema) => {
            const decision = z.object({ decision: z.object({ allowedActions: z.array(z.string()), concerns: z.array(z.object({ id: z.string() })) }) }).parse(input.usage).decision
            offered.push(decision.allowedActions)
            return schema(input).parse({ version: 'wallpaper-decision-v1', imageVersionId: source.id, planRevision: 1, findings: decision.concerns.map(concern => ({ concernId: concern.id, scope: 'subject', classification: 'normal-occlusion', blocking: false, reason: 'The original visible torso remains unchanged.', evidenceImageVersionIds: [source.id] })), sourceExtent: { extent: 'complete', reason: 'All originally visible subject pixels fit the canvas.' }, action: { kind: current ? 'continue_current_plan' : 'manual_review' }, reason: 'Use only the offered action; this is not final approval.' })
          }, save: () => ctx.save('planning', { checkpoint: { wallpaper: toJson({ version: 1, sourceRunId: 'source', skillVersion: 'isolated', items: [item] }) } }),
        })
        assert.equal(resumed, current)
        return 'target-met'
      })
      await f.jobs.drain()
      assert.equal(engine.get(run.id, f.actor).status, 'completed')
      assert.equal(offered.length, 1)
      assert.equal(offered.some(actions => actions.includes('continue_current_plan')), current)
      assert.equal(item.status, current ? 'rendering' : 'needs-review')
      assert.equal(item.attempts.length, current ? 2 : 1)
    }
    assert.deepEqual(f.http.operations, [])
  } finally { await f.cleanup() }
})

test('saved background actions require a complete-canvas receipt and discard previous review identities without laundering source-restoration evidence', async () => {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const engine = new RunEngine(f.repository, f.jobs)
    const bytes = await sharp({ create: { width: 400, height: 800, channels: 3, background: '#1f8a6a' } }).png().toBuffer()
    const original = importedRecords(f.profileId, f.actor, await f.files.importBytes(bytes), { kind: 'local-import', description: 'Isolated original' })
    const generatedBytes = await sharp({ create: { width: 400, height: 800, channels: 3, background: '#c41320' } }).png().toBuffer()
    const generated = importedRecords(f.profileId, f.actor, await f.files.importBytes(generatedBytes), { kind: 'local-import', description: 'Isolated complete provider canvas' })
    const source = original.image, raw = imageVersionSchema.parse({ ...generated.image, assetId: source.assetId, parentImageVersionId: source.id, versionKind: 'composition' })
    await f.repository.commit({ aggregateId: 'decision-media', expectedRevision: 0, operationId: 'decision-media', request: {}, records: [...original.records, raw], state: {} })
    const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: source.id, mode: 'single', subject: 'Subject', evidence: 'One known subject.', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Subject', role: 'subject', rect: { x: 0.3, y: 0.4, width: 0.2, height: 0.2 } }], placement: { scale: 1, left: 0, top: 0 }, reason: 'Keep the subject.' })
    const sourceProof = { version: 'source-intent-pixels-v1', sourceDigest: source.blob.digest, outputDigest: raw.blob.digest, comparedPixels: 1, changedPixels: 0, sourceRect: { left: 0, top: 0, width: 1, height: 1 } }
    const scenarios = [
      { mode: 'source-intent-background-v1', version: 'wallpaper-edit-input-v3', restored: true, reconstruction: true, action: 'manual_review' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v4', restored: true, reconstruction: true, action: 'manual_review' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v3', restored: false, reconstruction: true, action: 'manual_review' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v4', restored: false, reconstruction: false, action: 'recompose_saved_background' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v4', restored: false, reconstruction: true, action: 'reconstruct_saved_background' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v5', restored: false, reconstruction: false, action: 'recompose_saved_background' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v5', restored: false, reconstruction: true, action: 'reconstruct_saved_background' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v6', restored: false, reconstruction: false, action: 'recompose_saved_background' },
      { mode: 'generated-canvas-v1', version: 'wallpaper-edit-input-v6', restored: false, reconstruction: true, action: 'reconstruct_saved_background' },
    ] as const
    for (const [index, scenario] of scenarios.entries()) {
      const settings = wallpaperSettingsSchema.parse({ decision: { enabled: true }, backgroundResolution: { enabled: scenario.reconstruction } })
      const item = wallpaperItemSchema.parse({ imageVersionId: source.id, originalId: source.id, familyId: 'family', status: 'technical-failed', failedStep: 'rendering', errorCode: 'render-interrupted', attempts: [{ revision: 1, plan, checks: [], needsOutpaint: true, compositionMode: scenario.mode,
        generation: { id: 'generation', provider: 'isolated', model: 'isolated', taskId: 'task' }, generatedImageId: raw.id,
        generationInput: { version: scenario.version, prompt: 'Return one complete provider canvas.', references: ['wallpaper-edit-input-v5', 'wallpaper-edit-input-v6'].includes(scenario.version) ? [{ role: 'canvas', attachmentId: 'master', width: 400, height: 800 }, { role: 'original', attachmentId: 'original', width: 300, height: 600 }, { role: 'layout-only', attachmentId: 'guide', width: 400, height: 800 }] : [{ role: 'canvas', attachmentId: 'original', width: 400, height: 800 }], ...(scenario.version === 'wallpaper-edit-input-v6' ? { mask: { attachmentId: 'mask', width: 400, height: 800 } } : {}) },
        ...(scenario.restored ? { sourceIntentProof: sourceProof } : {}),
        nativeReviewCandidate: { nativeId: raw.id, nativeDigest: raw.blob.digest, previewId: 'old-preview', simulationId: 'old-simulation' },
        preResolutionReview: { nativeId: raw.id, nativeDigest: raw.blob.digest, previewId: 'old-preview', simulationId: 'old-simulation', finalId: 'old-final' },
        postResolutionReview: { requestId: 'old-review', imageVersionId: 'old-final', digest: 'old-final-digest', nativeId: raw.id, nativeDigest: raw.blob.digest, analysisId: 'old-analysis', simulationId: 'old-simulation' },
      }] })
      const prior = item.attempts[0]; assert.ok(prior)
      const offered: string[][] = []
      const run = await engine.create({ kind: 'crop', config: f.service.config, input: {}, fixed: {}, specDigest: `background-decision-${index}` }, f.actor, async ctx => {
        const resumed = await executeWallpaperDecision({ item, source, original: { imageVersionId: source.id, digest: source.blob.digest, mime: source.blob.mime, bytes, role: 'wallpaper-original' }, settings, prompt: { version: 'wallpaper-decision-v1', text: 'Choose an available recovery action.' }, taskBrief: 'Deliver one complete provider canvas.', rules: [], supportsDetail: false, maxImages: 2, ctx, domain: f.domain, files: f.files,
          commit: async (input, schema) => {
            const decision = z.object({ decision: z.object({ allowedActions: z.array(z.string()), concerns: z.array(z.object({ id: z.string() })) }) }).parse(input.usage).decision
            offered.push(decision.allowedActions)
            return schema(input).parse({ version: 'wallpaper-decision-v1', imageVersionId: source.id, planRevision: 1, findings: decision.concerns.map(concern => ({ concernId: concern.id, scope: 'technical', classification: 'technical-failure', blocking: false, reason: 'Recover only an allowed saved receipt.', evidenceImageVersionIds: [source.id] })), sourceExtent: { extent: 'complete', reason: 'No new source structure is authorized.' }, action: { kind: scenario.action }, reason: 'Use the saved complete generation only when eligible.' })
          }, save: () => ctx.save('planning', { checkpoint: { wallpaper: toJson({ version: 1, sourceRunId: 'source', skillVersion: 'isolated', items: [item] }) } }),
        })
        assert.equal(resumed, scenario.action !== 'manual_review')
        return 'target-met'
      })
      await f.jobs.drain()
      assert.equal(engine.get(run.id, f.actor).status, 'completed')
      assert.equal(offered.length, 1)
      const complete = scenario.action !== 'manual_review'
      assert.equal(offered.some(actions => actions.includes('recompose_saved_background')), complete)
      assert.equal(offered.some(actions => actions.includes('reconstruct_saved_background')), complete && scenario.reconstruction)
      const next = item.attempts.at(-1); assert.ok(next)
      if (complete) {
        assert.equal(item.attempts.length, 2)
        assert.equal(next.nativeReviewCandidate, undefined)
        assert.equal(next.preResolutionReview, undefined)
        assert.equal(next.postResolutionReview, undefined)
        assert.deepEqual(next.generation, prior.generation)
        assert.deepEqual(next.generationInput, prior.generationInput)
        assert.equal(next.generatedImageId, raw.id)
      } else {
        assert.equal(item.attempts.length, 1)
        assert.deepEqual(next.sourceIntentProof, prior.sourceIntentProof, 'An invalid receipt cannot become eligible by deleting its restoration marker')
      }
    }
    assert.deepEqual(f.http.operations, [])
  } finally { await f.cleanup() }
})
