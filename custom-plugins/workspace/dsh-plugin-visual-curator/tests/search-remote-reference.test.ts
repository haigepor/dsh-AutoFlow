import assert from 'node:assert/strict'
import { test } from 'node:test'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'
import { resolveConfig } from '../src/host/config.ts'
import { dataOf, specOf } from '../src/host/runtime.ts'
import { UnsplashApi } from '../src/media/unsplash.ts'
import { styleSummarySchema } from '../src/shared/style-analysis.ts'
import { modelProfileSchema } from '../src/shared/model.ts'
import { contentDigest } from '../src/domain/repository.ts'

const identity = z.object({ id: z.string() }), taskIdentity = z.object({ runId: z.string() })
const requestBody = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough())]) })) })
const promptSchema = z.object({ operation: z.string(), taskBrief: z.string(), stage: z.string().optional(), images: z.array(z.object({ imageVersionId: z.string(), remoteUrl: z.string().optional() })) })
const responseSchema = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })) })
type Prompt = z.infer<typeof promptSchema>

async function analyzed(remote: boolean, grouped = false) {
  const unsplash = resolveConfig({ source: { unsplash: { accounts: [{ id: 'a', label: 'A', credentialRef: 'COOKIE_A', userId: 'user-a', username: 'owner-a', name: 'A' }] } } }).source.unsplash
  const api = new UnsplashApi({ request: async path => path === '/me'
    ? { id: 'user-a', username: 'owner-a', name: 'A', total_collections: 1 }
    : { id: 'park', width: 400, height: 200, urls: { small: 'https://images.unsplash.com/reference?w=200', regular: 'https://images.unsplash.com/reference?w=1080' } } })
  let referenceDownloads = 0
  const f = await serviceFixture(undefined, {}, { galleryApi: async () => api, galleryMedia: { request: async () => { referenceDownloads++; throw new Error('Reference registration must not download pixels') } } }, remote ? { provider: 'unsplash', unsplash } : {})
  const prompts: Prompt[] = [], request = f.http.request.bind(f.http)
  f.http.request = async (url, input) => {
    if (!url.startsWith('https://vision.example.test')) return await request(url, input)
    const body = requestBody.parse(JSON.parse(Buffer.from(input.body ?? []).toString('utf8')))
    const content = body.messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(content))
    const prompt = z.object({ input: promptSchema }).parse(JSON.parse(content[0]?.text ?? '{}')).input
    prompts.push(prompt)
    const response = await request(url, input)
    if (!grouped || prompt.operation !== 'summarize') return response
    const envelope = responseSchema.parse(JSON.parse(response.bytes.toString('utf8')))
    const summary = styleSummarySchema.parse(JSON.parse(envelope.choices[0]!.message.content))
    const result = { ...summary, organization: {
      groups: [{ groupId: 'muted', name: 'Muted style', description: 'A transferable muted palette.', imageVersionIds: summary.dimensions[0]!.supportImageVersionIds }],
      selections: summary.suggestedRules.map((_, ruleIndex) => ({ ruleIndex, enabled: true, groupId: 'muted', reason: 'Supported alternative style.' })),
    } }
    return { ...response, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })) }
  }
  await f.service.initialize()
  try {
    const { id: styleId } = identity.parse(await f.action('style-create', { operationId: 'search-style', name: 'Search reference fixture' }))
    if (remote) await f.action('gallery-import', { operationId: 'remote-reference', transferId: 'remote-transfer', mode: 'remote-reference', accountId: 'a', styleId, expectedRevision: 1, photoIds: ['park'], role: 'positive' })
    else await f.action('reference-import', { operationId: 'byte-reference', styleId, expectedRevision: 1, files: [{ name: 'reference.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const { runId: analysisRunId } = taskIdentity.parse(await f.action('reference-analyze', { operationId: 'analyze-reference', styleId, buildDataset: true }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', analysisRunId).status, 'completed')
    const profile = f.repository.list('modelProfile')[0]!
    assert.ok(profile)
    const { id: usageRevisionId } = identity.parse(await f.action('usage-create', { operationId: 'square-usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }))
    return { f, profile, styleId, analysisRunId, usageRevisionId, prompts, referenceDownloads: () => referenceDownloads }
  } catch (error) {
    await f.cleanup()
    throw error
  }
}

test('a remotely referenced collection completes candidate review and final selection without copying its reference pixels', async () => {
  const { f, profile, usageRevisionId, prompts, referenceDownloads } = await analyzed(true)
  try {
    const reference = f.domain.require('imageVersion', profile.references[0]!.reference.imageVersionId)
    const before = contentDigest(reference)
    const { runId } = taskIdentity.parse(await f.action('search-start', { operationId: 'remote-search', releaseId: profile.id, usageRevisionId, sourceId: 'unsplash', taskBrief: 'Muted green scenery', targetCount: 1 }))
    await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.outcome, 'target-met', JSON.stringify({ counts: dataOf(run).counts, warnings: dataOf(run).warnings, error: dataOf(run).error }))
    assert.equal(f.repository.list('selection').filter(selection => selection.runId === runId && selection.qualification === 'auto-qualified').length, 1)
    const final = prompts.filter(prompt => prompt.operation === 'review' && prompt.stage === 'final')
    assert.ok(final.length > 0, 'Qualified output must have actual final-image visual review')
    assert.ok(final.every(prompt => prompt.images.some(image => image.imageVersionId === reference.id && image.remoteUrl === reference.blob.remoteSource?.url)))
    assert.equal(referenceDownloads(), 0)
    assert.equal(contentDigest(f.domain.require('imageVersion', reference.id)), before)
    assert.equal(reference.versionKind, 'remote-reference')
    assert.equal(f.domain.require('asset', reference.assetId).originalBlob, undefined)
  } finally { await f.cleanup() }
})

test('candidate screening, crop planning and final review retain the frozen matching prompt and alternative rule groups', async () => {
  const { f, profile, usageRevisionId, prompts } = await analyzed(false, true)
  try {
    const { runId } = taskIdentity.parse(await f.action('search-start', { operationId: 'grouped-search', releaseId: profile.id, usageRevisionId, sourceId: 'images', taskBrief: 'Muted green scenery', queries: ['green'], targetCount: 1 }))
    await f.jobs.drain()
    assert.equal(f.domain.require('run', runId).outcome, 'target-met')
    const candidateRequests = prompts.filter(prompt => prompt.operation === 'review' || prompt.operation === 'propose-crop')
    assert.equal(candidateRequests.filter(prompt => prompt.operation === 'review' && prompt.stage === 'source').length, 1, 'The crop subflow must reuse the committed source assessment for the same candidate and frozen standard')
    assert.ok(candidateRequests.some(prompt => prompt.stage === 'final'))
    assert.ok(candidateRequests.some(prompt => prompt.operation === 'propose-crop'))
    for (const prompt of candidateRequests) {
      const context = z.object({ matchingPrompt: z.string(), groups: modelProfileSchema.shape.groups, ruleGroups: z.array(z.object({ ruleId: z.string(), groupId: z.string().nullable() })) }).safeParse(JSON.parse(prompt.taskBrief))
      assert.ok(context.success, `${prompt.operation}:${prompt.stage ?? 'planning'} must receive the saved matching prompt and group context`)
      assert.equal(context.data.matchingPrompt, profile.matchingPrompt)
      assert.deepEqual(context.data.groups, profile.groups)
      assert.deepEqual(context.data.ruleGroups, profile.options.filter(option => option.enabled).map(option => ({ ruleId: option.rule.ruleId, groupId: option.groupId })))
    }
  } finally { await f.cleanup() }
})

test('editing the current profile while retrieval is blocked leaves the accepted search standard unchanged', async () => {
  const { f, profile, styleId, analysisRunId, usageRevisionId } = await analyzed(false)
  let enterSearch = () => {}, continueSearch = () => {}
  const entered = new Promise<void>(resolve => { enterSearch = resolve }), permit = new Promise<void>(resolve => { continueSearch = resolve })
  const request = f.http.request.bind(f.http)
  f.http.request = async (url, input) => {
    if (url.startsWith('https://source.example.test')) { enterSearch(); await permit }
    return await request(url, input)
  }
  try {
    const { runId } = taskIdentity.parse(await f.action('search-start', { operationId: 'frozen-search', releaseId: profile.id, usageRevisionId, sourceId: 'images', taskBrief: 'Muted green scenery', queries: ['green'], targetCount: 1 }))
    await entered
    const { id: updatedId } = identity.parse(await f.action('profile-save', { operationId: 'edit-during-search', styleId, analysisRunId, expectedProfileId: profile.id, changes: [{ ruleId: profile.options[0]!.rule.ruleId, enabled: true, statement: 'Prefer a different palette for future tasks.' }] }))
    assert.notEqual(updatedId, profile.id)
    continueSearch()
    await f.jobs.drain()
    const run = f.domain.require('run', runId)
    assert.equal(run.outcome, 'target-met')
    assert.deepEqual(modelProfileSchema.parse(specOf(run).fixed.release), profile)
    assert.ok(f.repository.list('assessment').some(assessment => assessment.runId === runId && assessment.standard?.id === profile.id))
    assert.equal(f.domain.require('modelProfile', profile.id).contentDigest, profile.contentDigest)
  } finally { continueSearch(); await f.cleanup() }
})
