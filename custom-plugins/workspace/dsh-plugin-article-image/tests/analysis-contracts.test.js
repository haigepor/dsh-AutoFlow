import { expect, test } from 'vitest'
import { createAnalysisInput, chunkSnapshot, validateUnderstanding, validateAnalysisPlan, computeSceneHash, analysisInputSchema } from '../src/shared/analysis-contracts.js'
import { loadEditorialRules, resolveAnalysisConfig } from '../src/host/editorial-rules.js'

const snapshot = { id: 'a'.repeat(32), sourceHash: 'b'.repeat(64), title: 'Article', blocks: [
  { id: 'b1', type: 'heading', text: 'Chapter' }, { id: 'b2', type: 'paragraph', text: 'A'.repeat(1500) },
  { id: 'b3', type: 'paragraph', text: 'B'.repeat(1500) }, { id: 'b4', type: 'figure', assetId: 'i1' },
], assets: [{ id: 'i1', status: 'ready', hash: 'c'.repeat(64), bytes: 123, mime: 'image/png' }] }

test('chunks cover every block and image and reject budgets without truncation', () => {
  const config = resolveAnalysisConfig({ contextChars: 4000 })
  const chunks = chunkSnapshot(snapshot, config)
  expect(chunks.flatMap(chunk => chunk.blockIds)).toEqual(snapshot.blocks.map(block => block.id))
  expect(chunks.flatMap(chunk => chunk.assetIds)).toEqual(['i1'])
  expect(() => chunkSnapshot(snapshot, { ...config, maxInputChars: 1000 })).toThrow('analysis-input-budget')
})

test('adopted business metadata, rules, model and image receipts affect input identity', async () => {
  const config = resolveAnalysisConfig({ provider: 'mock', model: 'mock' })
  const rules = await loadEditorialRules(config)
  const common = { articleId: 'd'.repeat(32), snapshot, rules, config, images: [] }
  const first = createAnalysisInput({ ...common, metadata: { notes: 'first' } })
  expect(createAnalysisInput({ ...common, metadata: { notes: 'second' } }).inputHash).not.toBe(first.inputHash)
  expect(createAnalysisInput({ ...common, metadata: { notes: 'first', row: 999 } }).inputHash).toBe(first.inputHash)
})

test('coverage cannot be satisfied by analyzing only the first block', () => {
  const result = { articleType: 'guide', audience: 'reader', purpose: 'explain', language: 'en', theme: 'topic',
    sections: [{ title: 'Chapter', summary: 'summary', blockIds: ['b1'] }], entities: [], facts: [{ id: 'f1', claim: 'Fact', kind: 'source', evidence: { blockIds: ['b1'], assetIds: [] } }],
    limitations: [], questions: [], images: [], coverage: { blockIds: ['b1'], assetIds: [] } }
  expect(() => validateUnderstanding(result, { blockIds: ['b1', 'b2'], assetIds: [] })).toThrow('analysis-coverage-incomplete')
})

test('scene identity ignores prompt text but changes with scene fields', () => {
  const shot = { subject: 'Family', action: 'walking', ratio: '16:9', prompt: 'First' }
  expect(computeSceneHash({ ...shot, prompt: 'Edited' })).toBe(computeSceneHash(shot))
  expect(computeSceneHash({ ...shot, action: 'reading' })).not.toBe(computeSceneHash(shot))
})

async function completePlan() {
  const source = { ...snapshot, blocks: [{ id: 'b1', type: 'paragraph', text: 'Families travel together.' }], assets: [] }
  const config = resolveAnalysisConfig({ provider: 'mock', model: 'mock' })
  const rules = await loadEditorialRules(config)
  const input = createAnalysisInput({ articleId: 'd'.repeat(32), snapshot: source, rules, config, images: [] })
  const understanding = { articleType: 'guide', audience: 'families', purpose: 'plan travel', language: 'en', theme: 'Family travel',
    sections: [{ title: 'Travel', summary: 'Families travel together', blockIds: ['b1'] }], entities: [], facts: [{ id: 'f1', claim: 'Families travel.', kind: 'source', evidence: { blockIds: ['b1'], assetIds: [] } }], limitations: [], questions: [], images: [], coverage: { blockIds: ['b1'], assetIds: [] } }
  const shot = { purpose: 'cover', paragraphs: [1], rationale: 'Travel', subject: 'Family', action: 'walking', environment: 'park', composition: 'wide', lighting: 'daylight', colors: 'natural', style: 'photography', details: 'Together', avoid: 'No text', prompt: 'Family walking in a park', ratio: '16:9', blockIds: ['b1'], assetIds: [], afterBlockId: 'b1', informationGoal: 'Travel together', visualMode: 'conceptual' }
  const plan = { sourceHash: source.sourceHash, inputHash: input.inputHash, rulesHash: input.rules.rulesHash, model: input.model, understanding, coverage: understanding.coverage,
    brief: { theme: 'Travel', facts: ['Families travel.'], subjects: ['Family'], scenes: ['Park'] }, shots: [shot], shortfall: { requested: 3, actual: 1, reason: 'Only one supported scene' }, checks: { structural: true, semanticReviewRequired: true } }
  return { source, input, understanding, plan }
}

test('plan checks reject stale inputs, invalid evidence, duplicate scenes and hidden quantity shortfalls', async () => {
  const { source, input, understanding, plan } = await completePlan()
  const context = { snapshot: source, input, understanding }
  expect(validateAnalysisPlan(plan, context)).toEqual(plan)
  expect(() => validateAnalysisPlan({ ...plan, inputHash: '0'.repeat(64) }, context)).toThrow('analysis-input-mismatch')
  expect(() => validateAnalysisPlan({ ...plan, shots: [{ ...plan.shots[0], blockIds: ['b99'] }] }, context)).toThrow('analysis-reference-invalid')
  expect(() => validateAnalysisPlan({ ...plan, shortfall: { ...plan.shortfall, reason: '' } }, context)).toThrow('analysis-quantity-invalid')
  expect(() => validateAnalysisPlan({ ...plan, shots: [plan.shots[0], { ...plan.shots[0], purpose: 'inline' }], shortfall: { requested: 3, actual: 2, reason: 'One missing' } }, context)).toThrow('analysis-shots-duplicate')
})

test('frozen input rejects modified rules or business metadata without a matching digest', async () => {
  const { input } = await completePlan()
  expect(() => analysisInputSchema.parse({ ...input, metadata: { ...input.metadata, notes: 'changed' } })).toThrow('analysis-input-hash-invalid')
  expect(() => analysisInputSchema.parse({ ...input, rules: { ...input.rules, rulesHash: '0'.repeat(64) } })).toThrow('analysis-rules-hash-invalid')
})
