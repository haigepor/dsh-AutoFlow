/** Authenticated analysis SSE coalesces ordinary text snapshots and retains one pending snapshot under backpressure. */
import type { DomainActor, RunRecord } from '../shared/model.ts'
import { analysisActive, type AnalysisStreamFrame } from '../shared/analysis-process.ts'
import { specOf, type RunEngine } from './runtime.ts'

/** @param engine Task owner. @param run Authorized analysis with its frozen ordinary-update interval. @param actor Authenticated reader. @param signal Request/profile lifetime. @returns Native Fetch stream; first output, phases, checkpoints and terminal status are immediate, and disconnecting stops observation only. */
export function analysisFollowResponse(engine: RunEngine, run: RunRecord, actor: DomainActor, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  let pending: AnalysisStreamFrame | undefined, controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const interval = specOf(run).config.limits.processPollIntervalMs
  let stopped = false, scheduled = false, immediate = false, unsubscribe: (() => void) | undefined
  let previous: AnalysisStreamFrame | undefined, timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = () => {
    if (stopped) return
    stopped = true; pending = undefined; unsubscribe?.(); signal.removeEventListener('abort', aborted)
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  }
  const aborted = () => { if (stopped) return; cleanup(); controller?.error(signal.reason) }
  const flush = () => {
    scheduled = false
    if (stopped || !controller || !pending || (controller.desiredSize ?? 0) <= 0) return
    if (timer !== undefined && !immediate) return
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    const frame = pending; pending = undefined; immediate = false
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      previous = frame
      if (!analysisActive(frame.status)) { cleanup(); controller.close(); return }
      timer = setTimeout(() => { timer = undefined; flush() }, interval)
    } catch (error) { cleanup(); controller.error(error) }
  }
  const enqueue = (frame: AnalysisStreamFrame) => {
    if (stopped) return
    // 慢读者只保留最新快照，且不能丢掉“已保存结果需要刷新”的标记。
    pending = { ...frame, checkpoint: frame.checkpoint || pending?.checkpoint === true }
    immediate ||= !previous || frame.checkpoint || frame.status !== previous.status || frame.process?.phase !== previous.process?.phase
      || frame.process?.messages?.at(-1)?.sequence !== previous.process?.messages?.at(-1)?.sequence
      || !!frame.process?.content && !previous.process?.content || !!frame.process?.reasoning && !previous.process?.reasoning
    if (!scheduled && (timer === undefined || immediate)) { scheduled = true; queueMicrotask(flush) }
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
