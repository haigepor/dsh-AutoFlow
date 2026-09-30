import { randomBytes, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store, digest } from './afp-state-store.js'
import { Connection } from './afp-credentials.js'
import { Changes } from './afp-change-plans.js'
import { categories, chooseCategories, refreshRun, reservedIds, summary } from './afp-refresh-workflow.js'
import { planAfpSearch } from '../vendor/auto-afp-img/afp-search-planner.mjs'
import { CATEGORY_PROFILES } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { isPrivateSelection, selectionDocIds } from '../vendor/auto-afp-img/afp-collection-run.mjs'

/** Shared profile service. Closing a view never cancels an admitted task. */
export class AfpService {
  constructor(ctx, config, dependencies = {}) {
    this.ctx = ctx; this.config = config
    this.store = dependencies.store ?? new Store(ctx.profileContext.home, ctx.profileContext.dir, config.maxStateBytes)
    this.connection = dependencies.connection ?? new Connection(ctx.credentials, config)
    this.connect = (...args) => this.connection.open(...args)
    this.changes = dependencies.changes ?? new Changes({ store: this.store, config, connect: this.connect })
    this.flags = new Set(); this.live = new Map(); this.challenges = new Map(); this.stopping = false; this.writeEpoch = 0
    this.pageOwner = `profile:${digest(ctx.profileContext.dir)}`
  }
  require(feature) { if (this.stopping || !this.flags.has(feature)) throw new Error(`AFP feature unavailable: ${feature}`) }
  async enable(feature) {
    if (this.flags.has(feature)) throw new Error(`Duplicate AFP feature: ${feature}`)
    this.flags.add(feature)
    if (feature === 'write') this.writeEpoch++
    return async () => {
      this.flags.delete(feature)
      if (feature === 'write') { this.writeEpoch++; this.challenges.clear() }
      const tasks = [...this.live.values()].filter(task => task.feature === feature)
      for (const task of tasks) task.controller.abort()
      await Promise.allSettled(tasks.map(task => task.done))
    }
  }
  async dispose() {
    this.stopping = true; this.challenges.clear(); this.flags.clear()
    const tasks = [...this.live.values()]
    for (const task of tasks) task.controller.abort()
    await Promise.allSettled(tasks.map(task => task.done))
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
  async startRefresh(args, owner, signal) {
    this.require('refresh'); signal.throwIfAborted()
    if (args.runId && args.categories) throw new Error('Resume uses saved categories')
    const run = args.runId ? await this.store.readRun(args.runId) : await this.store.createRun(chooseCategories(args.categories), this.config)
    const scheduled = this.job('refresh', owner, 'AFP visual dry-run', (taskSignal, handle) => this.store.lock(`run:${run.id}`, async () => {
      try {
      const current = await this.store.readRun(run.id), services = await this.connect(taskSignal, false, true)
      return await this.store.lock(`account:${services.account}`, async () => {
        if (current.account && current.account !== services.account) throw new Error('AFP account changed since refresh')
        current.account = services.account
        const reserved = await reservedIds(services.client, taskSignal)
        const result = await refreshRun({ run: current, store: this.store, config: current.settings, ...services, reserved, signal: taskSignal,
          onProgress: event => { const text = JSON.stringify(event); handle.updateProgress(text); handle.append(text + '\n') } })
        return summary(result)
      })
      } catch (error) {
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
  async collections(signal) {
    this.require('read')
    const { client } = await this.connect(signal), selections = await client.listSelections(), result = []
    for (const profile of CATEGORY_PROFILES) {
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
      tasks: [...this.live.values()].filter(task => !task.owner).map(({ taskId, feature, progress }) => ({ taskId, feature, progress: progress ?? null })), reports: await this.reports(), pollIntervalMs: this.config.pollIntervalMs }
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
  async pageAction(input, signal) {
    if (Object.keys(input).some(key => !['operation', 'args'].includes(key)) || typeof input.operation !== 'string') throw new Error('Invalid AFP page operation')
    const args = JSON.parse(input.args ?? '{}')
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid AFP operation arguments')
    const allowed = { status: [], collections: [], search: ['query'], refresh: ['categories', 'runId'], report: ['runId', 'planId'], cancel: ['taskId'], plan: ['operation', 'categories', 'runId'], confirm: ['planId', 'confirmation', 'confirmed'] }
    if (!Object.hasOwn(allowed, input.operation) || Object.keys(args).some(key => !allowed[input.operation].includes(key))) throw new Error('Unknown AFP operation or argument')
    switch (input.operation) {
      case 'status': return this.status()
      case 'collections': return this.collections(signal)
      case 'search': return this.search(args.query)
      case 'refresh': return this.startRefresh(args, undefined, signal)
      case 'report': return this.report(args)
      case 'cancel': return this.cancel(args.taskId)
      case 'plan': return this.pagePlan(args, signal)
      case 'confirm': return this.pageConfirm(args, signal)
      default: throw new Error('Unknown AFP operation')
    }
  }
}
