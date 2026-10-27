/** Authenticated SSE response over live analysis state with one pending snapshot under backpressure. */
import type { DomainActor, RunRecord } from '../shared/model.ts'
import { analysisActive, type AnalysisStreamFrame } from '../shared/analysis-process.ts'
import type { RunEngine } from './runtime.ts'

/** @param engine Task owner. @param run Authorized analysis. @param actor Authenticated reader. @param signal Request/profile lifetime. @returns Native Fetch stream; disconnecting stops observation only. */
export function analysisFollowResponse(engine: RunEngine, run: RunRecord, actor: DomainActor, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  let pending: AnalysisStreamFrame | undefined, controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let stopped = false, scheduled = false, unsubscribe: (() => void) | undefined
  const cleanup = () => { if (stopped) return; stopped = true; unsubscribe?.(); signal.removeEventListener('abort', aborted) }
  const aborted = () => { cleanup(); controller?.error(signal.reason) }
  const flush = () => {
    scheduled = false
    if (stopped || !controller || !pending || (controller.desiredSize ?? 0) <= 0) return
    const frame = pending; pending = undefined
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      if (!analysisActive(frame.status)) { cleanup(); controller.close() }
    } catch (error) { cleanup(); controller.error(error) }
  }
  const enqueue = (frame: AnalysisStreamFrame) => {
    if (stopped) return
    // 慢读者只保留最新快照，且不能丢掉“已保存结果需要刷新”的标记。
    pending = { ...frame, checkpoint: frame.checkpoint || pending?.checkpoint === true }
    if (!scheduled) { scheduled = true; queueMicrotask(flush) }
  }
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
      unsubscribe = engine.subscribeProcess(run.id, actor, enqueue)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) { aborted(); return }
      const process = engine.process(run)
      enqueue({ runId: run.id, status: run.status, ...(process ? { process } : {}), checkpoint: true })
    },
    pull() { flush() },
    cancel() { cleanup() },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'private, no-store', 'x-accel-buffering': 'no' } })
}
