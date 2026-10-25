import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeStyleSummary } from '../src/media/vision.ts'
import { MediaError } from '../src/media/errors.ts'

const output = {
  name: 'Muted green', summary: 'Soft green photography.', matchingPrompt: 'Inspect the candidate pixels for muted green colors.', searchHints: ['muted green'], avoidTerms: [],
  dimensions: [{ dimension: 'color', description: 'Muted green.', consistency: 'consistent', supportImageVersionIds: ['reference-1'] }], conflicts: [],
  suggestedRules: [{ dimension: 'color', statement: 'Prefer muted green.', strength: 'preferred', stage: 'source', supportImageVersionIds: ['reference-1'], condition: '', exceptions: [] }],
  organization: { groups: [], selections: [{ ruleIndex: 0, enabled: true, groupId: null, reason: 'Shared color evidence.' }] },
}

test('an omitted empty counterexample list is normalized without inventing image evidence', () => {
  const parsed = decodeStyleSummary(output, ['reference-1'])
  assert.deepEqual(parsed.suggestedRules[0]!.counterImageVersionIds, [])
  assert.deepEqual(parsed.dimensions[0]!.counterImageVersionIds, [])
  assert.deepEqual(parsed.suggestedRules[0]!.supportImageVersionIds, ['reference-1'])
})

test('malformed counters and foreign evidence still fail after empty-list compatibility decoding', () => {
  for (const counterImageVersionIds of ['reference-1', ['foreign-image']]) {
    assert.throws(() => decodeStyleSummary({ ...output, suggestedRules: [{ ...output.suggestedRules[0], counterImageVersionIds }] }, ['reference-1']), error => error instanceof MediaError && error.code === 'vision-invalid-output')
  }
})

test('unknown style-group selections cannot become adopted rules', () => {
  assert.throws(() => decodeStyleSummary({ ...output, organization: { groups: [], selections: [{ ruleIndex: 0, enabled: true, groupId: 'foreign-group', reason: 'Wrong group.' }] } }, ['reference-1']), error => error instanceof MediaError && error.diagnostics?.issues.includes('invalid-rule-organization') === true)
})
