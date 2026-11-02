import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recipeSchema, referenceSnapshotSchema, ruleSchema, type ModelProfile, type ReferenceSnapshot, type Rule } from '../src/shared/model.ts'
import { effectiveReviewReferenceRole, selectReviewReferences } from '../src/host/review-references.ts'

const base = { schemaVersion: 1, profileId: 'isolated-reference-test', createdAt: '2026-01-01T00:00:00.000Z' }

function reference(id: string, role: ReferenceSnapshot['reference']['role'] = 'positive', imageDigest = `pixels-${id}`): ReferenceSnapshot {
  return referenceSnapshotSchema.parse({ reference: { ...base, id, kind: 'reference', styleId: 'style', imageVersionId: `image-${id}`, role, intent: { kind: 'overall' }, context: {}, feedbackThreadIds: [] }, imageDigest, familyId: `family-${id}`, feedbackIds: [] })
}
function rule(id: string, supportRefs: string[], counterRefs: string[] = [], strength: Rule['strength'] = 'preferred'): Rule {
  return ruleSchema.parse({ ruleId: id, dimension: 'composition', statement: id, condition: {}, strength, stage: 'final', check: { kind: 'visual', criterion: id }, exceptions: [], supportRefs, counterRefs, confirmation: { status: 'suggested' } })
}
function standard(references: ReferenceSnapshot[], rules: Rule[], maxImages = 4, maxBytes = 100): Parameters<typeof selectReviewReferences>[0] {
  return { references, rules, recipe: recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'vision', model: 'offline', vendorVersion: null, promptVersion: 'test', outputSchemaVersion: '1', preprocessingVersion: 'test', referenceStrategy: { maxImages, maxBytes }, preferenceScale: { min: 0, max: 1, weights: { composition: 1 } }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' }) }
}
function option(rule: Rule, groupId: string | null, enabled = true): ModelProfile['options'][number] {
  return { rule, groupId, enabled, selectionSource: 'model', sourceStatement: rule.statement, reason: 'consistent' }
}
const ids = (references: ReferenceSnapshot[]) => references.map(snapshot => snapshot.reference.imageVersionId)

test('review pixels cover enabled alternatives and shared evidence before adding one relevant contrast', () => {
  const a = reference('10-shared-a'), duplicateA = reference('11-duplicate-a', 'positive', a.imageDigest)
  const b = reference('30-b'), c = reference('40-c'), inactive = reference('00-inactive'), negative = reference('90-negative', 'negative')
  const shared = rule('shared', [a.reference.id], [negative.reference.id], 'required')
  const aRule = rule('a', [a.reference.id, duplicateA.reference.id]), bRule = rule('b', [b.reference.id]), cRule = rule('c', [c.reference.id]), disabled = rule('disabled', [inactive.reference.id])
  const input = { ...standard([inactive, duplicateA, c, b, negative, a], [shared, aRule, bRule, cRule]), options: [option(shared, null), option(aRule, 'a'), option(bRule, 'b'), option(cRule, 'c'), option(disabled, 'disabled', false)], groups: [
    { groupId: 'a', name: '', description: '', imageVersionIds: [a.reference.imageVersionId, duplicateA.reference.imageVersionId] },
    { groupId: 'b', name: '', description: '', imageVersionIds: [b.reference.imageVersionId] },
    { groupId: 'c', name: '', description: '', imageVersionIds: [c.reference.imageVersionId] },
    { groupId: 'disabled', name: '', description: '', imageVersionIds: [inactive.reference.imageVersionId] },
  ] }
  const original = structuredClone(input)
  const selected = selectReviewReferences(input, () => 1)
  assert.deepEqual(ids(selected), ['image-10-shared-a', 'image-30-b', 'image-40-c', 'image-90-negative'])
  assert.deepEqual(selected.map(snapshot => snapshot.imageDigest), [a.imageDigest, b.imageDigest, c.imageDigest, negative.imageDigest])
  assert.deepEqual(ids(selectReviewReferences({ ...input, references: [...input.references].reverse(), options: [...input.options].reverse(), groups: [...input.groups].reverse(), rules: [...input.rules].reverse() }, () => 1)), ids(selected))
  assert.deepEqual(input, original)
})

test('one-image reviews retain a positive anchor even when a contrast sorts first', () => {
  const negative = reference('00-negative', 'negative'), positive = reference('99-positive')
  const input = standard([negative, positive], [rule('subject', [positive.reference.id], [negative.reference.id], 'required')], 1)
  assert.deepEqual(ids(selectReviewReferences(input, () => 1)), ['image-99-positive'])
})

test('oversized references are skipped and fitting pixel bytes may exactly consume the saved limit', () => {
  const large = reference('00-large'), fit = reference('20-fit'), other = reference('30-other'), negative = reference('90-negative', 'negative')
  const input = standard([large, fit, other, negative], [rule('shared', [large.reference.id, fit.reference.id], [negative.reference.id])], 4, 3)
  const sizes = new Map([[large.reference.id, 4], [fit.reference.id, 2], [other.reference.id, 2], [negative.reference.id, 1]])
  const selected = selectReviewReferences(input, snapshot => sizes.get(snapshot.reference.id)!)
  assert.deepEqual(ids(selected), ['image-20-fit', 'image-90-negative'])
  assert.equal(selected.reduce((sum, snapshot) => sum + sizes.get(snapshot.reference.id)!, 0), 3)
  assert.deepEqual(selectReviewReferences(standard([large], input.rules, 4, 3), snapshot => sizes.get(snapshot.reference.id)!), [])
})

test('release references without profile groups use rule evidence and deterministic image identities', () => {
  const anchor = reference('z-anchor'), extra = reference('a-extra'), negative = reference('00-negative', 'negative')
  const duplicatePixels = reference('b-same-pixels', 'positive', anchor.imageDigest)
  const repeatedImage = { ...reference('c-same-image'), reference: { ...extra.reference, id: reference('c-same-image').reference.id } }
  const input = standard([negative, duplicatePixels, extra, repeatedImage, anchor], [rule('required', [anchor.reference.id], [negative.reference.id], 'required')], 4)
  assert.deepEqual(ids(selectReviewReferences(input, () => 1)), ['image-z-anchor', 'image-a-extra', 'image-00-negative'])
})

test('effective negative judgments replace historical positive intent and mixed judgments stay undecided', () => {
  const anchor = reference('z-anchor'), positive = reference('y-positive')
  const revised = { ...reference('00-revised'), judgments: [{ feedbackId: 'revised', value: 'reject' as const }] }
  const mixed = { ...reference('01-mixed'), judgments: [{ feedbackId: 'accept', value: 'accept' as const }, { feedbackId: 'reject', value: 'reject' as const }] }
  const input = standard([mixed, revised, positive, anchor], [rule('active', [anchor.reference.id], [revised.reference.id])], 3)
  assert.deepEqual(ids(selectReviewReferences(input, () => 1)), ['image-z-anchor', 'image-y-positive', 'image-00-revised'])
  assert.equal(effectiveReviewReferenceRole(input, revised), 'negative')
  assert.equal(revised.reference.role, 'positive')
  assert.equal(effectiveReviewReferenceRole(input, mixed), 'undecided')
  const accepted = { ...reference('accepted', 'negative'), judgments: [{ feedbackId: 'accepted', value: 'accept' as const }] }
  assert.equal(effectiveReviewReferenceRole(input, accepted), 'positive')
  const unknown = { ...anchor, judgments: [{ feedbackId: 'unknown', value: 'unknown' as const }] }
  assert.equal(effectiveReviewReferenceRole(input, unknown), 'undecided')
})

test('unrelated dimension judgments do not replace the current reference intent', () => {
  const snapshot = { ...reference('positive'), judgments: [{ feedbackId: 'unrelated', dimension: 'color' as const, value: 'reject' as const }] }
  const negative = reference('negative', 'negative')
  const input = standard([negative, snapshot], [rule('composition', [snapshot.reference.id])], 1)
  assert.deepEqual(ids(selectReviewReferences(input, () => 1)), ['image-positive'])
  assert.equal(effectiveReviewReferenceRole(input, snapshot), 'positive')
  const disabled = { ...rule('disabled', []), dimension: 'color' as const }
  assert.equal(effectiveReviewReferenceRole({ rules: [...input.rules, disabled], options: [option(disabled, 'off', false)] }, snapshot), 'positive')
  assert.equal(effectiveReviewReferenceRole({ rules: [...input.rules, { ...disabled, strength: 'reference-only' }] }, snapshot), 'positive')
  assert.equal(effectiveReviewReferenceRole({ rules: [...input.rules, { ...disabled, check: { kind: 'measured', field: 'width', unit: 'pixels', tolerance: 0 } }] }, snapshot), 'positive')
  assert.equal(effectiveReviewReferenceRole({ rules: [...input.rules, disabled] }, snapshot), 'negative')
})

test('disabled-only evidence cannot occupy spare slots and active shared evidence remains eligible', () => {
  const disabled = reference('00-disabled'), shared = reference('10-shared')
  const inactiveRule = rule('inactive', [disabled.reference.id, shared.reference.id]), activeRule = rule('active', [shared.reference.id])
  const input = { ...standard([disabled, shared], [activeRule]), options: [option(inactiveRule, 'off', false), option(activeRule, null)], groups: [{ groupId: 'off', name: '', description: '', imageVersionIds: [disabled.reference.imageVersionId, shared.reference.imageVersionId] }] }
  assert.deepEqual(ids(selectReviewReferences(input, () => 1)), ['image-10-shared'])
})

test('empty references, remote byte metadata and locale-independent ties remain deterministic', () => {
  assert.deepEqual(selectReviewReferences(standard([], []), () => 0), [])
  const lower = reference('a'), upper = reference('B')
  assert.deepEqual(ids(selectReviewReferences(standard([lower, upper], [], 2, 1), () => 0)), ['image-B', 'image-a'])
  const negativeA = reference('negative-a', 'negative'), negativeB = reference('negative-b', 'negative')
  assert.deepEqual(ids(selectReviewReferences(standard([negativeB, negativeA], [], 4), () => 0)), ['image-negative-a'])
})
