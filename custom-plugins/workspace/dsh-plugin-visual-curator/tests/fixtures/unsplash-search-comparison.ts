/** Compare full Unsplash search Runs against identical, keyless source, pixels and model fixtures. */
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import sharp from 'sharp'
import { z } from 'zod'
import { resolveCurrentConfig } from '../../src/host/config.ts'
import { dataOf, specOf } from '../../src/host/runtime.ts'
import { searchScreeningSummary } from '../../src/host/search-screening-state.ts'
import { UnsplashApi, UnsplashSourceProvider } from '../../src/media/unsplash.ts'
import { serviceFixture } from '../helpers/service-fixture.ts'

type CoarseDecision = 'obvious-reject' | 'deep-review' | 'uncertain'
type Photo = { id: string; pixel: number; expectedPass: boolean; coarse: CoarseDecision; alternateEncoding?: true; slow?: true }
type Transfer = { id: string; representation: 'small' | 'regular' | 'raw' }
type Metrics = {
  sourcePages: { query: string; page: number }[]
  lookups: string[]
  hostMedia: Transfer[]
  modelMedia: Transfer[]
  coarse: Map<number, CoarseDecision>
  modelCalls: { operation: 'screen' | 'review'; stage?: 'source' | 'final'; pixels: number[]; elapsedMs: number }[]
  selectedCommits: { imageVersionId: string; elapsedMs: number }[]
  startedAt: number
}

const slowTail = Array.from({ length: 54 }, (_, index): Photo => ({
  id: `latency-${index + 1}`, pixel: index + 1,
  expectedPass: index === 1 || index === 46,
  coarse: index === 1 || index === 46 ? 'deep-review' : 'obvious-reject',
  ...(index >= 36 ? { slow: true } : {}),
}))
const preview = [
  { id: 'preview-unique-a', pixel: 61, expectedPass: true, coarse: 'deep-review' },
  { id: 'preview-alias-a', pixel: 61, expectedPass: true, coarse: 'deep-review', alternateEncoding: true },
  { id: 'preview-negative', pixel: 62, expectedPass: false, coarse: 'uncertain' },
  { id: 'preview-unique-b', pixel: 63, expectedPass: true, coarse: 'deep-review' },
  { id: 'preview-missed', pixel: 64, expectedPass: true, coarse: 'obvious-reject' },
] satisfies Photo[]
const history = [
  { id: 'historical-reject', pixel: 71, expectedPass: false, coarse: 'uncertain' },
  { id: 'historical-pick', pixel: 72, expectedPass: true, coarse: 'deep-review' },
] satisfies Photo[]
const original = [
  ...history,
  { id: 'historical-pick-alias', pixel: 72, expectedPass: true, coarse: 'deep-review', alternateEncoding: true },
  { id: 'original-unique-a', pixel: 73, expectedPass: true, coarse: 'deep-review' },
  { id: 'original-alias-a', pixel: 73, expectedPass: true, coarse: 'deep-review', alternateEncoding: true },
  { id: 'original-negative', pixel: 74, expectedPass: false, coarse: 'uncertain' },
  { id: 'original-unique-b', pixel: 75, expectedPass: true, coarse: 'deep-review' },
] satisfies Photo[]
const originalBrief = 'Find simple studio photographs.'
const changedBrief = 'Find layered outdoor photographs.'
const contextPhotos = [
  { id: 'context-coarse-reject', pixel: 81, expectedPass: false, coarse: 'obvious-reject' },
  { id: 'context-final-reject', pixel: 82, expectedPass: false, coarse: 'uncertain' },
  { id: 'context-previous-pick', pixel: 83, expectedPass: true, coarse: 'deep-review' },
] satisfies Photo[]
const newContextPhotos = new Map<string, Photo>(contextPhotos.slice(0, 2).map(photo =>
  [photo.id, { ...photo, expectedPass: true, coarse: 'deep-review' }]))

const suite = new Map<string, Photo[][]>([
  ['green landscape', [slowTail.slice(0, 20), slowTail.slice(20, 40), slowTail.slice(40)]],
  ['preview aliases', [preview.slice(0, 3), [preview[0]!, ...preview.slice(3)]]],
  ['original history', [history]],
  ['original current', [original]],
  ['context change', [contextPhotos]],
])
const photosById = new Map([...suite.values()].flat(2).map(photo => [photo.id, photo]))
const photosByPixel = new Map([...photosById.values()].map(photo => [photo.pixel, photo]))
const identity = z.object({ id: z.string() })
const runIdentity = z.object({ runId: z.string() })
const briefSchema = z.object({ task: z.string() })
const prompt = z.object({ input: z.object({
  operation: z.enum(['screen', 'review']), stage: z.enum(['source', 'final']).optional(),
  taskBrief: z.string(),
  images: z.array(z.object({ imageVersionId: z.string() })).min(1),
  rules: z.array(z.object({ ruleId: z.string() })),
  screeningPolicy: z.object({ sharedRequiredRuleIds: z.array(z.string()) }).optional(),
}) })
const modelRequest = z.object({ messages: z.array(z.object({
  role: z.string(), content: z.union([z.string(), z.array(z.object({
    text: z.string().optional(), image_url: z.object({ url: z.string() }).optional(),
  }))]),
})) })
const configuredDelays = { sourceMs: 12, hostMediaMs: 4, modelMediaMs: 4, coarseMs: 28, slowCoarseMs: 700, deepMs: 42 }
const normalizeFixtureQuery = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase()

async function makePixels() {
  const bytes = new Map<string, Buffer>()
  for (const photo of photosById.values()) {
    const sample = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: photo.pixel, g: 140, b: 210 } } })
    bytes.set(`${photo.id}/small`, await sample(96, 64).png().toBuffer())
    const full = await sample(480, 320).png({ compressionLevel: photo.alternateEncoding ? 0 : 9 }).toBuffer()
    bytes.set(`${photo.id}/regular`, full)
    bytes.set(`${photo.id}/raw`, full)
  }
  assert.notDeepEqual(bytes.get('historical-pick/raw'), bytes.get('historical-pick-alias/raw'))
  assert.deepEqual(await sharp(bytes.get('historical-pick/raw')).raw().toBuffer(), await sharp(bytes.get('historical-pick-alias/raw')).raw().toBuffer())
  assert.notDeepEqual(bytes.get('preview-unique-a/regular'), bytes.get('preview-alias-a/regular'))
  const previewA = await sharp(bytes.get('preview-unique-a/regular')).raw().toBuffer()
  const nearPreview = await sharp(bytes.get('preview-unique-b/regular')).raw().toBuffer()
  assert.deepEqual(previewA, await sharp(bytes.get('preview-alias-a/regular')).raw().toBuffer())
  assert.equal(previewA.length, nearPreview.length)
  assert.equal(Math.abs(previewA[0]! - nearPreview[0]!), 2, 'The visually near positive has genuinely different pixels')
  return bytes
}

const elapsed = (start: number) => Math.round(performance.now() - start)
const sourceRepresentation = z.enum(['small', 'regular', 'raw'])
function transferOf(url: string): Transfer {
  const [, id, size] = new URL(url).pathname.split('/')
  assert.ok(id && photosById.has(id), 'Unexpected fixture media identity')
  return { id, representation: sourceRepresentation.parse(size) }
}
function photoResponse(photo: Photo) {
  const prefix = `https://images.unsplash.com/${photo.id}`
  return { id: photo.id, width: 480, height: 320, urls: { small: `${prefix}/small`, regular: `${prefix}/regular`, raw: `${prefix}/raw` } }
}

async function setup() {
  const media = await makePixels()
  const defaults = resolveCurrentConfig({ source: { provider: 'unsplash' } })
  const fixture = await serviceFixture(undefined, defaults.limits, {}, { provider: 'unsplash' })
  let metrics: Metrics | undefined
  const receive = (transfer: Transfer) => {
    const bytes = media.get(`${transfer.id}/${transfer.representation}`)
    assert.ok(bytes)
    return bytes
  }
  const provider = new UnsplashSourceProvider(new UnsplashApi({ async request(path, params, bounds) {
    assert.ok(metrics)
    await delay(configuredDelays.sourceMs, undefined, { signal: bounds.signal })
    if (path === '/search/photos') {
      const query = z.string().parse(params.query), page = z.number().int().positive().parse(params.page)
      metrics.sourcePages.push({ query, page })
      const pages = suite.get(normalizeFixtureQuery(query))
      assert.ok(pages, `Unexpected source query ${query}`)
      return { results: (pages[page - 1] ?? []).map(photoResponse), total_pages: pages.length }
    }
    const id = path.slice('/photos/'.length), photo = photosById.get(id)
    assert.ok(path.startsWith('/photos/') && photo)
    metrics.lookups.push(id)
    return photoResponse(photo)
  } }))
  const source = await fixture.providers.source()
  source.search = provider.search.bind(provider)
  source.lookup = provider.lookup.bind(provider)
  source.config.lookup = provider.config.lookup

  const baselineHttp = fixture.http.request.bind(fixture.http)
  fixture.http.request = async (url, request) => {
    if (!metrics) return await baselineHttp(url, request)
    const run = metrics
    if (url.startsWith('https://images.unsplash.com/')) {
      const transfer = transferOf(url)
      run.hostMedia.push(transfer)
      await delay(configuredDelays.hostMediaMs, undefined, { signal: request.signal })
      return { status: 200, headers: { 'content-type': 'image/png' }, bytes: receive(transfer) }
    }
    assert.equal(url, 'https://vision.example.test/chat')
    const modelStartedAt = performance.now()
    const content = modelRequest.parse(JSON.parse(Buffer.from(request.body ?? []).toString('utf8'))).messages.find(message => message.role === 'user')?.content
    assert.ok(Array.isArray(content))
    const input = prompt.parse(JSON.parse(content[0]?.text ?? '{}')).input
    const revisedContext = briefSchema.parse(JSON.parse(input.taskBrief)).task === changedBrief
    // A deep review's first image is the candidate. Other supplied images are frozen style references.
    const urls = content.flatMap(part => part.image_url ? [part.image_url.url] : []).slice(0, input.operation === 'screen' ? input.images.length : 1)
    const candidates = await Promise.all(urls.map(async location => {
      let bytes: Buffer
      if (location.startsWith('data:image/')) bytes = Buffer.from(location.slice(location.indexOf(',') + 1), 'base64')
      else {
        const transfer = transferOf(location)
        run.modelMedia.push(transfer)
        await delay(configuredDelays.modelMediaMs, undefined, { signal: request.signal })
        bytes = receive(transfer)
      }
      const pixel = (await sharp(bytes).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer())[0]!
      const photo = photosByPixel.get(pixel)
      assert.ok(photo, 'Model receives recognizable fixture pixels')
      return revisedContext ? newContextPhotos.get(photo.id) ?? photo : photo
    }))
    if (input.operation === 'screen') {
      await delay(candidates.some(photo => photo.slow) ? configuredDelays.slowCoarseMs : configuredDelays.coarseMs, undefined, { signal: request.signal })
      for (const photo of candidates) run.coarse.set(photo.pixel, photo.coarse)
    } else await delay(configuredDelays.deepMs, undefined, { signal: request.signal })
    run.modelCalls.push({ operation: input.operation, ...(input.stage ? { stage: input.stage } : {}),
      pixels: candidates.map(photo => photo.pixel), elapsedMs: elapsed(modelStartedAt) })
    const good = candidates[0]?.expectedPass === true
    const result = input.operation === 'screen'
      ? { items: input.images.map((image, index) => {
        const photo = candidates[index]!, required = input.screeningPolicy?.sharedRequiredRuleIds[0]
        const requiredViolations = photo.coarse === 'obvious-reject' && required ? [{
          ruleId: required, evidenceImageVersionId: image.imageVersionId, visibility: photo.expectedPass ? 'unknown' : 'visible',
          observation: photo.expectedPass ? 'The thumbnail does not establish a hard failure.' : 'The large uniform swatch visibly misses the required palette.',
        }] : []
        return { imageVersionId: image.imageVersionId, decision: photo.coarse, reason: 'Fixture thumbnail decision.', ...(input.screeningPolicy ? { requiredViolations } : {}) }
      }) }
      : { ruleResults: input.rules.map(rule => ({ ruleId: rule.ruleId, status: good ? 'satisfied' : 'violated', source: 'inferred', reason: 'Fixture pixel rule.', evidenceImageVersionIds: [input.images[0]!.imageVersionId] })), cropPotential: 'direct',
        preferenceScores: [{ dimension: 'color', score: good ? 0.9 : 0.1 }], taskRelevance: good ? 'relevant' : 'irrelevant', subjectFocus: [] }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })) }
  }

  const commit = fixture.repository.commit.bind(fixture.repository)
  fixture.repository.commit = async input => {
    const result = await commit(input)
    if (metrics) for (const record of input.records) {
      if (record.kind === 'selection' && record.qualification === 'auto-qualified') {
        metrics.selectedCommits.push({ imageVersionId: record.imageVersionId, elapsedMs: elapsed(metrics.startedAt) })
      }
    }
    return result
  }
  try {
    await fixture.service.initialize()
    const newStyle = async (name: string) => {
      const { id: styleId } = identity.parse(await fixture.action('style-create', { operationId: `style-${name}`, name }))
      await fixture.action('reference-import', { operationId: `reference-${name}`, styleId, expectedRevision: 1,
        files: [{ name: 'reference.png', mime: 'image/png', base64: fixture.referenceImage.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
      await fixture.action('reference-analyze', { operationId: `analysis-${name}`, styleId, buildDataset: true })
      await fixture.jobs.drain()
      const profile = fixture.repository.list('modelProfile').find(row => row.styleId === styleId)
      assert.ok(profile, 'Reference analysis must produce a saved searchable profile')
      return profile.id
    }
    const execute = async (name: string, releaseId: string, output: 'preview' | 'original', queries: string[], targetCount: number, expected: readonly Photo[], taskBrief = 'Return the supplied reference style from Unsplash.') => {
      const counters: Metrics = { sourcePages: [], lookups: [], hostMedia: [], modelMedia: [],
        coarse: new Map(), modelCalls: [], selectedCommits: [], startedAt: performance.now() }
      metrics = counters
      try {
        const { runId } = runIdentity.parse(await fixture.action('search-start', { operationId: name, releaseId, sourceId: 'unsplash',
          output: { kind: output }, queries, taskBrief, targetCount }))
        await fixture.jobs.drain()
        const wallMs = elapsed(counters.startedAt), run = fixture.domain.require('run', runId), data = dataOf(run), spec = specOf(run)
        assert.equal(run.status, 'completed', JSON.stringify(data.error))
        assert.ok(!data.counts.technicalFailed, JSON.stringify(data.error))
        const results = fixture.repository.list('selection').filter(selection => selection.runId === runId)
        const selections = results.map(selection => {
          const image = fixture.domain.require('imageVersion', selection.imageVersionId)
          const asset = fixture.domain.require('asset', image.assetId)
          assert.equal(asset.source.kind, 'provider')
          const photo = photosById.get(asset.source.providerAssetId)!
          return { id: photo.id, pixel: photo.pixel, expectedPass: expected.some(candidate => candidate.pixel === photo.pixel && candidate.expectedPass) }
        })
        assert.equal(counters.selectedCommits.length, results.length)
        assert.ok(selections.every(selection => selection.expectedPass), 'False positive selection')
        const admitted = [...new Map(expected.map(photo => [photo.pixel, photo])).values()].filter(photo => photo.expectedPass)
        const admittedIds = new Map(admitted.map(photo => [photo.pixel, expected.filter(candidate => candidate.pixel === photo.pixel).map(candidate => candidate.id)]))
        const selectedPixels = new Set(selections.map(selection => selection.pixel))
        const retainedCoarse = new Map(searchScreeningSummary(run)?.screenedSources.map(row => [row.providerAssetId, row.decision]))
        const screenedPositive = admitted.filter(photo => admittedIds.get(photo.pixel)!.some(id => retainedCoarse.has(id)))
        const falseNegatives = screenedPositive.filter(photo => admittedIds.get(photo.pixel)!.every(id => retainedCoarse.get(id) === 'obvious-reject'))
        const falseNegativePixels = new Set(falseNegatives.map(photo => photo.pixel))
        const proposedFalseRejects = admitted.filter(photo => counters.coarse.get(photo.pixel) === 'obvious-reject')
        const eligibleUnselected = admitted.filter(photo => !selectedPixels.has(photo.pixel) && !falseNegativePixels.has(photo.pixel))
        const duplicates = selections.length - new Set(selections.map(selection => selection.id)).size
        const aliasDuplicates = new Set(selections.map(selection => selection.id)).size - selectedPixels.size
        assert.equal(duplicates, 0, 'Identical provider ID selected twice')
        return { name, output, targetCount, outcome: run.outcome, schedule: spec.fixed.searchScreeningSchedule ?? null, frozenQueries: spec.input.queries,
          firstCommittedSelectionMs: counters.selectedCommits[0]?.elapsedMs ?? null, wallMs,
          sourcePages: counters.sourcePages, lookups: counters.lookups, hostMediaRequests: counters.hostMedia.length,
          hostSmallRequests: counters.hostMedia.filter(row => row.representation === 'small').length,
          hostRegularRequests: counters.hostMedia.filter(row => row.representation === 'regular').length,
          hostMediaBytes: counters.hostMedia.reduce((sum, row) => sum + receive(row).length, 0),
          modelPreviewBytes: counters.modelMedia.reduce((sum, row) => sum + receive(row).length, 0),
          hostOriginals: counters.hostMedia.filter(row => row.representation === 'raw').map(row => row.id),
          modelPreviewReads: counters.modelMedia.length, coarseRequests: counters.modelCalls.filter(call => call.operation === 'screen').length,
          coarsePixels: counters.modelCalls.filter(call => call.operation === 'screen').reduce((sum, call) => sum + call.pixels.length, 0),
          slowCoarseRequests: counters.modelCalls.filter(call => call.operation === 'screen' && call.pixels.some(pixel => photosByPixel.get(pixel)?.slow)).length,
          sourceReviews: counters.modelCalls.filter(call => call.stage === 'source').length,
          finalReviews: counters.modelCalls.filter(call => call.stage === 'final').length,
          finalReviewedPixels: counters.modelCalls.filter(call => call.stage === 'final').flatMap(call => call.pixels),
          screenedPositive: screenedPositive.length, falseNegatives: falseNegatives.map(photo => photo.id),
          proposedFalseRejects: proposedFalseRejects.map(photo => photo.id),
          targetStopped: (run.outcome === 'target-met' ? eligibleUnselected : []).map(photo => photo.id),
          otherUnselected: (run.outcome === 'target-met' ? [] : eligibleUnselected).map(photo => photo.id),
          selections, distinctSelectedPixels: selectedPixels.size, duplicates, aliasDuplicates, counts: data.counts }
      } finally { metrics = undefined }
    }
    return { execute, newStyle, cleanup: fixture.cleanup }
  } catch (error) {
    await fixture.cleanup()
    throw error
  }
}

const warmups = Number(process.env.VISUAL_CURATOR_COMPARISON_WARMUPS ?? '1')
const repetitions = Number(process.env.VISUAL_CURATOR_COMPARISON_RUNS ?? '3')
const mode = z.enum(['all', 'brief-change', 'quality']).parse(process.env.VISUAL_CURATOR_COMPARISON_MODE ?? 'all')
assert.ok(Number.isInteger(warmups) && warmups >= 0 && Number.isInteger(repetitions) && repetitions > 0)
for (let sample = -warmups; sample < repetitions; sample++) {
  const fixture = await setup()
  try {
    const context = mode === 'quality' ? undefined : await fixture.newStyle('context')
    const oldContext = context === undefined ? undefined : await fixture.execute('old-brief', context, 'preview', ['context change'], 1, contextPhotos, originalBrief)
    const newContext = context === undefined ? undefined : await fixture.execute('new-brief', context, 'preview', ['context change'], 2, [...newContextPhotos.values()], changedBrief)
    if (oldContext) {
      assert.equal(oldContext.selections[0]?.id, 'context-previous-pick')
      assert.ok(oldContext.finalReviewedPixels.includes(82))
    }
    const report = (value: object) => { if (sample >= 0) console.log(JSON.stringify({ sample: sample + 1, delays: configuredDelays, ...value })) }
    if (mode === 'brief-change') { report({ oldContext, newContext }); continue }
    const latencyProfile = await fixture.newStyle('latency')
    const previewProfile = await fixture.newStyle('preview')
    const initial = await fixture.execute('small-target-slow-tail', latencyProfile, 'preview',
      ['green landscape'], 1, slowTail)
    const previews = await fixture.execute('preview-dedup', previewProfile, 'preview', ['preview aliases'], 4, preview)
    assert.equal(initial.selections[0]?.id, 'latency-2')
    if (mode === 'quality') { report({ initial, previews }); continue }
    const normalizationProfile = await fixture.newStyle('normalization')
    const originalProfile = await fixture.newStyle('original')
    const normalizedQuery = await fixture.execute('equivalent-query-variants', normalizationProfile, 'preview',
      [' green   landscape ', 'green landscape', 'GREEN LANDSCAPE'], 1, slowTail)
    const historyRun = await fixture.execute('history-seed', originalProfile, 'original', ['original history'], 1, history)
    const originals = await fixture.execute('original-normalized-history', originalProfile, 'original', ['original current'], 3, original.slice(3))
    assert.equal(normalizedQuery.selections[0]?.id, 'latency-2')
    assert.equal(historyRun.selections[0]?.id, 'historical-pick')
    assert.deepEqual(originals.selections.map(photo => photo.pixel).sort(), [73, 75])
    report({ initial, normalizedQuery, previews, historyRun, originals, oldContext, newContext })
  } finally { await fixture.cleanup() }
}
