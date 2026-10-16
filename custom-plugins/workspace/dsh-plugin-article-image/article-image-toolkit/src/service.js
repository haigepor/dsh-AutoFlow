/** Article records, retrieval and plan persistence shared by every toolkit entry point. */
import { z } from 'zod'
import { Store } from './store.js'
import { downloadSheet, parseSheet } from './sheets.js'
import { extractArticle, articleRecord } from './articles.js'
import { fetchArticlePage } from './fetch.js'
import { mappingSchema } from './config.js'
import { hash } from './hash.js'
import { failure, errorCode, idSchema, hashSchema, planSchema, revisionInput } from './contracts.js'

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
    this.store = dependencies.store ?? new Store(config.dataDir, config)
    this.download = dependencies.download ?? downloadSheet
    this.fetchPage = dependencies.fetchPage ?? fetchArticlePage
    this.life = new AbortController()
  }
  /** Reject use after disposal. @returns {void} Throws when closed. */
  requireOpen() { if (this.life.signal.aborted) throw failure('tools-unavailable') }
  /** Combine a caller signal with the instance lifetime. @param {AbortSignal|undefined} signal Caller signal. @returns {AbortSignal} Cancellation covering both. */
  combined(signal) { return signal ? AbortSignal.any([signal, this.life.signal]) : this.life.signal }
  /** Abort in-flight retrieval. @returns {Promise<void>} Completion after active work settles. */
  async dispose() { this.life.abort() }
  item(state, id, revision) {
    const item = state.items.find(value => value.id === idSchema.parse(id))
    if (!item) throw failure('item-missing')
    if (revision !== undefined && item.revision !== revision) throw failure('stale-revision')
    return item
  }
  /** Summarize configuration, stored source and record counts. @returns {Promise<object>} Readiness report. */
  async status() {
    const state = await this.store.read()
    return { count: state.items.length, source: state.source ?? (this.config.sourceUrl ? { url: this.config.sourceUrl, mapping: this.config.mapping, importedAt: null } : null),
      retrievalPolicy: { maxHtmlBytes: this.config.maxArticleHtmlBytes, maxHtmlChars: this.config.maxArticleHtmlChars, maxFetchBatch: this.fetchBatchLimit(), concurrency: this.config.fetchConcurrency },
      dataDir: this.store.root, generation: { available: false, reason: 'provider-not-connected' } }
  }
  /** Import a public sheet as a local snapshot, preserving saved text and plans. @param {object} input Import arguments. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Import counts and row diagnostics. */
  async importSource(input, signal) {
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
  }
  /** List stored articles with offset paging. @param {object} input List arguments. @returns {Promise<object>} Page of summaries. */
  async list(input = {}) {
    const args = listSchema.parse(input), state = await this.store.read()
    const items = state.items.filter(item => !args.category || item.category === args.category)
    return { total: items.length, offset: args.offset, nextOffset: args.offset + this.config.pageSize < items.length ? args.offset + this.config.pageSize : null,
      categories: [...new Set(state.items.map(item => item.category))], items: items.slice(args.offset, args.offset + this.config.pageSize).map(summary) }
  }
  /** Read one stored article. @param {string} id Article id. @returns {Promise<object>} Stored record. */
  async detail(id) { return this.item(await this.store.read(), id) }
  /** Retrieve one article into its record. @param {string} id Article id. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Saved record with retrieval metadata. */
  async fetchArticle(id, signal) {
    this.requireOpen()
    const combined = this.combined(signal)
    combined.throwIfAborted()
    const item = await this.detail(id)
    const page = await this.fetchPage(this.config, item.url, combined)
    combined.throwIfAborted(); this.requireOpen()
    const article = extractArticle(page, item, this.config)
    return this.store.update(state => {
      combined.throwIfAborted(); this.requireOpen()
      const current = this.item(state, id)
      const changed = current.article?.hash !== article.hash
      current.article = article; current.error = null; current.revision++
      if (changed) { current.plan = null; current.approval = null }
      current.state = current.approval ? 'approved' : current.plan ? 'review' : 'ready'
      return structuredClone(current)
    })
  }
  /** Derive the largest batch that still fits one tool result. @returns {number} Batch size. */
  fetchBatchLimit() {
    // 错误码最多 64 个 ASCII 字符；预留任务状态行空间，防止一次性结果被截掉。
    const entry = JSON.stringify({ id: '0'.repeat(32), ok: false, code: 'x'.repeat(64) }).length + 1
    const overhead = JSON.stringify({ results: [], completed: 100, total: 100 }).length + 256
    return Math.min(100, Math.floor((this.config.toolResultBytes - overhead) / entry))
  }
  /** Retrieve a batch synchronously with bounded concurrency. @param {object} input Batch arguments. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Per-article results. */
  async fetchMany(input, signal) {
    this.requireOpen()
    const args = fetchSchema.parse(input)
    if (args.ids.length > this.fetchBatchLimit()) throw failure('fetch-batch-limit')
    if (new Set(args.ids).size !== args.ids.length) throw failure('item-duplicate')
    const state = await this.store.read()
    for (const id of args.ids) this.item(state, id)
    const results = []
    let cursor = 0
    const worker = async () => {
      while (cursor < args.ids.length && !this.life.signal.aborted) {
        const id = args.ids[cursor++]
        try { const item = await this.fetchArticle(id, signal); results.push({ id, ok: true, title: item.article.title.slice(0, 160), paragraphs: item.article.paragraphs.length }) }
        catch (error) { results.push({ id, ok: false, code: errorCode(error) }) }
      }
    }
    await Promise.all(Array.from({ length: Math.min(args.ids.length, this.config.fetchConcurrency) }, worker))
    const ordered = args.ids.map(id => results.find(result => result.id === id))
    return { completed: ordered.filter(result => result.ok).length, total: args.ids.length, results: ordered }
  }
  /** Replace an article's text without network retrieval. @param {object} input Manual article fields. @returns {Promise<object>} Saved record. */
  async manualArticle(input) {
    this.requireOpen()
    const args = manualSchema.parse(input)
    return this.store.update(state => {
      const item = this.item(state, args.id, args.revision)
      item.article = articleRecord({ title: args.title, text: args.text, language: args.language, url: item.url, basis: 'manual' }, this.config)
      item.plan = null; item.approval = null; item.error = null; item.state = 'ready'; item.revision++
      return structuredClone(item)
    })
  }
  /** Describe where an article's text came from. @param {object} item Stored record. @returns {object} Bounded source fields. */
  articleSource(item) {
    return { requestedUrl: item.url, finalUrl: item.article?.url ?? null, category: item.category.slice(0, 100), notes: item.notes.slice(0, 500), notesTruncated: item.notes.length > 500,
      fetchedAt: item.article?.fetchedAt ?? null, basis: item.article?.basis ?? null, language: (item.article?.language || item.language).slice(0, 100) }
  }
  /** Page through saved article paragraphs. @param {object} input Page arguments. @returns {Promise<object>} Paragraph page. */
  async articlePage(input) {
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
  }
  /** Save a plan against the exact revision and source hash. @param {object} input Plan arguments. @returns {Promise<object>} Saved summary. */
  async savePlan(input) {
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
  }
  /** Mark an article as not requiring images. @param {object} input Revision arguments. @returns {Promise<object>} New state. */
  async skip(input) {
    this.requireOpen()
    const args = revisionInput.parse(input)
    return this.store.update(state => {
      const item = this.item(state, args.id, args.revision)
      item.state = 'skipped'; item.approval = null; item.revision++
      return { id: item.id, state: item.state, revision: item.revision }
    })
  }
  /** Report one article's readiness, source fields, plan summary and approval. @param {string} id Article id. @returns {Promise<object>} Bounded report. */
  async report(id) {
    const item = await this.detail(id)
    const title = item.article?.title ?? item.url
    return { id: item.id, revision: item.revision, state: item.state, title: title.slice(0, 300), titleTruncated: title.length > 300,
      sourceHash: item.article?.hash ?? null, paragraphs: item.article?.paragraphs.length ?? 0, source: this.articleSource(item),
      plan: item.plan ? { theme: item.plan.brief.theme, shots: item.plan.shots.map(shot => ({ purpose: shot.purpose, paragraphs: shot.paragraphs, ratio: shot.ratio })) } : null,
      approval: item.approval, error: item.error, generationAvailable: false }
  }
}
