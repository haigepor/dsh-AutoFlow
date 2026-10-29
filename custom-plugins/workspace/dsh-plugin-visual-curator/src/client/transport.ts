/** Workspace reads and task/configuration commands use authenticated JSON routes. */
import type { ActionArgs } from './contract.ts'
import type { ClientTransport } from './store.ts'
import { EventSourceParserStream } from 'eventsource-parser/stream'
import { analysisStreamFrameSchema } from '../shared/analysis-process.ts'

/** Route large projections and explicit local-path registration through authenticated HTTP endpoints.
 * @param dependencies Host action adapter, same-origin fetch, document base and plugin lifetime.
 * @returns The shared store transport; failed reads are never retried as actions.
 */
export function createCuratorTransport(dependencies: { action(operation: string, args: ActionArgs): Promise<unknown>; fetch: typeof fetch; baseUrl: string; signal: AbortSignal }): ClientTransport {
  return { async invoke(operation, args, signal) {
    let payload: unknown
    if (['search-launch-options', 'search-launch-list', 'search-launch-start', 'search-launch-stop', 'task-prepare', 'usage-list', 'analysis-detail', 'analysis-input', 'analysis-stop', 'reference-analyze', 'config-read', 'config-save', 'snapshot', 'run-get', 'run-control', 'run-delete', 'export-get', 'references-list', 'local-files-list', 'reference-local-import', 'local-reference-pick', 'gallery-validate', 'gallery-collections', 'gallery-photos', 'gallery-import', 'gallery-import-progress', 'gallery-import-cancel', 'gallery-reference-start', 'gallery-reference-tasks', 'gallery-reference-stop', 'gallery-login-start', 'gallery-login-status', 'gallery-login-retry', 'gallery-login-finish', 'gallery-login-cancel'].includes(operation)) {
      const route = operation.startsWith('gallery-') ? 'api/visual-curator/gallery' : ['reference-local-import', 'local-reference-pick'].includes(operation) ? 'api/visual-curator/local-reference' : 'api/visual-curator/data'
      const response = await dependencies.fetch(new URL(route, dependencies.baseUrl), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, args }), signal: signal ? AbortSignal.any([signal, dependencies.signal]) : dependencies.signal,
      })
      payload = await response.json()
      if (!response.ok) {
        if (payload && typeof payload === 'object' && 'error' in payload) throw payload.error
        throw new Error('workspace-data-unavailable')
      }
    } else payload = await dependencies.action(operation, args)
    if (!payload || typeof payload !== 'object' || !('ok' in payload)) throw new Error('invalid-action-response')
    if (payload.ok === true && 'value' in payload) return payload.value
    throw 'error' in payload ? payload.error : new Error('invalid-action-response')
  }, async followAnalysis(args, receive, signal) {
    const lifetime = new AbortController()
    let reader: ReadableStreamDefaultReader<import('eventsource-parser').EventSourceMessage> | undefined
    try {
      const response = await dependencies.fetch(new URL('api/visual-curator/analysis-stream', dependencies.baseUrl), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ operation: 'analysis-follow', args }), signal: AbortSignal.any([signal, dependencies.signal, lifetime.signal]),
      })
      if (!response.ok || !response.body || !/^text\/event-stream(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) throw new Error('analysis-stream-unavailable')
      reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader()
      for (;;) { const frame = await reader.read(); if (frame.done) break; receive(analysisStreamFrameSchema.parse(JSON.parse(frame.value.data))) }
    } finally { lifetime.abort(); reader?.releaseLock() }
  } }
}
