/** Electron-native inactivity deadlines for updater checks, full downloads, and blockmap requests. */
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import type { ClientRequest, IncomingMessage } from 'electron'
import type { DesktopUpdateDownload } from './update-download.ts'

type DownloadOptions = Parameters<ElectronHttpExecutor['download']>[2]

/** Retains electron-updater transport and proxy handling while bounding silent connections. */
export class DesktopUpdateHttpExecutor extends ElectronHttpExecutor {
  /**
   * @param idleTimeoutMs - Maximum silence before headers or between response chunks, not a total download deadline.
   * @param proxyLogin - Existing updater login event forwarding.
   * @param resumable - Full-file transport for public metadata-bound downloads; omission retains native downloads.
   */
  constructor(private readonly idleTimeoutMs: number, proxyLogin?: ConstructorParameters<typeof ElectronHttpExecutor>[0],
    private readonly resumable?: DesktopUpdateDownload) {
    super(proxyLogin)
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 2_147_483_647) {
      throw new Error('desktop update: HTTP idle timeout must be an integer from 1000 through 2147483647')
    }
  }

  private release: { version: string; files: readonly { sha512: string; size?: number }[] } | undefined

  /** @param release - Checked feed identity; only its SHA512/size-bound full files can use persistent resume. */
  prepare(release: { version: string; files: readonly { sha512: string; size?: number }[] }): void { this.release = release }

  override async download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    const file = this.release?.files.find(item => item.sha512 === options.sha512)
    // Custom headers can carry publisher authentication; retain the native path rather than forwarding them to mirrors.
    const customHeaders = Object.keys(options.headers ?? {}).some(key => !/^(?:accept|user-agent|cache-control)$/iu.test(key))
    if (this.resumable === undefined || file?.size === undefined || !Number.isSafeInteger(file.size) || file.size <= 0
      || customHeaders || this.release === undefined) return super.download(url, destination, options)
    const controller = new AbortController()
    const cancel = (): void => { controller.abort(new Error('Desktop update download cancelled')) }
    options.cancellationToken.on('cancel', cancel)
    if (options.cancellationToken.cancelled) cancel()
    try {
      return await this.resumable.download({ url, version: this.release.version, size: file.size, sha512: file.sha512 },
        destination, controller.signal)
    } finally { options.cancellationToken.off('cancel', cancel) }
  }

  override addErrorAndTimeoutHandlers(request: ClientRequest, reject: (error: Error) => void): void {
    // The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead.
    super.addErrorAndTimeoutHandlers(request, reject, this.idleTimeoutMs)
    let response: IncomingMessage | undefined
    let timer: ReturnType<typeof setTimeout>
    const stop = (): void => {
      clearTimeout(timer)
      request.off('response', onResponse)
      request.off('abort', stop)
      request.off('error', stop)
      response?.off('data', refresh)
      response?.off('end', stop)
      response?.off('error', stop)
    }
    const refresh = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stop()
        reject(Object.assign(new Error('Desktop update connection timed out'), { code: 'ETIMEDOUT' }))
        request.abort()
      }, this.idleTimeoutMs)
    }
    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming
      response.on('data', refresh)
      response.once('end', stop)
      response.once('error', stop)
      refresh()
    }
    request.once('response', onResponse)
    // Electron 44 can emit writable close after finish, before response headers arrive.
    request.once('abort', stop)
    request.once('error', stop)
    refresh()
  }
}
