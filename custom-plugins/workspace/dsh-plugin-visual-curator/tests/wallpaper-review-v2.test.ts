/** Frozen review protocols retain old request bytes and compute V2 style coverage on actual final pixels. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { z } from 'zod'
import { CompatibleVisionProvider, type VisionInput } from '../src/media/index.ts'
import { wallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperReviewKeys, wallpaperReviewSchema, wallpaperReviewOutputSchema, wallpaperSourceReviewV2Schema, wallpaperSourceReviewV4Schema, wallpaperStoredSourceReviewV4Schema, wallpaperSettingsSchema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { applyWallpaperSourceReview, applyWallpaperSourceSeams, applyWallpaperStyleReview, wallpaperReviewVersion, wallpaperStylePolicy, wallpaperCriticalReviewTargets, wallpaperCriticalReviewFocus, wallpaperCriticalReviewHistory, applyWallpaperCriticalDetail } from '../src/host/wallpaper-review.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const baseReview = () => wallpaperReviewSchema.parse({ subject: 'Final red source vehicle.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'style' ? 'violated' : 'satisfied', reason: 'Actual final pixels.' }])), issues: [{ kind: 'style', reason: 'The preferred palette is not present.' }] })

test('Desktop source review rejects an undeclared clarity issue and preserves rejection under the existing categories', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/wallpaper-review-desktop-source-v2.json', import.meta.url), 'utf8'))
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v2', [], fixture.imageIds, fixture.outputId, fixture.sourceId)
  assert.equal(schema.safeParse(fixture.output).success, false)
  const categorized = { ...fixture.output, issues: fixture.output.issues.map((issue: { kind: string; reason: string }) => issue.kind === 'clarity' ? { ...issue, kind: 'preservation' } : issue) }
  const review = wallpaperSourceReviewV2Schema.parse(schema.parse(categorized))
  assert.equal(review.checks.clarity.result, 'violated')
  assert.deepEqual(review.checks, fixture.output.checks)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(review, true)), 'reject')
  const actual = fixture.acceptedEvidence
  const actualSchema = wallpaperReviewOutputSchema('wallpaper-review-source-v2', [], actual.imageIds, fixture.outputId, fixture.sourceId)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(actualSchema.parse(actual.output), true)), 'reject')
  assert.equal(actual.output.subjectIntegrity.source.extent, 'cut-off')
})

test('V1 wallpaper request descriptor remains byte-identical to its saved pre-change request', async () => {
  const pixels = Buffer.from('saved-wallpaper-fixture'), { backgroundContextPixels: _context, ...settings } = wallpaperSettingsSchema.parse({ concurrency: 2, maxReworks: 2, maxEditsPerImage: 2 })
  const provider = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/chat', model: 'fixture', supportsMultiImage: true, maxImages: 10, maxImageBytes: 1000000, maxRequestBytes: 10000000, maxOutputTokens: 4000, temperature: 0, declaredModelVersion: 'fixture-v1' }, { request: async () => { throw new Error('No network expected') } })
  const input: VisionInput = { requestId: 'legacy-wallpaper-review', taskBrief: 'Review actual wallpaper pixels using the frozen template.', rules: [{ ruleId: 'palette', statement: 'Prefer muted colors.', dimension: 'color', strength: 'preferred', stage: 'final' }, { ruleId: 'preserve', statement: 'Preserve the source subject.', dimension: 'subject', strength: 'required', stage: 'source' }], images: [{ imageVersionId: 'final', digest: createHash('sha256').update(pixels).digest('hex'), mime: 'image/png', role: 'actual-wallpaper', bytes: pixels }], wallpaperPrompt: { version: 'wallpaper-review-v1', text: wallpaperPrompts['wallpaper-review'] }, usage: { settings, measured: { width: 1845, height: 3280, protectedSourceRegions: true, backgroundTransitionPixels: 192 } } }
  assert.equal(`${JSON.stringify(provider.describeRequest(input, 'wallpaper-review'), null, 2)}\n`, await readFile(new URL('./fixtures/wallpaper-review-v1-request.expected.json', import.meta.url), 'utf8'))
})

test('V2 rejects missing, duplicate, foreign and non-final style evidence before acceptance', () => {
  const schema = wallpaperReviewOutputSchema('wallpaper-review-v2', ['palette', 'light'], ['final', 'source'], 'final')
  const row = { ruleId: 'palette', result: 'satisfied', reason: 'Visible final pixels.', evidenceImageVersionIds: ['final'] }
  const valid = { ...baseReview(), styleResults: [row, { ...row, ruleId: 'light' }] }
  assert.equal(schema.safeParse(valid).success, true)
  for (const rows of [[row], [row, row], [row, { ...row, ruleId: 'foreign' }], [row, { ...row, ruleId: 'light', evidenceImageVersionIds: ['source'] }], [row, { ...row, ruleId: 'light', evidenceImageVersionIds: ['final', 'foreign'] }]]) assert.equal(schema.safeParse({ ...valid, styleResults: rows }).success, false)
})

test('V2 declares seven explicit result objects and rejects the observed native string-check response', () => {
  const schema = wallpaperReviewOutputSchema('wallpaper-review-v2', ['palette'], ['final'], 'final')
  const wire = z.toJSONSchema(schema, { unrepresentable: 'any' })
  const checks = z.object({ properties: z.object({ checks: z.object({ properties: z.record(z.string(), z.object({ type: z.string(), required: z.array(z.string()) })), required: z.array(z.string()), additionalProperties: z.literal(false) }) }) }).parse(wire).properties.checks
  assert.deepEqual(Object.keys(checks.properties), [...wallpaperReviewKeys]); assert.deepEqual(checks.required, [...wallpaperReviewKeys])
  for (const row of Object.values(checks.properties)) { assert.equal(row.type, 'object'); assert.deepEqual(row.required, ['result', 'reason']) }
  const styleResults = [{ ruleId: 'palette', result: 'violated', reason: 'Observed final source colors.', evidenceImageVersionIds: ['final'] }]
  const observed = { ...baseReview(), checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, 'satisfied：实际成品中的可观察依据。'])), styleResults }
  const rejected = schema.safeParse(observed)
  assert.equal(rejected.success, false)
  if (!rejected.success) assert.deepEqual(rejected.error.issues.map(issue => issue.path.join('.')), wallpaperReviewKeys.map(key => `checks.${key}`))
  assert.equal(schema.safeParse({ ...baseReview(), styleResults }).success, true)
})

test('V2 scoped activity ignores unrelated saved pending stages and retains their historical totals', async () => {
  const { wallpaperProgress, wallpaperStateSchema } = await import('../src/shared/wallpaper.ts')
  const state = wallpaperStateSchema.parse({ version: 1, sourceRunId: 'source', skillVersion: 'skill', items: [{ imageVersionId: 'target', familyId: 'a', status: 'reviewing' }, { imageVersionId: 'old-rendering', familyId: 'b', status: 'rendering' }, { imageVersionId: 'queued', familyId: 'c', status: 'queued' }] })
  const counts = wallpaperProgress(state, 'target')
  assert.equal(counts.reviewing, 1); assert.equal(counts.rendering, 0); assert.equal(counts.queued, 1); assert.equal(wallpaperProgress(state).rendering, 1)
})

test('V2 uses frozen weights, required rules and alternative groups while retaining all non-style failures', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 's', name: 'Frozen review policy' }))
    await f.action('reference-import', { operationId: 'i', styleId: style.id, expectedRevision: 1, files: [{ name: 'r.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'a', styleId: style.id, buildDataset: true }); await f.jobs.drain()
    const original = f.repository.list('modelProfile')[0]!, template = original.rules[0]!, option = original.options[0]!
    const dimensions = ['color', 'lighting', 'composition', 'subject'] as const
    const rules = dimensions.map(dimension => ({ ...template, ruleId: dimension, dimension, strength: 'preferred' as const }))
    const profile = { ...original, rules, groups: [], options: rules.map(rule => ({ ...option, rule, groupId: null })), recipe: { ...original.recipe, styleMatching: { version: 2 as const, minSatisfiedRatio: 0.75 }, preferenceScale: { ...original.recipe.preferenceScale, weights: Object.fromEntries(dimensions.map(dimension => [dimension, 0.25])) } } }
    const results = rules.map(rule => ({ ruleId: rule.ruleId, result: rule.dimension === 'color' ? 'violated' : 'satisfied', reason: 'Evidence in final wallpaper.', evidenceImageVersionIds: ['final'] }))
    const effective = applyWallpaperStyleReview({ ...baseReview(), styleResults: results }, profile, 'wallpaper-review-v2')
    assert.ok('styleMatch' in effective); assert.equal(effective.styleMatch.verdict, 'matched'); assert.equal(effective.styleMatch.satisfiedWeightRatio, 0.75)
    assert.equal(effective.modelStyleCheck.result, 'violated'); assert.deepEqual(effective.issues, []); assert.equal(wallpaperVerdict(effective), 'pass')
    const background = applyWallpaperStyleReview({ ...baseReview(), issues: [{ kind: 'style', reason: 'Palette.' }, { kind: 'background', reason: 'Visible seam.' }], styleResults: results }, profile, 'wallpaper-review-v2')
    assert.deepEqual(background.issues.map(issue => issue.kind), ['background']); assert.equal(wallpaperVerdict(background), 'needs-review')
    const required = { ...profile, rules: rules.map(rule => rule.dimension === 'color' ? { ...rule, strength: 'required' as const } : rule) }
    assert.equal(applyWallpaperStyleReview({ ...baseReview(), styleResults: results }, required, 'wallpaper-review-v2').checks.style.result, 'violated')
    const unknown = results.map(row => row.ruleId === 'color' ? { ...row, result: 'unknown' } : row)
    assert.equal(applyWallpaperStyleReview({ ...baseReview(), styleResults: unknown }, profile, 'wallpaper-review-v2').checks.style.result, 'unknown')
    assert.equal(applyWallpaperStyleReview({ ...baseReview(), styleResults: results }, { ...profile, recipe: { ...profile.recipe, preferenceScale: { ...profile.recipe.preferenceScale, weights: {} } } }, 'wallpaper-review-v2').checks.style.result, 'unknown')
    const grouped = { ...profile, options: profile.options.map((entry, i) => ({ ...entry, groupId: i === 0 ? 'red' : 'muted' })), groups: [{ groupId: 'red', name: 'Red', description: '', imageVersionIds: [] }, { groupId: 'muted', name: 'Muted', description: '', imageVersionIds: [] }] }
    assert.equal(applyWallpaperStyleReview({ ...baseReview(), styleResults: results }, grouped, 'wallpaper-review-v2').checks.style.result, 'satisfied')
    const { styleMatching: _matching, ...legacyRecipe } = profile.recipe
    const legacy = { ...profile, recipe: legacyRecipe }
    assert.equal(wallpaperReviewVersion(legacy), 'wallpaper-review-v1'); assert.throws(() => wallpaperStylePolicy(legacy), { code: 'constraint-conflict' })
    assert.deepEqual(applyWallpaperStyleReview(baseReview(), legacy, 'wallpaper-review-v1'), baseReview())
    const policy = z.object({ minSatisfiedRatio: z.number(), weights: z.record(z.string(), z.number()) }).parse(wallpaperStylePolicy(profile))
    assert.equal(policy.minSatisfiedRatio, 0.75); assert.equal(policy.weights.color, 0.25)
  } finally { await f.cleanup() }
})

test('complete-canvas review checks actual output regions and source structure after a uniform reframing', () => {
  const review = { reviewVersion: 'wallpaper-review-source-v3', subject: 'Same plant group', checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: 'satisfied', reason: 'Actual pixels' }])), issues: [], styleResults: [], sourceRepair: { result: 'satisfied', reason: 'Natural authorized edge continuation' }, subjectIntegrity: { mode: 'group', source: { extent: 'cut-off', reason: 'Source edge', imageVersionId: 'original' }, output: { extent: 'complete', reason: 'Full plant group', imageVersionId: 'final' }, task: { result: 'satisfied', reason: 'Same group after uniform scaling' } }, actualLayout: { imageVersionId: 'final', regions: [{ name: 'Whole group', role: 'subject', rect: { x: 0.22, y: 0.45, width: 0.56, height: 0.32 } }, { name: 'Flower', role: 'critical', rect: { x: 0.4, y: 0.48, width: 0.1, height: 0.1 } }] }, sourceCorrespondence: { result: 'satisfied', reason: 'Object identity, count, relative positions and visible structures match after whole-group scale and translation.' } }
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v3', [], ['original', 'final'], 'final', 'original')
  assert.equal(schema.safeParse(review).success, true)
  const settings = wallpaperSettingsSchema.parse({})
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(review, true, settings)), 'pass')
  const outside = structuredClone(review); outside.actualLayout.regions[1]!.rect.x = 0.01
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(outside, true, settings)), 'reject')
  const deformed = structuredClone(review); deformed.sourceCorrespondence = { result: 'violated', reason: 'One existing leaf changed shape independently of the global transform' }
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(deformed, true, settings)), 'reject')
  const uncertain = structuredClone(review); uncertain.sourceCorrespondence = { result: 'unknown', reason: 'A visible structure cannot be verified' }
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(uncertain, true, settings)), 'needs-review')
  const wrong = structuredClone(review); wrong.actualLayout.imageVersionId = 'simulation'
  assert.equal(schema.safeParse(wrong).success, false)
})

function balancedReview() {
  return wallpaperSourceReviewV4Schema.parse({ reviewVersion: 'wallpaper-review-source-v4', subject: 'Same plant group', checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: key === 'protection' ? 'violated' : 'satisfied', reason: key === 'protection' ? 'One small leaf is beyond the safe area' : 'Actual pixels' }])),
    issues: [{ kind: 'layout', check: 'protection', code: 'minor-peripheral-overflow', reason: 'One small outer leaf is beyond the safe area' }], styleResults: [], sourceRepair: { result: 'satisfied', reason: 'No source repair needed' },
    subjectIntegrity: { mode: 'group', source: { extent: 'complete', reason: 'Whole original', imageVersionId: 'original' }, output: { extent: 'complete', reason: 'Whole output', imageVersionId: 'final' }, task: { result: 'satisfied', reason: 'Same subjects' } },
    actualLayout: { imageVersionId: 'final', regions: [{ name: 'Main group', role: 'subject', scope: 'core', rect: { x: 0.22, y: 0.45, width: 0.56, height: 0.32 } }, { name: 'Flower', role: 'critical', scope: 'core', rect: { x: 0.4, y: 0.48, width: 0.1, height: 0.1 } }, { name: 'Outer leaf', role: 'subject', scope: 'peripheral', rect: { x: 0.03, y: 0.55, width: 0.03, height: 0.05 } }] },
    sourceCorrespondence: { result: 'satisfied', reason: 'Original structure retained' } })
}

test('small peripheral leaves warn, while substantial or core overflow and other quality failures still block', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: {} }), wire = balancedReview()
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], ['original', 'final'], 'final', 'original')
  assert.equal(schema.safeParse(wire).success, true)
  const accepted = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(wire, false, settings))
  assert.equal(wallpaperVerdict(accepted), 'pass')
  assert.equal(accepted.checks.protection.result, 'satisfied')
  assert.equal(accepted.modelProtectionCheck.result, 'violated')
  assert.equal(accepted.layoutWarnings.length, 1)
  assert.equal(accepted.issues.length, 0)
  const major = structuredClone(wire); major.actualLayout.regions[2]!.rect = { x: 0.03, y: 0.55, width: 0.3, height: 0.3 }
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(major, false, settings)), 'reject')
  const core = structuredClone(wire); core.actualLayout.regions[1]!.rect.x = 0.01
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(core, false, settings)), 'reject')
  const clock = structuredClone(wire); clock.actualLayout.regions[2]!.rect.y = 0.25
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(clock, false, settings)), 'reject')
  const changed = structuredClone(wire); changed.sourceCorrespondence = { result: 'violated', reason: 'Flower structure changed' }
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(changed, false, settings)), 'reject')
  const other = structuredClone(wire); other.issues.push({ kind: 'preservation', check: 'subject', code: 'other', reason: 'Flower was redrawn' })
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(other, false, settings)), 'needs-review')
  const wrong = structuredClone(wire); wrong.actualLayout.imageVersionId = 'simulation'
  assert.equal(schema.safeParse(wrong).success, false)
})

test('scene review accepts independently complete objects while retaining core protection and excluding background anchors', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: {}, repairPolicy: {} }), wire = balancedReview()
  wire.subjectIntegrity.mode = 'scene'
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v4', [], ['original', 'final'], 'final', 'original', true)
  assert.ok(schema.safeParse(wire).success)
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(wire, true, settings)), 'pass')
  const wholeObject = structuredClone(wire)
  wholeObject.actualLayout.regions = wholeObject.actualLayout.regions.filter(region => region.role === 'subject' && region.scope === 'core')
  wholeObject.checks.protection = { result: 'satisfied', reason: 'The entire visible object fits the core area.' }
  wholeObject.issues = wholeObject.issues.filter(issue => issue.check !== 'protection')
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(wholeObject, true, settings)), 'pass', 'The full observed object can carry stricter core protection without a duplicate model rectangle')
  const background = structuredClone(wire)
  background.actualLayout.regions[1]!.role = 'anchor'
  assert.equal(schema.safeParse(background).success, false)
  const contradictoryScope = structuredClone(wire)
  contradictoryScope.actualLayout.regions[1]!.scope = 'peripheral'
  assert.equal(schema.safeParse(contradictoryScope).success, false, 'Contradictory critical/peripheral annotations are a response-format failure, not an image-quality failure')
  const peripheral = structuredClone(wire)
  for (const region of peripheral.actualLayout.regions) region.scope = 'peripheral'
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(peripheral, true, settings)), 'reject')
  const missing = structuredClone(wire)
  missing.subjectIntegrity.output.extent = 'not-applicable'
  assert.notEqual(wallpaperVerdict(applyWallpaperSourceReview(missing, true, settings)), 'pass')
})

test('an actual core subject inside the safe area does not require a clock buffer unless configured', () => {
  const wire = balancedReview()
  wire.checks.protection = { result: 'satisfied', reason: 'Observed core pixels are inside the safe area.' }
  wire.issues = []
  wire.actualLayout.regions = wire.actualLayout.regions.filter(region => region.scope === 'core')
  wire.actualLayout.regions[0]!.rect.y = 0.323
  wire.actualLayout.regions[1]!.rect.y = 0.34
  const settings = wallpaperSettingsSchema.parse({ processing: {}, repairPolicy: {} })
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(wire, true, settings)), 'pass')
  const withClock = wallpaperSettingsSchema.parse({ processing: { clockContrast: {} }, repairPolicy: {} })
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(wire, true, withClock)), 'reject')
  wire.actualLayout.regions[0]!.rect.y = 0.31
  assert.equal(wallpaperVerdict(applyWallpaperSourceReview(wire, true, settings)), 'reject')
})

test('a measured extension seam overrides a model background pass without erasing its source findings', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: {}, repairPolicy: {} })
  const accepted = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(balancedReview(), true, settings))
  assert.equal(wallpaperVerdict(accepted), 'pass')
  const rejected = applyWallpaperSourceSeams(accepted, [{ edge: 'top', from: 0, to: 256, across: 57.8, adjacent: 2.5 }])
  assert.equal(wallpaperVerdict(rejected), 'reject')
  assert.equal(rejected.checks.background.result, 'violated')
  assert.deepEqual(rejected.sourceCorrespondence, accepted.sourceCorrespondence)
  assert.match(rejected.issues.at(-1)!.reason, /重新生成外侧背景/)
})

test('high local review resolves only unknown critical findings and cannot erase earlier definite evidence', () => {
  const settings = wallpaperSettingsSchema.parse({ processing: {} }), wire = balancedReview()
  wire.checks.subject = { result: 'unknown', reason: 'Flower center needs native detail' }
  wire.subjectIntegrity.output = { extent: 'unknown', reason: 'Detail insufficient', imageVersionId: 'final' }
  wire.sourceCorrespondence = { result: 'unknown', reason: 'Flower center uncertain' }
  wire.issues.push({ kind: 'unknown', check: 'subject', code: 'other', reason: 'Flower center uncertain' })
  const initial = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(wire, false, settings))
  assert.deepEqual(wallpaperCriticalReviewTargets(initial), ['subject', 'sourceCorrespondence'])
  assert.equal(wallpaperCriticalReviewFocus(initial), undefined, 'Unlocalized uncertainty does not request another full-frame high review')
  const focused = structuredClone(initial)
  focused.modelIssues[focused.modelIssues.length - 1]!.detail = { sourceRect: { x: 0.3, y: 0.4, width: 0.1, height: 0.1 }, outputRect: { x: 0.4, y: 0.5, width: 0.1, height: 0.1 }, question: 'Is the flower center attached?' }
  assert.ok(wallpaperCriticalReviewFocus(focused))
  focused.modelIssues[focused.modelIssues.length - 1]!.detail!.sourceRect = { x: 0, y: 0, width: 0.9, height: 0.9 }
  assert.equal(wallpaperCriticalReviewFocus(focused), undefined, 'Near-full-frame crops are refused')
  const detailWire = structuredClone(wire)
  detailWire.checks.subject = { result: 'satisfied', reason: 'Native flower detail matches' }
  detailWire.subjectIntegrity.output = { extent: 'complete', reason: 'Complete flower outline', imageVersionId: 'final' }
  detailWire.sourceCorrespondence = { result: 'satisfied', reason: 'Native structures correspond' }
  detailWire.issues = detailWire.issues.filter(issue => issue.check !== 'subject')
  const detail = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(detailWire, false, settings))
  const merged = applyWallpaperCriticalDetail(initial, detail, settings, 'review:critical-detail')
  assert.equal(wallpaperVerdict(merged), 'pass')
  assert.deepEqual(merged.criticalDetail?.resolvedChecks, ['subject', 'sourceCorrespondence'])
  assert.equal(merged.modelProtectionCheck.result, 'violated')
  assert.equal(merged.layoutWarnings.length, 1)
  const newlyFailed = structuredClone(detail)
  newlyFailed.checks.background = { result: 'violated', reason: 'A real local seam is visible' }
  newlyFailed.modelIssues.push({ kind: 'background', check: 'background', code: 'other', reason: 'A real local seam is visible' })
  const withFailure = applyWallpaperCriticalDetail(initial, newlyFailed, settings, 'review:new-seam')
  assert.equal(withFailure.checks.background.result, 'violated')
  assert.equal(wallpaperVerdict(withFailure), 'reject')
  const failed = structuredClone(wire); failed.checks.clarity = { result: 'violated', reason: 'Subject detail is blurred' }
  const failedReview = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(failed, false, settings))
  assert.deepEqual(wallpaperCriticalReviewTargets(failedReview), [])
  const cut = structuredClone(wire); cut.subjectIntegrity.source = { extent: 'cut-off', reason: 'Original flower missing', imageVersionId: 'original' }
  const cutReview = wallpaperStoredSourceReviewV4Schema.parse(applyWallpaperSourceReview(cut, false, settings))
  assert.equal(wallpaperVerdict(cutReview), 'reject')
  assert.deepEqual(wallpaperCriticalReviewTargets(cutReview), [])
})

test('unchanged pixels reuse the exact localized question and never request a second high for a different problem', async () => {
  const settings = wallpaperSettingsSchema.parse({ processing: {} })
  const input: Parameters<typeof wallpaperCriticalReviewHistory>[0] = { source: 'same-source-pixels', output: 'same-output-pixels', targets: ['subject'], focus: { sourceRect: { x: 0.3, y: 0.4, width: 0.1, height: 0.1 }, outputRect: { x: 0.4, y: 0.5, width: 0.1, height: 0.1 }, question: 'Is the flower center attached?' } }
  const first = wallpaperCriticalReviewHistory(input, [])
  const prior = wallpaperStoredSourceReviewV4Schema.parse({ ...applyWallpaperSourceReview(balancedReview(), false, settings), criticalDetail: { requestId: 'saved-high', evidenceDigest: first.evidenceDigest, examinedChecks: ['subject'], resolvedChecks: ['subject'] } })
  const sameQuestion = wallpaperCriticalReviewHistory({ ...input, focus: { ...input.focus, question: '  IS THE FLOWER\n center attached?  ' } }, [prior])
  const differentQuestion = wallpaperCriticalReviewHistory({ ...input, focus: { ...input.focus, question: 'Are the stem connections intact?' } }, [prior])
  const differentCrop = wallpaperCriticalReviewHistory({ ...input, focus: { ...input.focus, outputRect: { ...input.focus.outputRect, x: 0.5 } } }, [prior])
  const legacy = structuredClone(prior); delete legacy.criticalDetail!.evidenceDigest
  const legacyUsed = wallpaperCriticalReviewHistory(input, [legacy])
  assert.equal(sameQuestion.cached?.criticalDetail?.requestId, 'saved-high')
  const summary = (value: ReturnType<typeof wallpaperCriticalReviewHistory>) => ({ reuseSaved: !!value.cached, newHigh: value.mayInspect })
  const expected = JSON.parse(await readFile(new URL('./fixtures/wallpaper-critical-reuse.expected.json', import.meta.url), 'utf8'))
  assert.deepEqual({ first: summary(first), sameQuestion: summary(sameQuestion), differentQuestion: summary(differentQuestion), differentCrop: summary(differentCrop), legacyUsed: summary(legacyUsed) }, expected)
})
