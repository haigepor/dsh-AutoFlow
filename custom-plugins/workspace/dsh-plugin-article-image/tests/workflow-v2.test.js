/** Browser captures advance automatically to a version-bound plan, never to image generation. */
import { test, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { ArticleWorkflowService } from '../src/host/workflow-service.js'
import { resolveConfig } from '../config-schema.js'
import { hashSnapshot } from 'article-image-toolkit/capture-contracts'
import { createAnalysisInput, computeSceneHash } from '../src/shared/analysis-contracts.js'
import { loadEditorialRules } from '../src/host/editorial-rules.js'

const uuid = () => randomUUID().replaceAll('-', '')
const sheet = 'https://docs.google.com/spreadsheets/d/test-sheet/edit#gid=0'
function snapshot(url = 'https://example.com/a') {
  const value = { schemaVersion: 2, id: uuid(), title: 'Family travel', requestedUrl: url, url, language: 'en', capturedAt: new Date().toISOString(), extractorVersion: 'fixture',
    blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text: 'Families plan a relaxed trip and rest breaks.' }] }], assets: [], quality: { status: 'passed', reasons: [] } }
  return { ...value, sourceHash: hashSnapshot(value) }
}
async function result(args, config) {
  const rules = await loadEditorialRules(config, { inlineCount: 0 })
  const input = createAnalysisInput({ ...args, rules, config, images: [] })
  const coverage = { blockIds: ['b1'], assetIds: [] }
  const understanding = { articleType: 'Travel guide', audience: 'Parents', purpose: 'Plan a relaxed trip', language: 'en', theme: 'Family travel', sections: [{ title: 'Planning', summary: 'Plan rest breaks', blockIds: ['b1'] }], entities: ['Families'], facts: [{ id: 'f1', claim: 'Families plan rest breaks.', kind: 'source', evidence: coverage }], limitations: [], questions: [], images: [], coverage }
  const shot = { purpose: 'cover', paragraphs: [1], blockIds: ['b1'], assetIds: [], afterBlockId: 'b1', rationale: 'Illustrates the trip theme', informationGoal: 'Relaxed travel', visualMode: 'conceptual', subject: 'A family', action: 'resting', environment: 'a park', composition: 'wide', lighting: 'daylight', colors: 'natural', style: 'editorial', details: 'Plausible scene', avoid: 'No event claim', prompt: 'A conceptual editorial photograph of a family resting in a park.', ratio: '16:9' }
  shot.sceneHash = computeSceneHash(shot); shot.promptSceneHash = shot.sceneHash
  const plan = { sourceHash: args.snapshot.sourceHash, inputHash: input.inputHash, rulesHash: rules.rulesHash, model: input.model, coverage, understanding, brief: { theme: understanding.theme, facts: ['Rest breaks'], subjects: ['Families'], scenes: ['Park'] }, shots: [shot], shortfall: { requested: 1, actual: 1, reason: '' }, checks: { structural: true, semanticReviewRequired: true } }
  const checkpoint = { inputHash: input.inputHash, stageId: 'chunk-1', sessionId: 'fixture-session', messageId: 'fixture-message', submissionSeq: 3, result: understanding }
  return { input, understanding, plan, sessionId: 'fixture-session', checkpoints: [checkpoint] }
}
async function fixture(t, options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'article-workflow-v2-')), tasks = [], calls = [], captureCalls = []
  const config = resolveConfig({ ...options.config, analysis: { provider: 'fixture', model: 'fixture', ...options.config?.analysis } })
  const capture = { readiness: async () => ({ available: true }), dispose: async () => {}, capture: async (...args) => { captureCalls.push(args); return { snapshot: options.snapshot ?? snapshot(args[0]), assets: [] } } }
  const analysis = { readiness: options.readiness ?? (async () => ({ available: true })), run: async args => {
    calls.push(args)
    if (options.run) return options.run(args, config.analysis)
    const value = await result(args, config.analysis)
    await args.onStage({ stage: 'understanding', input: value.input, checkpoint: value.checkpoints[0], completedChunks: 1, totalChunks: 1 })
    return value
  } }
  const ctx = { profileContext: { home, dir: join(home, 'profile') }, jobs: { start(spec) { const task = spec.run({ append() {}, updateProgress() {} }); tasks.push(task); return `job-${tasks.length}` } } }
  const download = async () => options.csv ?? 'Links,Category,语言,备注\nhttps://example.com/a,Travel,en,\n'
  const service = new ArticleWorkflowService(ctx, config, { capture, analysis, download })
  await service.enable('tools')
  t.onTestFinished(async () => { await service.dispose(); await Promise.allSettled(tasks.map(task => task.done)); await rm(home, { recursive: true, force: true }) })
  await service.importSource({ url: sheet })
  const id = (await service.list()).items[0].id
  return { service, id, tasks, calls, captureCalls, home, ctx, config, capture, analysis, download }
}

test('automatically saves an evidence-bound plan and approval never invokes generation', async t => {
  const { service, id, tasks, calls } = await fixture(t)
  await service.action('process', { ids: [id] })
  await tasks[0].done
  const item = await service.detail(id)
  expect(item.state).toBe('review'); expect(item.snapshot.blocks[0].id).toBe('b1')
  expect(item.plan.inputHash).toBe(item.analysis.input.inputHash)
  const approved = await service.approve({ id, revision: item.revision })
  expect(approved.state).toBe('approved'); expect(calls).toHaveLength(1)
  expect((await service.status()).generation.available).toBe(false)
  await expect(service.action('generate', { id })).rejects.toThrow('operation-unavailable')
  await service.action('process', { ids: [id] })
  expect(calls).toHaveLength(1)
})

test('persists bounded failure diagnostics, excludes unsafe fields and resets logs on a new attempt', async t => {
  const { service, id, tasks, capture, ctx, config } = await fixture(t, { config: { maxRunEvents: 10 } })
  capture.capture = async (url, options) => {
    for (let index = 0; index < 15; index++) await options.onProgress({ phase: 'rendering', event: 'document-loaded', details: { statusCode: 200, chars: index, origin: 'https://example.com/?token=secret', headers: { authorization: 'secret' }, code: 'Unsafe remote text secret' } })
    throw Object.assign(new Error('Sensitive upstream message'), { code: 'article-content-not-ready' })
  }
  await service.startProcess({ ids: [id] }); await tasks[0].done
  const item = await service.detail(id)
  expect(item.run.events).toHaveLength(10)
  expect(item.run.eventsDropped).toBe(8)
  expect(item.run.events.at(-1)).toMatchObject({ event: 'failed', details: { code: 'article-content-not-ready' } })
  expect(JSON.stringify(item.run.events)).not.toMatch(/secret|Unsafe|Sensitive|authorization/)
  const { Store } = await import('../src/host/store.js')
  const disk = await new Store(ctx.profileContext.home, ctx.profileContext.dir, config).read()
  expect(disk.items.find(value => value.id === id).run.events).toEqual(item.run.events)
  capture.capture = async url => ({ snapshot: snapshot(url), assets: [] })
  await service.startProcess({ ids: [id] }); await tasks[1].done
  const retry = await service.detail(id)
  expect(retry.run.attemptId).not.toBe(item.run.attemptId)
  expect(retry.run.events[0].seq).toBe(1)
  expect(retry.run.eventsDropped).toBe(0)
})

test('does not analyze or permit review override for known missing source material', async t => {
  const source = snapshot(); source.quality = { status: 'partial', reasons: ['unhandled-pagination'] }
  const { service, id, tasks, calls } = await fixture(t, { snapshot: source })
  await service.action('process', { ids: [id] }); await tasks[0].done
  const item = await service.detail(id)
  expect(item.state).toBe('needs-source-review'); expect(calls).toHaveLength(0)
  await expect(service.action('review-source', { id, revision: item.revision, evidence: 'Checked' })).rejects.toThrow('source-incomplete')
})

test('a progress publication failure stops capture and persists its safe cause instead of a silent tail', async t => {
  const { service, id, tasks, capture, calls } = await fixture(t, { config: { progressBatchSize: 1 } })
  const commit = service.commitRun.bind(service)
  let commits = 0, interrupted = false
  service.commitRun = (...args) => {
    if (++commits === 2) return Promise.reject(Object.assign(new Error('C:/private?token=secret'), { code: 'EPERM' }))
    return commit(...args)
  }
  capture.capture = async (_url, options) => {
    try { await options.onProgress({ phase: 'rendering', event: 'document-loaded', details: { statusCode: 200 } }) }
    finally { interrupted = options.signal.aborted }
    throw new Error('must stop before snapshot publication')
  }
  await service.startProcess({ ids: [id] }); await tasks[0].done
  const item = await service.detail(id)
  expect(interrupted).toBe(true); expect(calls).toHaveLength(0); expect(item.snapshotRef).toBe(null)
  expect(item.error).toBe('operation-failed')
  expect(item.run.events.at(-1)).toMatchObject({ event: 'failed', details: { code: 'operation-failed', operation: 'progress-write', causeCode: 'fs-eperm' } })
  expect(JSON.stringify(item.run.events)).not.toMatch(/private|token|secret/)
})

test('allows explicit source review for unsettled background resources when no missing content was found', async t => {
  const source = snapshot(); source.quality = { status: 'needs-review', reasons: ['unsettled-resources'] }
  const { service, id, tasks, calls } = await fixture(t, { snapshot: source })
  await service.startProcess({ ids: [id] }); await tasks[0].done
  expect(calls).toHaveLength(0)
  const item = await service.detail(id)
  await service.reviewSource({ id, revision: item.revision, evidence: 'Compared all visible body text and original figures with the source.' }); await tasks[1].done
  expect((await service.detail(id)).state).toBe('review')
  expect(calls).toHaveLength(1)
})

test('rejects a validly hashed capture belonging to a different requested article', async t => {
  const { service, id, tasks, calls } = await fixture(t, { snapshot: snapshot('https://example.com/different') })
  await service.startProcess({ ids: [id] }); await tasks[0].done
  const item = await service.detail(id)
  expect(item.state).toBe('failed')
  expect(item.snapshotRef).toBe(null); expect(item.planRef).toBe(null); expect(calls).toHaveLength(0)
})

test('cancelled attempts cannot publish a late model result', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const { service, id, tasks } = await fixture(t, { run: async (args, config) => { entered.resolve(); await release.promise; return result(args, config) } })
  await service.action('process', { ids: [id] }); await entered.promise
  const stopping = service.stopTask((await service.detail(id)).run.id)
  release.resolve(); await stopping; await tasks[0].done
  const item = await service.detail(id)
  expect(item.state).toBe('cancelled'); expect(item.plan).toBe(null)
})

test('editing a scene invalidates prompt synchronization until explicitly confirmed', async t => {
  const { service, id, tasks } = await fixture(t)
  await service.action('process', { ids: [id] }); await tasks[0].done
  let item = await service.detail(id)
  item.plan.shots[0].subject = 'Two parents'
  await service.savePlan({ id, revision: item.revision, plan: item.plan })
  item = await service.detail(id)
  await expect(service.approve({ id, revision: item.revision })).rejects.toThrow('prompt-unsynchronized')
  await service.savePlan({ id, revision: item.revision, plan: item.plan, syncPromptShots: [0] })
  item = await service.detail(id)
  expect((await service.approve({ id, revision: item.revision })).state).toBe('approved')
})

test('a failed refresh keeps the earlier source read-only until processing succeeds', async t => {
  const { service, id, tasks, capture } = await fixture(t)
  await service.action('process', { ids: [id] }); await tasks[0].done
  const prior = await service.detail(id)
  capture.capture = async () => { throw Object.assign(new Error('article-timeout'), { code: 'article-timeout' }) }
  await service.action('process', { ids: [id], reprocess: true }); await tasks[1].done
  const item = await service.detail(id)
  expect(item.snapshot.sourceHash).toBe(prior.snapshot.sourceHash)
  expect(item.state).toBe('failed'); expect(item.approval).toBe(null)
  await expect(service.savePlan({ id, revision: item.revision, plan: item.plan })).rejects.toThrow('stale-source')
  await expect(service.approve({ id, revision: item.revision })).rejects.toThrow('stale-source')
})

test('native plan pages reconstruct a full Unicode plan within each complete JSON byte budget', async t => {
  const { service, id, tasks } = await fixture(t)
  await service.action('process', { ids: [id] }); await tasks[0].done
  let item = await service.detail(id)
  item.plan.shots[0].prompt = '家庭🌲'.repeat(2400)
  await service.savePlan({ id, revision: item.revision, plan: item.plan })
  item = await service.detail(id); service.config.toolResultBytes = 8000
  let offset = 0, pages = 0; const fragments = []
  do {
    const page = await service.planPage({ id, revision: item.revision, inputHash: item.plan.inputHash, offset })
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8000)
    expect(page.fragment.isWellFormed()).toBe(true)
    fragments.push(page.fragment); pages++; offset = page.nextOffset
  } while (offset !== null && pages < 20)
  expect(offset).toBe(null); expect(pages).toBeGreaterThan(1)
  expect(JSON.parse(fragments.join(''))).toEqual(item.plan)
  await expect(service.planPage({ id, revision: item.revision, inputHash: '0'.repeat(64) })).rejects.toThrow('stale-source')
  await expect(service.planPage({ id, revision: item.revision, inputHash: item.plan.inputHash, offset: 1000000 })).rejects.toThrow('invalid-request')
  await service.savePlan({ id, revision: item.revision, plan: item.plan })
  await expect(service.planPage({ id, revision: item.revision, inputHash: item.plan.inputHash })).rejects.toThrow('stale-revision')
})

/** Test-owned gates also settle on disposal so assertion failures cannot strand a fake provider. */
async function awaitGate(gate, signal) {
  let cancel
  try {
    signal.throwIfAborted()
    return await Promise.race([gate.promise, new Promise((resolve, reject) => { void resolve; cancel = () => reject(new Error('cancelled fixture')); signal.addEventListener('abort', cancel, { once: true }) })])
  } finally { if (cancel) signal.removeEventListener('abort', cancel) }
}

test('initial in-flight analysis cannot publish after imported business metadata changes', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const options = { run: async (args, config) => { entered.resolve(); await awaitGate(release, args.signal); return result(args, config) } }
  const { service, id, tasks } = await fixture(t, options)
  await service.startProcess({ ids: [id] }); await entered.promise
  expect((await service.detail(id)).analysisRef).toBe(null)
  options.csv = 'Links,Category,语言,备注\nhttps://example.com/a,Travel,en,new editorial brief\n'
  await service.importSource({ url: sheet })
  release.resolve(); await tasks[0].done
  const item = await service.detail(id)
  expect(item.notes).toBe('new editorial brief')
  expect(item.plan).toBe(null); expect(item.approval).toBe(null)
  expect(item.run.status).toBe('cancelled'); expect(item.error).toBe('analysis-input-changed')
})

test('changed metadata cannot regain approval by saving an old otherwise valid plan', async t => {
  const options = {}
  const { service, id, tasks } = await fixture(t, options)
  await service.startProcess({ ids: [id] }); await tasks[0].done
  let item = await service.detail(id)
  await service.approve({ id, revision: item.revision })
  options.csv = 'Links,Category,语言,备注\nhttps://example.com/a,Travel,en,Use a different readership\n'
  await service.importSource({ url: sheet })
  item = await service.detail(id)
  expect(item.approval).toBe(null)
  await expect(service.savePlan({ id, revision: item.revision, plan: item.plan, syncPromptShots: [0] })).rejects.toThrow('analysis-input-changed')
  await expect(service.approve({ id, revision: item.revision })).rejects.toThrow('analysis-input-changed')
})

test('source row movement preserves a still-current approved analysis', async t => {
  const options = {}
  const { service, id, tasks } = await fixture(t, options)
  await service.startProcess({ ids: [id] }); await tasks[0].done
  const item = await service.detail(id)
  const approved = await service.approve({ id, revision: item.revision })
  options.csv = 'Links,Category,语言,备注\n,,,\nhttps://example.com/a,Travel,en,\n'
  await service.importSource({ url: sheet })
  const moved = await service.detail(id)
  expect(moved.rows).not.toEqual(approved.rows)
  expect(moved.approval).toEqual(approved.approval)
  expect(moved.state).toBe('approved')
})

test('double starts are rejected while a single article owns its write attempt', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const { service, id, tasks, calls, captureCalls } = await fixture(t, { run: async (args, config) => { entered.resolve(); await awaitGate(release, args.signal); return result(args, config) } })
  await service.startProcess({ ids: [id] }); await entered.promise
  await expect(service.startProcess({ ids: [id], reprocess: true })).rejects.toThrow('item-busy')
  release.resolve(); await tasks[0].done
  expect(calls).toHaveLength(1); expect(captureCalls).toHaveLength(1)
})

test('a lost Host stays interrupted until explicit recovery reuses frozen input and checkpoints', async t => {
  let first, attempts = 0
  const readinessModels = []
  const { service, id, tasks, config, captureCalls, ctx, capture, analysis, download } = await fixture(t, { readiness: async (_snapshot, _signal, controls) => { if (controls) readinessModels.push(controls.model); return { available: true } }, run: async (args, controls) => {
    attempts++
    if (attempts === 1) {
      first = await result(args, controls)
      await args.onStage({ stage: 'understanding', input: first.input, checkpoint: first.checkpoints[0], completedChunks: 1, totalChunks: 1 })
      throw new Error('provider interrupted')
    }
    expect(args.checkpoint.input).toEqual(first.input)
    expect(args.checkpoint.checkpoints).toEqual(first.checkpoints)
    return first
  } })
  await service.startProcess({ ids: [id] }); await tasks[0].done
  const failed = await service.detail(id)
  expect(failed.run.checkpoints).toHaveLength(1)
  const exited = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true })
  await once(exited, 'exit')
  expect(() => process.kill(exited.pid, 0)).toThrow()
  await service.store.update(state => {
    const item = state.items.find(value => value.id === id)
    item.state = 'understanding'; item.error = null
    item.run.status = 'running'; item.run.pid = exited.pid; item.run.error = null
  })
  const restored = new ArticleWorkflowService(ctx, config, { capture, analysis, download })
  await restored.enable('tools')
  t.onTestFinished(() => restored.dispose())
  expect((await restored.detail(id)).state).toBe('interrupted')
  expect((await restored.list()).items[0].state).toBe('interrupted')
  expect(tasks).toHaveLength(1); expect(attempts).toBe(1)
  config.analysis.model = 'new-model'
  await restored.resumeRun(failed.run.id); await tasks[1].done
  const recovered = await restored.detail(id)
  expect(recovered.state).toBe('review')
  expect(recovered.analysis.input.inputHash).toBe(first.input.inputHash)
  expect(recovered.analysis.input.model.model).toBe('fixture')
  expect(readinessModels).toEqual(['fixture', 'fixture'])
  expect(captureCalls).toHaveLength(1)
})

test('manual text replacement invalidates every rich-source and analysis reference', async t => {
  const { service, id, tasks } = await fixture(t)
  await service.startProcess({ ids: [id] }); await tasks[0].done
  const item = await service.detail(id)
  await service.manualArticle({ id, revision: item.revision, title: 'Manual replacement', text: 'A complete manually supplied article about a different subject. '.repeat(8), language: 'en' })
  const manual = await service.detail(id)
  expect(manual.article.title).toBe('Manual replacement')
  expect(manual.snapshotRef).toBe(null); expect(manual.analysisRef).toBe(null); expect(manual.planRef).toBe(null); expect(manual.run).toBe(null)
  expect(manual.legacy).toBe(true); expect(manual.error).toBe('legacy-needs-refetch')
  await expect(service.approve({ id, revision: manual.revision })).rejects.toThrow('legacy-needs-refetch')
})

test('stopping one article drains only its work while another analysis continues', async t => {
  const entered = [Promise.withResolvers(), Promise.withResolvers()], release = [Promise.withResolvers(), Promise.withResolvers()]
  let index = 0
  const options = { csv: 'Links,Category,语言,备注\nhttps://example.com/a,Travel,en,\nhttps://example.com/b,Travel,en,\n', config: { analysis: { concurrency: 2 } }, run: async (args, controls) => {
    const own = index++
    entered[own].resolve(args)
    await awaitGate(release[own], args.signal)
    return result(args, controls)
  } }
  const { service, tasks } = await fixture(t, options)
  const ids = (await service.list()).items.map(item => item.id)
  await service.startProcess({ ids })
  const [first, second] = await Promise.all(entered.map(value => value.promise))
  const firstRun = (await service.detail(first.articleId)).run.id
  await service.stopTask(firstRun)
  expect((await service.detail(first.articleId)).state).toBe('cancelled')
  expect((await service.detail(second.articleId)).run.status).toBe('running')
  release[1].resolve(); await tasks[0].done
  expect((await service.detail(second.articleId)).state).toBe('review')
})

test('an old queued attempt cannot remove cancellation ownership from its resumed attempt', async t => {
  const entered = [Promise.withResolvers(), Promise.withResolvers()], release = [Promise.withResolvers(), Promise.withResolvers()]
  let index = 0
  const { service, tasks } = await fixture(t, {
    csv: 'Links,Category,语言,备注\nhttps://example.com/a,Travel,en,\nhttps://example.com/b,Travel,en,\n',
    config: { fetchConcurrency: 1, analysis: { concurrency: 2 } },
    run: async (args, controls) => {
      const own = index++
      entered[own].resolve(args)
      await awaitGate(release[own], args.signal)
      return result(args, controls)
    },
  })
  const ids = (await service.list()).items.map(item => item.id)
  await service.startProcess({ ids }); await entered[0].promise
  const queued = await service.detail(ids[1])
  expect(queued.state).toBe('queued')
  await service.stopTask(queued.run.id)
  await service.resumeRun(queued.run.id); await entered[1].promise
  release[0].resolve(); await tasks[0].done
  // 旧批次此时已越过原排队位置；恢复后的任务仍须可由同一个公开 run id 停止。
  await expect(service.stopTask(queued.run.id)).resolves.toEqual({ stopped: true })
  await tasks[1].done
  expect((await service.detail(ids[1])).state).toBe('cancelled')
})
