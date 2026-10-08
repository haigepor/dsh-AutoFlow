/** Authenticated Web recovery after the owning launcher replaces its Host. */

/** Public readiness response contains no process arguments or authentication credentials. */
export interface UpdateRestartStatus {
  readonly generation: string
  readonly supported: boolean
  readonly ready: boolean
  readonly timeoutMs: number
}

/**
 * Request a fresh Host and wait for a different, ready process before reloading the page.
 * A dropped commit response is expected during teardown; only new readiness confirms success.
 * @param status - Readiness observed before user-confirmed restart.
 * @param commit - Authenticated Remote request against the observed generation.
 * @param signal - Overlay lifetime; cancellation stops retries and prevents a late reload.
 * @returns When a replacement Host is ready; throws on unsupported launch or timeout.
 */
export async function waitForUpdatedWebHost(
  status: UpdateRestartStatus, commit: () => Promise<boolean | undefined>, signal: AbortSignal,
): Promise<void> {
  if (!status.supported) throw new Error('This launcher does not support restart')
  const deadline = AbortSignal.timeout(status.timeoutMs)
  const recovery = AbortSignal.any([signal, deadline])
  // 停机可能中断提交回复；请求失败不会被当作成功，后续必须确认新进程已就绪。
  const accepted = await commit().catch((_disconnectedCommit: unknown) => {
    // 新进程就绪是最终确认；停机造成的提交连接失败只由恢复截止时间裁定。
  })
  if (accepted === false) throw new Error('The Host refused restart; retry after plugin operations finish')
  while (!recovery.aborted) {
    try {
      const response = await fetch('api/plugins/restart-status', {
        credentials: 'same-origin', cache: 'no-store',
        signal: AbortSignal.any([recovery, AbortSignal.timeout(5000)]),
      })
      if (response.ok) {
        const result: unknown = await response.json()
        if (typeof result === 'object' && result !== null && 'generation' in result
          && typeof result.generation === 'string' && result.generation !== status.generation
          && 'ready' in result && result.ready === true) return
      } else await response.body?.cancel()
    } catch (_hostUnavailable) {
      // 旧进程退出与新进程绑定端口之间连接会失败；取消与截止时间由同一个信号控制。
      recovery.throwIfAborted()
    }
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        clearTimeout(timer)
        const reason: unknown = recovery.reason
        reject(reason instanceof Error ? reason : new DOMException('Restart recovery cancelled', 'AbortError'))
      }
      const timer = setTimeout(() => { recovery.removeEventListener('abort', abort); resolve() }, 1000)
      recovery.addEventListener('abort', abort, { once: true })
      if (recovery.aborted) abort()
    })
  }
  recovery.throwIfAborted()
}
