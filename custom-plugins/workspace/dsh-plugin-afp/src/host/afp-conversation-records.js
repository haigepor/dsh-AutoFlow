import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
/** Successful tools whose complete photo metadata supplies Turn-scoped evidence. */
export const photoReadTools = new Set(['afp_photo_search_start', 'afp_photo_search', 'afp_photo_details', 'afp_collection_items', 'afp_result_page'])

/** Read a plugin-owned result envelope; a retained prefix may recover only its opaque reference.
 * @param {object} message Durable tool message or PTC dispatch.
 * @param {object} [meta] Persisted native presentation metadata.
 * @returns {object|null} Safe structured result or reference, never a spill file path.
 */
export function photoResultEnvelope(message, meta) {
  if (message.isError) return null
  if (meta?.afp?.version === 1) return meta.afp.result
  const text = (message.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n')
  try { return JSON.parse(text) }
  catch (error) {
    // 只恢复固定格式 UUID；不能读取截断提示中的任意本地文件。
    const ref = text.match(/^\{"resultRef":"([a-f0-9-]{36})"/u)?.[1]
    return ref && uuid.test(ref) ? { resultRef: ref } : null
  }
}

/** Profile-owned full results and transient call progress, isolated by Session and Turn. */
export class ConversationRecords {
  constructor(store, config) { this.store = store; this.config = config; this.progress = new Map(); this.failures = new Map() }
  context(exec) {
    const session = exec.agent?.session
    const events = session?.snapshotEvents() ?? []
    const rootCallId = exec.rootCallId ?? exec.callId
    const turn = events.findLast(event => event.type === 'tool/call' && event.data.callId === rootCallId)?.data.turn
      ?? events.findLast(event => event.type === 'turn/start')?.data.turn
    if (!session || !Number.isSafeInteger(turn)) throw new Error('AFP tools require a Session')
    return { sessionId: session.id, turn, callId: exec.callId, name: exec.name }
  }
  key(context) { return JSON.stringify([context.sessionId, context.turn, context.callId]) }
  begin(exec) {
    const context = this.context(exec), key = this.key(context)
    // 每个会话只保留当前轮的瞬时进度，不覆盖持久结果。
    for (const [priorKey, value] of this.progress) if (value.sessionId === context.sessionId && value.turn !== context.turn) this.progress.delete(priorKey)
    for (const [priorKey, value] of this.failures) if (value.sessionId === context.sessionId && value.turn !== context.turn) this.failures.delete(priorKey)
    this.progress.set(key, { ...context, state: 'running', stage: 'connection', startedAt: Date.now(), updatedAt: Date.now(), retryCount: 0 })
    return update => { const value = this.progress.get(key); if (value) Object.assign(value, update, { updatedAt: Date.now() }) }
  }
  failureKey(exec) { const c = this.context(exec); return JSON.stringify([c.sessionId, c.turn, exec.name, canonical(exec.arguments)]) }
  previousFailure(exec) {
    if (!exec.agent?.session) return null
    const saved = this.failures.get(this.failureKey(exec))
    if (!saved) return null
    // 参数未变但本轮证据增加时，允许重新验证；否则缺证据会永远无法修复。
    if (['selection-missing-photos', 'selection-report-missing', 'selection-visual-rejected', 'selection-unverified'].includes(saved.error.code)
      && exec.agent.session.snapshotEvents().some(event => event.seq > saved.atSeq &&
        (event.type === 'tool/result' && !event.data.message.isError && event.data.meta?.afp
          || event.type === 'tool/ptc-dispatch' && !event.data.isError && event.data.name.startsWith('afp_')))) return null
    return saved.error
  }
  fail(exec, error) { if (exec.agent?.session && !error.retryable) this.failures.set(this.failureKey(exec), { ...this.context(exec), atSeq: exec.agent.session.snapshotEvents().at(-1)?.seq ?? -1, error }) }
  async save(exec, result) {
    const resultRef = randomUUID(), context = this.context(exec)
    const { resultRef: priorReference, ...payload } = result
    const value = { resultRef, ...payload }
    await this.store.write(join(this.store.profile, 'conversation-results', resultRef + '.json'), { schema: 1, ...context, result: value })
    return value
  }
  async read(context, resultRef) {
    if (!uuid.test(resultRef)) throw new Error('Invalid AFP result reference')
    const record = await this.store.read(join(this.store.profile, 'conversation-results', resultRef + '.json'))
    if (record.sessionId !== context.sessionId || record.turn !== context.turn || (context.callId && record.callId !== context.callId)
      || record.result?.resultRef !== resultRef) throw new Error('AFP selection lacks current turn evidence')
    return record.result
  }
  snapshot(sessionId, turn, callId) {
    return [...this.progress.values()].filter(row => row.sessionId === sessionId && row.turn === turn && (!callId || row.callId === callId))
      .map(row => ({ ...row }))
  }
  dispose() { this.progress.clear(); this.failures.clear() }
}

/** Render valid bounded JSON and local paging without discarding the complete saved result.
 * @param {string} value Canonical safe JSON result.
 * @param {number} maxBytes Deployment output budget.
 * @returns {Array} Model-facing text blocks.
 */
export function renderPhotoResult(value, maxBytes) {
  // 查看明细保存在原调用的完整记录中；模型摘要不携带仅供图片列表使用的身份和逐图结果。
  const { reviewedPhotoIds, reviewedPhotos, ...result } = JSON.parse(value)
  const compact = photo => ({ id: photo.id, title: (photo.title ?? '').slice(0, 160), caption: (photo.caption ?? '').slice(0, 400), provider: photo.provider, previewPath: 'api/afp/preview?photoId=' + encodeURIComponent(photo.id) })
  if (!result.resultRef) return [{ type: 'text', text: JSON.stringify(result) }]
  if (!Array.isArray(result.items)) {
    const output = Buffer.byteLength(value) > maxBytes && result.photo ? { ...result, photo: compact(result.photo) } : result
    const text = JSON.stringify(output)
    if (Buffer.byteLength(text) > maxBytes) throw new Error('AFP result output budget is too small')
    return [{ type: 'text', text }]
  }
  const completeText = JSON.stringify({ ...result, offset: result.offset ?? 0, totalItems: result.totalItems ?? result.items.length, nextOffset: result.nextOffset ?? null })
  if (result.pageLimit === undefined && Buffer.byteLength(completeText) <= maxBytes) return [{ type: 'text', text: completeText }]
  const start = result.offset ?? 0, total = result.items.length, limit = result.pageLimit ?? total
  const { pageLimit, ...fields } = result
  const output = { ...fields, items: [], offset: start, totalItems: total, nextOffset: start }
  for (const photo of result.items.slice(start, start + limit)) {
    output.items.push(compact(photo)); output.nextOffset = start + output.items.length < total ? start + output.items.length : null
    if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) { output.items.pop(); output.nextOffset = start + output.items.length; break }
  }
  if (!output.items.length && start < total) throw new Error('AFP result output budget is too small')
  if (output.nextOffset >= total) output.nextOffset = null
  if (Buffer.byteLength(JSON.stringify(output)) > maxBytes) throw new Error('AFP result output budget is too small')
  return [{ type: 'text', text: JSON.stringify(output) }]
}

/** Sort model JSON object keys so equivalent non-retryable inputs share one failure. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
