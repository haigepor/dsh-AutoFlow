/** Attempt-owned progress batches; terminal publication waits for the final drain. */
import { failure } from '../shared/contracts.js'

/** Coalesce capture callbacks without retaining a timer after close. @param {object} options Batch limits, writer and failure cancellation. @returns {object} Push, close and original write error. */
export function createRunProgress({ batchSize, flushMs, write, onFailure }) {
  let events = [], timer, tail = Promise.resolve(), error = null, closed = false, closing
  const flush = () => {
    clearTimeout(timer); timer = undefined
    const batch = events; events = []
    const operation = tail.then(async () => {
      if (error) throw error
      if (batch.length) await write(batch)
    })
    // 定时刷写的拒绝必须在此接管；原异常由 close 和前台回调报告。
    tail = operation.catch(value => {
      if (error) return
      error = value
      try { onFailure(value) } catch (callbackError) { void callbackError }
    })
    return operation
  }
  return {
    get error() { return error },
    async push(progress) {
      if (error) throw error
      if (closed) throw failure('progress-closed')
      events.push({ at: new Date().toISOString(), event: progress.event ?? progress.phase,
        details: { ...progress.details, completed: progress.completed, total: progress.total }, phase: progress.phase })
      if (events.length >= batchSize) return flush()
      timer ??= setTimeout(() => { void flush().catch(value => { void value }) }, flushMs)
    },
    close() {
      if (!closing) { closed = true; closing = flush() }
      return closing
    },
  }
}
