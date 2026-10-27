/** Repeated batch attempts retain distinct, ordered navigation targets. */
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { analysisNavigation } from '../src/client/analysis-navigation.ts'
import type { AnalysisMessage } from '../src/shared/analysis-process.ts'

const stamp = '2026-10-27T00:00:00.000Z'
function message(sequence: number, batch: number | undefined, state: AnalysisMessage['state'], kind: AnalysisMessage['kind'] = 'analysis'): AnalysisMessage {
  return { sequence, ...(batch === undefined ? {} : { batch }), state, kind, imageIds: ['a', 'b', 'c', 'd'], content: '', reasoning: '', at: stamp, updatedAt: stamp }
}

it('keeps failed and cancelled attempts separate from their completed batch and final summary', async () => {
  const messages = [message(0, 1, 'failed'), message(1, 1, 'complete'), message(2, 2, 'cancelled'), message(3, 2, 'complete'), message(4, 3, 'complete'), message(5, undefined, 'complete', 'summary')]
  const original = structuredClone(messages)
  const rows = analysisNavigation(messages)
  assert.deepEqual(rows, JSON.parse(await readFile(new URL('./fixtures/analysis-navigation.expected.json', import.meta.url), 'utf8')))
  assert.deepEqual(messages, original)
  assert.equal(new Set(rows.map(row => row.sequence)).size, 6)
})

it('keeps active summary retries distinct and accepts an empty retained transcript', () => {
  assert.deepEqual(analysisNavigation([]), [])
  const rows = analysisNavigation([message(7, undefined, 'failed', 'summary'), message(9, undefined, 'streaming', 'summary')])
  assert.deepEqual(rows.map(({ sequence, attempt, attempts, state }) => ({ sequence, attempt, attempts, state })), [{ sequence: 7, attempt: 1, attempts: 2, state: 'failed' }, { sequence: 9, attempt: 2, attempts: 2, state: 'streaming' }])
})
