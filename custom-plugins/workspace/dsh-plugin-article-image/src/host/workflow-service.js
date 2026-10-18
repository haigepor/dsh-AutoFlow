/** Profile-owned capture, isolated analysis and human review; phase one has no generation adapter. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createCapture } from 'article-image-toolkit/capture'
import { snapshotSchema, blocksToParagraphs, hashSnapshot } from 'article-image-toolkit/capture-contracts'
import { ArticleService } from './service.js'
import { ArtifactStore } from './artifact-store.js'
import { createAnalysisRunner } from './analysis-runner.js'
import { loadEditorialRules } from './editorial-rules.js'
import { articleRecord } from './articles.js'
import { analysisInputSchema, analysisResultSchema, analysisCheckpointSchema, analysisPlanSchema, validateAnalysisPlan, computeSceneHash, analysisHash } from '../shared/analysis-contracts.js'
import { failure, errorCode, idSchema, revisionInput } from '../shared/contracts.js'
import { appendRunEvent, failureDetails } from './run-diagnostics.js'
import { createRunProgress } from './run-progress.js'

const uuid = () => randomUUID().replaceAll('-', '')
const now = () => new Date().toISOString()
const active = run => run && ['queued', 'running'].includes(run.status)
const metadataOf = item => ({ category: item.category, language: item.language, notes: item.notes })
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
const processSchema = z.object({ ids: z.array(idSchema).min(1).max(100), reprocess: z.boolean().default(false), selection: z.object({ inlineCount: z.number().int().min(0).max(11).optional(), ratio: z.enum(['16:9', '4:3', '3:2', '1:1', '9:16']).optional() }).strict().optional() }).strict()
const saveSchema = revisionInput.extend({ plan: analysisPlanSchema, syncPromptShots: z.array(z.number().int().nonnegative()).max(12).default([]) })

/** Preserve legacy read adapters while routing all public processing through one capture kernel. */
export class ArticleWorkflowService extends ArticleService {
  constructor(ctx, config, dependencies = {}) {
    super(ctx, config, dependencies)
    this.artifacts = dependencies.artifacts ?? new ArtifactStore(this.store.root, config)
    this.capture = dependencies.capture ?? createCapture(config.capture)
    this.analysis = dependencies.analysis
    this.runControls = new Map()
    this.runDone = new Map()
    this.analysisSlots = new Set()
  }
  editable(item) {
    if (active(item.run) && alive(item.run.pid)) throw failure('item-busy')
    super.editable(item)
  }
  async dispose() {
    for (const control of this.runControls.values()) control.abort()
    await super.dispose()
    await this.capture.dispose()
  }
  async snapshotOf(item) {
    if (!item.snapshotRef) return null
    const snapshot = snapshotSchema.parse(await this.artifacts.get('snapshots', item.snapshotRef))
    if (hashSnapshot(snapshot) !== snapshot.sourceHash) throw failure('storage-integrity')
    return snapshot
  }
  async detail(id) {
    const item = await super.detail(id), snapshot = await this.snapshotOf(item)
    const plan = item.planRef ? analysisPlanSchema.parse(await this.artifacts.get('plans', item.planRef)) : item.plan
    const analysis = item.analysisRef ? analysisResultSchema.parse(await this.artifacts.get('analyses', item.analysisRef)) : null
    const article = snapshot ? { title: snapshot.title, url: snapshot.url, language: snapshot.language, hash: snapshot.sourceHash, fetchedAt: snapshot.capturedAt, basis: 'web', paragraphs: blocksToParagraphs(snapshot.blocks) } : item.article
    const interrupted = active(item.run) && !alive(item.run.pid)
    let currentRulesHash = null
    if (analysis) {
      try { currentRulesHash = (await loadEditorialRules(this.config.analysis, { inlineCount: analysis.input.rules.policy.inlineCount, ratio: analysis.input.rules.policy.ratio })).rulesHash }
      catch (error) { void error; /* 已保存的输入仍可审核；当前规则文件错误由下一次分析报告。 */ }
    }
    return { ...item, article, snapshot, plan, analysis, currentRulesHash, rulesOutdated: Boolean(currentRulesHash && analysis?.input.rules.rulesHash !== currentRulesHash), ...(interrupted ? { state: 'interrupted', error: 'article-interrupted', run: { ...item.run, status: 'interrupted' } } : {}) }
  }
  async list(input = {}) {
    const page = await super.list(input)
    page.items = await Promise.all(page.items.map(async summary => {
      // 摘要来自同一次索引读取；列表不需要分析正文、规则文件或逐项重读索引。
      const snapshot = await this.snapshotOf(summary)
      const plan = summary.planRef ? analysisPlanSchema.parse(await this.artifacts.get('plans', summary.planRef)) : null
      return { ...summary, title: snapshot?.title ?? summary.title, sourceHash: snapshot?.sourceHash ?? summary.sourceHash,
        shots: plan?.shots.length ?? summary.shots, state: active(summary.run) && !alive(summary.run.pid) ? 'interrupted' : summary.state,
        quality: snapshot?.quality ?? null, stage: summary.run?.stage ?? null, legacy: summary.legacy }
    }))
    return page
  }
  async status() {
    const status = await super.status()
    const analysis = await this.runner(null).readiness()
    const browser = await this.capture.readiness()
    return { ...status, retrievalPolicy: { ...status.retrievalPolicy, primary: 'browser-toolkit', adapterCount: this.config.capture.adapters?.length ?? 0 }, analysis, browser,
      generation: { available: false, reason: 'phase-one-review-only' } }
  }
  runner(snapshot) {
    return this.analysis ?? createAnalysisRunner(this.ctx, this.config.analysis, { cwd: this.store.root, loadAsset: async assetId => {
      const asset = snapshot?.assets.find(value => value.id === assetId)
      if (!asset || asset.status !== 'ready') throw failure('article-image-unavailable')
      return { bytes: await this.artifacts.getAsset(asset.contentHash), mime: asset.mime }
    } })
  }
  async importSource(input, signal) {
    const before = await this.store.read()
    const result = await super.importSource(input, signal)
    await this.mutate(state => {
      for (const item of state.items) {
        const old = before.items.find(value => value.id === item.id)
        if (!old) continue
        if (analysisHash([old.category, old.language, old.notes]) !== analysisHash([item.category, item.language, item.notes])) {
          if (active(item.run)) {
            this.runControls.get(item.run.id)?.abort()
            item.run.status = 'cancelled'; item.run.error = 'analysis-input-changed'
          }
          if (item.run) { item.run.inputRef = null; item.run.checkpoints = [] }
          item.approval = null; item.state = 'ready'; item.error = 'analysis-input-changed'; item.revision++
        }
      }
    })
    return result
  }
  async commitRun(id, attempt, signal, change) {
    return this.mutate(async state => {
      const item = this.item(state, id)
      if (item.run?.attemptId !== attempt || !active(item.run)) throw failure('stale-revision')
      if (item.run.metadataHash && item.run.metadataHash !== analysisHash(metadataOf(item))) throw failure('analysis-input-changed')
      signal.throwIfAborted()
      const previousStage = item.run.stage, previousStatus = item.run.status
      const result = await change(item)
      if (previousStage !== item.run.stage || previousStatus !== item.run.status) appendRunEvent(item.run, this.config.maxRunEvents, item.run.status, { code: item.run.error ?? undefined })
      signal.throwIfAborted()
      item.run.updatedAt = now(); item.revision++
      return result ?? structuredClone(item)
    }, signal)
  }
  startFetch(ids, owner) { return this.startProcess({ ids }, owner) }
  startProcess(input, owner, recovery = null) {
    return this.track(async () => {
      this.requireTools()
      const args = processSchema.parse(input), signal = AbortSignal.any([this.life.signal, this.toolsLife.signal])
      if (new Set(args.ids).size !== args.ids.length) throw failure('item-duplicate')
      if (args.ids.length > this.fetchBatchLimit()) throw failure('fetch-batch-size')
      const scheduled = await this.mutate(state => {
        const entries = []
        for (const id of args.ids) {
          const item = this.item(state, id); this.editable(item)
          if (!recovery && !args.reprocess && !item.legacy && ['review', 'approved'].includes(item.state) && item.planRef) continue
          const previous = recovery && item.run?.id === recovery ? item.run : null
          item.run = { id: previous?.id ?? uuid(), attemptId: uuid(), pid: process.pid, stage: 'queued', status: 'queued', startedAt: now(), updatedAt: now(), error: null,
            sourceHash: previous?.sourceHash ?? null, metadataHash: analysisHash(metadataOf(item)), counts: { completed: 0, total: 1 }, checkpoints: previous?.checkpoints ?? [], inputRef: previous?.inputRef ?? null, events: [], eventsDropped: 0 }
          appendRunEvent(item.run, this.config.maxRunEvents, previous ? 'resumed' : 'queued')
          item.state = 'queued'; item.error = null; item.approval = null; item.revision++
          entries.push({ id, run: structuredClone(item.run), useSnapshot: Boolean(previous && item.snapshotRef), selection: args.selection })
        }
        return entries
      }, signal)
      if (!scheduled.length) return { reused: args.ids.length, total: 0 }
      const taskId = uuid(), controller = new AbortController(), job = { id: taskId, ids: scheduled.map(item => item.id), owner, controller, done: null }
      this.jobs.set(taskId, job)
      for (const entry of scheduled) {
        entry.control = new AbortController()
        entry.control.articleAttemptId = entry.run.attemptId
        this.runControls.set(entry.run.id, entry.control)
      }
      try {
        const jobId = this.ctx.jobs.start({ kind: 'article-image', ...(owner ? { owner } : {}), label: 'Article capture and analysis', outputLimitBytes: this.config.toolResultBytes,
          run: handle => {
            let cursor = 0, completed = 0
            const results = []
            job.done = Promise.all(Array.from({ length: Math.min(scheduled.length, this.config.fetchConcurrency) }, async () => {
              while (cursor < scheduled.length) {
                const entry = scheduled[cursor++], own = entry.control
                const combined = AbortSignal.any([signal, controller.signal, own.signal])
                let done
                try {
                  done = this.executeRun(entry, combined)
                  if (this.runControls.get(entry.run.id) === own) this.runDone.set(entry.run.id, done)
                  const item = await done; results.push({ id: entry.id, ok: item.state === 'review', state: item.state })
                }
                catch (error) { results.push({ id: entry.id, ok: false, code: errorCode(error), ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) }) }
                finally {
                  // 恢复沿用 run id；旧 attempt 只能释放自己持有的取消句柄和完成等待。
                  if (this.runControls.get(entry.run.id) === own) this.runControls.delete(entry.run.id)
                  if (this.runDone.get(entry.run.id) === done) this.runDone.delete(entry.run.id)
                }
                completed++; handle.updateProgress(JSON.stringify({ completed, total: scheduled.length }))
              }
            })).then(() => ({ status: controller.signal.aborted || signal.aborted ? 'killed' : results.some(item => !item.ok) ? 'failed' : 'completed', result: JSON.stringify({ completed, total: scheduled.length, results }) }))
              .finally(() => this.jobs.delete(taskId))
            return { cancel: () => controller.abort(), done: job.done }
          } })
        return { jobId, taskId, total: scheduled.length }
      } catch (error) {
        controller.abort(); this.jobs.delete(taskId)
        for (const entry of scheduled) if (this.runControls.get(entry.run.id) === entry.control) this.runControls.delete(entry.run.id)
        await this.store.update(state => {
          for (const entry of scheduled) {
            const item = this.item(state, entry.id)
            if (item.run?.attemptId !== entry.run.attemptId) continue
            item.run.status = 'failed'; item.run.error = 'task-start-failed'; item.state = 'failed'; item.error = 'task-start-failed'; item.run.updatedAt = now(); item.revision++
            appendRunEvent(item.run, this.config.maxRunEvents, 'failed', { code: 'task-start-failed' })
          }
        })
        throw error
      }
    })
  }
  async executeRun(entry, signal) {
    const { id, run } = entry
    let operation = 'state-commit'
    try {
      await this.commitRun(id, run.attemptId, signal, item => { item.run.status = 'running'; item.run.stage = entry.useSnapshot ? 'understanding' : 'capturing'; item.state = item.run.stage })
      let item = await this.detail(id), snapshot = entry.useSnapshot ? item.snapshot : null
      if (!snapshot) {
        operation = 'capture'
        const control = new AbortController(), captureSignal = AbortSignal.any([signal, control.signal])
        const progress = createRunProgress({ batchSize: this.config.progressBatchSize, flushMs: this.config.progressFlushMs,
          onFailure: () => control.abort(), write: batch => this.commitRun(id, run.attemptId, signal, current => {
            for (const event of batch) {
              if (event.phase === 'assets' && event.details.completed !== undefined) Object.assign(current.run.counts, { assetsCompleted: event.details.completed, assetsTotal: event.details.total })
              appendRunEvent(current.run, this.config.maxRunEvents, event.event, event.details, event.at)
            }
          }) })
        let captured, captureError
        try { captured = await this.capture.capture(item.url, { language: item.language, signal: captureSignal, onProgress: progress.push }) }
        catch (error) { captureError = error }
        try { await progress.close() } catch (error) { operation = 'progress-write'; throw error }
        if (captureError) throw captureError
        signal.throwIfAborted()
        operation = 'snapshot-write'
        snapshot = snapshotSchema.parse(captured.snapshot)
        if (new URL(snapshot.requestedUrl).href !== new URL(item.url).href) throw failure('source-url-mismatch')
        if (hashSnapshot(snapshot) !== snapshot.sourceHash) throw failure('storage-integrity')
        for (const asset of captured.assets) await this.artifacts.putAsset({ ...asset, contentHash: snapshot.assets.find(value => value.id === asset.id)?.contentHash ?? asset.contentHash })
        const snapshotRef = await this.artifacts.put('snapshots', snapshot)
        await this.commitRun(id, run.attemptId, signal, current => {
          const changed = current.run.sourceHash !== snapshot.sourceHash
          current.snapshotRef = snapshotRef; current.article = null; current.legacy = false; current.sourceReview = null; current.run.sourceHash = snapshot.sourceHash
          if (changed) { current.planRef = null; current.plan = null; current.analysisRef = null; current.run.checkpoints = []; current.run.inputRef = null }
        })
      }
      item = await this.detail(id)
      operation = 'state-commit'
      if (snapshot.quality.status !== 'passed' && !(snapshot.quality.status === 'needs-review' && item.sourceReview?.sourceHash === snapshot.sourceHash)) {
        await this.commitRun(id, run.attemptId, signal, current => { current.state = 'needs-source-review'; current.run.stage = 'needs-source-review'; current.run.status = 'needs-source-review' })
        return this.detail(id)
      }
      const oldInput = item.run.inputRef ? analysisInputSchema.parse(await this.artifacts.get('inputs', item.run.inputRef)) : null
      operation = 'analysis'
      if (oldInput && analysisHash(oldInput.metadata) !== analysisHash(metadataOf(item))) throw failure('analysis-input-changed')
      const controls = oldInput ? { ...this.config.analysis, ...oldInput.budgets, ...oldInput.model } : this.config.analysis
      const runner = this.runner(snapshot), ready = await runner.readiness(snapshot, signal, controls)
      if (!ready.available) {
        await this.commitRun(id, run.attemptId, signal, current => { current.state = 'waiting-config'; current.error = ready.code; current.run.stage = 'waiting-config'; current.run.status = 'waiting-config'; current.run.error = ready.code })
        return this.detail(id)
      }
      const checkpoints = await Promise.all(item.run.checkpoints.map(async checkpoint => analysisCheckpointSchema.parse(await this.artifacts.get('analyses', checkpoint.ref))))
      let inputRef = item.run.inputRef
      const result = await this.withAnalysisSlot(signal, () => runner.run({ articleId: id, snapshot, metadata: { category: item.category, language: item.language, notes: item.notes },
        attemptId: run.attemptId, signal, selection: entry.selection, checkpoint: oldInput ? { input: oldInput, checkpoints } : null,
        onStage: async update => {
          signal.throwIfAborted()
          if (!inputRef && update.input) inputRef = await this.artifacts.put('inputs', analysisInputSchema.parse(update.input))
          const checkpointRef = update.checkpoint ? await this.artifacts.put('analyses', analysisCheckpointSchema.parse(update.checkpoint)) : null
          await this.commitRun(id, run.attemptId, signal, current => {
            current.state = update.stage; current.run.stage = update.stage; current.run.inputRef = inputRef
            if (update.completedChunks !== undefined) {
              const covered = update.input?.chunks.slice(0, update.completedChunks).reduce((sum, chunk) => sum + chunk.blockIds.length, 0) ?? 0
              Object.assign(current.run.counts, { blocksCompleted: covered, blocksTotal: snapshot.blocks.length })
              appendRunEvent(current.run, this.config.maxRunEvents, 'analysis-checkpoint', { completed: covered, total: snapshot.blocks.length })
            }
            if (checkpointRef) current.run.checkpoints = [...current.run.checkpoints.filter(value => value.stageId !== update.checkpoint.stageId), { stageId: update.checkpoint.stageId, ref: checkpointRef }]
          })
        } }))
      signal.throwIfAborted()
      const parsed = analysisResultSchema.parse(result)
      validateAnalysisPlan(parsed.plan, { snapshot, input: parsed.input, understanding: parsed.understanding })
      if (Buffer.byteLength(JSON.stringify(parsed.plan)) > this.config.maxPlanBytes) throw failure('plan-size')
      const analysisRef = await this.artifacts.put('analyses', parsed), planRef = await this.artifacts.put('plans', parsed.plan)
      if (!inputRef) inputRef = await this.artifacts.put('inputs', parsed.input)
      await this.commitRun(id, run.attemptId, signal, current => {
        current.analysisRef = analysisRef; current.planRef = planRef; current.plan = null; current.approval = null; current.error = null; current.state = 'review'
        current.run.status = 'review'; current.run.stage = 'review'; current.run.inputRef = inputRef; current.run.counts.completed = 1
      })
      return this.detail(id)
    } catch (error) {
      const code = signal.aborted ? 'article-cancelled' : errorCode(error), diagnostics = failureDetails(error, operation)
      try { await this.store.update(state => {
        const item = this.item(state, id)
        if (item.run?.attemptId !== run.attemptId || !active(item.run)) return
        item.state = signal.aborted ? 'cancelled' : 'failed'; item.error = code; item.run.status = item.state; item.run.error = code; item.run.updatedAt = now(); item.revision++
        appendRunEvent(item.run, this.config.maxRunEvents, item.state, { code, ...diagnostics })
      }) } catch (publicationError) {
        // 磁盘连终态也无法保存时，仍把脱敏根因交给后台任务结果。
        diagnostics.causes = [...new Set([...(diagnostics.causes ?? []), failureDetails(publicationError, 'state-commit').causeCode])].slice(0, 5)
      }
      throw Object.assign(failure(code), { diagnostics })
    }
  }
  async withAnalysisSlot(signal, operation) {
    while (this.analysisSlots.size >= this.config.analysis.concurrency) {
      let abort
      try { await Promise.race([Promise.race(this.analysisSlots), new Promise((resolve, reject) => { void resolve; abort = () => reject(failure('article-cancelled')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort() })]) }
      finally { signal.removeEventListener('abort', abort) }
    }
    signal.throwIfAborted()
    const running = Promise.resolve().then(operation), settled = running.then(() => {}, () => {})
    this.analysisSlots.add(settled)
    try { return await running } finally { this.analysisSlots.delete(settled) }
  }
  async stopTask(id) {
    const control = this.runControls.get(id)
    if (!control) return super.stopTask(id)
    const done = this.runDone.get(id)
    control.abort()
    await this.store.update(state => {
      const item = state.items.find(value => value.run?.id === id)
      if (!item || item.run.attemptId !== control.articleAttemptId || !active(item.run)) return
      item.run.status = 'cancelled'; item.run.error = 'article-cancelled'; item.run.updatedAt = now(); item.state = 'cancelled'; item.error = 'article-cancelled'; item.revision++
      appendRunEvent(item.run, this.config.maxRunEvents, 'cancelled', { code: 'article-cancelled' })
    })
    if (done) await Promise.allSettled([done])
    return { stopped: true }
  }
  async resumeRun(id) {
    const state = await this.store.read(), item = state.items.find(value => value.run?.id === id)
    if (!item || active(item.run) && alive(item.run.pid)) throw failure('task-unavailable')
    return this.startProcess({ ids: [item.id], reprocess: true }, undefined, id)
  }
  async reviewSource(input) {
    const args = revisionInput.extend({ evidence: z.string().trim().min(1).max(4000) }).parse(input)
    const item = await this.detail(args.id)
    const reviewable = new Set(['unknown-article-scope', 'unsettled-resources', 'resource-request-failed', 'blocked-network-resource'])
    if (!item.snapshot || item.snapshot.quality.status !== 'needs-review' || item.snapshot.quality.reasons.some(reason => !reviewable.has(reason))) throw failure('source-incomplete')
    await this.mutate(state => {
      const current = this.item(state, args.id, args.revision); this.editable(current)
      current.sourceReview = { sourceHash: item.snapshot.sourceHash, evidence: args.evidence, at: now() }; current.revision++
    })
    return this.resumeRun(item.run.id)
  }
  assertMetadata(item) {
    if (analysisHash(item.analysis.input.metadata) !== analysisHash(metadataOf(item))) throw failure('analysis-input-changed')
  }
  /** Read a complete plan as bounded JSON text. Offsets count Unicode code points. @param {object} input Article, exact revision, frozen input hash and offset. @returns {Promise<object>} Reconstructable plan page. */
  async planPage(input) {
    this.requireTools()
    const args = revisionInput.extend({ inputHash: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().nonnegative().default(0) }).strict().parse(input)
    const item = await this.detail(args.id)
    if (!item.plan?.inputHash || item.legacy) throw failure('legacy-needs-refetch')
    if (item.revision !== args.revision) throw failure('stale-revision')
    if (item.plan.inputHash !== args.inputHash) throw failure('stale-source')
    const characters = Array.from(JSON.stringify(item.plan)), remaining = characters.length - args.offset
    if (remaining < 0) throw failure('invalid-request')
    const page = count => ({ id: item.id, revision: item.revision, sourceHash: item.plan.sourceHash, inputHash: item.plan.inputHash, rulesHash: item.plan.rulesHash,
      offset: args.offset, totalCharacters: characters.length, fragment: characters.slice(args.offset, args.offset + count).join(''),
      nextOffset: count === remaining ? null : args.offset + count, encoding: 'json-code-points' })
    const fits = value => Buffer.byteLength(JSON.stringify(value)) <= this.config.toolResultBytes
    const complete = page(remaining)
    if (fits(complete)) return complete
    let low = 0, high = remaining - 1
    while (low < high) {
      const count = Math.ceil((low + high) / 2)
      if (fits(page(count))) low = count; else high = count - 1
    }
    if (low === 0) throw failure('response-size')
    return page(low)
  }
  async manualArticle(input) {
    this.requireTools()
    const args = revisionInput.extend({ title: z.string().trim().min(1).max(2000), text: z.string().min(1).max(500000), language: z.string().max(100).default('') }).parse(input)
    return this.mutate(state => {
      const item = this.item(state, args.id, args.revision); this.editable(item)
      item.article = articleRecord({ title: args.title, text: args.text, language: args.language, url: item.url, basis: 'manual' }, this.config)
      item.snapshotRef = null; item.analysisRef = null; item.planRef = null; item.run = null; item.sourceReview = null
      item.plan = null; item.approval = null; item.legacy = true; item.error = 'legacy-needs-refetch'; item.state = 'ready'; item.revision++
      return structuredClone(item)
    })
  }
  async savePlan(input) {
    this.requireTools()
    if (!input.plan?.inputHash) throw failure('legacy-needs-refetch')
    const args = saveSchema.parse(input), item = await this.detail(args.id)
    if (!item.snapshot || !item.analysis || item.legacy) throw failure('legacy-needs-refetch')
    this.assertMetadata(item)
    if (!['review', 'approved'].includes(item.state) || item.error) throw failure('stale-source')
    if (Buffer.byteLength(JSON.stringify(args.plan)) > this.config.maxPlanBytes) throw failure('plan-size')
    const plan = validateAnalysisPlan(args.plan, { snapshot: item.snapshot, input: item.analysis.input, understanding: item.analysis.understanding })
    const briefChanged = analysisHash(plan.brief) !== analysisHash(item.plan.brief)
    plan.shots = plan.shots.map((shot, index) => {
      const sceneHash = computeSceneHash(shot), prior = item.plan.shots[index]
      const synchronized = args.syncPromptShots.includes(index) || !briefChanged && prior?.promptSceneHash === sceneHash
      return { ...shot, sceneHash, promptSceneHash: synchronized ? sceneHash : '0'.repeat(64) }
    })
    const planRef = await this.artifacts.put('plans', plan)
    return this.mutate(state => {
      const current = this.item(state, args.id, args.revision); this.editable(current)
      if (current.analysisRef !== item.analysisRef || current.snapshotRef !== item.snapshotRef) throw failure('stale-source')
      current.planRef = planRef; current.plan = null; current.approval = null; current.state = 'review'; current.error = null; current.revision++
      return { ...current, plan }
    })
  }
  async approve(input) {
    this.requireTools()
    const args = revisionInput.parse(input), item = await this.detail(args.id)
    if (!item.snapshot || !item.analysis || !item.plan?.inputHash || item.legacy) throw failure('legacy-needs-refetch')
    this.assertMetadata(item)
    validateAnalysisPlan(item.plan, { snapshot: item.snapshot, input: item.analysis.input, understanding: item.analysis.understanding })
    if (item.plan.shots.some(shot => shot.promptSceneHash !== computeSceneHash(shot))) throw failure('prompt-unsynchronized')
    return this.mutate(state => {
      const current = this.item(state, args.id, args.revision); this.editable(current)
      if (current.state !== 'review' || current.planRef !== item.planRef || current.snapshotRef !== item.snapshotRef || current.error) throw failure('stale-source')
      current.state = 'approved'; current.revision++
      current.approval = { revision: current.revision, sourceHash: item.snapshot.sourceHash, inputHash: item.plan.inputHash, planHash: analysisHash(item.plan), at: now(), origin: 'workbench' }
      if (current.run) { current.run.status = 'approved'; current.run.stage = 'approved' }
      return structuredClone(current)
    })
  }
  async assetResponse(request, snapshotId, assetId) {
    try {
      idSchema.parse(snapshotId); idSchema.parse(assetId)
      const state = await this.store.read()
      for (const item of state.items) {
        const snapshot = await this.snapshotOf(item)
        if (snapshot?.id !== snapshotId) continue
        const asset = snapshot.assets.find(value => value.id === assetId && value.status === 'ready')
        if (!asset) break
        const bytes = await this.artifacts.getAsset(asset.contentHash)
        return new Response(bytes, { headers: { 'content-type': asset.mime, 'content-length': String(bytes.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
      }
      return new Response(null, { status: 404 })
    } catch (error) { void error; return new Response(null, { status: 404 }) }
  }
  async action(operation, args, signal) {
    switch (operation) {
      case 'process': return this.startProcess(args)
      case 'fetch': return this.startProcess(args)
      case 'resume': return this.resumeRun(z.object({ id: idSchema }).strict().parse(args).id)
      case 'review-source': return this.reviewSource(args)
      case 'stop': return this.stopTask(z.object({ id: z.string().min(1).max(100) }).strict().parse(args).id)
      default: return super.action(operation, args, signal)
    }
  }
}
