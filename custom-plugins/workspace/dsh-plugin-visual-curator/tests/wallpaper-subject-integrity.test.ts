/** Whole-subject evidence vetoes false positive labels independently of protected-box geometry. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { wallpaperSubjectRejection } from '../src/host/wallpaper-review.ts'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import sharp from 'sharp'
import { z } from 'zod'
import { CompatibleVisionProvider, MediaError } from '../src/media/index.ts'
import type { VisionInput } from '../src/media/index.ts'
import { parseModelJson } from '../src/shared/model-json.ts'
import { sourceFaithfulWallpaperPrompts } from '../src/shared/wallpaper-prompts.ts'
import { wallpaperReviewKeys, wallpaperReviewOutputSchema, wallpaperStoredReviewSchema, wallpaperVerdict } from '../src/shared/wallpaper.ts'

const cases = z.array(z.object({ name: z.string(), mode: z.enum(['single', 'group', 'scene', 'abstract', 'uncertain']), source: z.enum(['complete', 'cut-off', 'occluded', 'not-applicable', 'unknown']), output: z.enum(['complete', 'cut-off', 'occluded', 'not-applicable', 'unknown']), task: z.enum(['satisfied', 'violated', 'unknown']), verdict: z.enum(['pass', 'reject', 'needs-review']) })).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-subject-integrity.expected.json', import.meta.url), 'utf8')))
const base = { subject: 'The vehicle front and one wheel are recognizable.', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: 'satisfied', reason: 'A recognizable source detail is preserved.' }])), issues: [] }
const review = (sample = cases[0]!) => ({ ...base, reviewVersion: 'wallpaper-review-v3', styleResults: [], subjectIntegrity: { mode: sample.mode, source: { extent: sample.source, reason: 'Independent observation of the original frame.', imageVersionId: 'source' }, output: { extent: sample.output, reason: 'Independent observation of the actual final frame.', imageVersionId: 'final' }, task: { result: sample.task, reason: 'Check the unchanged whole-vehicle requirement.' } } })

test('V3 refuses cut-off or uncertain subjects even when every model check claims satisfied', () => {
  const schema = wallpaperReviewOutputSchema('wallpaper-review-v3', [], ['final', 'source', 'simulation'], 'final', 'source')
  for (const sample of cases) {
    const validated = schema.parse(review(sample))
    assert.equal(wallpaperVerdict(wallpaperStoredReviewSchema.parse(validated)), sample.verdict, sample.name)
  }
})

test('V3 requires original and actual-output evidence and never accepts a legacy response as new evidence', () => {
  const schema = wallpaperReviewOutputSchema('wallpaper-review-v3', [], ['final', 'source', 'simulation'], 'final', 'source')
  assert.equal(schema.safeParse(base).success, false)
  const valid = review()
  assert.equal(schema.safeParse({ ...valid, subjectIntegrity: { ...valid.subjectIntegrity, task: { ...valid.subjectIntegrity.task, imageVersionId: 'final' } } }).success, false)
  for (const id of ['final', 'simulation', 'foreign']) assert.equal(schema.safeParse({ ...valid, subjectIntegrity: { ...valid.subjectIntegrity, source: { ...valid.subjectIntegrity.source, imageVersionId: id } } }).success, false)
  for (const id of ['source', 'simulation', 'foreign']) assert.equal(schema.safeParse({ ...valid, subjectIntegrity: { ...valid.subjectIntegrity, output: { ...valid.subjectIntegrity.output, imageVersionId: id } } }).success, false)
  assert.throws(() => wallpaperReviewOutputSchema('unrecognized-review', [], ['final', 'source'], 'final', 'source'))
})

test('all-satisfied review text with a JavaScript value or nested task marker remains invalid instead of passing', async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer()
  const digest = createHash('sha256').update(bytes).digest('hex')
  const frozenPrompt = sourceFaithfulWallpaperPrompts().review
  const input: VisionInput = { requestId: 'review-format', taskBrief: 'Review the existing final image.', rules: [], wallpaperPrompt: { ...frozenPrompt }, images: [{ imageVersionId: 'source', role: 'wallpaper-original', digest, mime: 'image/png', bytes }, { imageVersionId: 'final', role: 'actual-wallpaper', digest, mime: 'image/png', bytes }] }
  const output = { ...review(cases.find(sample => sample.verdict === 'pass')!), reviewVersion: 'wallpaper-review-source-v1', checks: { ...base.checks, clarity: { result: 'satisfied', reason: 'Actual subject detail is visible.' } } }
  const javascriptValue = JSON.stringify(output).replace('"task":{', '"task":{"imageVersionIdsForbidden":undefined,')
  const nestedTask = { ...output, subjectIntegrity: { ...output.subjectIntegrity, task: { ...output.subjectIntegrity.task, task: '' } } }
  const provider = (text: string) => new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/v1/chat/completions', model: 'fixture-vision', supportsMultiImage: true, maxImages: 2, maxImageBytes: 65536, maxRequestBytes: 1024 * 1024, maxOutputTokens: 2048, temperature: 0 }, { async request() { return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] })) } } })
  const descriptor = provider(javascriptValue).describeRequest(input, 'wallpaper-review')
  assert.ok(descriptor.instructions.includes('JSON literal values'))
  assert.ok(descriptor.instructions.includes('exactly two fields: result and reason'))
  assert.ok(descriptor.instructions.includes('only fields declared by outputSchema'))
  assert.deepEqual(input.wallpaperPrompt, frozenPrompt)
  assert.throws(() => parseModelJson(javascriptValue), SyntaxError)
  assert.equal(wallpaperSubjectRejection({ rawText: javascriptValue }, 'source', 'final'), undefined)
  const parsedNested = parseModelJson(JSON.stringify(nestedTask))
  const schema = wallpaperReviewOutputSchema('wallpaper-review-source-v1', [], ['source', 'final'], 'final', 'source')
  assert.equal(schema.safeParse(parsedNested).success, false)
  assert.equal(wallpaperSubjectRejection(parsedNested, 'source', 'final'), undefined)
  for (const text of [javascriptValue, JSON.stringify(nestedTask)]) await assert.rejects(provider(text).wallpaper(input, 'wallpaper-review', { maxBytes: 65536, timeoutMs: 5000, maxRedirects: 0 }), (error: unknown) => {
    assert.ok(error instanceof MediaError)
    assert.equal(error.code, 'vision-invalid-output')
    if (text !== javascriptValue) assert.ok(error.diagnostics?.issues.includes('unrecognized_keys:subjectIntegrity.task:task'))
    return true
  })
})

test('V4 adds a required clarity verdict and keeps the same whole-subject veto', () => {
  const schema = wallpaperReviewOutputSchema('wallpaper-review-v4', [], ['final', 'source', 'simulation'], 'final', 'source')
  const valid = { ...review(cases.find(sample => sample.verdict === 'pass')!), reviewVersion: 'wallpaper-review-v4', checks: { ...base.checks, clarity: { result: 'satisfied', reason: 'Actual subject detail is sufficient for the requested use.' } } }
  assert.equal(wallpaperVerdict(wallpaperStoredReviewSchema.parse(schema.parse(valid))), 'pass')
  assert.equal(wallpaperVerdict(wallpaperStoredReviewSchema.parse(schema.parse({ ...valid, checks: { ...valid.checks, clarity: { result: 'violated', reason: 'The actual subject is blurred.' } } }))), 'reject')
  assert.equal(wallpaperVerdict(wallpaperStoredReviewSchema.parse(schema.parse({ ...valid, checks: { ...valid.checks, clarity: { result: 'unknown', reason: 'The original view contains too few pixels.' } } }))), 'needs-review')
  assert.equal(schema.safeParse({ ...valid, checks: base.checks }).success, false)
  assert.equal(wallpaperVerdict(wallpaperStoredReviewSchema.parse(schema.parse({ ...valid, subjectIntegrity: { ...valid.subjectIntegrity, source: { ...valid.subjectIntegrity.source, extent: 'cut-off' } } }))), 'reject')
})

test('legacy reviews remain readable and unchanged instead of rewriting historical judgments', () => {
  const saved = wallpaperStoredReviewSchema.parse(base)
  assert.deepEqual(saved, base)
  assert.equal(wallpaperVerdict(saved), 'pass')
})

test('malformed model conclusions can establish a bound subject rejection but never a passing result', () => {
  const cut = { ...review(), subjectIntegrity: { ...review().subjectIntegrity, source: { ...review().subjectIntegrity.source, extent: 'cut-off' } }, checks: { ...base.checks, subject: { result: 'violated', reason: 'The car is cut off.', imageVersionId: 'final' } }, styleResults: [{ ruleId: 'invented-rule' }] }
  const rejected = wallpaperSubjectRejection(cut, 'source', 'final')!
  assert.equal(wallpaperVerdict(rejected), 'reject'); assert('subjectRejectionOnly' in rejected)
  assert.equal(rejected.checks.style.result, 'unknown'); assert.equal(rejected.checks.background.result, 'unknown')
  assert.equal(wallpaperSubjectRejection(cut, 'foreign-source', 'final'), undefined)
  assert.equal(wallpaperSubjectRejection(cut, 'source', 'foreign-final'), undefined)
  assert.equal(wallpaperSubjectRejection({ ...cut, subjectIntegrity: review().subjectIntegrity }, 'source', 'final'), undefined)
  assert.equal(wallpaperVerdict(wallpaperSubjectRejection({ ...cut, subjectIntegrity: { ...cut.subjectIntegrity, task: { result: 'violated' } } }, 'source', 'final')!), 'reject')
  assert.equal(wallpaperSubjectRejection({ ...cut, subjectIntegrity: { ...cut.subjectIntegrity, source: undefined } }, 'source', 'final'), undefined)
})
