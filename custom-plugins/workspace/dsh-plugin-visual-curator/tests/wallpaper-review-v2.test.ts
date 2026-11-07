/** Frozen review protocols retain old request bytes and compute V2 style coverage on actual final pixels. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { z } from 'zod'
import { CompatibleVisionProvider, type VisionInput } from '../src/media/index.ts'
import { wallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperReviewKeys, wallpaperReviewSchema, wallpaperReviewOutputSchema, wallpaperSettingsSchema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { applyWallpaperStyleReview, wallpaperReviewVersion, wallpaperStylePolicy } from '../src/host/wallpaper-review.ts'
import { serviceFixture } from './helpers/service-fixture.ts'

const baseReview = () => wallpaperReviewSchema.parse({ subject: 'Final red source vehicle.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'style' ? 'violated' : 'satisfied', reason: 'Actual final pixels.' }])), issues: [{ kind: 'style', reason: 'The preferred palette is not present.' }] })

test('V1 wallpaper request descriptor remains byte-identical to its saved pre-change request', async () => {
  const pixels = Buffer.from('saved-wallpaper-fixture'), { backgroundContextPixels: _context, ...settings } = wallpaperSettingsSchema.parse({})
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
