/** Transfer timing and progressive presentation preserve frozen tasks and real step evidence. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { resolveConfig, resolveCurrentConfig, settingsSchema } from '../src/host/config.ts'
import { BudgetLedger } from '../src/host/runtime.ts'
import { originalRequestBounds, requestBounds } from '../src/host/providers.ts'
import { SafeHttpClient } from '../src/media/network.ts'
import { UnsplashApi, UnsplashSourceProvider, unsplashMediaUrl } from '../src/media/unsplash.ts'
import { imageWorkflowStages, imageWorkflowStageReached, imageWorkflowWindow, imageWorkflowPreviousReview, imageWorkflowArtifact } from '../src/client/workflow-image-branches.ts'
import { wallpaperItemSchema, wallpaperPlanSchema, wallpaperViewSchema, wallpaperReviewSchema, wallpaperReviewKeys } from '../src/shared/wallpaper.ts'
import { wallpaperRecovery } from '../src/client/wallpaper-recovery.ts'

test('original transfer limits are explicit for new tasks while legacy specs retain their API deadline', () => {
  const legacy = resolveConfig({ limits: { requestTimeoutMs: 120 } }), saved = JSON.stringify(legacy)
  const context = { signal: new AbortController().signal, ledger: new BudgetLedger(legacy.limits, undefined, () => 1000, 'native-model') }
  assert.equal(originalRequestBounds(legacy, context).timeoutMs, 120)
  assert.equal(originalRequestBounds(legacy, context).idleTimeoutMs, undefined)
  assert.equal(settingsSchema.parse(legacy).limits.originalDownloadTimeoutMs, undefined)
  const current = resolveCurrentConfig(legacy)
  assert.equal(originalRequestBounds(current, context).timeoutMs, 300_000)
  assert.equal(originalRequestBounds(current, context).idleTimeoutMs, 60_000)
  assert.equal(requestBounds(current, context).timeoutMs, 120)
  assert.equal(JSON.stringify(legacy), saved)
  const bounded = { ...context, ledger: new BudgetLedger(current.limits, { vision: 0, search: 0, downloadBytes: 0, deadlineAt: 1500 }, () => 1000) }
  assert.equal(originalRequestBounds(current, bounded).timeoutMs, 500)
  assert.throws(() => resolveCurrentConfig({ limits: { originalDownloadTimeoutMs: 0 } }))
  assert.throws(() => resolveCurrentConfig({ limits: { originalDownloadTimeoutMs: 900_001 } }))
})

test('slow original bodies outlive API timing while stalls, total time, cancellation and byte caps remain bounded', async () => {
  const timers = new Set<ReturnType<typeof setInterval>>()
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.write('a')
    if (request.url === '/stall') return
    let chunks = 1
    const timer = setInterval(() => { response.write('b'); if (++chunks === 8) { clearInterval(timer); timers.delete(timer); response.end() } }, 80)
    timers.add(timer); response.on('close', () => { clearInterval(timer); timers.delete(timer) })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert(address && typeof address !== 'string')
  const origin = 'http://vision.test:' + address.port
  const http = new SafeHttpClient({ allowedOrigins: [], localVisionOrigin: origin }, async () => [{ address: '127.0.0.1', family: 4 }])
  const config = resolveCurrentConfig({ limits: { requestTimeoutMs: 150, originalDownloadTimeoutMs: 2000, originalDownloadIdleTimeoutMs: 500 } })
  const controller = new AbortController(), context = { signal: controller.signal, ledger: new BudgetLedger(config.limits, undefined, Date.now, 'native-model') }
  const transfer = { ...originalRequestBounds(config, context), maxBytes: 128, method: 'GET' as const }
  try {
    await assert.rejects(http.request(origin + '/slow', { ...requestBounds(config, context), method: 'GET' }), { code: 'remote-timeout' })
    assert.equal((await http.request(origin + '/slow', transfer)).bytes.toString(), 'abbbbbbb')
    await assert.rejects(http.request(origin + '/stall', { ...transfer, idleTimeoutMs: 150 }), { code: 'remote-idle-timeout' })
    await assert.rejects(http.request(origin + '/slow', { ...transfer, timeoutMs: 250 }), { code: 'remote-timeout' })
    await assert.rejects(http.request(origin + '/slow', { ...transfer, maxBytes: 2 }), { code: 'budget-exhausted' })
    await assert.rejects(http.request(origin + '/slow', { ...transfer, onProgress: progress => { if (progress.receivedBytes > 0) controller.abort() } }), { code: 'cancelled' })
  } finally { for (const timer of timers) clearInterval(timer); server.closeAllConnections(); server.close(); await once(server, 'close') }
})

test('subscriber grants accept only the matching signed first-party original and leave preview policy unchanged', async () => {
  const reference = 'https://plus.unsplash.com/premium_photo-123-abc', expires = Math.floor(Date.now() / 1000) + 3600
  const original = 'https://delivery.unsplash.com/premium_photo-123-abc?s=' + 'a'.repeat(32) + '&expires=' + expires
  const photo = { id: 'member', width: 3000, height: 4000, premium: true, plus: true, urls: { small: reference + '?w=400', regular: reference + '?w=1080', raw: reference } }
  let location = original
  const source = new UnsplashSourceProvider(new UnsplashApi({ request: async path => path.endsWith('/download') ? { url: location } : photo }))
  const bounds = { timeoutMs: 1000, maxBytes: 100000, maxRedirects: 2 }
  assert.equal((await source.lookup('member', bounds)).originalUrl, original)
  for (const invalid of [original.replace('delivery.unsplash.com', 'delivery.unsplash.com.example'), original.replace('https:', 'http:'), original.replace('123-abc', '456-def'), original.replace(/s=[a]+/, 's=invalid'), original.replace(String(expires), '1')]) {
    location = invalid; await assert.rejects(source.lookup('member', bounds), { code: 'source-protocol-error' })
  }
  assert.throws(() => unsplashMediaUrl(original), { code: 'source-protocol-error' })
})

test('future canvas steps stay absent and recovery never targets an older displayed version', () => {
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', familyId: 'family', status: 'technical-failed', failedStep: 'downloading', errorCode: 'remote-timeout' })
  const visible = () => imageWorkflowStages.filter(step => imageWorkflowStageReached(step.stage, item)).map(step => step.stage)
  assert.deepEqual(visible(), ['original'])
  const view = wallpaperViewSchema.parse({ runId: 'run', sourceRunId: 'run', status: 'completed', settings: {}, state: { version: 2, sourceRunId: 'run', skillVersion: 'fixture', items: [item] }, resources: {}, sourceImages: {}, total: 1, offset: 0, counts: {}, warnings: [] })
  assert.equal(wallpaperRecovery(view, item, undefined).kind, 'download')
  item.originalId = 'original'; item.status = 'planning'; delete item.failedStep; delete item.errorCode
  assert.deepEqual(visible(), ['original', 'planning'])
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'original', mode: 'single', subject: 'Vehicle', evidence: 'Saved pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Saved layout' })
  item.attempts.push({ revision: 1, plan, checks: [], needsOutpaint: true })
  assert.deepEqual(visible(), ['original', 'planning', 'geometry'])
  const old = item.attempts[0]!
  item.attempts.push({ ...old, revision: 2, generation: { id: 'operation', provider: 'fixture', model: 'fixture', taskId: 'task' } }); item.status = 'needs-review'
  assert.deepEqual(visible(), ['original', 'planning', 'geometry', 'rendering'])
  assert.equal(wallpaperRecovery(view, item, old).kind, 'history')
  assert.equal(wallpaperRecovery(view, item, item.attempts.at(-1)).kind, 'receipt')
  item.attempts.at(-1)!.outputId = 'saved-output'; item.status = 'technical-failed'; item.failedStep = 'reviewing'
  for (const error of ['vision-invalid-output', 'vision-output-truncated']) {
    item.errorCode = error
    assert.equal(wallpaperRecovery(view, item, item.attempts.at(-1)).kind, 'review')
    assert.equal(wallpaperRecovery(view, item, old).kind, 'history')
  }
  item.errorCode = 'remote-timeout'
  assert.deepEqual(wallpaperRecovery(view, item, item.attempts.at(-1)), { kind: 'retry', step: 'reviewing' })
})

test('progressive windows preserve reached stages and distinguish the previous failed review from a new review failure', () => {
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'original', mode: 'single', subject: 'Vehicle', evidence: 'Original pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Safe placement' })
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', familyId: 'family', status: 'downloading' })
  const window = () => imageWorkflowWindow(item).map(step => step.stage)
  assert.deepEqual(window(), ['original', 'planning'])
  item.originalId = 'original'; item.status = 'planning'
  assert.deepEqual(window(), ['original', 'planning', 'geometry'])
  const review = wallpaperReviewSchema.parse({ subject: 'Vehicle', checks: Object.fromEntries(wallpaperReviewKeys.map(key => [key, { result: key === 'background' ? 'violated' : 'satisfied', reason: key === 'background' ? 'A visible platform seam remains' : 'Observed pixels' }])), issues: [{ kind: 'background', reason: 'A visible platform seam remains' }] })
  const previous = { revision: 1, plan, checks: [], needsOutpaint: true, canvasId: 'seed', outputId: 'first-output', review }
  item.attempts.push(previous, { revision: 2, plan, checks: [], needsOutpaint: true, canvasId: 'second-seed' }); item.status = 'rendering'
  const reached = ['original', 'planning', 'geometry', 'rendering', 'clarity', 'reviewing']
  assert.deepEqual(window(), reached)
  assert.equal(imageWorkflowPreviousReview(item), previous)
  item.status = 'technical-failed'; item.failedStep = 'reviewing'; item.errorCode = 'vision-invalid-output'
  assert.ok(window().includes('reviewing')); assert.equal(imageWorkflowPreviousReview(item), undefined)
  assert.equal(previous.review.checks.background.result, 'violated')
  const history = imageWorkflowWindow(item, item.attempts.at(-1), 'planning').map(step => step.stage)
  assert.deepEqual(history.slice(0, 3), ['original', 'planning', 'geometry'])
  assert.ok(history.includes('rendering'))
})

test('subject, layout and pre-enhancement images stay fixed when review overlays and enhanced output change', () => {
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'original', mode: 'single', subject: 'Vehicle', evidence: 'Original pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [], placement: { scale: 1, left: 0, top: 0 }, reason: 'Safe placement' })
  const item = wallpaperItemSchema.parse({ imageVersionId: 'source', originalId: 'original', familyId: 'family', status: 'rendering', attempts: [{ revision: 1, plan, checks: [], needsOutpaint: true, canvasId: 'seed', layoutAnalysisId: 'layout-before-edit', analysisId: 'layout-before-edit', outputId: 'edited-output' }] })
  const attempt = item.attempts[0]!
  const before = ['planning', 'geometry', 'rendering'].map(stage => imageWorkflowArtifact(stage as 'planning' | 'geometry' | 'rendering', item, attempt))
  attempt.analysisId = 'review-after-edit'; attempt.clarity = { status: 'passed', reason: 'Independent enhancement', originalOutputId: 'edited-output', enhancedOutputId: 'enhanced-output' }; attempt.outputId = 'enhanced-output'
  const after = ['planning', 'geometry', 'rendering'].map(stage => imageWorkflowArtifact(stage as 'planning' | 'geometry' | 'rendering', item, attempt))
  assert.deepEqual(before, ['original', 'layout-before-edit', 'edited-output']); assert.deepEqual(after, before)
  delete attempt.layoutAnalysisId
  assert.equal(imageWorkflowArtifact('geometry', item, attempt), 'seed', 'Legacy layouts use the preserved seed rather than a later review image')
})
