import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisRequestSchema, nativeCallFactsSchema } from '../src/shared/analysis-process.ts'
import { analysisContextUsage } from '../src/client/analysis-context.ts'

const native = { transport: 'native-llm', provider: 'vision', context: { contextWindow: 1_000_000 }, timing: { elapsedMs: 12 } }
const request = (fields: object) => analysisRequestSchema.parse({ requestId: 'request', createdAt: '2026-10-28', state: 'committed', operation: 'analyze', model: 'vision-model', imageIds: [], available: true, ...fields })

test('context occupancy uses the latest analysis request and disjoint native usage buckets', () => {
  const earlier = request({ native: { ...native, usage: { inputTokens: 800_000, outputTokens: 10_000 } } })
  const latest = request({ native: { ...native, usage: { inputTokens: 20_000, cacheReadTokens: 5_000, cacheWriteTokens: 2_000, outputTokens: 13_000, reasoningTokens: 8_000, totalTokens: 40_000 } } })
  const compact = request({ operation: null, native: { ...native, context: { contextWindow: 128_000 }, usage: { inputTokens: 100_000, outputTokens: 20_000 } } })
  assert.deepEqual(analysisContextUsage([earlier, latest, compact]), { usedTokens: 40_000, contextWindow: 1_000_000, percent: 4 })
})

test('a pending request retains the last measured request without mixing model capacities', () => {
  const earlier = request({ native: { ...native, usage: { inputTokens: 900_000, outputTokens: 2_000 } } })
  const pending = request({ state: 'reserved', native: { ...native, context: { contextWindow: 200_000 } } })
  assert.deepEqual(analysisContextUsage([earlier, pending]), { usedTokens: 902_000, contextWindow: 1_000_000, percent: 90.2, retained: true })
  assert.deepEqual(analysisContextUsage([earlier, request({})]), { usedTokens: 902_000, contextWindow: 1_000_000, percent: 90.2, retained: true })
  assert.deepEqual(analysisContextUsage([pending]), { contextWindow: 200_000 })
  assert.deepEqual(analysisContextUsage([]), {})
})

test('historical usage remains readable without inventing context capacity', () => {
  const { context: _context, ...legacy } = native
  assert.deepEqual(analysisContextUsage([request({ native: { ...legacy, usage: { inputTokens: 200, outputTokens: 100 } } })]), { usedTokens: 300 })
})

test('zero usage is measured and overflow bounds the ring without discarding the actual token count', () => {
  assert.deepEqual(analysisContextUsage([request({ native: { ...native, usage: { inputTokens: 0, outputTokens: 0 } } })]), { usedTokens: 0, contextWindow: 1_000_000, percent: 0 })
  assert.deepEqual(analysisContextUsage([request({ native: { ...native, usage: { inputTokens: 1_000_000, outputTokens: 1 } } })]), { usedTokens: 1_000_001, contextWindow: 1_000_000, percent: 100 })
})

test('public context facts retain capacity while excluding private model inputs', () => {
  const parsed = nativeCallFactsSchema.parse({ ...native, context: { contextWindow: 1_000_000, privatePolicy: 'hidden' }, request: { messages: ['private prompt'] } })
  assert.deepEqual(parsed, native)
  for (const contextWindow of [0, -1, 1.5, Infinity]) assert.equal(nativeCallFactsSchema.safeParse({ ...native, context: { contextWindow } }).success, false)
})
