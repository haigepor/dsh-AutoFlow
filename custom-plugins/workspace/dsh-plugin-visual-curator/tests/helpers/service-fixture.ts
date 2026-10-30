/** Keyless integration fixture: production business workflows with explicit in-process HTTP responses. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JobRegistry, JobId, JobHooks } from '@deepseek-ai/dsh-jobs'
import { CuratorDomain } from '../../src/domain/curator.ts'
import { DomainRepository, MemoryDomainAdapter } from '../../src/domain/repository.ts'
import { CuratorService, type CuratorHost, type CuratorServiceDependencies } from '../../src/host/service.ts'
import { resolveConfig, type Limits, type CuratorConfig } from '../../src/host/config.ts'
import { CompatibleVisionProvider, SourceHttpProvider, type HttpClient, type HttpRequest, type HttpResponse } from '../../src/media/index.ts'
import type { DomainActor, Json } from '../../src/shared/model.ts'

export class FixtureJobs implements Pick<JobRegistry, 'start'> {
  readonly hooks: JobHooks[] = []
  start: JobRegistry['start'] = spec => {
    const id = brandString<JobId>(`fixture-job-${this.hooks.length}`)
    this.hooks.push(spec.run({ id, append: () => {}, updateProgress: () => {} }))
    return id
  }
  async drain(): Promise<void> { await Promise.all(this.hooks.map(hook => hook.done)) }
}
const envelope = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]) })) })
const promptSchema = z.object({ input: z.object({ operation: z.string(), taskBrief: z.string(), stage: z.string().optional(), analysisOutput: z.literal('observations-only').optional(), images: z.array(z.object({ imageVersionId: z.string() })), rules: z.array(z.object({ ruleId: z.string() })) }) })

/** Actual adapter input is parsed, so fixtures exercise messages, image bytes and strict output schemas. */
export class FixtureHttp implements HttpClient {
  readonly operations: string[] = []
  mode: 'pass' | 'reject-final' | 'bad-json' | 'foreign-summary-evidence' | 'incomplete-analysis' = 'pass'
  readonly summaryInputs: string[] = []
  image: Buffer = Buffer.alloc(0)
  async request(url: string, request: HttpRequest): Promise<HttpResponse> {
    request.signal?.throwIfAborted()
    if (url.startsWith('https://images.example.test')) return { status: 200, headers: { 'content-type': 'image/png' }, bytes: this.image }
    if (url.startsWith('https://source.example.test')) return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ items: [{ id: 'one', previewUrl: 'https://images.example.test/preview', originalUrl: 'https://images.example.test/original' }], nextCursor: null })) }
    const messages = envelope.parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8'))).messages
    const content = messages.find(message => message.role === 'user')?.content
    if (!Array.isArray(content)) throw new Error('Expected model image content')
    const prompt = promptSchema.parse(JSON.parse(content[0]?.text ?? '{}')).input
    this.operations.push(`${prompt.operation}:${prompt.stage ?? ''}`)
    const dimensions = ['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth']
    let result: Json
    if (prompt.operation === 'analyze') result = { observations: prompt.images.map(image => ({ imageVersionId: image.imageVersionId, dimensions: [{ dimension: 'color', observation: 'A muted green palette is visible.', uncertain: false }] })), ...(prompt.analysisOutput === 'observations-only' ? {} : { suggestedRules: [{ statement: 'Use muted green colors.', dimension: 'color', strength: 'preferred', stage: 'source', supportImageVersionIds: prompt.images.map(image => image.imageVersionId), counterImageVersionIds: [], condition: '', exceptions: [] }] }) }
    else if (prompt.operation === 'summarize') {
      this.summaryInputs.push(prompt.taskBrief)
      const samples = z.object({ samples: z.array(z.object({ imageVersionId: z.string() })) }).parse(JSON.parse(prompt.taskBrief)).samples
      const evidence = this.mode === 'foreign-summary-evidence' ? ['unseen-image'] : samples.map(sample => sample.imageVersionId)
      result = { name: 'Muted green', summary: 'Soft lighting with muted greens.', matchingPrompt: 'Prefer muted green palettes and soft light; inspect actual candidate pixels.', searchHints: ['muted green landscape'], avoidTerms: ['neon'], dimensions: [{ dimension: 'color', description: 'Muted greens are shared across positive examples.', consistency: 'consistent', supportImageVersionIds: evidence, counterImageVersionIds: [] }], conflicts: [], suggestedRules: [{ statement: 'Use muted green colors.', dimension: 'color', strength: 'preferred', stage: 'source', supportImageVersionIds: evidence, counterImageVersionIds: [], condition: '', exceptions: [] }] }
    }
    else if (prompt.operation === 'propose-crop') result = { feasibility: 'feasible', reason: 'Central subject fits the requested output.', candidates: [{ requestedRect: { x: 0.25, y: 0, width: 0.5, height: 1 }, reason: 'Retains the subject.', protectedContent: 'preserved' }] }
    else result = { ruleResults: prompt.rules.map(rule => ({ ruleId: rule.ruleId, status: this.mode === 'reject-final' && prompt.stage === 'final' ? 'violated' : 'satisfied', source: 'inferred', reason: 'Fixture result from supplied actual pixels.', evidenceImageVersionIds: [prompt.images[0]?.imageVersionId ?? 'missing'] })), cropPotential: 'crop-candidate', preferenceScores: dimensions.map(dimension => ({ dimension, score: 0.8 })), taskRelevance: 'relevant' }
    if (this.mode === 'incomplete-analysis' && prompt.operation === 'analyze') result = { observations: [], ...(prompt.analysisOutput === 'observations-only' ? {} : { suggestedRules: [] }) }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: this.mode === 'bad-json' ? 'invalid JSON' : JSON.stringify(result) }, finish_reason: 'stop' }] })) }
  }
}

/** @param directory Optional already-private dsh profile path for browser fixtures. @param limits Validated deployment limits for the scenario. @param selection Same-process external adapter fixtures. @param sourceSettings Source settings for account and provider cases. @returns Real service, inspectable records and safe teardown. */
export async function serviceFixture(directory?: string, limits: Partial<Limits> = {}, selection: Pick<CuratorServiceDependencies, 'nativeSessions' | 'pickLocalPaths' | 'galleryApi' | 'galleryMedia' | 'launchGalleryLogin'> = {}, sourceSettings: Partial<CuratorConfig['source']> = {}) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'visual-service-'))
  const profileId = createHash('sha256').update(resolve(root)).digest('hex')
  const repository = new DomainRepository(profileId, new MemoryDomainAdapter()), jobs = new FixtureJobs(), http = new FixtureHttp()
  http.image = await sharp({ create: { width: 400, height: 200, channels: 3, background: '#536f53' } }).png().toBuffer()
  const config = resolveConfig({ source: { endpoint: 'https://source.example.test/search', credentialRef: '', ...sourceSettings }, vision: { backend: 'compatible', endpoint: 'https://vision.example.test/chat', model: 'fixture', credentialRef: '', vendorVersion: 'fixture-v1' }, limits: { maxRetryAttempts: 0, maxImportBytes: 1_000_000, maxReferenceBytes: 1_000_000, maxVisionCalls: 40, maxSearchPages: 4, maxCropCandidatesPerImage: 2, ...limits } })
  const provider = new CompatibleVisionProvider({ endpoint: config.vision.endpoint, model: config.vision.model, supportsMultiImage: true, maxImages: 10, maxImageBytes: 1_000_000, maxRequestBytes: 10_000_000, maxOutputTokens: 4000, temperature: 0, declaredModelVersion: 'fixture-v1' }, http)
  const source = new SourceHttpProvider({ endpoint: config.source.endpoint, method: 'GET', request: { query: 'q', cursor: 'cursor', pageSize: 'limit' }, response: { items: '/items', id: '/id', previewUrl: '/previewUrl', originalUrl: '/originalUrl', nextCursor: '/nextCursor' }, maxPageSize: 20 }, http)
  const host: CuratorHost = { profileContext: { dir: root }, jobs, sessions: { get: () => undefined }, credentials: { resolve: async () => undefined, set: async () => { throw new Error('Fixture credential writes require an explicit observer') } }, storageDomain: { open: async () => { throw new Error('Fixture uses an explicit memory domain') } }, configEditor: { entries: () => [], edit: async () => { throw new Error('Profile editing is unavailable in this isolated fixture') } } }
  let domain!: CuratorDomain
  const service = new CuratorService(host, config, { ...selection, openDomain: async files => { domain = new CuratorDomain(profileId, repository, { verifyImage: async image => { await files.verifyReference(image.blob) } }); return domain }, providers: { source: async () => source, vision: async () => provider, media: () => http } })
  const actor: DomainActor = { kind: 'human', id: 'fixture-owner', profileId }
  const action = async (operation: string, args: Record<string, Json> = {}) => service.action({ operation, args }, actor, new AbortController().signal)
  return { root, profileId, service, jobs, http, repository, actor, action, host, get domain() { return domain }, cleanup: async () => { await service.dispose(); if (!directory) await rm(root, { recursive: true, force: true }) } }
}
