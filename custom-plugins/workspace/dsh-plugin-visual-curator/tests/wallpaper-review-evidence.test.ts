/** Blocking findings require an observable cause, frozen entity and complete output evidence. */
import assert from 'node:assert/strict'
import { z } from 'zod'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { wallpaperObjectRoleSchema, wallpaperSourceReviewV4Schema, wallpaperStoredSourceReviewV4Schema, wallpaperReviewOutputSchema, wallpaperReviewKeys, wallpaperSettingsSchema, wallpaperVerdict, wallpaperItemSchema, wallpaperReviewReworkAvailable } from '../src/shared/wallpaper.ts'
import { applyWallpaperNoClockRequirement, applyWallpaperSourceReview } from '../src/host/wallpaper-review.ts'
import { CompatibleVisionProvider, MediaError } from '../src/media/index.ts'
import { safeFailure } from '../src/host/runtime.ts'
import type { VisionInput } from '../src/media/vision.ts'

const objects = [
  wallpaperObjectRoleSchema.parse({ entityId: 'fruit', name: 'Fruit', role: 'primary', evidence: 'The food is the subject.', rect: { x: 0.3, y: 0.4, width: 0.3, height: 0.2 }, sourceEdges: [] }),
  wallpaperObjectRoleSchema.parse({ entityId: 'bowl', name: 'Wood bowl', role: 'supporting', evidence: 'Ordinary serving vessel.', rect: { x: 0.7, y: 0.5, width: 0.3, height: 0.3 }, sourceEdges: ['right'] }),
]
const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], ['source', 'output'], 'output', 'source', true, objects)
const settings = wallpaperSettingsSchema.parse({ repairPolicy: {} })
function savedRework(raw: ReturnType<typeof review>) {
  const effective = applyWallpaperSourceReview(raw, true, settings)
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', originalId: 'source', familyId: 'food', status: 'needs-review', edits: 1, attempts: [{ revision: 1, needsOutpaint: true, checks: [], outputId: 'output', review: effective,
    plan: { version: 1, imageVersionId: 'source', mode: 'single', subject: 'Fruit', evidence: 'Visible fruit.', priorities: [], anchors: [], truncations: [], uncertainties: [], reason: 'Uniform placement.', placement: { scale: 1, left: 0, top: 0 }, objectRoles: objects, regions: [{ entityId: 'fruit', name: 'Fruit', role: 'subject', rect: objects[0]!.rect }] } }] })
  return wallpaperReviewReworkAvailable(item, settings)
}
function review() {
  return wallpaperSourceReviewV4Schema.parse({ reviewVersion: 'wallpaper-review-source-v4', subject: 'Fruit in a wood bowl',
    checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: 'satisfied', reason: 'Visible original and output pixels.' }])),
    issues: [], styleResults: [], sourceRepair: { result: 'satisfied', reason: 'No new content damage.' }, sourceCorrespondence: { result: 'satisfied', reason: 'Same objects after uniform placement.' },
    subjectIntegrity: { mode: 'single', source: { extent: 'complete', imageVersionId: 'source', reason: 'Complete fruit.' }, output: { extent: 'complete', imageVersionId: 'output', reason: 'Complete fruit.' }, task: { result: 'satisfied', reason: 'Same food subject.' } },
    actualLayout: { imageVersionId: 'output', regions: [{ entityId: 'fruit', name: 'Fruit', role: 'subject', scope: 'core', rect: objects[0]!.rect }] },
  })
}

test('companion safety overflow cannot be relabelled as composition, integrity or fidelity failure', async () => {
  const results: Record<string, boolean | string> = {}
  results.companionOutside = wallpaperVerdict(applyWallpaperSourceReview(schema.parse(review()), true, settings))
  for (const field of ['composition', 'subject', 'task', 'outputExtent', 'sourceCorrespondence', 'sourceRepair'] as const) {
    const raw = review(), failure = { result: 'violated' as const, reason: 'Only the companion bowl crosses the inner safe area.' }
    if (field === 'task') raw.subjectIntegrity.task = failure
    else if (field === 'outputExtent') raw.subjectIntegrity.output.extent = 'cut-off'
    else if (field === 'sourceCorrespondence' || field === 'sourceRepair') raw[field] = failure
    else raw.checks[field] = failure
    results[field] = schema.safeParse(raw).success
    results[`stored-${field}`] = savedRework(raw)
  }
  const disguised = review()
  disguised.checks.composition = { result: 'violated', reason: 'Companion beyond inner guide.' }
  disguised.issues = [{ kind: 'layout', check: 'composition', code: 'other', reason: 'Companion beyond inner guide.', evidence: { kind: 'safe-area-overflow', entityIds: ['bowl'], imageVersionId: 'output', outputRect: objects[1]!.rect } }]
  results.disguisedLayout = schema.safeParse(disguised).success
  const integrity = review()
  integrity.subjectIntegrity.task = { result: 'violated', reason: 'The bowl is outside.' }
  integrity.issues = [{ ...disguised.issues[0]!, check: 'subject' }]
  results.disguisedIntegrity = schema.safeParse(integrity).success
  const content = review()
  content.sourceCorrespondence = { result: 'violated', reason: 'The healthy wood bowl was visibly deformed.' }
  content.issues = [{ kind: 'preservation', check: 'sourceCorrespondence', code: 'other', reason: content.sourceCorrespondence.reason, evidence: { kind: 'distorted-structure', entityIds: ['bowl'], imageVersionId: 'output', sourceRect: objects[1]!.rect, outputRect: objects[1]!.rect } }]
  const effective = applyWallpaperSourceReview(schema.parse(content), true, settings)
  results.realCompanionDamage = wallpaperVerdict(effective)
  results.groundedContentRework = savedRework(content)
  results.independentSubject = effective.checks.subject.result
  const layout = review()
  layout.actualLayout.regions[0]!.rect = { x: 0.85, y: 0.4, width: 0.14, height: 0.2 }
  layout.checks.protection = { result: 'violated', reason: 'Primary fruit crosses the safe right edge.' }
  layout.issues = [{ kind: 'layout', check: 'protection', code: 'other', reason: layout.checks.protection.reason, evidence: { kind: 'safe-area-overflow', entityIds: ['fruit'], imageVersionId: 'output', outputRect: layout.actualLayout.regions[0]!.rect } }]
  results.realPrimaryOutside = wallpaperVerdict(applyWallpaperSourceReview(schema.parse(layout), true, settings))
  results.hostGeometryRework = savedRework(layout)
  const truncated = review()
  truncated.subjectIntegrity.output.extent = 'cut-off'
  truncated.checks.subject = { result: 'violated', reason: 'Fruit is cut by the actual right frame.' }
  truncated.actualLayout.regions[0]!.rect = { x: 0.9, y: 0.4, width: 0.1, height: 0.2 }
  truncated.issues = [{ kind: 'preservation', check: 'subject', code: 'other', reason: truncated.checks.subject.reason, evidence: { kind: 'frame-truncation', entityIds: ['fruit'], imageVersionId: 'output', outputRect: truncated.actualLayout.regions[0]!.rect } }]
  results.realFrameTruncation = wallpaperVerdict(applyWallpaperSourceReview(schema.parse(truncated), true, settings))
  truncated.issues[0]!.evidence!.outputRect = objects[0]!.rect
  results.innerGuideIsNotFrame = schema.safeParse(truncated).success
  content.issues[0]!.kind = 'layout'
  results.contentCannotHideAsLayout = schema.safeParse(content).success
  assert.deepEqual(results, JSON.parse(await readFile(new URL('./fixtures/wallpaper-review-evidence.expected.json', import.meta.url), 'utf8')))
})

test('a genuine companion repair failure still rejects the image without becoming protected-subject damage', () => {
  const raw = review()
  raw.sourceRepair = { result: 'violated', reason: 'The bowl has an unsupported flat cut inside the output.' }
  raw.issues = [{ kind: 'preservation', check: 'sourceRepair', code: 'other', reason: raw.sourceRepair.reason,
    evidence: { kind: 'missing-structure', entityIds: ['bowl'], imageVersionId: 'output', sourceRect: objects[1]!.rect, outputRect: objects[1]!.rect } }]
  const effective = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(schema.parse(raw), true, settings))
  assert.equal(wallpaperVerdict(effective), 'reject')
  assert.equal(effective.checks.subject.result, 'satisfied')
  assert.equal(effective.subjectIntegrity.task.result, 'satisfied')
  assert.equal(effective.sourceRepair.result, 'violated')
  raw.subjectIntegrity.task = { result: 'violated', reason: raw.sourceRepair.reason }
  const unsupported = schema.safeParse(raw)
  assert.equal(unsupported.success, false)
  if (!unsupported.success) assert.ok(unsupported.error.issues.some(issue => issue.path.join('.') === 'subjectIntegrity.task'))
})

test('full-bleed abstract reviews need no invented protected subject and retain independent quality holds', async () => {
  const fixture = z.object({ objects: z.array(wallpaperObjectRoleSchema), review: wallpaperSourceReviewV4Schema }).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-abstract-review.json', import.meta.url), 'utf8')))
  const sourceId = fixture.review.subjectIntegrity.source.imageVersionId, outputId = fixture.review.actualLayout.imageVersionId
  const scoped = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], [sourceId, outputId], outputId, sourceId, true, fixture.objects)
  const verdict = (raw: typeof fixture.review) => wallpaperVerdict(applyWallpaperNoClockRequirement(wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(scoped.parse(raw), true, settings))))
  assert.equal(verdict(fixture.review), 'pass')
  for (const mode of ['scene', 'single', 'group', 'uncertain'] as const) {
    const raw = structuredClone(fixture.review)
    raw.subjectIntegrity.mode = mode
    assert.equal(verdict(raw), mode === 'scene' ? 'pass' : 'reject')
  }
  const primary = wallpaperObjectRoleSchema.parse({ entityId: 'declared-primary', name: 'Declared subject', role: 'primary', evidence: 'The task requires this object.', rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, sourceEdges: [] })
  const missing = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], [sourceId, outputId], outputId, sourceId, true, [...fixture.objects, primary])
  assert.equal(missing.safeParse(fixture.review).success, false)
  const unknown = structuredClone(fixture.review)
  unknown.checks.clarity = { result: 'unknown', reason: 'The paper texture cannot be assessed.' }
  assert.equal(verdict(unknown), 'needs-review')
  const damaged = structuredClone(fixture.review)
  damaged.checks.background = { result: 'violated', reason: 'A rectangular patch interrupts the paper texture.' }
  damaged.issues = [{ kind: 'background', check: 'background', code: 'other', reason: damaged.checks.background.reason,
    evidence: { kind: 'background-artifact', entityIds: [], imageVersionId: outputId, outputRect: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 } } }]
  assert.equal(verdict(damaged), 'reject')
})

test('task-specific review failures retain the model response and field paths at the provider receiver', async () => {
  const raw = review()
  delete raw.actualLayout.regions[0]!.entityId
  const pixels = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#427141' } }).png().toBuffer()
  let calls = 0
  const provider = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/review', model: 'isolated', supportsMultiImage: true, maxImages: 10, maxImageBytes: 65536, maxRequestBytes: 1048576, maxOutputTokens: 4096, temperature: 0 }, { request: async () => {
    calls++
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(raw) }, finish_reason: 'stop' }] })) }
  } })
  const input: VisionInput = { requestId: 'same-native-review', taskBrief: 'Review the saved candidate.', rules: [], wallpaperPrompt: { version: 'wallpaper-review-source-v4', text: 'Use the frozen fruit and bowl roles.' }, wallpaperOutputSchema: schema,
    images: ['source', 'output'].map((imageVersionId, i) => ({ imageVersionId, role: i ? 'actual-wallpaper' : 'wallpaper-original', bytes: pixels, digest: createHash('sha256').update(pixels).digest('hex'), mime: 'image/png' })) }
  const protocol = JSON.parse(provider.describeRequest(input, 'wallpaper-review').inputText).outputSchema
  const transmitted = z.fromJSONSchema(protocol)
  assert.equal(transmitted.safeParse(review()).success, true)
  const companionRegion = review()
  companionRegion.actualLayout.regions[0]!.entityId = 'bowl'
  assert.equal(transmitted.safeParse(companionRegion).success, false)
  const missingEntity = JSON.parse(JSON.stringify(review()))
  delete missingEntity.actualLayout.regions[0].entityId
  assert.equal(transmitted.safeParse(missingEntity).success, false)
  await assert.rejects(provider.wallpaper(input, 'wallpaper-review', { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 0 }, schema), error => {
    assert.ok(error instanceof MediaError)
    assert.equal(safeFailure(error).code, 'vision-invalid-output')
    assert.equal(error.retryable, true)
    assert.deepEqual(error.diagnostics?.modelOutput, raw)
    assert.ok(error.diagnostics?.issues.some(path => path.includes('actualLayout.regions.0.entityId')))
    return true
  })
  assert.equal(calls, 1, 'The task owner, not the receiver, owns any bounded retry')
})
