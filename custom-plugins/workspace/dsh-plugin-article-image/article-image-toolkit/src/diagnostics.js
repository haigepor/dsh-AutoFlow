/** Bounded, process-local diagnostic evidence; raw page text and credentials are never retained. */
import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { failure } from './contracts.js'

const phases = new Set(['queued', 'fetching', 'rendering', 'extracting', 'assets', 'completed', 'failed', 'cancelled'])
const numeric = new Set(['elapsedMs', 'limitMs', 'bytes', 'chars', 'statusCode', 'blocks', 'assets', 'completed', 'total', 'attempt', 'downloadMs', 'decodeMs', 'chargedBytes'])
const codePattern = /^[a-z]+(?:-[a-z]+)*$/

function safeDetails(input = {}) {
  const details = {}
  for (const key of numeric) if (Number.isFinite(input[key]) && input[key] >= 0) details[key] = input[key]
  if (typeof input.code === 'string' && input.code.length <= 64 && codePattern.test(input.code)) details.code = input.code
  if (typeof input.blockId === 'string' && /^b[1-9]\d{0,5}$/.test(input.blockId)) details.blockId = input.blockId
  if (typeof input.mime === 'string' && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mime) && input.mime.length <= 100) details.mime = input.mime
  if (typeof input.itemId === 'string' && /^[a-f0-9]{32}$/.test(input.itemId)) details.itemId = input.itemId
  if (['static', 'structured', 'browser'].includes(input.rung)) details.rung = input.rung
  if (['document', 'image', 'script', 'stylesheet', 'font', 'media', 'xhr', 'fetch', 'other'].includes(input.resourceType)) details.resourceType = input.resourceType
  if (typeof input.origin === 'string') {
    try { const url = new URL(input.origin); if (['http:', 'https:'].includes(url.protocol)) details.origin = url.origin } catch (error) { void error /* 非 URL 诊断不保存。 */ }
  }
  return details
}

/** Notify an optional observer without making its delivery failure an article failure. @param {Function|undefined} observer Progress listener. @param {object} value Safe progress data. @returns {Promise<void>} Delivery settlement. */
export async function reportProgress(observer, value) {
  try { await observer?.(value) } catch (error) { void error /* 观察器不可用不改变抓取结果。 */ }
}

/** Own a bounded ring of recent calls for one service process. */
export class DiagnosticRuns {
  /** @param {object} config Resolved run/event/result budgets. */
  constructor(config) { this.config = config; this.runs = new Map() }

  /** Begin a call without storing its arguments. @param {string} tool Owned tool name. @returns {object} Run id, event recorder and terminal recorder. */
  begin(tool) {
    const id = randomBytes(16).toString('hex'), started = performance.now()
    const run = { diagnosticId: id, tool, state: 'running', startedAt: new Date().toISOString(), endedAt: null, events: [], totalEvents: 0, droppedEvents: 0 }
    this.runs.set(id, run)
    while (this.runs.size > this.config.maxDiagnosticRuns) this.runs.delete(this.runs.keys().next().value)
    let ended = false
    const record = progress => {
      if (ended) return null
      const phase = phases.has(progress.phase) ? progress.phase : 'rendering'
      const event = typeof progress.event === 'string' && progress.event.length <= 64 && codePattern.test(progress.event) ? progress.event : phase
      const value = { sequence: ++run.totalEvents, elapsedMs: Math.max(0, performance.now() - started), phase, event,
        details: safeDetails({ ...progress.details,
          ...(progress.completed === undefined ? {} : { completed: progress.completed }),
          ...(progress.total === undefined ? {} : { total: progress.total }) }) }
      run.events.push(value)
      if (run.events.length > this.config.maxDiagnosticEvents) { run.events.shift(); run.droppedEvents++ }
      return value
    }
    return { id, record, finish: (state, code) => {
      const value = record({ phase: state, event: state, details: code ? { code } : {} })
      run.state = state; run.endedAt = new Date().toISOString(); ended = true
      return value
    } }
  }

  /** Read retained events by monotonically increasing sequence cursor. @param {object} input Run id and last received sequence. @returns {object} Bounded page; evicted ids throw diagnostic-missing. */
  page({ diagnosticId, offset = 0 }) {
    const run = this.runs.get(diagnosticId)
    if (!run) throw failure('diagnostic-missing')
    const result = { diagnosticId, tool: run.tool, state: run.state, startedAt: run.startedAt, endedAt: run.endedAt,
      offset, nextOffset: null, totalEvents: run.totalEvents, droppedEvents: run.droppedEvents, events: [] }
    const events = run.events.filter(event => event.sequence > offset)
    for (let index = 0; index < events.length && result.events.length < this.config.pageSize; index++) {
      const event = events[index]
      const next = { ...result, events: [...result.events, event], nextOffset: index + 1 < events.length ? event.sequence : null }
      if (Buffer.byteLength(JSON.stringify(next)) > this.config.toolResultBytes) break
      Object.assign(result, next)
    }
    if (events.length && !result.events.length) throw failure('response-size')
    return result
  }
}
