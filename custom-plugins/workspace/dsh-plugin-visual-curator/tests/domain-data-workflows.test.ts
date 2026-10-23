import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JobId, JobHooks, JobRegistry } from '@deepseek-ai/dsh-jobs'
import { AssetFiles, CompatibleVisionProvider, type HttpClient, type HttpRequest } from '../src/media/index.ts'
import { CuratorDomain, DomainRepository, MemoryDomainAdapter, contentDigest, recipeSchema, type DomainActor, type AggregateManifest } from '../src/domain/index.ts'
import { importedRecords } from '../src/host/imports.ts'
import { settingsSchema } from '../src/host/config.ts'
import { RunEngine, dataOf, toJson } from '../src/host/runtime.ts'
import { createDataWorker } from '../src/host/data-workflows.ts'

const actor: DomainActor = { kind: 'human', id: 'human', profileId: 'profile' }
class FixtureJobs implements Pick<JobRegistry, 'start'> {
  hooks: JobHooks[] = []
  start: JobRegistry['start'] = input => { const id = brandString<JobId>(`job-${this.hooks.length}`); this.hooks.push(input.run({ id, append: () => {}, updateProgress: () => {} })); return id }
}
class AnalysisHttp implements HttpClient {
  calls = 0
  failAtCall = 0
  lastRoles: string[] = []
  reviewStatus: 'satisfied' | 'not-applicable' = 'satisfied'
  reviewedChecks: string[] = []
  async request(_url: string, input: HttpRequest) {
    this.calls++
    const body = JSON.parse(Buffer.from(input.body ?? []).toString('utf8'))
    const descriptor = JSON.parse(body.messages[1].content[0].text)
    const imageIds: string[] = descriptor.input.images.map((image: { imageVersionId: string }) => image.imageVersionId)
    this.lastRoles = descriptor.input.images.map((image: { role: string }) => image.role)
    this.reviewedChecks.push(...descriptor.input.rules.map((rule: { check: { kind: string } }) => rule.check.kind))
    const output = descriptor.input.operation === 'review' || descriptor.input.stage !== undefined
      ? { ruleResults: descriptor.input.rules.map((rule: { ruleId: string }) => ({ ruleId: rule.ruleId, status: this.reviewStatus, source: 'inferred', reason: 'Fixture review result.', evidenceImageVersionIds: imageIds })), cropPotential: 'direct', preferenceScores: [{ dimension: 'color', score: 1 }], taskRelevance: 'relevant' }
      : { observations: imageIds.map(imageVersionId => ({ imageVersionId, dimensions: [{ dimension: 'color', observation: 'Warm palette may be present.', uncertain: true }] })), suggestedRules: [{ statement: 'Prefer warm color when applicable.', dimension: 'color', strength: 'preferred', stage: 'source', supportImageVersionIds: imageIds, counterImageVersionIds: [], condition: '', exceptions: [] }] }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: this.calls === this.failAtCall ? 'invalid model JSON' : JSON.stringify(output) }, finish_reason: 'stop' }] })) }
  }
}
class ObservationFailureAdapter extends MemoryDomainAdapter {
  failObservation = false
  override async writeManifest(manifest: AggregateManifest): Promise<void> {
    if (this.failObservation && manifest.records.some(record => record.kind === 'observation')) {
      this.failObservation = false
      throw new Error('Crash after model response commit and before observation checkpoint')
    }
    await super.writeManifest(manifest)
  }
}

test('data tasks preserve human authorship, replay committed model responses and export frozen feedback heads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'curator-data-worker-'))
  try {
    const files = new AssetFiles(root, { maxFileBytes: 100000, maxPixels: 1000000, maxDimension: 1000, previewMaxDimension: 100, maxStorageBytes: 1000000 })
    const adapter = new ObservationFailureAdapter()
    const repository = new DomainRepository(actor.profileId, adapter)
    const domain = new CuratorDomain(actor.profileId, repository, { verifyImage: async image => { await files.read(image.blob) } })
    const bytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: 'orange' } }).png().toBuffer()
    const media = importedRecords(actor.profileId, actor, await files.importBytes(bytes), { kind: 'local-import', description: 'fixture' })
    await repository.commit({ aggregateId: 'media', expectedRevision: 0, operationId: 'media', request: {}, records: media.records, state: {} })
    const style = await domain.createStyle({ name: 'Warm', operationId: 'style' }, actor)
    const reference = await domain.confirmReference({ styleId: style.id, imageVersionId: media.image.id, role: 'positive', intent: { kind: 'dimensions', dimensions: ['color'] }, context: {}, viewEvidence: [{ imageVersionId: media.image.id, versionKind: 'normalized' }], operationId: 'reference' }, actor)
    const recipe = recipeSchema.parse({ schemaVersion: 1, profileId: actor.profileId, id: 'recipe', kind: 'recipe', createdAt: new Date().toISOString(), visionRevision: 'vision-1', model: 'fixture', vendorVersion: null, promptVersion: '1', outputSchemaVersion: '1', preprocessingVersion: files.processorVersion, referenceStrategy: { maxImages: 4, maxBytes: 100000 }, preferenceScale: { min: 0, max: 1, weights: { color: 1 } }, unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
    await domain.saveDraft({ styleId: style.id, expectedRevision: 1, operationId: 'draft', rules: [], referenceIds: [reference.id], feedbackIds: [], conflicts: [], recipe }, actor)
    const draft = domain.require('draft', style.draftId)
    const feedbackBefore = repository.list('feedback').length
    const http = new AnalysisHttp()
    const vision = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/v1/chat/completions', model: 'fixture', supportsMultiImage: true, maxImages: 4, maxImageBytes: 100000, maxRequestBytes: 1000000, maxOutputTokens: 2048, temperature: 0 }, http)
    const jobs = new FixtureJobs(), engine = new RunEngine(repository, jobs)
    const worker = createDataWorker({ domain, files, vision: async () => vision })
    const run = await engine.create({ kind: 'analyze', config: settingsSchema.parse({}), input: { styleId: style.id }, fixed: { draft: toJson(draft), references: toJson([reference]), feedback: toJson(domain.referenceJudgments(reference)), recipe: toJson(recipe) }, specDigest: contentDigest(draft) }, actor, worker)
    await jobs.hooks[0]!.done
    const saved = engine.get(run.id, actor)
    assert.equal(saved.status, 'completed')
    assert.equal(http.calls, 1)
    assert.equal(repository.list('observation').length, 1)
    assert.equal(repository.list('observation')[0]?.inferred[0]?.uncertain, true)
    assert.equal(repository.list('suggestion')[0]?.author.kind, 'model')
    assert.equal(repository.list('suggestion')[0]?.status, 'pending')
    assert.equal(repository.list('feedback').length, feedbackBefore)
    assert.deepEqual(domain.require('draft', draft.id).rules, [])
    assert.equal(dataOf(saved).resultIds.length, 2)

    const initialIntent = domain.referenceJudgments(reference)[0]!
    const revisedIntent = await domain.confirmFeedback({ operationId: 'revise-color-intent', subject: initialIntent.subject, context: initialIntent.context, judgment: { kind: 'dimension-verdict', dimension: 'color', value: 'reject' }, scope: 'style-candidate', expectedHead: initialIntent.id, viewEvidence: initialIntent.viewEvidence }, actor)
    await domain.confirmFeedback({ operationId: 'later-color-intent', subject: revisedIntent.subject, context: revisedIntent.context, judgment: { kind: 'dimension-verdict', dimension: 'color', value: 'accept' }, scope: 'style-candidate', expectedHead: revisedIntent.id, viewEvidence: revisedIntent.viewEvidence }, actor)
    adapter.failObservation = true
    const analyzeSpec = { kind: 'analyze' as const, config: settingsSchema.parse({}), input: { styleId: style.id }, fixed: { draft: toJson(draft), references: toJson([reference]), feedback: toJson([revisedIntent]), recipe: toJson(recipe) }, specDigest: contentDigest(draft) }
    const interrupted = await engine.create(analyzeSpec, actor, worker)
    await jobs.hooks[1]!.done
    assert.equal(engine.get(interrupted.id, actor).status, 'failed')
    const failed = engine.get(interrupted.id, actor)
    const restart = { ...failed, revision: failed.revision + 1, status: 'running' as const }
    await repository.commit({ aggregateId: `run:${failed.id}`, expectedRevision: failed.revision, operationId: 'simulate-restart', request: restart, records: [restart], state: {} })
    await engine.recover()
    await engine.control(failed.id, 'resume', actor, worker)
    await jobs.hooks[2]!.done
    assert.equal(engine.get(failed.id, actor).status, 'completed')
    assert.equal(http.calls, 2)
    const fixedRole = JSON.parse(http.lastRoles[0]!)
    assert.equal(fixedRole.judgments[0].judgment.kind, 'dimension-verdict')
    assert.equal(fixedRole.judgments[0].judgment.dimension, 'color')
    assert.equal(fixedRole.judgments[0].judgment.value, 'reject')
    assert.equal(fixedRole.judgments.some((item: { judgment: { kind: string } }) => item.judgment.kind === 'style-verdict'), false)

    const candidate = await domain.createCandidate({ operationId: 'candidate-one', styleId: style.id, expectedRevision: 2 }, actor)
    const release = await domain.publishStyle({ operationId: 'release-one', styleId: style.id, candidateId: candidate.id, expectedRevision: 3 }, actor)
    const comparisonCandidate = await domain.createCandidate({ operationId: 'unpublished-candidate', styleId: style.id, expectedRevision: 4 }, actor)
    const usage = await domain.createUsage({ operationId: 'usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 80, targetHeight: 80, allowUpscale: false, acceptedFormats: ['png'] }, protectedContent: [], safeRegions: [] }, actor)
    const comparisonBytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: 'blue' } }).png().toBuffer()
    const comparison = importedRecords(actor.profileId, actor, await files.importBytes(comparisonBytes), { kind: 'local-import', description: 'Independent comparison image' })
    await repository.commit({ aggregateId: 'comparison-image', expectedRevision: 0, operationId: 'comparison-image', request: {}, records: comparison.records, state: {} })
    await domain.confirmFamilies({ operationId: 'families', familyIds: [media.asset.familyId, comparison.asset.familyId] }, actor)
    const split = await domain.createSplit({ operationId: 'split', assignments: [{ familyId: media.asset.familyId, split: 'learning', groupingConfirmed: true }, { familyId: comparison.asset.familyId, split: 'development', groupingConfirmed: true }] }, actor)
    const feedback = await domain.confirmFeedback({ operationId: 'independent-label', subject: { kind: 'image', imageVersionId: comparison.image.id }, context: { styleId: style.id, standard: { kind: 'release', releaseId: release.id }, usage: { kind: 'revision', usageRevisionId: usage.id }, taskBriefDigest: contentDigest('compare') }, judgment: { kind: 'style-verdict', value: 'accept' }, scope: 'style-candidate', expectedHead: null, viewEvidence: [{ imageVersionId: comparison.image.id, versionKind: 'normalized' }] }, actor)
    const evaluation = await engine.create({ kind: 'evaluate', config: settingsSchema.parse({}), input: { leftId: release.id, rightId: comparisonCandidate.id, splitId: split.id, usageRevisionId: usage.id }, fixed: { left: toJson(release), right: toJson(comparisonCandidate), split: toJson(split), usage: toJson(usage), feedback: toJson([feedback]), humanActor: toJson(actor), images: toJson([comparison.image]) }, specDigest: contentDigest('comparison') }, actor, worker)
    await jobs.hooks[3]!.done
    assert.equal(engine.get(evaluation.id, actor).status, 'completed')
    const report = domain.require('evaluation', dataOf(engine.get(evaluation.id, actor)).resultIds[0]!)
    assert.equal(report.right.kind, 'candidate')
    assert.equal(report.items[0]?.humanLabel, 'accept')
    assert.equal(report.metrics['right.acceptance']?.status, 'available')
    assert.equal(report.metrics['right.cropDamage']?.status, 'unavailable')
    assert.equal(domain.require('style', style.id).defaultReleaseId, null)
    const candidateAssessments = repository.list('assessment').filter(record => record.standard?.kind === 'candidate')
    assert.equal(candidateAssessments.length, 2)
    assert.equal(candidateAssessments.every(record => record.releaseId === undefined), true)

    await domain.confirmFeedback({ operationId: 'revise-independent-label', subject: feedback.subject, context: feedback.context, judgment: { kind: 'style-verdict', value: 'reject' }, scope: 'style-candidate', expectedHead: feedback.id, viewEvidence: feedback.viewEvidence }, actor)
    const exported = await engine.create({ kind: 'export', config: settingsSchema.parse({}), input: { operationId: 'fixed-export', exportKind: 'classification', purpose: 'development', releaseId: release.id, usageRevisionId: usage.id, splitId: split.id }, fixed: { actor: toJson(actor), feedbackHeads: [feedback.id] }, specDigest: contentDigest('export') }, actor, createDataWorker({ domain, files, vision: async () => { throw new Error('Offline export must not require vision') } }))
    await jobs.hooks[4]!.done
    assert.equal(engine.get(exported.id, actor).status, 'completed')
    const pack = domain.require('export', dataOf(engine.get(exported.id, actor)).resultIds[0]!)
    assert.deepEqual(pack.feedbackIds, [feedback.id])
    assert.match(pack.files.find(file => file.name === 'classification.jsonl')?.content ?? '', /"value":"accept"/)

    const moreBytes = await sharp({ create: { width: 80, height: 80, channels: 3, background: 'green' } }).png().toBuffer()
    const more = importedRecords(actor.profileId, actor, await files.importBytes(moreBytes), { kind: 'local-import', description: 'Second independent comparison image' })
    await repository.commit({ aggregateId: 'more-image', expectedRevision: 0, operationId: 'more-image', request: {}, records: more.records, state: {} })
    await domain.confirmFamilies({ operationId: 'more-family', familyIds: [more.asset.familyId] }, actor)
    const budgetSplit = await domain.createSplit({ operationId: 'budget-split', assignments: [...split.assignments, { familyId: more.asset.familyId, split: 'development', groupingConfirmed: true }] }, actor)
    const moreFeedback = await domain.confirmFeedback({ operationId: 'more-label', subject: { kind: 'image', imageVersionId: more.image.id }, context: feedback.context, judgment: { kind: 'style-verdict', value: 'accept' }, scope: 'style-candidate', expectedHead: null, viewEvidence: [{ imageVersionId: more.image.id, versionKind: 'normalized' }] }, actor)
    http.failAtCall = http.calls + 3
    const limited = await engine.create({ kind: 'evaluate', config: settingsSchema.parse({ limits: { maxVisionCalls: 3, maxRetryAttempts: 0 } }), input: { leftId: release.id, rightId: comparisonCandidate.id, splitId: budgetSplit.id, usageRevisionId: usage.id }, fixed: { left: toJson(release), right: toJson(comparisonCandidate), split: toJson(budgetSplit), usage: toJson(usage), feedback: toJson([feedback, moreFeedback]), humanActor: toJson(actor), images: toJson([comparison.image, more.image]) }, specDigest: contentDigest('budget-comparison') }, actor, worker)
    await jobs.hooks[5]!.done
    const stopped = engine.get(limited.id, actor)
    assert.equal(stopped.status, 'completed')
    assert.equal(stopped.outcome, 'budget-exhausted')
    const partial = domain.require('evaluation', dataOf(stopped).resultIds[0]!)
    assert.equal(partial.executionOutcome, 'budget-exhausted')
    assert.equal(partial.items.length, 2)
    assert.equal(partial.items[0]?.left, 'pass')
    assert.equal(partial.items[0]?.right, 'technical-failed')
    assert.equal(partial.items[1]?.left, 'unprocessed')
    assert.equal(partial.items[1]?.right, 'unprocessed')
    assert.deepEqual(partial.metrics['left.recall'], { status: 'available', numerator: 1, denominator: 2, value: 0.5 })
    assert.deepEqual(partial.metrics['right.technicalFailure'], { status: 'available', numerator: 1, denominator: 2, value: 0.5 })
    assert.deepEqual(partial.metrics['right.unprocessed'], { status: 'available', numerator: 1, denominator: 2, value: 0.5 })

    const confirmation = { status: 'confirmed' as const, actor: { kind: 'authenticated-human' as const, id: actor.id, confirmationMethod: 'client-action' as const, confirmedAt: new Date().toISOString() } }
    const ruleBase = { dimension: 'color' as const, statement: 'Check actual pixels', condition: {}, strength: 'required' as const, exceptions: [], supportRefs: [], counterRefs: [], confirmation }
    const semanticRecipe = { ...recipe, id: recipe.id, preferenceScale: { ...recipe.preferenceScale, weights: { color: 1, lighting: 0 } } }
    // 新 recipe 使用独立 ID；已发布的 recipe 不可改写。
    const newRecipe = recipeSchema.parse({ ...semanticRecipe, id: 'semantic-recipe' })
    await domain.saveDraft({ operationId: 'semantic-draft', styleId: style.id, expectedRevision: 5, rules: [{ ...ruleBase, ruleId: 'unconditional', stage: 'source', check: { kind: 'visual', criterion: 'Natural color' } }, { ...ruleBase, ruleId: 'width', stage: 'final', check: { kind: 'measured', field: 'width', min: 80, tolerance: 0, unit: 'pixels' } }], referenceIds: [reference.id], feedbackIds: [], conflicts: [], recipe: newRecipe }, actor)
    const semanticCandidate = await domain.createCandidate({ operationId: 'semantic-candidate', styleId: style.id, expectedRevision: 6 }, actor)
    http.reviewStatus = 'not-applicable'; http.reviewedChecks = []
    const semantic = await engine.create({ kind: 'evaluate', config: settingsSchema.parse({}), input: { leftId: release.id, rightId: semanticCandidate.id, splitId: split.id, usageRevisionId: usage.id }, fixed: { left: toJson(release), right: toJson(semanticCandidate), split: toJson(split), usage: toJson(usage), feedback: toJson([feedback]), humanActor: toJson(actor), images: toJson([comparison.image]) }, specDigest: contentDigest('semantic-comparison') }, actor, worker)
    await jobs.hooks[6]!.done
    const semanticReport = domain.require('evaluation', dataOf(engine.get(semantic.id, actor)).resultIds[0]!)
    assert.equal(semanticReport.items[0]?.left, 'pass')
    assert.equal(semanticReport.items[0]?.right, 'needs-review')
    assert.deepEqual(http.reviewedChecks, ['visual'])
    const final = repository.list('assessment').find(a => a.runId === semantic.id && a.standard?.id === semanticCandidate.id && a.stage === 'final')!
    assert.equal(final.verdict, 'pass')
    assert.equal(final.ruleResults[0]?.basis, 'measured')
  } finally { await rm(root, { recursive: true, force: true }) }
})
