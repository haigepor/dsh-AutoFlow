import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { analysisAnswer, providerMarkdown } from '../src/client/analysis-markdown.ts'
import { analysisDetailSchema, analysisMessageSchema } from '../src/shared/analysis-process.ts'
import { en, type WorkbenchText } from '../src/client/workbench-locale.ts'

const t: WorkbenchText = key => en[key]
const detail = analysisDetailSchema.parse({ task: { runId: 'r', styleId: 's', name: 'Saved analysis', status: 'failed', observed: 1, total: 2, model: 'Fixture', reasoningEffort: null, attempts: 1, startedAt: '2026-10-26', phase: 'failed', autoResume: false }, images: [{ imageVersionId: 'a', name: 'Image [a](unsafe)' }], observations: [{ imageVersionId: 'a', dimensions: [{ field: 'color', value: 'Muted **green**', uncertain: true }] }] })
const message = analysisMessageSchema.parse({ sequence: 1, kind: 'analysis', batch: 1, imageIds: ['a'], content: '{"observations":[]}', reasoning: '', state: 'complete', at: 'now', updatedAt: 'now' })

test('native answer projection uses saved observations only, retains raw text and safely labels data', async () => {
  const answer = analysisAnswer(message, detail, t)
  assert.equal(answer.structured, true)
  assert.ok(answer.text.includes('Muted \\*\\*green\\*\\*'))
  assert.ok(answer.text.includes('Image \\[a\\](unsafe)'))
  assert.ok(answer.text.includes('uncertain') || answer.text.includes('Uncertain'))
  const partial = analysisAnswer({ ...message, state: 'failed', content: '{"observations":["unfinished ```' }, detail, t)
  assert.equal(partial.structured, false)
  assert.ok(partial.text.startsWith('````json\n'))
  assert.ok(partial.text.includes('unfinished ```'))
  assert.equal(providerMarkdown('## Actual prose\n\n- Returned by model'), '## Actual prose\n\n- Returned by model')
  assert.deepEqual({ structured: answer.structured, markdown: answer.text, partial: partial.text }, JSON.parse(await readFile(new URL('./fixtures/analysis-message.expected.json', import.meta.url), 'utf8')))
})

test('streams readable observation text without treating an unfinished response as saved results', () => {
  const partial = { ...message, state: 'streaming' as const, content: '{"observations":[{"imageVersionId":"a","dimensions":[{"dimension":"color","observation":"Soft **green' }
  const active = { ...detail, task: { ...detail.task, status: 'running' as const } }
  const answer = analysisAnswer(partial, active, t)
  assert.equal(answer.structured, false)
  assert.ok(answer.text.includes('Soft \\*\\*green'))
  assert.ok(!answer.text.includes('imageVersionId'))
  assert.ok(!answer.text.includes('Muted'))
  assert.equal(detail.observations.length, 1)
  const foreign = analysisAnswer({ ...partial, content: partial.content.replace('"a"', '"foreign"') }, active, t)
  assert.equal(foreign.text, '')
})
