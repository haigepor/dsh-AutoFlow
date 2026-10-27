import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { matchStyle, compileStyleInstructions } from '../src/host/style-execution.ts'
import { BudgetLedger, specOf, toJson } from '../src/host/runtime.ts'
import { runSchema } from '../src/shared/model.ts'

test('current rules replace the old prompt and zero-style candidates cannot become final selections', async () => {
  const f = await serviceFixture(); await f.service.initialize()
  try {
    const style = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 's', name: 'Profile' }))
    await f.action('reference-import', { operationId: 'i', styleId: style.id, expectedRevision: 1, files: [{ name: 'r.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'a', styleId: style.id, buildDataset: true }); await f.jobs.drain()
    let profile = f.repository.list('modelProfile')[0]!
    const saved = z.object({ id: z.string() }).parse(await f.action('profile-save', { operationId: 'edit', styleId: style.id, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: profile.rules[0]!.ruleId, enabled: true, statement: 'Prefer red colors.' }] }))
    profile = f.domain.require('modelProfile', saved.id)
    assert.match(compileStyleInstructions(profile), /Prefer red colors/); assert.doesNotMatch(compileStyleInstructions(profile), /Prefer muted green palettes/)
    const rule = profile.rules[0]!
    const failed = matchStyle(profile, [{ ruleId: rule.ruleId, result: 'violated' }], 0.75)
    assert.equal(failed.verdict, 'not-matched')
    assert.equal(matchStyle(profile, [{ ruleId: rule.ruleId, result: 'unknown' }], 0.75).verdict, 'unknown')
    const groupProfile = { ...profile, rules: [rule, { ...rule, ruleId: 'alternate', statement: 'Alternative.' }], options: [{ ...profile.options[0]!, groupId: 'a' }, { ...profile.options[0]!, rule: { ...rule, ruleId: 'alternate' }, groupId: 'b' }], groups: [{ groupId: 'a', name: 'A', description: '', imageVersionIds: [] }, { groupId: 'b', name: 'B', description: '', imageVersionIds: [] }] }
    const grouped = matchStyle(groupProfile, [{ ruleId: rule.ruleId, result: 'satisfied' }, { ruleId: 'alternate', result: 'violated' }], 0.75)
    assert.equal(grouped.verdict, 'matched'); assert.equal(grouped.groupId, 'a')
    const sharedRule = { ...rule, ruleId: 'shared' }
    const withShared = { ...groupProfile, rules: [...groupProfile.rules, sharedRule], options: [...groupProfile.options, { ...profile.options[0]!, rule: sharedRule, groupId: null }] }
    assert.equal(matchStyle(withShared, [{ ruleId: rule.ruleId, result: 'satisfied' }, { ruleId: 'alternate', result: 'violated' }, { ruleId: 'shared', result: 'violated' }], 0.75).verdict, 'not-matched')
    const sameDimension = [rule, ...[1, 2, 3].map(index => ({ ...rule, ruleId: `color-${index}` })), { ...rule, ruleId: 'composition', dimension: 'composition' as const }]
    const weighted = matchStyle({ ...profile, rules: sameDimension, groups: [], options: sameDimension.map(item => ({ ...profile.options[0]!, rule: item, groupId: null })) }, sameDimension.map((item, index) => ({ ruleId: item.ruleId, result: index < 3 ? 'satisfied' : 'violated' })), 0.5)
    assert.equal(weighted.verdict, 'not-matched'); assert.ok(Math.abs(weighted.satisfiedWeightRatio! - 0.375) < 0.00001)
    const usage = z.object({ id: z.string() }).parse(await f.action('usage-create', { operationId: 'u', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    const request = f.http.request.bind(f.http)
    f.http.request = async (url, input) => {
      const response = await request(url, input)
      if (!url.startsWith('https://vision.example.test') || !f.http.operations.at(-1)?.startsWith('review:')) return response
      const body = JSON.parse(response.bytes.toString('utf8')), result = JSON.parse(body.choices[0].message.content)
      result.ruleResults = result.ruleResults.map((row: { ruleId: string }) => ({ ...row, status: 'violated' }))
      result.preferenceScores = result.preferenceScores.map((row: { dimension: string }) => ({ ...row, score: 0 }))
      body.choices[0].message.content = JSON.stringify(result)
      return { ...response, bytes: Buffer.from(JSON.stringify(body)) }
    }
    const started = z.object({ runId: z.string() }).parse(await f.action('search-start', { operationId: 'search', releaseId: profile.id, usageRevisionId: usage.id, sourceId: 'images', taskBrief: 'Find candidate', targetCount: 1 }))
    await f.jobs.drain()
    assert.equal(f.repository.list('selection').filter(row => row.runId === started.runId).length, 0)
    assert.ok(f.repository.list('assessment').some(row => row.runId === started.runId && row.stage === 'final' && row.verdict === 'reject'))
    const current = f.domain.require('run', started.runId), spec = specOf(current)
    const { executionRecipe, executionInstructions, ...legacyFixed } = spec.fixed
    assert.ok(executionRecipe); assert.ok(executionInstructions)
    const legacySpec = { ...spec, fixed: legacyFixed }
    const legacy = runSchema.parse({ ...current, id: 'legacy-profile-task', revision: 1, status: 'paused', outcome: undefined, spec: toJson(legacySpec), data: { attemptId: 'legacy-attempt', attempts: 1, budget: new BudgetLedger(spec.config.limits).snapshot(), checkpoint: {}, counts: {}, warnings: [], resultIds: [], requestIds: [] } })
    await f.repository.commit({ aggregateId: `run:${legacy.id}`, expectedRevision: 0, operationId: 'seed-legacy-task', request: {}, records: [legacy], state: { runId: legacy.id } })
    await f.action('run-control', { runId: legacy.id, command: 'resume' }); await f.jobs.drain()
    assert.deepEqual(specOf(f.domain.require('run', legacy.id)), legacySpec)
    assert.equal(f.repository.list('selection').filter(row => row.runId === legacy.id).length, 1)
    assert.ok(f.repository.list('assessment').filter(row => row.runId === legacy.id).every(row => !Object.hasOwn(z.record(z.string(), z.json()).parse(row.data), 'styleMatch')))
  } finally { await f.cleanup() }
})
