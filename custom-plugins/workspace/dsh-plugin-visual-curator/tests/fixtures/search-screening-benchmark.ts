/** Opt-in live diagnostic: public pixels, isolated production records, one selected native route and bounded calls. */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { LlmRuntime as LlmService, PreparedLlmCall } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '../../../../../packages/credentials/credentials-local/src/index.ts'
import LocalAttachmentStore from '../../../../../packages/attachment/attachment-local/src/index.ts'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as PiAi from '../../../../../packages/llm/llm-pi-ai/src/index.ts'
import { CuratorDomain } from '../../src/domain/curator.ts'
import { openCuratorRepository, contentDigest } from '../../src/domain/repository.ts'
import { NativeVisionProvider } from '../../src/host/native-vision.ts'
import { resolveConfig, visionSettingsSchema } from '../../src/host/config.ts'
import { RunEngine, dataOf, toJson, safeFailure, type ExecutionSpec } from '../../src/host/runtime.ts'
import { createSearchWorker } from '../../src/host/search-workflow.ts'
import { AssetFiles } from '../../src/media/index.ts'
import { GalleryMediaClient } from '../../src/media/media-routing.ts'
import { UnsplashApi, UnsplashSourceProvider } from '../../src/media/unsplash.ts'
import { CurlUnsplashTransport } from '../../src/media/unsplash-transport.ts'
import type { ImageSourceProvider, SourceItem } from '../../src/media/source.ts'
import { modelProfileSchema, recipeSchema, type Json } from '../../src/shared/model.ts'
import { FixtureJobs } from '../helpers/service-fixture.ts'

const require = createRequire(new URL('../../../../../packages/credentials/credentials-local/package.json', import.meta.url))
const yaml: { parseDocument(text: string, options: { customTags: { tag: string; resolve(value: string): string }[] }): { errors: readonly unknown[]; toJS(): unknown } } = require('yaml')
const object = z.record(z.string(), z.unknown())
const publicCorpusSchema = z.array(z.object({
  providerAssetId: z.string(), previewUrl: z.string().url(), thumbnailUrl: z.string().url().optional(),
  originalUrl: z.string().url().optional(), originalUnavailable: z.literal('restricted').optional(),
  width: z.number().int().positive(), height: z.number().int().positive(),
})).length(12).transform(items => items.map(item => ({ providerAssetId: item.providerAssetId, previewUrl: item.previewUrl,
  width: item.width, height: item.height, ...(item.thumbnailUrl === undefined ? {} : { thumbnailUrl: item.thumbnailUrl }),
  ...(item.originalUrl === undefined ? {} : { originalUrl: item.originalUrl }), ...(item.originalUnavailable === undefined ? {} : { originalUnavailable: item.originalUnavailable }),
})))
const taskBrief = 'Find environmental car portraits. A clearly visible car must be the dominant subject, with a road or forest as its environment.'
const query = 'car forest road'
const maxCalls = 40, maxElapsedMs = 600_000

function argument(name: string): string {
  const index = process.argv.indexOf(name), value = process.argv[index + 1]
  if (index < 0 || !value || value.startsWith('--')) throw new Error('A required diagnostic argument is missing.')
  return resolve(value)
}

function configurationRows(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(configurationRows)
  const row = object.safeParse(value)
  if (!row.success) return []
  return [row.data, ...Object.values(row.data).flatMap(configurationRows)]
}

async function selectedRoute(filename: string) {
  const document = yaml.parseDocument(await readFile(filename, 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => String(value) }],
  })
  if (document.errors.length) throw new Error('The profile could not be parsed without evaluation.')
  const rows = configurationRows(document.toJS())
  const named = (row: Record<string, unknown>, name: string) => [row.plugin, row.id, row.name].some(value => typeof value === 'string' && value.includes(name))
  const curator = rows.find(row => named(row, 'visual-curator') && object.safeParse(row.config).success && object.parse(row.config).vision)
  const vision = visionSettingsSchema.parse(object.parse(curator?.config).vision)
  if (vision.backend !== 'native' || !vision.provider || !vision.model || !vision.useModelDefaults) throw new Error('The selected native model defaults are required.')
  const provider = vision.provider
  const providers = rows.filter(row => named(row, 'llm-pi-ai')).flatMap(row => {
    const config = object.safeParse(row.config)
    const profiles = config.success ? object.safeParse(config.data.providers) : undefined
    return profiles?.success && profiles.data[provider] ? [object.parse(profiles.data[provider])] : []
  })
  if (providers.length !== 1) throw new Error('Exactly one selected native route is required.')
  const route = providers[0]!
  if (['apiKey', 'key', 'token', 'authorization'].some(key => Object.hasOwn(route, key))) throw new Error('The diagnostic accepts credential references only.')
  const ref = credentialRef(z.string().min(1).parse(route.apiKeyEnv))
  return { vision, provider, route, ref }
}

async function publicCorpus(directory: string): Promise<SourceItem[]> {
  const filename = join(directory, 'public-candidate-descriptors.json')
  try { return publicCorpusSchema.parse(JSON.parse(await readFile(filename, 'utf8'))) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const config = resolveConfig({ source: { provider: 'unsplash' } })
  const source = new UnsplashSourceProvider(new UnsplashApi(new CurlUnsplashTransport(undefined, {
    ...config.source.unsplash, maxRetryAttempts: 0,
  })))
  const page = await source.search({ query, pageSize: 20 }, null, { maxBytes: 4 * 1024 * 1024, timeoutMs: 30_000, maxRedirects: 3 })
  const candidates = publicCorpusSchema.parse(page.items.slice(0, 12))
  if (new Set(candidates.map(item => item.providerAssetId)).size !== 12) throw new Error('The public corpus must contain 12 unique images.')
  await writeFile(filename, JSON.stringify(candidates, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return candidates
}

function standard() {
  const base = { schemaVersion: 1, profileId: 'public-search-benchmark', createdAt: '2026-11-04T00:00:00.000Z' }
  const rules = [
    { ruleId: 'dominant-car', dimension: 'subject', statement: 'A clearly visible car is the dominant subject, not a tiny incidental object.', criterion: 'Inspect the actual car size, visibility and focal prominence.' },
    { ruleId: 'road-or-forest', dimension: 'composition', statement: 'The dominant car is situated on a road or in a forest environment.', criterion: 'A visible road or forest must surround the car; a studio car alone does not satisfy this rule.' },
  ].map(({ criterion, ...rule }) => ({ ...rule, condition: {}, strength: 'required', stage: 'source', check: { kind: 'visual', criterion }, exceptions: [], supportRefs: [], counterRefs: [], confirmation: { status: 'suggested' } }))
  const recipe = recipeSchema.parse({ ...base, id: 'public-recipe', kind: 'recipe', visionRevision: 'public-benchmark-v1', model: 'selected-native-model', vendorVersion: null,
    promptVersion: 'visual-curator-rules-v3', outputSchemaVersion: 'v1', preprocessingVersion: 'v1',
    referenceStrategy: { maxImages: 4, maxBytes: 4 * 1024 * 1024 }, preferenceScale: { min: 0, max: 1, weights: { subject: 1, composition: 1 } },
    unknownPolicy: 'needs-review', tieBreak: 'stable-id' })
  return modelProfileSchema.parse({ ...base, id: 'public-model-profile', kind: 'modelProfile', styleId: 'public-style', draftId: 'public-draft', draftRevision: 1,
    access: { kind: 'profile-library' }, analysisRunId: 'public-analysis', referenceDigest: contentDigest([]), contentDigest: contentDigest({ rules, recipe }), revision: 1,
    model: 'selected-native-model', matchingPrompt: taskBrief, rules, references: [], recipe, groups: [],
    options: rules.map(rule => ({ rule, enabled: true, groupId: null, selectionSource: 'model', sourceStatement: rule.statement, reason: 'consistent' })) })
}

const metadataSchema = z.object({
  bundle: z.object({ operation: z.string() }).passthrough().optional(),
  metadata: z.object({
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), cacheReadTokens: z.number().optional(), cacheWriteTokens: z.number().optional(), reasoningTokens: z.number().optional(), totalTokens: z.number().optional() }).optional(),
    timing: z.object({ elapsedMs: z.number(), preparationQueueMs: z.number().optional(), prepareImagesMs: z.number().optional(), modelElapsedMs: z.number().optional(), firstOutputMs: z.number().optional() }),
    request: z.object({ config: z.object({ maxTokens: z.number().optional() }).passthrough() }).optional(),
  }).passthrough().optional(),
}).passthrough()

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Live diagnostics require the explicit --live flag.')
  const profilePath = argument('--profile'), credentialsPath = argument('--credentials'), artifacts = argument('--artifacts')
  await mkdir(artifacts, { recursive: true })
  const credentialsBefore = createHash('sha256').update(await readFile(credentialsPath)).digest('hex')
  // The provider migrates pre-release flat files during activation; refuse that write-capable format.
  if (!/^version:\s*1\s*$/m.test(await readFile(credentialsPath, 'utf8'))) throw new Error('A current, non-migrating credential store is required.')
  const selected = await selectedRoute(profilePath), corpus = await publicCorpus(artifacts)
  const root = await mkdtemp(join(tmpdir(), 'visual-search-live-'))
  await writeFile(join(artifacts, 'isolated-runtime-location.json'), JSON.stringify({ root }) + '\n', 'utf8')
  const ctx = new Context(), lifetime = AbortSignal.timeout(maxElapsedMs)
  let actualCalls = 0
  try {
    await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, watch: false })
    if (!await ctx.credentials.resolve(selected.ref)) throw new Error('The selected credential reference is unavailable.')
    const boundedLlm = (runtime: LlmService): Pick<LlmService, 'prepareCall'> => ({ prepareCall: async (options, signal): Promise<PreparedLlmCall> => {
      lifetime.throwIfAborted()
      const prepared = await runtime.prepareCall(options, signal)
      return { ...prepared, stream: request => {
        lifetime.throwIfAborted()
        if (actualCalls >= maxCalls) throw new Error('The live model-call bound is exhausted.')
        actualCalls++
        return prepared.stream({ ...request, signal: AbortSignal.any([lifetime, ...(request.signal ? [request.signal] : [])]) })
      } }
    } })

    async function runCase(label: string, items: SourceItem[], screened: boolean) {
      lifetime.throwIfAborted()
      const caseRoot = join(root, label), carrier = new Context()
      await mkdir(caseRoot, { recursive: true })
      const beforeCalls = actualCalls
      let transferredBytes = 0, transferCalls = 0
      const config = resolveConfig({ source: { provider: 'unsplash' }, vision: {
        backend: 'native', provider: selected.provider, model: selected.vision.model, useModelDefaults: true,
        supportsMultipleImages: selected.vision.supportsMultipleImages, supportsJson: selected.vision.supportsJson,
      }, limits: { maxVisionCalls: maxCalls - actualCalls, maxSearchPages: 2, maxCandidates: 12, maxConcurrentRequests: 3,
        maxRetryAttempts: 0, retryDelayMs: 0, deadlineMs: maxElapsedMs, maxDownloadBytes: 128 * 1024 * 1024, maxReferenceBytes: 20 * 1024 * 1024 } })
      const media = new GalleryMediaClient(config.source.unsplash)
      let closeRepository: (() => Promise<void>) | undefined, engine: RunEngine | undefined
      try {
        await carrier.plugin(LocalAttachmentStore, { dshHome: caseRoot })
        carrier.provide('credentials', ctx.credentials)
        await carrier.plugin(LlmRuntime)
        // A diagnostic's wire-call bound cannot inherit a provider's hidden retries.
        await carrier.plugin(PiAi, { providers: { [selected.provider]: { ...selected.route, retryPolicy: { mode: 'normal', maxRetries: 0 } } } })
        await carrier.plugin(Storage)
        await carrier.plugin(StorageJson, { root: join(caseRoot, 'storage') })
        await carrier.plugin(StorageDomain, { backend: 'json' })
        const opened = await openCuratorRepository({ profileId: 'public-search-benchmark', facility: carrier.storageDomain, lockPath: join(caseRoot, 'curator.lock') })
        closeRepository = opened.close
        const repository = opened.repository, domain = new CuratorDomain('public-search-benchmark', repository), jobs = new FixtureJobs()
        const files = new AssetFiles(join(caseRoot, 'media'), { maxFileBytes: 20 * 1024 * 1024, maxPixels: 80_000_000, maxDimension: 20_000, previewMaxDimension: 1280, maxStorageBytes: 512 * 1024 * 1024 })
        const boundedMedia = { request: async (url: string, request: Parameters<typeof media.request>[1]) => {
          const response = await media.request(url, { ...request, signal: AbortSignal.any([lifetime, ...(request.signal ? [request.signal] : [])]) })
          transferredBytes += response.bytes.byteLength; transferCalls++
          return response
        } }
        const vision = new NativeVisionProvider(config, { llm: boundedLlm(carrier.llm), attachments: carrier.attachments, media: boundedMedia })
        await vision.preflight(lifetime)
        const source: ImageSourceProvider = { config: {},
          search: async () => ({ items, nextCursor: null }),
          lookup: async id => { const item = items.find(candidate => candidate.providerAssetId === id); if (!item) throw new Error('The fixed corpus identity is unavailable.'); return item } }
        const worker = createSearchWorker({ domain, files, source: async () => source, vision: async () => vision, media: () => boundedMedia,
          crop: async () => { throw new Error('The preview benchmark cannot crop or publish originals.') } })
        engine = new RunEngine(repository, jobs)
        const actor = { kind: 'human' as const, id: 'public-benchmark-owner', profileId: 'public-search-benchmark' }
        const fixed = { release: toJson(standard()), output: { kind: 'preview' }, ...(screened ? { searchScreening: { version: 1, candidatePoolSize: 50, batchSize: 6, maxScreeningImageEdge: 384 } } : {}) }
        const spec: ExecutionSpec = { kind: 'search', config, input: { taskBrief, queries: [query], targetCount: items.length }, fixed, specDigest: contentDigest({ label, fixed }) }
        const started = performance.now(), run = await engine.create(spec, actor, worker, label)
        await jobs.drain()
        const settled = engine.get(run.id, actor), data = dataOf(settled), wallMs = Math.round(performance.now() - started)
        const requests = repository.list('request').filter(request => request.runId === run.id)
        const visionRequests = requests.flatMap(request => { const parsed = metadataSchema.safeParse(request.data); return parsed.success && parsed.data.metadata ? [{ state: request.state, ...parsed.data }] : [] })
        const passed = new Set(repository.list('assessment').filter(item => item.runId === run.id && item.stage === 'final' && item.verdict === 'pass').map(item => repository.get('imageVersion', item.imageVersionId)?.assetId).flatMap(id => {
          const asset = id ? repository.get('asset', id) : undefined
          return asset?.source.kind === 'provider' ? [asset.source.providerAssetId] : []
        }))
        const state = z.object({ searchScreening: z.object({ screened: z.record(z.string(), z.object({ decision: z.string() }).passthrough()) }).passthrough().optional() }).parse(data.checkpoint)
        const rejected = new Set(Object.entries(state.searchScreening?.screened ?? {}).filter(([, result]) => result.decision === 'obvious-reject').map(([id]) => id))
        const tokenTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        const usageFieldReports = { ...tokenTotals }
        for (const request of visionRequests) for (const key of Object.keys(tokenTotals) as (keyof typeof tokenTotals)[]) {
          const value = request.metadata?.usage?.[key]
          if (value !== undefined) { tokenTotals[key] += value; usageFieldReports[key]++ }
        }
        const explicitRequestMaxTokens = [...new Set(visionRequests.flatMap(request => request.metadata?.request?.config.maxTokens === undefined ? [] : [request.metadata.request.config.maxTokens]))]
        const timings = visionRequests.map(request => ({ operation: request.bundle?.operation ?? 'unknown', ...request.metadata!.timing }))
        const sum = (key: 'preparationQueueMs' | 'prepareImagesMs' | 'modelElapsedMs') => timings.reduce((total, timing) => total + (timing[key] ?? 0), 0)
        const summary = toJson({ label, sourceCandidates: items.length, status: settled.status, outcome: settled.outcome ?? null, errorCode: data.error?.code ?? null,
          wallMs, actualCalls: actualCalls - beforeCalls, reservedVisionCalls: data.budget.vision, recordedVisionRequests: visionRequests.length,
          screenCalls: visionRequests.filter(request => request.bundle?.operation === 'screen').length, reviewCalls: visionRequests.filter(request => request.bundle?.operation === 'review').length,
          passed: passed.size, screeningRejected: data.counts.screeningRejected ?? 0, screeningFallback: data.counts.screeningFallback ?? 0, deepReviewed: data.counts.deepReviewed ?? 0,
          downloadedBytes: data.budget.downloadBytes, transferredBytes, transferCalls, tokenTotals, usageFieldReports, explicitRequestMaxTokens,
          tokenAccounting: 'Input and cache buckets are disjoint; pi-ai omits zero cache fields and folds reasoning into output.',
          callMeaning: 'Native stream dispatches; committed streams use one provider request with retries disabled.',
          timingSums: { preparationQueueMs: sum('preparationQueueMs'), prepareImagesMs: sum('prepareImagesMs'), modelElapsedMs: sum('modelElapsedMs') },
          timings, requestStates: requests.reduce<Record<string, number>>((counts, request) => { counts[request.state] = (counts[request.state] ?? 0) + 1; return counts }, {}) })
        if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) throw new Error('A benchmark summary must be a JSON object.')
        const result = { label, summary, passed, rejected }
        await writeFile(join(artifacts, label + '-aggregate.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
        console.log(JSON.stringify({ phase: label, ...summary }))
        if (settled.status !== 'completed' || visionRequests.some(request => request.state !== 'committed')) throw new Error('The live path did not finish with committed model evidence.')
        return result
      } finally {
        await engine?.dispose()
        await closeRepository?.()
        await media.dispose()
        await carrier.fiber.dispose()
      }
    }

    await runCase('preflight', corpus.slice(0, 1), false)
    if (!process.argv.includes('--preflight-only')) {
      const baseline = await runCase('legacy-single-final', corpus, false)
      const screened = await runCase('six-image-screening', corpus, true)
      const final = toJson({ measured: 'same-12-public-candidates-same-native-model-same-synthetic-rules', totalActualCalls: actualCalls, maxCalls, maxElapsedMs,
        sourceSetupIncluded: false, originalDownloadsIncluded: false, caseSetupIncluded: false, requestLogging: 'isolated production storage and attachments retained for replay',
        baseline: baseline.summary, screened: screened.summary, baselinePasses: baseline.passed.size,
        coarseRejectedBaselinePasses: [...baseline.passed].filter(id => screened.rejected.has(id)).length,
        finalPassedInBoth: [...baseline.passed].filter(id => screened.passed.has(id)).length,
        credentialsUnchanged: credentialsBefore === createHash('sha256').update(await readFile(credentialsPath)).digest('hex') })
      await writeFile(join(artifacts, 'native-screening-comparison.json'), JSON.stringify(final, null, 2) + '\n', 'utf8')
      console.log(JSON.stringify({ phase: 'comparison-complete', totalActualCalls: actualCalls }))
    }
  } finally { await ctx.fiber.dispose() }
}

await main().catch(error => {
  const failure = safeFailure(error)
  console.log(JSON.stringify({ phase: 'diagnostic-failed', code: failure.code, stage: failure.stage, retryable: failure.retryable }))
  process.exitCode = 1
})
