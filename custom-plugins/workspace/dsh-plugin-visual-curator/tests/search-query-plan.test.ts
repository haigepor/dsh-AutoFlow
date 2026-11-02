import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assessmentSchema } from '../src/shared/model.ts'
import { chooseSearchQuery } from '../src/host/search-query-plan.ts'

function assessment(imageId: string, taskRelevance: 'relevant' | 'irrelevant' | 'unknown', subjectFocusVerdict?: 'matched' | 'not-matched' | 'unknown') {
  return assessmentSchema.parse({ schemaVersion: 1, profileId: 'query-test', id: `assessment-${imageId}`, createdAt: '2026-10-31T00:00:00.000Z', kind: 'assessment', imageVersionId: imageId, runId: 'run', stage: 'final', releaseId: 'release', recipeId: 'recipe', reviewBundleId: 'bundle', technicalStatus: 'completed', verdict: 'reject', ruleResults: [], cropPotential: 'unknown', preferenceScores: {}, data: { taskRelevance, ...(subjectFocusVerdict === undefined ? {} : { subjectFocusVerdict }) } })
}

for (const verdict of ['not-matched', 'unknown'] as const) test(`v3 subject focus ${verdict} does not inherit a positive overall relevance signal`, () => {
  const index = chooseSearchQuery({ pages: [{ index: 0, ids: ['v3'], done: ['v3'], empty: false }, { index: 1, ids: ['legacy'], done: ['legacy'], empty: false }], nextQuery: 0, queryCount: 2, imageId: id => id, assessments: [assessment('v3', 'relevant', verdict), assessment('legacy', 'relevant')], selections: [] })
  assert.equal(index, 1)
})

test('a matched v3 subject also requires relevant task evidence and preserves legacy relevance behavior', () => {
  const pages = [{ index: 0, ids: ['first'], done: ['first'], empty: false }, { index: 1, ids: ['second'], done: ['second'], empty: false }]
  assert.equal(chooseSearchQuery({ pages, nextQuery: 0, queryCount: 2, imageId: id => id, assessments: [assessment('first', 'irrelevant', 'matched'), assessment('second', 'relevant')], selections: [] }), 1)
  assert.equal(chooseSearchQuery({ pages, nextQuery: 0, queryCount: 2, imageId: id => id, assessments: [assessment('first', 'unknown'), assessment('second', 'relevant', 'matched')], selections: [] }), 1)
})

test('unseen directions outrank a fetched page with no new source identities', () => {
  assert.equal(chooseSearchQuery({ pages: [{ index: 0, ids: [], done: [], empty: true }, { index: 1, ids: [], done: [], empty: false }], nextQuery: 0, queryCount: 2, imageId: () => undefined, assessments: [], selections: [] }), 1)
})
