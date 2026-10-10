import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { summary } from './afp-refresh-workflow.js'
import { agentError } from './afp-agent-errors.js'
import { isPrivateSelection } from '../vendor/auto-afp-img/afp-collection-run.mjs'
import { buildPhotoSearchRequest, CATEGORY_PROFILES } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { categoryTargets } from './afp-category-bindings.js'

const languages = new Set(['en', 'fr', 'es', 'ar', 'de', 'pt'])
const decisions = new Set(['all', 'kept', 'rejected', 'failed'])
const categories = new Set(CATEGORY_PROFILES.map(profile => profile.key))
const imageTypes = new Map([
  ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif'],
])

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid AFP ${name}`)
  return value
}

function pageNumber(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid AFP ${name}`)
  return value
}

function photoId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Invalid AFP photo ID')
  }
  return value
}

function photoDto(photo) {
  const rawId = photo?.id ?? photo?.uno
  if (typeof rawId !== 'string') throw new Error('Invalid AFP photo ID')
  const id = photoId(rawId.trim())
  const rawKeywords = Array.isArray(photo.entityKeywords) ? photo.entityKeywords : photo.afpEntityKeyword
  const keywords = Array.isArray(rawKeywords) ? rawKeywords
    .map(item => String(item?.keyword ?? item ?? '').trim()).filter(Boolean) : []
  const provider = photo?.partner?.gcp?.provider_code ?? photo?.provider
  return {
    id,
    guid: typeof photo.guid === 'string' ? photo.guid : null,
    title: typeof photo.title === 'string' ? photo.title : id,
    // FAR 官网当前返回字符串数组；保留旧字符串兼容，避免真实说明文字被丢弃。
    caption: Array.isArray(photo.caption) ? photo.caption.filter(value => typeof value === 'string').join(' ')
      : typeof photo.caption === 'string' ? photo.caption : '',
    keywords,
    provider: typeof provider === 'string' && provider ? provider : null,
    previewPath: `api/afp/preview?photoId=${encodeURIComponent(id)}`,
  }
}

function placeholder(id) {
  return { id, guid: null, title: id, caption: '', keywords: [], provider: null,
    previewPath: `api/afp/preview?photoId=${encodeURIComponent(id)}` }
}

function maskUsername(value) {
  const username = String(value ?? '')
  if (!username) return null
  return username.length <= 2 ? `${username.slice(0, 1)}***` : `${username.slice(0, 1)}***${username.slice(-1)}`
}

function createdAt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function byCreatedAt(left, right) {
  if (left.createdAt === null && right.createdAt !== null) return 1
  if (left.createdAt !== null && right.createdAt === null) return -1
  return (right.createdAt ?? 0) - (left.createdAt ?? 0) || left.id.localeCompare(right.id)
}

function collectionDto(selection, selections, bindings = {}) {
  const privateSelection = isPrivateSelection(selection)
  const category = categoryTargets(selections, bindings).find(target => target.id === selection.id)?.category ?? null
  return { id: selection.id, name: String(selection.name ?? ''), isPrivate: privateSelection,
    readOnly: !privateSelection, count: Number.isSafeInteger(selection.docsCount) && selection.docsCount >= 0 ? selection.docsCount : null, category }
}

// 图片工作台只排除明确的非图片文档；旧选集缺少 docClass 时仍保留，写入流程继续核对完整成员。
function collectionPhotoIds(selection) {
  const rows = Array.isArray(selection) ? selection : selection?.docs ?? selection?.content ?? selection?.documents ?? []
  if (!Array.isArray(rows)) throw new Error('Invalid AFP collection contents')
  return [...new Set(rows.filter(item => !item?.docClass || ['picture', 'photo'].includes(String(item.docClass).toLowerCase()))
    .map(item => typeof item === 'string' ? item : item?.id ?? item?.uno)
    .filter(id => typeof id === 'string' && id.trim()).map(id => photoId(id.trim())))]
}

function imageKind(bytes) {
  if (!(bytes instanceof Uint8Array)) return null
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71
    && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'png'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'webp'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).match(/^GIF8[79]a$/)) return 'gif'
  return null
}

/** Local, allowlisted DTOs for the AFP workbench; no raw vendor records leave this Host module. */
export class WorkbenchData {
  constructor({ ctx, config, store, connection }) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.connection = connection
    this.lifecycle = new AbortController()
    this.readLifecycle = new AbortController()
    this.active = new Set()
    this.disposed = false
  }

  /** Start a fresh read generation after the read feature is enabled again. */
  enableReads() {
    if (this.disposed) throw new Error('AFP workbench is disposed')
    if (this.readLifecycle.signal.aborted) this.readLifecycle = new AbortController()
  }

  /** Abort and drain current network reads when the feature is disabled. */
  async disableReads() {
    this.readLifecycle.abort(new Error('AFP read capability disabled'))
    await Promise.allSettled([...this.active])
  }

  /** Abort and drain every in-flight page read before the profile service is disposed. */
  async dispose() {
    if (this.disposed) return
    this.disposed = true
    this.lifecycle.abort(new Error('AFP workbench disposed'))
    this.readLifecycle.abort(new Error('AFP workbench disposed'))
    await Promise.allSettled([...this.active])
  }

  async track(callerSignal, network, operation) {
    if (this.disposed) throw new Error('AFP workbench is disposed')
    const signals = [this.lifecycle.signal, callerSignal]
    if (network) signals.push(this.readLifecycle.signal)
    const signal = AbortSignal.any(signals.filter(Boolean))
    signal.throwIfAborted()
    const task = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return operation(signal)
    })
    this.active.add(task)
    try {
      const result = await task
      signal.throwIfAborted()
      return result
    } finally {
      this.active.delete(task)
    }
  }

  async accountSummary(signal) {
    return this.track(signal, false, async () => {
      const info = await this.connection.configurationInfo()
      const username = await this.connection.credentials.resolve(this.connection.config.usernameRef)
      const dir = this.ctx.profileContext.dir
      return { username: maskUsername(username?.value), credentials: info.credentials, token: info.token,
        references: { accessTokenRef: this.config.accessTokenRef, usernameRef: this.config.usernameRef,
          passwordRef: this.config.passwordRef, visionKeyRef: this.config.visionKeyRef },
        visionConfigured: Boolean(this.connection.config.visionModel && this.connection.config.visionBaseUrl),
        profile: this.ctx.profileContext.name || basename(dir),
        settings: { language: this.config.language, pageSize: this.config.pageSize,
          targetPerCategory: this.config.targetPerCategory, threshold: this.config.threshold } }
    })
  }

  async photoSearch(args, callerSignal, progress = () => {}) {
    object(args, 'photo search arguments')
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 2000) throw new Error('Invalid AFP query')
    if (args.cursor !== undefined && (typeof args.cursor !== 'string' || args.cursor.length > 8192)) throw new Error('Invalid AFP cursor')
    const limit = pageNumber(args.limit, this.config.pageSize, 1, this.config.pageSize, 'page size')
    const language = args.language ?? this.config.language
    if (!languages.has(language)) throw new Error('Invalid AFP language')
    return this.track(callerSignal, true, async signal => {
      const { client } = await this.connection.open(signal, false, false, false, event => progress({ retryCount: event.retryCount }))
      progress({ stage: 'search' })
      const query = `caption=${JSON.stringify(args.query.trim())}`
      const request = buildPhotoSearchRequest({ criteria: query }, limit, query, args.cursor ?? null)
      request.variables.input.lang = language
      const response = await client.searchPhotos(request)
      const rows = Array.isArray(response?.docs) ? response.docs : []
      const nextCursor = response?.cursor
      const hasMore = rows.length > 0 && response?.hasMore === true && typeof nextCursor === 'string' && nextCursor.trim().length > 0
        && nextCursor.length <= 8192 && nextCursor !== (args.cursor ?? null)
      return { items: rows.map(photoDto), cursor: hasMore ? nextCursor : null, hasMore,
        ...(response?.hasMore === true && rows.length > 0 && !hasMore ? { paginationStopped: true } : {}) }
    })
  }

  async accountProfile(callerSignal) {
    return this.track(callerSignal, true, async signal => {
      const { readAccountProfile } = await this.connection.open(signal)
      return readAccountProfile()
    })
  }

  async photoDetails(args, callerSignal) {
    object(args, 'photo details arguments')
    const id = photoId(args.photoId)
    return this.track(callerSignal, true, async signal => {
      const { client } = await this.connection.open(signal)
      const rows = await client.photosByIds([id])
      const found = Array.isArray(rows) ? rows.find(item => String(item?.id ?? item?.uno ?? '') === id) : undefined
      return found ? photoDto(found) : null
    })
  }

  async collectionList(callerSignal) {
    return this.track(callerSignal, true, async signal => {
      const { client, account } = await this.connection.open(signal)
      const selections = await client.listSelections()
      if (!Array.isArray(selections)) throw new Error('Invalid AFP collection list')
      const bindings = account ? await this.store.readBindings(account) : { values: {} }
      return { items: selections.filter(item => typeof item?.id === 'string' && item.id)
        .map(item => collectionDto(item, selections, bindings.values)), bindings: categoryTargets(selections, bindings.values) }
    })
  }

  async collectionItems(args, callerSignal) {
    object(args, 'collection items arguments')
    const id = photoId(args.collectionId)
    const offset = pageNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'collection offset')
    const limit = pageNumber(args.limit, this.config.pageSize, 1, this.config.pageSize, 'page size')
    return this.track(callerSignal, true, async signal => {
      const { client, account } = await this.connection.open(signal)
      const selections = await client.listSelections()
      if (!Array.isArray(selections)) throw new Error('Invalid AFP collection list')
      const matches = selections.filter(item => item?.id === id)
      if (matches.length !== 1) throw new Error('AFP collection is not available to this account')
      const selection = matches[0]
      // 空名称目录项不在工作台可浏览清单中，不将其作为共享收藏夹调用成员接口。
      if (!String(selection.name ?? '').trim()) throw new Error('AFP collection has no display name')
      const ids = collectionPhotoIds(await client.getSelection(id))
      const page = ids.slice(offset, offset + limit)
      const fetched = page.length ? await client.photosByIds(page) : []
      const byId = new Map()
      for (const item of Array.isArray(fetched) ? fetched : []) {
        const key = item?.id ?? item?.uno
        if (typeof key === 'string' && page.includes(key.trim())) byId.set(key.trim(), photoDto(item))
      }
      return { items: page.map(photo => byId.get(photo) ?? placeholder(photo)), offset, total: ids.length,
        hasMore: offset + page.length < ids.length, collection: collectionDto(selection, selections, account ? (await this.store.readBindings(account)).values : {}) }
    })
  }

  async runItems(args, callerSignal) {
    object(args, 'run items arguments')
    const runId = args.runId
    if (typeof runId !== 'string' || !runId) throw new Error('Invalid AFP run ID')
    const decisionFilter = args.decision ?? 'all'
    if (!decisions.has(decisionFilter)) throw new Error('Invalid AFP decision filter')
    const offset = pageNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'run offset')
    const limit = pageNumber(args.limit, this.config.pageSize, 1, this.config.pageSize, 'page size')
    return this.track(callerSignal, false, async signal => {
      const run = await this.store.readRun(runId)
      signal.throwIfAborted()
      if (args.category !== undefined && (!categories.has(args.category) || !run.categories.includes(args.category))) throw new Error('AFP category is not part of this run')
      const decisionsByKey = new Map(run.decisions.map(item => [`${item.category}\n${item.id}`, item]))
      const candidates = []
      for (const [category, group] of Object.entries(run.groups)) {
        if (args.category !== undefined && category !== args.category) continue
        for (const candidate of group.candidates) candidates.push({ category, candidate })
      }
      if (run.pending && (args.category === undefined || run.pending.category === args.category)) {
        for (const candidate of run.pending.candidates) candidates.push({ category: run.pending.category, candidate })
      }
      const items = candidates.map(({ category, candidate }) => {
        const photo = photoDto(candidate)
        if (!photo) return null
        const decision = decisionsByKey.get(`${category}\n${photo.id}`)
        const requestFailed = decision?.reason === 'preview or vision request failed'
        return { ...photo, category, keep: typeof decision?.keep === 'boolean' ? decision.keep : null,
          confidence: Number.isFinite(decision?.confidence) ? decision.confidence : null,
          reason: typeof decision?.reason === 'string' ? decision.reason : '', requestFailed }
      }).filter(Boolean).filter(item => decisionFilter === 'all'
        || (decisionFilter === 'kept' && item.keep === true)
        || (decisionFilter === 'rejected' && item.keep === false && !item.requestFailed)
        || (decisionFilter === 'failed' && item.requestFailed))
      return { items: items.slice(offset, offset + limit), offset, total: items.length,
        hasMore: offset + Math.min(limit, Math.max(0, items.length - offset)) < items.length, run: summary(run) }
    })
  }

  async historyList(args, callerSignal) {
    object(args, 'history arguments')
    const kind = args.kind ?? 'all'
    if (!['all', 'runs', 'plans'].includes(kind)) throw new Error('Invalid AFP history kind')
    const offset = pageNumber(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'history offset')
    const limit = pageNumber(args.limit, this.config.pageSize, 1, this.config.pageSize, 'page size')
    return this.track(callerSignal, false, async signal => {
      const rows = []
      for (const selected of kind === 'all' ? ['runs', 'plans'] : [kind]) {
        let files
        try { files = await readdir(join(this.store.profile, selected)) }
        catch (error) { if (error.code === 'ENOENT') continue; throw error }
        for (const file of files.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
          signal.throwIfAborted()
          const id = file.slice(0, -5)
          try {
          if (selected === 'runs') {
            const run = await this.store.readRun(id)
            rows.push({ kind: 'run', id, createdAt: createdAt(run.createdAt), status: run.status, run: summary(run) })
          } else {
            const plan = await this.store.readPlan(id)
            const result = plan.result && typeof plan.result === 'object' ? {
              status: plan.result.status,
              categories: Array.isArray(plan.result.categories) ? plan.result.categories.map(item => ({ category: item.category,
                status: item.status, removed: item.removed, added: item.added })) : [],
            } : null
            rows.push({ kind: 'plan', id, createdAt: createdAt(plan.createdAt), status: plan.state, plan: {
              operation: plan.operation, expiresAt: plan.expiresAt,
              targets: plan.targets.map(target => ({ category: target.category, name: target.name,
                existing: target.existing, remove: plan.operation === 'append' ? 0 : target.existing,
                add: target.docs.length, create: target.id === null && plan.operation !== 'clear' })), result,
            } })
          }
          } catch (error) {
            // 归档可与列表读取并发；仅忽略已移走的记录，损坏或不安全的文件仍报错。
            if (error.code !== 'ENOENT') throw error
          }
        }
      }
      rows.sort(byCreatedAt)
      return { items: rows.slice(offset, offset + limit), offset, total: rows.length,
        hasMore: offset + Math.min(limit, Math.max(0, rows.length - offset)) < rows.length }
    })
  }

  async previewResponse(request) {
    const safeHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { ...safeHeaders, allow: 'GET' } })
    let url
    try { url = new URL(request.url) }
    catch (error) {
      // 忽略 URL 解析错误，不回显请求内容或底层异常。
      return new Response('Invalid preview request', { status: 400, headers: safeHeaders })
    }
    if ([...url.searchParams.keys()].some(key => key !== 'photoId')) return new Response('Invalid photo ID', { status: 400, headers: safeHeaders })
    const values = url.searchParams.getAll('photoId')
    if (values.length !== 1) return new Response('Invalid photo ID', { status: 400, headers: safeHeaders })
    let id
    try { id = photoId(values[0]) }
    catch (error) {
      // 忽略无效 photoId 的详细值，避免将请求数据写入响应。
      return new Response('Invalid photo ID', { status: 400, headers: safeHeaders })
    }
    const readSignal = this.readLifecycle.signal
    try {
      const result = await this.track(request.signal, true, async signal => {
        const { previewClient } = await this.connection.open(signal, false, false, true)
        if (!previewClient) throw new Error('Preview client unavailable')
        return previewClient.getPreviewBytes(id)
      })
      const kind = imageKind(result?.bytes)
      const contentType = imageTypes.get(kind)
      const declaredType = typeof result?.contentType === 'string' ? result.contentType.split(';', 1)[0].trim().toLowerCase() : ''
      // APICore/CDN 可能把有效栅格图片标为二进制流；按签名输出准确类型，拒绝 HTML、SVG 和冲突的图片类型。
      if (!contentType || !['', contentType, 'application/octet-stream', ...(kind === 'jpeg' ? ['image/jpg'] : [])].includes(declaredType)) {
        return Response.json({ code: 'unsupported-image' }, { status: 502, headers: safeHeaders })
      }
      return new Response(result.bytes, { status: 200, headers: { ...safeHeaders, 'content-type': contentType } })
    } catch (error) {
      if (request.signal.aborted || readSignal.aborted || this.disposed) throw error
      const blocked = error?.code === 'preview-host-blocked' && typeof error.hostname === 'string' && /^[a-z0-9.-]+$/.test(error.hostname)
      // 502仅是本地预览代理状态；认证和配置拒绝不能被浏览器误当作临时网络故障。
      const retryable = !blocked && (agentError(error, 'read', 0).retryable || (error instanceof TypeError && error.message === 'fetch failed')
        || /^mockup download failed with HTTP (408|429|500|502|503|504)$/.test(error.message))
      return Response.json(blocked ? { code: 'preview-host-blocked', host: error.hostname, retryable: false }
        : { code: 'preview-unavailable', retryable }, { status: 502, headers: safeHeaders })
    }
  }
}
