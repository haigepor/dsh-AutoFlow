import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CuratorDomain } from '../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter, contentDigest } from '../src/domain/repository.ts'
import { ModelProfiles } from '../src/domain/model-profile.ts'
import { analysisReferenceDigest } from '../src/domain/style-analysis.ts'
import { assetSchema, imageVersionSchema, referenceSchema, observationSchema, recipeSchema, styleSchema, draftSchema, runSchema, feedbackSchema, feedbackThreadSchema, modelProfileSchema, profileExportSchema, type DomainActor, type Reference } from '../src/shared/model.ts'
import { styleAnalysisSchema, type StyleSummary } from '../src/shared/style-analysis.ts'
import { compileStyleInstructions, matchStyle } from '../src/host/style-execution.ts'
import { selectReviewReferences } from '../src/host/review-references.ts'
import { freezeSearchNegatives, searchNegativeSummary } from '../src/host/search-reference-datasets.ts'

const base = { schemaVersion: 1, profileId: 'negative-evidence-test', createdAt: '2026-11-04T00:00:00.000Z' }
const actor: DomainActor = { kind: 'human', id: 'owner', profileId: base.profileId }
const exclusion: StyleSummary['suggestedRules'][number] = { statement: 'Exclude dense edge clutter.', dimension: 'composition', strength: 'required', stage: 'source', supportImageVersionIds: [], counterImageVersionIds: ['image-1'], condition: '', exceptions: [] }
const preference: StyleSummary['suggestedRules'][number] = { ...exclusion, statement: 'Prefer warm colors.', dimension: 'color', strength: 'required', supportImageVersionIds: ['image-0'], counterImageVersionIds: [] }

async function fixture(options: { role: Reference['role']; intent?: Reference['intent'] }[] = [{ role: 'positive' }, { role: 'negative' }]) {
  const repository = new DomainRepository(base.profileId, new MemoryDomainAdapter())
  const domain = new CuratorDomain(base.profileId, repository, { verifyImage: async () => {} }), profiles = new ModelProfiles(domain)
  const recipe = recipeSchema.parse({ ...base, id: 'recipe', kind: 'recipe', visionRevision: 'fixture', model: 'fixture', vendorVersion: null, promptVersion: 'visual-curator-rules-v3', outputSchemaVersion: '1', preprocessingVersion: '1', referenceStrategy: { maxImages: 4, maxBytes: 1000 }, preferenceScale: { min: 0, max: 1, weights: { color: 1, composition: 1 } }, styleMatching: { version: 2, minSatisfiedRatio: 0.75 }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
  const assets = options.map((_, index) => assetSchema.parse({ ...base, id: `asset-${index}`, kind: 'asset', familyId: `family-${index}`, source: { kind: 'local-import', description: 'Synthetic constant' }, access: { kind: 'profile-library' }, exportPermission: 'references-only', groupingStatus: 'unreviewed' }))
  const images = assets.map((asset, index) => imageVersionSchema.parse({ ...base, id: `image-${index}`, kind: 'imageVersion', assetId: asset.id, versionKind: 'normalized', blob: { digest: String(index + 1).repeat(64), byteLength: 1, mime: 'image/png', storageRef: `synthetic-${index}` }, geometry: { width: 1, height: 1, colorSpace: 'srgb', processorVersion: 'fixture' } }))
  const references = images.map((image, index) => referenceSchema.parse({ ...base, id: `ref-${index}`, kind: 'reference', styleId: 'style', imageVersionId: image.id, role: options[index]!.role, intent: options[index]!.intent ?? { kind: 'overall' }, context: {}, feedbackThreadIds: [`thread-${index}`] }))
  const observations = images.map(image => observationSchema.parse({ ...base, id: `observation-${image.id}`, kind: 'observation', imageVersionId: image.id, measured: [], inferred: [], corrections: [] }))
  const style = styleSchema.parse({ ...base, id: 'style', kind: 'style', name: 'Synthetic', archived: false, draftId: 'draft', revision: 1, committedReleaseIds: [], defaultReleaseId: null, nextReleaseNumber: 1 })
  const draft = draftSchema.parse({ ...base, id: 'draft', kind: 'draft', styleId: style.id, revision: 1, status: 'editing', rules: [], referenceIds: references.map(ref => ref.id), feedbackIds: [], conflicts: [] })
  await repository.commit({ aggregateId: 'seed', expectedRevision: 0, operationId: 'seed', request: {}, records: [...assets, ...images, ...references, ...observations, style, draft], state: {} })
  let sequence = 0
  return {
    domain, repository, profiles, references,
    async analyze(id: string, rules: StyleSummary['suggestedRules'] = [preference, exclusion], disabledRuleIndices?: readonly number[]) {
      const feedback = domain.currentFeedback(actor)
      const summary: StyleSummary = { name: 'Synthetic', summary: 'Warm color with evidence-backed exclusions.', matchingPrompt: 'Prefer warm colors; exclude dense edge clutter.', searchHints: ['warm scene'], avoidTerms: ['dense clutter'], dimensions: [{ dimension: 'color', description: 'Warm colors.', consistency: 'consistent', supportImageVersionIds: ['image-0'], counterImageVersionIds: [] }], conflicts: [], suggestedRules: rules,
        ...(disabledRuleIndices ? { organization: { groups: [], selections: rules.map((_, ruleIndex) => ({ ruleIndex, enabled: !disabledRuleIndices.includes(ruleIndex), groupId: null, reason: 'Explicit model selection.' })) } } : {}) }
      const analysis = styleAnalysisSchema.parse({ formatVersion: 1, runId: id, styleId: style.id, draftId: draft.id, draftRevision: 1, referenceDigest: analysisReferenceDigest(references, feedback.map(item => item.id)), feedbackIds: feedback.map(item => item.id), recipeId: recipe.id, model: 'fixture', declaredModelVersion: null, observationPromptVersion: 'visual-curator-v1', summaryPromptVersion: 'visual-curator-summary-v3', summaryRequestId: `request-${id}`, samples: references.map((reference, index) => ({ reference, imageDigest: images[index]!.blob.digest, observationId: observations[index]!.id, feedbackIds: feedback.filter(item => item.threadId === reference.feedbackThreadIds[0]).map(item => item.id) })), summary })
      const run = runSchema.parse({ ...base, createdAt: `2026-11-04T00:00:${String(sequence++).padStart(2, '0')}.000Z`, id, kind: 'run', owner: { kind: 'profile' }, revision: 1, status: 'completed', stage: 'finalizing', outcome: 'target-met', spec: { fixed: { recipe } }, data: { checkpoint: { styleAnalysis: analysis } } })
      await repository.commit({ aggregateId: id, expectedRevision: 0, operationId: id, request: {}, records: [run], state: {} })
      const profile = await profiles.adopt(run, actor)
      assert.ok(profile)
      return profile
    },
    async judge(index: number, value: 'accept' | 'reject' | 'unknown') {
      const threadId = `thread-${index}`, aggregateId = `feedback:${threadId}`, prior = repository.manifest(aggregateId), image = images[index]!
      const feedback = feedbackSchema.parse({ ...base, id: `feedback-${index}-${value}`, kind: 'feedback', threadId, subject: { kind: 'image', imageVersionId: image.id }, context: { styleId: style.id, standard: { kind: 'draft', draftId: draft.id, draftRevision: 1 }, usage: { kind: 'none' }, taskBriefDigest: 'synthetic' }, judgment: { kind: 'style-verdict', value }, reasonCodes: [], scope: 'style-candidate', labelEligibility: 'confirmed-candidate', actor: { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'client-action', confirmedAt: base.createdAt }, viewEvidence: [{ imageVersionId: image.id, versionKind: image.versionKind }], supersedesFeedbackId: null, operationId: `feedback-${index}-${value}` })
      const thread = feedbackThreadSchema.parse({ ...base, id: threadId, kind: 'feedbackThread', identityDigest: contentDigest(threadId), headFeedbackId: feedback.id, revision: (prior?.revision ?? 0) + 1 })
      await repository.commit({ aggregateId, expectedRevision: prior?.revision ?? 0, operationId: feedback.operationId, request: {}, records: [feedback, thread], state: {} })
    },
  }
}

test('explicit negative constraints retain required strength while positive-only requirements remain preferences', async () => {
  const f = await fixture(), profile = await f.analyze('analysis')
  const constraint = profile.options.find(option => option.rule.statement === exclusion.statement)!
  assert.equal(constraint.enabled, true)
  assert.equal(constraint.rule.strength, 'required')
  assert.deepEqual(constraint.rule.supportRefs, [])
  assert.deepEqual(constraint.rule.counterRefs, ['ref-1'])
  assert.equal(constraint.rule.confirmation.status, 'suggested')
  assert.equal(profile.rules.find(rule => rule.statement === preference.statement)!.strength, 'preferred')
  assert.ok(compileStyleInstructions(profile).includes(exclusion.statement))
  assert.deepEqual(selectReviewReferences(profile, () => 1).map(ref => ref.reference.role), ['positive', 'negative'])
})

test('an inapplicable positive reference does not disable a scoped interaction rule', async () => {
  const f = await fixture([{ role: 'positive', intent: { kind: 'dimensions', dimensions: ['subject'] } }, { role: 'positive' }, { role: 'negative', intent: { kind: 'dimensions', dimensions: ['subject'] } }])
  const profile = await f.analyze('scoped-interaction', [{ ...preference, statement: 'Prefer interaction in two-person portraits.', dimension: 'subject', strength: 'preferred', condition: 'Two-person portraits only.', supportImageVersionIds: ['image-0'], counterImageVersionIds: ['image-2'], notApplicableImageVersionIds: ['image-1'] }])
  assert.equal(profile.options[0]!.enabled, true)
  assert.deepEqual(profile.options[0]!.rule.counterRefs, ['ref-2'])
  assert.deepEqual(profile.options[0]!.rule.notApplicableRefs, ['ref-1'])
})

test('counter-only negative preferences remain enabled preferences through user edits and reanalysis', async () => {
  const f = await fixture()
  const rules: StyleSummary['suggestedRules'] = [preference,
    { ...exclusion, strength: 'preferred' },
    { ...exclusion, statement: 'Reference-only clutter observation.', strength: 'reference-only' },
    { ...exclusion, statement: 'Disabled clutter preference.', strength: 'preferred' },
  ]
  const profile = await f.analyze('first', rules, [3]), selected = profile.options.find(option => option.rule.statement === exclusion.statement)!
  assert.equal(selected.enabled, true)
  assert.equal(selected.rule.strength, 'preferred')
  assert.deepEqual(selected.rule.supportRefs, [])
  assert.deepEqual(selected.rule.counterRefs, ['ref-1'])
  assert.equal(profile.options.find(option => option.rule.strength === 'reference-only')!.enabled, false)
  assert.equal(profile.options.find(option => option.rule.statement === 'Disabled clutter preference.')!.enabled, false)
  assert.ok(profile.rules.every(rule => rule.strength === 'preferred'))
  assert.equal(matchStyle(profile, profile.rules.map(rule => ({ ruleId: rule.ruleId, result: rule.ruleId === selected.rule.ruleId ? 'violated' : 'satisfied' })), 0.5).verdict, 'matched')
  await f.profiles.save({ operationId: 'preferred-wording', styleId: profile.styleId, analysisRunId: profile.analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: selected.rule.ruleId, enabled: true, statement: 'Prefer clear edges.' }] }, actor)
  const refreshed = await f.analyze('second', rules, [3]), retained = refreshed.options.find(option => option.rule.ruleId === selected.rule.ruleId)!
  assert.equal(retained.enabled, true)
  assert.equal(retained.rule.strength, 'preferred')
  assert.equal(retained.rule.statement, 'Prefer clear edges.')
  await f.profiles.save({ operationId: 'preferred-disabled', styleId: refreshed.styleId, analysisRunId: refreshed.analysisRunId, expectedProfileId: refreshed.id, changes: [{ ruleId: selected.rule.ruleId, enabled: false }] }, actor)
  const disabled = await f.analyze('third', rules, [3])
  assert.equal(disabled.options.find(option => option.rule.ruleId === selected.rule.ruleId)!.enabled, false)
})

test('positive counterevidence, unknown judgments and unrelated dimensions cannot establish required exclusions', async () => {
  const f = await fixture([{ role: 'positive' }, { role: 'negative' }, { role: 'negative', intent: { kind: 'dimensions', dimensions: ['color'] } }])
  await f.judge(1, 'unknown')
  const profile = await f.analyze('analysis', [preference,
    { ...exclusion, statement: 'Unknown rejection.', supportImageVersionIds: ['image-0'] },
    { ...exclusion, statement: 'Positive disagreement.', supportImageVersionIds: ['image-0'], counterImageVersionIds: ['image-0'] },
    { ...exclusion, statement: 'Unrelated dimension.', counterImageVersionIds: ['image-2'] },
    { ...exclusion, statement: 'Unconfirmed negative hint.', strength: 'preferred' },
  ])
  assert.ok(profile.options.every(option => option.rule.strength !== 'required'))
  assert.equal(profile.options.find(option => option.rule.statement === 'Positive disagreement.')!.enabled, false)
  assert.equal(profile.options.find(option => option.rule.statement === 'Unrelated dimension.')!.enabled, false)
  assert.equal(profile.options.find(option => option.rule.statement === 'Unconfirmed negative hint.')!.enabled, false)
})

test('user exclusion wording survives reanalysis and is disabled when its counterexample is accepted', async () => {
  const f = await fixture(), original = await f.analyze('first')
  const constraint = original.rules.find(rule => rule.statement === exclusion.statement)!
  await f.profiles.save({ operationId: 'wording', styleId: original.styleId, analysisRunId: original.analysisRunId, expectedProfileId: original.id, changes: [{ ruleId: constraint.ruleId, enabled: true, statement: 'Exclude heavy edge clutter.' }] }, actor)
  const refreshed = await f.analyze('second')
  const retained = refreshed.options.find(option => option.rule.ruleId === constraint.ruleId)!
  assert.equal(retained.enabled, true)
  assert.equal(retained.rule.strength, 'required')
  assert.equal(retained.rule.statement, 'Exclude heavy edge clutter.')
  await f.judge(1, 'accept')
  const accepted = await f.analyze('third'), revised = accepted.options.find(option => option.rule.ruleId === constraint.ruleId)!
  assert.equal(revised.enabled, false)
  assert.equal(revised.reason, 'evidence-changed')
  assert.equal(accepted.rules.some(rule => rule.ruleId === constraint.ruleId), false)
})

test('shared required exclusions cannot be averaged away and alternatives enforce their own required rules', async () => {
  const f = await fixture(), profile = await f.analyze('analysis')
  const required = profile.rules.find(rule => rule.strength === 'required')!, preferred = profile.rules.find(rule => rule.strength === 'preferred')!
  const results = [{ ruleId: preferred.ruleId, result: 'satisfied' }, { ruleId: required.ruleId, result: 'violated' }]
  assert.equal(matchStyle(profile, results, 0.75).verdict, 'not-matched')
  assert.equal(matchStyle(profile, [{ ...results[0]! }, { ...results[1]!, result: 'unknown' }], 0.75).verdict, 'unknown')
  const alternative = { ...required, ruleId: 'alternative' }
  const grouped = modelProfileSchema.parse({ ...profile, rules: [required, alternative], options: [{ ...profile.options.find(option => option.rule.ruleId === required.ruleId)!, groupId: 'a' }, { ...profile.options.find(option => option.rule.ruleId === required.ruleId)!, rule: alternative, groupId: 'b' }], groups: ['a', 'b'].map(groupId => ({ groupId, name: groupId, description: '', imageVersionIds: [] })) })
  const matched = matchStyle(grouped, [{ ruleId: required.ruleId, result: 'violated' }, { ruleId: alternative.ruleId, result: 'satisfied' }], 0.75)
  assert.equal(matched.verdict, 'matched')
  assert.equal(matched.groupId, 'b')
})

test('negative observation supplements and exports follow revised roles without importing another collection', async () => {
  const f = await fixture()
  await f.judge(0, 'reject'); await f.judge(1, 'accept')
  const profile = await f.analyze('analysis', [{ ...preference, supportImageVersionIds: ['image-1'] }])
  const dataset = await f.profiles.export(profile, 'negative-export', actor, { sampleScope: 'negative' })
  assert.deepEqual(dataset.resources.map(resource => resource.imageVersionId), ['image-0'])
  const other = modelProfileSchema.parse({ ...profile, id: 'other-profile', styleId: 'other-style' })
  const otherDataset = profileExportSchema.parse({ ...dataset, id: 'other-export', modelProfileId: other.id })
  const directory = { profiles: [profile, other], artifacts: [dataset, otherDataset] }
  const supplement = freezeSearchNegatives(f.domain, profile, actor, directory)
  assert.deepEqual(supplement.samples.map(sample => sample.reference.imageVersionId), ['image-0'])
  assert.equal(supplement.samples[0]!.reference.role, 'negative')
  assert.equal(profile.references[0]!.reference.role, 'positive')
  assert.deepEqual(supplement.datasets.map(source => source.exportId), [dataset.id])
  assert.deepEqual(searchNegativeSummary(f.domain, profile, directory), { datasets: 1, references: 1 })
  const missing = { ...dataset, resources: [] }
  assert.equal(searchNegativeSummary(f.domain, profile, { profiles: [profile], artifacts: [missing] }).datasets, 0)
})
