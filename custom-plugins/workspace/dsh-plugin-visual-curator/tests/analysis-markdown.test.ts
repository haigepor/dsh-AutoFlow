import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { analysisAnswer, providerMarkdown } from '../src/client/analysis-markdown.ts'
import { analysisDetailSchema, analysisMessageSchema } from '../src/shared/analysis-process.ts'
import { en, zh, type WorkbenchText } from '../src/client/workbench-locale.ts'
import { styleSummarySchema } from '../src/shared/style-analysis.ts'

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

test('known raw JSON tails keep code presentation when retention removes the opening', () => {
  for (const tail of ['observation": "Retained tail', '    "uncertain": false\n  }', '```\nA provider-authored fence']) {
    const markdown = providerMarkdown(tail, true)
    const delimiter = markdown.slice(0, markdown.indexOf('json\n'))
    assert.ok(delimiter.length >= 3)
    assert.equal(markdown.slice(delimiter.length + 5, -delimiter.length - 1), tail)
  }
})

test('summary presentation links restored evidence while retaining the original short-label output', () => {
  const summary = styleSummarySchema.parse({ name: 'Saved vehicle style', summary: 'A clear vehicle subject.', matchingPrompt: 'Inspect the actual vehicle.', searchHints: ['car portrait'], avoidTerms: [],
    dimensions: [{ dimension: 'subject', description: 'The vehicle commands attention.', consistency: 'consistent', supportImageVersionIds: ['a'], counterImageVersionIds: [] }], conflicts: [], suggestedRules: [] })
  const content = JSON.stringify({ ...summary, dimensions: [{ ...summary.dimensions[0], supportImageVersionIds: ['r1'] }] })
  const complete = { ...message, kind: 'summary' as const, content }
  const current = { ...detail, summary, process: { phase: 'completed' as const, events: [], messages: [complete], content, reasoning: '', truncated: false, updatedAt: 'now' } }
  const answer = analysisAnswer(complete, current, t)
  assert.deepEqual(answer.evidence, ['a'])
  assert.ok(answer.text.includes('Image \\[a\\](unsafe)'))
  assert.equal(complete.content, content)
  const historical = analysisAnswer({ ...complete, sequence: 0 }, current, t)
  assert.equal(historical.structured, false)
  assert.deepEqual(historical.evidence, [])
  assert.ok(historical.text.includes('r1'))
})

test('a retained source uses the current labels through a stable translator reference', () => {
  let dictionary = zh
  const translate: WorkbenchText = key => dictionary[key]
  const stableTranslate = translate
  const source = { ...message, state: 'streaming' as const, content: '{"observations":[{"imageVersionId":"a","dimensions":[{"dimension":"color","observation":"Soft reflected light' }
  const original = source.content
  const chinese = analysisAnswer(source, detail, translate)
  assert.ok(chinese.text.includes(`### ${zh.chatImage} 01`))
  assert.ok(chinese.text.includes(`**${zh.color}**`))
  dictionary = en
  const english = analysisAnswer(source, detail, translate)
  assert.equal(translate, stableTranslate)
  assert.ok(english.text.includes(`### ${en.chatImage} 01`))
  assert.ok(english.text.includes(`**${en.color}**`))
  assert.ok(english.text.includes('Soft reflected light'))
  assert.ok(!english.text.includes(`### ${zh.chatImage} 01`))
  assert.equal(source.content, original)
})
