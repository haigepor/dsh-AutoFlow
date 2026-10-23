/** Profile-launched recorded-session fixture; only HTTP, clock and UUID entropy are fixed. */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { mock } from 'node:test'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { JobHooks } from '@deepseek-ai/dsh-jobs'
import sharp from 'sharp'
import { CuratorDomain, DomainRepository, MemoryDomainAdapter, recipeSchema, contentDigest, runSchema } from '../../src/domain/index.ts'
import { CuratorService, type CuratorHost } from '../../src/host/service.ts'
import { resolveConfig, reviewerRevision } from '../../src/host/config.ts'
import { createAgentTools } from '../../src/host/tools.ts'
import { CompatibleVisionProvider, SourceHttpProvider } from '../../src/media/index.ts'
import { FixtureHttp } from '../helpers/service-fixture.ts'
import type { DomainActor } from '../../src/shared/model.ts'

export const name = 'visual-curator-session-fixture'
export const inject = ['jobs', 'sessions', 'sessionPersistence', 'tools']

/** @param ctx Shipped headless profile services. @returns Seeded provider and real Agent tool registrations. */
export async function apply(ctx: Context): Promise<void> {
  try { await mount(ctx) } catch (error) { process.stderr.write(`${String(error)}\n`); throw error }
}
async function mount(ctx: Context): Promise<void> {
  let sequence = 0
  const uuid = mock.method(crypto, 'randomUUID', () => `${(++sequence).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`)
  syncBuiltinESMExports()
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T00:00:00Z') })
  ctx.effect(() => () => { mock.timers.reset(); uuid.mock.restore(); syncBuiltinESMExports() }, 'Snapshot entropy scope')
  const sessionId = SessionId('visual-curator-recorded-session')
  const handle = await ctx.sessionPersistence.create({ id: sessionId, version: SESSION_FORMAT_VERSION, createdAt: 0, cwd: process.cwd(), isSeeded: false, delegationDepth: 0 })
  await handle.flush()
  await handle.close()
  const repository = new DomainRepository('visual-curator-snapshot', new MemoryDomainAdapter())
  const http = new FixtureHttp()
  http.image = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#536f53' } }).png().toBuffer()
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test/search', credentialRef: '' }, vision: { endpoint: 'https://vision.example.test/chat', model: 'fixture', credentialRef: '', vendorVersion: 'fixture-v1' }, limits: { maxRetryAttempts: 0, maxImportBytes: 1_000_000, maxReferenceBytes: 1_000_000, maxVisionCalls: 40, maxSearchPages: 4, maxCropCandidatesPerImage: 2 } })
  const vision = new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: config.vision.model, supportsMultiImage: true, maxImages: 10, maxImageBytes: 1_000_000, maxRequestBytes: 10_000_000, maxOutputTokens: 4000, temperature: 0, declaredModelVersion: 'fixture-v1' }, http)
  const source = new SourceHttpProvider({ endpoint: config.source.endpoint, method: 'GET', request: { query: 'q', cursor: 'cursor', pageSize: 'limit' }, response: { items: '/items', id: '/id', previewUrl: '/previewUrl', originalUrl: '/originalUrl', nextCursor: '/nextCursor' }, maxPageSize: 20 }, http)
  const hooks: JobHooks[] = []
  const host: CuratorHost = { profileContext: { dir: join(process.cwd(), '.dsh/profiles/headless') }, storageDomain: { open: async () => { throw new Error('Recorded fixture uses its explicit memory domain') } }, configEditor: { entries: () => [], edit: async () => { throw new Error('Recorded fixture never edits deployment configuration') } }, sessions: ctx.sessions, credentials: { resolve: async () => undefined }, jobs: { start: spec => ctx.jobs.start({ ...spec, run: job => { const hook = spec.run(job); hooks.push(hook); return hook } }) } }
  class SnapshotService extends CuratorService { override readonly profileId = 'visual-curator-snapshot' }
  let domain!: CuratorDomain
  let processorVersion = ''
  const service = new SnapshotService(host, config, { openDomain: async files => { processorVersion = files.processorVersion; domain = new CuratorDomain('visual-curator-snapshot', repository, { verifyImage: async image => { await files.read(image.blob) } }); return domain }, providers: { source: async () => source, vision: async () => vision, media: () => http } })
  await service.initialize()
  ctx.effect(() => () => service.dispose(), 'Snapshot provider drain')
  const actor: DomainActor = { kind: 'human', id: 'fixture-human', profileId: service.profileId }
  const style = await domain.createStyle({ operationId: 'seed-style', name: 'Recorded muted green' }, actor)
  const recipe = { schemaVersion: 1 as const, kind: 'recipe' as const, id: 'snapshot-recipe', profileId: service.profileId, createdAt: new Date().toISOString(), visionRevision: reviewerRevision(config), model: config.vision.model, vendorVersion: config.vision.vendorVersion, promptVersion: 'visual-curator-v1', outputSchemaVersion: '1', preprocessingVersion: processorVersion, referenceStrategy: { maxImages: config.limits.maxReferenceImages, maxBytes: config.limits.maxReferenceBytes }, preferenceScale: { min: 0, max: 1, weights: { color: 1 } }, unknownPolicy: 'needs-review' as const, tieBreak: 'stable-id' as const }
  const parsedRecipe = recipeSchema.parse(recipe)
  await domain.saveDraft({ operationId: 'seed-draft', styleId: style.id, expectedRevision: 1, rules: [{ ruleId: 'final-color', dimension: 'color', statement: 'Preserve muted green in final pixels', condition: {}, exceptions: [], supportRefs: [], counterRefs: [], strength: 'required', stage: 'final', check: { kind: 'visual', criterion: 'Muted green colors' }, confirmation: { status: 'confirmed', actor: { kind: 'authenticated-human', id: actor.id, confirmationMethod: 'client-action', confirmedAt: new Date().toISOString() } } }], referenceIds: [], feedbackIds: [], conflicts: [], recipe: parsedRecipe }, actor)
  const candidate = await domain.createCandidate({ operationId: 'seed-candidate', styleId: style.id, expectedRevision: 2 }, actor)
  await domain.publishStyle({ operationId: 'seed-release', styleId: style.id, candidateId: candidate.id, expectedRevision: 3 }, actor)
  await domain.createUsage({ operationId: 'seed-usage', name: 'Square', output: { aspectP: 1, aspectQ: 1, targetWidth: 100, targetHeight: 100, acceptedFormats: ['png'], allowUpscale: false }, safeRegions: [], protectedContent: [] }, actor)
  const toolsFork = ctx.plugin({ name: 'visual-curator-recorded-tools', inject: ['tools'], apply(child) {
    for (const tool of createAgentTools(service)) child.effect(() => child.tools.register(tool), `Recorded ${tool.name}`)
  } })
  await toolsFork
  ctx.provide('visualCurator', service)
  // 仅统一本场景目录文字的分隔符，保留实际目录、生产目录校验及共享 corpus 规范化规则。
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.systemPrompt.context({
      name: 'working-directory:current', order: agent.ctx.systemPrompt.getContextOrder('WORKING_DIRECTORY'),
      required: true, interpolate: false,
      text: () => `Current working directory: ${JSON.stringify(process.cwd().replaceAll('\\', '/'))}.`,
    })
  })
  const initialFeedback = repository.list('feedback').length
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    await Promise.all(hooks.map(hook => hook.done))
    const call = agent.session.snapshotEvents().findLast(event => event.type === 'tool/call')
    if (call?.type === 'tool/call') {
      const id = call.data.callId
      if (id === 'search-pass' || id === 'search-rejected' || id === 'search-invalid') {
        const runId = contentDigest({ profileId: service.profileId, sessionId, operationId: id }).slice(10)
        const run = domain.require('run', runId)
        if (id === 'search-pass') assert.equal(run.outcome, 'target-met')
        if (id === 'search-rejected') assert.ok(repository.list('assessment').some(a => a.runId === run.id && a.stage === 'final' && a.verdict === 'reject'))
        if (id === 'search-invalid') assert.ok(repository.list('assessment').filter(a => a.runId === run.id).every(a => a.technicalStatus === 'failed' && a.verdict === undefined))
      }
      if (id === 'run-pass') {
        http.mode = 'reject-final'
        if (!repository.get('run', 'foreign-owned-run')) {
          const original = repository.list('run')[0]!
          const foreign = runSchema.parse({ ...original, id: 'foreign-owned-run', owner: { kind: 'session', sessionId: 'foreign-session' } })
          await repository.commit({ aggregateId: 'run:foreign-owned-run', operationId: 'seed-foreign-run', expectedRevision: 0, request: {}, records: [foreign], state: {} })
        }
      }
      if (id === 'run-rejected') http.mode = 'bad-json'
      if (id === 'forged-human') await toolsFork.dispose()
      if (id === 'disabled-tools') {
        assert.equal(repository.list('feedback').length, initialFeedback)
        assert.equal(repository.list('suggestion').length, 1)
        assert.equal(repository.list('suggestion')[0]?.author.kind, 'agent')
        assert.equal(ctx.tools.schemas().some(tool => tool.name.startsWith('visual_')), false)
      }
    }
    return next()
  })
}
