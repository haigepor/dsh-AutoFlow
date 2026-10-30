/** Historical attempt failures never make a completed task resumable. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { analysisDetailSchema } from '../src/shared/analysis-process.ts'
import { analysisIssues, analysisCanContinue, analysisContinuationHint, analysisFailureSummary } from '../src/client/analysis-diagnostics.tsx'
import { zh } from '../src/client/workbench-locale.ts'

function detail() {
  return analysisDetailSchema.parse({ observations: [], task: { runId: 'task', styleId: 'style', name: 'Fixture', status: 'completed', outcome: 'target-met', observed: 2, total: 2, model: 'fixture', reasoningEffort: null, attempts: 2, startedAt: '2026-10-30T00:00:00Z', phase: 'completed', autoResume: true, continuation: { allowed: false, reason: 'completed' } },
    requests: [{ requestId: 'timeout', createdAt: '2026-10-30T00:00:00Z', state: 'outcome-unknown', operation: 'summarize', model: 'fixture', imageIds: [], available: true, error: { code: 'request-timeout', safeMessage: 'Timed out' } }, { requestId: 'success', createdAt: '2026-10-30T00:01:00Z', state: 'committed', operation: 'summarize', model: 'fixture', imageIds: [], available: true }],
    process: { phase: 'completed', content: '', reasoning: '', truncated: false, updatedAt: '2026-10-30T00:01:00Z', events: [], messages: [{ sequence: 0, kind: 'summary', requestId: 'timeout', imageIds: [], content: '', reasoning: '', state: 'failed', at: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:30Z' }, { sequence: 1, kind: 'summary', imageIds: [], content: '', reasoning: '', state: 'interrupted', at: '2026-10-30T00:00:30Z', updatedAt: '2026-10-30T00:00:35Z' }, { sequence: 2, kind: 'summary', requestId: 'success', imageIds: [], content: '', reasoning: '', state: 'complete', at: '2026-10-30T00:00:35Z', updatedAt: '2026-10-30T00:01:00Z' }] } })
}

test('failure diagnostics deduplicate a receipt and response while retaining interruptions without receipts', () => {
  const value = detail(), issues = analysisIssues(value)
  assert.equal(issues.length, 2)
  assert.equal(issues[0]!.request?.error?.code, 'request-timeout')
  assert.equal(issues[1]!.message?.state, 'interrupted')
  assert.equal(analysisCanContinue(value.task), false)
  assert.equal(analysisCanContinue({ ...value.task, continuation: { allowed: true, reason: 'ready' } }), false)
})

test('failed continuation uses Host eligibility and preserves legacy paused controls', () => {
  const task = detail().task
  assert.equal(analysisCanContinue({ ...task, status: 'failed', continuation: { allowed: true, reason: 'ready' } }), true)
  assert.equal(analysisCanContinue({ ...task, status: 'failed', continuation: { allowed: false, reason: 'deadline' } }), false)
  assert.equal(analysisContinuationHint({ ...task, status: 'failed', continuation: { allowed: false, reason: 'deadline' } }, key => zh[key]), zh.analysisResumeDeadline)
  const { continuation, ...legacy } = task
  assert.equal(analysisCanContinue({ ...legacy, status: 'paused' }), true)
  assert.equal(analysisCanContinue({ ...legacy, status: 'failed' }), false)
})

test('localized failure summaries distinguish missing causes, image preparation and remote failures', () => {
  const t = (key: keyof typeof zh) => zh[key]
  assert.equal(analysisFailureSummary({ code: 'capability-unavailable', stage: 'workflow', safeMessage: 'The operation failed.' }, t), zh.analysisFailureUnknownCause)
  assert.equal(analysisFailureSummary({ code: 'capability-unavailable', stage: 'vision-preflight' }, t), zh.analysisFailureCapability)
  assert.equal(analysisFailureSummary({ code: 'IMAGE_TYPE_MISMATCH', stage: 'vision-images' }, t), zh.analysisFailureImage)
  assert.equal(analysisFailureSummary({ code: 'IMAGE_TOO_MANY_PIXELS', stage: 'vision-images' }, t), zh.analysisFailureImageLimit)
  assert.equal(analysisFailureSummary({ code: 'ATTACHMENT_WRITE_FAILED', stage: 'vision-images' }, t), zh.analysisFailureAttachmentStore)
  assert.equal(analysisFailureSummary({ code: 'remote-request-failed', stage: 'network' }, t), zh.analysisFailureNetwork)
  assert.ok(!zh.analysisContextUpdating.includes('进行中'))
})
