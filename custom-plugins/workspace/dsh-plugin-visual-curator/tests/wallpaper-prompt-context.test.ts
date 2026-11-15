/** Compact wallpaper requests retain quality policy, source identities and strict acceptance. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { wallpaperModelUsage } from '../src/media/wallpaper-context.ts'
import { CompatibleVisionProvider } from '../src/media/vision.ts'
import { wallpaperRepairInstructions } from '../src/shared/wallpaper-policy.ts'
import { sourceFaithfulWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperBoundaryReviewPrompt } from '../src/shared/wallpaper-repair-prompts.ts'
import { wallpaperSettingsSchema, wallpaperRoleObservationOutputSchema, wallpaperReviewOutputSchema } from '../src/shared/wallpaper.ts'
import { jsonSchema, type Json } from '../src/shared/model.ts'

const expected = z.object({ taskIntegrityGuidance: z.string(), qualitySettings: z.array(z.string()), checks: z.array(z.string()), requiredReviewFields: z.array(z.string()), prompts: z.object({ plan: z.string(), review: z.string(), boundary: z.string() }) }).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-prompt-context.expected.json', import.meta.url), 'utf8')))

function expandSchema(value: Json, definitions: Record<string, Json> = {}): Json {
  if (Array.isArray(value)) return value.map(item => expandSchema(item, definitions))
  if (value === null || typeof value !== 'object') return value
  if (typeof value.$ref === 'string') {
    const reference = definitions[value.$ref.slice('#/$defs/'.length)]
    assert.ok(reference)
    const target = expandSchema(reference, definitions)
    assert.ok(target !== null && typeof target === 'object' && !Array.isArray(target))
    const siblings = expandSchema(Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref')), definitions)
    assert.ok(siblings !== null && typeof siblings === 'object' && !Array.isArray(siblings))
    return { ...target, ...siblings }
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$defs').map(([key, item]) => [key, expandSchema(item, definitions)]))
}

test('request compaction removes execution controls without dropping quality policy or custom instructions', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: { clockContrast: {} } })
  const usage = { settings, objectPolicy: { objectRoles: [{ entityId: 'subject', role: 'primary', evidence: 'Frozen role' }] }, layoutCoordinates: { safe: settings.safe },
    imageRepresentations: [{ imageVersionId: 'original', sourceRect: { x: 0.2, y: 0.1, width: 0.3, height: 0.4 } }],
    sourceEdgeContinuation: { targets: [{ entityId: 'subject', disposition: 'interior' }] }, composition: { instruction: 'Caller-specific measured seam requires repair.' }, previous: [{ reason: 'Unresolved source fact' }] }
  const untouched = structuredClone(usage)
  const compact = jsonSchema.parse(wallpaperModelUsage(usage))
  assert.ok(compact !== null && typeof compact === 'object' && !Array.isArray(compact))
  const projected = compact.settings
  assert.ok(projected !== null && typeof projected === 'object' && !Array.isArray(projected))
  assert.deepEqual(Object.keys(projected).sort(), expected.qualitySettings)
  const originalSettings = z.record(z.string(), jsonSchema).parse(settings)
  for (const key of expected.qualitySettings) assert.deepEqual(projected[key], originalSettings[key])
  for (const key of ['objectPolicy', 'layoutCoordinates', 'imageRepresentations', 'sourceEdgeContinuation', 'composition', 'previous']) assert.deepEqual(compact[key], z.record(z.string(), jsonSchema).parse(usage)[key])
  assert.deepEqual(usage, untouched)
  assert.deepEqual(wallpaperModelUsage({ composition: { instruction: wallpaperRepairInstructions } }), { composition: { instruction: 'Apply the frozen repair policy in the system instructions; independently verify the actual output pixels.' } })
})

test('shared review definitions preserve every JSON constraint and the complete acceptance checklist', async () => {
  const bytes = await sharp({ create: { width: 32, height: 48, channels: 3, background: 'black' } }).png().toBuffer()
  const images = ['wallpaper-original', 'actual-wallpaper'].map((role, index) => ({ imageVersionId: index ? 'output' : 'source', role, mime: 'image/png' as const, bytes, digest: createHash('sha256').update(bytes).digest('hex') }))
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], images.map(image => image.imageVersionId), 'output', 'source', true)
  const provider = new CompatibleVisionProvider({ endpoint: 'https://fixture.invalid', model: 'reviewer', supportsMultiImage: true, maxImages: 8, maxImageBytes: 1_000_000, maxRequestBytes: 2_000_000, maxOutputTokens: 16000, temperature: 0.1 }, { async request() { throw Error('Request description must not invoke a model') } })
  const prompts = sourceFaithfulWallpaperPrompts(wallpaperSettingsSchema.parse({ repairPolicy: { mode: 'repair-when-needed' } }))
  const descriptor = provider.describeRequest({ requestId: 'review', taskBrief: 'Retain strict final quality.', images, rules: [], usage: { settings: wallpaperSettingsSchema.parse({ repairPolicy: { mode: 'repair-when-needed' } }) }, wallpaperPrompt: prompts.review, wallpaperOutputSchema: schema }, 'wallpaper-review')
  const transmitted = z.object({ outputSchema: jsonSchema }).parse(JSON.parse(descriptor.inputText)).outputSchema
  assert.ok(transmitted !== null && typeof transmitted === 'object' && !Array.isArray(transmitted))
  const definitions = z.record(z.string(), jsonSchema).parse(transmitted.$defs)
  assert.deepEqual(expandSchema(transmitted, definitions), jsonSchema.parse(z.toJSONSchema(schema, { unrepresentable: 'any', io: 'output' })))
  const fields = z.object({ properties: z.object({ checks: z.object({ required: z.array(z.string()) }) }), required: z.array(z.string()) }).parse(transmitted)
  assert.deepEqual(fields.properties.checks.required, expected.checks)
  assert.deepEqual(fields.required.sort(), expected.requiredReviewFields.toSorted())
  assert.equal(descriptor.promptVersion, 'wallpaper-review-source-v4')
  const planning = provider.describeRequest({ requestId: 'plan', taskBrief: 'Observe without changing roles.', images: images.slice(0, 1), rules: [], usage: { settings: wallpaperSettingsSchema.parse({ repairPolicy: { mode: 'repair-when-needed' } }) }, wallpaperPrompt: prompts.plan, wallpaperOutputSchema: wallpaperRoleObservationOutputSchema() }, 'wallpaper-plan')
  assert.equal(JSON.parse(planning.inputText).outputSchema.$defs, undefined)
})

test('planning, final review and boundary prompts each carry the frozen repair policy once', () => {
  const prompts = sourceFaithfulWallpaperPrompts(wallpaperSettingsSchema.parse({ repairPolicy: { mode: 'repair-when-needed' } }))
  assert.deepEqual({ plan: prompts.plan.text, review: prompts.review.text, boundary: wallpaperBoundaryReviewPrompt }, expected.prompts)
  for (const prompt of [prompts.plan.text, prompts.review.text, wallpaperBoundaryReviewPrompt]) assert.equal(prompt.split(wallpaperRepairInstructions).length - 1, 1)
})

test('review integrity guidance retains the complete task policy, custom requirements and planning evidence', async () => {
  const bytes = await sharp({ create: { width: 32, height: 48, channels: 3, background: 'black' } }).png().toBuffer()
  const image = { imageVersionId: 'source', role: 'wallpaper-original', mime: 'image/png' as const, bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  const provider = new CompatibleVisionProvider({ endpoint: 'https://fixture.invalid', model: 'reviewer', supportsMultiImage: true, maxImages: 8, maxImageBytes: 1_000_000, maxRequestBytes: 2_000_000, maxOutputTokens: 16000, temperature: 0.1 }, { async request() { throw Error('Request description must not invoke a model') } })
  const prompts = sourceFaithfulWallpaperPrompts(wallpaperSettingsSchema.parse({ repairPolicy: { mode: 'repair-when-needed' } }))
  const usage = { skill: { id: 'custom', content: wallpaperRepairInstructions }, previous: [{ plan: { regions: [{ entityId: 'truss', rect: { x: 0, y: 0.4, width: 1, height: 0.2 } }] } }] }
  for (const operation of ['wallpaper-plan', 'wallpaper-review'] as const) {
    const wallpaperPrompt = operation === 'wallpaper-plan' ? prompts.plan : prompts.review
    const input = { requestId: operation, taskBrief: wallpaperRepairInstructions, images: [image], rules: [], usage, wallpaperPrompt, wallpaperOutputSchema: wallpaperRoleObservationOutputSchema() }
    const duplicate = provider.describeRequest(input, operation)
    const encoded = JSON.parse(duplicate.inputText)
    assert.equal(encoded.input.taskBrief, wallpaperRepairInstructions)
    assert.deepEqual(encoded.input.usage, usage)
    assert.ok(duplicate.instructions.includes(wallpaperRepairInstructions))
    if (operation === 'wallpaper-review') {
      assert.ok(duplicate.instructions.includes(expected.taskIntegrityGuidance))
      const legacy = provider.describeRequest({ ...input, wallpaperPrompt: { ...wallpaperPrompt, version: 'wallpaper-review-source-v3' } }, operation)
      assert.equal(legacy.instructions.includes(expected.taskIntegrityGuidance), false)
    }
    for (const taskBrief of ['Keep three co-primary hikers and their backpacks.', `${wallpaperRepairInstructions}\nKeep the distant left and right trusses.`]) {
      assert.equal(JSON.parse(provider.describeRequest({ ...input, taskBrief }, operation).inputText).input.taskBrief, taskBrief)
    }
    const standalone = provider.describeRequest({ ...input, wallpaperPrompt: { ...wallpaperPrompt, text: 'Custom policy without the shared instructions.' } }, operation)
    assert.equal(JSON.parse(standalone.inputText).input.taskBrief, wallpaperRepairInstructions)
  }
})
