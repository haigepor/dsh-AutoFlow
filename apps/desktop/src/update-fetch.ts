/** Electron public-artifact streaming with system proxy routing and proxy-only authentication. */
import { Readable } from 'node:stream'
import { net, type AuthInfo, type IncomingMessage, type Session } from 'electron'

type ProxyLogin = (auth: AuthInfo, callback: (username?: string, password?: string) => void) => void

/**
 * @param session - Updater-owned Electron session or its lazy reader, retaining system proxy, PAC, auth cache, and certificate policy.
 * @param proxyLogin - Existing updater proxy challenge handler; omission declines a fresh challenge.
 * @returns GET-only fetch for public bytes, without origin credentials; cancellation closes the underlying request.
 */
export function createDesktopUpdateFetch(session: Session | (() => Session), proxyLogin?: ProxyLogin): typeof globalThis.fetch {
  return async (input, init) => {
    const spec = new Request(input, init)
    spec.signal.throwIfAborted()
    if (spec.method !== 'GET') throw new Error('Desktop public artifact transport supports only GET')
    const headers: Record<string, string> = {}
    for (const [name, value] of spec.headers) {
      if (!/^(?:range|accept-encoding|accept|user-agent|cache-control)$/u.test(name)) {
        throw new Error('Desktop public artifact transport rejected a private request header')
      }
      headers[name] = value
    }
    return new Promise<Response>((resolve, reject) => {
      const request = net.request({ url: spec.url, session: typeof session === 'function' ? session() : session,
        method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'follow' })
      let failBody: ((error: unknown) => void) | undefined
      const abort = (): void => {
        const reason = spec.signal.reason instanceof Error ? spec.signal.reason : new Error('Desktop update request cancelled')
        failBody?.(reason); request.abort(); reject(reason)
      }
      const cleanup = (): void => { spec.signal.removeEventListener('abort', abort) }
      spec.signal.addEventListener('abort', abort, { once: true })
      request.on('login', (auth: AuthInfo, callback: (username?: string, password?: string) => void) => {
        if (auth.isProxy && proxyLogin !== undefined) proxyLogin(auth, callback)
        else callback()
      })
      request.once('error', (error) => { failBody?.(error); cleanup(); reject(error) })
      request.once('abort', cleanup)
      request.once('response', (response: IncomingMessage) => {
        response.once('end', cleanup)
        response.once('error', cleanup)
        const fields = new Headers()
        for (const [name, value] of Object.entries(response.headers)) {
          for (const item of typeof value === 'string' ? [value] : value) fields.append(name, item)
        }
        if (response.statusCode < 200 || response.statusCode > 599) {
          reject(new Error('Desktop update returned an invalid HTTP status')); request.abort(); return
        }
        if ([204, 205, 304].includes(response.statusCode)) {
          resolve(new Response(null, { status: response.statusCode, headers: fields })); request.abort(); return
        }
        // Electron declares only EventEmitter here; backpressure requires the actual Node stream implementation.
        if (!(response instanceof Readable)) {
          reject(new Error('Desktop update response is not a readable stream')); request.abort(); return
        }
        let stopped = false
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            failBody = (error) => { if (!stopped) { stopped = true; controller.error(error) } }
            response.pause()
            response.on('data', (bytes: Buffer) => {
              if (stopped) return
              response.pause(); controller.enqueue(bytes)
            })
            response.once('end', () => { if (!stopped) { stopped = true; controller.close() } })
            response.once('error', failBody)
            response.once('close', () => { failBody?.(new Error('Desktop update response closed before completion')); cleanup() })
          },
          pull() { response.resume() },
          cancel() { stopped = true; cleanup(); request.abort() },
        })
        resolve(new Response(body, { status: response.statusCode, statusText: response.statusMessage, headers: fields }))
      })
      request.end()
    })
  }
}
