import { ConversationRecords, photoResultEnvelope } from './afp-conversation-records.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, digest } from './afp-state-store.js'
import { Connection } from './afp-credentials.js'
import { Changes } from './afp-change-plans.js'
import { WorkbenchData } from './afp-workbench-data.js'
import { AfpDownloads, downloadErrorCode } from './afp-downloads.js'
import { categories, chooseCategories, refreshRun, reservedIds, summary } from './afp-refresh-workflow.js'
import { planAfpSearch } from '../vendor/auto-afp-img/afp-search-planner.mjs'
import { CATEGORY_PROFILES } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { isPrivateSelection, selectionDocIds } from '../vendor/auto-afp-img/afp-collection-run.mjs'
import { resolveConfig } from '../../config-schema.js'

function photoMembership(selection) {
  const rows = Array.isArray(selection) ? selection : selection?.docs ?? selection?.content ?? selection?.documents ?? []
  if (!Array.isArray(rows)) throw new Error('Invalid AFP collection contents')
  return new Set(rows.map(item => typeof item === 'string' ? item : item?.id ?? item?.uno)
    .filter(id => typeof id === 'string').map(id => id.trim()).filter(Boolean))
}

/** Shared profile service. Closing a view never cancels an admitted task. */
export class AfpService {
  constructor(ctx, config, dependencies = {}) {
    this.ctx = ctx; this.config = config
    this.store = dependencies.store ?? new Store(ctx.profileContext.home, ctx.profileContext.dir, config.maxStateBytes)
    this.conversationRecords = new ConversationRecords(this.store, config)
    this.connection = dependencies.connection ?? new Connection(ctx.credentials, config)
    this.workbench = dependencies.workbench ?? new WorkbenchData({ ctx, config, store: this.store, connection: this.connection })
    this.connect = (...args) => this.connection.open(...args)
    this.changes = dependencies.changes ?? new Changes({ store: this.store, config, connect: this.connect })
    this.flags = new Set(); this.live = new Map(); this.challenges = new Map(); this.stopping = false; this.writeEpoch = 0
    this.pageOwner = `profile:${digest(ctx.profileContext.dir)}`
    this.previewCacheScope = randomUUID()
    this.downloads = dependencies.downloads ?? new AfpDownloads({ ctx, config, connection: this.connection, store: this.store,
      schedule: (feature, label, operation) => this.job(feature, undefined, label, operation), requireFeature: feature => this.require(feature) })
  }
  require(feature) { if (this.stopping || !this.flags.has(feature)) throw new Error(`AFP feature unavailable: ${feature}`) }
  async enable(feature) {
    if (this.flags.has(feature)) throw new Error(`Duplicate AFP feature: ${feature}`)
    this.flags.add(feature)
    if (feature === 'read') { this.previewCacheScope = randomUUID(); this.workbench.enableReads() }
    if (feature === 'write') this.writeEpoch++
    return async () => {
      this.flags.delete(feature)
      if (feature === 'read') this.previewCacheScope = randomUUID()
      if (feature === 'write') { this.writeEpoch++; this.challenges.clear() }
      const tasks = [...this.live.values()].filter(task => task.feature === feature)
      for (const task of tasks) task.controller.abort()
      await Promise.allSettled(tasks.map(task => task.done))
      if (feature === 'read') await this.workbench.disableReads()
    }
  }
  async dispose() {
    this.stopping = true; this.challenges.clear(); this.flags.clear()
    const tasks = [...this.live.values()]
    for (const task of tasks) task.controller.abort()
    await this.workbench.dispose()
    this.downloads.dispose()
    await Promise.allSettled(tasks.map(task => task.done))
    this.conversationRecords.dispose()
  }
  /** Admit a Session-owned Agent job or an unowned profile job; outcomes wait for resource release. */
  job(feature, owner, label, operation) {
    this.require(feature)
    const taskId = randomUUID()
    const jobId = this.ctx.jobs.start({ kind: 'afp', ...(owner ? { owner } : {}), label, outputLimitBytes: this.config.outputLimitBytes,
      run: handle => {
        const controller = new AbortController(), task = { taskId, feature, owner, controller, done: null }
        this.live.set(taskId, task)
        const tracked = { ...handle, updateProgress: progress => { task.progress = progress; handle.updateProgress(progress) } }
        task.done = Promise.resolve().then(() => operation(controller.signal, tracked)).then(
          result => ({ status: controller.signal.aborted ? 'killed' : ['failed', 'cancelled'].includes(result.status) ? 'failed' : 'completed', result: JSON.stringify(result) }),
          () => ({ status: controller.signal.aborted ? 'killed' : 'failed', detail: 'AFP operation failed. Check setup and the saved report; remote writes may be partial.' }),
        ).finally(() => this.live.delete(taskId))
        return { cancel: () => controller.abort(), done: task.done }
      },
    })
    return { jobId, taskId }
  }
  async startRefresh(args, owner, signal, progress = () => {}) {
    this.require('refresh'); signal.throwIfAborted()
    const targetOverride = Object.hasOwn(args, 'targetPerCategory')
    const thresholdOverride = Object.hasOwn(args, 'threshold')
    const hasOverrides = targetOverride || thresholdOverride
    if (args.runId && (args.categories || hasOverrides)) throw new Error('Resume uses saved categories and settings; overrides require a new page run')
    if (owner && hasOverrides) throw new Error('Run setting overrides are available only for new page runs')
    const runConfig = hasOverrides ? resolveConfig({ ...this.config,
      ...(targetOverride ? { targetPerCategory: args.targetPerCategory } : {}),
      ...(thresholdOverride ? { threshold: args.threshold } : {}),
    }) : this.config
    const run = args.runId ? await this.store.readRun(args.runId) : await this.store.createRun(chooseCategories(args.categories), runConfig)
    const scheduled = this.job('refresh', owner, 'AFP visual dry-run', (taskSignal, handle) => this.store.lock(`run:${run.id}`, async () => {
      let stage = 'connection'
      progress({ stage, state: 'running', runId: run.id })
      try {
      const current = await this.store.readRun(run.id), services = await this.connect(taskSignal, false, true)
      return await this.store.lock(`account:${services.account}`, async () => {
        if (current.account && current.account !== services.account) throw new Error('AFP account changed since refresh')
        current.account = services.account
        stage = 'collection-deduplication'
        progress({ stage: 'collections' })
        const reserved = await reservedIds(services.client, taskSignal)
        stage = 'screening'
        const result = await refreshRun({ run: current, store: this.store, config: current.settings, ...services, reserved, signal: taskSignal,
          onProgress: event => {
            progress({ stage: 'visual', state: 'running', completed: event.reviewed, total: event.total, category: event.category })
            const text = JSON.stringify(event)
            stage = 'progress-update'; handle.updateProgress(text)
            stage = 'progress-output'; handle.append(text + '\n')
            stage = 'screening'
          } })
        progress({ state: 'completed', stage: 'completed', completed: result.decisions.length, total: result.decisions.length })
        return summary(result)
      })
      } catch (error) {
        progress({ state: taskSignal.aborted ? 'stopped' : 'failed', stage: taskSignal.aborted ? 'stopped' : 'failed' })
        // 仅记录本地阶段与代码位置，不记录远端异常正文、令牌或媒体引用。
        const frames = String(error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line))
          .map(line => line.match(/([a-z0-9-]+\.(?:js|mjs|ts):\d+:\d+)/i)?.[1]).filter(Boolean).slice(0, 5)
        this.ctx.logger?.warn('AFP refresh failed', { runId: run.id, stage, cancelled: taskSignal.aborted, frames })
        // 仅持有运行锁的任务可更新失败状态，避免并发续跑覆写正在工作的任务。
        const saved = await this.store.readRun(run.id)
        if (!['cancelled', 'failed'].includes(saved.status)) {
          saved.status = taskSignal.aborted ? 'cancelled' : 'failed'
          await this.store.saveRun(saved)
        }
        throw error
      }
    }))
    return { ...scheduled, runId: run.id }
  }
  async collections(signal, progress = () => {}) {
    this.require('read')
    const { client } = await this.connection.open(signal, false, false, false, event => progress({ retryCount: event.retryCount })), selections = await client.listSelections(), result = []
    for (const profile of CATEGORY_PROFILES) {
      progress({ stage: 'collections', completed: result.length, total: CATEGORY_PROFILES.length, category: profile.key })
      const matches = selections.filter(item => item.name === profile.selectionName)
      const privateTarget = matches.length === 1 && isPrivateSelection(matches[0])
      result.push({ category: profile.key, selectionName: profile.selectionName, status: matches.length === 0 ? 'missing' : privateTarget ? 'private' : 'conflict',
        count: privateTarget ? selectionDocIds(await client.getSelection(matches[0].id)).size : null })
    }
    return { categories: result }
  }
  search(query) {
    this.require('read')
    if (typeof query !== 'string' || !query.trim() || query.length > 2000) throw new Error('Invalid AFP query')
    return planAfpSearch({ query, nature: 'photos', language: this.config.language })
  }
  async report(args) {
    if (Boolean(args.runId) === Boolean(args.planId)) throw new Error('Choose runId or planId')
    if (args.runId) return summary(await this.store.readRun(args.runId))
    const plan = await this.store.readPlan(args.planId)
    return { planId: plan.id, operation: plan.operation, state: plan.state, result: plan.result ?? null }
  }
  async reports() {
    const result = []
    for (const kind of ['runs', 'plans']) {
      let files
      try { files = await readdir(join(this.store.profile, kind)) }
      catch (error) { if (error.code === 'ENOENT') continue; throw error }
      for (const file of files.filter(file => /^[a-f0-9-]{36}\.json$/.test(file)).sort().slice(-12)) result.push(await this.report({ [kind === 'runs' ? 'runId' : 'planId']: file.slice(0, -5) }))
    }
    return result
  }
  async status() {
    return { ...(await this.connection.status()), writesEnabled: this.flags.has('write'), features: [...this.flags], categories, scope: 'profile',
      tasks: [...this.live.values()].filter(task => !task.owner).map(({ taskId, feature, progress }) => ({ taskId, feature, progress: progress ?? null })),
      downloads: await this.downloads.status(), reports: await this.reports(), pollIntervalMs: this.config.pollIntervalMs }
  }
  async collectionOperation(args, signal) {
    this.require('write')
    const action = args.action
    const photoIds = Array.isArray(args.photoIds) ? [...new Set(args.photoIds.map(value => {
      if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid AFP photo ID')
      return value
    }))] : []
    if (!['remove', 'copy', 'move'].includes(action) || !photoIds.length || photoIds.length > 120) throw new Error('Invalid AFP collection operation')
    const sources = args.photoSources
    if (!sources || typeof sources !== 'object' || Array.isArray(sources)
      || Object.keys(sources).some(id => !photoIds.includes(id))) throw new Error('Invalid AFP source collection map')
    const targetId = args.targetCollectionId
    if (action !== 'remove' && (typeof targetId !== 'string' || targetId.length > 256)) throw new Error('Choose an AFP target collection')
    const { client, account } = await this.connection.open(signal, true)
    return this.store.lock(`collection-actions:${account}`, async () => {
      const selections = await client.listSelections()
      const byId = new Map(selections.filter(item => typeof item?.id === 'string').map(item => [item.id, item]))
      const sourceIds = [...new Set(photoIds.flatMap(id => {
        const values = sources[id] ?? []
        if (!Array.isArray(values) || values.some(value => typeof value !== 'string' || value.length > 256)) throw new Error('Invalid AFP source collection list')
        return values
      }))]
      const target = action === 'remove' ? null : byId.get(targetId)
      if (action !== 'remove' && (!target || !isPrivateSelection(target))) throw new Error('Target collection is missing, shared or read-only')
      if (action !== 'copy') {
        for (const id of sourceIds) {
          const selection = byId.get(id)
          if (!selection || !isPrivateSelection(selection)) throw new Error('A source collection is missing, shared or read-only')
        }
      }
      if (action === 'move' && sourceIds.includes(targetId)) throw new Error('Choose a different target collection')
      const photoRows = await client.photosByIds(photoIds)
      const photos = new Map((Array.isArray(photoRows) ? photoRows : []).map(photo => [String(photo?.id ?? photo?.uno ?? ''), photo]))
      const memberships = new Map()
      // 加入操作只需读取目标；已知来源可能只读或已消失，不能阻止添加关系。
      for (const id of [...(action === 'copy' ? [] : sourceIds), ...(target ? [targetId] : [])]) memberships.set(id, photoMembership(await client.getSelection(id)))
      for (const photoId of photoIds) {
        const assigned = sources[photoId] ?? []
        if (action !== 'copy' && (!assigned.length || assigned.some(id => !memberships.get(id)?.has(photoId)))) {
          throw new Error('A selected image no longer belongs to the indicated writable source')
        }
      }
      const outcomes = []
      for (const photoId of photoIds) {
        signal.throwIfAborted()
        const photo = photos.get(photoId)
        if (!photo) { outcomes.push({ photoId, status: 'failed', errorCode: 'photo-unavailable' }); continue }
        const assigned = sources[photoId] ?? []
        const trackedIds = [...new Set([...assigned, ...(target ? [targetId] : [])])]
        const currentSourceIds = () => trackedIds.filter(id => (action === 'copy' && id !== targetId) || memberships.get(id)?.has(photoId))
        const doc = { id: photoId, ...(typeof photo.guid === 'string' ? { guid: photo.guid } : {}),
          ...(typeof photo.title === 'string' ? { title: photo.title } : {}), docClass: 'picture',
          ...(typeof photo?.partner?.gcp?.provider_code === 'string' ? { provider: photo.partner.gcp.provider_code } : {}) }
        let operationMutated = false, membershipWritePending = false
        const alreadyPresent = target && memberships.get(targetId).has(photoId)
        try {
          if (target && !memberships.get(targetId).has(photoId)) {
            membershipWritePending = true
            await client.addSelectionDoc(targetId, doc)
            operationMutated = true
            const verifiedTarget = photoMembership(await client.getSelection(targetId))
            if (!verifiedTarget.has(photoId)) throw new Error('target-verification-failed')
            memberships.set(targetId, verifiedTarget)
            membershipWritePending = false
          }
          if (action !== 'copy') {
            for (const sourceId of assigned) {
              membershipWritePending = true
              await client.deleteSelectionDocs(sourceId, [photoId])
              operationMutated = true
              const verifiedSource = photoMembership(await client.getSelection(sourceId))
              if (verifiedSource.has(photoId)) throw new Error('source-removal-unverified')
              memberships.set(sourceId, verifiedSource)
              membershipWritePending = false
            }
          }
          outcomes.push({ photoId, title: String(photo.title ?? photoId).slice(0, 200), status: 'completed', errorCode: null, sourceCollectionIds: currentSourceIds(),
            ...(action === 'copy' ? { membershipChange: alreadyPresent ? 'already-present' : 'added' } : {}) })
        } catch (error) {
          outcomes.push({ photoId, title: String(photo.title ?? photoId).slice(0, 200), status: membershipWritePending ? 'pending' : operationMutated ? 'partial' : 'failed',
            errorCode: membershipWritePending ? 'write-result-uncertain' : /verification|unverified/i.test(String(error?.message)) ? 'verification-failed' : 'operation-failed',
            ...(membershipWritePending ? {} : { sourceCollectionIds: currentSourceIds() }) })
        }
      }
      return { action, completed: outcomes.filter(item => item.status === 'completed').length,
        partial: outcomes.filter(item => item.status === 'partial').length, pending: outcomes.filter(item => item.status === 'pending').length,
        failed: outcomes.filter(item => item.status === 'failed').length, items: outcomes }
    })
  }
  /** Acquire or refresh the AFP token through the configured credential provider. */
  async acquireToken(signal) {
    await this.connection.open(signal)
    return { acquired: true }
  }
  async pagePlan(args, signal) {
    this.require('write')
    const epoch = this.writeEpoch
    const report = await this.changes.plan(args, this.pageOwner, signal)
    this.require('write')
    if (epoch !== this.writeEpoch) throw new Error('AFP write capability changed; create a new preview')
    // 确认凭据仅发给页面，重启后须重新预览；不写入报告或会话。
    this.challenges.clear()
    const confirmation = randomBytes(32).toString('hex')
    this.challenges.set(confirmation, { planId: report.planId, expiresAt: report.expiresAt })
    return { ...report, confirmation }
  }
  async pageConfirm({ planId, confirmation, confirmed }, signal) {
    this.require('write'); signal.throwIfAborted()
    const challenge = this.challenges.get(confirmation)
    if (confirmed !== true || !challenge || challenge.planId !== planId || challenge.expiresAt <= Date.now()) throw new Error('AFP confirmation refused, expired or already consumed')
    // 入队前消费，重复网络提交不会再次执行。
    this.challenges.delete(confirmation)
    await this.changes.check(planId, this.pageOwner)
    return { ...this.job('write', undefined, 'AFP confirmed profile write', taskSignal => this.changes.execute(planId, this.pageOwner, taskSignal)), planId }
  }
  async cancel(taskId) {
    const task = this.live.get(taskId)
    if (!task || task.owner) throw new Error('AFP profile task is no longer running; Agent jobs use Session cancellation')
    task.controller.abort(); await task.done
    return { taskId, cancelled: true }
  }
  async previewResponse(request) {
    if (this.stopping || !this.flags.has('read')) return new Response('AFP read unavailable', {
      status: 403, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    })
    return this.workbench.previewResponse(request)
  }
  /** 接收同源工作台元数据请求，绕过 plugin-manager 的模型输出上限，但保留独立响应字节上限。 */
  async workbenchDataResponse(request) {
    return this.workbench.track(request.signal, false, signal => this.readWorkbenchData(request, signal))
  }
  async readWorkbenchData(request, signal) {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-type': 'application/json; charset=utf-8' }
    const response = (status, code, value) => new Response(JSON.stringify(value ?? { ok: false, error: { code } }), { status, headers })
    const invalid = () => response(400, 'invalid-request')
    const tooLarge = () => response(413, 'response-too-large')
    const unavailable = () => response(503, 'unavailable')
    let reader, cancelBody
    try {
      if (request.method !== 'POST' || new URL(request.url).search || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(request.headers.get('content-type') ?? '') || !request.body) return invalid()
      reader = request.body.getReader()
      cancelBody = () => { void reader.cancel(signal.reason).catch(error => { /* 取消已结束的请求体时忽略流错误。 */ }) }
      signal.addEventListener('abort', cancelBody, { once: true })
      const chunks = []
      let size = 0
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > this.config.maxResponseBytes) {
          await reader.cancel().catch(error => { /* 请求体已超过限制，忽略取消流时的解析错误。 */ })
          return tooLarge()
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      let payload
      try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch (error) { /* 无效 UTF-8 或 JSON 只返回固定请求错误，不回显正文。 */ return invalid() }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !['operation', 'args'].includes(key))
        || typeof payload.operation !== 'string' || !Object.hasOwn(payload, 'operation')) return invalid()
      const allowed = new Set(['conversation-progress', 'conversation-result', 'account-summary', 'account-profile', 'photo-search', 'photo-details', 'collection-list', 'collection-items', 'run-items', 'history-list', 'download-options'])
      if (!allowed.has(payload.operation)) return invalid()
      const args = payload.args ?? {}
      if (!args || typeof args !== 'object' || Array.isArray(args)) return invalid()
      signal.throwIfAborted()
      let result
      try {
        if (payload.operation.startsWith('conversation-')) result = await this.conversationData(payload.operation, args)
        else result = await this.pageAction({ operation: payload.operation, args: JSON.stringify(args) }, signal)
      }
      catch (error) { signal.throwIfAborted(); return response(503, downloadErrorCode(error) ?? 'unavailable') }
      const body = JSON.stringify({ ok: true, value: result })
      if (new TextEncoder().encode(body).byteLength > this.config.maxResponseBytes) return tooLarge()
      return new Response(body, { status: 200, headers })
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return invalid()
      return unavailable()
    } finally {
      if (cancelBody) signal.removeEventListener('abort', cancelBody)
      reader?.releaseLock()
    }
  }
  async conversationData(operation, args) {
    this.require('read')
    if (typeof args.sessionId !== 'string' || !Number.isSafeInteger(args.turn) || args.turn < 1
      || Object.keys(args).some(key => !['sessionId', 'turn', 'callId', 'resultRef'].includes(key))) throw new Error('Invalid AFP arguments')
    const session = this.ctx.get('sessions')?.get(args.sessionId)
    if (operation === 'conversation-progress') {
      if (!session || session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn !== args.turn) return []
      return this.conversationRecords.snapshot(args.sessionId, args.turn, args.callId)
    }
    const events = session ? session.snapshotEvents() : (await this.ctx.sessionQuery.readSession(args.sessionId)).events
    const calls = new Map()
    let matched = false
    for (const event of events) {
      const data = event.data
      if (event.type === 'tool/call' && data.turn === args.turn) calls.set(data.callId, data.name)
      if (event.type === 'tool/result' && data.turn === args.turn && calls.has(data.message.toolCallId)
        && photoResultEnvelope(data.message, data.meta)?.resultRef === args.resultRef) {
        matched = true; args = { ...args, callId: data.message.toolCallId }
      }
      if (event.type === 'tool/ptc-dispatch' && calls.has(data.rootCallId) && photoResultEnvelope(data)?.resultRef === args.resultRef) {
        matched = true; args = { ...args, callId: data.subCallId }
      }
    }
    if (!matched) throw new Error('AFP selection lacks current turn evidence')
    return this.conversationRecords.read(args, args.resultRef)
  }
  async pageAction(input, signal, progress) {
    if (Object.keys(input).some(key => !['operation', 'args'].includes(key)) || typeof input.operation !== 'string') throw new Error('Invalid AFP page operation')
    const args = JSON.parse(input.args ?? '{}')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid AFP operation arguments')
    const allowed = { status: [], collections: [], search: ['query'], refresh: ['categories', 'runId', 'targetPerCategory', 'threshold'],
      'account-summary': [], 'account-profile': [], 'photo-search': ['query', 'cursor', 'limit', 'language'], 'photo-details': ['photoId'],
      'collection-list': [], 'collection-items': ['collectionId', 'offset', 'limit'],
      'run-items': ['runId', 'category', 'decision', 'offset', 'limit'], 'history-list': ['kind', 'offset', 'limit'],
      'download-options': ['photoIds'], 'pick-download-directory': ['path'], 'browse-download-directory': ['path'],
      'download-prepare': ['items', 'directoryId', 'prefix', 'suffix'], 'download-confirm': ['planId', 'confirmation', 'confirmed'],
      'collection-operation': ['action', 'photoIds', 'photoSources', 'targetCollectionId'],
      report: ['runId', 'planId'], cancel: ['taskId'], plan: ['operation', 'categories', 'runId'], confirm: ['planId', 'confirmation', 'confirmed'] }
    if (!Object.hasOwn(allowed, input.operation) || Object.keys(args).some(key => !allowed[input.operation].includes(key))) throw new Error('Unknown AFP operation or argument')
    switch (input.operation) {
      // 缓存和动画设置只提供给插件页面；Agent 状态输出保持原有字段。
      case 'status': return { ...(await this.status()), previewAnimation: { enabled: this.config.previewAnimationEnabled }, previewCache: { scope: this.previewCacheScope,
        maxEntries: this.config.previewCacheMaxEntries, maxBytes: this.config.previewCacheMaxBytes, ttlMs: this.config.previewCacheTtlMs,
        retryCount: this.config.previewRetryCount, retryDelayMs: this.config.previewRetryDelayMs } }
      case 'collections': return this.collections(signal)
      case 'search': return this.search(args.query)
      case 'account-summary': return this.workbench.accountSummary(signal)
      case 'account-profile': this.require('read'); return this.workbench.accountProfile(signal)
      case 'photo-search': this.require('read'); return this.workbench.photoSearch(args, signal, progress)
      case 'photo-details': this.require('read'); return this.workbench.photoDetails(args, signal)
      case 'collection-list': this.require('read'); return this.workbench.collectionList(signal)
      case 'collection-items': this.require('read'); return this.workbench.collectionItems(args, signal)
      case 'run-items': return this.workbench.runItems(args, signal)
      case 'history-list': return this.workbench.historyList(args, signal)
      case 'download-options': this.require('read'); return this.downloads.options(args, signal)
      case 'pick-download-directory': this.require('read'); return this.downloads.pickDirectory(signal, args)
      case 'browse-download-directory': this.require('read'); return this.downloads.browseDirectory(args, signal)
      case 'download-prepare': this.require('read'); return this.downloads.prepare(args, signal)
      case 'download-confirm': this.require('read'); return this.downloads.confirm(args, signal)
      case 'collection-operation': return this.collectionOperation(args, signal)
      case 'refresh': return this.startRefresh(args, undefined, signal)
      case 'report': return this.report(args)
      case 'cancel': return this.cancel(args.taskId)
      case 'plan': return this.pagePlan(args, signal)
      case 'confirm': return this.pageConfirm(args, signal)
      default: throw new Error('Unknown AFP operation')
    }
  }
}
