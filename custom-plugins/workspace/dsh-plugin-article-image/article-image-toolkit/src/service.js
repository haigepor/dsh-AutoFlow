/** Article records, retrieval and plan persistence shared by every toolkit entry point. */
import { z } from 'zod'
import { Store } from './store.js'
import { downloadSheet, parseSheet } from './sheets.js'
import { extractArticle, articleRecord, structuredArticle } from './articles.js'
import { fetchArticlePage } from './fetch.js'
import { Renderer } from './render.js'
import { CookieJar } from './session.js'
import { pacer } from './pacing.js'
import { ResponseCache } from './cache.js'
import { DiagnosticRuns, reportProgress } from './diagnostics.js'
import { join } from 'node:path'
import { planRungs, escalate } from './pipeline.js'
import { CaptureSourceService } from './capture-service.js'
import { CaptureRenderer } from './capture-renderer.js'
import { Recorder } from './recorder.js'
import { replayExchange, bodyPreview } from './replay.js'
import { redactExchange } from './har.js'
import { ownerOf } from './endpoints.js'
import { createPublicRequest } from './capture-media.js'
import { mappingSchema } from './config.js'
import { hash } from './hash.js'
import { failure, errorCode, idSchema, hashSchema, planSchema, revisionInput } from './contracts.js'

// 静态管线失败后升级到浏览器渲染的判定在 pipeline.js：按失败族决定，不再按错误码白名单。

const importSchema = z.object({ url: z.string().url(), mapping: mappingSchema.optional() }).strict()
const listSchema = z.object({ offset: z.number().int().nonnegative().default(0), category: z.string().max(200).optional() }).strict()
const fetchSchema = z.object({ ids: z.array(idSchema).min(1).max(100) }).strict()
const saveSchema = revisionInput.extend({ plan: planSchema })
const manualSchema = revisionInput.extend({ title: z.string().trim().min(1).max(2000), text: z.string().min(1).max(500000), language: z.string().max(100).default('') })
const pageSchema = z.object({ id: idSchema, sourceHash: hashSchema, offset: z.number().int().nonnegative().default(0) }).strict()
const summary = ({ article, plan, approval, raw, ...item }) => ({ ...item, title: article?.title ?? item.url, sourceHash: article?.hash ?? null, shots: plan?.shots.length ?? 0 })

/** One toolkit instance owns records and retrieval; callers never own execution lifetime. */
export class ArticleService {
  constructor(config, dependencies = {}) {
    this.config = config
    this.diagnostics = new DiagnosticRuns(config)
    this.store = dependencies.store ?? new Store(config.dataDir, config)
    this.download = dependencies.download ?? downloadSheet
    this.fetchPage = dependencies.fetchPage ?? fetchArticlePage
    this.jar = dependencies.jar ?? new CookieJar({ maxCookies: config.maxSessionCookies })
    this.pacer = dependencies.pacer ?? new pacer(config)
    // 响应缓存默认关闭：只有在部署明确接受“按源站 Cache-Control 复用正文”时才开启。
    this.cache = dependencies.cache ?? (config.fetchCache ? new ResponseCache(join(config.dataDir, 'http-cache')) : null)
    this.renderer = dependencies.renderer ?? new Renderer(config, { jar: this.jar })
    this.richCapture = dependencies.captureService ?? new CaptureSourceService(config, { capture: dependencies.capture, renderer: dependencies.recordRenderer, jar: this.jar })
    this.recorder = dependencies.recorder ?? new Recorder(config)
    this.recordRenderer = dependencies.recordRenderer ?? null
    this.ownedRenderer = null
    this.replayRequest = dependencies.replayRequest ?? createPublicRequest(config, dependencies)
    this.life = new AbortController()
    this.active = new Set()
    this.disposing = null
  }
  /** Reject use after disposal. @returns {void} Throws when closed. */
  requireOpen() { if (this.life.signal.aborted) throw failure('tools-unavailable') }
  /** Combine a caller signal with the instance lifetime. @param {AbortSignal|undefined} signal Caller signal. @returns {AbortSignal} Cancellation covering both. */
  combined(signal) { return signal ? AbortSignal.any([signal, this.life.signal]) : this.life.signal }
  /** Register an operation before its first asynchronous suspension. @param {Function} operation Owned asynchronous work. @returns {Promise<object>} Original outcome after work settles. */
  run(operation) {
    this.requireOpen()
    const pending = operation()
    this.active.add(pending)
    void pending.finally(() => this.active.delete(pending)).catch(error => { void error })
    return pending
  }
  /** Abort new work and await all requests, durable writes and owned renderers. Repeated calls share shutdown. @returns {Promise<void>} Quiescence, or a renderer shutdown failure after other work settles. */
  dispose() {
    if (!this.disposing) {
      // 先发布共享关闭 promise，再发 abort，避免取消监听器重入时重复释放依赖。
      this.disposing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => this.renderer.dispose()),
          Promise.resolve().then(() => this.richCapture.dispose()),
          Promise.resolve().then(() => this.ownedRenderer?.dispose()),
        ])
        await Promise.allSettled([...this.active])
        const failed = results.find(result => result.status === 'rejected')
        if (failed) throw failed.reason
      })
      this.life.abort()
    }
    return this.disposing
  }
  /** Capture rich article content without changing legacy records. @param {object} input URL/language. @param {AbortSignal} signal Cancellation. @param {Function} [onProgress] Optional stage observer. @returns {Promise<object>} Snapshot summary. */
  async captureSource(input, signal, onProgress) { return this.run(async () => this.richCapture.captureSource(input, this.combined(signal), onProgress)) }
  /** Read blocks and asset metadata from an immutable rich snapshot. @param {object} input Snapshot id/offset. @returns {Promise<object>} Bounded rich page. */
  async sourcePage(input) { return this.run(async () => { this.requireOpen(); return this.richCapture.sourcePage(input) }) }
  item(state, id, revision) {
    const item = state.items.find(value => value.id === idSchema.parse(id))
    if (!item) throw failure('item-missing')
    if (revision !== undefined && item.revision !== revision) throw failure('stale-revision')
    return item
  }
  /** Summarize configuration, stored source and record counts. @returns {Promise<object>} Readiness report. */
  async status() {
    return this.run(async () => {
      const state = await this.store.read()
      return { count: state.items.length, source: state.source ?? (this.config.sourceUrl ? { url: this.config.sourceUrl, mapping: this.config.mapping, importedAt: null } : null),
        retrievalPolicy: { maxHtmlBytes: this.config.maxArticleHtmlBytes, maxHtmlChars: this.config.maxArticleHtmlChars, maxFetchBatch: this.fetchBatchLimit(), concurrency: this.config.fetchConcurrency, renderMode: this.config.renderMode,
          ladder: planRungs(this.config.renderMode), hostRatePerSecond: this.config.hostRatePerSecond, hostBurst: this.config.hostBurst, maxSessionCookies: this.config.maxSessionCookies, responseCache: this.cache !== null },
        dataDir: this.store.root, generation: { available: false, reason: 'provider-not-connected' } }
    })
  }
  /** Import a public sheet as a local snapshot, preserving saved text and plans. @param {object} input Import arguments. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Import counts and row diagnostics. */
  async importSource(input, signal) {
    return this.run(async () => {
      this.requireOpen()
      const args = importSchema.parse(input), mapping = args.mapping ?? this.config.mapping
      const combined = this.combined(signal)
      const csv = await this.download(args.url, this.config, combined)
      const parsed = parseSheet(csv, args.url, mapping, this.config.maxRows)
      combined.throwIfAborted(); this.requireOpen()
      return this.store.update(state => {
        let added = 0, updated = 0
        for (const record of parsed.items) {
          const existing = state.items.find(item => item.id === record.id)
          if (existing) {
            // 重新导入只更新表格来源；正文、已保存提示词和审核快照保持原样。
            if (JSON.stringify([existing.rows, existing.raw, existing.category, existing.language, existing.notes]) !== JSON.stringify([record.rows, record.raw, record.category, record.language, record.notes])) {
              Object.assign(existing, record, { revision: existing.revision + 1 }); updated++
            }
          } else { state.items.push({ ...record, revision: 1, state: 'imported', article: null, plan: null, approval: null, error: null }); added++ }
        }
        if (state.items.length > this.config.maxRows) throw failure('sheet-size')
        state.source = { url: args.url, mapping, importedAt: new Date().toISOString() }
        return { added, updated, total: state.items.length, rejected: parsed.rejected }
      })
    })
  }
  /** List stored articles with offset paging. @param {object} input List arguments. @returns {Promise<object>} Page of summaries. */
  async list(input = {}) {
    return this.run(async () => {
      const args = listSchema.parse(input), state = await this.store.read()
      const items = state.items.filter(item => !args.category || item.category === args.category)
      return { total: items.length, offset: args.offset, nextOffset: args.offset + this.config.pageSize < items.length ? args.offset + this.config.pageSize : null,
        categories: [...new Set(state.items.map(item => item.category))], items: items.slice(args.offset, args.offset + this.config.pageSize).map(summary) }
    })
  }
  /** Read one stored article. @param {string} id Article id. @returns {Promise<object>} Stored record. */
  async detail(id) { return this.run(async () => { return this.item(await this.store.read(), id) }) }
  /** Retrieve one article into its record. @param {string} id Article id. @param {AbortSignal} signal Cancellation. @param {Function|undefined} onProgress Safe rung observer. @returns {Promise<object>} Saved record with retrieval metadata. */
  async fetchArticle(id, signal, onProgress) {
    return this.run(async () => {
      this.requireOpen()
      const combined = this.combined(signal)
      combined.throwIfAborted()
      const item = await this.detail(id)
      const article = await this.readArticle(item, combined, onProgress)
      combined.throwIfAborted(); this.requireOpen()
      return this.store.update(state => {
        combined.throwIfAborted(); this.requireOpen()
        const current = this.item(state, id)
        const changed = current.article?.hash !== article.hash
        current.article = article; current.error = null; current.revision++
        if (changed) { current.plan = null; current.approval = null }
        current.state = current.approval ? 'approved' : current.plan ? 'review' : 'ready'
        return structuredClone(current)
      })
    })
  }
  /** Read and extract one article by walking the configured strategy ladder. @param {object} item Stored record. @param {AbortSignal} signal Cancellation. @param {Function|undefined} onProgress Safe rung observer. @returns {Promise<object>} Durable article. */
  async readArticle(item, signal, onProgress) {
    return this.run(async () => {
      const rungs = planRungs(this.config.renderMode)
      const state = { static: null, rendered: null, visible: null }
      let rung = rungs[0]
      const report = (phase, event, details = {}) => reportProgress(onProgress, { phase, event, details: { itemId: item.id, rung, origin: new URL(item.url).origin, ...details } })
      const extracted = async article => {
        await report('extracting', 'article-extracted', { blocks: article.paragraphs.length, chars: article.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0) })
        return article
      }
      while (rung) {
        const phase = rung === 'browser' ? 'rendering' : rung === 'structured' ? 'extracting' : 'fetching'
        await report(phase, 'rung-started')
        try {
          signal.throwIfAborted()
          const page = await this.attempt(rung, item, signal, state)
          await report(phase, 'response-received', { statusCode: page.statusCode })
          return await extracted(extractArticle(page, item, this.config))
        } catch (error) {
          signal.throwIfAborted()
          const failure = errorCode(error)
          if (failure === 'article-interrupted') throw error
          await report(phase, 'rung-failed', { code: failure })
          // 浏览器这一级在一次渲染里已有第二种投影：序列化 DOM 读不出来时，用同一份渲染的可见文本再抽一次。
          if (rung === 'browser' && state.visible) {
            const page = { ...state.rendered, declaredTitle: state.rendered.visibleTitle || undefined, body: { kind: 'text', content: state.visible } }
            state.visible = null
            try { return await extracted(extractArticle(page, item, this.config)) } catch (second) { signal.throwIfAborted(); void second; throw error }
          }
          // 阶梯按失败族决定下一级，中间级不构成咽喉：403 直接跳到浏览器，受限页一次都不渲染。
          const following = escalate(rungs, rung, failure)
          if (!following) throw error
          rung = following
        }
      }
      throw failure('article-extraction')
    })
  }

  /**
   * Run one ladder rung.
   * `structured` re-reads the cached static page, so it never issues a second request;
   * `browser` runs once and keeps both projections, so a page whose serialized markup lost
   * text does not pay for a second navigation.
   * @param {string} rung Rung id.
   * @param {object} item Stored record.
   * @param {AbortSignal} signal Cancellation.
   * @param {object} state Cached rung outputs.
   * @returns {Promise<object>} Page result for extraction.
   */
  async attempt(rung, item, signal, state) {
    if (rung === 'static') {
      state.static = await this.fetchPage(this.config, item.url, signal, undefined, { jar: this.jar, pacer: this.pacer, cache: this.cache })
      return state.static
    }
    if (rung === 'structured') {
      const page = state.static
      if (!page || page.body.kind !== 'html') throw failure('article-extraction')
      const declared = structuredArticle(page.body.content)
      if (!declared) throw failure('article-extraction')
      // declaredTitle 让抽取阶段优先采用页面自述标题，而不是列表页的通用标题。
      return { ...page, declaredTitle: declared.title, body: { kind: 'text', content: declared.text } }
    }
    if (rung === 'browser') {
      const rendered = await this.renderer.render(item.url, signal)
      state.rendered = rendered
      // 可见文本是同一份渲染的第二投影，只在序列化 DOM 抽不出正文时兜底，不按长度预筛：
      // 两者单位不同（HTML 标记 vs 纯文本），比长度没有意义。没有正文区域时渲染器返回空文本，
      // 因此页面框架永远不会被当成文章首段。
      state.visible = rendered.visible || null
      return rendered
    }
    throw failure('article-extraction')
  }
  /** Derive the largest batch that still fits one tool result. @returns {number} Batch size. */
  fetchBatchLimit() {
    // 错误码最多 64 个 ASCII 字符；预留任务状态行空间，防止一次性结果被截掉。
    const entry = JSON.stringify({ id: '0'.repeat(32), ok: false, code: 'x'.repeat(64) }).length + 1
    const overhead = JSON.stringify({ results: [], completed: 100, total: 100 }).length + 256
    return Math.min(100, Math.floor((this.config.toolResultBytes - overhead) / entry))
  }
  /** Retrieve a batch synchronously with bounded concurrency. @param {object} input Batch arguments. @param {AbortSignal} signal Cancellation. @param {Function|undefined} onProgress Safe completion observer. @returns {Promise<object>} Per-article results, including interrupted ids that did not start. */
  async fetchMany(input, signal, onProgress) {
    return this.run(async () => {
      this.requireOpen()
      const args = fetchSchema.parse(input)
      if (args.ids.length > this.fetchBatchLimit()) throw failure('fetch-batch-limit')
      if (new Set(args.ids).size !== args.ids.length) throw failure('item-duplicate')
      const state = await this.store.read()
      for (const id of args.ids) this.item(state, id)
      const results = []
      let cursor = 0, finished = 0
      const worker = async () => {
        while (cursor < args.ids.length && !this.life.signal.aborted && !signal?.aborted) {
          const id = args.ids[cursor++]
          try { const item = await this.fetchArticle(id, signal, onProgress); results.push({ id, ok: true, title: item.article.title.slice(0, 160), paragraphs: item.article.paragraphs.length }) }
          catch (error) { results.push({ id, ok: false, code: errorCode(error) }) }
          await reportProgress(onProgress, { phase: 'fetching', event: 'article-finished', completed: ++finished, total: args.ids.length,
            details: results.at(-1).ok ? {} : { code: results.at(-1).code } })
        }
      }
      await Promise.all(Array.from({ length: Math.min(args.ids.length, this.config.fetchConcurrency) }, worker))
      const ordered = args.ids.map(id => results.find(result => result.id === id) ?? { id, ok: false, code: 'article-interrupted' })
      return { completed: ordered.filter(result => result.ok).length, total: args.ids.length, results: ordered }
    })
  }
  /** Replace an article's text without network retrieval. @param {object} input Manual article fields. @returns {Promise<object>} Saved record. */
  async manualArticle(input) {
    return this.run(async () => {
      this.requireOpen()
      const args = manualSchema.parse(input)
      return this.store.update(state => {
        const item = this.item(state, args.id, args.revision)
        item.article = articleRecord({ title: args.title, text: args.text, language: args.language, url: item.url, basis: 'manual' }, this.config)
        item.plan = null; item.approval = null; item.error = null; item.state = 'ready'; item.revision++
        return structuredClone(item)
      })
    })
  }
  /** Describe where an article's text came from. @param {object} item Stored record. @returns {object} Bounded source fields. */
  articleSource(item) {
    return { requestedUrl: item.url, finalUrl: item.article?.url ?? null, category: item.category.slice(0, 100), notes: item.notes.slice(0, 500), notesTruncated: item.notes.length > 500,
      fetchedAt: item.article?.fetchedAt ?? null, basis: item.article?.basis ?? null, language: (item.article?.language || item.language).slice(0, 100) }
  }
  /** Page through saved article paragraphs. @param {object} input Page arguments. @returns {Promise<object>} Paragraph page. */
  async articlePage(input) {
    return this.run(async () => {
      const args = pageSchema.parse(input), item = await this.detail(args.id)
      if (!item.article || item.article.hash !== args.sourceHash) throw failure('stale-source')
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
    })
  }
  /** Save a plan against the exact revision and source hash. @param {object} input Plan arguments. @returns {Promise<object>} Saved summary. */
  async savePlan(input) {
    return this.run(async () => {
      this.requireOpen()
      const args = saveSchema.parse(input)
      if (Buffer.byteLength(JSON.stringify(args.plan)) > this.config.maxPlanBytes) throw failure('plan-size')
      return this.store.update(state => {
        const item = this.item(state, args.id, args.revision)
        if (!item.article || item.article.hash !== args.plan.sourceHash || !['ready', 'review', 'approved'].includes(item.state)) throw failure('stale-source')
        const paragraphs = new Set(item.article.paragraphs.map(paragraph => paragraph.id))
        if (args.plan.shots.some(shot => shot.paragraphs.some(id => !paragraphs.has(id)))) throw failure('paragraph-reference')
        item.plan = args.plan; item.approval = null; item.state = 'review'; item.error = null; item.revision++
        return { id: item.id, revision: item.revision, state: item.state, sourceHash: item.article.hash, shots: item.plan.shots.length }
      })
    })
  }
  /** Mark an article as not requiring images. @param {object} input Revision arguments. @returns {Promise<object>} New state. */
  async skip(input) {
    return this.run(async () => {
      this.requireOpen()
      const args = revisionInput.parse(input)
      return this.store.update(state => {
        const item = this.item(state, args.id, args.revision)
        item.state = 'skipped'; item.approval = null; item.revision++
        return { id: item.id, state: item.state, revision: item.revision }
      })
    })
  }
  /** Report one article's readiness, source fields, plan summary and approval. @param {string} id Article id. @returns {Promise<object>} Bounded report. */
  async report(id) {
    return this.run(async () => {
      const item = await this.detail(id)
      const title = item.article?.title ?? item.url
      return { id: item.id, revision: item.revision, state: item.state, title: title.slice(0, 300), titleTruncated: title.length > 300,
        sourceHash: item.article?.hash ?? null, paragraphs: item.article?.paragraphs.length ?? 0, source: this.articleSource(item),
        plan: item.plan ? { theme: item.plan.brief.theme, shots: item.plan.shots.map(shot => ({ purpose: shot.purpose, paragraphs: shot.paragraphs, ratio: shot.ratio })) } : null,
        approval: item.approval, error: item.error, generationAvailable: false }
    })
  }
  /** Record one page load as a private network capture. @param {object} input URL and scope. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Bounded capture summary. */
  async recordCapture(input, signal) {
    return this.run(async () => {
      this.requireOpen()
      const combined = this.combined(signal)
      const renderer = this.recordRenderer ?? this.ownedRenderer ?? (this.ownedRenderer = new CaptureRenderer(this.config.capture, { request: createPublicRequest(this.config.capture), jar: this.jar }))
      const capture = await this.recorder.record(input.url, { renderer, signal: combined, scope: input.scope, language: input.language ?? '' })
      this.requireOpen()
      return {
        captureId: capture.id, requestedUrl: capture.requestedUrl, scope: capture.scope,
        entries: capture.entries, dropped: capture.dropped, bytes: capture.bytes,
        endpoints: capture.endpoints.length, siteEndpoints: capture.endpoints.filter(endpoint => endpoint.owner === 'site').length,
        trackerEndpoints: capture.endpoints.filter(endpoint => endpoint.owner === 'tracker').length,
        generationAvailable: false,
      }
    })
  }
  /** Page through a capture's endpoint inventory. @param {object} input Capture id, offset and owner filter. @returns {Promise<object>} Bounded endpoint page. */
  async captureEndpoints(input) {
    return this.run(async () => {
      this.requireOpen()
      const capture = await this.recorder.index(input.captureId)
      const offset = input.offset ?? 0
      const all = input.owner === 'all' ? capture.endpoints : capture.endpoints.filter(endpoint => endpoint.owner === (input.owner ?? 'site'))
      const result = { captureId: capture.id, owner: input.owner ?? 'site', total: all.length, offset, nextOffset: null, endpoints: [] }
      for (let index = offset; index < all.length && result.endpoints.length < this.config.pageSize; index++) {
        const next = { ...result, endpoints: [...result.endpoints, all[index]], nextOffset: index + 1 < all.length ? index + 1 : null }
        if (Buffer.byteLength(JSON.stringify(next)) > this.config.toolResultBytes) break
        Object.assign(result, next)
      }
      if (offset < all.length && !result.endpoints.length) throw failure('response-size')
      return result
    })
  }
  /** Read one recorded exchange, redacted unless explicitly revealed. @param {object} input Capture id, index and reveal switch. @returns {Promise<object>} Bounded exchange view. */
  async captureExchange(input) {
    return this.run(async () => {
      this.requireOpen()
      const exchange = await this.recorder.exchange(input.captureId, input.index)
      const view = redactExchange(exchange, { reveal: input.reveal === true })
      const preview = bodyPreview(view.response.body, 4096)
      return {
        captureId: input.captureId, index: exchange.index, resourceType: exchange.resourceType,
        startedAt: exchange.startedAt, timingMs: exchange.timingMs, replayed: exchange.replayed === true,
        sent: exchange.sent !== false, blocked: exchange.blocked ?? null,
        owner: ownerOf(new URL(exchange.request.url).host),
        revealsCredentials: view.revealsCredentials,
        request: { method: view.request.method, url: view.request.url, headers: view.request.headers, bodyPreview: typeof view.request.body === 'string' ? view.request.body.slice(0, 2048) : null },
        response: { status: view.response.status, headers: view.response.headers, mime: view.response.mime, bodyBytes: view.response.bodyBytes, bodyPreview: preview.preview, truncated: preview.truncated },
      }
    })
  }
  /** Replay one recorded exchange with overrides, then append the result to the capture. @param {object} input Capture id, index, overrides and credential policy. @returns {Promise<object>} Replay outcome. */
  async replayCapture(input) {
    return this.run(async () => {
      this.requireOpen()
      const combined = this.combined(undefined)
      const exchange = await this.recorder.exchange(input.captureId, input.index)
      const credentials = input.credentials ?? 'inherit'
      // omit 时剥离录制时的凭据头，用于判断端点是否依赖会话。
      const base = credentials === 'omit'
        ? { ...exchange, request: { ...exchange.request, headers: Object.fromEntries(Object.entries(exchange.request.headers).filter(([name]) => !/^(?:authorization|cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i.test(name))) } }
        : exchange
      const result = await replayExchange(base, input.overrides ?? {}, { request: this.replayRequest, limits: {
        maxExchangeBytes: this.config.maxExchangeBytes,
      }, signal: combined })
      const appendedIndex = await this.recorder.append(input.captureId, result)
      const preview = bodyPreview(result.response.body, 4096)
      return {
        captureId: input.captureId, sourceIndex: input.index, appendedIndex,
        status: result.response.status, mime: result.response.mime, bodyBytes: result.response.bodyBytes,
        timingMs: result.timingMs, credentials, bodyPreview: preview.preview, truncated: preview.truncated,
      }
    })
  }
  /** Export a capture as a HAR document. @param {string} captureId Capture id. @returns {Promise<object>} Export summary. */
  async exportCaptureHar(captureId) {
    return this.run(async () => {
      this.requireOpen()
      return this.recorder.exportHar(captureId, '0.1.0')
    })
  }
  /** Import a HAR document into a new capture. @param {object} input Export file name or inline document. @returns {Promise<object>} Import summary. */
  async importCaptureHar(input) {
    return this.run(async () => {
      this.requireOpen()
      const capture = await this.recorder.importHar(input)
      return { captureId: capture.id, requestedUrl: capture.requestedUrl, scope: capture.scope, entries: capture.entries, endpoints: capture.endpoints.length }
    })
  }
}
