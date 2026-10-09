import { randomUUID } from 'node:crypto'
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { readFailure } from '../vendor/auto-afp-img/read-failure.mjs'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const steps = new Set(['connection', 'collections', 'collection-list', 'collection-read', 'collection-parse', 'checkpoint-save',
  'search-initialization', 'search', 'preview', 'vision', 'confirmation', 'progress-update', 'progress-output', 'workflow', 'completion'])
const names = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AbortError', 'TimeoutError', 'AggregateError'])
const systemCodes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EIO', 'EBUSY', 'EINTR', 'EMFILE', 'ENFILE',
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND'])
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const phase = value => steps.has(value) ? value : 'workflow'

/** Only fixed error categories and code locations enter diagnostic exports.
 * @param {unknown} error Local or provider error; its message is never exported.
 * @param {string} stage Instrumented operation.
 * @returns {object} Bounded diagnostic fields without URLs or provider text.
 */
export function diagnosticFailure(error, stage) {
  const frames = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line))
    .map(line => line.match(/(?:[/\\]|\s|\()([a-z0-9-]+\.(?:js|mjs|ts):\d+:\d+)(?:\)|\s|$)/i)?.[1])
    .filter(frame => frame && frame.length <= 120).slice(0, 5)
  return { ...readFailure(error, phase(stage)), errorName: names.has(error?.name) ? error.name : 'Error',
    ...(systemCodes.has(error?.code) ? { systemCode: error.code } : {}), frames }
}

function cleanFailure(value) {
  if (!value || typeof value !== 'object') return null
  const allowedCodes = new Set(['read-failed', 'authentication-failed', 'access-denied', 'api-schema-rejected', 'query-rejected',
    'rate-limited', 'upstream-unavailable', 'read-timeout', 'network-failed', 'cancelled', 'preview-host-blocked', 'checkpoint-save-failed'])
  return { code: allowedCodes.has(value.code) ? value.code : 'read-failed', stage: phase(value.stage),
    errorName: names.has(value.errorName) ? value.errorName : 'Error', retryable: value.retryable === true,
    ...(systemCodes.has(value.systemCode) ? { systemCode: value.systemCode } : {}),
    ...(value.code === 'preview-host-blocked' && typeof value.host === 'string' && value.host.length <= 253
      && /^[a-z0-9.-]+$/.test(value.host) ? { host: value.host } : {}),
    frames: (Array.isArray(value.frames) ? value.frames : []).filter(frame => typeof frame === 'string'
      && frame.length <= 120 && /^[a-z0-9-]+\.(?:js|mjs|ts):\d+:\d+$/i.test(frame)).slice(0, 5) }
}

/** Profile-owned bounded diagnostics; failures and timings are retained even with debug disabled.
 * @param {object} store Existing private AFP JSON store.
 * @param {object} config Validated diagnostic limits.
 */
export class AfpDiagnostics {
  constructor(store, config) { this.store = store; this.config = config; this.active = new Map() }
  file(runId) { if (!uuid.test(runId)) throw new Error('Invalid AFP diagnostic run id'); return join(this.store.profile, 'diagnostics', `${runId}.json`) }
  /** Begin one admitted run attempt; resumes replace its diagnostic window.
   * @param {string} runId Saved run UUID.
   * @param {string} jobId Job registry identity.
   * @returns {object} Operation timing and failure recorder.
   */
  begin(runId, jobId) {
    this.file(runId)
    const trace = new DiagnosticTrace(this, runId, jobId)
    // 文件系统不可写时保留有界内存摘要，页面仍可导出本次失败。
    for (const [id, retained] of this.active) if (this.active.size >= this.config.debugMaxRuns && retained.closed) this.active.delete(id)
    this.active.set(runId, trace)
    trace.schedule()
    return trace
  }
  /** Read only the current profile's run and project an allowlisted export.
   * @param {string} runId Existing run UUID.
   * @returns {Promise<object|null>} Safe diagnostics, or null for runs predating instrumentation.
   */
  async read(runId) {
    await this.store.readRun(runId)
    const live = this.active.get(runId)
    if (live) return live.snapshot()
    const file = this.file(runId)
    let info
    try { info = await lstat(file) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
    if (!info.isFile() || info.size > this.config.debugMaxBytes) throw new Error('Unsafe or oversized AFP diagnostics')
    const value = await this.store.read(file)
    if (value.runId !== runId || value.version !== 1) throw new Error('Invalid AFP diagnostics')
    return { schema: 1, version: 1, runId, attemptId: uuid.test(value.attemptId) ? value.attemptId : null,
      jobId: typeof value.jobId === 'string' && /^[a-z0-9-]{1,80}$/i.test(value.jobId) ? value.jobId : null,
      debug: value.debug === true, startedAt: count(value.startedAt), endedAt: count(value.endedAt), durationMs: count(value.durationMs),
      outcome: ['running', 'ready', 'paused', 'failed', 'cancelled'].includes(value.outcome) ? value.outcome : 'failed',
      storageIssue: value.storageIssue === true, droppedEvents: count(value.droppedEvents), failure: cleanFailure(value.failure),
      errors: (Array.isArray(value.errors) ? value.errors : []).slice(0, 20).map(cleanFailure).filter(Boolean),
      timings: (Array.isArray(value.timings) ? value.timings : []).filter(row => steps.has(row?.stage)).slice(0, steps.size)
        .map(row => ({ stage: row.stage, count: count(row.count), failed: count(row.failed), durationMs: count(row.durationMs) })),
      events: (Array.isArray(value.events) ? value.events : []).slice(0, this.config.debugMaxEvents).map(row => ({ seq: count(row?.seq), at: count(row?.at),
        stage: phase(row?.stage), event: ['start', 'end', 'error'].includes(row?.event) ? row.event : 'error',
        ...(Number.isSafeInteger(row?.durationMs) ? { durationMs: count(row.durationMs) } : {}),
        ...(row?.failure ? { failure: cleanFailure(row.failure) } : {}) })) }
  }
  async prune() {
    const directory = join(this.store.profile, 'diagnostics')
    const files = []
    for (const name of await readdir(directory)) {
      const runId = name.slice(0, -5)
      if (!name.endsWith('.json') || !uuid.test(runId) || this.active.has(runId)) continue
      const file = join(directory, name), info = await lstat(file)
      if (info.isFile()) files.push({ file, time: info.mtimeMs })
    }
    files.sort((a, b) => b.time - a.time)
    const expires = Date.now() - this.config.debugRetentionDays * 86400000
    for (const [index, item] of files.entries()) if (index >= this.config.debugMaxRuns || item.time < expires) await unlink(item.file)
  }
}

class DiagnosticTrace {
  constructor(owner, runId, jobId) {
    this.owner = owner; this.clock = performance.now(); this.timings = new Map(); this.locations = new WeakMap()
    this.queue = Promise.resolve(); this.timer = null; this.eventBytes = 0; this.sequence = 0; this.closed = false
    this.record = { schema: 1, version: 1, runId, attemptId: randomUUID(), jobId, debug: owner.config.debugEnabled,
      startedAt: Date.now(), endedAt: 0, durationMs: 0, outcome: 'running', storageIssue: false, droppedEvents: 0,
      failure: null, errors: [], timings: [], events: [] }
  }
  snapshot() { return structuredClone({ ...this.record, durationMs: this.closed ? this.record.durationMs : Math.round(performance.now() - this.clock), timings: [...this.timings.values()] }) }
  schedule() {
    if (this.timer || this.closed) return
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, this.owner.config.debugFlushIntervalMs)
    this.timer.unref()
  }
  flush() {
    // 诊断写入独立排队；失败只标记存储问题，不能替换业务错误。
    this.queue = this.queue.then(() => { this.record.storageIssue = false; return this.owner.store.write(this.owner.file(this.record.runId), this.snapshot()) })
      .catch(error => { this.record.storageIssue = true })
    return this.queue
  }
  event(stage, event, extra = {}) {
    if (!this.record.debug) return
    const row = { seq: ++this.sequence, at: Date.now(), stage: phase(stage), event, ...extra }
    const bytes = Buffer.byteLength(JSON.stringify(row))
    if (this.record.events.length >= this.owner.config.debugMaxEvents || this.eventBytes + bytes > this.owner.config.debugMaxBytes - 16384) this.record.droppedEvents++
    else { this.record.events.push(row); this.eventBytes += bytes }
  }
  start(stage) { this.event(stage, 'start'); this.schedule(); return performance.now() }
  end(stage, started, error) {
    const durationMs = Math.round(performance.now() - started), key = phase(stage)
    const row = this.timings.get(key) ?? { stage: key, count: 0, failed: 0, durationMs: 0 }
    row.count++; row.durationMs += durationMs; if (error !== undefined) row.failed++
    this.timings.set(key, row)
    const failure = error === undefined ? null : diagnosticFailure(error, this.errorStage(error, stage))
    if (error && typeof error === 'object' && !this.locations.has(error)) this.locations.set(error, key)
    if (failure && this.record.errors.length < 20) this.record.errors.push(failure)
    this.event(stage, failure ? 'error' : 'end', { durationMs, ...(failure ? { failure } : {}) }); this.schedule()
  }
  errorStage(error, fallback) { return error && typeof error === 'object' ? this.locations.get(error) ?? phase(fallback) : phase(fallback) }
  async measure(stage, operation) {
    const started = this.start(stage)
    try { const result = await operation(); this.end(stage, started); return result }
    catch (error) { this.end(stage, started, error); throw error }
  }
  sync(stage, operation) {
    const started = this.start(stage)
    try { const result = operation(); this.end(stage, started); return result }
    catch (error) { this.end(stage, started, error); throw error }
  }
  async finish(outcome, error, stage) {
    this.closed = true; clearTimeout(this.timer); this.timer = null
    this.record.outcome = outcome; this.record.endedAt = Date.now(); this.record.durationMs = Math.round(performance.now() - this.clock)
    if (error !== undefined) this.record.failure = diagnosticFailure(error, this.errorStage(error, stage))
    await this.flush()
    if (!this.record.storageIssue) this.owner.active.delete(this.record.runId)
    try { await this.owner.prune() }
    catch (error) { /* 保留或清理诊断失败不能改变任务结果；后续运行会再次清理。 */ }
  }
}
