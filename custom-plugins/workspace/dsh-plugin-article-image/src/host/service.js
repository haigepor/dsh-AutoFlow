/** Profile service shared by Agent tools and the workbench. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { Store, hash } from './store.js'
import { downloadSheet, parseSheet } from './sheets.js'
import { extractArticle, articleRecord } from './articles.js'
import { fetchArticlePage, articleFetchError } from './article-fetch.js'
import { mappingSchema } from '../../config-schema.js'
import { failure, errorCode, idSchema, hashSchema, planSchema, revisionInput } from '../shared/contracts.js'

const importSchema = z.object({ url: z.string().url(), mapping: mappingSchema.optional() }).strict()
const listSchema = z.object({ offset: z.number().int().nonnegative().default(0), category: z.string().max(200).optional() }).strict()
const fetchSchema = z.object({ ids: z.array(idSchema).min(1).max(100) }).strict()
const saveSchema = revisionInput.extend({ plan: planSchema })
const manualSchema = revisionInput.extend({ title: z.string().trim().min(1).max(2000), text: z.string().min(1).max(500000), language: z.string().max(100).default('') })
const pageSchema = z.object({ id: idSchema, sourceHash: hashSchema, offset: z.number().int().nonnegative().default(0) }).strict()
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' } }
const summary = ({ article, plan, approval, fetching, raw, ...item }) => ({ ...item, title: article?.title ?? item.url, sourceHash: article?.hash ?? null, shots: plan?.shots.length ?? 0 })

/** One profile owns records and jobs; views never own their execution lifetime. */
export class ArticleService {
  constructor(ctx, config, dependencies = {}) {
    this.ctx = ctx; this.config = config; this.store = dependencies.store ?? new Store(ctx.profileContext.home, ctx.profileContext.dir, config)
    this.download = dependencies.download ?? downloadSheet
    this.largeFetch = dependencies.largeFetch
    this.features = new Set(); this.life = new AbortController(); this.toolsLife = new AbortController(); this.pending = new Set(); this.jobs = new Map()
  }
  requireTools() { if (this.life.signal.aborted || !this.features.has('tools')) throw failure('tools-unavailable') }
  async enable(feature) {
    if (this.features.has(feature)) throw failure('feature-duplicate')
    this.features.add(feature)
    if (feature === 'tools') this.toolsLife = new AbortController()
    return async () => {
      this.features.delete(feature)
      if (feature === 'tools') {
        this.toolsLife.abort()
        for (const job of this.jobs.values()) job.controller.abort()
        await Promise.allSettled([...this.pending, ...[...this.jobs.values()].map(job => job.done)])
      }
    }
  }
  track(operation) {
    const pending = Promise.resolve().then(operation)
    this.pending.add(pending)
    pending.then(() => this.pending.delete(pending), () => this.pending.delete(pending))
    return pending
  }
  mutate(operation, signal = this.toolsLife.signal) {
    return this.track(() => {
      this.requireTools(); signal.throwIfAborted()
      return this.store.update(state => {
        // 等待跨进程写锁后重新检查原功能周期，避免卸载或重新启用后的迟到提交。
        this.requireTools(); signal.throwIfAborted()
        return operation(state)
      })
    })
  }
  async dispose() {
    this.life.abort(); this.features.clear()
    for (const job of this.jobs.values()) job.controller.abort()
    await Promise.allSettled([...this.pending, ...[...this.jobs.values()].map(job => job.done)])
  }
  item(state, id, revision) {
    const item = state.items.find(value => value.id === idSchema.parse(id))
    if (!item) throw failure('item-missing')
    if (revision !== undefined && item.revision !== revision) throw failure('stale-revision')
    return item
  }
  editable(item) {
    if (item.fetching && alive(item.fetching.pid)) throw failure('item-busy')
    item.fetching = null
  }
  async status() {
    const state = await this.store.read()
    return { features: [...this.features], count: state.items.length, source: state.source ?? { url: this.config.sourceUrl, mapping: this.config.mapping },
      retrievalPolicy: { primary: 'configured-web', retryLargeHtml: this.config.retryLargeHtml, retry: 'anonymous-http', maxHtmlBytes: this.config.maxArticleHtmlBytes, maxHtmlChars: this.config.maxArticleHtmlChars, maxFetchBatch: this.fetchBatchLimit() },
      generation: { available: false, reason: 'provider-not-connected' }, pollIntervalMs: this.config.pollIntervalMs,
      jobs: [...this.jobs.values()].map(({ id, ids, owner }) => ({ id, ids, sessionOwned: Boolean(owner) })) }
  }
  importSource(input, signal = this.life.signal) {
    return this.track(async () => {
      this.requireTools()
      const args = importSchema.parse(input), mapping = args.mapping ?? this.config.mapping
      const combined = AbortSignal.any([signal, this.life.signal, this.toolsLife.signal])
      const csv = await this.download(args.url, this.config, combined)
      const parsed = parseSheet(csv, args.url, mapping, this.config.maxRows)
      combined.throwIfAborted(); this.requireTools()
      return this.mutate(state => {
        let added = 0, updated = 0
        for (const record of parsed.items) {
          const existing = state.items.find(item => item.id === record.id)
          if (existing) {
            // 重新导入只更新表格来源；正文、已保存提示词和审核快照保持原样。
            if (JSON.stringify([existing.rows, existing.raw, existing.category, existing.language, existing.notes]) !== JSON.stringify([record.rows, record.raw, record.category, record.language, record.notes])) {
              Object.assign(existing, record, { revision: existing.revision + 1 }); updated++
            }
          } else { state.items.push({ ...record, revision: 1, state: 'imported', article: null, plan: null, approval: null, error: null, fetching: null }); added++ }
        }
        if (state.items.length > this.config.maxRows) throw failure('sheet-size')
        state.source = { url: args.url, mapping, importedAt: new Date().toISOString() }
        return { added, updated, total: state.items.length, rejected: parsed.rejected }
      }, combined)
    })
  }
  async list(input = {}) {
    const args = listSchema.parse(input), state = await this.store.read()
    const items = state.items.filter(item => !args.category || item.category === args.category)
    return { total: items.length, offset: args.offset, previousOffset: Math.max(0, args.offset - this.config.pageSize), nextOffset: args.offset + this.config.pageSize < items.length ? args.offset + this.config.pageSize : null,
      categories: [...new Set(state.items.map(item => item.category))], items: items.slice(args.offset, args.offset + this.config.pageSize).map(item => summary(this.presentItem(item))) }
  }
  async detail(id) {
    const item = this.item(await this.store.read(), id)
    return this.presentItem(item)
  }
  /** Project interrupted legacy fetches without mutating the saved record. @param {object} item Read record. @returns {object} Presented record. */
  presentItem(item) {
    // Host 崩溃后只呈现中断，不在读取页面时自动重新请求远端。
    if (item.state === 'fetching' && item.fetching && !alive(item.fetching.pid)) return { ...item, state: 'interrupted', error: 'article-interrupted' }
    return item
  }
  fetchArticle(id, signal) {
    return this.track(async () => {
      this.requireTools()
      const token = randomUUID(), toolsSignal = this.toolsLife.signal, timeout = AbortSignal.timeout(this.config.requestTimeoutMs)
      const combined = AbortSignal.any([signal, this.life.signal, toolsSignal, timeout])
      try {
        combined.throwIfAborted()
        const item = await this.store.update(state => {
          combined.throwIfAborted(); this.requireTools()
          const item = this.item(state, id); this.editable(item)
          item.state = 'fetching'; item.error = null; item.fetching = { pid: process.pid, token }; item.revision++
          return structuredClone(item)
        })
        const retrieved = await fetchArticlePage(this.ctx.web, this.config, item.url, combined, this.largeFetch)
        combined.throwIfAborted(); this.requireTools()
        const article = extractArticle(retrieved.page, item, this.config)
        const saved = await this.store.update(state => {
          combined.throwIfAborted(); this.requireTools()
          const current = this.item(state, id)
          if (current.fetching?.token !== token) throw failure('stale-revision')
          const changed = current.article?.hash !== article.hash
          current.article = article; current.fetching = null; current.error = null; current.revision++
          if (changed) { current.plan = null; current.approval = null }
          current.state = current.approval ? 'approved' : current.plan ? 'review' : 'ready'
          return structuredClone(current)
        })
        return { ...saved, retrieval: { transport: retrieved.transport, retried: retrieved.retried } }
      } catch (error) {
        const interrupted = signal.aborted || this.life.signal.aborted || toolsSignal.aborted
        const code = interrupted ? 'article-interrupted' : timeout.aborted ? 'article-timeout' : errorCode(articleFetchError(error))
        await this.store.update(state => {
          const current = state.items.find(item => item.id === id)
          if (current?.fetching?.token !== token) return
          current.fetching = null; current.state = interrupted ? 'interrupted' : 'failed'
          current.error = code; current.revision++
        })
        throw failure(code)
      }
    })
  }
  fetchBatchLimit() {
    // 错误码最多 64 个 ASCII 字符；预留任务状态行空间，防止一次性结果被截掉。
    const entry = JSON.stringify({ id: '0'.repeat(32), ok: false, code: 'x'.repeat(64) }).length + 1
    const overhead = JSON.stringify({ results: [], completed: 100, total: 100 }).length + 256
    return Math.min(100, Math.floor((this.config.toolResultBytes - overhead) / entry))
  }
  startFetch(ids, owner) {
    return this.track(async () => {
      this.requireTools(); fetchSchema.parse({ ids })
      if (ids.length > this.fetchBatchLimit()) throw failure('fetch-batch-limit')
      const toolsSignal = this.toolsLife.signal
      if (new Set(ids).size !== ids.length) throw failure('item-duplicate')
      const state = await this.store.read()
      this.requireTools(); toolsSignal.throwIfAborted()
      for (const id of ids) this.item(state, id)
      const id = randomUUID(), controller = new AbortController(), job = { id, ids, owner, controller, done: null }
      this.jobs.set(id, job)
      try {
        const jobId = this.ctx.jobs.start({ kind: 'article-image', ...(owner ? { owner } : {}), label: 'Article retrieval', outputLimitBytes: this.config.toolResultBytes,
          run: handle => {
            let cursor = 0, completed = 0
            const results = []
            job.done = Promise.all(Array.from({ length: Math.min(ids.length, this.config.fetchConcurrency) }, async () => {
              while (cursor < ids.length && !controller.signal.aborted && !this.life.signal.aborted) {
                const itemId = ids[cursor++]
                try { const item = await this.fetchArticle(itemId, controller.signal); results.push({ id: itemId, ok: true, ...item.retrieval }) }
                catch (error) { results.push({ id: itemId, ok: false, code: errorCode(error) }) }
                completed++; handle.updateProgress(JSON.stringify({ completed, total: ids.length }))
              }
            })).then(() => ({ status: controller.signal.aborted || this.life.signal.aborted ? 'killed' : results.some(result => !result.ok) ? 'failed' : 'completed',
              result: JSON.stringify({ results, completed, total: ids.length }) })).finally(() => this.jobs.delete(id))
            return { cancel: () => controller.abort(), done: job.done }
          },
        })
        return { jobId, taskId: id, total: ids.length }
      } catch (error) { this.jobs.delete(id); throw error }
    })
  }
  async stopTask(id) {
    const job = this.jobs.get(id)
    if (!job || job.owner) throw failure('task-unavailable')
    job.controller.abort(); await job.done
    return { stopped: true }
  }
  async manualArticle(input) {
    this.requireTools()
    const args = manualSchema.parse(input)
    return this.mutate(state => {
      const item = this.item(state, args.id, args.revision); this.editable(item)
      item.article = articleRecord({ title: args.title, text: args.text, language: args.language, url: item.url, basis: 'manual' }, this.config)
      item.plan = null; item.approval = null; item.error = null; item.state = 'ready'; item.revision++
      return structuredClone(item)
    })
  }
  articleSource(item) {
    return { requestedUrl: item.url, finalUrl: item.article?.url ?? null, category: item.category.slice(0, 100), notes: item.notes.slice(0, 500), notesTruncated: item.notes.length > 500,
      fetchedAt: item.article?.fetchedAt ?? null, basis: item.article?.basis ?? null, language: (item.article?.language || item.language).slice(0, 100) }
  }
  async articlePage(input) {
    const args = pageSchema.parse(input), item = await this.detail(args.id)
    if (!item.article || item.article.hash !== args.sourceHash || item.state === 'fetching') throw failure('stale-source')
    // 来源业务字段由 report 返回；每页保留地址和时间，给 UTF-8 正文留出字节预算。
    const result = { id: item.id, revision: item.revision, state: item.state, error: item.error, sourceHash: item.article.hash,
      title: item.article.title.slice(0, 160), titleTruncated: item.article.title.length > 160, language: item.article.language,
      basis: item.article.basis, source: { url: item.article.url, fetchedAt: item.article.fetchedAt }, offset: args.offset, paragraphs: [], nextOffset: null, total: item.article.paragraphs.length }
    let characters = 0, end = args.offset
    while (end < item.article.paragraphs.length) {
      const size = item.article.paragraphs[end].text.length
      const next = { ...result, paragraphs: [...result.paragraphs, item.article.paragraphs[end]], nextOffset: end + 1 < item.article.paragraphs.length ? end + 1 : null }
      if (characters + size > this.config.articlePageChars || Buffer.byteLength(JSON.stringify(next)) > this.config.toolResultBytes) break
      Object.assign(result, next)
      characters += size; end++
    }
    if (args.offset < item.article.paragraphs.length && end === args.offset) throw failure('response-size')
    return result
  }
  async savePlan(input) {
    this.requireTools()
    const args = saveSchema.parse(input)
    if (Buffer.byteLength(JSON.stringify(args.plan)) > this.config.maxPlanBytes) throw failure('plan-size')
    return this.mutate(state => {
      const item = this.item(state, args.id, args.revision); this.editable(item)
      if (!item.article || item.article.hash !== args.plan.sourceHash || !['ready', 'review', 'approved'].includes(item.state)) throw failure('stale-source')
      const paragraphs = new Set(item.article.paragraphs.map(paragraph => paragraph.id))
      if (args.plan.shots.some(shot => shot.paragraphs.some(id => !paragraphs.has(id)))) throw failure('paragraph-reference')
      item.plan = args.plan; item.approval = null; item.state = 'review'; item.error = null; item.revision++
      return structuredClone(item)
    })
  }
  async approve(input) {
    this.requireTools()
    const args = revisionInput.parse(input)
    return this.mutate(state => {
      const item = this.item(state, args.id, args.revision); this.editable(item)
      if (!item.article || !item.plan || item.state !== 'review' || item.plan.sourceHash !== item.article.hash) throw failure('stale-source')
      item.revision++; item.state = 'approved'
      item.approval = { revision: item.revision, sourceHash: item.article.hash, planHash: hash(JSON.stringify(item.plan)), at: new Date().toISOString() }
      return structuredClone(item)
    })
  }
  async skip(input) {
    this.requireTools()
    const args = revisionInput.parse(input)
    return this.mutate(state => {
      const item = this.item(state, args.id, args.revision); this.editable(item)
      item.state = 'skipped'; item.approval = null; item.revision++
      return { id: item.id, state: item.state, revision: item.revision }
    })
  }
  /** Validate workbench JSON before selecting an owned operation. @param {string} operation Action. @param {object} args Wire arguments. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Safe result. */
  async action(operation, args, signal) {
    switch (operation) {
      case 'status': return this.status()
      case 'list': return this.list(args)
      case 'detail': return this.detail(z.object({ id: idSchema }).strict().parse(args).id)
      case 'import': return this.importSource(args, signal)
      case 'fetch': return this.startFetch(fetchSchema.parse(args).ids)
      case 'stop': return this.stopTask(z.object({ id: z.string().uuid() }).strict().parse(args).id)
      case 'manual': return this.manualArticle(args)
      case 'save-plan': return this.savePlan(args)
      case 'approve': return this.approve(args)
      case 'skip': return this.skip(args)
      default: throw failure('operation-unavailable')
    }
  }

  /** Serve read-only records with a request-byte cap applied before JSON decoding. @param {Request} request Authenticated gateway request. @returns {Promise<Response>} Bounded JSON. */
  async dataResponse(request) {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    let reader
    try {
      reader = request.body?.getReader()
      if (!reader || !/^application\/json(?:;|$)/i.test(request.headers.get('content-type') ?? '')) throw failure('invalid-request')
      const chunks = []
      let bytes = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > this.config.maxWireBytes) throw failure('request-size')
        chunks.push(chunk.value)
      }
      let json
      try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))) }
      catch { throw failure('invalid-request') }
      const input = z.object({ operation: z.enum(['status', 'list', 'detail', 'article']), args: z.record(z.string(), z.unknown()).default({}) }).strict().parse(json)
      const value = input.operation === 'article' ? await this.articlePage(input.args) : await this.action(input.operation, input.args, request.signal)
      const body = JSON.stringify({ ok: true, value })
      if (Buffer.byteLength(body) > this.config.maxWireBytes) throw failure('response-size')
      return new Response(body, { headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } })
    } catch (error) { return Response.json({ ok: false, error: { code: errorCode(error) } }, { status: 400, headers }) }
    finally {
      if (reader) {
        try { await reader.cancel() } catch (error) {
          // 已失败的流可能拒绝取消；仍须释放 reader，且不覆盖原请求的安全错误码。
          void error
        }
        reader.releaseLock()
      }
    }
  }
}
