import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BudgetLedger, decideAssessment, rankedSelections } from '../src/host/runtime.ts'
import { resolveConfig } from '../src/host/config.ts'

test('last shared vision reservation cannot be spent twice; retries spend again', async () => {
  const limits = { ...resolveConfig({}).limits, maxVisionCalls: 1 }
  const ledger = new BudgetLedger(limits)
  const attempts = await Promise.allSettled([ledger.reserve('vision'), ledger.reserve('vision')])
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1)
  assert.equal(ledger.snapshot().vision, 1)
})
test('required failures and unknown cannot be averaged away by preferred scores', () => {
  assert.equal(decideAssessment([{ strength: 'required', result: 'violated' }]), 'reject')
  assert.equal(decideAssessment([{ strength: 'required', result: 'unknown' }]), 'needs-review')
  assert.equal(decideAssessment([{ strength: 'preferred', result: 'violated' }]), 'pass')
})
test('saved assessments have stable deterministic ranking', () => {
  assert.deepEqual(rankedSelections([{ id: 'b', score: 4 }, { id: 'a', score: 4 }, { id: 'c', score: 5 }]).map(x => x.id), ['c', 'a', 'b'])
})
