/** Fixed model judgments exercise local acceptance independently of image search or paid vision calls. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { modelProfileSchema, recipeSchema, ruleSchema, type ModelProfile, type Rule } from '../src/shared/model.ts'
import { subjectReviewResults, subjectFocusVerdict } from '../src/host/subject-review.ts'
import { matchStyle } from '../src/host/style-execution.ts'
import type { VisionReview } from '../src/media/vision.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { z } from 'zod'

const base = { schemaVersion: 1, profileId: 'subject-focus', createdAt: '2026-10-31T00:00:00.000Z' }
const dimensions = ['subject', 'color', 'lighting', 'texture', 'composition', 'density', 'depth'] as const
const rules = dimensions.map(dimension => ruleSchema.parse({ ruleId: dimension, dimension, statement: dimension === 'subject' ? 'Vehicles must be the clear visual subject.' : `Match ${dimension}.`, condition: {}, strength: 'preferred', stage: 'final', check: { kind: 'visual', criterion: 'Inspect the actual candidate.' }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'suggested' } }))
const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'fixture', model: 'fixture', vendorVersion: null, promptVersion: 'visual-curator-rules-v3', outputSchemaVersion: '1', preprocessingVersion: '1', referenceStrategy: { maxImages: 4, maxBytes: 100000 }, preferenceScale: { min: 0, max: 1, weights: Object.fromEntries(dimensions.map(dimension => [dimension, 1])) }, styleMatching: { version: 2, minSatisfiedRatio: 0.75 }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
const option = (rule: Rule, groupId: string | null = null): ModelProfile['options'][number] => ({ rule, enabled: true, groupId, selectionSource: 'model', sourceStatement: rule.statement, reason: 'consistent' })
const profile = modelProfileSchema.parse({ ...base, id: 'profile', kind: 'modelProfile', styleId: 'style', draftId: 'draft', draftRevision: 1, access: { kind: 'profile-library' }, analysisRunId: 'analysis', referenceDigest: `sha256-v1:${'a'.repeat(64)}`, contentDigest: `sha256-v1:${'b'.repeat(64)}`, revision: 1, model: 'fixture', matchingPrompt: 'Vehicle environmental portraits.', rules, references: [], recipe, groups: [], options: rules.map(rule => option(rule)) })

function output(observed: 'dominant' | 'incidental' | 'absent' | 'unknown', requirement: 'dominant' | 'presence-or-exclusion' | 'unknown' = 'dominant'): VisionReview {
  return { ruleResults: rules.map(rule => ({ ruleId: rule.ruleId, status: 'satisfied', source: 'inferred', reason: 'The object is recognizable.', evidenceImageVersionIds: ['candidate'] })), cropPotential: 'direct', preferenceScores: dimensions.map(dimension => ({ dimension, score: 0.9 })), taskRelevance: 'relevant', subjectFocus: [{ ruleId: 'subject', requirement, observed, reason: observed === 'dominant' ? 'A deliberate close-up makes vehicle detail the visual focus.' : 'The vehicle does not clearly dominate the candidate.', evidenceImageVersionIds: ['candidate'] }] }
}

test('focal subject violations cannot be averaged away by six matching dimensions; deliberate close-ups remain valid', () => {
  for (const [observed, expected] of [['incidental', 'not-matched'], ['absent', 'not-matched'], ['unknown', 'unknown'], ['dominant', 'matched']] as const) {
    const checked = subjectReviewResults(rules, output(observed))
    const results = checked.ruleResults.map(rule => ({ ruleId: rule.ruleId, result: rule.status }))
    assert.equal(matchStyle(profile, results, 0.75, checked.focusRuleIds).verdict, expected)
    if (observed === 'incidental') assert.equal(matchStyle(profile, results, 0.75).verdict, 'matched', 'The fixed legacy 6/7 case demonstrates why focal acceptance needs its own gate')
  }
  const merelyExcluded = subjectReviewResults(rules, output('absent', 'presence-or-exclusion'))
  assert.deepEqual(merelyExcluded.focusRuleIds, [])
  assert.equal(matchStyle(profile, merelyExcluded.ruleResults.map(rule => ({ ruleId: rule.ruleId, result: rule.status })), 0.75, merelyExcluded.focusRuleIds).verdict, 'matched')
  const uncertain = subjectReviewResults(rules, output('dominant', 'unknown'))
  assert.equal(subjectFocusVerdict(profile, uncertain.ruleResults.map(rule => ({ ruleId: rule.ruleId, result: rule.status })), uncertain.focusRuleIds), 'unknown')
})

test('the same alternative must satisfy both style and focal subject, while unrelated alternatives remain optional', () => {
  const a = rules.map(rule => ({ ...rule, ruleId: `a-${rule.ruleId}` })), b = rules.map(rule => ({ ...rule, ruleId: `b-${rule.ruleId}` }))
  const grouped = { ...profile, rules: [...a, ...b], groups: [{ groupId: 'a', name: 'A', description: '', imageVersionIds: [] }, { groupId: 'b', name: 'B', description: '', imageVersionIds: [] }], options: [...a.map(rule => option(rule, 'a')), ...b.map(rule => option(rule, 'b'))] }
  const results = [...a.map(rule => ({ ruleId: rule.ruleId, result: rule.dimension === 'subject' ? 'violated' : 'satisfied' })), ...b.map(rule => ({ ruleId: rule.ruleId, result: rule.dimension === 'subject' ? 'satisfied' : 'violated' }))]
  assert.equal(matchStyle(grouped, results, 0.75).verdict, 'matched')
  assert.equal(matchStyle(grouped, results, 0.75, ['a-subject', 'b-subject']).verdict, 'not-matched')
  assert.equal(matchStyle(grouped, results.map(result => result.ruleId.startsWith('b-') ? { ...result, result: 'satisfied' } : result), 0.75, ['a-subject', 'b-subject']).groupId, 'b')
})

test('new image-search tasks persist focal evidence and reject a contradictory satisfied response without changing the frozen rule strength', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  let observed: 'dominant' | 'incidental' | 'unknown' = 'incidental'
  const request = f.http.request.bind(f.http)
  f.http.request = async (url, input) => {
    if (url.startsWith('https://source.example.test')) return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ items: [{ id: observed, previewUrl: `https://images.example.test/${observed}`, originalUrl: `https://images.example.test/${observed}` }], nextCursor: null })) }
    const response = await request(url, input)
    if (!url.startsWith('https://vision.example.test')) return response
    const envelope = JSON.parse(Buffer.from(response.bytes).toString('utf8')), result = JSON.parse(envelope.choices[0].message.content)
    if (f.http.operations.at(-1)?.startsWith('summarize:')) {
      result.suggestedRules[0].dimension = 'subject'; result.suggestedRules[0].statement = 'Vehicles must be the clear visual subject.'
      result.dimensions[0].dimension = 'subject'
    } else if (f.http.operations.at(-1)?.startsWith('review:')) result.subjectFocus = result.ruleResults.map((rule: { ruleId: string; evidenceImageVersionIds: string[] }) => ({ ruleId: rule.ruleId, requirement: 'dominant', observed, reason: observed === 'dominant' ? 'Vehicle detail commands attention in a deliberate close-up.' : 'The recognizable vehicle is secondary to its environment.', evidenceImageVersionIds: rule.evidenceImageVersionIds }))
    envelope.choices[0].message.content = JSON.stringify(result)
    return { ...response, bytes: Buffer.from(JSON.stringify(envelope)) }
  }
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'focus-style', name: 'Vehicle focus' }))
    await f.action('reference-import', { operationId: 'focus-reference', styleId: style.id, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'focus-analysis', styleId: style.id, buildDataset: true }); await f.jobs.drain()
    const analyzed = f.repository.list('modelProfile')[0]!, subject = analyzed.options.find(option => option.rule.dimension === 'subject')!
    const selected = z.object({ id: z.string() }).parse(await f.action('profile-save', { operationId: 'enable-focus', styleId: style.id, analysisRunId: analyzed.analysisRunId, expectedProfileId: analyzed.id, changes: [{ ruleId: subject.rule.ruleId, enabled: true }] }))
    const frozen = f.domain.require('modelProfile', selected.id), recorded = []
    for (const choice of ['incidental', 'dominant', 'unknown'] as const) {
      observed = choice
      f.http.image = await sharp({ create: { width: 400, height: 200, channels: 3, background: { incidental: '#536f53', dominant: '#234799', unknown: '#716f53' }[choice] } }).png().toBuffer()
      const start = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: `focus-${choice}`, releaseId: frozen.id, output: { kind: 'original' }, sourceId: 'images', taskBrief: 'Find vehicle environmental portraits.', queries: ['car forest road'], targetCount: 1 }))
      await f.jobs.drain()
      const assessment = f.repository.list('assessment').find(item => item.runId === start.runId)!
      recorded.push({ observed: choice, verdict: assessment.verdict, subject: assessment.ruleResults[0]?.result, selected: f.repository.list('selection').filter(item => item.runId === start.runId).length })
    }
    assert.deepEqual(recorded, JSON.parse(await readFile(new URL('./fixtures/subject-focus-review.expected.json', import.meta.url), 'utf8')))
    assert.equal(frozen.rules[0]?.strength, 'preferred')
    assert.deepEqual(f.domain.require('modelProfile', frozen.id), frozen)
  } finally { await f.cleanup() }
})
